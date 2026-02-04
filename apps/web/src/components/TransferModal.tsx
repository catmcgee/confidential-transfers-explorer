'use client';

import { useState, useEffect } from 'react';
import { useWallet } from './WalletProvider';
import { shortenAddress } from '@/lib/format';
import {
  deriveElGamalKeypair,
  deriveAeKey,
  buildConfigureCtInstructions,
  buildConfigureCtTransaction,
  buildDepositTransaction,
  buildApplyPendingBalanceTransaction,
  serializeTransactionToBase64,
  parseElGamalPubkeyFromAccountInfo,
  decryptPendingBalance,
  decryptDecryptableBalance,
  generateSplitTransferProofs,
  buildSplitProofTransferTransactions,
  generateContextStateKeypair,
  signWithKeypair,
  type SplitProofTransferProgress,
} from '@/lib/confidentialTransfer';
import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';

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

  // Cached keys only (not balances) - keys require wallet signature so we cache them
  const [cachedKeys, setCachedKeys] = useState<Record<string, {
    elgamalSecretKey: Uint8Array;
    aeKey: unknown;
  }>>({});

  // Get cached keys for selected token
  const tokenCache = selectedToken ? cachedKeys[selectedToken.address] : null;

  // Select a token - reset decrypted balances, keys will be derived on decrypt
  const handleSelectToken = async (token: TokenAccount) => {
    setSelectedToken(token);
    setOperation(null);
    setOperationError(null);
    // Reset decrypted balances when selecting a new token
    setDecryptedPendingBalance(null);
    setDecryptedConfidentialBalance(null);
  };

  // Decrypt pending balance - derives keys if needed, fetches fresh state from RPC, then decrypts
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

      // Derive keys if not cached
      let secretKey = tokenCache?.elgamalSecretKey;
      if (!secretKey) {
        console.log('Deriving keys for decryption...');
        const { secretKey: derivedKey } = await deriveElGamalKeypair(signMessage, selectedToken.address);
        const { aeKey: derivedAeKey } = await deriveAeKey(signMessage, selectedToken.address);
        secretKey = derivedKey;
        // Cache the keys
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: { elgamalSecretKey: derivedKey, aeKey: derivedAeKey }
        }));
      }

      console.log('Decrypting pending balance...');
      const pendingBalance = await decryptPendingBalance(
        secretKey,
        freshCtState.pendingBalanceLo,
        freshCtState.pendingBalanceHi
      );

      console.log('Decrypted pending balance:', pendingBalance?.toString());
      setDecryptedPendingBalance(pendingBalance);
    } catch (err) {
      console.error('Failed to decrypt pending balance:', err);
    } finally {
      setIsDecryptingPending(false);
    }
  };

  // Decrypt confidential balance - derives keys if needed, fetches fresh state from RPC, then decrypts
  // Uses AES decryption on decryptableAvailableBalance (not ElGamal which is too slow for large values)
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

      // Derive AE key if not cached (needed for AES decryption)
      let aeKey = tokenCache?.aeKey;
      if (!aeKey) {
        console.log('Deriving keys for decryption...');
        const { secretKey: derivedKey } = await deriveElGamalKeypair(signMessage, selectedToken.address);
        const { aeKey: derivedAeKey } = await deriveAeKey(signMessage, selectedToken.address);
        aeKey = derivedAeKey;
        // Cache the keys
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: { elgamalSecretKey: derivedKey, aeKey: derivedAeKey }
        }));
      }

      console.log('Decrypting confidential balance using AES...');
      console.log('Fresh decryptableAvailableBalance:', freshCtState.decryptableAvailableBalance);

      // Use AES decryption on decryptableAvailableBalance (much faster than ElGamal for large values)
      const balance = await decryptDecryptableBalance(
        aeKey,
        freshCtState.decryptableAvailableBalance
      );

      console.log('Decrypted confidential balance:', balance?.toString());
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

      // Get blockhash
      const blockhashResponse = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }]
        })
      });
      const blockhashData = await blockhashResponse.json();
      const recentBlockhash = blockhashData.result.value.blockhash;
      const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);

      // Build deposit transaction
      const compiledTx = buildDepositTransaction(
        selectedToken.address,
        selectedToken.mint,
        publicKey,
        amount,
        selectedToken.decimals,
        recentBlockhash,
        lastValidBlockHeight
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

      // Refresh
      await fetchTokenAccounts();
      setDepositAmount('');
      setOperation(null);
    } catch (err) {
      console.error('Deposit failed:', err);
      setOperationError(err instanceof Error ? err.message : 'Deposit failed');
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

      // Use cached AE key - derive if not available
      let aeKey = tokenCache?.aeKey;
      if (!aeKey) {
        console.log('Deriving keys for apply pending...');
        const { secretKey } = await deriveElGamalKeypair(signMessage, selectedToken.address);
        const { aeKey: derivedAeKey } = await deriveAeKey(signMessage, selectedToken.address);
        aeKey = derivedAeKey;
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: { elgamalSecretKey: secretKey, aeKey: derivedAeKey }
        }));
      }

      // The expected counter is the current pending balance credit counter
      const expectedCounter = BigInt(ctState.pendingBalanceCreditCounter);

      // Get current available balance from decrypted state
      const currentAvailable = decryptedConfidentialBalance ?? 0n;

      // Get the pending amount from decrypted state or manual input
      let pendingAmount = decryptedPendingBalance ?? 0n;

      // If no decrypted pending but there IS pending on-chain, use manual input
      if (pendingAmount === 0n && ctState.pendingBalanceCreditCounter > 0 && newBalanceAmount) {
        const manualNewBalance = BigInt(Math.floor(parseFloat(newBalanceAmount) * Math.pow(10, selectedToken.decimals)));
        pendingAmount = manualNewBalance - currentAvailable;
      }

      // New available = current available + pending amount
      const newAvailableBalance = currentAvailable + pendingAmount;

      if (newAvailableBalance <= 0n && ctState.pendingBalanceCreditCounter > 0) {
        throw new Error('Please decrypt balances first or enter the expected new balance amount');
      }

      console.log('ApplyPendingBalance:', {
        expectedCounter: expectedCounter.toString(),
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
          params: [{ commitment: 'finalized' }]
        })
      });
      const blockhashData = await blockhashResponse.json();
      const recentBlockhash = blockhashData.result.value.blockhash;
      const lastValidBlockHeight = BigInt(blockhashData.result.value.lastValidBlockHeight);

      // Build apply pending balance transaction
      const compiledTx = await buildApplyPendingBalanceTransaction(
        selectedToken.address,
        publicKey,
        expectedCounter,
        newAvailableBalance,
        aeKey,
        recentBlockhash,
        lastValidBlockHeight
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

      // Refresh
      await fetchTokenAccounts();
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
      setOperationError('Please decrypt your confidential balance first');
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
      totalTransactions: 6,
    });

    try {
      // Derive keys if not cached
      let senderAeKey = tokenCache?.aeKey;
      if (!senderAeKey) {
        console.log('Deriving keys for transfer...');
        const { secretKey } = await deriveElGamalKeypair(signMessage, selectedToken.address);
        const { aeKey: derivedAeKey } = await deriveAeKey(signMessage, selectedToken.address);
        senderAeKey = derivedAeKey;
        setCachedKeys(prev => ({
          ...prev,
          [selectedToken.address]: { elgamalSecretKey: secretKey, aeKey: derivedAeKey }
        }));
      }

      // Derive the full keypair for proofs
      const { keypair } = await deriveElGamalKeypair(signMessage, selectedToken.address);

      console.log('Generating ZK proofs for confidential transfer...');
      console.log('Sender:', selectedToken.address);
      console.log('Recipient:', recipientInfo.tokenAccountAddress);
      console.log('Amount:', amount.toString());
      console.log('Sender available balance:', available.toString());

      // Generate all proofs first (this is the slow part)
      const proofData = await generateSplitTransferProofs(
        keypair,
        available,
        amount,
        recipientInfo.elgamalPubkey
      );

      console.log('Proofs generated successfully');
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

      // Build all split proof transactions
      const { transactions } = await buildSplitProofTransferTransactions(
        selectedToken.address,
        recipientInfo.tokenAccountAddress,
        selectedToken.mint,
        publicKey,
        amount,
        keypair,
        senderAeKey,
        available,
        recipientInfo.elgamalPubkey,
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

            // Rebuild this specific transaction with fresh blockhash
            const { transactions: rebuiltTxs } = await buildSplitProofTransferTransactions(
              selectedToken.address,
              recipientInfo.tokenAccountAddress,
              selectedToken.mint,
              publicKey,
              amount,
              keypair,
              senderAeKey,
              available,
              recipientInfo.elgamalPubkey,
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

        // Wait briefly before next transaction (custom RPC doesn't reliably track tx status)
        if (i < transactions.length - 1) {
          // For this custom RPC, just use a fixed delay since getSignatureStatuses returns null
          console.log(`Transaction ${i + 1} sent, waiting 2s before next transaction...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
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

      // Refresh token accounts
      await fetchTokenAccounts();

    } catch (err) {
      console.error('Confidential transfer failed:', err);

      // Provide more helpful error messages for common issues
      let errorMessage = err instanceof Error ? err.message : 'Transfer failed';

      if (errorMessage.includes('too large') || errorMessage.includes('encoding overruns') || errorMessage.includes('1644')) {
        errorMessage = 'Transaction too large: The RPC may not support 4KB transactions. ' +
          'The zk-edge.surfnet.dev RPC supports larger transactions needed for ZK proofs.';
      } else if (errorMessage.includes('invalid account data')) {
        errorMessage = 'Context state account error: The ZK proof context state format may not be supported by this RPC. ' +
          'This custom devnet may have different requirements for proof verification.';
      }

      setTransferProgress({
        step: 'error',
        currentTransaction: 0,
        totalTransactions: 6,
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

      // Step 1: Derive ElGamal keypair from wallet signature using WASM SDK
      console.log('Deriving ElGamal keypair...');
      const { publicKey: elgamalPubkey, secretKey: elgamalSecretKey, keypair } = await deriveElGamalKeypair(
        signMessage,
        token.address
      );
      console.log('ElGamal pubkey derived (full 32 bytes):', Array.from(elgamalPubkey).map(b => b.toString(16).padStart(2, '0')).join(''));
      console.log('ElGamal pubkey length:', elgamalPubkey.length);
      console.log('ElGamal secret key (first 8 bytes):', Array.from(elgamalSecretKey.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(''));

      // Step 2: Build the instructions (now async - uses WASM SDK for proof generation)
      console.log('Building instructions...');
      const { reallocateInstruction, proofInstruction, configureInstruction } = await buildConfigureCtInstructions(
        token.address,
        token.mint,
        publicKey,
        elgamalPubkey,
        keypair
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
          params: [{ commitment: 'finalized' }]
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

      // Refresh token accounts
      await fetchTokenAccounts();

      setConfigureError(null);
    } catch (err) {
      console.error('Failed to configure confidential transfers:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to configure confidential transfers';
      setConfigureError(errorMessage);
    } finally {
      setConfiguringAccount(null);
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

      const data = await response.json();

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
                <p className="text-xs text-zinc-500">Loading Token-2022 accounts...</p>
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
                                  <div className="text-[10px] text-blue-400 mb-2">Deposit from public to confidential pending balance</div>
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
                                  <div className="text-[10px] text-purple-400 mb-2">Move pending balance to available balance</div>
                                  {token.ctState && token.ctState.pendingBalanceCreditCounter > 0 && decryptedPendingBalance === null && (
                                    <div className="mb-2">
                                      <div className="text-[10px] text-zinc-400 mb-1">Decrypt balances first, or enter expected new total balance:</div>
                                      <input
                                        type="number"
                                        placeholder="New available balance"
                                        value={newBalanceAmount}
                                        onChange={(e) => setNewBalanceAmount(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="w-full px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200"
                                      />
                                    </div>
                                  )}
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

                                      {transferProgress.step === 'complete' && transferProgress.signature && (
                                        <div className="text-[10px] text-zinc-400">
                                          <div className="mb-1">Signature:</div>
                                          <a
                                            href={`/tx/${transferProgress.signature}`}
                                            onClick={(e) => e.stopPropagation()}
                                            className="font-mono text-emerald-400 hover:text-emerald-300 break-all text-[9px] block"
                                          >
                                            {transferProgress.signature}
                                          </a>
                                        </div>
                                      )}

                                      {transferProgress.step === 'error' && (
                                        <div className="text-[10px] text-red-400">
                                          {transferProgress.error}
                                        </div>
                                      )}

                                      {(transferProgress.step === 'complete' || transferProgress.step === 'error') && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setTransferProgress(null); }}
                                          className="w-full px-2 py-1.5 text-[10px] bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                                        >
                                          {transferProgress.step === 'complete' ? 'Done' : 'Try Again'}
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
                                              : 'decrypt first'
                                            }
                                          </div>

                                          <button
                                            onClick={(e) => { e.stopPropagation(); handleTransfer(); }}
                                            disabled={isProcessing || !transferAmount || !recipientInfo?.elgamalPubkey}
                                            className="w-full px-2 py-1.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white rounded transition-colors"
                                          >
                                            {isProcessing ? 'Processing...' : 'Send Confidential Transfer'}
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

                          <div className="text-[10px] text-zinc-600 font-mono break-all mt-1">
                            {token.address}
                          </div>
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
                    <div className="mb-3 p-2 bg-yellow-500/5 border border-yellow-500/20 rounded text-[10px] text-yellow-400/80">
                      Confidential configuration requires ElGamal key derivation from your wallet. Use the CLI command below with your wallet keypair.
                    </div>
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
                            className="w-full mb-3 px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-wait rounded transition-colors flex items-center justify-center gap-2"
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

                          <div className="text-[10px] text-zinc-600 mb-2">Or use CLI:</div>
                          <div className="flex items-start gap-2">
                            <code className="text-[10px] text-zinc-500 font-mono break-all flex-1 bg-zinc-900/50 p-2 rounded">
                              spl-token configure-confidential-transfer-account --address {token.address}
                            </code>
                            <CopyButton
                              text={`spl-token configure-confidential-transfer-account --address ${token.address}`}
                              label="Copy cmd"
                            />
                          </div>
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
