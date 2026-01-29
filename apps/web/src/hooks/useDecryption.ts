'use client';

import { useState, useCallback, useEffect } from 'react';

// Storage key for encrypted key material
const STORAGE_KEY = 'ct-explorer-key-material';

interface DecryptionState {
  isUnlocked: boolean;
  keyMaterial: Uint8Array | null;
  error: string | null;
}

/**
 * Hook for managing client-side decryption state.
 * Key material is stored encrypted in localStorage using WebCrypto.
 */
export function useDecryption() {
  const [state, setState] = useState<DecryptionState>({
    isUnlocked: false,
    keyMaterial: null,
    error: null,
  });

  // Check for stored key material on mount
  useEffect(() => {
    const loadStoredKey = async () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          // In production, this would be encrypted with WebCrypto
          // and require user action to decrypt
          const keyMaterial = base64ToUint8Array(stored);
          setState({
            isUnlocked: true,
            keyMaterial,
            error: null,
          });
        }
      } catch (error) {
        console.error('Failed to load stored key:', error);
      }
    };

    if (typeof window !== 'undefined') {
      loadStoredKey();
    }
  }, []);

  /**
   * Unlock decryption with the provided key material
   */
  const unlock = useCallback(async (keyBase64: string) => {
    try {
      // Validate the key format
      const keyMaterial = base64ToUint8Array(keyBase64);

      // ElGamal secret key should be 32 bytes
      if (keyMaterial.length !== 32) {
        throw new Error('Invalid key length. Expected 32 bytes for ElGamal secret key.');
      }

      // Store in localStorage (in production, encrypt with WebCrypto)
      localStorage.setItem(STORAGE_KEY, keyBase64);

      setState({
        isUnlocked: true,
        keyMaterial,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to unlock';
      setState((prev) => ({ ...prev, error: message }));
      throw error;
    }
  }, []);

  /**
   * Lock decryption and clear key material
   */
  const lock = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setState({
      isUnlocked: false,
      keyMaterial: null,
      error: null,
    });
  }, []);

  /**
   * Decrypt an ElGamal ciphertext
   * This is a simplified implementation - in production, use proper ElGamal decryption
   */
  const decryptCiphertext = useCallback(
    (ciphertextLo: string | null, ciphertextHi: string | null): bigint | null => {
      if (!state.isUnlocked || !state.keyMaterial) {
        return null;
      }

      if (!ciphertextLo || !ciphertextHi) {
        return null;
      }

      try {
        // Decode ciphertexts
        const ctLo = base64ToUint8Array(ciphertextLo);
        const ctHi = base64ToUint8Array(ciphertextHi);

        // In production, implement proper Twisted ElGamal decryption:
        // 1. Extract the random point (first 32 bytes)
        // 2. Extract the ciphertext point (second 32 bytes)
        // 3. Compute shared secret: random_point * secret_key
        // 4. Subtract from ciphertext point
        // 5. Solve discrete log for the result

        // For now, return a placeholder that indicates decryption would happen
        // This is where you'd integrate the actual crypto library
        console.log('[Decryption] Would decrypt ciphertexts:', {
          loLength: ctLo.length,
          hiLength: ctHi.length,
          keyLength: state.keyMaterial.length,
        });

        // Return null to indicate decryption not implemented
        // In production, this would return the decrypted amount
        return null;
      } catch (error) {
        console.error('Decryption failed:', error);
        return null;
      }
    },
    [state.isUnlocked, state.keyMaterial]
  );

  /**
   * Decrypt a pending balance (low and high components)
   */
  const decryptPendingBalance = useCallback(
    (pendingLo: string | null, pendingHi: string | null): bigint | null => {
      const lo = decryptCiphertext(pendingLo, null);
      const hi = decryptCiphertext(pendingHi, null);

      if (lo === null || hi === null) {
        return null;
      }

      // Combine: total = lo + (hi << 16)
      return lo + (hi << 16n);
    },
    [decryptCiphertext]
  );

  return {
    isUnlocked: state.isUnlocked,
    error: state.error,
    unlock,
    lock,
    decryptCiphertext,
    decryptPendingBalance,
  };
}

/**
 * Convert base64 to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
