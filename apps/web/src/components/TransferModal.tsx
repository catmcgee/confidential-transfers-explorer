'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { createSolanaRpc, singleInstructionPlan } from '@solana/kit';
import { useWallet } from './WalletProvider';
import { formatAmount, parseTokenAmount, shortenAddress } from '@/lib/format';
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
  type SupportedTransactionVersion,
} from '@/lib/confidentialTransfer';

// Progress tracking type (local since it's UI-specific)
interface TransferProgress {
  step: 'generating_proofs' | 'executing_transfer' | 'complete' | 'error';
  currentTransaction: number;
  totalTransactions: number;
  signature?: string;
  error?: string;
}

// With v1 transactions (4096 bytes) the proofs, the transfer and the proof
// account cleanup all fit in ONE transaction. Wallets that can only sign v0
// (1232 bytes) need the plan split across ~5 transactions. Only an estimate
// for the progress bar until the plan finishes.
const estimatedTransferTransactions = (version: SupportedTransactionVersion) =>
  version === 1 ? 1 : 5;

const SINGLE_TRANSFER_TX_LABEL =
  'Verified the equality, validity and range proofs, executed the transfer and closed the proof accounts';

// What each v0 transaction in the transfer plan is doing, in order. The exact
// count can vary, so anything past the list falls back to a generic label.
const V0_TRANSFER_TX_LABELS = [
  'Verified the equality proof (new balance matches the ciphertext)',
  'Verified the validity proof (amount encrypted to the right keys)',
  'Wrote the range proof context (amount is in bounds, not negative)',
  'Verified the range proof',
  'Executed the transfer and closed the proof accounts',
];

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

type StepId = 'deposit' | 'apply' | 'transfer';

function LockIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="encrypted">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

function BalanceCell({ label, hint, value, tone }: { label: string; hint: string; value: ReactNode; tone: string }) {
  return (
    <div className="p-2.5 bg-zinc-800/50 rounded">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`text-base font-mono mt-0.5 flex items-center gap-1 ${tone}`}>{value}</div>
      <div className="text-[10px] text-zinc-600 mt-0.5">{hint}</div>
    </div>
  );
}

function Step({
  number,
  title,
  instruction,
  isOpen,
  lockedReason,
  onOpen,
  children,
}: {
  number: number;
  title: string;
  instruction: string;
  isOpen: boolean;
  lockedReason: string | null;
  onOpen: () => void;
  children: ReactNode;
}) {
  const locked = lockedReason !== null;
  return (
    <div className={`rounded border transition-colors ${isOpen && !locked ? 'border-zinc-600 bg-zinc-800/40' : 'border-zinc-800'}`}>
      <button
        type="button"
        onClick={onOpen}
        disabled={locked}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed"
      >
        <span
          className={`w-5 h-5 shrink-0 rounded-full text-[11px] font-medium flex items-center justify-center ${
            locked ? 'bg-zinc-800 text-zinc-600' : isOpen ? 'bg-emerald-500 text-zinc-950' : 'bg-zinc-700 text-zinc-200'
          }`}
        >
          {number}
        </span>
        <span className={`flex-1 text-sm ${locked ? 'text-zinc-600' : 'text-zinc-100'}`}>{title}</span>
        <code className="text-[10px] text-zinc-500">{instruction}</code>
      </button>
      {locked && <div className="pl-11 pr-3 pb-2.5 -mt-1 text-xs text-zinc-600">{lockedReason}</div>}
      {isOpen && !locked && <div className="pl-11 pr-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
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

// In the browser, go through our same-origin /api/rpc proxy: it forwards to
// the private server-side RPC (SOLANA_RPC_URL), avoiding both the public
// endpoint's rate limits and CORS-less 429s that surface as "Failed to
// fetch" during transfer flows.
const RPC_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api/rpc`
    : process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
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
  const {
    isConnected,
    publicKey,
    connect,
    isConnecting,
    messageSigner,
    transactionSigner,
    transactionVersion,
  } = useWallet();
  const estimatedTransferTxs = estimatedTransferTransactions(transactionVersion);
  const [tokens, setTokens] = useState<TokenAccount[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuringAccount, setConfiguringAccount] = useState<string | null>(null);
  // Keyed by token address so the error stays visible after configuring ends
  const [configureError, setConfigureError] = useState<{ address: string; message: string } | null>(null);
  const configuringRef = useRef(false);

  // New state for operations
  const [selectedToken, setSelectedToken] = useState<TokenAccount | null>(null);
  const [operation, setOperation] = useState<StepId | null>(null);
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

  // Derived keys, cached per (wallet, mint) because derivation asks the
  // wallet for two signatures. A ref (not state) so async handlers always see
  // the latest cache, and the in-flight promise is cached so two quick
  // decrypt clicks share one round of signing.
  const keyCache = useRef(new Map<string, Promise<CtKeys>>());
  const keyCacheId = (mintAddress: string) => `${publicKey}:${mintAddress}`;

  // Derive the confidential-transfer keys for a mint via wallet signMessage.
  const getCtKeys = (mintAddress: string): Promise<CtKeys> => {
    if (!publicKey || !messageSigner) return Promise.reject(new Error('Wallet not connected'));
    const id = keyCacheId(mintAddress);
    const cached = keyCache.current.get(id);
    if (cached) return cached;

    const derivation = deriveCtKeys(messageSigner, publicKey, mintAddress).catch((err: unknown) => {
      keyCache.current.delete(id); // let the user retry after a rejected prompt
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('UserKeyring') || errMsg.includes('signMessage') || errMsg.includes('locked')) {
        throw new Error('Message signing failed. Make sure your wallet is connected and unlocked.');
      }
      throw err;
    });
    keyCache.current.set(id, derivation);
    return derivation;
  };

  // Wallet-backed kit signer used as fee payer / authority for plans.
  const getWalletSigner = () => {
    if (!transactionSigner) throw new Error('Wallet not connected');
    return transactionSigner;
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
        params: [tokenAccountAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]
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

      // Pending is two ElGamal ciphertexts: the low 16 bits and the high bits.
      // ElGamal decryption is a discrete-log search, so it only works on
      // small numbers — hence the split. total = lo + (hi << 16).
      const pendingLoBytes = Uint8Array.from(atob(freshCtState.pendingBalanceLo), c => c.charCodeAt(0));
      const pendingHiBytes = Uint8Array.from(atob(freshCtState.pendingBalanceHi), c => c.charCodeAt(0));

      const pendingLo = await decryptElGamalBalance(keys.elgamalSecretKey, pendingLoBytes);
      const pendingHi = await decryptElGamalBalance(keys.elgamalSecretKey, pendingHiBytes);

      if (pendingLo === null || pendingHi === null) {
        throw new Error('Could not decrypt the pending balance with this wallet\'s keys');
      }
      setDecryptedPendingBalance(pendingLo + (pendingHi << 16n));
    } catch (err) {
      console.error('Failed to decrypt pending balance:', err);
    } finally {
      setIsDecryptingPending(false);
    }
  };

  // Decrypt confidential balance - derives keys if needed, fetches fresh state, decrypts via ZK SDK
  const handleDecryptConfidential = async (): Promise<bigint | null> => {
    if (!selectedToken) return null;

    setIsDecryptingConfidential(true);
    try {
      const freshCtState = await fetchCtState(selectedToken.address);
      if (!freshCtState) return null;

      const keys = await getCtKeys(selectedToken.mint);

      // Decode base64 to bytes and decrypt using the AES key
      const ciphertextBytes = Uint8Array.from(atob(freshCtState.decryptableAvailableBalance), c => c.charCodeAt(0));
      const balance = await decryptAeBalance(keys.aesKey, ciphertextBytes);

      setDecryptedConfidentialBalance(balance);
      return balance;
    } catch (err) {
      console.error('Failed to decrypt confidential balance:', err);
      return null;
    } finally {
      setIsDecryptingConfidential(false);
    }
  };

  // Reveal both encrypted balances; the shared key cache means one round of
  // wallet signing covers both.
  const handleReveal = async () => {
    await handleDecryptPending();
    await handleDecryptConfidential();
  };

  // Re-decrypt balances after an operation using already-cached keys.
  // Skips silently when keys aren't cached yet so it never triggers a
  // surprise wallet signature prompt.
  const refreshDecryptedBalances = async (mint: string) => {
    if (!keyCache.current.has(keyCacheId(mint))) return;
    try {
      await handleDecryptPending();
      await handleDecryptConfidential();
    } catch (err) {
      console.warn('Balance re-decryption failed:', err);
    }
  };

  // Handle deposit (public → pending)
  const handleDeposit = async () => {
    if (!selectedToken || !publicKey || !depositAmount) return;

    setIsProcessing(true);
    setOperationError(null);

    try {
      const amount = parseTokenAmount(depositAmount, selectedToken.decimals);
      if (amount === null || amount <= 0n) {
        throw new Error(`Enter a positive amount with at most ${selectedToken.decimals} decimal places`);
      }

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
        transactionVersion,
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
      await refreshDecryptedBalances(selectedToken.mint);
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
        transactionVersion,
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
      if (selectedToken) await refreshDecryptedBalances(selectedToken.mint);
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
          params: [inputAddress, { encoding: 'jsonParsed', commitment: 'confirmed' }]
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
              { encoding: 'jsonParsed', commitment: 'confirmed' }
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

  // Keep the selected token in sync with the latest fetch, and select the
  // first configured token automatically so its steps are visible right away.
  useEffect(() => {
    const current = selectedToken && tokens.find((t) => t.address === selectedToken.address);
    if (current) {
      setSelectedToken(current);
    } else {
      const firstConfigured = tokens.find((t) => t.isCtConfigured);
      if (firstConfigured) setSelectedToken(firstConfigured);
    }
  }, [tokens]);

  // Look the recipient up as soon as a full address has been typed or pasted.
  useEffect(() => {
    const candidate = recipientAddress.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate)) return;
    const timer = setTimeout(() => lookupRecipient(candidate), 400);
    return () => clearTimeout(timer);
  }, [recipientAddress, selectedToken?.mint]);

  // Handle confidential transfer via the instruction plan (one v1 transaction)
  const handleTransfer = async () => {
    if (!selectedToken || !publicKey || !transferAmount || !recipientInfo?.isCtConfigured || !recipientInfo.elgamalPubkey) {
      setOperationError('Missing required information for transfer');
      return;
    }

    // Decrypt the spendable balance on the fly if it hasn't been revealed yet.
    const available = decryptedConfidentialBalance ?? (await handleDecryptConfidential());
    if (available === null) {
      setOperationError('Could not decrypt your spendable balance. Try "Reveal my balances" first.');
      return;
    }
    const amount = parseTokenAmount(transferAmount, selectedToken.decimals);

    if (amount === null || amount <= 0n) {
      setOperationError(`Enter a positive amount with at most ${selectedToken.decimals} decimal places`);
      return;
    }

    if (amount > available) {
      setOperationError(`Insufficient available balance. You have ${formatAmount(available.toString(), selectedToken.decimals)} available.`);
      return;
    }

    setIsProcessing(true);
    setOperationError(null);
    setTransferProgress({
      step: 'generating_proofs',
      currentTransaction: 0,
      totalTransactions: estimatedTransferTxs,
    });

    try {
      const keys = await getCtKeys(selectedToken.mint);
      const walletSigner = getWalletSigner();

      // Build the transfer plan: generates the equality, validity, and range
      // proofs, verifies them into context-state accounts, executes the
      // transfer and closes the proof accounts.
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
        totalTransactions: estimatedTransferTxs,
      });

      const { signatures } = await executeInstructionPlan({
        plan,
        rpc,
        feePayer: walletSigner,
        transactionVersion,
        onProgress: ({ signature, index }) => {
          setTransferProgress({
            step: 'executing_transfer',
            currentTransaction: index + 1,
            // Keep the bar from hitting 100% before the plan is done
            totalTransactions: Math.max(estimatedTransferTxs, index + 2),
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
      if (selectedToken) await refreshDecryptedBalances(selectedToken.mint);

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
        totalTransactions: estimatedTransferTxs,
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
      // The faucet waits for on-chain confirmation, so refresh right away
      await fetchTokenAccounts();
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
          params: [token.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]
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
        transactionVersion,
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
      setConfigureError({ address: token.address, message: errorMessage });
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
              { encoding: 'jsonParsed', commitment: 'confirmed' }
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
              Your confidential balance
            </h2>
            <div className="flex items-center gap-1">
            {isConnected && (
              <button
                onClick={fetchTokenAccounts}
                disabled={isLoadingTokens}
                className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
                aria-label="Refresh balances"
                title="Refresh"
              >
                <svg className={`w-4 h-4 ${isLoadingTokens ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            </div>
          </div>

          <div className="p-5 max-h-[70vh] overflow-y-auto">
            {!isConnected ? (
              // Rare: the local wallet is normally ready before the modal opens
              <div className="text-center py-4">
                <div className="w-6 h-6 mx-auto mb-3 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
                <p className="text-xs text-zinc-500 mb-4">Setting up your wallet...</p>
                <button
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 rounded transition-colors"
                >
                  {isConnecting ? 'Connecting...' : 'Connect a wallet instead'}
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
                <p className="text-sm text-zinc-300 mb-2">You don&apos;t have any test tokens yet</p>
                <p className="text-xs text-zinc-500 mb-4 max-w-xs mx-auto">
                  The faucet mints 50 test tokens straight to your wallet (and
                  covers a little devnet SOL for fees).
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
              <div className="space-y-4">
                {ctConfiguredTokens.map((token) => {
                  if (selectedToken?.address !== token.address) {
                    return (
                      <button
                        key={token.address}
                        onClick={() => handleSelectToken(token)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded border border-zinc-800 hover:border-zinc-700 text-xs transition-colors"
                      >
                        <span className="font-mono text-zinc-300">{shortenAddress(token.mint, 4)}</span>
                        <span className="text-zinc-500">{token.balance} public</span>
                      </button>
                    );
                  }

                  // What's possible right now, from on-chain state (no decryption
                  // needed): the pending credit counter is non-zero whenever
                  // something is waiting in Pending.
                  const publicRaw = parseTokenAmount(token.balance, token.decimals) ?? 0n;
                  const hasPending =
                    (token.ctState?.pendingBalanceCreditCounter ?? 0) > 0 ||
                    (decryptedPendingBalance ?? 0n) > 0n;
                  const spendable = decryptedConfidentialBalance;
                  const nextStep: StepId = hasPending
                    ? 'apply'
                    : spendable !== null && spendable > 0n
                      ? 'transfer'
                      : publicRaw > 0n
                        ? 'deposit'
                        : 'transfer';
                  const openStep = transferProgress ? 'transfer' : operation ?? nextStep;
                  const openStepAt = (step: StepId) => () => {
                    setOperation(step);
                    setOperationError(null);
                  };
                  const revealed = decryptedPendingBalance !== null && decryptedConfidentialBalance !== null;

                  return (
                    <div key={token.address} className="space-y-4">
                      {/* Balances */}
                      <div>
                        <div className="grid grid-cols-3 gap-2">
                          <BalanceCell label="Public" hint="anyone can see" tone="text-zinc-100" value={token.balance} />
                          <BalanceCell
                            label="Pending"
                            hint={hasPending && decryptedPendingBalance === null ? 'incoming, encrypted' : 'incoming'}
                            tone="text-yellow-400"
                            value={decryptedPendingBalance !== null ? formatAmount(decryptedPendingBalance.toString(), token.decimals) : <LockIcon />}
                          />
                          <BalanceCell
                            label="Spendable"
                            hint="encrypted"
                            tone="text-emerald-400"
                            value={spendable !== null ? formatAmount(spendable.toString(), token.decimals) : <LockIcon />}
                          />
                        </div>
                        {!revealed && (
                          <button
                            onClick={handleReveal}
                            disabled={isDecryptingPending || isDecryptingConfidential}
                            className="mt-2 w-full px-3 py-2 text-xs text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:text-zinc-500 rounded transition-colors"
                          >
                            {isDecryptingPending || isDecryptingConfidential ? 'Decrypting…' : 'Reveal my balances'}
                          </button>
                        )}
                        <p className="mt-2 text-[11px] text-zinc-500">
                          Pending and Spendable are encrypted on-chain. Only your keys can reveal them.
                        </p>
                      </div>

                      {/* Steps */}
                      <div className="space-y-2">
                        <Step
                          number={1}
                          title="Encrypt tokens"
                          instruction="Deposit"
                          isOpen={openStep === 'deposit'}
                          lockedReason={publicRaw === 0n ? 'No public tokens to encrypt.' : null}
                          onOpen={openStepAt('deposit')}
                        >
                          <p className="text-xs text-zinc-500">
                            Moves public tokens into your encrypted Pending balance. The amount is
                            visible on-chain in this step only.
                          </p>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder={`Amount (up to ${token.balance})`}
                              value={depositAmount}
                              onChange={(e) => setDepositAmount(e.target.value)}
                              className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                            />
                            <button
                              onClick={() => setDepositAmount(token.balance)}
                              className="px-2 text-xs text-zinc-400 hover:text-zinc-200"
                            >
                              Max
                            </button>
                          </div>
                          <button
                            onClick={handleDeposit}
                            disabled={isProcessing || !depositAmount}
                            className="w-full px-3 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white rounded transition-colors"
                          >
                            {isProcessing ? 'Encrypting…' : 'Encrypt'}
                          </button>
                        </Step>

                        <Step
                          number={2}
                          title="Make them spendable"
                          instruction="ApplyPendingBalance"
                          isOpen={openStep === 'apply'}
                          lockedReason={hasPending ? null : 'Nothing waiting in Pending.'}
                          onOpen={openStepAt('apply')}
                        >
                          <p className="text-xs text-zinc-500">
                            Deposits and incoming transfers wait in Pending. This decrypts them on
                            your device and adds them to Spendable.
                          </p>
                          <button
                            onClick={handleApplyPendingBalance}
                            disabled={isProcessing}
                            className="w-full px-3 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white rounded transition-colors"
                          >
                            {isProcessing
                              ? 'Applying…'
                              : decryptedPendingBalance !== null
                                ? `Make ${formatAmount(decryptedPendingBalance.toString(), token.decimals)} spendable`
                                : 'Make spendable'}
                          </button>
                        </Step>

                        <Step
                          number={3}
                          title="Send privately"
                          instruction="Transfer"
                          isOpen={openStep === 'transfer'}
                          lockedReason={!transferProgress && spendable === 0n ? 'Nothing spendable yet.' : null}
                          onOpen={openStepAt('transfer')}
                        >
                          {transferProgress ? (
                                    <div className="space-y-3">
                                      <div className="text-[10px] text-emerald-400 font-medium">
                                        {transferProgress.step === 'generating_proofs' && 'Generating ZK proofs...'}
                                        {transferProgress.step === 'executing_transfer' &&
                                          (transferProgress.totalTransactions === 1 ? 'Sending transfer transaction...' : 'Sending transfer transactions...')}
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
                                        {transferProgress.totalTransactions === 1
                                          ? transferProgress.currentTransaction === 1 ? 'Transaction confirmed' : 'Waiting for 1 transaction to confirm'
                                          : `${transferProgress.currentTransaction} of ~${transferProgress.totalTransactions} transactions confirmed`}
                                      </div>

                                      {transferProgress.step === 'executing_transfer' && transferProgress.currentTransaction > 0 && (
                                        <div className="text-[10px] text-zinc-400">
                                          {transactionVersion === 1
                                            ? SINGLE_TRANSFER_TX_LABEL
                                            : V0_TRANSFER_TX_LABELS[transferProgress.currentTransaction - 1] ?? 'Finalizing...'}
                                        </div>
                                      )}

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
                                      {transferProgress.step === 'complete' && (
                                        <button
                                          onClick={() => {
                                            setTransferProgress(null);
                                            setTransferAmount('');
                                            setOperation(null);
                                          }}
                                          className="w-full px-2 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                                        >
                                          Done
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
                            <>
                              <p className="text-xs text-zinc-500">
                                The amount is encrypted for you and the recipient and proven valid
                                with three zero-knowledge proofs. It never appears on-chain.
                              </p>
                              <input
                                type="text"
                                placeholder="Recipient wallet address"
                                value={recipientAddress}
                                onChange={(e) => {
                                  setRecipientAddress(e.target.value);
                                  setRecipientInfo(null);
                                  setRecipientError(null);
                                }}
                                className="w-full px-2 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono"
                              />
                              {isLookingUpRecipient && <div className="text-xs text-zinc-500">Checking recipient…</div>}
                              {recipientInfo?.isCtConfigured && (
                                <div className="text-xs text-emerald-400">
                                  ✓ {shortenAddress(recipientInfo.walletAddress, 4)} can receive confidential tokens
                                </div>
                              )}
                              {recipientError && <div className="text-xs text-red-400">{recipientError}</div>}
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder={spendable !== null ? `Amount (up to ${formatAmount(spendable.toString(), token.decimals)})` : 'Amount'}
                                value={transferAmount}
                                onChange={(e) => setTransferAmount(e.target.value)}
                                className="w-full px-2 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-200"
                              />
                              <button
                                onClick={() => {
                                  setOperation('transfer');
                                  handleTransfer();
                                }}
                                disabled={isProcessing || !transferAmount || !recipientInfo?.isCtConfigured}
                                className="w-full px-3 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white rounded transition-colors"
                              >
                                {isProcessing ? 'Sending…' : 'Send privately'}
                              </button>
                              <p className="text-[11px] text-zinc-600">
                                {transactionVersion === 1
                                  ? 'Proofs, transfer and cleanup all go in one transaction.'
                                  : "Your wallet can't sign version 1 transactions, so this takes ~5 transactions."}
                              </p>
                            </>
                          )}
                        </Step>
                      </div>

                      {operationError && (
                        <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                          {operationError}
                        </div>
                      )}

                      {publicKey && (
                        <div className="flex items-center justify-between gap-2 pt-3 border-t border-zinc-800 text-xs">
                          <span className="text-zinc-500">
                            Your address <span className="font-mono text-zinc-300">{shortenAddress(publicKey, 6)}</span>
                          </span>
                          <CopyButton text={publicKey} label="Copy to receive" />
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Accounts that haven't opted in yet */}
                {unconfiguredTokens.map((token) => (
                  <div key={token.address} className="p-4 rounded border border-zinc-800 space-y-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-zinc-100">Turn on confidential balances</span>
                      <code className="text-[10px] text-zinc-500">ConfigureAccount</code>
                    </div>
                    <p className="text-xs text-zinc-500">
                      You have {token.balance} public test tokens. Setting up asks your wallet to sign
                      two messages that create your encryption keys, then publishes your public key
                      so others can send to you.
                    </p>
                    {configureError?.address === token.address && (
                      <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                        {configureError.message}
                      </div>
                    )}
                    <button
                      onClick={() => handleConfigureCt(token)}
                      disabled={configuringAccount === token.address}
                      className="w-full px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-wait rounded transition-colors flex items-center justify-center gap-2"
                    >
                      {configuringAccount === token.address ? (
                        <>
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Setting up…
                        </>
                      ) : (
                        'Set up'
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
