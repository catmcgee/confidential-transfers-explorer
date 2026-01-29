'use client';

import { useState, useEffect } from 'react';
import { useWallet } from './WalletProvider';

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Token {
  mint: string;
  symbol: string;
  balance: string;
  decimals: number;
}

export function TransferModal({ isOpen, onClose }: TransferModalProps) {
  const { isConnected, publicKey, connect, isConnecting } = useWallet();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);

  // Fetch CT-enabled tokens when connected
  useEffect(() => {
    if (isOpen && isConnected && publicKey) {
      setIsLoadingTokens(true);
      // TODO: Fetch actual CT-enabled token accounts from the chain
      // For now, show empty state - user needs CT-enabled tokens
      setTokens([]);
      setIsLoadingTokens(false);
    }
  }, [isOpen, isConnected, publicKey]);

  // Close on escape key
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

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setRecipient('');
      setAmount('');
      setSelectedToken(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConnect = async () => {
    try {
      await connect();
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedToken || !publicKey) return;

    setIsSubmitting(true);

    // TODO: Implement actual confidential transfer
    alert('Confidential transfer functionality coming soon!');
    setIsSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Modal */}
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/50">
            <div>
              <h2 className="text-sm font-medium text-zinc-100">
                Send Confidential Transfer
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Content */}
          {!isConnected ? (
            <div className="p-8 text-center">
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-zinc-800 flex items-center justify-center">
                <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <p className="text-xs text-zinc-500 mb-4">
                Wallet required
              </p>
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 rounded transition-colors"
              >
                {isConnecting ? 'Connecting...' : 'Connect Wallet'}
              </button>
            </div>
          ) : isLoadingTokens ? (
            <div className="p-8 text-center">
              <div className="w-6 h-6 mx-auto mb-3 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
              <p className="text-xs text-zinc-500">Loading tokens...</p>
            </div>
          ) : tokens.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-zinc-800 flex items-center justify-center">
                <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 12H4" />
                </svg>
              </div>
              <p className="text-xs text-zinc-400 mb-2">No CT-enabled tokens found</p>
              <p className="text-[10px] text-zinc-600">
                You need tokens with confidential transfer enabled
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {/* Token selector */}
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">
                  Token
                </label>
                <div className="space-y-1">
                  {tokens.map((token) => (
                    <button
                      key={token.mint}
                      type="button"
                      onClick={() => setSelectedToken(token)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded text-left transition-colors ${
                        selectedToken?.mint === token.mint
                          ? 'bg-emerald-600/20 border border-emerald-600/50'
                          : 'bg-zinc-800/30 border border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      <div>
                        <span className="text-xs text-zinc-200 font-medium">{token.symbol}</span>
                        <span className="text-[10px] text-zinc-600 ml-2 font-mono">{token.mint}</span>
                      </div>
                      <span className="text-xs text-zinc-400 font-mono">{token.balance}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Recipient */}
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">
                  Recipient
                </label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Wallet address"
                  className="w-full px-3 py-2 bg-zinc-800/30 border border-zinc-800 rounded text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-700 transition-colors"
                  required
                />
              </div>

              {/* Amount */}
              <div>
                <label className="block text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">
                  Amount
                </label>
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="any"
                    min="0"
                    className="w-full px-3 py-2 bg-zinc-800/30 border border-zinc-800 rounded text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-700 transition-colors pr-16"
                    required
                  />
                  {selectedToken && (
                    <button
                      type="button"
                      onClick={() => setAmount(selectedToken.balance)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      MAX
                    </button>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !recipient || !amount || !selectedToken}
                  className="flex-1 px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded transition-colors"
                >
                  {isSubmitting ? 'Sending...' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
