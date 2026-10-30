# The same wallet index from HyperSync

`index.mjs` writes the same JSONL rows as [`../recipe/index.mjs`](../recipe/index.mjs) (same wallets file, same `external` and `erc20` categories, same fields), but reads them from [HyperSync](https://docs.envio.dev/docs/HyperSync/overview) instead of `alchemy_getAssetTransfers`. The Alchemy recipe is untouched.

```bash
cd hypersync && npm install
cp .env.example .env      # add a free token: https://envio.dev/app/api-tokens
node --env-file=.env index.mjs --wallets ../wallets.txt --last-blocks 50000 --out transfers.jsonl
npm test                  # 13 offline tests
```

Options match the recipe: `--wallets`, `--address`, `--from-block` / `--last-blocks`, `--to-block`, `--directions`, `--categories`, `--out`, `--append`. There is no `--dry-run`, `--max-cu` or rate setting: HyperSync is queried with a token, not with compute units. The last stdout line is a JSON summary (`next_from_block`, rows, `stream_s`, `token_meta_s`).

## How it maps

| Alchemy | HyperSync |
|---|---|
| `erc20`, `fromAddress` / `toAddress`, two calls per wallet | one stream of `Transfer` logs with topic1 (from) in the wallet list, and one with topic2 (to) |
| `external` | transactions with `from` / `to` in the wallet list and `value > 0`, `status = 1` |
| `uniqueId` `<tx>:log:<n>` / `<tx>:external` | built from the log index / tx hash |
| `asset`, `rawContract.decimal` | `symbol()` and `decimals()` read once per token from the public RPC (`RPC_URL`) |
| `withMetadata` timestamp | block timestamp, from a second light block stream |

Whole-chain scans (no wallet list) are not implemented.

## What is not covered

- **`internal` transfers.** HyperSync returns no traces for chain 4663 (a trace query over blocks 0 to head returned none on 2026-10-30), and the public RPC has no `debug_traceTransaction`. `--categories internal` stops with that message. The balance-delta workaround in the main README applies unchanged.
- ERC-721 / ERC-1155 categories.

## Differences you may notice

- Not verified against Alchemy, because I had no Alchemy key: whether Alchemy lists failed transactions under `external` (this script skips them), whether `raw_value` is padded hex (this script writes minimal hex, `0x298d2`), and the `decimals` of ETH rows (this script writes 18). Check these against your own output.
- `value` is computed as a JS number from the raw integer and `decimals()`, so very large balances lose precision, as they do for Alchemy's float. `raw_value` is exact.
- A token whose `symbol()` or `decimals()` call fails gets `null` for both (and `value: null`).

## Measured (2026-10-30, Apple M2 Max, shared machine, so timings are noisy)

No Alchemy output was available, so the check is against a second source: `verify.mjs` rebuilds the rows for a block range from the public RPC (`eth_getBlockByNumber` + `eth_getBlockReceipts`) and compares them field by field.

| check | result |
|---|---|
| 3,000 blocks (101,603,427 to 101,606,426), 6,636 wallets (the 1,000 busiest in the range plus a 5,699-address sample) | **15,111 of 15,111 rows matched, 0 differences in 241,776 field values**; 7,142 + 7,122 ERC-20 out / in, 432 + 415 ETH out / in |
| same range, index run | 3.5 s stream, 22.3 s token metadata, 26.5 s total |

The reference shares this script's row-building code, so it checks that HyperSync returns every log and transaction and that the filters are right. It does not check the row logic independently (the unit tests do that).

One day (850,000 blocks, about 24 h), 5,699 addresses sampled from addresses active on the chain, leaving out only the 5 busiest. Predge's real wallet list is not in the repo, so this list is a stand-in of the same size. It is likely busier than theirs: 3,677 of 5,699 addresses had rows, one address alone had 148,472.

| | |
|---|---|
| rows | 430,271 (394,209 ERC-20, 36,062 ETH) |
| HyperSync stream (logs, transactions, blocks) | 79.5 s |
| token `symbol()` / `decimals()` from the public RPC, 2,951 tokens | 135.7 s |
| total | 223 s |

More than half of the wall-clock is the public RPC, which rate-limits (a first attempt failed after retries while another job was using it). A private RPC, or caching token metadata between nightly runs, would remove most of it. Both are left out to keep the script small. A run on a second wallet list (leaving out the 300 busiest) gave 42.9 s stream, 325.8 s metadata, 373 s total.

For scale, the Alchemy recipe documents 240 CU per wallet per day for this call pattern, 1.37M CU for 5,699 wallets, and 65 minutes per nightly run (README, measured by them). I did not run the Alchemy side.
