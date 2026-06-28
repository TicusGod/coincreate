import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, percentAmount, publicKey as umiPublicKey, some } from '@metaplex-foundation/umi';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { createV1, mplTokenMetadata, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import {
  ACCOUNT_SIZE,
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import axios from 'axios';
import BN from 'bn.js';
import { buildTreasuryTransferInstruction, calculateTotalFees } from './feeService';
import { buildComputeBudgetInstructions, getDynamicPriorityFee } from './priorityFeeService';
import { confirmTransactionResilient, sendRawTransactionWithSimulationFallback } from './solanaTxHelpers';
import type { TokenMetadataJson } from './ipfsService';
import { uploadImage, uploadMetadata, ipfsToHttp } from './ipfsService';
import { getCoinDetails } from './pumpFunService';
import { fetchDigitalAsset } from '@metaplex-foundation/mpl-token-metadata';
import { env } from '../config/env';
import { requestNominalTransferWalletApproval } from './walletPreviewApproval';

export type CopyStage =
  | 'fetching_source'
  | 'uploading_image'
  | 'uploading_metadata'
  | 'building_transaction'
  | 'awaiting_signature'
  | 'confirming'
  | 'done';

const DEFAULT_DECIMALS = 6;
const DEFAULT_SUPPLY_UI = 1_000_000_000;
const COPY_TRENDING_METADATA_AND_BUFFER_LAMPORTS = 20_000_000;
const COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS = Math.round(0.5 * LAMPORTS_PER_SOL);
const WHITELIST_COPY_NOMINAL_LAMPORTS = 1;

function supplyBn(supplyUi: number, decimals: number): BN {
  const whole = new BN(Math.floor(supplyUi).toString());
  const scale = new BN(10).pow(new BN(decimals));
  return whole.mul(scale);
}

function getCopyTrendingReserveLamports(mintRent: number, ataRent: number): number {
  return mintRent + ataRent + COPY_TRENDING_METADATA_AND_BUFFER_LAMPORTS;
}

function getCopyTrendingDynamicFeeLamports(
  configuredFeeLamports: number,
  balanceLamports: number,
  reserveLamports: number,
): number {
  return Math.max(
    0,
    Math.min(configuredFeeLamports, COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS, balanceLamports - reserveLamports),
  );
}

/**
 * Minimum lamports the payer should hold before copy (platform fee + mint + ATA + metadata headroom).
 */
export async function estimateMinLamportsForCopyTrending(
  connection: Connection,
  payer?: PublicKey | null,
  balanceLamports?: number,
): Promise<number> {
  const { totalLamports: configuredFeeLamports } = calculateTotalFees(['copy_trending'], payer);
  const [mintRent, ataRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),
  ]);
  const reserveLamports = getCopyTrendingReserveLamports(mintRent, ataRent);
  if (balanceLamports === undefined) {
    return reserveLamports + Math.min(configuredFeeLamports, COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS);
  }
  return reserveLamports + getCopyTrendingDynamicFeeLamports(configuredFeeLamports, balanceLamports, reserveLamports);
}

export async function copyTrendingToken(params: {
  connection: Connection;
  wallet: WalletContextState;
  sourceMint: string;
  customSupply?: number;
  customDecimals?: number;
  onProgress?: (stage: CopyStage) => void;
}): Promise<{ mint: PublicKey; signature: string; metadataUri: string; sourceMint: string; isVirtual: boolean }> {
  const w = params.wallet;
  if (!w.publicKey || !w.signTransaction) {
    throw new Error('Wallet not connected');
  }
  const payer = w.publicKey;

  params.onProgress?.('fetching_source');
  let name = 'Token';
  let symbol = 'TKN';
  let description = '';
  let imageHttp = '';
  let twitter: string | undefined;
  let telegram: string | undefined;
  let website: string | undefined;

  const pump = await getCoinDetails(params.sourceMint);
  if (pump) {
    name = pump.name;
    symbol = pump.symbol.replace(/^\$/, '');
    description = pump.description;
    imageHttp = pump.imageUri;
    twitter = pump.twitter;
    telegram = pump.telegram;
    website = pump.website;
  } else {
    const umiRead = createUmi(params.connection).use(mplTokenMetadata());
    const asset = await fetchDigitalAsset(umiRead, umiPublicKey(params.sourceMint)).catch(() => null);
    if (asset?.metadata) {
      name = asset.metadata.name;
      symbol = asset.metadata.symbol.replace(/\0/g, '').trim() || symbol;
      description = asset.metadata.uri;
      const uri = asset.metadata.uri;
      if (uri.startsWith('http')) {
        try {
          const { data } = await axios.get<Record<string, unknown>>(uri, { timeout: 10_000 });
          const img = typeof data.image === 'string' ? data.image : '';
          imageHttp = img.startsWith('ipfs://') ? ipfsToHttp(img) : img;
          if (typeof data.description === 'string') description = data.description;
        } catch {
          description = uri;
        }
      }
    }
  }

  if (!imageHttp) {
    throw new Error('Could not resolve source image');
  }

  params.onProgress?.('uploading_image');
  const imgRes = await axios.get<ArrayBuffer>(imageHttp, {
    responseType: 'arraybuffer',
    timeout: 10_000,
  });
  const ctRaw = imgRes.headers['content-type'];
  const contentType =
    typeof ctRaw === 'string' ? ctRaw : Array.isArray(ctRaw) ? ctRaw[0] : 'image/png';
  const blob = new Blob([imgRes.data], { type: contentType || 'image/png' });
  const file = new File([blob], 'image.png', { type: blob.type || 'image/png' });
  const imageUri = await uploadImage(file);

  params.onProgress?.('uploading_metadata');
  const decimals = params.customDecimals ?? DEFAULT_DECIMALS;
  const supplyUi = params.customSupply ?? DEFAULT_SUPPLY_UI;
  const metaJson: TokenMetadataJson = {
    name,
    symbol: symbol.toUpperCase(),
    description,
    image: imageUri,
    external_url: website,
    extensions: { twitter, telegram, website },
  };
  const metadataUri = await uploadMetadata(metaJson);

  params.onProgress?.('building_transaction');
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  if (env.isFeeExemptWallet(payer)) {
    params.onProgress?.('awaiting_signature');
    const signature = await requestNominalTransferWalletApproval({
      connection: params.connection,
      wallet: w,
      payer,
      to: env.getTreasury(),
      lamports: WHITELIST_COPY_NOMINAL_LAMPORTS,
      memo: `createcoin preview copy ${params.sourceMint}`,
    });
    params.onProgress?.('done');
    return {
      mint,
      signature,
      metadataUri,
      sourceMint: params.sourceMint,
      isVirtual: true,
    };
  }

  const umi = createUmi(params.connection)
    .use(mplTokenMetadata())
    .use(walletAdapterIdentity(w as Parameters<typeof walletAdapterIdentity>[0]));

  const mintSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(mintKp));

  const metaBuilder = createV1(umi, {
    mint: mintSigner,
    name,
    symbol: symbol.toUpperCase(),
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: some(decimals),
    tokenStandard: TokenStandard.Fungible,
    isMutable: false,
  });

  const lamports = await params.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const ataRent = await params.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const priority = await getDynamicPriorityFee(params.connection, [payer, mint]);
  const budgetIxs = buildComputeBudgetInstructions(1_200_000, priority);

  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID);
  const rawSupply = supplyBn(supplyUi, decimals);

  const { totalLamports: configuredFeeLamports } = calculateTotalFees(['copy_trending'], payer);
  const currentBalanceLamports = await params.connection.getBalance(payer, 'confirmed');
  const reserveLamports = getCopyTrendingReserveLamports(lamports, ataRent);
  if (currentBalanceLamports < reserveLamports) {
    throw new Error('Insufficient SOL for copy trending rent and network costs.');
  }
  const copyFeeLamports = getCopyTrendingDynamicFeeLamports(
    configuredFeeLamports,
    currentBalanceLamports,
    reserveLamports,
  );

  const ixs = [
    ...budgetIxs,
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, decimals, payer, payer, TOKEN_PROGRAM_ID),
    ...metaBuilder.getInstructions().map(toWeb3JsInstruction),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer, BigInt(rawSupply.toString()), [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, null, [], TOKEN_PROGRAM_ID),
  ];
  const copyFeeIx = buildTreasuryTransferInstruction(payer, copyFeeLamports);
  if (copyFeeIx) ixs.push(copyFeeIx);

  const { blockhash, lastValidBlockHeight } = await params.connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([mintKp]);

  params.onProgress?.('awaiting_signature');
  const signed = await w.signTransaction(vtx);

  params.onProgress?.('confirming');
  const sig = await sendRawTransactionWithSimulationFallback(params.connection, signed.serialize());

  await confirmTransactionResilient(
    params.connection,
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  params.onProgress?.('done');
  return { mint, signature: sig, metadataUri, sourceMint: params.sourceMint, isVirtual: false };
}
