'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

export function SearchBar() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = query.trim();

      if (!trimmed) return;

      setIsSearching(true);

      // Determine if it's a signature or address based on length
      if (trimmed.length > 50) {
        router.push(`/tx/${trimmed}`);
      } else {
        router.push(`/address/${trimmed}`);
      }

      setIsSearching(false);
    },
    [query, router]
  );

  return (
    <form onSubmit={handleSearch} className="w-full">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search address or signature..."
          className="w-full px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded text-xs text-zinc-300 placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-700 transition-colors"
          disabled={isSearching}
        />
        <button
          type="submit"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors"
          disabled={isSearching}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </button>
      </div>
    </form>
  );
}
