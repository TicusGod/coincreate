import bs58 from 'bs58';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/**
 * Ask the wallet to approve a harmless preview transaction so whitelist flows
 * still show the normal Phantom approval popup without sending anything on-chain.
 */
export async function requestPreviewWalletApproval(params: {
  connection: Connection;
  wallet: WalletContextState;
  payer: PublicKey;
  memo: string;
}): Promise<string> {
  const { blockhash } = await params.connection.getLatestBlockhash('confirmed');
  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: params.payer, isSigner: true, isWritable: false }],
    data: new TextEncoder().encode(params.memo),
  });

  const msg = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: blockhash,
    instructions: [memoIx],
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  const signed = await params.wallet.signTransaction!(vtx);
  const sig = signed.signatures[0];
  return sig ? bs58.encode(sig) : `preview-${params.payer.toBase58()}`;
}
