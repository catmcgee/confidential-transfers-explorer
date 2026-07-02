'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
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
  /** Connect to the first available wallet (used by inline connect buttons) */
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

  // Convenience connect used by inline "Connect Wallet" buttons: connect to
  // the first installed wallet.
  const connect = useCallback(async () => {
    const target = connectors.find((connector) => connector.ready) ?? connectors[0];
    if (!target) {
      throw new Error('No wallet found. Please install a Solana wallet.');
    }
    await connectById(target.id);
  }, [connectors, connectById]);

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

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
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
