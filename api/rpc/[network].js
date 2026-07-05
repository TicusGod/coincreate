import {
  getServerRpcUrl,
  readRawBody,
  relayUpstreamResponse,
  rejectCrossSite,
  sendJson,
  takeRateLimit,
} from '../_serverUtil.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const ALLOWED_RPC_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlock',
  'getBlockHeight',
  'getBlockTime',
  'getBlocks',
  'getEpochInfo',
  'getFeeForMessage',
  'getGenesisHash',
  'getHealth',
  'getIdentity',
  'getLatestBlockhash',
  'getLatestBlockhashAndContext',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getParsedAccountInfo',
  'getParsedProgramAccounts',
  'getParsedTokenAccountsByOwner',
  'getParsedTransaction',
  'getProgramAccounts',
  'getProgramAccountsV2',
  'getRecentPerformanceSamples',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getSlot',
  'getSupply',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getTransaction',
  'getTransactionCount',
  'getVersion',
  'isBlockhashValid',
  'sendTransaction',
  'simulateTransaction',
]);

const HEAVY_RPC_METHODS = new Set([
  'getProgramAccounts',
  'getProgramAccountsV2',
  'getParsedProgramAccounts',
  'getTokenAccountsByOwner',
  'getParsedTokenAccountsByOwner',
  'getMultipleAccounts',
  'getSignaturesForAddress',
]);

const TX_RPC_METHODS = new Set(['sendTransaction', 'simulateTransaction']);

function extractRpcMethods(payload) {
  const rows = Array.isArray(payload) ? payload : [payload];
  const methods = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.method !== 'string') {
      throw new Error('Invalid JSON-RPC payload');
    }
    methods.push(row.method);
  }

  return methods;
}

function rateLimitCost(methods) {
  return methods.reduce((sum, method) => {
    if (TX_RPC_METHODS.has(method)) return sum + 20;
    if (HEAVY_RPC_METHODS.has(method)) return sum + 10;
    return sum + 1;
  }, 0);
}

export default async function rpcProxy(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  if (rejectCrossSite(req, res)) return;

  let rawBody;
  let payload;
  let methods;

  try {
    rawBody = await readRawBody(req, 2 * 1024 * 1024);
    payload = JSON.parse(rawBody.toString('utf8'));
    methods = extractRpcMethods(payload);
  } catch (error) {
    return sendJson(res, 400, {
      error: 'invalid_rpc_payload',
      message: error instanceof Error ? error.message : 'Could not parse JSON-RPC body',
    });
  }

  for (const method of methods) {
    if (!ALLOWED_RPC_METHODS.has(method)) {
      return sendJson(res, 403, { error: 'rpc_method_blocked', method });
    }
  }

  const limited = takeRateLimit(req, `rpc:${req.query.network}`, {
    limit: 1200,
    windowMs: 60_000,
    cost: rateLimitCost(methods),
  });
  if (!limited.ok) {
    res.setHeader('Retry-After', String(limited.retryAfterSeconds));
    return sendJson(res, 429, { error: 'rate_limited', retryAfter: limited.retryAfterSeconds });
  }

  let upstreamUrl;
  try {
    upstreamUrl = getServerRpcUrl(req.query.network);
  } catch (error) {
    return sendJson(res, 500, {
      error: 'rpc_not_configured',
      message: error instanceof Error ? error.message : 'RPC is not configured',
    });
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: rawBody,
      redirect: 'follow',
    });
    return await relayUpstreamResponse(res, upstream);
  } catch {
    return sendJson(res, 502, { error: 'rpc_upstream_failed' });
  }
}
