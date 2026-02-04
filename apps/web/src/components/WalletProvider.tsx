'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { VersionedTransaction } from '@solana/web3.js';

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
  disconnect: () => void;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signAndSendTransaction: (transaction: Uint8Array) => Promise<string>;
}

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
 * Wait for a transaction to be confirmed
 */
async function waitForConfirmation(rpcUrl: string, signature: string, timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 1000; // Check every second

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
          return true;
        }
        if (status.err) {
          console.error('Transaction failed:', status.err);
          return false;
        }
      }
    } catch (e) {
      console.warn('Error checking confirmation:', e);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasAutoConnected, setHasAutoConnected] = useState(false);

  // Get available wallets from the Wallet Standard registry
  const getWallets = useCallback((): Wallet[] => {
    if (typeof window === 'undefined') return [];

    // Access wallets through the standard registry
    const windowWithWallets = window as unknown as {
      navigator?: {
        wallets?: {
          get?: () => Wallet[];
        };
      };
    };

    // Try Wallet Standard API
    const wallets = windowWithWallets.navigator?.wallets?.get?.() ?? [];
    return wallets;
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

      const selectedWallet = wallets[0]!;

      // Connect if needed
      if (selectedWallet.connect) {
        await selectedWallet.connect();
      }

      if (selectedWallet.accounts.length === 0) {
        throw new Error('No accounts available');
      }

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
    localStorage.removeItem(WALLET_CONNECTED_KEY);
  }, []);

  // Sign a message
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (!wallet || !account) {
        throw new Error('Wallet not connected');
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

      // Try Backpack direct API first
      if (wallet.name === 'Backpack') {
        const backpackWindow = window as unknown as {
          backpack?: {
            solana?: {
              connect: () => Promise<{ publicKey: { toBase58: () => string; toBytes: () => Uint8Array } }>;
              signAndSendTransaction: (
                transaction: VersionedTransaction,
                options?: { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: string }
              ) => Promise<{ signature: string }>;
              signTransaction: (
                transaction: VersionedTransaction
              ) => Promise<VersionedTransaction>;
              connection?: {
                sendRawTransaction: (
                  transaction: Uint8Array,
                  options?: { skipPreflight?: boolean; maxRetries?: number }
                ) => Promise<string>;
              };
            };
          };
        };

        const backpack = backpackWindow.backpack?.solana;
        if (backpack) {
          // Verify the connected wallet matches the transaction fee payer
          // This prevents errors when user switches wallets in Backpack
          const connectedResponse = await backpack.connect();
          const currentWalletPubkey = connectedResponse.publicKey.toBase58();

          // Deserialize the transaction bytes into a proper VersionedTransaction
          const versionedTx = VersionedTransaction.deserialize(transaction);
          const feePayer = versionedTx.message.staticAccountKeys[0]?.toBase58();

          console.log('Current Backpack wallet:', currentWalletPubkey);
          console.log('Transaction fee payer:', feePayer);

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

          console.log('VersionedTransaction created:', versionedTx);
          console.log('Transaction message:', versionedTx.message);
          console.log('Message header:', versionedTx.message.header);
          console.log('Num required signatures:', versionedTx.message.header.numRequiredSignatures);
          console.log('Static account keys:', versionedTx.message.staticAccountKeys.map(k => k.toBase58()));
          console.log('Signatures array length:', versionedTx.signatures.length);

          // Try signing first, then sending manually to avoid Backpack's internal simulation
          if (backpack.signTransaction) {
            try {
              console.log('Trying sign-then-send approach...');
              const signedTx = await backpack.signTransaction(versionedTx);
              console.log('Transaction signed:', signedTx);

              // Send raw transaction directly to RPC (skip simulation for custom RPC with mock blockhashes)
              const serializedTx = signedTx.serialize();
              const base64Tx = btoa(String.fromCharCode(...serializedTx));
              const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://zk-edge.surfnet.dev:8899';

              // Send transaction directly without simulation (custom RPC has issues with simulation)
              console.log('Sending transaction (skipping simulation for custom RPC)...');
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
              console.log('RPC response:', result);

              if (result.error) {
                throw new Error(result.error.message || JSON.stringify(result.error));
              }

              // Wait for confirmation before returning
              const signature = result.result;
              console.log('Transaction sent, waiting for confirmation...', signature);

              const confirmed = await waitForConfirmation(rpcUrl, signature, 30000);
              if (!confirmed) {
                throw new Error('Transaction not confirmed within timeout');
              }
              console.log('Transaction confirmed!', signature);

              return signature;
            } catch (signError) {
              console.log('Sign-then-send failed, trying signAndSendTransaction:', signError);
            }
          }

          // Fallback to signAndSendTransaction
          if (backpack.signAndSendTransaction) {
            const result = await backpack.signAndSendTransaction(
              versionedTx,
              { skipPreflight: true, maxRetries: 3 }
            );
            return result.signature;
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

      // Try Wallet Standard feature (for other wallets)
      const signAndSendFeature = wallet.features['solana:signAndSendTransaction'] as
        | { signAndSendTransaction: (transaction: Uint8Array) => Promise<{ signature: string }> }
        | undefined;

      if (signAndSendFeature) {
        const result = await signAndSendFeature.signAndSendTransaction(transaction);
        return result.signature;
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

    const wasConnected = localStorage.getItem(WALLET_CONNECTED_KEY) === 'true';
    if (wasConnected && !isConnected && !isConnecting) {
      setHasAutoConnected(true);
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
  }, [hasAutoConnected, isConnected, isConnecting, connect]);

  return (
    <WalletContext.Provider
      value={{
        wallet,
        account,
        publicKey,
        isConnected,
        isConnecting,
        connect,
        disconnect,
        signMessage,
        signAndSendTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
