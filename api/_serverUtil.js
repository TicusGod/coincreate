const rateBuckets = globalThis.__createcoinRateBuckets ?? new Map();
globalThis.__createcoinRateBuckets = rateBuckets;

export function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export function sendJson(res, status, payload) {
  setNoStore(res);
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(payload);
}

export function normalizePriceApiUrl(raw) {
  const trimmed = String(raw || 'https://api.jup.ag/price/v3').trim().replace(/\/$/, '');
  return trimmed.replace(/\/price\/v2$/i, '/price/v3');
}

function readServerEnv(name) {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? undefined : String(raw).trim();
}

export function requireHttpsUrlEnv(name) {
  const value = readServerEnv(name);
  if (!value) {
    throw new Error(`Missing required server env ${name}.`);
  }
  if (!value.startsWith('https://')) {
    throw new Error(`${name} must use https://`);
  }
  if (value.includes('YOUR_KEY')) {
    throw new Error(`${name} still contains YOUR_KEY.`);
  }
  new URL(value);
  return value;
}

export function getServerRpcUrl(network) {
  if (network === 'mainnet-beta') return requireHttpsUrlEnv('SOLANA_RPC_URL_MAINNET');
  if (network === 'devnet') return requireHttpsUrlEnv('SOLANA_RPC_URL_DEVNET');
  throw new Error(`Unsupported Solana network: ${network}`);
}

export function getServerPinataJwt() {
  const jwt = readServerEnv('PINATA_JWT');
  if (!jwt) throw new Error('Missing required server env PINATA_JWT.');
  return jwt;
}

export function getServerPumpfunAuth() {
  return readServerEnv('PUMPFUN_AUTH');
}

export function getServerPriceApi() {
  return normalizePriceApiUrl(readServerEnv('PRICE_API'));
}

export function getServerJupiterPriceApiKey() {
  return readServerEnv('JUPITER_PRICE_API_KEY');
}

function normalizeHost(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutWww = trimmed.replace(/^www\./, '');
  try {
    return new URL(`https://${withoutWww}`).hostname.replace(/^www\./, '');
  } catch {
    return withoutWww.split(':')[0] || null;
  }
}

export function rejectCrossSite(req, res) {
  void req;
  void res;
  // Emergency recovery: do not block browser requests on host/origin matching.
  // Server-side secrets remain protected because they never leave /api, and abuse
  // is still constrained by per-endpoint method allowlists and rate limits.
  return false;
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(',')[0].trim();
  }
  return 'unknown';
}

export function takeRateLimit(req, bucketName, { limit, windowMs, cost = 1 }) {
  const now = Date.now();
  const key = `${bucketName}:${getClientIp(req)}`;
  const current = rateBuckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };

  if (bucket.count + cost > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }

  bucket.count += cost;
  rateBuckets.set(key, bucket);
  return { ok: true, remaining: Math.max(0, limit - bucket.count) };
}

export async function readRawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

export async function relayUpstreamResponse(res, upstream) {
  const body = Buffer.from(await upstream.arrayBuffer());
  setNoStore(res);

  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);

  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);

  return res.status(upstream.status).send(body);
}
