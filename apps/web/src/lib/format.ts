/**
 * Shorten an address for display (shows start...end)
 */
export function shortenAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Shorten a signature for display (shows only start...)
 */
export function shortenSignature(signature: string, chars = 12): string {
  if (signature.length <= chars + 3) return signature;
  return `${signature.slice(0, chars)}...`;
}

/**
 * Format a Unix timestamp
 */
export function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp * 1000);
  return date.toLocaleString();
}

/**
 * Format a relative time
 */
export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return '—';

  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Format an amount with decimals
 */
export function formatAmount(amount: string | null, decimals: number = 9): string {
  if (!amount) return '0';

  const num = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = num / divisor;
  const fraction = num % divisor;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

/**
 * Get badge class for instruction type
 */
export function getTypeBadgeClass(type: string): string {
  switch (type) {
    case 'Transfer':
    case 'TransferWithSplitProofs':
    case 'TransferWithFee':
      return 'badge-transfer';
    case 'Deposit':
      return 'badge-deposit';
    case 'Withdraw':
      return 'badge-withdraw';
    case 'ApplyPendingBalance':
      return 'badge-apply';
    case 'ConfigureAccount':
    case 'ApproveAccount':
    case 'EmptyAccount':
    case 'EnableConfidentialCredits':
    case 'DisableConfidentialCredits':
    case 'EnableNonConfidentialCredits':
    case 'DisableNonConfidentialCredits':
      return 'badge-configure';
    case 'InitializeMint':
    case 'UpdateMint':
      return 'badge-init';
    default:
      return 'badge-unknown';
  }
}

/**
 * Get display name for instruction type
 */
export function getTypeDisplayName(type: string): string {
  switch (type) {
    case 'TransferWithSplitProofs':
      return 'Transfer';
    case 'TransferWithFee':
      return 'Transfer+Fee';
    case 'ApplyPendingBalance':
      return 'Apply';
    case 'ConfigureAccount':
      return 'Configure';
    case 'ApproveAccount':
      return 'Approve';
    case 'EmptyAccount':
      return 'Empty';
    case 'EnableConfidentialCredits':
      return 'Enable CT';
    case 'DisableConfidentialCredits':
      return 'Disable CT';
    case 'EnableNonConfidentialCredits':
      return 'Enable Non-CT';
    case 'DisableNonConfidentialCredits':
      return 'Disable Non-CT';
    case 'InitializeMint':
      return 'Init Mint';
    case 'UpdateMint':
      return 'Update Mint';
    default:
      return type;
  }
}
