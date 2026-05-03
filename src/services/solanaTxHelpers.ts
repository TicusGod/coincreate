import type { Connection, TransactionSignature } from '@solana/web3.js';

function isSimulationPreflightFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /simulation failed/i.test(msg);
}

/**
 * Some RPCs return flaky preflight simulation for large txs (metadata + mint + fees)
 * even when the same serialized transaction lands successfully. Retry once without preflight.
 */
export async function sendRawTransactionWithSimulationFallback(
  connection: Connection,
  rawTx: Uint8Array,
): Promise<TransactionSignature> {
  try {
    return await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e) {
    if (!isSimulationPreflightFailure(e)) throw e;
    return await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });
  }
}

/**
 * If confirmTransaction throws (WS/RPC glitch) while the signature already landed, poll status instead of failing the flow.
 */
export async function confirmTransactionResilient(
  connection: Connection,
  strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
  commitment: 'confirmed' | 'finalized' = 'confirmed',
): Promise<void> {
  try {
    await connection.confirmTransaction(strategy, commitment);
    return;
  } catch {
    /* fall through to status polling */
  }

  const sig = strategy.signature;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st?.err != null) {
      throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    }
    const rawStatus = st?.confirmationStatus as string | undefined;
    const ok =
      rawStatus === 'finalized' ||
      (commitment === 'confirmed' && (rawStatus === 'confirmed' || rawStatus === 'finalized'));
    if (ok) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error('Confirmation timed out');
}
