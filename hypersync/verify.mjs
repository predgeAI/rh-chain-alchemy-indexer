#!/usr/bin/env node
// Check index.mjs output against a second source: the public Robinhood Chain RPC.
// For each block in the range it reads eth_getBlockByNumber(full) and eth_getBlockReceipts, rebuilds the
// same rows, and compares them with the JSONL from index.mjs field by field. Needs no key.
//
//   node hypersync/verify.mjs --jsonl transfers.jsonl --wallets wallets.txt --from-block N --to-block M
//   add --cache FILE to keep the RPC data between runs, and --top-active K to also print the K busiest non-router addresses in the range (a good wallet list for a test)
//
// Keep ranges to a few thousand blocks: the public RPC is rate limited.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fetchTokenMeta, logToRows, txToRows, parseWallets, hex, TRANSFER_TOPIC } from './index.mjs';

const RPC = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function batch(calls) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) });
      const json = res.ok ? await res.json() : null;
      if (Array.isArray(json) && json.length === calls.length && !json.some((r) => r.error)) return json.sort((a, b) => a.id - b.id).map((r) => r.result);
    } catch { /* retry */ }
    await sleep(1500 * 2 ** Math.min(attempt, 3));
  }
  throw new Error('public RPC kept failing');
}

export async function readRange(from, to, step = 5, concurrency = 1) {
  const blocks = [];
  for (let b = from; b <= to; b += step) blocks.push(b);
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < blocks.length) {
      const start = blocks[i++];
      const nums = Array.from({ length: Math.min(step, to - start + 1) }, (_, k) => start + k);
      const calls = nums.flatMap((n, k) => [
        { jsonrpc: '2.0', id: k * 2, method: 'eth_getBlockByNumber', params: [hex(n), true] },
        { jsonrpc: '2.0', id: k * 2 + 1, method: 'eth_getBlockReceipts', params: [hex(n)] },
      ]);
      const res = await batch(calls);
      await sleep(Number(process.env.PACE_MS ?? 1000)); // the public RPC answers 429 after a couple of calls in a row
      nums.forEach((n, k) => out.push({ n, block: res[k * 2], receipts: res[k * 2 + 1] }));
    }
  }));
  return out.sort((a, b) => a.n - b.n);
}

const num = (h) => parseInt(h, 16);

export function referenceRows(data, wallets, directions, meta) {
  const walletSet = new Set(wallets);
  const rows = [];
  for (const { block, receipts } of data) {
    const ts = new Date(num(block.timestamp) * 1000).toISOString();
    const status = new Map(receipts.map((r) => [r.transactionHash, num(r.status)]));
    for (const t of block.transactions) {
      rows.push(...txToRows({ hash: t.hash, from: t.from, to: t.to, value: t.value, status: status.get(t.hash), blockNumber: num(block.number) }, ts, walletSet, directions));
    }
    for (const r of receipts) for (const l of r.logs) {
      rows.push(...logToRows({
        blockNumber: num(l.blockNumber), logIndex: num(l.logIndex), transactionHash: l.transactionHash, address: l.address,
        data: l.data, topics: l.topics,
      }, ts, walletSet, directions, meta));
    }
  }
  return rows;
}

const key = (r) => `${r.wallet}|${r.direction}|${r.uid}`;

export function compare(mine, ref) {
  const a = new Map(mine.map((r) => [key(r), r]));
  const b = new Map(ref.map((r) => [key(r), r]));
  const onlyMine = [...a.keys()].filter((k) => !b.has(k));
  const onlyRef = [...b.keys()].filter((k) => !a.has(k));
  let fieldDiffs = 0, fields = 0;
  const examples = [];
  for (const [k, r] of a) {
    const o = b.get(k);
    if (!o) continue;
    for (const f of Object.keys(o)) {
      fields++;
      if (JSON.stringify(r[f]) !== JSON.stringify(o[f])) { fieldDiffs++; if (examples.length < 5) examples.push({ k, f, mine: r[f], ref: o[f] }); }
    }
  }
  return { mine: a.size, ref: b.size, matched: a.size - onlyMine.length, onlyMine, onlyRef, fields, fieldDiffs, examples };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values: v } = parseArgs({ options: {
    jsonl: { type: 'string' }, wallets: { type: 'string' }, 'from-block': { type: 'string' }, 'to-block': { type: 'string' },
    directions: { type: 'string', default: 'out,in' }, 'top-active': { type: 'string' }, cache: { type: 'string' },
  } });
  const from = Number(v['from-block']), to = Number(v['to-block']);
  let data;
  if (v.cache && existsSync(v.cache)) data = JSON.parse(readFileSync(v.cache, 'utf8'));
  else {
    data = await readRange(from, to);
    if (v.cache) writeFileSync(v.cache, JSON.stringify(data)); // saves re-reading the public RPC for a second wallet list
  }
  const directions = v.directions.split(',');
  if (v['top-active']) {
    const cnt = new Map();
    const bump = (a) => cnt.set(a, (cnt.get(a) ?? 0) + 1);
    for (const { block, receipts } of data) {
      for (const t of block.transactions) { bump(t.from.toLowerCase()); if (t.to) bump(t.to.toLowerCase()); }
      for (const r of receipts) for (const l of r.logs) if (l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3) { bump('0x' + l.topics[1].slice(-40)); bump('0x' + l.topics[2].slice(-40)); }
    }
    const top = [...cnt.entries()].sort((x, y) => y[1] - x[1]).slice(20, 20 + Number(v['top-active'])).map((e) => e[0]);
    console.log(top.join('\n'));
    process.exit(0);
  }
  const wallets = parseWallets(readFileSync(v.wallets, 'utf8'));
  const contracts = new Set();
  for (const { receipts } of data) for (const r of receipts) for (const l of r.logs) if (l.topics[0] === TRANSFER_TOPIC) contracts.add(l.address.toLowerCase());
  const meta = await fetchTokenMeta(RPC, contracts);
  const ref = referenceRows(data, wallets, directions, meta);
  const mine = readFileSync(v.jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = compare(mine, ref);
  console.log(JSON.stringify({ blocks: to - from + 1, wallets: wallets.length, rows_index: r.mine, rows_reference: r.ref, matched: r.matched,
    only_in_index: r.onlyMine.length, only_in_reference: r.onlyRef.length, field_values_compared: r.fields, field_diffs: r.fieldDiffs,
    examples: r.examples, missing_examples: r.onlyRef.slice(0, 3), extra_examples: r.onlyMine.slice(0, 3) }, null, 1));
}
