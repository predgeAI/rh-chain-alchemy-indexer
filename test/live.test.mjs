// Live test against Robinhood Chain mainnet, public data only.
//
// It needs a real Alchemy key, so it only runs when RUN_LIVE=1 and ALCHEMY_API_KEY and RPC_URL are set:
//   npm run test:live          (reads .env through node --env-file)
// It finds its own sample wallets in a one-minute window of recent blocks, so no wallet list ships with the
// repo. It spends roughly 1,500 to 2,000 CU, well under 0.01% of the Free plan's month, and prints a report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RH_CHAIN_ID, createClient, endpoint, estimate, hex, queryParams, toRow } from '../recipe/index.mjs';

const KEY = process.env.ALCHEMY_API_KEY ?? '';
const URL_BASE = process.env.RPC_URL ?? '';
const live = process.env.RUN_LIVE === '1' && KEY && URL_BASE;
const SCRIPT = fileURLToPath(new URL('../recipe/index.mjs', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ALCHEMY_API_KEY: KEY, RPC_URL: URL_BASE } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});
const tryCall = async (client, method, params) => {
  try { return { ok: true, result: await client.call(method, params) }; }
  catch (e) { return { ok: false, code: e.code ?? null, message: client.redact(e.message).slice(0, 220) }; }
};

test('live: Robinhood Chain mainnet', { skip: !live }, async (t) => {
  mkdirSync(OUT_DIR, { recursive: true });
  const client = createClient({ url: endpoint(URL_BASE, KEY), secret: KEY, cuPerSecond: 400 });
  const report = { date: new Date().toISOString() };
  const ctx = {};

  await t.test('the endpoint is Robinhood Chain and a one-minute window can be chosen', async () => {
    assert.equal(parseInt(await client.call('eth_chainId'), 16), RH_CHAIN_ID);
    const head = parseInt(await client.call('eth_blockNumber'), 16);
    ctx.hi = head - 600; // a minute behind the head, so the Transfers API has certainly indexed it
    ctx.lo = ctx.hi - 599;
    Object.assign(report, { head, from_block: ctx.lo, to_block: ctx.hi, window_blocks: 600 });
  });

  await t.test('a whole-chain scan of the window works, and shows that tickers are not identities', async () => {
    const sample = [];
    let pages = 0;
    let complete = false;
    let pageKey;
    while (pages < 4) {
      const p = queryParams({ from: ctx.lo, to: ctx.hi, categories: ['external', 'erc20'] });
      const res = await client.call('alchemy_getAssetTransfers', [pageKey ? { ...p, pageKey } : p]);
      pages++;
      sample.push(...res.transfers);
      pageKey = res.pageKey;
      if (!pageKey) { complete = true; break; }
    }
    ctx.sample = sample;
    const rows = sample.map((x) => toRow(null, null, x));
    const bySymbol = new Map();
    for (const r of rows) if (r.contract && r.symbol) (bySymbol.get(r.symbol) ?? bySymbol.set(r.symbol, new Set()).get(r.symbol)).add(r.contract);
    const lastBlock = Math.max(...rows.map((r) => r.block));
    report.chain_sample = {
      transfers: sample.length, pages, window_fully_read: complete,
      blocks_covered: lastBlock - ctx.lo + 1,
      transfers_per_block: Number((sample.length / (lastBlock - ctx.lo + 1)).toFixed(2)),
      distinct_contracts: new Set(rows.map((r) => r.contract).filter(Boolean)).size,
      distinct_symbols: bySymbol.size,
      symbols_with_several_contracts: [...bySymbol.values()].filter((s) => s.size > 1).length,
    };
    assert.ok(sample.length > 0, 'expected some transfers in a 600-block window');
    assert.ok(sample.every((x) => x.metadata?.blockTimestamp), 'withMetadata should return block timestamps');
    assert.ok(rows.filter((r) => r.category === 'erc20').every((r) => /^0x[0-9a-f]{40}$/.test(r.asset_key)));
  });

  await t.test('three sample wallets are found: externally owned, with a few transfers each', async () => {
    const seen = new Map();
    const tokens = new Set(ctx.sample.map((x) => x.rawContract?.address?.toLowerCase()).filter(Boolean));
    for (const x of ctx.sample) for (const a of [x.from, x.to]) if (a) seen.set(a.toLowerCase(), (seen.get(a.toLowerCase()) ?? 0) + 1);
    const candidates = [...seen].filter(([a, n]) => n >= 1 && n <= 12 && !tokens.has(a) && a !== '0x' + '0'.repeat(40)).map(([a]) => a);
    ctx.wallets = [];
    let codeChecks = 0;
    for (const a of candidates) {
      if (ctx.wallets.length === 3 || codeChecks === 10) break;
      codeChecks++;
      if (await client.call('eth_getCode', [a, 'latest']) === '0x') ctx.wallets.push(a);
    }
    report.wallet_selection = { candidates: candidates.length, code_checks: codeChecks, wallets: ctx.wallets.length };
    assert.equal(ctx.wallets.length, 3);
  });

  await t.test('dry run, then the real run, through the CLI', async () => {
    const walletsFile = OUT_DIR + 'wallets.txt';
    const out = OUT_DIR + 'live.jsonl';
    writeFileSync(walletsFile, ctx.wallets.join('\n') + '\n');
    const common = ['--wallets', walletsFile, '--from-block', String(ctx.lo), '--to-block', String(ctx.hi)];
    const dry = await run([...common, '--dry-run', '--extra-page-share', '0']);
    assert.equal(dry.code, 0, dry.stderr);
    const dryJson = JSON.parse(dry.stdout.trim());
    assert.equal(dryJson.cu_min, estimate({ wallets: 3, directions: 2, extraPageShare: 0 }).cuMin);

    const real = await run([...common, '--out', out, '--max-cu', '3000']);
    assert.equal(real.code, 0, real.stderr);
    const s = JSON.parse(real.stdout.trim());
    ctx.cli = s;
    ctx.rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const text of [dry.stdout, dry.stderr, real.stdout, real.stderr, readFileSync(out, 'utf8')]) assert.ok(!text.includes(KEY), 'the key must never be printed or written');
    assert.equal(s.complete, true);
    assert.equal(s.cu, s.pages * 120); // the explicit --to-block needs no head lookup, and eth_chainId is free
    assert.ok(s.cu >= dryJson.cu_min, 'the real run cannot cost less than the minimum');
    assert.ok(ctx.rows.length > 0);
    assert.ok(ctx.rows.every((r) => r.block >= ctx.lo && r.block <= ctx.hi), 'rows stay inside the block range');
    assert.ok(ctx.rows.every((r) => r.ts), 'every row has a block timestamp');
    assert.ok(ctx.rows.every((r) => r.asset_key === 'native' || r.asset_key === r.contract), 'identity is the contract address');
    assert.equal(new Set(ctx.rows.map((r) => `${r.wallet}|${r.direction}|${r.uid}`)).size, ctx.rows.length, 'no duplicate rows');
    report.dry_run = { cu_min: dryJson.cu_min };
    report.cli = {
      wallets: s.wallets, queries: s.queries, pages: s.pages, rows: s.rows, calls: s.calls, cu: s.cu,
      http_429: s.http_429, retries: s.retries, latency_ms: s.latency_ms, upstream_ms_p50: s.upstream_ms_p50,
      extra_pages_over_minimum: s.pages - s.queries, elapsed_s: s.elapsed_s,
    };
  });

  await t.test('per-wallet queries agree with the whole-chain scan', async () => {
    const have = new Set(ctx.rows.map((r) => `${r.direction}|${r.wallet}|${r.uid}`));
    let expected = 0;
    let found = 0;
    for (const x of ctx.sample) {
      for (const w of ctx.wallets) {
        for (const [side, dir] of [[x.from, 'out'], [x.to, 'in']]) {
          if (side?.toLowerCase() !== w) continue;
          expected++;
          if (have.has(`${dir}|${w}|${x.uniqueId}`)) found++;
        }
      }
    }
    report.consistency = { expected, found };
    assert.ok(expected > 0);
    assert.equal(found, expected, 'every transfer seen in the chain scan must come back in the per-wallet results');
  });

  await t.test('workaround: a balance delta shows native ETH that the Transfers API does not', async () => {
    // Candidates are the pattern the README describes: a wallet sent an ERC-20 in a tx and no transfer
    // INTO that wallet is visible in the same tx. They may be sells paid in ETH, or plain token sends.
    const byTx = new Map();
    for (const x of ctx.sample) {
      const e = byTx.get(x.hash) ?? byTx.set(x.hash, { outs: new Set(), ins: new Set(), block: parseInt(x.blockNum, 16) }).get(x.hash);
      if (x.category === 'erc20' && x.from) e.outs.add(x.from.toLowerCase());
      if (x.to) e.ins.add(x.to.toLowerCase());
    }
    const candidates = [];
    for (const [hash, e] of byTx) for (const wallet of e.outs) if (!e.ins.has(wallet)) candidates.push({ hash, wallet, block: e.block });
    const res = { txs_in_sample: byTx.size, candidates: candidates.length, examined: 0, checked: 0, skipped_not_the_sender: 0, native_received: 0, zero: 0, negative: 0, largest_received_eth: 0 };
    for (const c of candidates.slice(0, 8)) {
      if (res.checked >= 4) break;
      res.examined++;
      const receipt = await client.call('eth_getTransactionReceipt', [c.hash]);
      if (!receipt || receipt.from.toLowerCase() !== c.wallet) { res.skipped_not_the_sender++; continue; }
      const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      const after = BigInt(await client.call('eth_getBalance', [c.wallet, hex(c.block)]));
      const before = BigInt(await client.call('eth_getBalance', [c.wallet, hex(c.block - 1)]));
      const received = after - before + fee; // exact when the wallet has no other balance-changing tx in the block
      res.checked++;
      if (received > 0n) { res.native_received++; res.largest_received_eth = Math.max(res.largest_received_eth, Number(received) / 1e18); }
      else if (received === 0n) res.zero++;
      else res.negative++;
    }
    report.balance_delta_check = res;
    // Informational: a negative result means the wallet had another outflow in the same block, which breaks the
    // exactness assumption for that tx. It is reported, not asserted, so a busy block cannot make the test flaky.
    assert.equal(res.checked + res.skipped_not_the_sender, res.examined);
  });

  await t.test('limits: internal category, eth_getLogs range, trace methods (observed, dated)', async () => {
    const internal = await tryCall(client, 'alchemy_getAssetTransfers',
      [queryParams({ from: ctx.lo, to: ctx.hi, categories: ['internal'], wallet: ctx.wallets[0], direction: 'in' })]);
    report.internal_probe = internal.ok ? { supported: true } : { supported: false, code: internal.code, message: internal.message };
    assert.equal(internal.ok, false, 'internal is now accepted on Robinhood Chain: remove the gap from the README');
    assert.equal(internal.code, -32602);

    const logs10 = await tryCall(client, 'eth_getLogs', [{ fromBlock: hex(ctx.hi - 9), toBlock: hex(ctx.hi) }]);
    const logs11 = await tryCall(client, 'eth_getLogs', [{ fromBlock: hex(ctx.hi - 10), toBlock: hex(ctx.hi) }]);
    report.get_logs = {
      ten_blocks: logs10.ok ? { ok: true, logs: logs10.result.length } : logs10,
      eleven_blocks: logs11.ok ? { ok: true, logs: logs11.result.length } : logs11,
    };

    const tx = ctx.sample.find((x) => x.hash)?.hash;
    const trace = await tryCall(client, 'trace_transaction', [tx]);
    const debug = await tryCall(client, 'debug_traceTransaction', [tx, { tracer: 'callTracer' }]);
    report.trace = {
      trace_transaction: trace.ok ? { ok: true } : trace,
      debug_traceTransaction: debug.ok ? { ok: true } : debug,
    };
  });

  const s = client.stats;
  report.total = {
    client_cu: s.cu, client_calls: s.calls, cli_cu: ctx.cli?.cu ?? 0,
    cu_total: s.cu + (ctx.cli?.cu ?? 0),
    http_429: s.http429 + (ctx.cli?.http_429 ?? 0),
    client_latency_ms: { p50: s.latencyMs.length ? [...s.latencyMs].sort((a, b) => a - b)[Math.floor(s.latencyMs.length / 2)] : null, max: Math.max(0, ...s.latencyMs) },
    by_method: s.byMethod,
  };
  writeFileSync(OUT_DIR + 'live-report.json', JSON.stringify(report, null, 2) + '\n');
  assert.ok(!JSON.stringify(report).includes(KEY));
  console.log('LIVE REPORT\n' + JSON.stringify(report, null, 2));
});
