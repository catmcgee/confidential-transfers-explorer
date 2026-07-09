'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useWallet } from './WalletProvider';
import { shortenAddress } from '@/lib/format';

export function WalletButton() {
  const {
    publicKey,
    isConnected,
    isConnecting,
    connect,
    disconnect,
    walletIcon,
    isLocalWallet,
    newLocalWallet,
    exportLocalSecretKey,
  } = useWallet();
  const [showMenu, setShowMenu] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [confirmNewWallet, setConfirmNewWallet] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
        setConfirmNewWallet(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const handleDisconnect = useCallback(async () => {
    setShowMenu(false);
    try {
      await disconnect();
    } catch (error) {
      console.error('Failed to disconnect:', error);
    }
  }, [disconnect]);

  const handleCopySecretKey = useCallback(async () => {
    const secretKey = exportLocalSecretKey();
    if (!secretKey) return;
    await navigator.clipboard.writeText(secretKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }, [exportLocalSecretKey]);

  const handleNewWallet = useCallback(async () => {
    if (!confirmNewWallet) {
      setConfirmNewWallet(true);
      return;
    }
    setConfirmNewWallet(false);
    setShowMenu(false);
    try {
      await newLocalWallet();
    } catch (error) {
      console.error('Failed to create new wallet:', error);
    }
  }, [confirmNewWallet, newLocalWallet]);

  if (!isConnected || !publicKey) {
    // The local wallet loads almost immediately; this shows only in the
    // brief moment before it's ready (or if storage is unavailable).
    return (
      <button
        onClick={() => void connect()}
        className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded transition-colors"
      >
        {isConnecting ? 'Connecting...' : 'Connect'}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
      >
        {walletIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={walletIcon} alt="" className="w-5 h-5 rounded-full" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500" />
        )}
        <span className="font-mono text-xs text-zinc-200">
          {shortenAddress(publicKey, 4)}
        </span>
        {isLocalWallet && (
          <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded">
            local
          </span>
        )}
        <svg
          className={`w-3 h-3 text-zinc-500 transition-transform ${showMenu ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showMenu && (
        <div ref={menuRef} className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-20">
          <div className="p-3 border-b border-zinc-800">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
              {isLocalWallet ? 'Local wallet' : 'Connected'}
            </div>
            <div className="font-mono text-[11px] text-zinc-300 break-all">
              {publicKey}
            </div>
            {isLocalWallet && (
              <p className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                This keypair was generated in your browser and lives in local
                storage. It signs everything automatically — no extension or
                login needed. Clearing site data deletes it, so copy the secret
                key if you want to keep it.
              </p>
            )}
          </div>

          <div className="p-2 space-y-0.5">
            {isLocalWallet ? (
              <>
                <button
                  onClick={handleCopySecretKey}
                  className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
                >
                  {copiedKey ? 'Copied!' : 'Copy secret key (importable into Phantom etc.)'}
                </button>
                <button
                  onClick={() => { setShowMenu(false); void connect(); }}
                  className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800 rounded transition-colors"
                >
                  Connect a browser wallet instead
                </button>
                <button
                  onClick={handleNewWallet}
                  className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-zinc-800 rounded transition-colors"
                >
                  {confirmNewWallet
                    ? 'Click again to confirm — the current key is discarded'
                    : 'Start over with a new wallet'}
                </button>
              </>
            ) : (
              <button
                onClick={handleDisconnect}
                className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-zinc-800 rounded transition-colors"
              >
                Disconnect (falls back to the local wallet)
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
