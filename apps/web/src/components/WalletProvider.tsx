'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { getWallets as getStandardWallets } from '@wallet-standard/app';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

// Wallet Standard types
interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
}

interface Wallet {
  name: string;
  icon: string;
  accounts: WalletAccount[];
  features: Record<string, unknown>;
  connect?: () => Promise<void>;
}

interface WalletContextType {
  wallet: Wallet | null;
  account: WalletAccount | null;
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  connectDevWallet: (secretKeyBase58?: string) => void;
  disconnect: () => void;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signAndSendTransaction: (transaction: Uint8Array) => Promise<string>;
}

const DEV_WALLET_KEY = 'devWalletSecretKey';

const WalletContext = createContext<WalletContextType | null>(null);

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}

interface WalletProviderProps {
  children: ReactNode;
}

const WALLET_CONNECTED_KEY = 'walletConnected';

/**
 * Wait for a transaction to be confirmed.
 * Optionally resends the raw transaction periodically to combat dropped txs.
 * Returns { confirmed: true } on success, { confirmed: false, error: ... } on failure
 */
export async function waitForConfirmation(
  rpcUrl: string,
  signature: string,
  timeoutMs: number = 30000,
  rawBase64Tx?: string // optional: resend periodically if provided
): Promise<{ confirmed: boolean; error?: unknown }> {
  const startTime = Date.now();
  const pollInterval = 2000; // Check every 2 seconds
  const resendInterval = 4000; // Resend every 4 seconds
  let lastResend = startTime;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }]
        })
      });
      const result = await response.json();

      if (result.result?.value?.[0]) {
        const status = result.result.value[0];
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          if (status.err) {
            console.error('Transaction confirmed but failed:', status.err);
            return { confirmed: false, error: status.err };
          }
          return { confirmed: true };
        }
        if (status.err) {
          console.error('Transaction failed:', status.err);
          return { confirmed: false, error: status.err };
        }
      }
    } catch (e) {
      console.warn('Error checking confirmation:', e);
    }

    // Periodically resend the transaction to combat dropped txs
    if (rawBase64Tx && Date.now() - lastResend >= resendInterval) {
      lastResend = Date.now();
      try {
        console.log('Resending transaction...');
        await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [rawBase64Tx, { skipPreflight: true, encoding: 'base64' }]
          })
        });
      } catch (resendErr) {
        console.warn('Resend failed:', resendErr);
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return { confirmed: false, error: 'Confirmation timeout' };
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasAutoConnected, setHasAutoConnected] = useState(false);
  // Store reference to the original Wallet Standard wallet for feature access
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const standardWalletRef = useRef<any>(null);
  // Dev wallet secret key for local signing
  const devSecretKeyRef = useRef<Uint8Array | null>(null);

  // Get available wallets from the Wallet Standard registry
  const getWallets = useCallback((): Wallet[] => {
    if (typeof window === 'undefined') return [];

    try {
      // Use the proper Wallet Standard API
      const { get } = getStandardWallets();
      const standardWallets = get();
      if (standardWallets.length > 0) {
        return standardWallets as unknown as Wallet[];
      }
    } catch (e) {
      console.warn('Failed to get standard wallets:', e);
    }

    return [];
  }, []);

  // Connect to first available wallet
  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const wallets = getWallets();

      if (wallets.length === 0) {
        // Fallback: check for Backpack (uses window.backpack.solana)
        const backpackWindow = window as unknown as {
          backpack?: {
            solana?: {
              connect: () => Promise<{ publicKey: { toBase58: () => string; toBytes: () => Uint8Array } }>;
              signMessage: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
              disconnect: () => Promise<void>;
            };
          };
        };

        if (backpackWindow.backpack?.solana) {
          const backpack = backpackWindow.backpack.solana;
          const response = await backpack.connect();

          const mockWallet: Wallet = {
            name: 'Backpack',
            icon: '',
            accounts: [
              {
                address: response.publicKey.toBase58(),
                publicKey: response.publicKey.toBytes(),
                chains: ['solana:devnet'],
                features: ['solana:signMessage'],
              },
            ],
            features: {
              'standard:connect': true,
            },
          };

          setWallet(mockWallet);
          setAccount(mockWallet.accounts[0] ?? null);
          localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
          return;
        }

        // Fallback: check for Phantom
        const phantomWindow = window as unknown as {
          phantom?: {
            solana?: {
              isPhantom: boolean;
              connect: () => Promise<{ publicKey: { toBase58: () => string; toBytes: () => Uint8Array } }>;
              signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
              disconnect: () => Promise<void>;
            };
          };
        };

        if (phantomWindow.phantom?.solana) {
          const phantom = phantomWindow.phantom.solana;
          const response = await phantom.connect();

          const mockWallet: Wallet = {
            name: 'Phantom',
            icon: '',
            accounts: [
              {
                address: response.publicKey.toBase58(),
                publicKey: response.publicKey.toBytes(),
                chains: ['solana:devnet'],
                features: ['solana:signMessage'],
              },
            ],
            features: {
              'standard:connect': true,
              'solana:signMessage': {
                signMessage: phantom.signMessage.bind(phantom),
              },
            },
          };

          setWallet(mockWallet);
          setAccount(mockWallet.accounts[0] ?? null);
          localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
          return;
        }

        throw new Error('No wallet found. Please install a Solana wallet.');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const selectedWallet = wallets[0] as any;

      // Store original wallet ref for feature access
      standardWalletRef.current = selectedWallet;

      // Connect using standard:connect feature if available
      const connectFeature = selectedWallet.features?.['standard:connect'];
      if (connectFeature?.connect) {
        await connectFeature.connect();
      } else if (selectedWallet.connect) {
        await selectedWallet.connect();
      }

      if (!selectedWallet.accounts || selectedWallet.accounts.length === 0) {
        throw new Error('No accounts available');
      }

      console.log('Wallet Standard wallet connected:', selectedWallet.name);
      console.log('Features:', Object.keys(selectedWallet.features || {}));

      setWallet(selectedWallet);
      setAccount(selectedWallet.accounts[0] ?? null);
      localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      throw error;
    } finally {
      setIsConnecting(false);
    }
  }, [getWallets]);

  // Disconnect wallet
  const disconnect = useCallback(() => {
    setWallet(null);
    setAccount(null);
    devSecretKeyRef.current = null;
    standardWalletRef.current = null;
    localStorage.removeItem(WALLET_CONNECTED_KEY);
    localStorage.removeItem(DEV_WALLET_KEY);
  }, []);

  // Connect a dev wallet using a local keypair (bypasses wallet extension)
  const connectDevWallet = useCallback((secretKeyBase58?: string) => {
    let secretKey: Uint8Array;

    if (secretKeyBase58) {
      // Use provided key
      secretKey = bs58.decode(secretKeyBase58);
    } else {
      // Check localStorage for existing dev wallet
      const stored = localStorage.getItem(DEV_WALLET_KEY);
      if (stored) {
        secretKey = bs58.decode(stored);
      } else {
        // Generate new keypair
        secretKey = ed25519.utils.randomSecretKey();
      }
    }

    // Full keypair (64 bytes) - extract first 32 as secret key
    if (secretKey.length === 64) {
      secretKey = secretKey.slice(0, 32);
    }

    // Store for signing
    devSecretKeyRef.current = secretKey;
    localStorage.setItem(DEV_WALLET_KEY, bs58.encode(secretKey));

    // Derive public key
    const publicKeyBytes = ed25519.getPublicKey(secretKey);
    const publicKeyBase58 = bs58.encode(publicKeyBytes);

    console.log('Dev wallet connected:', publicKeyBase58);

    const devWallet: Wallet = {
      name: 'Dev Wallet',
      icon: '',
      accounts: [
        {
          address: publicKeyBase58,
          publicKey: publicKeyBytes,
          chains: ['solana:devnet'],
          features: ['solana:signMessage'],
        },
      ],
      features: {
        'standard:connect': true,
      },
    };

    setWallet(devWallet);
    setAccount(devWallet.accounts[0] ?? null);
    localStorage.setItem(WALLET_CONNECTED_KEY, 'dev');
  }, []);

  // Sign a message
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (!wallet || !account) {
        throw new Error('Wallet not connected');
      }

      // Dev wallet: sign locally
      if (wallet.name === 'Dev Wallet' && devSecretKeyRef.current) {
        const signature = ed25519.sign(message, devSecretKeyRef.current);
        return signature;
      }

      // Try Backpack direct API first (it has issues with Wallet Standard Buffer encoding)
      if (wallet.name === 'Backpack') {
        const backpackWindow = window as unknown as {
          backpack?: {
            solana?: {
              signMessage: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
            };
          };
        };

        if (backpackWindow.backpack?.solana?.signMessage) {
          const result = await backpackWindow.backpack.solana.signMessage(message);
          return result.signature;
        }
      }

      // Try Phantom direct API
      if (wallet.name === 'Phantom') {
        const phantomWindow = window as unknown as {
          phantom?: {
            solana?: {
              signMessage: (message: Uint8Array, encoding: string) => Promise<{ signature: Uint8Array }>;
            };
          };
        };

        if (phantomWindow.phantom?.solana) {
          const result = await phantomWindow.phantom.solana.signMessage(message, 'utf8');
          return result.signature;
        }
      }

      // Fallback: Try Wallet Standard feature
      const signMessageFeature = wallet.features['solana:signMessage'] as
        | { signMessage: (params: { message: Uint8Array; account: WalletAccount }) => Promise<{ signature: Uint8Array }[]> }
        | undefined;

      if (signMessageFeature) {
        const result = await signMessageFeature.signMessage({ message, account });
        return result[0]?.signature ?? new Uint8Array();
      }

      throw new Error('Wallet does not support message signing');
    },
    [wallet, account]
  );

  // Sign and send a transaction
  const signAndSendTransaction = useCallback(
    async (transaction: Uint8Array): Promise<string> => {
      if (!wallet || !account) {
        throw new Error('Wallet not connected');
      }

      // Dev wallet: sign locally and send directly to RPC
      if (wallet.name === 'Dev Wallet' && devSecretKeyRef.current) {
        const decodedTx = getTransactionDecoder().decode(transaction);
        const signature = ed25519.sign(new Uint8Array(decodedTx.messageBytes), devSecretKeyRef.current);

        // Fill in only the dev wallet's own signature slot; preserve any
        // signatures already present (e.g. pre-signed context-state signers).
        const signedTx: Transaction = {
          ...decodedTx,
          signatures: Object.freeze({
            ...decodedTx.signatures,
            [address(account.address)]: signature as SignatureBytes,
          }),
        };

        const serializedTx = getTransactionEncoder().encode(signedTx);
        const base64Tx = btoa(String.fromCharCode(...serializedTx));
        const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';

        // Debug: simulate first to get program logs
        console.log('Dev wallet: simulating transaction first...');
        const simResponse = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'simulateTransaction',
            params: [base64Tx, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]
          })
        });
        const simResult = await simResponse.json();
        if (simResult.result?.value?.err) {
          console.log('SIMULATION ERROR:', JSON.stringify(simResult.result.value.err));
        }
        if (simResult.result?.value?.logs) {
          console.log('SIMULATION LOGS:');
          simResult.result.value.logs.forEach((log: string) => console.log('  ', log));
        }

        console.log('Dev wallet: sending signed transaction to RPC...');
        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base64Tx, { skipPreflight: true, encoding: 'base64' }]
          })
        });
        const result = await response.json();
        console.log('Dev wallet RPC response:', result);

        if (result.error) {
          throw new Error(result.error.message || JSON.stringify(result.error));
        }

        const sig = result.result;
        const confirmResult = await waitForConfirmation(rpcUrl, sig, 30000);
        if (!confirmResult.confirmed) {
          const errMsg = confirmResult.error
            ? `Transaction failed: ${JSON.stringify(confirmResult.error)}`
            : 'Transaction not confirmed within timeout';
          throw new Error(errMsg);
        }
        console.log('Dev wallet transaction confirmed!', sig);
        return sig;
      }

      // Backpack: verify the connected wallet matches the transaction fee payer
      // before signing (prevents errors when the user switches wallets in
      // Backpack). Signing itself goes through the Wallet Standard flow below.
      if (wallet.name === 'Backpack') {
        const backpackWindow = window as unknown as {
          backpack?: {
            solana?: {
              connect: () => Promise<{ publicKey: { toBase58: () => string; toBytes: () => Uint8Array } }>;
            };
          };
        };

        const backpack = backpackWindow.backpack?.solana;
        if (backpack) {
          const connectedResponse = await backpack.connect();
          const currentWalletPubkey = connectedResponse.publicKey.toBase58();

          // Decode the wire transaction; the first entry in the signatures map
          // is the fee payer.
          const decodedTx = getTransactionDecoder().decode(transaction);
          const feePayer = Object.keys(decodedTx.signatures)[0];

          if (currentWalletPubkey !== feePayer) {
            // Update our stored wallet state to match Backpack's current wallet
            const updatedWallet: Wallet = {
              name: 'Backpack',
              icon: '',
              accounts: [
                {
                  address: currentWalletPubkey,
                  publicKey: connectedResponse.publicKey.toBytes(),
                  chains: ['solana:devnet'],
                  features: ['solana:signMessage'],
                },
              ],
              features: {
                'standard:connect': true,
              },
            };
            setWallet(updatedWallet);
            setAccount(updatedWallet.accounts[0] ?? null);

            throw new Error(`Wallet changed: Now connected to ${currentWalletPubkey.slice(0, 8)}... Please try the operation again.`);
          }
        }
      }

      // Try Phantom direct API
      if (wallet.name === 'Phantom') {
        const phantomWindow = window as unknown as {
          phantom?: {
            solana?: {
              signAndSendTransaction: (transaction: { serialize: () => Uint8Array }) => Promise<{ signature: string }>;
              request: (params: { method: string; params: { message: string; options?: object } }) => Promise<{ signature: string }>;
            };
          };
        };

        if (phantomWindow.phantom?.solana) {
          // Phantom expects a base64 encoded transaction for signAndSendTransaction
          const base64Tx = btoa(String.fromCharCode(...transaction));
          const result = await phantomWindow.phantom.solana.request({
            method: 'signAndSendTransaction',
            params: {
              message: base64Tx,
              options: { skipPreflight: false },
            },
          });
          return result.signature;
        }
      }

      // Try Wallet Standard signTransaction + manual send
      // Check both the stored wallet and the standardWalletRef for features
      const wsWallet = standardWalletRef.current || wallet;
      const wsAccount = wsWallet?.accounts?.[0] || account;
      console.log('Wallet Standard features available:', Object.keys(wsWallet?.features || {}));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signFeature = wsWallet?.features?.['solana:signTransaction'] as any;

      if (signFeature?.signTransaction && wsAccount) {
        try {
          console.log('Trying Wallet Standard signTransaction + manual send...');
          const signResults = await signFeature.signTransaction({
            transaction,
            account: wsAccount,
            chain: 'solana:devnet',
          });
          // Wallet Standard may return array or single result
          const signedTransaction = Array.isArray(signResults)
            ? signResults[0]?.signedTransaction
            : signResults?.signedTransaction;

          // Send to the RPC ourselves
          const base64Tx = btoa(String.fromCharCode(...signedTransaction));
          const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';

          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sendTransaction',
              params: [base64Tx, { skipPreflight: true, encoding: 'base64' }]
            })
          });
          const result = await response.json();
          console.log('Wallet Standard sign + manual send RPC response:', result);

          if (result.error) {
            throw new Error(result.error.message || JSON.stringify(result.error));
          }

          const signature = result.result;
          const confirmResult = await waitForConfirmation(rpcUrl, signature, 30000);
          if (!confirmResult.confirmed) {
            const errMsg = confirmResult.error
              ? `Transaction failed: ${JSON.stringify(confirmResult.error)}`
              : 'Transaction not confirmed within timeout';
            throw new Error(errMsg);
          }
          console.log('Transaction confirmed via Wallet Standard sign!', signature);
          return signature;
        } catch (wsSignError) {
          console.error('Wallet Standard signTransaction failed:', wsSignError);
          // Fall through to signAndSendTransaction
        }
      }

      // Try Wallet Standard signAndSendTransaction
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signAndSendFeature = wsWallet?.features?.['solana:signAndSendTransaction'] as any;

      if (signAndSendFeature?.signAndSendTransaction && wsAccount) {
        try {
          const sendResults = await signAndSendFeature.signAndSendTransaction({
            transaction,
            account: wsAccount,
            chain: 'solana:devnet',
            options: { skipPreflight: true },
          });
          // Wallet Standard may return array or single result
          const result = Array.isArray(sendResults) ? sendResults[0] : sendResults;
          return result.signature;
        } catch (wsError) {
          const errorMsg = wsError instanceof Error
            ? wsError.message
            : typeof wsError === 'object' && wsError !== null
              ? JSON.stringify(wsError)
              : String(wsError);
          throw new Error(`Wallet transaction failed: ${errorMsg}`);
        }
      }

      throw new Error('Wallet does not support transaction signing');
    },
    [wallet, account]
  );

  const publicKey = account?.address ?? null;
  const isConnected = !!account;

  // Listen for account changes
  useEffect(() => {
    const handleAccountChange = () => {
      // Re-fetch wallet state
      const wallets = getWallets();
      if (wallets.length > 0 && wallets[0]!.accounts.length > 0) {
        setWallet(wallets[0]!);
        setAccount(wallets[0]!.accounts[0] ?? null);
      }
    };

    window.addEventListener('wallet-standard:wallet-added', handleAccountChange);
    return () => {
      window.removeEventListener('wallet-standard:wallet-added', handleAccountChange);
    };
  }, [getWallets]);

  // Auto-reconnect on page load if previously connected
  useEffect(() => {
    if (hasAutoConnected) return;

    const wasConnected = localStorage.getItem(WALLET_CONNECTED_KEY);
    if (wasConnected && !isConnected && !isConnecting) {
      setHasAutoConnected(true);

      if (wasConnected === 'dev') {
        // Reconnect dev wallet from stored key
        connectDevWallet();
        return;
      }

      // Small delay to let wallet extensions initialize
      const timer = setTimeout(() => {
        connect().catch((err) => {
          console.log('Auto-reconnect failed:', err);
          // Clear the flag if auto-connect fails
          localStorage.removeItem(WALLET_CONNECTED_KEY);
        });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [hasAutoConnected, isConnected, isConnecting, connect, connectDevWallet]);

  return (
    <WalletContext.Provider
      value={{
        wallet,
        account,
        publicKey,
        isConnected,
        isConnecting,
        connect,
        connectDevWallet,
        disconnect,
        signMessage,
        signAndSendTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
