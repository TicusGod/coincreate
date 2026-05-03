function str(e: unknown): string {
  if (e instanceof Error) return `${e.name} ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function parseSolanaError(error: unknown): {
  title: string;
  message: string;
  isUserRejection: boolean;
  shouldRetry: boolean;
  technicalDetails?: string;
} {
  const s = str(error);
  const lower = s.toLowerCase();

  if (
    lower.includes('walletsigntransactionerror') ||
    lower.includes('user rejected') ||
    lower.includes('user denied') ||
    lower.includes('cancelled')
  ) {
    return {
      title: 'Cancelled',
      message: 'Transaction cancelled',
      isUserRejection: true,
      shouldRetry: false,
    };
  }

  if (lower.includes('0x1') || lower.includes('insufficient lamports') || lower.includes('insufficient funds')) {
    return {
      title: 'Insufficient SOL',
      message: 'Not enough SOL to cover the transaction and fees',
      isUserRejection: false,
      shouldRetry: false,
    };
  }

  if (lower.includes('blockhashnotfound') || lower.includes('blockhash not found')) {
    return {
      title: 'Expired',
      message: 'Transaction expired before confirmation. Please try again',
      isUserRejection: false,
      shouldRetry: true,
    };
  }

  if (lower.includes('0x1771') || lower.includes('slippage')) {
    return {
      title: 'Slippage',
      message: 'Price moved beyond your slippage tolerance',
      isUserRejection: false,
      shouldRetry: true,
    };
  }

  if (lower.includes('account does not exist') || lower.includes('could not find account')) {
    return {
      title: 'Account',
      message: 'Token account not found. The token may not exist on this network',
      isUserRejection: false,
      shouldRetry: false,
    };
  }

  if (lower.includes('metadataaccountalreadyexists') || lower.includes('already in use')) {
    return {
      title: 'Metadata',
      message: 'A token with this mint already has metadata',
      isUserRejection: false,
      shouldRetry: false,
    };
  }

  if (
    lower.includes('pinata') ||
    lower.includes('ipfs') ||
    lower.includes('upload') && lower.includes('fail')
  ) {
    return {
      title: 'Upload',
      message: 'Failed to upload to IPFS. Check your network connection and try again',
      isUserRejection: false,
      shouldRetry: true,
    };
  }

  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit')) {
    return {
      title: 'Network',
      message: 'Network is congested. Please try again in a moment',
      isUserRejection: false,
      shouldRetry: true,
    };
  }

  if (lower.includes('simulation failed')) {
    const logsMatch = s.match(/Program log: ([^\n]+)/g);
    const hint = logsMatch?.[logsMatch.length - 1]?.replace('Program log: ', '') ?? '';
    if (hint.toLowerCase().includes('slippage')) {
      return {
        title: 'Slippage',
        message: 'Price moved beyond slippage tolerance. Increase slippage and retry',
        isUserRejection: false,
        shouldRetry: true,
        technicalDetails: hint,
      };
    }
    return {
      title: 'Simulation',
      message: hint || 'Transaction simulation failed',
      isUserRejection: false,
      shouldRetry: true,
      technicalDetails: s.slice(0, 800),
    };
  }

  return {
    title: 'Error',
    message: 'Something went wrong. Please try again',
    isUserRejection: false,
    shouldRetry: false,
    technicalDetails: s.slice(0, 1200),
  };
}
