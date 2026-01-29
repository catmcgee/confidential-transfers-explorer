'use client';

import { useState, useCallback } from 'react';
import { useWallet } from './WalletProvider';
import { useAuth } from '@/hooks/useAuth';
import { shortenAddress } from '@/lib/format';

export function WalletButton() {
  const { publicKey, isConnected, isConnecting, connect, disconnect } = useWallet();
  const { isAuthenticated, login, logout, isLoggingIn } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const handleConnect = useCallback(async () => {
    try {
      await connect();
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  }, [connect]);

  const handleLogin = useCallback(async () => {
    try {
      await login();
    } catch (error) {
      console.error('Failed to login:', error);
    }
  }, [login]);

  const handleLogout = useCallback(async () => {
    await logout();
    disconnect();
    setShowMenu(false);
  }, [logout, disconnect]);

  if (!isConnected) {
    return (
      <button
        onClick={handleConnect}
        disabled={isConnecting}
        className="btn btn-primary"
      >
        {isConnecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
      >
        <div className="w-6 h-6 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full" />
        <span className="font-mono text-sm text-gray-200">
          {shortenAddress(publicKey!, 4)}
        </span>
        {isAuthenticated && (
          <span className="w-2 h-2 bg-green-500 rounded-full" title="Logged in" />
        )}
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 mt-2 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-20">
            <div className="p-3 border-b border-gray-800">
              <div className="text-xs text-gray-400 mb-1">Connected</div>
              <div className="font-mono text-sm text-gray-200 truncate">
                {publicKey}
              </div>
            </div>

            <div className="p-2">
              {!isAuthenticated ? (
                <button
                  onClick={handleLogin}
                  disabled={isLoggingIn}
                  className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800 rounded transition-colors"
                >
                  {isLoggingIn ? 'Signing...' : 'Sign in to unlock data'}
                </button>
              ) : (
                <div className="px-3 py-2 text-sm text-green-400 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Signed in
                </div>
              )}

              <button
                onClick={handleLogout}
                className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-gray-800 rounded transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
