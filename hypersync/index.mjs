#!/usr/bin/env node
// Index Robinhood Chain with HyperSync.
//
// A sibling of ../recipe/index.mjs: same wallets, same categories (external, erc20), same JSONL row
// fields, but the data comes from HyperSync (@envio-dev/hypersync-client) instead of
// alchemy_getAssetTransfers. A wallet list is one filtered stream, not two calls per wallet.
//
//   ENVIO_API_TOKEN  free token from https://envio.dev/app/api-tokens
//   HYPERSYNC_URL    default https://4663.hypersync.xyz
//   RPC_URL          default https://rpc.mainnet.chain.robinhood.com; only used for token symbol() / decimals()

import { createWriteStream, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const RH_CHAIN_ID = 4663;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SYMBOL = '0x95d89b41';
const DECIMALS = '0x313ce567';

export class UsageError extends Error {}

export const hex = (n) => '0x' + n.toString(16);
const pad = (addr) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const unpad = (topic) => '0x' + topic.slice(-40).toLowerCase();

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

// Wallet-side filters. Out: topic1 (from) or tx.from. In: topic2 (to) or tx.to.
export function buildQuery({ from, toInclusive, wallets, directions, categories }) {
  const q = {
    fromBlock: from,
    toBlock: toInclusive + 1, // HyperSync's toBlock is exclusive
    joinMode: 2, // JoinNothing: return only the logs and transactions that match, not everything in their transactions/blocks
    logs: [],
    transactions: [],
    fieldSelection: {
      block: ['Number', 'Timestamp'],
      log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Address', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3'],
      transaction: ['BlockNumber', 'Hash', 'From', 'To', 'Value', 'Status'],
    },
  };
  const padded = wallets.map(pad);
  if (categories.includes('erc20')) {
    if (directions.includes('out')) q.logs.push({ topics: [[TRANSFER_TOPIC], padded] });
    if (directions.includes('in')) q.logs.push({ topics: [[TRANSFER_TOPIC], [], padded] });
  }
  if (categories.includes('external')) {
    if (directions.includes('out')) q.transactions.push({ from: wallets });
    if (directions.includes('in')) q.transactions.push({ to: wallets });
  }
  if (!q.logs.length) delete q.logs;
  if (!q.transactions.length) delete q.transactions;
  return q;
}

const formatUnits = (raw, decimals) => {
  if (decimals == null) return null;
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return Number(frac ? `${whole}.${frac}` : whole);
};

// A Transfer log -> up to two rows (one per wallet side). ERC-721 transfers have four topics and are skipped.
export function logToRows(log, ts, wallets, directions, meta) {
  const [topic0, topic1, topic2, topic3] = log.topics ?? [];
  if (topic0 !== TRANSFER_TOPIC || !topic1 || !topic2 || topic3) return [];
  if (!log.data || log.data.length !== 66) return [];
  const raw = BigInt(log.data);
  if (raw === 0n) return []; // Alchemy's excludeZeroValue, on by default
  const from = unpad(topic1);
  const to = unpad(topic2);
  const contract = log.address.toLowerCase();
  const m = meta.get(contract) ?? { symbol: null, decimals: null };
  const base = {
    uid: `${log.transactionHash}:log:${log.logIndex}`,
    tx: log.transactionHash,
    block: log.blockNumber,
    ts,
    category: 'erc20',
    asset_key: contract,
    contract,
    symbol: m.symbol,
    decimals: m.decimals,
    value: formatUnits(raw, m.decimals),
    raw_value: hex(raw),
    token_id: null,
    from,
    to,
  };
  const rows = [];
  if (directions.includes('out') && wallets.has(from)) rows.push({ wallet: from, direction: 'out', ...base });
  if (directions.includes('in') && wallets.has(to)) rows.push({ wallet: to, direction: 'in', ...base });
  return rows;
}

// A top-level ETH transfer -> up to two rows. Failed transactions move no ETH and are skipped.
export function txToRows(tx, ts, wallets, directions) {
  if (!tx.to || tx.status !== 1) return [];
  const raw = BigInt(tx.value || '0x0');
  if (raw === 0n) return [];
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const base = {
    uid: `${tx.hash}:external`,
    tx: tx.hash,
    block: tx.blockNumber,
    ts,
    category: 'external',
    asset_key: 'native',
    contract: null,
    symbol: 'ETH',
    decimals: 18,
    value: formatUnits(raw, 18),
    raw_value: hex(raw),
    token_id: null,
    from,
    to,
  };
  const rows = [];
  if (directions.includes('out') && wallets.has(from)) rows.push({ wallet: from, direction: 'out', ...base });
  if (directions.includes('in') && wallets.has(to)) rows.push({ wallet: to, direction: 'in', ...base });
  return rows;
}

// ABI-decode a string or bytes32 return value.
export function decodeString(h) {
  if (!h || h === '0x') return null;
  const b = Buffer.from(h.slice(2), 'hex');
  try {
    if (b.length === 32) return b.toString('utf8').replace(/\0+$/, '') || null;
    const off = Number(BigInt('0x' + b.subarray(0, 32).toString('hex')));
    const len = Number(BigInt('0x' + b.subarray(off, off + 32).toString('hex')));
    return b.subarray(off + 32, off + 32 + len).toString('utf8') || null;
  } catch {
    return null;
  }
}

// symbol() and decimals() for each token, in JSON-RPC batches. Failures become null, like a token with no metadata.
export async function fetchTokenMeta(rpcUrl, contracts, { fetchImpl = globalThis.fetch, batch = 25, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const meta = new Map();
  const list = [...contracts];
  for (let i = 0; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch);
    const body = slice.flatMap((c, j) => [
      { jsonrpc: '2.0', id: j * 2, method: 'eth_call', params: [{ to: c, data: SYMBOL }, 'latest'] },
      { jsonrpc: '2.0', id: j * 2 + 1, method: 'eth_call', params: [{ to: c, data: DECIMALS }, 'latest'] },
    ]);
    let out = null;
    for (let attempt = 0; attempt < 12 && !out; attempt++) {
      try {
        const res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const json = res.ok ? await res.json() : null;
        if (Array.isArray(json) && !json.some((r) => r.error?.code === 429)) out = json;
      } catch { /* retry */ }
      if (!out) await sleep(Math.min(30_000, 500 * 2 ** attempt));
    }
    if (!out) throw new Error(`token metadata: ${rpcUrl} kept failing`);
    const byId = new Map(out.map((r) => [r.id, r.result]));
    slice.forEach((c, j) => {
      const d = byId.get(j * 2 + 1);
      meta.set(c, { symbol: decodeString(byId.get(j * 2)), decimals: d && d !== '0x' ? Number(BigInt(d)) : null });
    });
  }
  return meta;
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
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `Index Robinhood Chain with HyperSync -> JSONL (same rows as ../recipe/index.mjs)

  node --env-file=.env hypersync/index.mjs --wallets wallets.txt --from-block 78678908 --out transfers.jsonl

  --wallets FILE        one address per line (# comments allowed). Required.
  --address 0x...       add one address (repeatable)
  --from-block N        first block, decimal or 0x...   (or --last-blocks N)
  --to-block N|latest   last block, inclusive, default latest (resolved once at start)
  --last-blocks N       the N newest blocks
  --directions out,in   which sides of each wallet, default out,in
  --categories LIST     external, erc20 (default both). internal is not available on this chain via HyperSync.
  --out FILE            JSONL output, default transfers.jsonl;  --append adds to it
`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const v = parsed.values;
  const list = (name, allowed) => {
    const items = v[name].split(',').map((s) => s.trim()).filter(Boolean);
    if (name === 'categories' && items.includes('internal')) {
      throw new UsageError('internal transfers need traces, and HyperSync has none for chain 4663 (checked 2026-10-30); see README');
    }
    if (!items.length || items.some((x) => !allowed.includes(x))) throw new UsageError(`--${name}: use ${allowed.join(', ')}`);
    return items;
  };
  const opts = {
    help: v.help,
    out: v.out,
    append: v.append,
    directions: list('directions', ['out', 'in']),
    categories: list('categories', ['external', 'erc20']),
    toBlock: parseBlock(v['to-block'], '--to-block'),
    fromBlock: v['from-block'] === undefined ? null : parseBlock(v['from-block'], '--from-block'),
    lastBlocks: v['last-blocks'] === undefined ? null : Number(v['last-blocks']),
    wallets: [],
  };
  if (opts.fromBlock === 'latest') throw new UsageError('--from-block cannot be "latest"');
  if (!opts.help) {
    if ((opts.fromBlock === null) === (opts.lastBlocks === null)) throw new UsageError('give exactly one of --from-block or --last-blocks');
    if (opts.lastBlocks !== null && !(Number.isInteger(opts.lastBlocks) && opts.lastBlocks >= 1)) throw new UsageError('--last-blocks: expected an integer >= 1');
    let text = '';
    if (v.wallets) {
      try {
        text = readFileSync(v.wallets, 'utf8');
      } catch {
        throw new UsageError(`cannot read --wallets file "${v.wallets}"`);
      }
    }
    opts.wallets = parseWallets(text + '\n' + (v.address ?? []).join('\n'));
    if (!opts.wallets.length) throw new UsageError('give --wallets FILE or --address 0x...');
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { out: console.log, err: console.error }) {
  const token = env.ENVIO_API_TOKEN ?? '';
  try {
    const o = parseCli(argv);
    if (o.help) { io.err(HELP); return 0; }
    if (!token) throw new UsageError('set ENVIO_API_TOKEN (free: https://envio.dev/app/api-tokens)');
    const { HypersyncClient } = await import('@envio-dev/hypersync-client');
    const client = new HypersyncClient({ url: env.HYPERSYNC_URL ?? 'https://4663.hypersync.xyz', apiToken: token });
    const started = Date.now();

    const chainId = await client.getChainId();
    if (chainId !== RH_CHAIN_ID) throw new UsageError(`endpoint is chain ${chainId}, expected Robinhood Chain (${RH_CHAIN_ID})`);
    const to = o.toBlock === 'latest' ? await client.getHeight() : o.toBlock;
    const from = o.lastBlocks !== null ? Math.max(0, to - o.lastBlocks + 1) : o.fromBlock;
    if (from > to) throw new UsageError(`empty range: ${from} > ${to}`);

    const query = buildQuery({ from, toInclusive: to, wallets: o.wallets, directions: o.directions, categories: o.categories });
    const walletSet = new Set(o.wallets);
    const tsByBlock = new Map();
    const logs = [];
    const txs = [];
    const tStream = Date.now();
    const stream = await client.stream(query, {});
    let batches = 0;
    for (;;) {
      const res = await stream.recv();
      if (!res) break;
      batches++;
      logs.push(...res.data.logs);
      txs.push(...res.data.transactions);
    }
    // Block timestamps come from a second, light stream (number + timestamp only).
    const blockStream = await client.stream({ fromBlock: from, toBlock: to + 1, includeAllBlocks: true, fieldSelection: { block: ['Number', 'Timestamp'] } }, {});
    for (;;) {
      const res = await blockStream.recv();
      if (!res) break;
      for (const b of res.data.blocks) tsByBlock.set(b.number, new Date(Number(BigInt(b.timestamp)) * 1000).toISOString());
    }
    const streamS = Number(((Date.now() - tStream) / 1000).toFixed(1));
    io.err(`stream: ${logs.length} logs, ${txs.length} transactions in ${streamS}s`);
    const tMeta = Date.now();
    const meta = await fetchTokenMeta(env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', new Set(logs.filter((l) => l.topics?.[0] === TRANSFER_TOPIC && l.topics[1] && l.topics[2] && !l.topics[3] && (walletSet.has(unpad(l.topics[1])) || walletSet.has(unpad(l.topics[2])))).map((l) => l.address.toLowerCase())));
    const metaS = Number(((Date.now() - tMeta) / 1000).toFixed(1));
    const file = createWriteStream(o.out, { flags: o.append ? 'a' : 'w' });
    await new Promise((resolve, reject) => { file.once('open', resolve); file.once('error', reject); });
    let rows = 0;
    const write = (r) => { file.write(JSON.stringify(r) + '\n'); rows++; };
    const seen = new Set();
    for (const l of logs) {
      for (const r of logToRows(l, tsByBlock.get(l.blockNumber) ?? null, walletSet, o.directions, meta)) {
        const k = `${r.wallet}|${r.direction}|${r.uid}`;
        if (!seen.has(k)) { seen.add(k); write(r); }
      }
    }
    for (const t of txs) {
      for (const r of txToRows(t, tsByBlock.get(t.blockNumber) ?? null, walletSet, o.directions)) {
        const k = `${r.wallet}|${r.direction}|${r.uid}`;
        if (!seen.has(k)) { seen.add(k); write(r); }
      }
    }
    await new Promise((resolve) => file.end(resolve));

    const elapsed = Number(((Date.now() - started) / 1000).toFixed(1));
    const summary = {
      ok: true, wallets: o.wallets.length, directions: o.directions, categories: o.categories,
      from_block: from, to_block: to, next_from_block: to + 1, batches, logs: logs.length, transactions: txs.length,
      rows, tokens: meta.size, stream_s: streamS, token_meta_s: metaS, out: o.out, elapsed_s: elapsed,
    };
    io.err(`done: ${rows} rows for ${o.wallets.length} wallets, blocks ${from}-${to}, ${batches} batches, ${elapsed}s -> ${o.out}`);
    io.out(JSON.stringify(summary));
    return 0;
  } catch (e) {
    io.err(`error: ${String(e.message).split(token || '\u0000').join('***')}`);
    return e instanceof UsageError ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
