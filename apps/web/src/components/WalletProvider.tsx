'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  AppProvider,
  getDefaultConfig,
  useConnectWallet,
  useConnectorClient,
  useDisconnectWallet,
  useKitTransactionSigner,
  useWallet as useConnectorWallet,
  useWalletConnectors,
  useWalletInfo,
} from '@solana/connector/react';
import { createSolanaDevnet } from '@solana/connector/headless';
import {
  address,
  type MessagePartialSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionSigner,
} from '@solana/kit';

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const connectorConfig = getDefaultConfig({
  appName: 'Confidential Transfer Explorer',
  network: 'devnet',
  autoConnect: true,
  clusters: [createSolanaDevnet({ url: RPC_URL })],
});

interface WalletContextType {
  /** Connected wallet address (base58) or null */
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** Name of the connected wallet (e.g. 'Phantom') */
  walletName: string | null;
  /** Icon URL / data URI of the connected wallet */
  walletIcon: string | null;
  /** Open the wallet picker so the user can choose which wallet to connect */
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Sign raw bytes with the connected wallet (auth login) */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  /** Kit MessagePartialSigner for ElGamal/AES key derivation */
  messageSigner: MessagePartialSigner | null;
  /** Kit TransactionSigner used as fee payer / authority for instruction plans */
  transactionSigner: TransactionSigner | null;
}

const WalletContext = createContext<WalletContextType | null>(null);

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}

function WalletContextBridge({ children }: { children: ReactNode }) {
  const { isConnected, isConnecting, account, session, connectorId } = useConnectorWallet();
  const { name: walletName, icon: walletIcon } = useWalletInfo();
  const client = useConnectorClient();
  const connectors = useWalletConnectors();
  const { connect: connectById } = useConnectWallet();
  const { disconnect } = useDisconnectWallet();
  const { signer: kitSigner } = useKitTransactionSigner();

  const publicKey = account ? String(account) : null;

  // The underlying wallet-standard wallet + account for the active session.
  const standardWallet = useMemo(
    () => (connectorId && client ? client.getConnector(connectorId) ?? null : null),
    [connectorId, client]
  );
  const standardAccount = session?.selectedAccount.account ?? null;

  // Sign raw bytes with the wallet's `solana:signMessage` feature, calling it
  // directly with the spec-compliant input ({ account, message } only — no
  // chain param, which some wallets reject) and propagating the wallet's REAL
  // error message instead of a generic "Failed to sign message".
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (!standardWallet || !standardAccount) {
        throw new Error('Wallet not connected');
      }
      const signFeature = standardWallet.features['solana:signMessage'] as
        | {
            signMessage: (input: {
              account: typeof standardAccount;
              message: Uint8Array;
            }) => Promise<readonly { signature: Uint8Array }[]>;
          }
        | undefined;
      if (!signFeature) {
        throw new Error(
          `${standardWallet.name ?? 'This wallet'} does not support message signing (solana:signMessage). ` +
            'Try Phantom, Solflare, or Backpack.'
        );
      }

      try {
        const results = await signFeature.signMessage({
          account: standardAccount,
          message,
        });
        const signature = results?.[0]?.signature;
        if (!signature) {
          throw new Error('Wallet returned no signature');
        }
        return new Uint8Array(signature);
      } catch (error) {
        // Surface the wallet's actual failure, walking the cause chain.
        const parts: string[] = [];
        let current: unknown = error;
        while (current) {
          const msg =
            current instanceof Error
              ? current.message
              : typeof current === 'string'
                ? current
                : null;
          if (msg && !parts.includes(msg)) parts.push(msg);
          current = current instanceof Error ? current.cause : null;
        }
        throw new Error(
          `Wallet message signing failed (${standardWallet.name ?? 'unknown wallet'}): ${
            parts.join(' — ') || String(error)
          }`
        );
      }
    },
    [standardWallet, standardAccount]
  );

  // deriveCtKeys expects a kit MessagePartialSigner (wallets sign one message
  // at a time, so messages are signed sequentially).
  const messageSigner = useMemo<MessagePartialSigner | null>(() => {
    if (!standardAccount) return null;
    const signerAddress = address(standardAccount.address);
    return {
      address: signerAddress,
      signMessages: async (messages) => {
        const dictionaries: SignatureDictionary[] = [];
        for (const message of messages) {
          const signature = await signMessage(new Uint8Array(message.content));
          dictionaries.push(
            Object.freeze({ [signerAddress]: signature as SignatureBytes })
          );
        }
        return dictionaries;
      },
    };
  }, [standardAccount, signMessage]);

  const transactionSigner = useMemo(
    () => (kitSigner as TransactionSigner | null) ?? null,
    [kitSigner]
  );

  // Never auto-pick a wallet: browsers like Brave register a built-in wallet
  // even when the user has never set it up, so "first ready connector" would
  // silently grab the wrong one. connect() always opens the picker instead.
  const [isPickerOpen, setPickerOpen] = useState(false);

  const connect = useCallback(async () => {
    setPickerOpen(true);
  }, []);

  const handlePickWallet = useCallback(
    async (connectorId: string) => {
      setPickerOpen(false);
      try {
        await connectById(connectorId as Parameters<typeof connectById>[0]);
      } catch (error) {
        console.error('Failed to connect wallet:', error);
      }
    },
    [connectById]
  );

  const value = useMemo<WalletContextType>(
    () => ({
      publicKey,
      isConnected,
      isConnecting,
      walletName,
      walletIcon,
      connect,
      disconnect,
      signMessage,
      messageSigner,
      transactionSigner,
    }),
    [
      publicKey,
      isConnected,
      isConnecting,
      walletName,
      walletIcon,
      connect,
      disconnect,
      signMessage,
      messageSigner,
      transactionSigner,
    ]
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {isPickerOpen && (
        <WalletPickerModal
          connectors={connectors}
          onSelect={handlePickWallet}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </WalletContext.Provider>
  );
}

interface WalletPickerModalProps {
  connectors: ReturnType<typeof useWalletConnectors>;
  onSelect: (connectorId: string) => void;
  onClose: () => void;
}

function WalletPickerModal({ connectors, onSelect, onClose }: WalletPickerModalProps) {
  const installed = connectors.filter((connector) => connector.ready);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className="w-full max-w-xs bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-zinc-800">
            <span className="text-xs text-zinc-400 uppercase tracking-wider">Select wallet</span>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="p-2">
            {installed.length === 0 ? (
              <p className="px-3 py-4 text-xs text-zinc-500">
                No Solana wallet found. Install Phantom, Solflare, or Backpack, then reload this
                page.
              </p>
            ) : (
              installed.map((connector) => (
                <button
                  key={connector.id}
                  onClick={() => onSelect(connector.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 rounded transition-colors"
                >
                  {connector.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={connector.icon} alt="" className="w-5 h-5 rounded" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500" />
                  )}
                  {connector.name}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  return (
    <AppProvider connectorConfig={connectorConfig}>
      <WalletContextBridge>{children}</WalletContextBridge>
    </AppProvider>
  );
}
