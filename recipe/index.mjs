#!/usr/bin/env node
// Index Robinhood Chain with Alchemy.
//
// Pages alchemy_getAssetTransfers over a block range, for a list of wallets or for the whole chain,
// and writes one JSON object per transfer (JSONL). Tokens are identified by contract address,
// never by ticker. Run with --dry-run to see the compute-unit (CU) estimate before spending any.
//
//   ALCHEMY_API_KEY  your Alchemy API key
//   RPC_URL          https://robinhood-mainnet.g.alchemy.com/v2   (the key is appended to it)
//
// Built-in modules only, no dependencies. Tested on Node 20.20; needs 20.6+ for `node --env-file`.

import { createWriteStream, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// Alchemy's published CU prices, https://www.alchemy.com/docs/reference/compute-unit-costs (checked 2026-10-03).
export const PRICES = {
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getBalance: 20,
  eth_getCode: 20,
  eth_getTransactionReceipt: 20,
  eth_getLogs: 60,
  trace_transaction: 40,
  debug_traceTransaction: 40,
  alchemy_getAssetTransfers: 120,
};
export const FREE_TIER_CU = 30_000_000; // CU per month on the Free plan
export const RH_CHAIN_ID = 4663; // Robinhood Chain mainnet, 0x1237
export const PAGE_SIZE = 1000; // maximum transfers per alchemy_getAssetTransfers page
const RATE_LIMIT_CODES = new Set([429, -32005, -32029]); // rate limits can also arrive inside a JSON-RPC error body

export class UsageError extends Error {}
export class BudgetError extends Error {}
export class RpcError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export const hex = (n) => '0x' + n.toString(16);
const unhex = (h) => (h == null ? null : parseInt(h, 16));

export function parseBlock(value, name = 'block') {
  const s = String(value).trim();
  if (s === 'latest') return 'latest';
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n)) throw new UsageError(`${name}: expected a block number (decimal or 0x...), got "${s}"`);
  return n;
}

// One address per line. Blank lines and # comments are ignored. Addresses are lower-cased and de-duplicated.
export function parseWallets(text) {
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(line)) throw new UsageError(`not an address: "${line.slice(0, 48)}"`);
    seen.add(line.toLowerCase());
  }
  return [...seen];
}

export function endpoint(rpcUrl, key) {
  const base = String(rpcUrl).replace(/\/+$/, '');
  return key && !base.endsWith(`/${key}`) ? `${base}/${key}` : base;
}

// CU estimate that spends nothing. A wallet-filtered query costs one call per direction as long as the
// range holds at most 1,000 transfers in that direction; busy wallets cost one more call per extra 1,000.
// extraPageShare is the expected share of additional pages (the README has measured values).
export function estimate({ wallets = 0, directions = 2, extraPageShare = 0.02, resolveHead = false, assumeTransfers = null } = {}) {
  const head = resolveHead ? PRICES.eth_blockNumber : 0;
  const price = PRICES.alchemy_getAssetTransfers;
  let queries, pagesMin, pagesExpected, unknownVolume = false;
  if (wallets > 0) {
    queries = wallets * directions;
    pagesMin = queries;
    pagesExpected = Math.ceil(queries * (1 + extraPageShare) - 1e-9);
  } else {
    queries = 1;
    if (assumeTransfers > 0) pagesMin = pagesExpected = Math.max(1, Math.ceil(assumeTransfers / PAGE_SIZE));
    else { pagesMin = pagesExpected = 1; unknownVolume = true; }
  }
  const cuMin = pagesMin * price + head;
  const cuExpected = pagesExpected * price + head;
  return { queries, pagesMin, pagesExpected, cuMin, cuExpected, headLookupCu: head, freeTierShare: cuExpected / FREE_TIER_CU, unknownVolume };
}

// One transfer from Alchemy -> one flat row. `asset_key` is the identity: the lower-case token contract
// address, or "native" for ETH. `symbol` is for display only; tickers are not unique on this chain.
export function toRow(wallet, direction, t) {
  const contract = t.rawContract?.address ? t.rawContract.address.toLowerCase() : null;
  return {
    wallet,
    direction,
    uid: t.uniqueId,
    tx: t.hash,
    block: unhex(t.blockNum),
    ts: t.metadata?.blockTimestamp ?? null,
    category: t.category,
    asset_key: contract ?? 'native',
    contract,
    symbol: t.asset ?? null,
    decimals: unhex(t.rawContract?.decimal),
    value: t.value ?? null,
    raw_value: t.rawContract?.value ?? null,
    token_id: t.tokenId ?? null,
    from: t.from?.toLowerCase() ?? null,
    to: t.to?.toLowerCase() ?? null,
  };
}

export function queryParams({ from, to, categories, wallet = null, direction = 'out', maxCount = PAGE_SIZE }) {
  const p = {
    fromBlock: hex(from),
    toBlock: hex(to),
    category: categories,
    withMetadata: true,
    excludeZeroValue: true,
    order: 'asc',
    maxCount: hex(maxCount),
  };
  if (wallet) p[direction === 'out' ? 'fromAddress' : 'toAddress'] = wallet;
  return p;
}

export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

// JSON-RPC client. Counts calls and CU at published prices, retries 429/5xx/network errors with backoff,
// enforces a CU budget before each request, spaces requests to stay under cuPerSecond, and never lets the
// API key appear in an error message.
export function createClient({
  url,
  secret = '',
  fetchImpl = globalThis.fetch,
  maxCu = 0,
  cuPerSecond = 0,
  maxRetries = 8,
  timeoutMs = 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const stats = { calls: 0, cu: 0, retries: 0, http429: 0, byMethod: {}, latencyMs: [], upstreamMs: [] };
  const redact = (s) => (secret ? String(s).split(secret).join('***') : String(s));
  const backoff = (attempt) => Math.min(32_000, 1000 * 2 ** attempt) + Math.random() * 1000;
  let nextAt = 0;

  async function call(method, params = []) {
    const price = PRICES[method];
    if (price === undefined) throw new UsageError(`no CU price known for ${method}`);
    if (maxCu && stats.cu + price > maxCu) throw new BudgetError(`CU budget of ${maxCu} reached (${stats.cu} used)`);
    stats.cu += price; // reserved now so parallel workers cannot overshoot; refunded below if never billed
    let billed = false;
    try {
      for (let attempt = 0; ; attempt++) {
        if (cuPerSecond && price) {
          const now = Date.now();
          const at = Math.max(now, nextAt);
          nextAt = at + (price / cuPerSecond) * 1000;
          if (at > now) await sleep(at - now);
        }
        const t0 = performance.now();
        let res;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          if (attempt >= maxRetries) throw new Error(redact(`network error: ${e.cause?.code ?? e.message}`));
          stats.retries++;
          await sleep(backoff(attempt));
          continue;
        }
        const body = await res.json().catch(() => null);
        const errText = String(body?.error?.message ?? '');
        const rateLimited = res.status === 429 || RATE_LIMIT_CODES.has(body?.error?.code)
          || /per second capacity|rate limit|too many requests/i.test(errText);
        if (rateLimited && /monthly/i.test(errText)) throw new Error(redact(`monthly capacity used up: ${errText}`)); // retrying cannot help
        if (rateLimited || res.status >= 500) {
          if (rateLimited) stats.http429++;
          if (attempt >= maxRetries) throw new Error(`HTTP ${res.status}${rateLimited ? ' (rate limited)' : ''} after ${attempt + 1} attempts`);
          stats.retries++;
          const wait = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : backoff(attempt));
          continue;
        }
        if ([401, 403, 404].includes(res.status)) {
          throw new Error(redact(`HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`));
        }
        if (!body || (res.status >= 400 && !body.error)) {
          if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
          if (attempt >= maxRetries) throw new Error('response was not JSON');
          stats.retries++;
          await sleep(backoff(attempt));
          continue;
        }
        billed = true; // a JSON-RPC error body is counted too: we do not know that Alchemy waives it
        stats.calls++;
        const m = (stats.byMethod[method] ??= { calls: 0, cu: 0 });
        m.calls++;
        m.cu += price;
        stats.latencyMs.push(Math.round(performance.now() - t0));
        const up = Number(res.headers.get('x-envoy-upstream-service-time'));
        if (Number.isFinite(up)) stats.upstreamMs.push(up);
        if (body.error) throw new RpcError(body.error.code ?? res.status, redact(body.error.message));
        return body.result;
      }
    } finally {
      if (!billed) stats.cu -= price;
    }
  }

  return { call, stats, redact };
}

// Pages one alchemy_getAssetTransfers query to the end, handing each row to `sink`.
export async function drain(client, params, wallet, direction, sink) {
  let pageKey;
  let pages = 0;
  let rows = 0;
  do {
    const res = await client.call('alchemy_getAssetTransfers', [pageKey ? { ...params, pageKey } : params]);
    pages++;
    for (const t of res.transfers ?? []) {
      sink(toRow(wallet, direction, t));
      rows++;
    }
    pageKey = res.pageKey || undefined;
  } while (pageKey);
  return { pages, rows };
}

async function pool(items, concurrency, stopped, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !stopped()) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const OPTIONS = {
  wallets: { type: 'string' },
  address: { type: 'string', multiple: true },
  'from-block': { type: 'string' },
  'to-block': { type: 'string', default: 'latest' },
  'last-blocks': { type: 'string' },
  directions: { type: 'string', default: 'out,in' },
  categories: { type: 'string', default: 'external,erc20' },
  out: { type: 'string', default: 'transfers.jsonl' },
  append: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'max-cu': { type: 'string', default: '100000' },
  'cu-per-second': { type: 'string', default: '400' },
  concurrency: { type: 'string', default: '4' },
  'extra-page-share': { type: 'string', default: '0.02' },
  'assume-transfers': { type: 'string' },
  'any-chain': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `Index Robinhood Chain with Alchemy: alchemy_getAssetTransfers -> JSONL

  node --env-file=.env recipe/index.mjs --wallets wallets.txt --from-block 78678908 --dry-run
  node --env-file=.env recipe/index.mjs --wallets wallets.txt --from-block 78678908 --out transfers.jsonl

  --wallets FILE        one address per line (# comments allowed). Without wallets the whole chain is scanned.
  --address 0x...       add one address (repeatable)
  --from-block N        first block, decimal or 0x...   (or --last-blocks N)
  --to-block N|latest   last block, default latest (resolved once at start, so paging sees a fixed range)
  --last-blocks N       the N newest blocks
  --directions out,in   which sides of each wallet to query, default out,in
  --categories LIST     default external,erc20 (internal is not supported on Robinhood Chain)
  --out FILE            JSONL output, default transfers.jsonl;  --append adds to it
  --dry-run             print the CU estimate and exit; sends nothing
  --max-cu N            stop before spending more than N CU, default 100000, 0 = no cap
  --cu-per-second N     spacing between requests, default 400 (Free plan: 500), 0 = off
  --concurrency N       parallel queries, default 4
  --extra-page-share X  dry-run only: expected share of extra pages, default 0.02
  --assume-transfers N  dry-run only, whole-chain scan: expected transfer count
  --any-chain           skip the check that the endpoint is Robinhood Chain (chain id 4663)
`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const v = parsed.values;
  const num = (name, { int = false, min = 0 } = {}) => {
    const n = Number(v[name]);
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new UsageError(`--${name}: expected a number >= ${min}`);
    return n;
  };
  const list = (name, allowed) => {
    const items = v[name].split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.length || items.some((x) => !allowed.includes(x))) throw new UsageError(`--${name}: use ${allowed.join(', ')}`);
    return items;
  };
  const opts = {
    help: v.help,
    dryRun: v['dry-run'],
    out: v.out,
    append: v.append,
    anyChain: v['any-chain'],
    directions: list('directions', ['out', 'in']),
    categories: list('categories', ['external', 'internal', 'erc20', 'erc721', 'erc1155', 'specialnft']),
    maxCu: num('max-cu', { int: true }),
    cuPerSecond: num('cu-per-second'),
    concurrency: num('concurrency', { int: true, min: 1 }),
    extraPageShare: num('extra-page-share'),
    assumeTransfers: v['assume-transfers'] === undefined ? null : num('assume-transfers', { int: true, min: 1 }),
    toBlock: parseBlock(v['to-block'], '--to-block'),
    fromBlock: v['from-block'] === undefined ? null : parseBlock(v['from-block'], '--from-block'),
    lastBlocks: v['last-blocks'] === undefined ? null : num('last-blocks', { int: true, min: 1 }),
    wallets: [],
  };
  if (opts.fromBlock === 'latest') throw new UsageError('--from-block cannot be "latest"');
  if (!opts.help) {
    if ((opts.fromBlock === null) === (opts.lastBlocks === null)) throw new UsageError('give exactly one of --from-block or --last-blocks');
    let text = '';
    if (v.wallets) {
      try {
        text = readFileSync(v.wallets, 'utf8');
      } catch {
        throw new UsageError(`cannot read --wallets file "${v.wallets}"`);
      }
    }
    opts.wallets = parseWallets(text + '\n' + (v.address ?? []).join('\n'));
    if ((v.wallets || (v.address ?? []).length) && opts.wallets.length === 0) {
      throw new UsageError('no addresses found in --wallets / --address (leave both out for a whole-chain scan)');
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { out: console.log, err: console.error }) {
  let key = '';
  let client = null;
  try {
    const o = parseCli(argv);
    if (o.help) { io.err(HELP); return 0; }
    key = env.ALCHEMY_API_KEY ?? '';
    const resolveHead = o.toBlock === 'latest';
    const est = estimate({
      wallets: o.wallets.length,
      directions: o.directions.length,
      extraPageShare: o.extraPageShare,
      resolveHead,
      assumeTransfers: o.assumeTransfers,
    });
    const mode = o.wallets.length ? 'wallets' : 'chain';

    if (o.dryRun) {
      io.err([
        `dry run: nothing is sent, 0 CU spent`,
        `  mode              ${mode === 'wallets' ? `${o.wallets.length} wallets x ${o.directions.length} direction(s)` : 'whole-chain scan'}`,
        `  queries           ${est.queries}`,
        `  pages, at least   ${est.pagesMin}  ->  ${est.cuMin.toLocaleString('en-US')} CU`,
        `  pages, expected   ${est.pagesExpected}  ->  ${est.cuExpected.toLocaleString('en-US')} CU` +
          (mode === 'wallets' ? `   (extra-page share ${o.extraPageShare})` : ''),
        `  of Free plan      ${(est.freeTierShare * 100).toFixed(2)}% of ${FREE_TIER_CU.toLocaleString('en-US')} CU / month`,
        est.unknownVolume ? '  whole-chain scans cost 120 CU per 1,000 transfers returned; pass --assume-transfers N to estimate' : '',
        o.maxCu && est.cuExpected > o.maxCu ? `  note: --max-cu ${o.maxCu} is below the estimate, so a real run would stop early; raise it or use 0` : '',
      ].filter(Boolean).join('\n'));
      io.out(JSON.stringify({
        dry_run: true, mode, wallets: o.wallets.length, queries: est.queries,
        pages_min: est.pagesMin, pages_expected: est.pagesExpected, cu_min: est.cuMin, cu_expected: est.cuExpected,
        free_tier_share: Number(est.freeTierShare.toFixed(6)), volume_unknown: est.unknownVolume,
      }));
      return 0;
    }

    if (!env.RPC_URL || !key) throw new UsageError('set RPC_URL and ALCHEMY_API_KEY (see .env.example)');
    client = createClient({ url: endpoint(env.RPC_URL, key), secret: key, maxCu: o.maxCu, cuPerSecond: o.cuPerSecond });
    const started = Date.now();

    if (!o.anyChain) {
      const id = unhex(await client.call('eth_chainId'));
      if (id !== RH_CHAIN_ID) throw new UsageError(`endpoint is chain ${id}, expected Robinhood Chain (${RH_CHAIN_ID}); use --any-chain to override`);
    }
    const to = resolveHead ? unhex(await client.call('eth_blockNumber')) : o.toBlock;
    const from = o.lastBlocks !== null ? Math.max(0, to - o.lastBlocks + 1) : o.fromBlock;
    if (from > to) throw new UsageError(`empty range: ${from} > ${to}`);

    const jobs = mode === 'wallets'
      ? o.wallets.flatMap((wallet) => o.directions.map((direction) => ({ wallet, direction })))
      : [{ wallet: null, direction: null }];
    let fatal = null;
    const file = createWriteStream(o.out, { flags: o.append ? 'a' : 'w' });
    await new Promise((resolve, reject) => {
      file.once('open', resolve);
      file.once('error', reject);
    });
    file.on('error', (e) => { fatal ??= e; });
    const contractsBySymbol = new Map();
    const contracts = new Set();
    let rows = 0;
    let pages = 0;
    let budgetHit = false;
    const sink = (row) => {
      file.write(JSON.stringify(row) + '\n');
      rows++;
      if (row.contract) {
        contracts.add(row.contract);
        if (row.symbol) (contractsBySymbol.get(row.symbol) ?? contractsBySymbol.set(row.symbol, new Set()).get(row.symbol)).add(row.contract);
      }
    };
    await pool(jobs, o.concurrency, () => budgetHit || fatal, async ({ wallet, direction }) => {
      try {
        const params = queryParams({ from, to, categories: o.categories, wallet, direction });
        const done = await drain(client, params, wallet, direction, sink);
        pages += done.pages; // not `pages += (await ...)`: that would read `pages` before the await and lose updates
      } catch (e) {
        if (e instanceof BudgetError) budgetHit = true;
        else fatal ??= e;
      }
    });
    await new Promise((resolve) => file.end(resolve));

    const s = client.stats;
    const summary = {
      ok: !fatal, complete: !fatal && !budgetHit, mode, wallets: o.wallets.length, directions: o.directions,
      categories: o.categories, from_block: from, to_block: to, next_from_block: to + 1,
      queries: jobs.length, pages, rows, calls: s.calls, cu: s.cu, http_429: s.http429, retries: s.retries,
      latency_ms: { p50: pct(s.latencyMs, 50), p95: pct(s.latencyMs, 95), max: pct(s.latencyMs, 100) },
      upstream_ms_p50: pct(s.upstreamMs, 50),
      contracts: contracts.size,
      symbols: contractsBySymbol.size,
      symbols_with_several_contracts: [...contractsBySymbol.values()].filter((c) => c.size > 1).length,
      out: o.out, elapsed_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    };
    io.err(`${summary.complete ? 'done' : budgetHit ? 'STOPPED at the CU budget, output is partial' : 'FAILED'}: ${rows} rows from ${jobs.length} queries ` +
      `(${pages} pages), ${s.cu.toLocaleString('en-US')} CU at published prices, ${s.http429} x 429, ${summary.elapsed_s}s -> ${o.out}`);
    io.out(JSON.stringify(summary));
    if (fatal) throw fatal;
    return budgetHit ? 3 : 0;
  } catch (e) {
    const msg = client ? client.redact(e.message) : String(e.message).split(key || '\u0000').join('***');
    io.err(`error: ${msg}`);
    return e instanceof UsageError ? 1 : e instanceof BudgetError ? 3 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
