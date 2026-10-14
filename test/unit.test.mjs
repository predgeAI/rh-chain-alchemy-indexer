// Offline tests: no network, no key, no CU. Run with `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BudgetError, PRICES, RpcError, UsageError, createClient, drain, endpoint, estimate, parseBlock, parseWallets,
  pct, queryParams, toRow,
} from '../recipe/index.mjs';

const SCRIPT = fileURLToPath(new URL('../recipe/index.mjs', import.meta.url));
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const TOKEN_1 = '0x' + 'c3'.repeat(20);
const TOKEN_2 = '0x' + 'd4'.repeat(20);

const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function fakeFetch(queue) {
  const sent = [];
  const f = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  };
  f.sent = sent;
  return f;
}
const transfer = (n, o = {}) => ({
  blockNum: '0x10', uniqueId: `0xtx${n}:log:${n}`, hash: `0xtx${n}`, from: A.toUpperCase().replace('0X', '0x'), to: B,
  value: 1.5, asset: 'USDG', category: 'erc20', tokenId: null,
  rawContract: { value: '0x16345785d8a0000', address: TOKEN_1.toUpperCase().replace('0X', '0x'), decimal: '0x12' },
  metadata: { blockTimestamp: '2026-10-03T00:00:00.000Z' }, ...o,
});
const noSleep = async () => {};

test('parseBlock accepts decimal, hex and latest, and rejects junk', () => {
  assert.equal(parseBlock('78678907'), 78678907);
  assert.equal(parseBlock('0x4b0b57b'), 0x4b0b57b);
  assert.equal(parseBlock('latest'), 'latest');
  assert.throws(() => parseBlock('1.5'), UsageError);
  assert.throws(() => parseBlock('abc'), UsageError);
});

test('parseWallets lower-cases, de-duplicates, skips comments and rejects junk', () => {
  const text = `# my wallets\n${A.toUpperCase().replace('0X', '0x')}\n\n${B} # trailing comment\n${A}\n`;
  assert.deepEqual(parseWallets(text), [A, B]);
  assert.throws(() => parseWallets('0x123'), UsageError);
});

test('endpoint appends the key exactly once', () => {
  assert.equal(endpoint('https://h/v2/', 'K'), 'https://h/v2/K');
  assert.equal(endpoint('https://h/v2/K', 'K'), 'https://h/v2/K');
});

test('estimate: one call per wallet per direction, priced at 120 CU', () => {
  const e = estimate({ wallets: 5699, directions: 2, extraPageShare: 0 });
  assert.equal(e.queries, 11398);
  assert.equal(e.cuMin, 11398 * 120);
  assert.equal(estimate({ wallets: 5699, directions: 2, extraPageShare: 0, resolveHead: true }).cuMin, 11398 * 120 + 10);
  assert.equal(estimate({ wallets: 3, directions: 2, extraPageShare: 0.02 }).pagesExpected, 7);
  assert.ok(Math.abs(e.freeTierShare - (11398 * 120) / 30_000_000) < 1e-12);
});

test('estimate: a whole-chain scan is priced per 1,000 transfers, and says when the volume is unknown', () => {
  assert.equal(estimate({ assumeTransfers: 2500 }).cuMin, 3 * 120);
  assert.equal(estimate({}).unknownVolume, true);
});

test('toRow: identity is the contract address; the ticker is display only', () => {
  const one = toRow(A, 'in', transfer(1));
  const two = toRow(A, 'in', transfer(2, { rawContract: { value: '0x1', address: TOKEN_2, decimal: '0x6' } }));
  assert.equal(one.symbol, two.symbol); // same ticker ...
  assert.notEqual(one.asset_key, two.asset_key); // ... different tokens
  assert.equal(one.asset_key, TOKEN_1); // lower-cased contract
  assert.equal(one.contract, TOKEN_1);
  assert.equal(one.from, A);
  assert.equal(one.decimals, 18);
  assert.equal(one.block, 16);
  assert.equal(one.raw_value, '0x16345785d8a0000');
  const eth = toRow(A, 'out', transfer(3, { category: 'external', asset: 'ETH', rawContract: { value: '0x1', address: null, decimal: '0x12' } }));
  assert.equal(eth.asset_key, 'native');
  assert.equal(eth.contract, null);
});

test('queryParams puts the wallet on the right side', () => {
  assert.equal(queryParams({ from: 1, to: 2, categories: ['erc20'], wallet: A, direction: 'out' }).fromAddress, A);
  assert.equal(queryParams({ from: 1, to: 2, categories: ['erc20'], wallet: A, direction: 'in' }).toAddress, A);
  const chain = queryParams({ from: 255, to: 256, categories: ['erc20'] });
  assert.equal(chain.fromBlock, '0xff');
  assert.equal(chain.fromAddress, undefined);
  assert.equal(chain.maxCount, '0x3e8');
});

test('drain follows pageKey and bills one call per page', async () => {
  const f = fakeFetch([
    reply({ result: { transfers: [transfer(1), transfer(2)], pageKey: 'k1' } }),
    reply({ result: { transfers: [transfer(3)], pageKey: 'k2' } }),
    reply({ result: { transfers: [transfer(4)] } }),
  ]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: noSleep });
  const rows = [];
  const out = await drain(client, queryParams({ from: 1, to: 2, categories: ['erc20'], wallet: A, direction: 'in' }), A, 'in', (r) => rows.push(r));
  assert.deepEqual(out, { pages: 3, rows: 4 });
  assert.equal(rows.length, 4);
  assert.equal(client.stats.cu, 3 * PRICES.alchemy_getAssetTransfers);
  assert.equal(f.sent[0].params[0].pageKey, undefined);
  assert.equal(f.sent[1].params[0].pageKey, 'k1');
  assert.equal(f.sent[2].params[0].pageKey, 'k2');
  assert.equal(f.sent[2].params[0].toAddress, A); // same filter on every page
});

test('client retries HTTP 429 with Retry-After and bills the request once', async () => {
  const waits = [];
  const f = fakeFetch([
    new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    reply({ result: '0x1237' }),
  ]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: async (ms) => waits.push(ms) });
  assert.equal(await client.call('eth_blockNumber'), '0x1237');
  assert.equal(client.stats.http429, 1);
  assert.equal(client.stats.retries, 1);
  assert.equal(client.stats.calls, 1);
  assert.equal(client.stats.cu, 10);
  assert.ok(waits.includes(2000));
});

test('client refunds the CU reservation when a request is never billed', async () => {
  const f = fakeFetch([new Response('nope', { status: 401 })]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: noSleep });
  await assert.rejects(client.call('alchemy_getAssetTransfers', [{}]), /HTTP 401/);
  assert.equal(client.stats.cu, 0);
  assert.equal(client.stats.calls, 0);
});

test('client retries a rate limit that arrives inside a JSON-RPC error body, and does not bill it', async () => {
  const f = fakeFetch([
    reply({ error: { code: 429, message: 'Your app has exceeded its compute units per second capacity.' } }),
    reply({ result: '0x10' }),
  ]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: noSleep });
  assert.equal(await client.call('eth_blockNumber'), '0x10');
  assert.equal(client.stats.http429, 1);
  assert.equal(client.stats.retries, 1);
  assert.equal(client.stats.cu, 10);
});

test('client fails fast when the monthly capacity is used up', async () => {
  const f = fakeFetch([reply({ error: { code: 429, message: 'Monthly capacity limit exceeded.' } }, 429)]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: noSleep });
  await assert.rejects(client.call('eth_blockNumber'), /monthly capacity used up/);
  assert.equal(client.stats.retries, 0);
  assert.equal(client.stats.cu, 0);
  assert.equal(f.sent.length, 1);
});

test('client surfaces a JSON-RPC error that arrives with HTTP 400, and counts it', async () => {
  const f = fakeFetch([reply({ error: { code: -32600, message: 'range too large' } }, 400)]);
  const client = createClient({ url: 'http://x', fetchImpl: f, sleep: noSleep });
  await assert.rejects(client.call('eth_getLogs', [{}]), (e) => e instanceof RpcError && e.code === -32600 && /range too large/.test(e.message));
  assert.equal(client.stats.cu, PRICES.eth_getLogs);
  assert.equal(client.stats.retries, 0); // a 400 is not retried
});

test('client enforces the CU budget before it sends', async () => {
  const f = fakeFetch([reply({ result: { transfers: [] } }), reply({ result: { transfers: [] } })]);
  const client = createClient({ url: 'http://x', fetchImpl: f, maxCu: 200, sleep: noSleep });
  await client.call('alchemy_getAssetTransfers', [{}]);
  await assert.rejects(client.call('alchemy_getAssetTransfers', [{}]), BudgetError);
  assert.equal(f.sent.length, 1);
  assert.equal(client.stats.cu, 120);
});

test('client keeps the API key out of error messages', async () => {
  const secret = 'sk_live_0123456789abcdef';
  const f = fakeFetch([reply({ error: { code: -32602, message: `bad request for /v2/${secret}` } })]);
  const client = createClient({ url: 'http://x', secret, fetchImpl: f, sleep: noSleep });
  await assert.rejects(client.call('alchemy_getAssetTransfers', [{}]), (e) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.code, -32602);
    assert.ok(!e.message.includes(secret));
    return true;
  });
  assert.equal(client.stats.cu, 120); // a JSON-RPC error is counted: we do not assume it is free
});

test('pct picks nearest-rank percentiles', () => {
  assert.equal(pct([5, 1, 3, 2, 4], 50), 3);
  assert.equal(pct([5, 1, 3, 2, 4], 100), 5);
  assert.equal(pct([], 50), null);
});

// ---- CLI, end to end, against a local mock of the Alchemy endpoint ----

function mockAlchemy({ key, chainId = '0x1237', pagesByQuery }) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw);
      requests.push({ url: req.url, ...msg });
      res.setHeader('content-type', 'application/json');
      if (req.url !== `/v2/${key}`) { res.statusCode = 401; return res.end('{}'); }
      if (msg.method === 'eth_chainId') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chainId }));
      if (msg.method === 'eth_blockNumber') return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3e8' }));
      const p = msg.params[0];
      const who = p.fromAddress ? `out:${p.fromAddress}` : p.toAddress ? `in:${p.toAddress}` : 'chain';
      const pages = pagesByQuery[who] ?? [[]];
      const idx = p.pageKey ? Number(p.pageKey.slice(1)) : 0;
      const result = { transfers: pages[idx], ...(idx + 1 < pages.length ? { pageKey: `p${idx + 1}` } : {}) };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}
const runCli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

test('CLI dry run sends nothing and prints the estimate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-recipe-'));
  const wallets = join(dir, 'wallets.txt');
  writeFileSync(wallets, `${A}\n${B}\n`);
  const out = join(dir, 'out.jsonl');
  // Port 9 is closed: any request would fail, so a successful dry run proves none was made.
  const r = await runCli(['--dry-run', '--wallets', wallets, '--from-block', '100', '--out', out],
    { RPC_URL: 'http://127.0.0.1:9/v2', ALCHEMY_API_KEY: 'dummy' });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.dry_run, true);
  assert.equal(j.queries, 4);
  assert.equal(j.cu_min, 4 * 120 + 10); // four queries plus the eth_blockNumber that resolves "latest"
  assert.ok(r.stderr.includes('nothing is sent'));
  assert.equal(existsSync(out), false);
});

test('CLI does not turn an empty wallet file into a whole-chain scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rh-recipe-'));
  const empty = join(dir, 'empty.txt');
  writeFileSync(empty, '# nothing here\n');
  const r = await runCli(['--dry-run', '--wallets', empty, '--from-block', '1'], {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no addresses found/);
});

test('CLI needs exactly one of --from-block / --last-blocks', async () => {
  const r = await runCli(['--dry-run'], {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--from-block or --last-blocks/);
});

test('CLI end to end: pages, JSONL, summary, --append, and a key that never leaks', async () => {
  const key = 'k_test_secret_0123456789';
  const { server, requests, port } = await mockAlchemy({
    key,
    pagesByQuery: {
      [`out:${A}`]: [[transfer(1)], [transfer(2)]], // two pages
      [`in:${A}`]: [[transfer(3, { category: 'external', asset: 'ETH', rawContract: { value: '0x1', address: null, decimal: '0x12' } })]],
      [`out:${B}`]: [[]],
      [`in:${B}`]: [[transfer(4, { rawContract: { value: '0x1', address: TOKEN_2, decimal: '0x6' } })]],
    },
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), 'rh-recipe-'));
    const out = join(dir, 'out.jsonl');
    const env = { RPC_URL: `http://127.0.0.1:${port}/v2`, ALCHEMY_API_KEY: key };
    const args = ['--address', A, '--address', B, '--from-block', '10', '--to-block', '20', '--out', out, '--cu-per-second', '0'];
    const r = await runCli(args, env);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout.trim());
    assert.equal(s.complete, true);
    assert.equal(s.queries, 4);
    assert.equal(s.pages, 5);
    assert.equal(s.rows, 4);
    assert.equal(s.cu, 5 * 120); // chain id is free, the explicit --to-block needs no head lookup
    assert.equal(s.next_from_block, 21);
    assert.equal(s.contracts, 2);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 4);
    assert.ok(lines.every((l) => l.asset_key === 'native' || /^0x[0-9a-f]{40}$/.test(l.asset_key)));
    // request shape
    const queries = requests.filter((q) => q.method === 'alchemy_getAssetTransfers');
    assert.equal(queries.length, 5);
    assert.ok(queries.every((q) => q.params[0].withMetadata === true && q.params[0].maxCount === '0x3e8'));
    assert.deepEqual(queries[0].params[0].category, ['external', 'erc20']);
    assert.equal(queries.filter((q) => q.params[0].pageKey).length, 1);
    // append mode adds to the file
    const r2 = await runCli([...args, '--append'], env);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 8);
    // the key is in the URL only
    for (const text of [r.stdout, r.stderr, r2.stdout, r2.stderr, readFileSync(out, 'utf8')]) assert.ok(!text.includes(key));
  } finally {
    server.close();
  }
});

test('CLI stops at the CU budget with exit code 3 and partial output', async () => {
  const key = 'k_test_secret_budget';
  const { server, port } = await mockAlchemy({ key, pagesByQuery: { [`out:${A}`]: [[transfer(1)]], [`in:${A}`]: [[transfer(2)]], [`out:${B}`]: [[transfer(3)]], [`in:${B}`]: [[transfer(4)]] } });
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'rh-recipe-')), 'out.jsonl');
    const r = await runCli(['--address', A, '--address', B, '--from-block', '1', '--to-block', '9', '--out', out, '--max-cu', '250', '--concurrency', '1', '--cu-per-second', '0'],
      { RPC_URL: `http://127.0.0.1:${port}/v2`, ALCHEMY_API_KEY: key });
    assert.equal(r.code, 3);
    const s = JSON.parse(r.stdout.trim());
    assert.equal(s.complete, false);
    assert.equal(s.cu, 240); // two calls fit under 250 CU, the third would not
    assert.equal(s.rows, 2);
  } finally {
    server.close();
  }
});

test('CLI refuses an endpoint that is not Robinhood Chain', async () => {
  const key = 'k_test_secret_chain';
  const { server, port } = await mockAlchemy({ key, chainId: '0x1', pagesByQuery: {} });
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'rh-recipe-')), 'out.jsonl');
    const r = await runCli(['--address', A, '--from-block', '1', '--to-block', '9', '--out', out],
      { RPC_URL: `http://127.0.0.1:${port}/v2`, ALCHEMY_API_KEY: key });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /expected Robinhood Chain \(4663\)/);
    assert.equal(existsSync(out), false);
  } finally {
    server.close();
  }
});
