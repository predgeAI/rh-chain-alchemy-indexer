import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, logToRows, txToRows, decodeString, parseWallets, parseBlock, fetchTokenMeta, main, TRANSFER_TOPIC } from '../index.mjs';
import { compare } from '../verify.mjs';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const TOKEN = '0x' + 'd'.repeat(40);
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const meta = new Map([[TOKEN, { symbol: 'USDG', decimals: 6 }]]);
const log = (over = {}) => ({
  blockNumber: 10, logIndex: 4, transactionHash: '0xtx', address: TOKEN,
  topics: [TRANSFER_TOPIC, pad(A), pad(B)], data: '0x' + (170194).toString(16).padStart(64, '0'), ...over,
});

test('parseWallets lower-cases, de-duplicates and rejects junk', () => {
  assert.deepEqual(parseWallets(`${A.toUpperCase().replace('0X', '0x')}  # note\n\n${A}\n`), [A]);
  assert.throws(() => parseWallets('0x123'));
});

test('parseBlock takes decimal, hex and latest', () => {
  assert.equal(parseBlock('0x10'), 16);
  assert.equal(parseBlock('latest'), 'latest');
  assert.throws(() => parseBlock('abc'));
});

test('buildQuery: one stream for the whole wallet list, toBlock exclusive', () => {
  const q = buildQuery({ from: 5, toInclusive: 9, wallets: [A, B], directions: ['out', 'in'], categories: ['external', 'erc20'] });
  assert.equal(q.toBlock, 10);
  assert.equal(q.logs.length, 2);
  assert.deepEqual(q.logs[0].topics, [[TRANSFER_TOPIC], [pad(A), pad(B)]]);
  assert.deepEqual(q.logs[1].topics, [[TRANSFER_TOPIC], [], [pad(A), pad(B)]]);
  assert.deepEqual(q.transactions, [{ from: [A, B] }, { to: [A, B] }]);
});

test('buildQuery leaves out unused selections', () => {
  const q = buildQuery({ from: 1, toInclusive: 2, wallets: [A], directions: ['in'], categories: ['erc20'] });
  assert.equal(q.logs.length, 1);
  assert.equal(q.transactions, undefined);
});

test('logToRows: a transfer between two wallets gives an out row and an in row', () => {
  const rows = logToRows(log(), '2026-10-03T11:35:32.000Z', new Set([A, B]), ['out', 'in'], meta);
  assert.deepEqual(rows.map((r) => [r.wallet, r.direction]), [[A, 'out'], [B, 'in']]);
  const r = rows[0];
  assert.equal(r.uid, '0xtx:log:4');
  assert.equal(r.asset_key, TOKEN);
  assert.equal(r.symbol, 'USDG');
  assert.equal(r.decimals, 6);
  assert.equal(r.value, 0.170194);
  assert.equal(r.raw_value, '0x298d2');
  assert.equal(r.token_id, null);
});

test('logToRows respects directions, skips zero value, ERC-721 and malformed logs', () => {
  assert.equal(logToRows(log(), null, new Set([A, B]), ['in'], meta).length, 1);
  assert.equal(logToRows(log({ data: '0x' + '0'.repeat(64) }), null, new Set([A]), ['out'], meta).length, 0);
  assert.equal(logToRows(log({ topics: [TRANSFER_TOPIC, pad(A), pad(B), pad(C)] }), null, new Set([A]), ['out'], meta).length, 0);
  assert.equal(logToRows(log({ data: '0x' }), null, new Set([A]), ['out'], meta).length, 0);
  assert.equal(logToRows(log(), null, new Set([C]), ['out', 'in'], meta).length, 0);
});

test('logToRows keeps a null value when the token has no decimals()', () => {
  const r = logToRows(log(), null, new Set([A]), ['out'], new Map())[0];
  assert.equal(r.value, null);
  assert.equal(r.symbol, null);
  assert.equal(r.raw_value, '0x298d2');
});

test('txToRows: successful top-level ETH only', () => {
  const tx = { hash: '0xtx', from: A, to: B, value: '0x' + (10n ** 17n).toString(16), status: 1, blockNumber: 7 };
  const rows = txToRows(tx, 't', new Set([A]), ['out', 'in']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uid, '0xtx:external');
  assert.equal(rows[0].asset_key, 'native');
  assert.equal(rows[0].value, 0.1);
  assert.equal(txToRows({ ...tx, status: 0 }, 't', new Set([A]), ['out']).length, 0);
  assert.equal(txToRows({ ...tx, value: '0x0' }, 't', new Set([A]), ['out']).length, 0);
  assert.equal(txToRows({ ...tx, to: null }, 't', new Set([A]), ['out']).length, 0);
});

test('decodeString reads dynamic strings and bytes32 symbols', () => {
  const dyn = '0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + Buffer.from('USDG').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(dyn), 'USDG');
  assert.equal(decodeString('0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0')), 'MKR');
  assert.equal(decodeString('0x'), null);
});

test('fetchTokenMeta batches calls and tolerates a token that reverts', async () => {
  const fetchImpl = async (_url, init) => {
    const reqs = JSON.parse(init.body);
    const out = reqs.map((r) => (r.id === 2
      ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } }
      : { jsonrpc: '2.0', id: r.id, result: r.id % 2 ? '0x' + (6).toString(16).padStart(64, '0') : '0x' + '20'.padStart(64, '0') + '3'.padStart(64, '0') + Buffer.from('ABC').toString('hex').padEnd(64, '0') }));
    return { ok: true, json: async () => out };
  };
  const m = await fetchTokenMeta('http://x', [A, B], { fetchImpl, sleep: async () => {} });
  assert.deepEqual(m.get(A), { symbol: 'ABC', decimals: 6 });
  assert.deepEqual(m.get(B), { symbol: null, decimals: 6 });
});

test('compare reports missing, extra and differing rows', () => {
  const row = (uid, v) => ({ wallet: A, direction: 'out', uid, value: v });
  const r = compare([row('1', 1), row('2', 2), row('4', 4)], [row('1', 1), row('2', 9), row('3', 3)]);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.onlyMine, [`${A}|out|4`]);
  assert.deepEqual(r.onlyRef, [`${A}|out|3`]);
  assert.equal(r.fieldDiffs, 1);
});

test('main: internal category is refused with a reason, and the token never prints', async () => {
  const err = [];
  const code = await main(['--address', A, '--last-blocks', '10', '--categories', 'internal'], { ENVIO_API_TOKEN: 'sekret' }, { out: () => {}, err: (m) => err.push(m) });
  assert.equal(code, 1);
  assert.match(err.join(''), /traces/);
  assert.doesNotMatch(err.join(''), /sekret/);
});

test('main: needs a token and a wallet', async () => {
  const io = { out: () => {}, err: () => {} };
  assert.equal(await main(['--address', A, '--last-blocks', '10'], {}, io), 1);
  assert.equal(await main(['--last-blocks', '10'], { ENVIO_API_TOKEN: 'x' }, io), 1);
});
