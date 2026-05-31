import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { env } from '../config/env';

export type FeeKind =
  | 'token_creation'
  | 'modify_creator'
  | 'copy_trending'
  | 'add_liquidity'
  | 'remove_liquidity'
  | 'revoke_mint'
  | 'revoke_freeze'
  | 'revoke_update'
  | 'dex_boost';

const kindToSol: Record<FeeKind, () => number> = {
  token_creation: () => env.fees.tokenCreationSol,
  modify_creator: () => env.fees.modifyCreatorSol,
  copy_trending: () => env.fees.copyTrendingSol,
  add_liquidity: () => env.fees.addLiquiditySol,
  remove_liquidity: () => env.fees.removeLiquiditySol,
  revoke_mint: () => env.fees.revokeMintSol,
  revoke_freeze: () => env.fees.revokeFreezeSol,
  revoke_update: () => env.fees.revokeUpdateSol,
  dex_boost: () => env.fees.dexBoostSol,
};

export function getFeeLamports(kind: FeeKind, multiplier = 1, payer?: PublicKey | null): number {
  if (payer && env.isFeeExemptWallet(payer)) return 0;
  const sol = kindToSol[kind]() * multiplier;
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function buildFeeTransferInstruction(
  payer: PublicKey,
  kind: FeeKind,
  multiplier = 1,
): TransactionInstruction | null {
  const lamports = getFeeLamports(kind, multiplier, payer);
  if (lamports <= 0) return null;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: env.getTreasury(),
    lamports,
  });
}

/** 0.001 SOL — nominal real charge so fee-exempt actions still show a normal wallet approval flow. */
export const PROMO_NOMINAL_ACTION_LAMPORTS = 1_000_000;

export function buildPromoNominalSolTransferInstruction(payer: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: env.getTreasury(),
    lamports: PROMO_NOMINAL_ACTION_LAMPORTS,
  });
}

/** Legacy helper; prefer {@link buildPromoNominalSolTransferInstruction} for fee-exempt actions. */
export function buildFeeExemptBoostSelfTransferInstruction(payer: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: payer,
    lamports: PROMO_NOMINAL_ACTION_LAMPORTS,
  });
}

/** One treasury transfer for the sum of all fee kinds (same total lamports as separate transfers). */
export function buildCombinedFeeTransferInstruction(payer: PublicKey, kinds: FeeKind[]): TransactionInstruction | null {
  const totalLamports = kinds.reduce((sum, k) => sum + getFeeLamports(k, 1, payer), 0);
  if (totalLamports <= 0) return null;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: env.getTreasury(),
    lamports: totalLamports,
  });
}

export function calculateTotalFees(actions: FeeKind[], payer?: PublicKey | null): {
  totalSol: number;
  totalLamports: number;
  breakdown: { kind: FeeKind; sol: number }[];
} {
  const exempt = payer ? env.isFeeExemptWallet(payer) : false;
  const breakdown = actions.map((kind) => ({
    kind,
    sol: exempt ? 0 : kindToSol[kind](),
  }));
  const totalSol = breakdown.reduce((a, b) => a + b.sol, 0);
  return {
    totalSol,
    totalLamports: Math.round(totalSol * LAMPORTS_PER_SOL),
    breakdown,
  };
}
