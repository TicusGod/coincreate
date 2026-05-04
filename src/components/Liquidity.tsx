import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import axios from 'axios';
import { ChevronDown, RefreshCw, X, Copy, Minus, Zap } from 'lucide-react';
import { LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplTokenMetadata, fetchDigitalAsset } from '@metaplex-foundation/mpl-token-metadata';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { useSolanaWallet } from '../hooks/useSolanaWallet';
import { useRaydium } from '../hooks/useRaydium';
import { withTransactionToast } from '../utils/transactionToast';
import { env } from '../config/env';
import { buildFeeTransferInstruction, getFeeLamports } from '../services/feeService';
import { confirmTransactionResilient, sendRawTransactionWithSimulationFallback } from '../services/solanaTxHelpers';
import { ipfsToHttp } from '../services/ipfsService';
import { previewWillCreateNewCpmmPool, RAYDIUM_CPMM_NEW_POOL_LAMPORTS, type UserPoolPosition } from '../services/raydiumService';

type WalletTokenOption = { mint: string; symbol: string; label: string; uiAmount: number; imageUrl: string | null };

async function imageUrlFromMetadataUri(uriRaw: string): Promise<string | null> {
  const uri = uriRaw.replace(/\0/g, '').trim();
  if (!uri) return null;
  try {
    const fetchUrl = uri.startsWith('ipfs://') ? ipfsToHttp(uri) : uri;
    if (!fetchUrl.startsWith('http://') && !fetchUrl.startsWith('https://')) return null;
    const { data } = await axios.get<Record<string, unknown>>(fetchUrl, { timeout: 10_000 });
    const img = typeof data.image === 'string' ? data.image : '';
    if (!img) return null;
    return img.startsWith('ipfs://') ? ipfsToHttp(img) : img;
  } catch {
    return null;
  }
}

const META_TTL_MS = 5 * 60 * 1000;
const LP_PERCENTAGES = [25, 50, 75, 100];
/** Applied to add/remove LP txs; not shown in the UI. */
const AUTO_SLIPPAGE_PERCENT = 1;
/** Lamports reserved on top of platform fee (and quoted SOL for add) for tx + wrap headroom. */
const ADD_LIQ_RESERVE_LAMPORTS = 5_000_000;
const REMOVE_LIQ_RESERVE_LAMPORTS = 3_000_000;
const BOOST_RESERVE_LAMPORTS = 1_000_000;

function toastInsufficientSol(minLamports: number, balanceLamports: number) {
  const need = (minLamports / LAMPORTS_PER_SOL).toFixed(3);
  const have = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
  toast.error(`Insufficient SOL. Need ~${need} SOL; you have ${have} SOL.`);
}

function shortMint(mint: string, head = 4, tail = 4): string {
  if (mint.length <= head + tail) return mint;
  return `${mint.slice(0, head)}...${mint.slice(-tail)}`;
}

/** `smallFractionDigits` applies when |num| is below 1; K/M/B and values ≥ 1 stay at 2 decimals. */
function formatCompact(num: number, smallFractionDigits = 6): string {
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  if (abs >= 1) return num.toFixed(2);
  return num.toFixed(smallFractionDigits);
}

/** Whole token amount with `.` thousands groups, e.g. 999.999.998 (no decimals). */
function formatSplBalanceDots(uiAmount: number): string {
  if (!Number.isFinite(uiAmount)) return '0';
  const n = Math.floor(Math.max(0, uiAmount));
  const s = String(n);
  const groups: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    groups.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return groups.join('.');
}

function splBalanceLabel(uiAmount: number, symbol: string): string {
  return `${formatSplBalanceDots(uiAmount)} $${symbol}`;
}

/** Axiom `/meme/` expects the pool (pair) address, not the token mint. */
function axiomPairTradeUrl(poolId: string): string {
  return `https://axiom.trade/meme/${encodeURIComponent(poolId)}?chain=sol`;
}

/** Pooled SOL / USDC: K/M/B when large, else always 2 decimal places (e.g. 0.75). */
function formatQuotePooledCompact(num: number): string {
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  if (abs >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toFixed(2);
}

function isWsolMint(mint: string): boolean {
  return mint === env.wsolMint;
}

function isPoolSolSide(p: UserPoolPosition, side: 'base' | 'quote'): boolean {
  return isWsolMint(side === 'base' ? p.baseMint : p.quoteMint);
}

function pairLabel(p: UserPoolPosition): string {
  const label = (mint: string, raw: string) => (isWsolMint(mint) ? 'SOL' : raw);
  const a = label(p.baseMint, p.baseSymbol);
  const b = label(p.quoteMint, p.quoteSymbol);
  const solish = (s: string) => s === 'SOL' || s === 'WSOL';
  if (solish(a)) return `${a}-${b}`;
  if (solish(b)) return `${b}-${a}`;
  return `${a}-${b}`;
}

function nonSolSymbol(p: UserPoolPosition): string {
  const isUsd = (s: string) => s === 'USDC';
  if (isPoolSolSide(p, 'base') && !isPoolSolSide(p, 'quote')) return p.quoteSymbol;
  if (isPoolSolSide(p, 'quote') && !isPoolSolSide(p, 'base')) return p.baseSymbol;
  if (isUsd(p.baseSymbol) && !isUsd(p.quoteSymbol)) return p.quoteSymbol;
  if (isUsd(p.quoteSymbol) && !isUsd(p.baseSymbol)) return p.baseSymbol;
  return p.baseSymbol;
}

function quoteLikeLabel(p: UserPoolPosition): string {
  if (isPoolSolSide(p, 'base') || isPoolSolSide(p, 'quote')) return 'SOL';
  if (p.quoteSymbol === 'USDC') return 'USDC';
  if (p.baseSymbol === 'USDC') return 'USDC';
  return p.quoteSymbol;
}

function pooledQuoteDisplay(p: UserPoolPosition): string {
  let raw: string;
  if (isPoolSolSide(p, 'quote')) raw = p.quoteAmount;
  else if (isPoolSolSide(p, 'base')) raw = p.baseAmount;
  else if (p.quoteSymbol === 'USDC') raw = p.quoteAmount;
  else if (p.baseSymbol === 'USDC') raw = p.baseAmount;
  else raw = p.quoteAmount;
  return formatQuotePooledCompact(Number(raw));
}

function pooledMemeNumeric(p: UserPoolPosition): number {
  const isUsd = (s: string) => s === 'USDC';
  if (isPoolSolSide(p, 'base') && !isPoolSolSide(p, 'quote')) return Number(p.quoteAmount);
  if (isPoolSolSide(p, 'quote') && !isPoolSolSide(p, 'base')) return Number(p.baseAmount);
  if (isUsd(p.baseSymbol) && !isUsd(p.quoteSymbol)) return Number(p.quoteAmount);
  if (isUsd(p.quoteSymbol) && !isUsd(p.baseSymbol)) return Number(p.baseAmount);
  return Number(p.baseAmount);
}

function pooledMemeDisplay(p: UserPoolPosition): string {
  return formatCompact(pooledMemeNumeric(p));
}

function poolDisplayMintOrder(p: UserPoolPosition): [string, string] {
  if (isPoolSolSide(p, 'base') && !isPoolSolSide(p, 'quote')) return [p.baseMint, p.quoteMint];
  if (isPoolSolSide(p, 'quote') && !isPoolSolSide(p, 'base')) return [p.quoteMint, p.baseMint];
  return [p.baseMint, p.quoteMint];
}

function SolIcon({ className = '' }: { className?: string }) {
  return <img src="/sol.png" alt="" className={className} width={26} height={26} aria-hidden draggable={false} />;
}

function TokenAvatar({
  symbol,
  mint,
  imageUrl,
  className = 'w-6 h-6',
  textClassName = 'text-[10px]',
}: {
  symbol: string;
  mint: string;
  imageUrl?: string | null;
  className?: string;
  textClassName?: string;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        className={`${className} rounded-full object-cover shrink-0 border border-[#212225]`}
      />
    );
  }
  const hue = mint.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return (
    <div
      className={`${className} rounded-full flex items-center justify-center font-bold text-white shrink-0 ${textClassName}`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue}, 65%, 42%), hsl(${(hue + 40) % 360}, 70%, 35%))`,
      }}
    >
      {(symbol || '?').slice(0, 2).toUpperCase()}
    </div>
  );
}

function PoolRoundMint({
  mint,
  symbol,
  imageUrl,
  sizeClass,
  textClassName,
}: {
  mint: string;
  symbol: string;
  imageUrl: string | null | undefined;
  sizeClass: string;
  textClassName?: string;
}) {
  if (mint === env.wsolMint) {
    return (
      <div
        className={`${sizeClass} rounded-full ring-2 ring-[#18191b] bg-[#111113] flex items-center justify-center shrink-0 overflow-hidden`}
      >
        <SolIcon className="" />
      </div>
    );
  }
  return (
    <div className={`${sizeClass} rounded-full ring-2 ring-[#18191b] shrink-0 overflow-hidden`}>
      <TokenAvatar
        symbol={symbol}
        mint={mint}
        imageUrl={imageUrl}
        className="w-full h-full rounded-full border-0"
        textClassName={textClassName ?? 'text-[10px]'}
      />
    </div>
  );
}

function quoteSideMint(p: UserPoolPosition): string {
  if (isPoolSolSide(p, 'base')) return p.baseMint;
  if (isPoolSolSide(p, 'quote')) return p.quoteMint;
  if (p.quoteSymbol === 'USDC') return p.quoteMint;
  if (p.baseSymbol === 'USDC') return p.baseMint;
  return p.quoteMint;
}

function memeSideMint(p: UserPoolPosition): string {
  const isUsd = (s: string) => s === 'USDC';
  if (isPoolSolSide(p, 'base') && !isPoolSolSide(p, 'quote')) return p.quoteMint;
  if (isPoolSolSide(p, 'quote') && !isPoolSolSide(p, 'base')) return p.baseMint;
  if (isUsd(p.baseSymbol) && !isUsd(p.quoteSymbol)) return p.quoteMint;
  if (isUsd(p.quoteSymbol) && !isUsd(p.baseSymbol)) return p.baseMint;
  return p.quoteMint;
}

function symbolForMint(p: UserPoolPosition, mint: string): string {
  if (isWsolMint(mint)) return 'SOL';
  return mint === p.baseMint ? p.baseSymbol : p.quoteSymbol;
}

function BoostModal({ onClose }: { onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { connection } = useConnection();
  const wallet = useWallet();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dismiss = () => setClosing(true);
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) dismiss();
  };

  const boostSol = env.fees.dexBoostSol;
  const payerPreview = wallet.publicKey;
  const boostFeeExempt = payerPreview ? env.isFeeExemptWallet(payerPreview) : false;

  const payBoostFee = async () => {
    if (busy || closing) return;
    const payer = wallet.publicKey;
    if (!payer) {
      toast.error('Connect your wallet first');
      return;
    }
    const signTx = wallet.signTransaction;
    if (!signTx) {
      toast.error('Your wallet cannot sign transactions');
      return;
    }
    try {
      const minLamports = getFeeLamports('dex_boost', 1, payer) + BOOST_RESERVE_LAMPORTS;
      const balance = await connection.getBalance(payer, 'confirmed');
      if (balance < minLamports) {
        toastInsufficientSol(minLamports, balance);
        return;
      }
    } catch {
      toast.error('Could not verify balance. Check your connection and try again.');
      return;
    }
    setBusy(true);
    try {
      const ix = buildFeeTransferInstruction(payer, 'dex_boost');
      if (!ix) {
        toast.success('Boost activated — no platform fee for your wallet');
        dismiss();
        return;
      }
      await withTransactionToast(
        'Approve boost payment in Phantom',
        async () => {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          const msg = new TransactionMessage({
            payerKey: payer,
            recentBlockhash: blockhash,
            instructions: [ix],
          }).compileToV0Message();
          const vtx = new VersionedTransaction(msg);
          const signed = await signTx(vtx);
          const sig = await sendRawTransactionWithSimulationFallback(connection, signed.serialize());
          await confirmTransactionResilient(connection, { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
          return { signature: sig };
        },
        { successMessage: 'Boost fee paid' },
      );
      dismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={handleOverlayClick}
      onAnimationEnd={closing ? onClose : undefined}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm ${
        closing ? 'modal-backdrop-out' : 'modal-backdrop-in'
      }`}
    >
      <div
        className={`bg-[#18191b] border border-[#fbbf24]/30 rounded-[20px] p-7 w-full max-w-sm mx-4 shadow-[0_0_64px_rgba(251,191,36,0.15),0_24px_64px_rgba(0,0,0,0.6)] ${closing ? 'modal-panel-out' : 'modal-panel-in'}`}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[#fafafa] font-bold text-lg">Boost Your Token</h2>
          <button
            type="button"
            onClick={dismiss}
            className="w-8 h-8 flex items-center justify-center rounded-[8px] text-[#696e77] hover:text-[#fafafa] hover:bg-[#212225] transition-all duration-150"
          >
            <X size={16} />
          </button>
        </div>

        <div className="relative rounded-[12px] overflow-hidden mb-5 border border-[#fbbf24]/20 bg-[#111113] flex items-center justify-center h-36">
          <img
            src="/boost.png"
            alt="Boost"
          />
        </div>

        <p className="text-[#b0b4ba] text-sm leading-relaxed mb-5">
          Boost your token to the top of{' '}
          <span className="text-[#fafafa] font-semibold">Dexscreener&apos;s trending list</span> for{' '}
          <span className="text-[#fbbf24] font-semibold">1 hour</span>, maximizing visibility to thousands of
          traders actively scanning for new opportunities.
        </p>

        <div className="flex items-center justify-between bg-[#111113] border border-[#fbbf24]/20 rounded-[12px] px-4 py-3 mb-5">
          <div>
            <p className="text-[#696e77] text-xs mb-0.5">Boost duration</p>
            <p className="text-[#fafafa] font-semibold text-sm">1 Hour</p>
          </div>
          <div className="h-8 w-px bg-[#212225]" />
          <div className="text-right">
            <p className="text-[#696e77] text-xs mb-0.5">Cost</p>
            <p className="text-[#fbbf24] font-bold text-sm">{boostFeeExempt ? '0 (waived)' : `${boostSol} SOL`}</p>
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          className="w-full h-11 rounded-[10px] font-bold text-sm text-white transition-all duration-150 active:translate-y-px select-none relative overflow-hidden disabled:opacity-50 disabled:pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 50%, #f59e0b 100%)',
            boxShadow: '0 0 20px rgba(251,191,36,0.4), 0 4px 12px rgba(0,0,0,0.3)',
          }}
          onClick={() => void payBoostFee()}
        >
          {busy ? 'Confirm in Phantom…' : 'Boost'}
        </button>
        <p className="text-[#696e77] text-xs text-center mt-3">
          {boostFeeExempt
            ? 'No platform boost fee for your wallet — keep enough SOL for network costs.'
            : `You must have ${boostSol} SOL (platform fee) plus a little extra for network costs.`}
        </p>
      </div>
    </div>
  );
}

function RemoveLiquidityModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (pct: number) => Promise<void>;
}) {
  const [selected, setSelected] = useState(0);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { publicKey } = useWallet();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dismiss = () => setClosing(true);
  const removeFeeSol = env.fees.removeLiquiditySol;
  const removeFeeExempt = publicKey ? env.isFeeExemptWallet(publicKey) : false;

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) dismiss();
  };

  const canRemove = selected >= 1;

  const runRemove = async () => {
    if (!canRemove || busy) return;
    setBusy(true);
    try {
      await onConfirm(selected);
      dismiss();
    } catch {
      /* transaction toast */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={handleOverlayClick}
      onAnimationEnd={closing ? onClose : undefined}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm ${
        closing ? 'modal-backdrop-out' : 'modal-backdrop-in'
      }`}
    >
      <div
        className={`relative bg-[#18191b] border border-[#212225] rounded-[20px] p-7 w-full max-w-sm mx-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] ${closing ? 'modal-panel-out' : 'modal-panel-in'}`}
      >
        <button
          type="button"
          onClick={dismiss}
          className="absolute top-5 right-5 w-8 h-8 flex items-center justify-center rounded-[8px] text-[#696e77] hover:text-[#fafafa] hover:bg-[#212225] transition-all duration-150"
        >
          <X size={16} />
        </button>
        <h2 className="text-[#fafafa] font-bold text-xl mb-5">Remove Liquidity</h2>

        <div className="flex gap-2 mb-5">
          {LP_PERCENTAGES.map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => setSelected(pct)}
              className={`flex-1 h-9 rounded-[8px] text-sm font-semibold transition-all duration-150 ${
                selected === pct
                  ? 'bg-[#86efac] text-[#052e16]'
                  : 'bg-[#212225] text-[#b0b4ba] hover:bg-[#272a2d] hover:text-[#fafafa]'
              }`}
            >
              {pct}%
            </button>
          ))}
        </div>

        <div className="mb-5 relative h-6 flex items-center">
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-[#212225] overflow-hidden">
            <div
              className="absolute left-0 top-0 h-full bg-[#86efac] rounded-full"
              style={{ width: `${selected}%` }}
            />
          </div>
          <div
            className="pointer-events-none absolute w-3 h-3 rounded-full bg-[#86efac] shadow border-2 border-white z-0"
            style={{ left: `calc(${selected}% - 6px)` }}
          />
          <input
            type="range"
            min={0}
            max={100}
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
          />
        </div>

        <p className="text-[#e4e4e7] font-semibold text-sm mb-5">Remove {selected}% of LP tokens</p>

        <button
          type="button"
          onClick={() => void runRemove()}
          disabled={!canRemove || busy}
          className={`w-full h-11 rounded-[10px] font-bold text-sm transition-all duration-150 ${
            canRemove && !busy
              ? 'bg-[#ef4444] text-white hover:bg-[#dc2626] active:translate-y-px cursor-pointer'
              : 'bg-[#ef4444]/30 text-white/40 cursor-not-allowed'
          }`}
        >
          {busy ? 'Removing…' : 'Remove Liquidity'}
        </button>
        <p className="text-[#696e77] text-xs text-center mt-3">
          {removeFeeExempt
            ? 'No platform fee for your wallet — keep SOL for network costs.'
            : `You must have ${removeFeeSol} SOL for the platform fee plus network costs.`}
        </p>
      </div>
    </div>
  );
}

export default function Liquidity({
  initialSelectMint = null,
  onInitialSelectConsumed,
}: {
  initialSelectMint?: string | null;
  onInitialSelectConsumed: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, connected } = wallet;
  const { connect, solBalance } = useSolanaWallet();
  const { addLiquidity, removeLiquidity, userPools, refreshUserPools, isLoading } = useRaydium();

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [walletTokens, setWalletTokens] = useState<WalletTokenOption[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [tokenAmount, setTokenAmount] = useState('');
  const [solAmount, setSolAmount] = useState('');
  const [copiedMint, setCopiedMint] = useState(false);
  const [poolForRemove, setPoolForRemove] = useState<UserPoolPosition | null>(null);
  const [boostPoolId, setBoostPoolId] = useState<string | null>(null);

  const metaCache = useRef<Map<string, { at: number; label: string; symbol: string; imageUrl: string | null }>>(
    new Map(),
  );
  /** Mint to select after wallet tokens finish loading (from Create flow); ref avoids races with async refresh. */
  const pendingLiquidityMintRef = useRef<string | null>(null);

  useEffect(() => {
    pendingLiquidityMintRef.current = initialSelectMint;
  }, [initialSelectMint]);

  const resolveMeta = useCallback(
    async (mint: string): Promise<{ label: string; symbol: string; imageUrl: string | null }> => {
      const now = Date.now();
      const hit = metaCache.current.get(mint);
      if (hit && now - hit.at < META_TTL_MS) {
        return { label: hit.label, symbol: hit.symbol, imageUrl: hit.imageUrl };
      }
      try {
        const umi = createUmi(connection).use(mplTokenMetadata());
        const asset = await fetchDigitalAsset(umi, umiPublicKey(mint));
        const sym = asset.metadata.symbol.replace(/\0/g, '').trim() || mint.slice(0, 4);
        const label = `${sym} · ${mint.slice(0, 4)}…${mint.slice(-4)}`;
        const uriRaw = asset.metadata.uri.replace(/\0/g, '').trim();
        const imageUrl = uriRaw ? await imageUrlFromMetadataUri(uriRaw) : null;
        metaCache.current.set(mint, { at: now, label, symbol: sym, imageUrl });
        return { label, symbol: sym, imageUrl };
      } catch {
        const sym = mint.slice(0, 4);
        const label = `${sym}…${mint.slice(-4)}`;
        metaCache.current.set(mint, { at: now, label, symbol: sym, imageUrl: null });
        return { label, symbol: sym, imageUrl: null };
      }
    },
    [connection],
  );

  const loadWalletTokens = useCallback(async () => {
    if (!publicKey) {
      setWalletTokens([]);
      return;
    }
    const preferMint = pendingLiquidityMintRef.current;
    setLoadingTokens(true);
    try {
      const parsed = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID });
      const rows: { mint: string; ui: number }[] = [];
      for (const { account } of parsed.value) {
        const data = account.data as {
          parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } };
        };
        const mint = data.parsed?.info?.mint;
        const ui = Number(data.parsed?.info?.tokenAmount?.uiAmount ?? 0);
        if (!mint) continue;
        const keepForLiquidityNav = preferMint != null && mint === preferMint;
        if (ui <= 0 && !keepForLiquidityNav) continue;
        rows.push({ mint, ui });
      }
      if (preferMint && !rows.some((r) => r.mint === preferMint)) {
        try {
          const extra = await connection.getParsedTokenAccountsByOwner(publicKey, {
            programId: TOKEN_PROGRAM_ID,
            mint: new PublicKey(preferMint),
          });
          for (const { account } of extra.value) {
            const data = account.data as {
              parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } };
            };
            const mint = data.parsed?.info?.mint;
            const ui = Number(data.parsed?.info?.tokenAmount?.uiAmount ?? 0);
            if (mint === preferMint) {
              rows.push({ mint, ui: Math.max(ui, 0) });
              break;
            }
          }
        } catch {
          /* ignore */
        }
      }
      if (preferMint && !rows.some((r) => r.mint === preferMint)) {
        rows.push({ mint: preferMint, ui: 0 });
      }
      const opts: WalletTokenOption[] = [];
      for (const r of rows) {
        const { label, symbol, imageUrl } = await resolveMeta(r.mint);
        opts.push({ mint: r.mint, symbol, label, uiAmount: r.ui, imageUrl });
      }
      opts.sort((a, b) => b.uiAmount - a.uiAmount);
      setWalletTokens(opts);
      setSelectedMint((prev) => {
        if (preferMint && opts.some((o) => o.mint === preferMint)) return preferMint;
        if (prev && opts.some((o) => o.mint === prev)) return prev;
        return null;
      });
    } catch {
      setWalletTokens([]);
    } finally {
      setLoadingTokens(false);
    }
  }, [connection, publicKey, resolveMeta]);

  const [poolMintImages, setPoolMintImages] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (userPools.length === 0) return;
    const mints = new Set<string>();
    for (const p of userPools) {
      mints.add(p.baseMint);
      mints.add(p.quoteMint);
    }
    let cancelled = false;
    void (async () => {
      const next: Record<string, string | null> = {};
      await Promise.all(
        [...mints].map(async (m) => {
          const { imageUrl } = await resolveMeta(m);
          next[m] = imageUrl;
        }),
      );
      if (!cancelled) setPoolMintImages((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [userPools, resolveMeta]);

  useEffect(() => {
    void loadWalletTokens();
  }, [loadWalletTokens]);

  const selected = useMemo(
    () => walletTokens.find((t) => t.mint === selectedMint) ?? null,
    [walletTokens, selectedMint],
  );

  useEffect(() => {
    if (!initialSelectMint || loadingTokens) return;
    if (walletTokens.some((t) => t.mint === initialSelectMint)) {
      setSelectedMint(initialSelectMint);
      onInitialSelectConsumed();
    }
  }, [initialSelectMint, walletTokens, loadingTokens, onInitialSelectConsumed]);

  const tokenSelected = selected !== null;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshUserPools();
      await loadWalletTokens();
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyMint = async () => {
    if (!selectedMint) return;
    try {
      await navigator.clipboard.writeText(selectedMint);
      setCopiedMint(true);
      setTimeout(() => setCopiedMint(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  const fmtTokenInput = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Decimal(n).toSignificantDigits(20).toString();
  };

  const solBal = solBalance ?? 0;

  const onAddLiquidity = async () => {
    if (!connected) {
      connect();
      toast('Connect your wallet');
      return;
    }
    if (!selectedMint) {
      toast.error('Select a token');
      return;
    }
    const baseStr = tokenAmount.trim();
    const quoteStr = solAmount.trim();
    const baseDec = new Decimal(baseStr);
    const quoteDec = new Decimal(quoteStr);
    if (!baseDec.isFinite() || baseDec.lte(0) || !quoteDec.isFinite() || quoteDec.lte(0)) {
      toast.error('Enter token and SOL amounts');
      return;
    }
    if (import.meta.env.DEV) {
      console.log('[addLiquidity input STEP 1 form]', {
        baseAmountString: baseStr,
        quoteAmountString: quoteStr,
        baseMint: selectedMint,
      });
    }
    if (!publicKey) {
      connect();
      return;
    }
    try {
      const willCreatePool = await previewWillCreateNewCpmmPool({
        connection,
        wallet,
        baseMint: new PublicKey(selectedMint),
        quoteCurrency: 'WSOL',
      });
      const solLamports = Math.ceil(quoteDec.mul(LAMPORTS_PER_SOL).toNumber());
      const raydiumCreateLamports = willCreatePool ? RAYDIUM_CPMM_NEW_POOL_LAMPORTS : 0;
      const minLamports =
        getFeeLamports('add_liquidity', 1, publicKey) + solLamports + ADD_LIQ_RESERVE_LAMPORTS + raydiumCreateLamports;
      const balance = await connection.getBalance(publicKey, 'confirmed');
      if (balance < minLamports) {
        toastInsufficientSol(minLamports, balance);
        return;
      }
    } catch {
      toast.error('Could not verify balance. Check your connection and try again.');
      return;
    }
    const slip = AUTO_SLIPPAGE_PERCENT;
    try {
      await withTransactionToast(
        'Adding liquidity',
        async () => {
          const res = await addLiquidity({
            baseMint: selectedMint,
            quoteCurrency: 'WSOL',
            baseAmount: baseStr,
            quoteAmount: quoteStr,
            slippagePercent: slip,
          });
          await refreshUserPools();
          await loadWalletTokens();
          return { signature: res.signature, isNewPool: res.isNewPool };
        },
        {
          successMessage: () => 'Creating pool. It can take a few minutes',
          successDuration: 6000,
          errorMessage: 'Pool creation transaction failed',
        },
      );
      setTokenAmount('');
      setSolAmount('');
    } catch {
      /* toast */
    }
  };

  const removePctOfPool = async (pool: UserPoolPosition, pct: number) => {
    if (!connected) {
      connect();
      toast('Connect your wallet');
      throw new Error('Wallet not connected');
    }
    if (!publicKey) {
      toast.error('Connect your wallet');
      throw new Error('Wallet not connected');
    }
    try {
      const minLamports = getFeeLamports('remove_liquidity', 1, publicKey) + REMOVE_LIQ_RESERVE_LAMPORTS;
      const balance = await connection.getBalance(publicKey, 'confirmed');
      if (balance < minLamports) {
        toastInsufficientSol(minLamports, balance);
        throw new Error('Insufficient SOL');
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'Insufficient SOL') throw e;
      toast.error('Could not verify balance. Check your connection and try again.');
      throw e;
    }
    /** Derive burn amount from chain raw LP balance so 100% never exceeds ATA (display `lpAmount` uses toFixed(4) and can round up). */
    const pctInt = Math.min(100, Math.max(0, Math.round(pct)));
    const totalRaw = new BN(pool.lpAmountRaw);
    const rawToBurn = pctInt >= 100 ? totalRaw : totalRaw.muln(pctInt).divn(100);
    if (rawToBurn.isZero()) {
      toast.error('Nothing to remove');
      throw new Error('Nothing to remove');
    }
    const slip = AUTO_SLIPPAGE_PERCENT;
    await withTransactionToast('Removing liquidity', async () => {
      const res = await removeLiquidity({
        poolId: pool.poolId,
        lpAmountRaw: rawToBurn.toString(10),
        slippagePercent: slip,
      });
      await refreshUserPools();
      await loadWalletTokens();
      return { signature: res.signature };
    });
  };

  return (
    <section className="pt-12 pb-20 px-4 min-h-screen bg-[#111113]">
      {poolForRemove && (
        <RemoveLiquidityModal
          onClose={() => setPoolForRemove(null)}
          onConfirm={(pct) => {
            if (!poolForRemove) return Promise.resolve();
            return removePctOfPool(poolForRemove, pct);
          }}
        />
      )}
      {boostPoolId && <BoostModal onClose={() => setBoostPoolId(null)} />}

      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-[#fafafa] text-center mb-8 tracking-tight">
          Create Raydium Liquidity Pool
        </h1>

        <div className="bg-[#18191b] border border-[#212225] rounded-[16px] p-6 mb-10">
          <p className="text-[#e4e4e7] font-semibold text-sm mb-4">
            For which token would you like to create a pool?
          </p>

          <div className="relative mb-4">
            {tokenSelected ? (
              <div className="w-full flex items-center justify-between bg-[#111113] border border-[#212225] rounded-[12px] px-3 h-11">
                <button
                  type="button"
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="flex-1 flex items-center gap-2 h-full text-left min-w-0"
                >
                  <TokenAvatar symbol={selected.symbol} mint={selected.mint} imageUrl={selected.imageUrl} />
                  <span className="text-[#fafafa] font-semibold text-sm shrink-0">{selected.symbol}</span>
                  <span className="text-[#696e77] text-sm truncate">
                    - Balance: {splBalanceLabel(selected.uiAmount, selected.symbol)}
                  </span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMint(null);
                      setDropdownOpen(false);
                      setTokenAmount('');
                    }}
                    className="p-1.5 text-[#696e77] hover:text-[#fafafa] transition-colors rounded-md focus:outline-none"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <X size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDropdownOpen((o) => !o)}
                    className="p-1 text-[#696e77] hover:text-[#fafafa] transition-colors focus:outline-none"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <ChevronDown size={15} className={`transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDropdownOpen((o) => !o)}
                className="w-full h-11 flex items-center justify-between bg-[#111113] border border-[#212225] hover:border-[#272a2d] rounded-[12px] px-3 text-sm transition-all duration-150 outline-none focus:border-[#696e77]"
              >
                <span className="text-[#363a3f]">
                  {loadingTokens ? 'Loading tokens…' : 'Choose your token'}
                </span>
                <ChevronDown size={16} className={`text-[#696e77] transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`} />
              </button>
            )}

            {dropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#18191b] border border-[#212225] rounded-[12px] overflow-hidden z-20 shadow-[0_8px_32px_rgba(0,0,0,0.4)] max-h-56 overflow-y-auto">
                {walletTokens.length === 0 ? (
                  <p className="px-4 py-3 text-[#696e77] text-sm">
                    {connected ? 'No SPL tokens in this wallet.' : 'Connect a wallet to list tokens.'}
                  </p>
                ) : (
                  walletTokens.map((t) => (
                    <button
                      key={t.mint}
                      type="button"
                      className="w-full flex items-center gap-2 px-4 py-3 hover:bg-[#212225] transition-colors text-sm text-left"
                      onClick={() => {
                        setSelectedMint(t.mint);
                        setDropdownOpen(false);
                      }}
                    >
                      <TokenAvatar symbol={t.symbol} mint={t.mint} imageUrl={t.imageUrl} />
                      <span className="text-[#fafafa] font-semibold">{t.symbol}</span>
                      <span className="text-[#696e77]">
                        - {splBalanceLabel(t.uiAmount, t.symbol)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {tokenSelected && selectedMint && (
            <>
              <div className="flex items-center gap-2 mb-5 flex-wrap">
                <span className="text-[#696e77] text-xs font-mono">{shortMint(selectedMint, 8, 6)}</span>
                <button
                  type="button"
                  onClick={() => void handleCopyMint()}
                  className="text-[#696e77] hover:text-[#b0b4ba] transition-colors"
                >
                  <Copy size={13} />
                </button>
                {copiedMint && <span className="text-[10px] text-[#86efac]">Copied!</span>}
              </div>

              <label className="block text-[#e4e4e7] font-semibold text-sm mb-2">
                Amount of ${selected.symbol}
              </label>
              <div className="flex items-center gap-2 bg-[#111113] border border-[#212225] rounded-[12px] px-3 h-11 mb-1">
                <input
                  type="text"
                  value={tokenAmount}
                  onChange={(e) => setTokenAmount(e.target.value)}
                  placeholder="0"
                  className="flex-1 min-w-0 bg-transparent text-[#fafafa] text-sm outline-none placeholder:text-[#2a2d31]"
                />
                <button
                  type="button"
                  onClick={() => setTokenAmount(fmtTokenInput(selected.uiAmount * 0.5))}
                  className="text-[10px] font-bold text-[#86efac] hover:text-[#bbf7d0] px-1 transition-colors shrink-0"
                >
                  50%
                </button>
                <button
                  type="button"
                  onClick={() => setTokenAmount(fmtTokenInput(selected.uiAmount * 0.9))}
                  className="text-[10px] font-bold text-[#86efac] hover:text-[#bbf7d0] px-1 transition-colors shrink-0"
                >
                  90%
                </button>
                <button
                  type="button"
                  onClick={() => setTokenAmount(fmtTokenInput(selected.uiAmount))}
                  className="text-[10px] font-bold text-[#86efac] hover:text-[#bbf7d0] px-1 transition-colors shrink-0"
                >
                  Max
                </button>
              </div>
              <p className="text-[#696e77] text-xs mb-5">
                Balance: {splBalanceLabel(selected.uiAmount, selected.symbol)}
              </p>

              <div className="flex items-center gap-2 mb-2">
                <SolIcon />
                <label className="text-[#e4e4e7] font-semibold text-sm">Amount of SOL to Pair</label>
              </div>
              <p className="text-[#696e77] text-xs mb-2">
                (Pairing with SOL. An additional {env.fees.addLiquiditySol} SOL app fee applies to add liquidity)
              </p>
              <div className="flex items-center gap-2 bg-[#111113] border border-[#212225] rounded-[12px] px-3 h-11 mb-1">
                <input
                  type="text"
                  value={solAmount}
                  onChange={(e) => setSolAmount(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 min-w-0 bg-transparent text-[#fafafa] text-sm outline-none placeholder:text-[#2a2d31]"
                />
                <button
                  type="button"
                  onClick={() => setSolAmount(fmtTokenInput(solBal * 0.5))}
                  className="text-[10px] font-bold text-[#86efac] hover:text-[#bbf7d0] px-1 transition-colors shrink-0"
                >
                  50%
                </button>
                <button
                  type="button"
                  onClick={() => setSolAmount(fmtTokenInput(solBal))}
                  className="text-[10px] font-bold text-[#86efac] hover:text-[#bbf7d0] px-1 transition-colors shrink-0"
                >
                  Max
                </button>
              </div>
              <p className="text-[#696e77] text-xs mb-6">
                Balance: {solBal.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL
              </p>

              <button
                type="button"
                onClick={() => void onAddLiquidity()}
                className="w-full h-12 rounded-[12px] bg-[#86efac] text-[#052e16] font-bold text-base flex items-center justify-center hover:bg-[#bbf7d0] active:translate-y-px transition-all duration-150 select-none"
              >
                Create Pool
              </button>
            </>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[#fafafa] text-lg font-bold">Your Pools</h2>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="w-9 h-9 flex items-center justify-center rounded-[10px] bg-[#212225] hover:bg-[#272a2d] transition-all duration-150 active:translate-y-px"
            >
              <RefreshCw size={15} className={`text-[#b0b4ba] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {isLoading && !userPools.length ? (
            <p className="text-[#696e77] text-sm">Loading positions…</p>
          ) : userPools.length === 0 ? (
            <p className="text-[#696e77] text-sm">No Raydium pools found with LP tokens.</p>
          ) : (
            <div className="space-y-5">
              {userPools.map((p) => (
                <div key={p.poolId} className="bg-[#18191b] border border-[#212225] rounded-[16px] p-5">
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex -space-x-2 shrink-0">
                        {(() => {
                          const [m0, m1] = poolDisplayMintOrder(p);
                          return (
                            <>
                              <PoolRoundMint
                                mint={m0}
                                symbol={symbolForMint(p, m0)}
                                imageUrl={poolMintImages[m0]}
                                sizeClass="w-9 h-9"
                                textClassName="text-[11px]"
                              />
                              <PoolRoundMint
                                mint={m1}
                                symbol={symbolForMint(p, m1)}
                                imageUrl={poolMintImages[m1]}
                                sizeClass="w-9 h-9"
                                textClassName="text-[11px]"
                              />
                            </>
                          );
                        })()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[#fafafa] font-bold text-base">{pairLabel(p)}</p>
                        <p className="text-[#696e77] text-xs font-mono truncate">
                          {shortMint(p.baseMint, 4, 4)}-{shortMint(p.quoteMint, 4, 4)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setBoostPoolId(p.poolId)}
                        className="w-8 h-8 rounded-[8px] flex items-center justify-center transition-all duration-150 active:translate-y-px relative"
                        style={{
                          background: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 50%, #f59e0b 100%)',
                          boxShadow: '0 0 14px rgba(251,191,36,0.55), 0 2px 6px rgba(0,0,0,0.3)',
                        }}
                        title="Boost on Dexscreener"
                      >
                        <Zap size={14} className="text-white fill-white" />
                      </button>
                      <a
                        href={axiomPairTradeUrl(p.poolId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-8 px-3 rounded-[8px] border border-[#86efac] text-[#86efac] text-xs font-semibold hover:bg-[#86efac]/10 transition-colors flex items-center"
                      >
                        View on Axiom
                      </a>
                      <button
                        type="button"
                        onClick={() => setPoolForRemove(p)}
                        className="w-8 h-8 rounded-[8px] bg-[#ef4444] flex items-center justify-center hover:bg-[#dc2626] transition-colors"
                      >
                        <Minus size={14} className="text-white" />
                      </button>
                    </div>
                  </div>

                  <p className="text-[#696e77] text-xs mb-4 break-all">
                    Pool ID: <span className="text-[#e4e4e7] font-mono font-semibold">{p.poolId}</span>
                  </p>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-[#111113] border border-[#212225] rounded-[12px] p-3">
                      <p className="text-[#696e77] text-xs mb-1">Pooled {quoteLikeLabel(p)}</p>
                      <div className="flex items-center gap-1.5">
                        <PoolRoundMint
                          mint={quoteSideMint(p)}
                          symbol={symbolForMint(p, quoteSideMint(p))}
                          imageUrl={poolMintImages[quoteSideMint(p)]}
                          sizeClass="w-4 h-4"
                          textClassName="text-[6px]"
                        />
                        <span className="text-[#fafafa] font-bold text-sm">{pooledQuoteDisplay(p)}</span>
                      </div>
                    </div>
                    <div className="bg-[#111113] border border-[#212225] rounded-[12px] p-3">
                      <p className="text-[#696e77] text-xs mb-1">Pooled {nonSolSymbol(p)}</p>
                      <div className="flex items-center gap-1.5">
                        <PoolRoundMint
                          mint={memeSideMint(p)}
                          symbol={symbolForMint(p, memeSideMint(p))}
                          imageUrl={poolMintImages[memeSideMint(p)]}
                          sizeClass="w-4 h-4"
                          textClassName="text-[6px]"
                        />
                        <span className="text-[#fafafa] font-bold text-sm">{pooledMemeDisplay(p)}</span>
                      </div>
                    </div>
                    <div className="bg-[#111113] border border-[#212225] rounded-[12px] p-3">
                      <p className="text-[#696e77] text-xs mb-1">Value / Share</p>
                      <p className="text-[#86efac] font-bold text-sm leading-tight">
                        {p.totalUsdValue >= 0 ? '+' : ''}
                        {p.totalUsdValue.toFixed(2)} USD
                      </p>
                      {p.totalSolEquivalent != null && Number.isFinite(p.totalSolEquivalent) ? (
                        <p className="text-[#696e77] text-xs font-semibold mt-1 leading-tight">
                          ≈ {formatCompact(p.totalSolEquivalent, 2)} SOL
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
