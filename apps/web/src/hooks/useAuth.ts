'use client';

import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@/components/WalletProvider';

interface AuthState {
  isAuthenticated: boolean;
  publicKey: string | null;
  expiresAt: number | null;
}

// Base58 encoder for signatures
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zeros
  let zeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros++;
  }

  // Convert to base58
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Convert to string
  let result = '';
  for (let i = 0; i < zeros; i++) {
    result += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]!];
  }

  return result;
}

export function useAuth() {
  const { publicKey, isConnected, signMessage } = useWallet();
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    publicKey: null,
    expiresAt: null,
  });
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Check session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch('/api/auth/session');
        const data = await response.json();

        if (data.success && data.data.authenticated) {
          setAuthState({
            isAuthenticated: true,
            publicKey: data.data.publicKey,
            expiresAt: data.data.expiresAt,
          });
        }
      } catch (error) {
        console.error('Failed to check session:', error);
      }
    };

    checkSession();
  }, []);

  // Clear auth if wallet disconnects
  useEffect(() => {
    if (!isConnected && authState.isAuthenticated) {
      setAuthState({
        isAuthenticated: false,
        publicKey: null,
        expiresAt: null,
      });
    }
  }, [isConnected, authState.isAuthenticated]);

  const login = useCallback(async () => {
    if (!publicKey || !isConnected) {
      throw new Error('Wallet not connected');
    }

    setIsLoggingIn(true);
    try {
      // Create message with timestamp
      const timestamp = Date.now();
      const message = `CT Explorer Login: ${timestamp}`;
      const messageBytes = new TextEncoder().encode(message);

      // Sign message
      const signature = await signMessage(messageBytes);
      const signatureBase58 = encodeBase58(signature);

      // Send to server
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey,
          signature: signatureBase58,
          message,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Login failed');
      }

      setAuthState({
        isAuthenticated: true,
        publicKey,
        expiresAt: data.data.expiresAt,
      });
    } finally {
      setIsLoggingIn(false);
    }
  }, [publicKey, isConnected, signMessage]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout error:', error);
    }

    setAuthState({
      isAuthenticated: false,
      publicKey: null,
      expiresAt: null,
    });
  }, []);

  return {
    isAuthenticated: authState.isAuthenticated,
    authenticatedPublicKey: authState.publicKey,
    expiresAt: authState.expiresAt,
    isLoggingIn,
    login,
    logout,
  };
}
