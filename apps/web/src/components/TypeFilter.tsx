'use client';

interface TypeFilterProps {
  value: string;
  onChange: (value: string) => void;
  showMineFilter?: boolean;
  isConnected?: boolean;
}

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'Transfer', label: 'Transfer' },
  { value: 'Deposit', label: 'Deposit' },
  { value: 'Withdraw', label: 'Withdraw' },
  { value: 'ApplyPendingBalance', label: 'Apply' },
  { value: 'ConfigureAccount', label: 'Configure' },
  { value: 'InitializeMint', label: 'Init Mint' },
];

export function TypeFilter({ value, onChange, showMineFilter = true, isConnected = false }: TypeFilterProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-all duration-150 ${
            value === option.value
              ? 'bg-zinc-100 text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
          }`}
        >
          {option.label}
        </button>
      ))}
      {showMineFilter && (
        <button
          onClick={() => onChange('mine')}
          disabled={!isConnected}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-all duration-150 ${
            value === 'mine'
              ? 'bg-emerald-500 text-white'
              : isConnected
                ? 'text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30'
                : 'text-zinc-600 cursor-not-allowed'
          }`}
          title={!isConnected ? 'Connect wallet to filter your transactions' : 'Show my transactions'}
        >
          Mine
        </button>
      )}
    </div>
  );
}
