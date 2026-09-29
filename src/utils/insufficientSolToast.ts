import toast from 'react-hot-toast';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export type SolAction = 'create' | 'copy' | 'add_liquidity' | 'remove_liquidity' | 'boost';

const ACTION_LABEL: Record<SolAction, string> = {
  create: 'Creating this coin',
  copy: 'Copying this coin',
  add_liquidity: 'Adding liquidity',
  remove_liquidity: 'Removing liquidity',
  boost: 'Boosting on Dexscreener',
};

export type SolRequirement = {
  /** Platform fee charged by the website (treasury transfer). */
  websiteFeeLamports: number;
  /** Signature + priority fees and rent for accounts the tx opens. */
  networkFeeLamports: number;
  /** SOL the user deposits as part of the action (e.g. SOL side of liquidity). */
  depositLamports?: number;
};

/** Round up to 4 decimals so we never under-state what the user needs. */
function fmtSol(lamports: number): string {
  const sol = Math.max(0, lamports) / LAMPORTS_PER_SOL;
  return (Math.ceil(sol * 10_000) / 10_000).toFixed(4);
}

export function totalRequiredLamports(req: SolRequirement): number {
  return Math.max(0, req.websiteFeeLamports) + Math.max(0, req.networkFeeLamports) + Math.max(0, req.depositLamports ?? 0);
}

export function toastInsufficientSolBreakdown(action: SolAction, req: SolRequirement, balanceLamports: number): void {
  const total = totalRequiredLamports(req);

  toast.error(
    `Not enough SOL in your wallet.\n` +
      `${ACTION_LABEL[action]} needs ${fmtSol(total)} SOL.\n` +
      `You have ${fmtSol(balanceLamports)} SOL. Add at least ${fmtSol(total - balanceLamports)} SOL and try again.`,
    {
      id: `insufficient-sol-${action}`,
      duration: 9_000,
      style: { maxWidth: 520, whiteSpace: 'pre-wrap' },
    },
  );
}

/** Returns true when the wallet can cover the action; otherwise shows the breakdown toast and returns false. */
export function hasEnoughSolOrToast(action: SolAction, req: SolRequirement, balanceLamports: number): boolean {
  if (balanceLamports >= totalRequiredLamports(req)) return true;
  toastInsufficientSolBreakdown(action, req, balanceLamports);
  return false;
}

/** Thrown by services before the wallet popup when the balance can't cover the action. */
export class InsufficientSolError extends Error {
  readonly action: SolAction;
  readonly requirement: SolRequirement;
  readonly balanceLamports: number;

  constructor(action: SolAction, requirement: SolRequirement, balanceLamports: number) {
    super('Insufficient SOL');
    this.name = 'InsufficientSolError';
    this.action = action;
    this.requirement = requirement;
    this.balanceLamports = balanceLamports;
  }
}

export function isInsufficientSolError(e: unknown): e is InsufficientSolError {
  return e instanceof InsufficientSolError;
}

export function toastFromInsufficientSolError(e: InsufficientSolError): void {
  toastInsufficientSolBreakdown(e.action, e.requirement, e.balanceLamports);
}
