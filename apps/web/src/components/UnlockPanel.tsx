'use client';

import { useState, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDecryption } from '@/hooks/useDecryption';

export function UnlockPanel() {
  const { isAuthenticated } = useAuth();
  const { isUnlocked, unlock, lock, error } = useDecryption();
  const [keyInput, setKeyInput] = useState('');
  const [showWarning, setShowWarning] = useState(true);

  const handleUnlock = useCallback(async () => {
    if (!keyInput.trim()) return;

    try {
      await unlock(keyInput.trim());
      setKeyInput('');
    } catch (err) {
      console.error('Failed to unlock:', err);
    }
  }, [keyInput, unlock]);

  if (!isAuthenticated) {
    return (
      <div className="card p-4">
        <div className="text-center text-gray-400">
          <p>Connect and sign in with your wallet to unlock decryption features.</p>
        </div>
      </div>
    );
  }

  if (isUnlocked) {
    return (
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-900/50 rounded-lg flex items-center justify-center">
              <svg
                className="w-5 h-5 text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <div className="text-green-400 font-medium">Decryption Unlocked</div>
              <div className="text-sm text-gray-400">
                Your balances and amounts are decrypted locally.
              </div>
            </div>
          </div>
          <button onClick={lock} className="btn btn-outline text-sm">
            Lock
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center flex-shrink-0">
          <svg
            className="w-5 h-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <div className="text-white font-medium">Unlock Decryption</div>
          <div className="text-sm text-gray-400 mt-1">
            Paste your ElGamal secret key (base64) to decrypt your confidential balances and
            transaction amounts locally.
          </div>
        </div>
      </div>

      {showWarning && (
        <div className="bg-yellow-900/20 border border-yellow-800/50 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div className="text-sm">
              <div className="text-yellow-500 font-medium">Security Notice</div>
              <div className="text-yellow-600 mt-1">
                Your decryption key never leaves your browser. All decryption happens locally.
                Public view hides amounts; unlocked view is local to your browser only.
              </div>
            </div>
            <button
              onClick={() => setShowWarning(false)}
              className="text-yellow-600 hover:text-yellow-500"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <textarea
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="Paste your ElGamal secret key (base64 encoded)..."
          className="input h-20 resize-none font-mono text-sm"
        />

        {error && <div className="text-red-400 text-sm">{error}</div>}

        <div className="flex justify-end">
          <button
            onClick={handleUnlock}
            disabled={!keyInput.trim()}
            className="btn btn-primary"
          >
            Unlock
          </button>
        </div>
      </div>

      <div className="text-xs text-gray-500 border-t border-gray-800 pt-3">
        <p>
          <strong>How to get your key:</strong> Your ElGamal secret key is derived from signing a
          specific message with your wallet. Use the reference tools or SDK to derive your key
          material.
        </p>
      </div>
    </div>
  );
}
