'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import type { TransactionDetailResponse, CTActivityResponse } from '@ct-explorer/shared';
import { LoadingPage } from '@/components/LoadingSpinner';
import {
  formatAmount,
  getTypeBadgeClass,
  getTypeDisplayName,
} from '@/lib/format';

interface TxPageProps {
  params: Promise<{ sig: string }>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 text-zinc-600 hover:text-zinc-400 transition-colors"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

export default function TxPage({ params }: TxPageProps) {
  const { sig } = use(params);
  const [tx, setTx] = useState<TransactionDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTx = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/tx/${sig}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch transaction');
        }

        setTx(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load transaction');
      } finally {
        setIsLoading(false);
      }
    };

    fetchTx();
  }, [sig]);

  if (isLoading) {
    return <LoadingPage />;
  }

  if (error || !tx) {
    return (
      <div className="border border-zinc-800 rounded-lg p-8 text-center">
        <h2 className="text-base font-medium text-zinc-100 mb-2">Transaction Not Found</h2>
        <p className="text-xs text-zinc-500 mb-4 font-mono">{error || 'Not in index'}</p>
        <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="border border-zinc-800 rounded-lg p-5">
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h1 className="text-sm font-medium text-zinc-100">Transaction</h1>
              <a
                href={`https://solscan.io/tx/${tx.signature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                Solscan ↗
              </a>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xs text-zinc-400 font-mono break-all">{tx.signature}</code>
              <CopyButton text={tx.signature} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-zinc-800/50">
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Slot</div>
              <div className="text-xs text-zinc-300 font-mono">{tx.slot.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1">Instructions</div>
              <div className="text-xs text-zinc-300">{tx.activities.length}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Confidential Transfer Instructions */}
      <div className="border border-zinc-800 rounded-lg">
        <div className="px-4 py-3 border-b border-zinc-800/50">
          <h2 className="text-xs font-medium text-zinc-300">Confidential Transfer Instructions</h2>
        </div>

        <div className="divide-y divide-zinc-800/30">
          {tx.activities.map((activity, index) => (
            <ActivityDetail key={activity.id} activity={activity} index={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityDetail({ activity, index }: { activity: CTActivityResponse; index: number }) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[10px] text-zinc-600 font-mono">#{index + 1}</span>
        <span className={`badge ${getTypeBadgeClass(activity.instructionType)}`}>
          {getTypeDisplayName(activity.instructionType)}
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* Source */}
        {(activity.sourceOwner || activity.sourceTokenAccount) && (
          <div className="bg-zinc-900/30 rounded p-3">
            <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">From</div>
            {activity.sourceOwner && (
              <div className="mb-1.5">
                <span className="text-[10px] text-zinc-600">Owner</span>
                <div className="flex items-center gap-1.5">
                  <a
                    href={`https://solscan.io/account/${activity.sourceOwner}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-zinc-400 hover:text-zinc-200 break-all transition-colors"
                  >
                    {activity.sourceOwner}
                  </a>
                  <CopyButton text={activity.sourceOwner} />
                </div>
              </div>
            )}
            {activity.sourceTokenAccount && (
              <div>
                <span className="text-[10px] text-zinc-600">Token Account</span>
                <div className="flex items-center gap-1.5">
                  <a
                    href={`https://solscan.io/account/${activity.sourceTokenAccount}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-zinc-500 hover:text-zinc-300 break-all transition-colors"
                  >
                    {activity.sourceTokenAccount}
                  </a>
                  <CopyButton text={activity.sourceTokenAccount} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Destination */}
        {(activity.destOwner || activity.destTokenAccount) && (
          <div className="bg-zinc-900/30 rounded p-3">
            <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-2">To</div>
            {activity.destOwner && (
              <div className="mb-1.5">
                <span className="text-[10px] text-zinc-600">Owner</span>
                <div className="flex items-center gap-1.5">
                  <a
                    href={`https://solscan.io/account/${activity.destOwner}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-zinc-400 hover:text-zinc-200 break-all transition-colors"
                  >
                    {activity.destOwner}
                  </a>
                  <CopyButton text={activity.destOwner} />
                </div>
              </div>
            )}
            {activity.destTokenAccount && (
              <div>
                <span className="text-[10px] text-zinc-600">Token Account</span>
                <div className="flex items-center gap-1.5">
                  <a
                    href={`https://solscan.io/account/${activity.destTokenAccount}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-zinc-500 hover:text-zinc-300 break-all transition-colors"
                  >
                    {activity.destTokenAccount}
                  </a>
                  <CopyButton text={activity.destTokenAccount} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Amount & Mint */}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        <div>
          <span className="text-zinc-600">Amount: </span>
          {activity.amount === 'confidential' ? (
            <span className="text-zinc-600 italic">encrypted</span>
          ) : (
            <span className="text-zinc-300 font-mono">{formatAmount(activity.amount)}</span>
          )}
        </div>

        {activity.mint && (
          <div>
            <span className="text-zinc-600">Mint: </span>
            <a
              href={`https://solscan.io/token/${activity.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {activity.mint}
            </a>
          </div>
        )}
      </div>

      {/* Ciphertext info */}
      {(activity.ciphertextLo || activity.ciphertextHi) && (
        <div className="mt-3 p-2 bg-zinc-900/50 rounded border border-zinc-800/30">
          <div className="text-[10px] text-zinc-600 mb-1">Encrypted Amount</div>
          {activity.ciphertextLo && (
            <div className="text-[10px] font-mono text-zinc-700 truncate">Lo: {activity.ciphertextLo}</div>
          )}
          {activity.ciphertextHi && (
            <div className="text-[10px] font-mono text-zinc-700 truncate">Hi: {activity.ciphertextHi}</div>
          )}
        </div>
      )}
    </div>
  );
}
