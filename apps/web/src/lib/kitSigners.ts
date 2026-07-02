/**
 * Adapters that wrap the app's wallet-standard callbacks into @solana/kit
 * signer interfaces so they can be used with instruction plans and the
 * confidential-transfer helpers from @solana-program/token-2022.
 */

import {
  address,
  getBase58Encoder,
  getTransactionEncoder,
  type MessagePartialSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionSendingSigner,
} from '@solana/kit';

/**
 * Wraps a wallet's `signMessage` into a kit `MessagePartialSigner`.
 * Used for deriving ElGamal/AES keys from wallet signatures.
 */
export function createWalletMessageSigner(
  walletAddress: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): MessagePartialSigner {
  const signerAddress = address(walletAddress);
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
}

/**
 * Wraps a wallet's `signAndSendTransaction` into a kit
 * `TransactionSendingSigner` so it can act as the fee payer for
 * instruction plans (the wallet signs and submits each transaction).
 */
export function createWalletSendingSigner(
  walletAddress: string,
  signAndSendTransaction: (transaction: Uint8Array) => Promise<string>
): TransactionSendingSigner {
  const signerAddress = address(walletAddress);
  const transactionEncoder = getTransactionEncoder();
  const base58Encoder = getBase58Encoder();
  return {
    address: signerAddress,
    signAndSendTransactions: async (transactions) => {
      const signatures: SignatureBytes[] = [];
      for (const transaction of transactions) {
        const wireBytes = transactionEncoder.encode(transaction);
        const signatureBase58 = await signAndSendTransaction(new Uint8Array(wireBytes));
        signatures.push(base58Encoder.encode(signatureBase58) as SignatureBytes);
      }
      return signatures;
    },
  };
}
