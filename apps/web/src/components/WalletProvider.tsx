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
import { createKitSignersFromWallet, createSolanaDevnet } from '@solana/connector/headless';
import {
  createSignableMessage,
  type MessagePartialSigner,
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

  // ConnectorKit's headless helper wires the wallet's `solana:signMessage`
  // feature into a kit message signer.
  const walletMessageSigner = useMemo(
    () => createKitSignersFromWallet(standardWallet, standardAccount, null, 'devnet').messageSigner,
    [standardWallet, standardAccount]
  );

  // Raw bytes-in/bytes-out signing for auth login.
  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      if (!walletMessageSigner) {
        throw new Error('Wallet not connected or does not support message signing');
      }
      const [signed] = await walletMessageSigner.modifyAndSignMessages([
        createSignableMessage(message),
      ]);
      const signature = signed?.signatures[walletMessageSigner.address];
      if (!signature) {
        throw new Error('Wallet returned no signature');
      }
      return new Uint8Array(signature);
    },
    [walletMessageSigner]
  );

  // deriveCtKeys expects a kit MessagePartialSigner; adapt the ConnectorKit
  // message signer (wallets sign one message at a time) to that interface.
  const messageSigner = useMemo<MessagePartialSigner | null>(() => {
    if (!walletMessageSigner) return null;
    const signerAddress = walletMessageSigner.address;
    return {
      address: signerAddress,
      signMessages: async (messages) => {
        const dictionaries: SignatureDictionary[] = [];
        for (const message of messages) {
          const [signed] = await walletMessageSigner.modifyAndSignMessages([
            createSignableMessage(new Uint8Array(message.content)),
          ]);
          dictionaries.push((signed?.signatures ?? Object.freeze({})) as SignatureDictionary);
        }
        return dictionaries;
      },
    };
  }, [walletMessageSigner]);

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
