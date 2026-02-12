'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ActivityTable } from '@/components/ActivityTable';
import { TypeFilter } from '@/components/TypeFilter';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { TransferModal } from '@/components/TransferModal';
import { useWallet } from '@/components/WalletProvider';
import { useFeed } from '@/hooks/useFeed';

const KONAMI_SEQUENCE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const TITLE_TEXT = 'Confidential Transfers';

export default function HomePage() {
  const { publicKey, isConnected } = useWallet();
  const [typeFilter, setTypeFilter] = useState('all');
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);

  // Easter egg: Konami code reveals encrypted amounts as 👀
  const [konamiActive, setKonamiActive] = useState(false);
  const konamiIndex = useRef(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === KONAMI_SEQUENCE[konamiIndex.current]) {
        konamiIndex.current++;
        if (konamiIndex.current === KONAMI_SEQUENCE.length) {
          konamiIndex.current = 0;
          setKonamiActive(true);
          setTimeout(() => setKonamiActive(false), 3000);
        }
      } else {
        konamiIndex.current = 0;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Easter egg: click title 3 times for cipher scramble
  const [titleDisplay, setTitleDisplay] = useState(TITLE_TEXT);
  const titleClicks = useRef(0);
  const titleTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTitleClick = useCallback(() => {
    titleClicks.current++;
    if (titleTimeout.current) clearTimeout(titleTimeout.current);
    titleTimeout.current = setTimeout(() => { titleClicks.current = 0; }, 800);

    if (titleClicks.current >= 3) {
      titleClicks.current = 0;
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      let iterations = 0;
      const interval = setInterval(() => {
        setTitleDisplay(
          TITLE_TEXT.split('').map((char, i) => {
            if (char === ' ') return ' ';
            if (i < iterations) return TITLE_TEXT[i];
            return chars[Math.floor(Math.random() * chars.length)];
          }).join('')
        );
        iterations += 0.5;
        if (iterations > TITLE_TEXT.length) {
          clearInterval(interval);
          setTitleDisplay(TITLE_TEXT);
        }
      }, 30);
    }
  }, []);

  // Determine the actual filter to use
  const actualTypeFilter = typeFilter === 'mine' ? 'all' : typeFilter;

  const { activities, isLoading, error, hasMore, loadMore, refresh, addOptimisticActivity } = useFeed({
    type: actualTypeFilter,
    limit: 50,
    autoRefresh: true,
    refreshInterval: 15000,
    address: typeFilter === 'mine' ? publicKey ?? undefined : undefined,
  });

  const filteredActivities = activities;

  return (
    <div className="min-h-[calc(100vh-80px)]">
      {/* Compact header section */}
      <div className="flex items-center justify-between py-6 border-b border-zinc-800/50">
        <div>
          <h1
            className="text-lg font-medium text-zinc-100 tracking-tight cursor-default select-none"
            onClick={handleTitleClick}
          >
            {titleDisplay}
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5 font-mono">
            Token-2022 encrypted activity on zk-edge
          </p>
        </div>
        <button
          onClick={() => setIsTransferModalOpen(true)}
          className="group flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-all duration-150 hover:shadow-lg hover:shadow-emerald-600/20"
        >
          Send
          <svg className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 17L17 7M17 7H7M17 7v10" />
          </svg>
        </button>
      </div>

      {/* Activity feed */}
      <div className="py-6">
        {/* Controls row */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Filter</span>
            <TypeFilter
              value={typeFilter}
              onChange={setTypeFilter}
              isConnected={isConnected}
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-600 font-mono">
              {filteredActivities.length} transactions
            </span>
            <button
              onClick={refresh}
              disabled={isLoading}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors rounded hover:bg-zinc-800/50"
              title="Refresh"
            >
              <svg
                className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Table container */}
        <div className="border border-zinc-800/80 rounded-lg overflow-hidden bg-zinc-900/30">
          {error ? (
            <div className="p-12 text-center">
              <p className="text-red-400/80 text-sm mb-4 font-mono">{error}</p>
              <button
                onClick={refresh}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          ) : isLoading && filteredActivities.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center gap-3">
              <LoadingSpinner size="md" />
              <p className="text-xs text-zinc-500 font-mono">
Fetching...
              </p>
            </div>
          ) : (
            <>
              <ActivityTable
                activities={filteredActivities}
                highlightAddress={publicKey || undefined}
                konamiActive={konamiActive}
              />

              {hasMore && typeFilter !== 'mine' && (
                <div className="p-4 border-t border-zinc-800/50 text-center">
                  <button
                    onClick={loadMore}
                    disabled={isLoading}
                    className="text-xs text-zinc-400 hover:text-zinc-200 font-mono transition-colors"
                  >
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <LoadingSpinner size="sm" />
                        <span>loading...</span>
                      </span>
                    ) : (
                      'Load more ↓'
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Empty state */}
        {!isLoading && !error && filteredActivities.length === 0 && (
          <div className="text-center py-16">
            <p className="text-zinc-600 text-sm font-mono">
              {typeFilter === 'mine' ? 'No transactions found for your wallet' : 'No activity found'}
            </p>
          </div>
        )}
      </div>

      {/* Transfer Modal */}
      <TransferModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        onTransferComplete={(transferData) => {
          addOptimisticActivity(transferData);
        }}
      />
    </div>
  );
}
