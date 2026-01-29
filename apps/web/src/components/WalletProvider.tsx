'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

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

export function WalletProvider({ children }: WalletProviderProps) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

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
  }, []);

  // Sign a message
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (!wallet || !account) {
        throw new Error('Wallet not connected');
      }

      // Try Phantom direct API first
      const phantomWindow = window as unknown as {
        phantom?: {
          solana?: {
            signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
          };
        };
      };

      if (phantomWindow.phantom?.solana) {
        const result = await phantomWindow.phantom.solana.signMessage(message);
        return result.signature;
      }

      // Try Wallet Standard feature
      const signMessageFeature = wallet.features['solana:signMessage'] as
        | { signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }> }
        | undefined;

      if (signMessageFeature) {
        const result = await signMessageFeature.signMessage(message);
        return result.signature;
      }

      throw new Error('Wallet does not support message signing');
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
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
