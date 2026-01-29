'use client';

import Link from 'next/link';
import { SearchBar } from './SearchBar';
import { WalletButton } from './WalletButton';

export function Header() {
  const networkName = process.env['NEXT_PUBLIC_NETWORK_NAME'] || 'zk-edge.surfnet.dev';

  return (
    <header className="border-b border-zinc-800/50 bg-zinc-950/90 backdrop-blur-sm sticky top-0 z-50">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            {/* Lock/Shield icon for confidential transfers */}
            <div className="w-6 h-6 flex items-center justify-center">
              <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <span className="text-sm text-zinc-300 hidden sm:inline group-hover:text-zinc-100 transition-colors">
              Conf Transfers
            </span>
          </Link>

          {/* Network badge */}
          <div className="hidden md:flex items-center gap-1.5 px-2 py-1 text-[10px] text-zinc-600 font-mono">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
            <span>{networkName}</span>
          </div>

          {/* Search */}
          <div className="flex-1 max-w-sm">
            <SearchBar />
          </div>

          {/* Wallet */}
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
