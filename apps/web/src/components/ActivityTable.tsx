'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CTActivityResponse } from '@ct-explorer/shared';
import {
  shortenAddress,
  shortenSignature,
  formatAmount,
  getTypeBadgeClass,
  getTypeDisplayName,
} from '@/lib/format';

interface ActivityTableProps {
  activities: CTActivityResponse[];
  showMint?: boolean;
  highlightAddress?: string;
  decryptedAmounts?: Map<number, string>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className="ml-1.5 p-0.5 text-zinc-600 hover:text-zinc-400 transition-colors"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

export function ActivityTable({
  activities,
  showMint = true,
  highlightAddress,
  decryptedAmounts,
}: ActivityTableProps) {
  if (activities.length === 0) {
    return (
      <div className="text-center py-12 text-zinc-600">
        <p className="text-sm font-mono">No activity found</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="activity-table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Type</th>
            <th>Signature</th>
            {showMint && <th>Mint</th>}
            <th>From</th>
            <th>To</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {activities.map((activity) => {
            const decryptedAmount = decryptedAmounts?.get(activity.id);
            const isHighlightedSource =
              highlightAddress &&
              (activity.sourceOwner === highlightAddress ||
                activity.sourceTokenAccount === highlightAddress);
            const isHighlightedDest =
              highlightAddress &&
              (activity.destOwner === highlightAddress ||
                activity.destTokenAccount === highlightAddress);

            return (
              <tr key={activity.id}>
                <td className="text-zinc-500 text-xs whitespace-nowrap font-mono">
                  {activity.slot.toLocaleString()}
                </td>
                <td>
                  <span className={`badge ${getTypeBadgeClass(activity.instructionType)}`}>
                    {getTypeDisplayName(activity.instructionType)}
                  </span>
                </td>
                <td>
                  <div className="flex items-center">
                    <Link
                      href={`/tx/${activity.signature}`}
                      className="font-mono text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      {shortenSignature(activity.signature, 12)}
                    </Link>
                    <CopyButton text={activity.signature} />
                  </div>
                </td>
                {showMint && (
                  <td>
                    {activity.mint ? (
                      <a
                        href={`https://solscan.io/token/${activity.mint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        {shortenAddress(activity.mint, 4)}
                      </a>
                    ) : (
                      <span className="text-zinc-700">—</span>
                    )}
                  </td>
                )}
                <td>
                  {activity.sourceOwner ? (
                    <a
                      href={`https://solscan.io/account/${activity.sourceOwner}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`font-mono text-xs ${
                        isHighlightedSource
                          ? 'text-amber-400'
                          : 'text-zinc-500 hover:text-zinc-300'
                      } transition-colors`}
                    >
                      {shortenAddress(activity.sourceOwner, 4)}
                    </a>
                  ) : (
                    <span className="text-zinc-700">—</span>
                  )}
                </td>
                <td>
                  {activity.destOwner ? (
                    <a
                      href={`https://solscan.io/account/${activity.destOwner}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`font-mono text-xs ${
                        isHighlightedDest
                          ? 'text-amber-400'
                          : 'text-zinc-500 hover:text-zinc-300'
                      } transition-colors`}
                    >
                      {shortenAddress(activity.destOwner, 4)}
                    </a>
                  ) : (
                    <span className="text-zinc-700">—</span>
                  )}
                </td>
                <td className="text-right">
                  {decryptedAmount ? (
                    <span className="text-emerald-400 font-mono text-xs">{formatAmount(decryptedAmount)}</span>
                  ) : activity.amount === 'confidential' ? (
                    <span className="text-zinc-600 text-xs italic">encrypted</span>
                  ) : (
                    <span className="text-zinc-300 font-mono text-xs">{formatAmount(activity.amount)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
