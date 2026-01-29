'use client';

import { useState } from 'react';
import { ActivityTable } from '@/components/ActivityTable';
import { TypeFilter } from '@/components/TypeFilter';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { TransferModal } from '@/components/TransferModal';
import { useFeed } from '@/hooks/useFeed';

export default function HomePage() {
  const [typeFilter, setTypeFilter] = useState('all');
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const { activities, isLoading, error, hasMore, loadMore, refresh } = useFeed({
    type: typeFilter,
    limit: 50,
    autoRefresh: true,
    refreshInterval: 15000,
  });

  return (
    <div className="min-h-[calc(100vh-80px)]">
      {/* Compact header section */}
      <div className="flex items-center justify-between py-6 border-b border-zinc-800/50">
        <div>
          <h1 className="text-lg font-medium text-zinc-100 tracking-tight">
            Confidential Transfers
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
            <TypeFilter value={typeFilter} onChange={setTypeFilter} />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-600 font-mono">
              {activities.length} transactions
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
          ) : (
            <>
              <ActivityTable activities={activities} />

              {hasMore && (
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
        {!isLoading && !error && activities.length === 0 && (
          <div className="text-center py-16">
            <p className="text-zinc-600 text-sm font-mono">No activity found</p>
          </div>
        )}
      </div>

      {/* Transfer Modal */}
      <TransferModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
      />
    </div>
  );
}
