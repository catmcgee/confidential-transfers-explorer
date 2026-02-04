'use client';

import { useState, use } from 'react';
import Link from 'next/link';
import { ActivityTable } from '@/components/ActivityTable';
import { TypeFilter } from '@/components/TypeFilter';
import { UnlockPanel } from '@/components/UnlockPanel';
import { LoadingSpinner, LoadingPage } from '@/components/LoadingSpinner';
import { useAddressActivity } from '@/hooks/useAddressActivity';
import { useAuth } from '@/hooks/useAuth';
import { shortenAddress } from '@/lib/format';

interface AddressPageProps {
  params: Promise<{ pubkey: string }>;
}

export default function AddressPage({ params }: AddressPageProps) {
  const { pubkey } = use(params);
  const [typeFilter, setTypeFilter] = useState('all');
  const { isAuthenticated, authenticatedPublicKey } = useAuth();

  const { activities, isLoading, error, hasMore, loadMore, refresh } = useAddressActivity({
    address: pubkey,
    type: typeFilter,
    limit: 50,
  });

  const isOwnAddress = isAuthenticated && authenticatedPublicKey === pubkey;

  if (isLoading && activities.length === 0) {
    return <LoadingPage />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h1 className="text-xl font-semibold text-white">Address</h1>
              {isOwnAddress && (
                <span className="px-2 py-0.5 bg-green-900/50 text-green-400 text-xs rounded">
                  Your Address
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <code className="text-gray-300 font-mono text-sm break-all">{pubkey}</code>
              <button
                onClick={() => navigator.clipboard.writeText(pubkey)}
                className="p-1 text-gray-500 hover:text-gray-300"
                title="Copy address"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href={`https://explorer.solana.com/address/${pubkey}?cluster=custom&customUrl=https%3A%2F%2Fzk-edge.surfnet.dev`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline text-sm"
            >
              View on Solana Explorer
            </Link>
          </div>
        </div>
      </div>

      {/* Unlock panel for own address */}
      {isOwnAddress && <UnlockPanel />}

      {/* Activity */}
      <div className="card">
        <div className="p-4 border-b border-gray-800">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <h2 className="text-lg font-semibold text-white">Confidential Activity</h2>
            <div className="flex items-center gap-4">
              <TypeFilter value={typeFilter} onChange={setTypeFilter} />
              <button
                onClick={refresh}
                disabled={isLoading}
                className="p-2 text-gray-400 hover:text-white transition-colors"
                title="Refresh"
              >
                <svg
                  className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="p-8 text-center">
            <p className="text-red-400 mb-4">{error}</p>
            <button onClick={refresh} className="btn btn-secondary">
              Try Again
            </button>
          </div>
        ) : activities.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-gray-400">No confidential activity found for this address.</p>
          </div>
        ) : (
          <>
            <ActivityTable activities={activities} highlightAddress={pubkey} />

            {hasMore && (
              <div className="p-4 border-t border-gray-800 text-center">
                <button
                  onClick={loadMore}
                  disabled={isLoading}
                  className="btn btn-secondary"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <LoadingSpinner size="sm" />
                      Loading...
                    </span>
                  ) : (
                    'Load More'
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
