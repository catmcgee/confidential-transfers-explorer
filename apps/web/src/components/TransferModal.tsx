'use client';

import { useState, useEffect, useRef } from 'react';
import { useWallet, waitForConfirmation } from './WalletProvider';
import { shortenAddress } from '@/lib/format';
import {
  deriveElGamalKeypair,
  generateElGamalKeypairFallback,
  buildConfigureCtInstructions,
  buildConfigureCtTransaction,
  buildDepositInstruction,
  buildDepositTransaction,
  buildApplyPendingBalanceInstruction,
  buildApplyPendingBalanceTransaction,
  serializeTransactionToBase64,
  parseElGamalPubkeyFromAccountInfo,
  decryptAeBalance,
  decryptElGamalBalance,
  generateTransferProofs,
  buildSplitProofTransferTransactions,
  generateContextStateKeypair,
  signWithKeypair,
  type TransferProofs,
} from '@/lib/confidentialTransfer';

// Progress tracking type (local since it's UI-specific)
interface SplitProofTransferProgress {
  step: 'generating_proofs' | 'creating_equality' | 'creating_validity' | 'creating_range' | 'verifying_range' | 'executing_transfer' | 'complete' | 'error';
  currentTransaction: number;
  totalTransactions: number;
  signature?: string;
  error?: string;
}
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomFact } from 'random-facts';

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

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://zk-edge.surfnet.dev:8899';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

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
  const [newBalanceAmount, setNewBalanceAmount] = useState(''); // For manual apply pending
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
  const [transferProgress, setTransferProgress] = useState<SplitProofTransferProgress | null>(null);

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
      setFunFact(randomFact());
      const interval = setInterval(() => {
        setFunFact(randomFact());
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [transferProgress?.step]);

  // Cached keys for ZK SDK - keys require wallet interaction so we cache them
  const [cachedKeys, setCachedKeys] = useState<Record<string, {
    keypair: Awaited<ReturnType<typeof deriveElGamalKeypair>>['keypair'];
    aeKey: Awaited<ReturnType<typeof deriveElGamalKeypair>>['aeKey'];
    publicKeyBytes: Uint8Array;
  }>>({});

  // Get cached keys for selected token
  const tokenKeys = selectedToken ? cachedKeys[selectedToken.address] : null;

  // Helper: derive ElGamal keys with fallback to random generation
  const getElGamalKeys = async (tokenAddress: string) => {
    try {
      return await deriveElGamalKeypair(signMessage, tokenAddress);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('UserKeyring') || errMsg.includes('signMessage') || errMsg.includes('locked')) {
        setError('Make sure your wallet is connected and unlocked');
      }
      console.warn('signMessage failed, using random keypair fallback:', err);
      return await generateElGamalKeypairFallback(tokenAddress);
    }
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

  // Decrypt pending balance - gets keys if needed, fetches fresh state from RPC, then decrypts via ZK SDK
  const handleDecryptPending = async () => {
    if (!selectedToken) {
      console.log('Cannot decrypt pending - no token selected');
      return;
    }

    setIsDecryptingPending(true);
    try {
      // Fetch fresh account state from RPC
      console.log('Fetching fresh account state for pending balance...');
      const accountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [selectedToken.address, { encoding: 'jsonParsed' }]
        })
      });
      const accountData = await accountResponse.json();
      const extensions = accountData.result?.value?.data?.parsed?.info?.extensions || [];
      const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
      const freshCtState = ctExt?.state as CtAccountState | undefined;

      if (!freshCtState) {
        console.log('No CT state found on account');
        return;
      }

      // Get keys if not cached
      let keys = tokenKeys;
      if (!keys) {
        console.log('Getting wallet keys for decryption...');
        const derivedKeys = await getElGamalKeys(selectedToken.address);
        keys = derivedKeys;
        // Cache the keys
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: keys!
        }));
      }

      // DEBUG: Compare derived ElGamal pubkey with on-chain
      const derivedPubkeyBytes = keys.publicKeyBytes;
      const onChainPubkeyBytes = Uint8Array.from(atob(freshCtState.elgamalPubkey), c => c.charCodeAt(0));
      const derivedHex = Array.from(derivedPubkeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      const onChainHex = Array.from(onChainPubkeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      console.log('Derived ElGamal pubkey:', derivedHex);
      console.log('On-chain ElGamal pubkey:', onChainHex);
      console.log('ElGamal pubkeys match:', derivedHex === onChainHex);

      // Decrypt pending balance: lo (48-bit) and hi (16-bit) ElGamal ciphertexts
      const pendingLoBytes = Uint8Array.from(atob(freshCtState.pendingBalanceLo), c => c.charCodeAt(0));
      const pendingHiBytes = Uint8Array.from(atob(freshCtState.pendingBalanceHi), c => c.charCodeAt(0));

      console.log('pendingLo bytes len:', pendingLoBytes.length, 'handle all zeros:', pendingLoBytes.slice(32).every(b => b === 0));
      console.log('pendingHi bytes len:', pendingHiBytes.length, 'handle all zeros:', pendingHiBytes.slice(32).every(b => b === 0));

      const secretKey = keys.keypair.secret();

      const pendingLo = await decryptElGamalBalance(secretKey, pendingLoBytes);
      const pendingHi = await decryptElGamalBalance(secretKey, pendingHiBytes);

      console.log('Raw decrypted pendingLo:', pendingLo?.toString());
      console.log('Raw decrypted pendingHi:', pendingHi?.toString());

      if (pendingLo !== null && pendingHi !== null) {
        const pendingBalance = pendingLo + (pendingHi << 48n);
        console.log('Decrypted pending balance:', pendingBalance.toString());
        // Sanity check: ElGamal BSGS decrypt can return garbage for values > 2^32
        // If the result looks unreasonable, set to null to trigger manual entry
        const MAX_RELIABLE = (1n << 32n);
        if (pendingLo > MAX_RELIABLE || pendingBalance > MAX_RELIABLE * 2n) {
          console.warn('Pending balance decrypt may be unreliable (value > 2^32 BSGS range)');
          setDecryptedPendingBalance(null);
        } else {
          setDecryptedPendingBalance(pendingBalance);
        }
      } else {
        console.log('Could not decrypt pending balance (key mismatch or zero ciphertext)');
        setDecryptedPendingBalance(0n);
      }
    } catch (err) {
      console.error('Failed to decrypt pending balance:', err);
    } finally {
      setIsDecryptingPending(false);
    }
  };

  // Decrypt confidential balance - gets keys if needed, fetches fresh state from RPC, then decrypts via ZK SDK
  const handleDecryptConfidential = async () => {
    if (!selectedToken) {
      console.log('Cannot decrypt confidential - no token selected');
      return;
    }

    setIsDecryptingConfidential(true);
    try {
      // Fetch fresh account state from RPC
      console.log('Fetching fresh account state for confidential balance...');
      const accountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [selectedToken.address, { encoding: 'jsonParsed' }]
        })
      });
      const accountData = await accountResponse.json();
      const extensions = accountData.result?.value?.data?.parsed?.info?.extensions || [];
      const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
      const freshCtState = ctExt?.state as CtAccountState | undefined;

      if (!freshCtState) {
        console.log('No CT state found on account');
        return;
      }

      // Get keys if not cached
      let keys = tokenKeys;
      if (!keys) {
        console.log('Getting wallet keys for decryption...');
        const derivedKeys = await getElGamalKeys(selectedToken.address);
        keys = derivedKeys;
        // Cache the keys
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: keys!
        }));
      }

      console.log('Decrypting confidential balance via ZK SDK...');
      console.log('Fresh decryptableAvailableBalance:', freshCtState.decryptableAvailableBalance);

      // Decode base64 to bytes
      const ciphertextBytes = Uint8Array.from(atob(freshCtState.decryptableAvailableBalance), c => c.charCodeAt(0));

      // Decrypt using the AE key
      const balance = await decryptAeBalance(keys.aeKey, ciphertextBytes);

      console.log('Decrypted confidential balance:', balance?.toString());
      setDecryptedConfidentialBalance(balance);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : 'No stack trace';
      console.error('Failed to decrypt confidential balance:', errorMessage);
      console.error('Error stack:', errorStack);
      console.error('Full error object:', err);
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

      // Get blockhash
      const blockhashResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'confirmed' }]
        })
      });
      const blockhashData = await blockhashResponse.json();
      const recentBlockhash = blockhashData.result.value.blockhash;
      const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);

      // Build deposit instruction
      const depositInstruction = buildDepositInstruction(
        selectedToken.address,
        selectedToken.mint,
        publicKey,
        amount,
        selectedToken.decimals
      );

      // Build deposit transaction
      const compiledTx = buildDepositTransaction(
        depositInstruction,
        recentBlockhash,
        lastValidBlockHeight,
        publicKey
      );

      const base64Tx = serializeTransactionToBase64(compiledTx);
      const transactionBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));

      const signature = await signAndSendTransaction(transactionBytes);
      console.log('Deposit transaction sent:', signature);

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
      // First, refresh account state to get latest pending balance info
      const accountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [selectedToken.address, { encoding: 'jsonParsed' }]
        })
      });
      const accountData = await accountResponse.json();
      const extensions = accountData.result?.value?.data?.parsed?.info?.extensions || [];
      const ctExt = extensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
      const ctState = ctExt?.state as CtAccountState | undefined;

      if (!ctState) {
        throw new Error('Could not fetch confidential account state');
      }

      // Get keys if not cached
      let keys = tokenKeys;
      if (!keys) {
        console.log('Getting wallet keys for apply pending...');
        const derivedKeys = await getElGamalKeys(selectedToken.address);
        keys = derivedKeys;
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: keys!
        }));
      }

      // Always AE-decrypt current available balance from fresh on-chain state (reliable, not BSGS)
      const currentAeBytes = Uint8Array.from(atob(ctState.decryptableAvailableBalance), c => c.charCodeAt(0));
      const currentAvailable = await decryptAeBalance(keys.aeKey, currentAeBytes) ?? 0n;

      // Determine pending amount from ElGamal decrypt or by decrypting inline
      let pendingAmount = 0n;
      if (decryptedPendingBalance !== null && decryptedPendingBalance > 0n) {
        pendingAmount = decryptedPendingBalance;
      } else if (ctState.pendingBalanceCreditCounter > 0) {
        // Try inline ElGamal decrypt of pending balance
        try {
          const pendingLoB64 = ctState.pendingBalanceLo;
          const pendingHiB64 = ctState.pendingBalanceHi;
          if (pendingLoB64 && pendingHiB64) {
            const pendingLoCt = Uint8Array.from(atob(pendingLoB64), c => c.charCodeAt(0));
            const pendingHiCt = Uint8Array.from(atob(pendingHiB64), c => c.charCodeAt(0));
            const secretKey = keys.keypair.secret();
            const lo = await decryptElGamalBalance(secretKey, pendingLoCt);
            const hi = await decryptElGamalBalance(secretKey, pendingHiCt);
            if (lo !== null) {
              pendingAmount = lo + ((hi ?? 0n) << 48n);
            }
          }
        } catch (decryptErr) {
          console.warn('Inline pending decrypt failed:', decryptErr);
        }
        // If still zero but credits exist, the pending might be too large - use 0 and hope for the best
        if (pendingAmount === 0n) {
          console.warn('Could not determine pending balance, applying with pendingAmount=0');
        }
      }

      // New available = current available + pending amount
      const newAvailableBalance = currentAvailable + pendingAmount;

      console.log('ApplyPendingBalance:', {
        currentAvailable: currentAvailable.toString(),
        pendingAmount: pendingAmount.toString(),
        newAvailableBalance: newAvailableBalance.toString(),
      });

      // Get blockhash
      const blockhashResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'confirmed' }]
        })
      });
      const blockhashData = await blockhashResponse.json();
      const recentBlockhash = blockhashData.result.value.blockhash;
      const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);

      // Build apply pending balance instruction using ZK SDK
      const applyInstruction = await buildApplyPendingBalanceInstruction(
        selectedToken.address,
        publicKey,
        keys.aeKey,
        newAvailableBalance,
        BigInt(ctState.actualPendingBalanceCreditCounter)
      );

      // Build transaction
      const compiledTx = buildApplyPendingBalanceTransaction(
        applyInstruction,
        recentBlockhash,
        lastValidBlockHeight,
        publicKey
      );

      const base64Tx = serializeTransactionToBase64(compiledTx);
      const transactionBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));

      const signature = await signAndSendTransaction(transactionBytes);
      console.log('Apply pending balance transaction sent:', signature);

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
              { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
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

  // Handle confidential transfer using split proofs with partial signing
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
      totalTransactions: 5,
    });

    try {
      // Get keys if not cached
      let keys = tokenKeys;
      if (!keys) {
        console.log('Getting wallet keys for transfer...');
        const derivedKeys = await getElGamalKeys(selectedToken.address);
        keys = derivedKeys;
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: keys!
        }));
      }

      console.log('Generating ZK proofs via ZK SDK...');
      console.log('Sender:', publicKey);
      console.log('Recipient:', recipientInfo.walletAddress);
      console.log('Mint:', selectedToken.mint);
      console.log('Amount:', amount.toString());
      console.log('Current balance:', available.toString());

      // Fetch the source account's available_balance ElGamal ciphertext from on-chain
      // This is needed for homomorphic derivation of the new balance ciphertext
      const sourceAccountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getAccountInfo',
          params: [selectedToken.address, { encoding: 'jsonParsed', commitment: 'confirmed' }]
        })
      });
      const sourceAccountData = await sourceAccountResponse.json();
      const sourceExtensions = sourceAccountData.result?.value?.data?.parsed?.info?.extensions || [];
      const sourceCTExt = sourceExtensions.find((e: { extension: string }) => e.extension === 'confidentialTransferAccount');
      if (!sourceCTExt?.state?.availableBalance) {
        throw new Error('Cannot read source account available balance ciphertext');
      }
      // availableBalance is base64-encoded 64-byte ElGamal ciphertext
      console.log('Raw availableBalance from RPC:', sourceCTExt.state.availableBalance);
      const sourceAvailableBalanceCt = Uint8Array.from(atob(sourceCTExt.state.availableBalance), c => c.charCodeAt(0));
      console.log('Source available balance ciphertext length:', sourceAvailableBalanceCt.length, '(expected 64)');

      // Generate proofs using ZK SDK
      const proofData = await generateTransferProofs(
        keys.keypair,
        keys.aeKey,
        recipientInfo.elgamalPubkey,
        amount,
        available,
        sourceAvailableBalanceCt,
        undefined // no auditor for now
      );

      console.log('Proofs generated successfully via ZK SDK');
      console.log('Equality proof size:', proofData.equalityProofData.length);
      console.log('Validity proof size:', proofData.validityProofData.length);
      console.log('Range proof size:', proofData.rangeProofData.length);

      // Generate context state keypairs for split proofs
      const equalityContextKeypair = generateContextStateKeypair();
      const validityContextKeypair = generateContextStateKeypair();
      const rangeContextKeypair = generateContextStateKeypair();

      console.log('Context state accounts:');
      console.log('  Equality:', equalityContextKeypair.address);
      console.log('  Validity:', validityContextKeypair.address);
      console.log('  Range:', rangeContextKeypair.address);

      // Helper to get fresh blockhash (using 'confirmed' for fresher blockhashes)
      const getBlockhash = async () => {
        const response = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getLatestBlockhash',
            params: [{ commitment: 'confirmed' }]
          })
        });
        const data = await response.json();
        return {
          blockhash: data.result.value.blockhash,
          lastValidBlockHeight: BigInt(data.result.value.lastValidBlockHeight)
        };
      };

      // Get initial blockhash for building transactions
      const { blockhash: recentBlockhash, lastValidBlockHeight } = await getBlockhash();

      // Build all split proof transactions using ZK SDK-generated proofs
      const { transactions } = await buildSplitProofTransferTransactions(
        selectedToken.address,
        recipientInfo.tokenAccountAddress,
        selectedToken.mint,
        publicKey,
        proofData,
        recentBlockhash,
        lastValidBlockHeight,
        RPC_URL,
        equalityContextKeypair,
        validityContextKeypair,
        rangeContextKeypair
      );

      console.log(`Built ${transactions.length} transactions for split proof transfer`);

      // Process each transaction (5 transactions to fit within wallet limits)
      const stepNames: SplitProofTransferProgress['step'][] = [
        'creating_equality',
        'creating_validity',
        'creating_range',
        'verifying_range',
        'executing_transfer',
      ];

      let lastSignature = '';

      for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        console.log(`Processing transaction ${i + 1}/${transactions.length}: ${tx.name}`);

        setTransferProgress({
          step: stepNames[i] || 'executing_transfer',
          currentTransaction: i + 1,
          totalTransactions: transactions.length,
        });

        // Retry logic with fresh blockhash for each transaction
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            // Get fresh blockhash for this transaction
            const { blockhash: freshBlockhash, lastValidBlockHeight: freshHeight } = await getBlockhash();

            // Rebuild this specific transaction with fresh blockhash (using already-generated proofs)
            const { transactions: rebuiltTxs } = await buildSplitProofTransferTransactions(
              selectedToken.address,
              recipientInfo.tokenAccountAddress,
              selectedToken.mint,
              publicKey,
              proofData,
              freshBlockhash,
              freshHeight,
              RPC_URL,
              equalityContextKeypair,
              validityContextKeypair,
              rangeContextKeypair
            );

            const rebuiltTx = rebuiltTxs[i];

            // Serialize the compiled transaction
            const base64Tx = serializeTransactionToBase64(rebuiltTx.compiled);
            const txBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));
            console.log(`Tx ${i + 1} size: ${txBytes.length} bytes (attempt ${attempt})`);

            // If this transaction has additional signers (context keypairs), sign with them first
            if (rebuiltTx.additionalSigners && rebuiltTx.additionalSigners.length > 0) {
              // Create a VersionedTransaction to add partial signatures
              const versionedTx = VersionedTransaction.deserialize(txBytes);
              const messageBytes = versionedTx.message.serialize();

              console.log(`Tx ${i + 1}: numRequiredSignatures =`, versionedTx.message.header.numRequiredSignatures);
              console.log(`Tx ${i + 1}: staticAccountKeys =`, versionedTx.message.staticAccountKeys.map(k => k.toBase58()));

              for (const signerSecretKey of rebuiltTx.additionalSigners) {
                // Sign with the context keypair
                const signature = signWithKeypair(messageBytes, signerSecretKey);
                const signerPubkey = ed25519.getPublicKey(signerSecretKey);

                // Find the index of this signer in the transaction's account keys
                // and add the signature at the correct position
                const staticKeys = versionedTx.message.staticAccountKeys;
                const signerPubkeyBase58 = new PublicKey(signerPubkey).toBase58();
                const signerIndex = staticKeys.findIndex(
                  key => key.toBase58() === signerPubkeyBase58
                );

                console.log(`Tx ${i + 1}: Looking for signer ${signerPubkeyBase58}, found at index ${signerIndex}`);

                if (signerIndex >= 0 && signerIndex < versionedTx.message.header.numRequiredSignatures) {
                  versionedTx.signatures[signerIndex] = signature;
                  console.log(`Added signature for context account at index ${signerIndex}`);
                } else if (signerIndex >= 0) {
                  console.error(`Signer found at index ${signerIndex} but numRequiredSignatures is ${versionedTx.message.header.numRequiredSignatures}`);
                } else {
                  console.warn('Context signer not found in transaction accounts');
                }
              }

              // Re-serialize with partial signatures for wallet signing
              const partiallySignedTx = versionedTx.serialize();
              lastSignature = await signAndSendTransaction(partiallySignedTx);
            } else {
              // No additional signers, just send to wallet
              lastSignature = await signAndSendTransaction(txBytes);
            }

            console.log(`Transaction ${i + 1} sent: ${lastSignature}`);
            break; // Success, exit retry loop

          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const errorMsg = lastError.message || '';

            if (errorMsg.includes('Blockhash not found') && attempt < maxRetries) {
              console.log(`Tx ${i + 1}: Blockhash issue, retrying (${attempt}/${maxRetries})...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }

            // Non-retryable error or max retries reached
            throw lastError;
          }
        }

        // Wait for transaction confirmation before proceeding to the next one
        if (i < transactions.length - 1) {
          console.log(`Transaction ${i + 1} sent (${lastSignature}), waiting for confirmation...`);

          // Wait a moment then check transaction status
          await new Promise(resolve => setTimeout(resolve, 1500));

          const confirmResult = await waitForConfirmation(RPC_URL, lastSignature, 10000);

          if (!confirmResult.confirmed) {
            const errorMsg = confirmResult.error
              ? JSON.stringify(confirmResult.error)
              : 'Transaction failed or timed out';
            throw new Error(`Transaction ${i + 1} failed: ${errorMsg}`);
          }

          console.log(`Transaction ${i + 1} confirmed successfully`);
        }
      }

      console.log('Confidential transfer complete!');

      setTransferProgress({
        step: 'complete',
        currentTransaction: transactions.length,
        totalTransactions: transactions.length,
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

      // Provide more helpful error messages for common issues
      let errorMessage = 'Transfer failed';
      if (err instanceof Error) {
        errorMessage = err.message;
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else {
        errorMessage = String(err);
      }

      if (errorMessage.includes('too large') || errorMessage.includes('encoding overruns') || errorMessage.includes('1644')) {
        errorMessage = 'Transaction too large: The RPC may not support 4KB transactions. ' +
          'The zk-edge.surfnet.dev RPC supports larger transactions needed for ZK proofs.';
      } else if (errorMessage.includes('invalid account data')) {
        errorMessage = 'Context state account error: The ZK proof context state format may not be supported by this RPC. ' +
          'This custom devnet may have different requirements for proof verification.';
      } else if (errorMessage.includes('InvalidInstructionData')) {
        errorMessage = 'Invalid instruction data: The transfer instruction format may not match what the program expects. ' +
          'This could be due to proof verification issues or incorrect account configuration.';
      }

      setTransferProgress({
        step: 'error',
        currentTransaction: 0,
        totalTransactions: 5,
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
    console.log('handleConfigureCt called, publicKey:', publicKey, 'token:', token.address);
    if (!publicKey) {
      console.log('handleConfigureCt: publicKey is falsy, returning early');
      return;
    }

    // Guard against multiple concurrent calls (React StrictMode / event bubbling)
    if (configuringRef.current) {
      console.log('handleConfigureCt: already in progress, skipping');
      return;
    }
    configuringRef.current = true;

    setConfiguringAccount(token.address);
    setConfigureError(null);

    try {
      // Step 0: Check mint and token account extensions
      console.log('Checking mint and token account extensions...');

      // Check mint
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
      console.log('Mint extensions:', JSON.stringify(mintData.result?.value?.data?.parsed?.info?.extensions || [], null, 2));

      const mintExtensions = mintData.result?.value?.data?.parsed?.info?.extensions || [];
      const hasCtMint = mintExtensions.some((ext: { extension: string }) =>
        ext.extension === 'confidentialTransferMint'
      );
      console.log('Mint has CT extension:', hasCtMint);

      if (!hasCtMint) {
        throw new Error('Mint does not have ConfidentialTransferMint extension. Confidential transfers cannot be configured.');
      }

      // Check token account
      const accountResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [token.address, { encoding: 'jsonParsed' }]
        })
      });
      const accountData = await accountResponse.json();
      const accountExtensions = accountData.result?.value?.data?.parsed?.info?.extensions || [];
      console.log('Token account extensions:', JSON.stringify(accountExtensions, null, 2));
      console.log('Token account data size:', accountData.result?.value?.data?.parsed?.info?.space || accountData.result?.value?.space);

      // Check if CT extension already exists on account
      const hasCtAccount = accountExtensions.some((ext: { extension: string }) =>
        ext.extension === 'confidentialTransferAccount'
      );
      console.log('Token account already has CT extension:', hasCtAccount);

      // Step 1: Get wallet keys for derivation via ZK SDK
      console.log('Getting ElGamal keypair via ZK SDK...');
      const { keypair, publicKeyBytes, aeKey } = await getElGamalKeys(token.address);
      console.log('ElGamal pubkey derived (full 32 bytes):', Array.from(publicKeyBytes).map(b => b.toString(16).padStart(2, '0')).join(''));
      console.log('ElGamal pubkey length:', publicKeyBytes.length);

      // Cache the keys for later use
      setCachedKeys(prev => ({
        ...prev,
        [token.address]: { keypair, aeKey, publicKeyBytes }
      }));

      // Step 2: Build the instructions via ZK SDK
      console.log('Building instructions via ZK SDK...');
      const { reallocateInstruction, proofInstruction, configureInstruction } = await buildConfigureCtInstructions(
        token.address,
        token.mint,
        publicKey,
        keypair,
        aeKey
      );

      // Step 3: Get recent blockhash
      console.log('Getting blockhash...');
      const blockhashResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'confirmed' }]
        })
      });
      const blockhashData = await blockhashResponse.json();
      if (blockhashData.error) {
        throw new Error(blockhashData.error.message);
      }
      const recentBlockhash = blockhashData.result.value.blockhash;
      const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);
      console.log('Blockhash:', recentBlockhash);
      console.log('Last valid block height:', lastValidBlockHeight.toString());

      // Step 4: Build transaction using Solana Kit
      console.log('Building transaction with Solana Kit...');
      console.log('Proof instruction data length:', proofInstruction.data?.length ?? 0);
      console.log('Token account:', token.address);
      console.log('Mint:', token.mint);
      console.log('Owner:', publicKey);

      const compiledTransaction = buildConfigureCtTransaction(
        reallocateInstruction,
        configureInstruction,
        proofInstruction,
        recentBlockhash,
        lastValidBlockHeight,
        publicKey
      );
      console.log('Compiled transaction:', compiledTransaction);

      // Step 5: Serialize to base64 for wallet
      const base64Tx = serializeTransactionToBase64(compiledTransaction);
      console.log('Base64 transaction length:', base64Tx.length);

      // Step 6: Send to wallet for signing and sending
      console.log('Sending to wallet...');

      // Convert base64 to Uint8Array for wallet
      const transactionBytes = Uint8Array.from(atob(base64Tx), c => c.charCodeAt(0));
      const signature = await signAndSendTransaction(transactionBytes);

      console.log('Transaction sent:', signature);

      // Refresh token accounts (don't let refresh failure mask a successful configure)
      try {
        await fetchTokenAccounts();
      } catch (refreshErr) {
        console.warn('Post-configure token refresh failed (configure itself succeeded):', refreshErr);
      }

      setConfigureError(null);
    } catch (err) {
      console.error('Failed to configure confidential transfers:', err);
      console.error('Error type:', typeof err, 'constructor:', err?.constructor?.name);
      if (err && typeof err === 'object') {
        console.error('Error keys:', Object.keys(err));
        try { console.error('Error JSON:', JSON.stringify(err, null, 2)); } catch {}
      }
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
              { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
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
                                        {transferProgress.step === 'creating_equality' && 'Creating & verifying equality proof...'}
                                        {transferProgress.step === 'creating_validity' && 'Creating & verifying validity proof...'}
                                        {transferProgress.step === 'creating_range' && 'Creating range context...'}
                                        {transferProgress.step === 'verifying_range' && 'Verifying range proof...'}
                                        {transferProgress.step === 'executing_transfer' && 'Executing transfer & closing contexts...'}
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
                                          style={{ width: `${(transferProgress.currentTransaction / transferProgress.totalTransactions) * 100}%` }}
                                        />
                                      </div>

                                      <div className="text-[10px] text-zinc-500">
                                        Step {transferProgress.currentTransaction} of {transferProgress.totalTransactions}
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
                                            <strong>Note:</strong> Confidential transfers use 5 transactions with ZK proofs
                                            to fit within wallet transaction size limits.
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
