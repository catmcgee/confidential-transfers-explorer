'use client';

import { useState, useEffect, useRef } from 'react';
import { createSolanaRpc, singleInstructionPlan } from '@solana/kit';
import { useWallet } from './WalletProvider';
import { shortenAddress } from '@/lib/format';
import {
  deriveCtKeys,
  createConfigureAccountPlan,
  createDepositInstruction,
  createApplyPendingBalanceInstruction,
  createTransferPlan,
  executeInstructionPlan,
  decryptAeBalance,
  decryptElGamalBalance,
  parseElGamalPubkeyFromAccountInfo,
  type CtKeys,
} from '@/lib/confidentialTransfer';
import { createWalletMessageSigner, createWalletSendingSigner } from '@/lib/kitSigners';

// Progress tracking type (local since it's UI-specific)
interface TransferProgress {
  step: 'generating_proofs' | 'executing_transfer' | 'complete' | 'error';
  currentTransaction: number;
  totalTransactions: number;
  signature?: string;
  error?: string;
}

// A confidential transfer on devnet verifies its ZK proofs into context-state
// accounts across several transactions before the transfer itself executes.
// This is only an estimate used for the progress bar until the plan finishes.
const ESTIMATED_TRANSFER_TRANSACTIONS = 5;

const TRANSFER_FACTS = [
  'Zero-knowledge proofs let you prove a fact without revealing the secret itself.',
  'Confidential Transfer splits proof generation and transfer execution into separate steps.',
  'ElGamal encryption supports homomorphic operations on encrypted balances.',
  'Pending balances must be applied before they become spendable confidential balances.',
  'Range proofs verify an amount stays in bounds without exposing the amount.',
  'Wallet signatures can derive deterministic local keys without storing a seed server-side.',
  'Grouped ciphertexts can include sender, recipient, and auditor handles together.',
  'A decryptable available balance lets the owner recover their own confidential state.',
];

function getRandomTransferFact() {
  return TRANSFER_FACTS[Math.floor(Math.random() * TRANSFER_FACTS.length)] ?? TRANSFER_FACTS[0]!;
}

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTransferComplete?: (transferData: {
    signature: string;
    instructionType: string;
    mint: string | null;
    sourceOwner: string | null;
    destOwner: string | null;
    sourceTokenAccount: string | null;
    destTokenAccount: string | null;
    amount: string;
  }) => void;
}

interface CtAccountState {
  elgamalPubkey: string;
  pendingBalanceLo: string;
  pendingBalanceHi: string;
  availableBalance: string;
  decryptableAvailableBalance: string;
  actualPendingBalanceCreditCounter: number;
  expectedPendingBalanceCreditCounter: number;
  pendingBalanceCreditCounter: number;
}

interface TokenAccount {
  address: string;
  mint: string;
  balance: string;
  decimals: number;
  isCtConfigured: boolean;
  ctState?: CtAccountState;
}

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Single kit RPC client shared by all confidential-transfer operations.
const rpc = createSolanaRpc(RPC_URL);

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      {copied ? 'Copied!' : (label || 'Copy')}
    </button>
  );
}

export function TransferModal({ isOpen, onClose, onTransferComplete }: TransferModalProps) {
  const { isConnected, publicKey, connect, isConnecting, signMessage, signAndSendTransaction } = useWallet();
  const [tokens, setTokens] = useState<TokenAccount[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuringAccount, setConfiguringAccount] = useState<string | null>(null);
  const [configureError, setConfigureError] = useState<string | null>(null);
  const configuringRef = useRef(false);

  // New state for operations
  const [selectedToken, setSelectedToken] = useState<TokenAccount | null>(null);
  const [operation, setOperation] = useState<'deposit' | 'apply' | 'transfer' | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  // Recipient lookup state
  const [recipientInfo, setRecipientInfo] = useState<{
    walletAddress: string;
    tokenAccountAddress: string;
    isCtConfigured: boolean;
    elgamalPubkey: Uint8Array | null;
    balance: string;
  } | null>(null);
  const [isLookingUpRecipient, setIsLookingUpRecipient] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  // Faucet state
  const [isRequestingTokens, setIsRequestingTokens] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [faucetSuccess, setFaucetSuccess] = useState(false);

  // Transfer progress state
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);

  // Decryption loading states
  const [isDecryptingPending, setIsDecryptingPending] = useState(false);
  const [isDecryptingConfidential, setIsDecryptingConfidential] = useState(false);

  // Simple state for decrypted balances (current view only)
  const [decryptedPendingBalance, setDecryptedPendingBalance] = useState<bigint | null>(null);
  const [decryptedConfidentialBalance, setDecryptedConfidentialBalance] = useState<bigint | null>(null);

  // Easter egg: fun ZK facts during transfer
  const [funFact, setFunFact] = useState('');

  useEffect(() => {
    if (transferProgress && !['complete', 'error'].includes(transferProgress.step)) {
      setFunFact(getRandomTransferFact());
      const interval = setInterval(() => {
        setFunFact(getRandomTransferFact());
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [transferProgress?.step]);

  // Cached keys - derivation requires a wallet signature, so cache per mint.
  // Keys are bound to (owner, mint), not the token-account address.
  const [cachedKeys, setCachedKeys] = useState<Record<string, CtKeys>>({});

  // Derive the confidential-transfer keys for a mint via wallet signMessage.
  const getCtKeys = async (mintAddress: string): Promise<CtKeys> => {
    const cached = cachedKeys[mintAddress];
    if (cached) return cached;
    if (!publicKey) throw new Error('Wallet not connected');

    const messageSigner = createWalletMessageSigner(publicKey, signMessage);
    try {
      const keys = await deriveCtKeys(messageSigner, publicKey, mintAddress);
      setCachedKeys(prev => ({ ...prev, [mintAddress]: keys }));
      return keys;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('UserKeyring') || errMsg.includes('signMessage') || errMsg.includes('locked')) {
        throw new Error('Message signing failed. Make sure your wallet is connected and unlocked.');
      }
      throw err;
    }
  };

  // Wallet-backed sending signer used as fee payer / authority for plans.
  const getWalletSigner = () => {
    if (!publicKey) throw new Error('Wallet not connected');
    return createWalletSendingSigner(publicKey, signAndSendTransaction);
  };

  // Select a token - reset decrypted balances, keys will be derived on decrypt
  const handleSelectToken = async (token: TokenAccount) => {
    // If clicking on already-selected token, don't reset operation state
    if (selectedToken?.address === token.address) {
      return;
    }
    setSelectedToken(token);
    setOperation(null);
    setOperationError(null);
    // Reset decrypted balances when selecting a new token
    setDecryptedPendingBalance(null);
    setDecryptedConfidentialBalance(null);
  };

  // Fetch fresh confidential-transfer state for a token account
  const fetchCtState = async (tokenAccountAddress: string): Promise<CtAccountState | undefined> => {
    const accountResponse = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [tokenAccountAddress, { encoding: 'jsonParsed' }]
      })
    });
    const accountData = await accountResponse.json();
    const extensions = accountData.result?.value?.data?.parsed?.info?.extensions || [];
    const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
    return ctExt?.state as CtAccountState | undefined;
  };

  // Decrypt pending balance - derives keys if needed, fetches fresh state, decrypts via ZK SDK
  const handleDecryptPending = async () => {
    if (!selectedToken) return;

    setIsDecryptingPending(true);
    try {
      const freshCtState = await fetchCtState(selectedToken.address);
      if (!freshCtState) return;

      const keys = await getCtKeys(selectedToken.mint);

      // Decrypt pending balance: lo (48-bit) and hi (16-bit) ElGamal ciphertexts
      const pendingLoBytes = Uint8Array.from(atob(freshCtState.pendingBalanceLo), c => c.charCodeAt(0));
      const pendingHiBytes = Uint8Array.from(atob(freshCtState.pendingBalanceHi), c => c.charCodeAt(0));

      const pendingLo = await decryptElGamalBalance(keys.elgamalSecretKey, pendingLoBytes);
      const pendingHi = await decryptElGamalBalance(keys.elgamalSecretKey, pendingHiBytes);

      if (pendingLo !== null && pendingHi !== null) {
        setDecryptedPendingBalance(pendingLo + (pendingHi << 16n));
      } else {
        setDecryptedPendingBalance(0n);
      }
    } catch (err) {
      console.error('Failed to decrypt pending balance:', err);
    } finally {
      setIsDecryptingPending(false);
    }
  };

  // Decrypt confidential balance - derives keys if needed, fetches fresh state, decrypts via ZK SDK
  const handleDecryptConfidential = async () => {
    if (!selectedToken) return;

    setIsDecryptingConfidential(true);
    try {
      const freshCtState = await fetchCtState(selectedToken.address);
      if (!freshCtState) return;

      const keys = await getCtKeys(selectedToken.mint);

      // Decode base64 to bytes and decrypt using the AES key
      const ciphertextBytes = Uint8Array.from(atob(freshCtState.decryptableAvailableBalance), c => c.charCodeAt(0));
      const balance = await decryptAeBalance(keys.aesKey, ciphertextBytes);

      setDecryptedConfidentialBalance(balance);
    } catch (err) {
      console.error('Failed to decrypt confidential balance:', err);
    } finally {
      setIsDecryptingConfidential(false);
    }
  };

  // Handle deposit (public → pending)
  const handleDeposit = async () => {
    if (!selectedToken || !publicKey || !depositAmount) return;

    setIsProcessing(true);
    setOperationError(null);

    try {
      const amount = BigInt(Math.floor(parseFloat(depositAmount) * Math.pow(10, selectedToken.decimals)));

      const walletSigner = getWalletSigner();
      const depositInstruction = createDepositInstruction({
        tokenAccountAddress: selectedToken.address,
        mintAddress: selectedToken.mint,
        authority: walletSigner,
        amount,
        decimals: selectedToken.decimals,
      });

      const { signatures } = await executeInstructionPlan({
        plan: singleInstructionPlan(depositInstruction),
        rpc,
        feePayer: walletSigner,
      });
      const signature = signatures[signatures.length - 1] ?? '';

      // Add optimistic activity to the feed immediately
      if (onTransferComplete) {
        onTransferComplete({
          signature,
          instructionType: 'Deposit',
          mint: selectedToken.mint,
          sourceOwner: publicKey,
          destOwner: null,
          sourceTokenAccount: selectedToken.address,
          destTokenAccount: selectedToken.address,
          amount: depositAmount,
        });
      }

      // Reset decrypted balances since they changed
      setDecryptedPendingBalance(null);

      // Refresh (don't let refresh failure mask a successful deposit)
      try {
        await fetchTokenAccounts();
      } catch (refreshErr) {
        console.warn('Post-deposit token refresh failed (deposit itself succeeded):', refreshErr);
      }
      setDepositAmount('');
      setOperation(null);
    } catch (err) {
      console.error('Deposit failed:', err);
      const errorMsg = err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null
          ? JSON.stringify(err)
          : String(err);
      setOperationError(errorMsg || 'Deposit failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle apply pending balance (pending → available)
  const handleApplyPendingBalance = async () => {
    if (!selectedToken || !publicKey || !selectedToken.ctState) return;

    setIsProcessing(true);
    setOperationError(null);

    try {
      const keys = await getCtKeys(selectedToken.mint);
      const walletSigner = getWalletSigner();

      // The helper fetches the token account, decrypts the pending balance
      // locally, and re-encrypts the new decryptable available balance.
      const applyInstruction = await createApplyPendingBalanceInstruction({
        rpc,
        tokenAccountAddress: selectedToken.address,
        authority: walletSigner,
        keys,
      });

      const { signatures } = await executeInstructionPlan({
        plan: singleInstructionPlan(applyInstruction),
        rpc,
        feePayer: walletSigner,
      });
      const signature = signatures[signatures.length - 1] ?? '';

      // Add optimistic activity to the feed immediately
      if (onTransferComplete) {
        onTransferComplete({
          signature,
          instructionType: 'ApplyPendingBalance',
          mint: selectedToken.mint,
          sourceOwner: publicKey,
          destOwner: null,
          sourceTokenAccount: selectedToken.address,
          destTokenAccount: selectedToken.address,
          amount: 'confidential',
        });
      }

      // Reset decrypted balances since they changed
      setDecryptedPendingBalance(null);
      setDecryptedConfidentialBalance(null);

      // Refresh (don't let refresh failure mask a successful apply)
      try {
        await fetchTokenAccounts();
      } catch (refreshErr) {
        console.warn('Post-apply token refresh failed (apply itself succeeded):', refreshErr);
      }
      setOperation(null);
    } catch (err) {
      console.error('Apply pending balance failed:', err);
      setOperationError(err instanceof Error ? err.message : 'Apply pending balance failed');
    } finally {
      setIsProcessing(false);
    }
  };

  // Look up recipient by wallet or token account address
  const lookupRecipient = async (inputAddress: string) => {
    if (!inputAddress || !selectedToken) return;

    setIsLookingUpRecipient(true);
    setRecipientError(null);
    setRecipientInfo(null);

    try {
      // First, try to fetch as a token account directly
      const accountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [inputAddress, { encoding: 'jsonParsed' }]
        })
      });
      const accountData = await accountResponse.json();

      let tokenAccountAddress = '';
      let walletAddress = '';
      let ctState: CtAccountState | null = null;
      let balance = '0';

      if (accountData.result?.value?.data?.parsed?.type === 'account') {
        // It's a token account
        const info = accountData.result.value.data.parsed.info;

        // Check if it's for the same mint
        if (info.mint !== selectedToken.mint) {
          throw new Error(`Token account is for a different mint. Expected ${shortenAddress(selectedToken.mint, 4)}`);
        }

        tokenAccountAddress = inputAddress;
        walletAddress = info.owner;
        balance = info.tokenAmount?.uiAmountString || '0';

        // Check CT extension
        const extensions = info.extensions || [];
        const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
        if (ctExt?.state) {
          ctState = ctExt.state;
        }
      } else {
        // Try as a wallet address - look for their token account
        // Use programId filter instead of mint (some RPCs have indexing issues with mint filter)
        const tokenAccountsResponse = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              inputAddress,
              { programId: TOKEN_2022_PROGRAM_ID },
              { encoding: 'jsonParsed' }
            ]
          })
        });
        const tokenAccountsData = await tokenAccountsResponse.json();

        // Filter for the correct mint
        const matchingAccounts = (tokenAccountsData.result?.value || []).filter(
          (acc: { account: { data: { parsed: { info: { mint: string } } } } }) =>
            acc.account.data.parsed.info.mint === selectedToken.mint
        );

        if (!matchingAccounts.length) {
          throw new Error(`No token account found for this wallet. They need a ${shortenAddress(selectedToken.mint, 4)} token account first.`);
        }

        // Use the first token account for this mint
        const tokenAccount = matchingAccounts[0];
        tokenAccountAddress = tokenAccount.pubkey;
        walletAddress = inputAddress;
        balance = tokenAccount.account.data.parsed.info.tokenAmount?.uiAmountString || '0';

        // Check CT extension
        const extensions = tokenAccount.account.data.parsed.info.extensions || [];
        const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
        if (ctExt?.state) {
          ctState = ctExt.state;
        }
      }

      // Parse ElGamal public key if CT is configured
      let elgamalPubkey: Uint8Array | null = null;
      if (ctState) {
        elgamalPubkey = parseElGamalPubkeyFromAccountInfo(ctState);
      }

      setRecipientInfo({
        walletAddress,
        tokenAccountAddress,
        isCtConfigured: !!ctState,
        elgamalPubkey,
        balance,
      });

      if (!ctState) {
        setRecipientError('Recipient has not configured confidential transfers on their account. They need to configure it first.');
      }
    } catch (err) {
      console.error('Recipient lookup failed:', err);
      setRecipientError(err instanceof Error ? err.message : 'Failed to look up recipient');
    } finally {
      setIsLookingUpRecipient(false);
    }
  };

  // Handle confidential transfer via the multi-transaction instruction plan
  const handleTransfer = async () => {
    if (!selectedToken || !publicKey || !transferAmount || !recipientInfo?.isCtConfigured || !recipientInfo.elgamalPubkey) {
      setOperationError('Missing required information for transfer');
      return;
    }

    if (decryptedConfidentialBalance === null) {
      // Auto-decrypt confidential balance before proceeding
      setOperationError('Decrypting your confidential balance...');
      try {
        await handleDecryptConfidential();
      } catch {
        setOperationError('Failed to decrypt confidential balance. Please try decrypting manually.');
        return;
      }
      // After decrypt, check if it succeeded (state won't be updated yet in this call)
      setOperationError('Confidential balance decrypted. Please click Send again.');
      return;
    }

    const available = decryptedConfidentialBalance;
    const amount = BigInt(Math.floor(parseFloat(transferAmount) * Math.pow(10, selectedToken.decimals)));

    if (amount > available) {
      setOperationError(`Insufficient available balance. You have ${(Number(available) / Math.pow(10, selectedToken.decimals)).toFixed(selectedToken.decimals)} available.`);
      return;
    }

    if (amount <= 0n) {
      setOperationError('Amount must be greater than 0');
      return;
    }

    setIsProcessing(true);
    setOperationError(null);
    setTransferProgress({
      step: 'generating_proofs',
      currentTransaction: 0,
      totalTransactions: ESTIMATED_TRANSFER_TRANSACTIONS,
    });

    try {
      const keys = await getCtKeys(selectedToken.mint);
      const walletSigner = getWalletSigner();

      // Build the transfer plan: generates the equality, validity, and range
      // proofs and verifies them via context-state accounts across multiple
      // transactions before executing the transfer.
      const plan = await createTransferPlan({
        rpc,
        payer: walletSigner,
        sourceTokenAccountAddress: selectedToken.address,
        destinationTokenAccountAddress: recipientInfo.tokenAccountAddress,
        mintAddress: selectedToken.mint,
        authority: walletSigner,
        amount,
        keys,
      });

      setTransferProgress({
        step: 'executing_transfer',
        currentTransaction: 0,
        totalTransactions: ESTIMATED_TRANSFER_TRANSACTIONS,
      });

      const { signatures } = await executeInstructionPlan({
        plan,
        rpc,
        feePayer: walletSigner,
        onProgress: ({ signature, index }) => {
          setTransferProgress({
            step: 'executing_transfer',
            currentTransaction: index + 1,
            // Keep the bar from hitting 100% before the plan is done
            totalTransactions: Math.max(ESTIMATED_TRANSFER_TRANSACTIONS, index + 2),
            signature,
          });
        },
      });

      const lastSignature = signatures[signatures.length - 1] ?? '';

      setTransferProgress({
        step: 'complete',
        currentTransaction: signatures.length,
        totalTransactions: signatures.length,
        signature: lastSignature,
      });

      // Add optimistic activity to the feed immediately
      if (onTransferComplete) {
        onTransferComplete({
          signature: lastSignature,
          instructionType: 'ConfidentialTransfer',
          mint: selectedToken.mint,
          sourceOwner: publicKey,
          destOwner: recipientInfo.walletAddress,
          sourceTokenAccount: selectedToken.address,
          destTokenAccount: recipientInfo.tokenAccountAddress,
          amount: 'confidential',
        });
      }

      // Reset decrypted balances since they changed
      setDecryptedConfidentialBalance(null);

      // Refresh token accounts (don't let refresh failure mask a successful transfer)
      try {
        await fetchTokenAccounts();
      } catch (refreshErr) {
        console.warn('Post-transfer token refresh failed (transfer itself succeeded):', refreshErr);
      }

    } catch (err) {
      console.error('Confidential transfer failed:', err);

      let errorMessage = 'Transfer failed';
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else {
        errorMessage = String(err);
      }

      setTransferProgress({
        step: 'error',
        currentTransaction: 0,
        totalTransactions: ESTIMATED_TRANSFER_TRANSACTIONS,
        error: errorMessage,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  // Request tokens from faucet
  const handleRequestTokens = async () => {
    if (!publicKey) return;

    setIsRequestingTokens(true);
    setFaucetError(null);
    setFaucetSuccess(false);

    try {
      const response = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: publicKey })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Faucet request failed');
      }

      setFaucetSuccess(true);
      // Refresh token accounts after a short delay
      setTimeout(() => {
        fetchTokenAccounts();
      }, 2000);
    } catch (err) {
      console.error('Faucet request failed:', err);
      setFaucetError(err instanceof Error ? err.message : 'Failed to request tokens');
    } finally {
      setIsRequestingTokens(false);
    }
  };

  const handleConfigureCt = async (token: TokenAccount) => {
    if (!publicKey) return;

    // Guard against multiple concurrent calls (React StrictMode / event bubbling)
    if (configuringRef.current) return;
    configuringRef.current = true;

    setConfiguringAccount(token.address);
    setConfigureError(null);

    try {
      // Check that the mint supports confidential transfers
      const mintResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [token.mint, { encoding: 'jsonParsed' }]
        })
      });
      const mintData = await mintResponse.json();
      const mintExtensions = mintData.result?.value?.data?.parsed?.info?.extensions || [];
      const hasCtMint = mintExtensions.some((ext: { extension: string }) =>
        ext.extension === 'confidentialTransferMint'
      );

      if (!hasCtMint) {
        throw new Error('Mint does not have ConfidentialTransferMint extension. Confidential transfers cannot be configured.');
      }

      // Derive keys for (owner, mint) via wallet signMessage
      const keys = await getCtKeys(token.mint);
      const walletSigner = getWalletSigner();

      // Build and execute the configure-account plan: reallocates the account
      // for the extension, verifies the pubkey-validity proof, and configures it.
      const plan = await createConfigureAccountPlan({
        rpc,
        payer: walletSigner,
        owner: walletSigner,
        mintAddress: token.mint,
        tokenAccountAddress: token.address,
        keys,
      });

      await executeInstructionPlan({
        plan,
        rpc,
        feePayer: walletSigner,
      });

      // Refresh token accounts (don't let refresh failure mask a successful configure)
      try {
        await fetchTokenAccounts();
      } catch (refreshErr) {
        console.warn('Post-configure token refresh failed (configure itself succeeded):', refreshErr);
      }

      setConfigureError(null);
    } catch (err) {
      console.error('Failed to configure confidential transfers:', err);
      let errorMessage: string;
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else if (err && typeof err === 'object' && 'message' in err) {
        errorMessage = String((err as { message: unknown }).message);
      } else {
        errorMessage = `Configure failed: ${String(err)}`;
      }
      setConfigureError(errorMessage);
    } finally {
      setConfiguringAccount(null);
      configuringRef.current = false;
    }
  };

  // Fetch token accounts when connected
  useEffect(() => {
    if (isOpen && isConnected && publicKey) {
      fetchTokenAccounts();
    }
  }, [isOpen, isConnected, publicKey]);

  const fetchTokenAccounts = async () => {
    if (!publicKey) return;

    setIsLoadingTokens(true);
    setError(null);

    try {
      // Retry up to 3 times for transient RPC errors
      let data;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              String(publicKey),
              { programId: TOKEN_2022_PROGRAM_ID },
              { encoding: 'jsonParsed' }
            ]
          })
        });

        data = await response.json();

        if (!data.error) break;
        if (attempt < 2) {
          console.warn(`RPC error on attempt ${attempt + 1}, retrying...`, data.error.message);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }

      if (data.error) {
        throw new Error(data.error.message);
      }

      const accounts: TokenAccount[] = [];

      for (const item of data.result?.value || []) {
        const info = item.account.data.parsed.info;
        const extensions = info.extensions || [];

        const ctExtension = extensions.find((ext: { extension: string; state?: CtAccountState }) =>
          ext.extension === 'confidentialTransferAccount'
        ) as { extension: string; state?: CtAccountState } | undefined;

        accounts.push({
          address: item.pubkey,
          mint: info.mint,
          balance: info.tokenAmount.uiAmountString || '0',
          decimals: info.tokenAmount.decimals,
          isCtConfigured: !!ctExtension,
          ctState: ctExtension?.state,
        });
      }

      setTokens(accounts);
    } catch (err) {
      console.error('Failed to fetch tokens:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch tokens');
    } finally {
      setIsLoadingTokens(false);
    }
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleConnect = async () => {
    try {
      await connect();
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const ctConfiguredTokens = tokens.filter(t => t.isCtConfigured);
  const unconfiguredTokens = tokens.filter(t => !t.isCtConfigured);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50">
            <h2 className="text-sm font-medium text-zinc-100">
              Confidential Transfer
            </h2>
            <button
              onClick={onClose}
              className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-5 max-h-[70vh] overflow-y-auto">
            {!isConnected ? (
              <div className="text-center py-4">
                <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-zinc-800 flex items-center justify-center">
                  <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <p className="text-xs text-zinc-500 mb-4">Connect wallet to view your tokens</p>
                <button
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 rounded transition-colors"
                >
                  {isConnecting ? 'Connecting...' : 'Connect Wallet'}
                </button>
              </div>
            ) : isLoadingTokens ? (
              <div className="text-center py-8">
                <div className="w-6 h-6 mx-auto mb-3 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
                <p className="text-xs text-zinc-500">Looking for your confidential tokens...</p>
              </div>
            ) : error ? (
              <div className="text-center py-4">
                <p className="text-xs text-red-400 mb-3">{error}</p>
                <button
                  onClick={fetchTokenAccounts}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline"
                >
                  Retry
                </button>
              </div>
            ) : tokens.length === 0 ? (
              <div className="text-center py-6">
                <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-zinc-800 flex items-center justify-center">
                  <svg className="w-6 h-6 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
                <p className="text-sm text-zinc-300 mb-2">No confidential-enabled tokens found</p>
                <p className="text-[10px] text-zinc-500 mb-4">
                  Get test tokens to try confidential transfers
                </p>

                {faucetSuccess ? (
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded mb-3">
                    <div className="flex items-center justify-center gap-2 text-emerald-400">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-xs">Tokens sent! Refreshing...</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={handleRequestTokens}
                    disabled={isRequestingTokens}
                    className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 rounded transition-colors flex items-center gap-2 mx-auto"
                  >
                    {isRequestingTokens ? (
                      <>
                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Requesting...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        Get Test Tokens
                      </>
                    )}
                  </button>
                )}

                {faucetError && (
                  <p className="text-[10px] text-red-400 mt-3">{faucetError}</p>
                )}
              </div>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-[10px] text-zinc-500">
                    {tokens.length} token account{tokens.length !== 1 ? 's' : ''} found
                  </span>
                  <button
                    onClick={fetchTokenAccounts}
                    disabled={isLoadingTokens}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
                  >
                    <svg className={`w-3 h-3 ${isLoadingTokens ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh
                  </button>
                </div>
                <div className="space-y-5">
                {/* CT Configured Tokens */}
                {ctConfiguredTokens.length > 0 && (
                  <div>
                    <h3 className="text-[10px] text-emerald-500 uppercase tracking-wider mb-2 font-medium">
                      Confidential Ready
                    </h3>
                    <div className="space-y-2">
                      {ctConfiguredTokens.map((token) => (
                        <div
                          key={token.address}
                          className={`px-3 py-3 rounded border transition-colors cursor-pointer ${
                            selectedToken?.address === token.address
                              ? 'bg-emerald-600/20 border-emerald-500/50'
                              : 'bg-emerald-600/10 border-emerald-600/30 hover:border-emerald-500/40'
                          }`}
                          onClick={() => handleSelectToken(token)}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-zinc-200 font-mono">{shortenAddress(token.mint, 4)}</span>
                            <span className="text-[10px] text-zinc-500">Public: <span className="text-emerald-400">{token.balance}</span></span>
                          </div>

                          {selectedToken?.address === token.address && (
                            <div className="mt-3 pt-3 border-t border-emerald-500/20">
                              {/* Balance display */}
                              <div className="grid grid-cols-3 gap-2 mb-3 text-[10px]">
                                <div className="p-2 bg-zinc-800/50 rounded">
                                  <div className="text-zinc-500 mb-1">Public</div>
                                  <div className="text-zinc-200 font-mono">{token.balance}</div>
                                </div>
                                <div className="p-2 bg-zinc-800/50 rounded">
                                  <div className="text-zinc-500 mb-1">Pending</div>
                                  <div className="text-yellow-400 font-mono">
                                    {decryptedPendingBalance !== null
                                      ? (Number(decryptedPendingBalance) / Math.pow(10, token.decimals)).toFixed(token.decimals)
                                      : (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleDecryptPending(); }}
                                          disabled={isDecryptingPending}
                                          className="text-yellow-500 hover:text-yellow-300 disabled:text-yellow-700 transition-colors text-[9px] uppercase tracking-wider"
                                        >
                                          {isDecryptingPending ? 'Decrypting...' : 'Click to decrypt'}
                                        </button>
                                      )
                                    }
                                  </div>
                                </div>
                                <div className="p-2 bg-zinc-800/50 rounded">
                                  <div className="text-zinc-500 mb-1">Confidential</div>
                                  <div className="text-emerald-400 font-mono">
                                    {decryptedConfidentialBalance !== null
                                      ? (Number(decryptedConfidentialBalance) / Math.pow(10, token.decimals)).toFixed(token.decimals)
                                      : (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleDecryptConfidential(); }}
                                          disabled={isDecryptingConfidential}
                                          className="text-emerald-500 hover:text-emerald-300 disabled:text-emerald-700 transition-colors text-[9px] uppercase tracking-wider"
                                        >
                                          {isDecryptingConfidential ? 'Decrypting...' : 'Click to decrypt'}
                                        </button>
                                      )
                                    }
                                  </div>
                                </div>
                              </div>

                              {/* Operation buttons */}
                              <div className="flex gap-2 mb-3">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setOperation('deposit'); setOperationError(null); }}
                                  className={`flex-1 px-2 py-1.5 text-[10px] rounded transition-colors ${
                                    operation === 'deposit'
                                      ? 'bg-blue-600 text-white'
                                      : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                                  }`}
                                >
                                  Deposit
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setOperation('apply'); setOperationError(null); }}
                                  className={`flex-1 px-2 py-1.5 text-[10px] rounded transition-colors ${
                                    operation === 'apply'
                                      ? 'bg-purple-600 text-white'
                                      : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                                  }`}
                                >
                                  Apply Pending
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setOperation('transfer'); setOperationError(null); }}
                                  className={`flex-1 px-2 py-1.5 text-[10px] rounded transition-colors ${
                                    operation === 'transfer'
                                      ? 'bg-emerald-600 text-white'
                                      : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                                  }`}
                                >
                                  Transfer
                                </button>
                              </div>

                              {/* Operation forms */}
                              {operation === 'deposit' && (
                                <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded">
                                  <div className="text-[10px] text-blue-400 mb-2">Deposit from public to pending balance</div>
                                  <input
                                    type="number"
                                    placeholder="Amount"
                                    value={depositAmount}
                                    onChange={(e) => setDepositAmount(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 mb-2"
                                  />
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleDeposit(); }}
                                    disabled={isProcessing || !depositAmount}
                                    className="w-full px-2 py-1.5 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 text-white rounded transition-colors"
                                  >
                                    {isProcessing ? 'Processing...' : 'Deposit'}
                                  </button>
                                </div>
                              )}

                              {operation === 'apply' && (
                                <div className="p-2 bg-purple-500/10 border border-purple-500/20 rounded">
                                  <div className="text-[10px] text-purple-400 mb-2">Move pending balance to confidential balance</div>
                                  {decryptedPendingBalance !== null && decryptedPendingBalance > 0n && (
                                    <div className="text-[10px] text-zinc-400 mb-2">
                                      Pending: {(Number(decryptedPendingBalance) / Math.pow(10, token.decimals)).toFixed(token.decimals)}
                                    </div>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleApplyPendingBalance(); }}
                                    disabled={isProcessing}
                                    className="w-full px-2 py-1.5 text-[10px] bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 text-white rounded transition-colors"
                                  >
                                    {isProcessing ? 'Processing...' : 'Apply Pending Balance'}
                                  </button>
                                </div>
                              )}

                              {operation === 'transfer' && (
                                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded">
                                  {transferProgress ? (
                                    /* Progress view during transfer */
                                    <div className="space-y-3">
                                      <div className="text-[10px] text-emerald-400 font-medium">
                                        {transferProgress.step === 'generating_proofs' && 'Generating ZK proofs...'}
                                        {transferProgress.step === 'executing_transfer' && 'Sending transfer transactions...'}
                                        {transferProgress.step === 'complete' && 'Transfer complete!'}
                                        {transferProgress.step === 'error' && 'Transfer failed'}
                                      </div>

                                      {/* Progress bar */}
                                      <div className="w-full bg-zinc-700 rounded-full h-1.5">
                                        <div
                                          className={`h-1.5 rounded-full transition-all duration-300 ${
                                            transferProgress.step === 'error' ? 'bg-red-500' :
                                            transferProgress.step === 'complete' ? 'bg-emerald-500' : 'bg-emerald-400'
                                          }`}
                                          style={{ width: `${Math.min(100, (transferProgress.currentTransaction / transferProgress.totalTransactions) * 100)}%` }}
                                        />
                                      </div>

                                      <div className="text-[10px] text-zinc-500">
                                        {transferProgress.currentTransaction} of ~{transferProgress.totalTransactions} transactions confirmed
                                      </div>

                                      {transferProgress.step !== 'complete' && transferProgress.step !== 'error' && funFact && (
                                        <div className="text-[10px] text-zinc-600 italic mt-1 transition-all duration-500">
                                          {funFact}
                                        </div>
                                      )}

                                      {transferProgress.step === 'complete' && transferProgress.signature && (
                                        <div className="text-[10px] text-zinc-400">
                                          <div className="mb-1">Signature:</div>
                                          <span className="font-mono text-zinc-500 break-all text-[9px] block">
                                            {transferProgress.signature}
                                          </span>
                                        </div>
                                      )}

                                      {transferProgress.step === 'error' && (
                                        <div className="text-[10px] text-red-400">
                                          {transferProgress.error}
                                        </div>
                                      )}

                                      {transferProgress.step === 'complete' && transferProgress.signature && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); window.location.href = `/tx/${transferProgress.signature}`; }}
                                          className="w-full px-2 py-1.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors"
                                        >
                                          Show Transaction
                                        </button>
                                      )}
                                      {transferProgress.step === 'error' && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setTransferProgress(null); }}
                                          className="w-full px-2 py-1.5 text-[10px] bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                                        >
                                          Try Again
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    /* Input form */
                                    <>
                                      <div className="text-[10px] text-emerald-400 mb-2">Send confidential transfer</div>

                                      {/* Recipient input */}
                                      <div className="mb-2">
                                        <input
                                          type="text"
                                          placeholder="Recipient wallet or token account address"
                                          value={recipientAddress}
                                          onChange={(e) => {
                                            setRecipientAddress(e.target.value);
                                            setRecipientInfo(null);
                                            setRecipientError(null);
                                          }}
                                          onClick={(e) => e.stopPropagation()}
                                          className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 font-mono"
                                        />
                                      </div>

                                      {/* Lookup button */}
                                      {recipientAddress && !recipientInfo && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); lookupRecipient(recipientAddress); }}
                                          disabled={isLookingUpRecipient}
                                          className="w-full px-2 py-1.5 text-[10px] bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 text-white rounded transition-colors mb-2"
                                        >
                                          {isLookingUpRecipient ? 'Looking up...' : 'Look up recipient'}
                                        </button>
                                      )}

                                      {/* Recipient info */}
                                      {recipientInfo && (
                                        <div className="mb-2 p-2 bg-zinc-800/50 rounded text-[10px]">
                                          <div className="flex justify-between mb-1">
                                            <span className="text-zinc-500">Wallet:</span>
                                            <span className="text-zinc-300 font-mono">{shortenAddress(recipientInfo.walletAddress, 4)}</span>
                                          </div>
                                          <div className="flex justify-between mb-1">
                                            <span className="text-zinc-500">Token Account:</span>
                                            <span className="text-zinc-300 font-mono">{shortenAddress(recipientInfo.tokenAccountAddress, 4)}</span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span className="text-zinc-500">Confidential Status:</span>
                                            <span className={recipientInfo.isCtConfigured ? 'text-emerald-400' : 'text-red-400'}>
                                              {recipientInfo.isCtConfigured ? '✓ Configured' : '✗ Not configured'}
                                            </span>
                                          </div>
                                        </div>
                                      )}

                                      {recipientError && (
                                        <div className="mb-2 text-[10px] text-red-400">{recipientError}</div>
                                      )}

                                      {/* Amount input */}
                                      {recipientInfo?.isCtConfigured && (
                                        <>
                                          <input
                                            type="number"
                                            placeholder="Amount"
                                            value={transferAmount}
                                            onChange={(e) => setTransferAmount(e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 mb-2"
                                          />

                                          <div className="text-[10px] text-zinc-500 mb-2">
                                            Confidential: {decryptedConfidentialBalance !== null
                                              ? (Number(decryptedConfidentialBalance) / Math.pow(10, token.decimals)).toFixed(token.decimals)
                                              : (
                                                <button
                                                  onClick={(e) => { e.stopPropagation(); handleDecryptConfidential(); }}
                                                  disabled={isDecryptingConfidential}
                                                  className="text-emerald-500 hover:text-emerald-300 disabled:text-emerald-700 transition-colors underline"
                                                >
                                                  {isDecryptingConfidential ? 'decrypting...' : 'click to decrypt'}
                                                </button>
                                              )
                                            }
                                          </div>

                                          <button
                                            onClick={(e) => { e.stopPropagation(); handleTransfer(); }}
                                            disabled={isProcessing || !transferAmount || !recipientInfo?.elgamalPubkey}
                                            className="w-full px-2 py-1.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white rounded transition-colors"
                                          >
                                            {isProcessing ? 'Processing...' : decryptedConfidentialBalance === null ? 'Decrypt & Send' : 'Send Confidential Transfer'}
                                          </button>

                                          <div className="mt-2 p-2 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-emerald-400/80">
                                            <strong>Note:</strong> Confidential transfers on devnet run as multiple
                                            transactions — ZK proofs are verified into context-state accounts before
                                            the transfer executes.
                                          </div>
                                        </>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}

                              {operationError && (
                                <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400">
                                  {operationError}
                                </div>
                              )}
                            </div>
                          )}

                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Unconfigured Tokens */}
                {unconfiguredTokens.length > 0 && (
                  <div>
                    <h3 className="text-[10px] text-yellow-500 uppercase tracking-wider mb-2 font-medium">
                      Needs Confidential Configuration
                    </h3>
                    {unconfiguredTokens.map((token) => (
                      <div
                        key={token.address}
                        className="mb-3 p-3 bg-zinc-800/50 border border-zinc-700/50 rounded"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-zinc-300 font-mono">{shortenAddress(token.mint, 4)}</span>
                          <span className="text-xs text-zinc-500 font-mono">{token.balance}</span>
                        </div>

                        <div className="mb-3">
                          <div className="text-[10px] text-zinc-500 mb-1">Token Account Address:</div>
                          <div className="flex items-center gap-2">
                            <code className="text-[10px] text-zinc-300 font-mono break-all flex-1">
                              {token.address}
                            </code>
                            <CopyButton text={token.address} />
                          </div>
                        </div>

                        <div className="pt-2 border-t border-zinc-700/50">
                          {configureError && configuringAccount === token.address && (
                            <div className="mb-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400">
                              {configureError}
                            </div>
                          )}

                          {/* Configure button */}
                          <button
                            onClick={() => handleConfigureCt(token)}
                            disabled={configuringAccount === token.address}
                            className="w-full px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-wait rounded transition-colors flex items-center justify-center gap-2"
                          >
                            {configuringAccount === token.address ? (
                              <>
                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                Configuring...
                              </>
                            ) : (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                                Configure Confidential
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
