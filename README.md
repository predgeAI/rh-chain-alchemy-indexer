# Index Robinhood Chain with Alchemy

Read transfer history from Robinhood Chain (mainnet, chain id 4663) with Alchemy's
`alchemy_getAssetTransfers`. One Node script, no dependencies, JSONL out, and a dry run that prints
the compute-unit (CU) cost before you spend any.

From [Predge](https://predge.io). It uses the query pattern of the indexer we run every night on
Alchemy's Free plan, rewritten as a small standalone script. The run figures below come from that
indexer's own run logs; where a number comes from somewhere else, the text says so.
A short write-up of the same numbers is in [CASE-STUDY.md](CASE-STUDY.md).

## Quick start

```bash
cp .env.example .env     # add your Alchemy API key; RPC_URL is the endpoint without the key
# put wallet addresses in wallets.txt, one per line (# comments allowed)

# 1. What will it cost? Sends nothing.
node --env-file=.env recipe/index.mjs --wallets wallets.txt --last-blocks 50000 --dry-run

# 2. Run it.
node --env-file=.env recipe/index.mjs --wallets wallets.txt --last-blocks 50000 --out transfers.jsonl
```

You need an Alchemy app with Robinhood Chain Mainnet enabled (the Free plan is enough) and Node 20.6 or
newer for `--env-file` (tested on 20.20). The script uses only built-in modules, so it should also run
on older Node 18 and 20 releases if you export `ALCHEMY_API_KEY` and `RPC_URL` yourself, but we have not
tested that. Leave out `--wallets` to scan every transfer on the chain in the range instead (see
"Whole-chain scans").

| option | meaning |
|---|---|
| `--wallets FILE`, `--address 0x...` | wallets to index (repeatable `--address`). None means a whole-chain scan |
| `--from-block N` or `--last-blocks N` | start of the range, decimal or `0x...`; exactly one of the two |
| `--to-block N\|latest` | end of the range, default `latest`, resolved once so paging sees a fixed range |
| `--directions out,in` | which sides of each wallet to query, default both |
| `--categories LIST` | default `external,erc20` (`internal` is not supported on this chain, see below) |
| `--out FILE`, `--append` | JSONL file, default `transfers.jsonl`; `--append` adds to it |
| `--dry-run` | print the CU estimate and exit, no request is made |
| `--max-cu N` | refuse to spend more than N CU (default 100,000, `0` = no cap); exit code 3 when it stops |
| `--cu-per-second N` | spacing between requests, default 400 (Free plan: 500), `0` = off |
| `--concurrency N` | parallel queries, default 4 |
| `--extra-page-share X` | dry run only: expected share of extra pages for wallet queries, default 0.02 |
| `--assume-transfers N` | dry run only, whole-chain scans: how many transfers you expect |
| `--any-chain` | skip the check that the endpoint is Robinhood Chain (chain id 4663) |

The key is appended to `RPC_URL` inside the script and is redacted from every error message. The last
line on stdout is a JSON summary (CU, calls, rows, 429s, latency, `next_from_block`) that you can log.

## Output

One JSON object per transfer, in no particular order:

```json
{"wallet":"0x…","direction":"in","uid":"0x…:log:4","tx":"0x…","block":79052459,"ts":"2026-10-03T11:35:32.000Z","category":"erc20","asset_key":"0x…","contract":"0x…","symbol":"USDG","decimals":6,"value":0.170194,"raw_value":"0x298d2…","token_id":null,"from":"0x…","to":"0x…"}
```

- **Identity is the contract address.** `asset_key` is the lower-case token contract, or `native` for
  ETH. Group, join and price on `asset_key`. `symbol` is for display only: tickers are not unique on
  Robinhood Chain. In the live test below, one sample of 4,000 transfers held 221 contracts under 202
  tickers, and 12 of those tickers were used by more than one contract.
- `uid` is Alchemy's `uniqueId` (`<tx>:log:<n>` for ERC-20, `<tx>:external` for ETH). Together with
  `wallet` and `direction` it is a unique key, so overlapping runs can be de-duplicated.
- `raw_value` is the exact integer in hex; `value` is Alchemy's decimal-adjusted number.
- `ts` is the block timestamp. `withMetadata` returns it on Robinhood Chain.

## What it costs

CU prices the script counts with, from Alchemy's
[CU table](https://www.alchemy.com/docs/reference/compute-unit-costs) (checked 2026-10-03):

| method | CU |
|---|---|
| `alchemy_getAssetTransfers` | 120 |
| `eth_getBalance`, `eth_getTransactionReceipt`, `eth_getCode` | 20 |
| `eth_blockNumber` | 10 |
| `eth_getLogs` | 60 |
| `eth_chainId` | 0 |

A wallet query costs one call per direction, plus one more call for every further 1,000 transfers in
the range. So for wallets with fewer than 1,000 transfers in the range, **CU = wallets x 2 x 120**,
whatever the length of the range.

### Measured: our nightly indexer

5,699 Robinhood Chain wallets, two queries each, 4 workers, one run a night. Every figure here comes from
the job's run log, one line per run (end time, exit code, seconds, CU), and the per-run log it points to.
Sixteen runs, 2 to 17 October 2026: fifteen full runs, plus one short resume run on 14 October that
finished a single wallet left over from the night before. The first full run was started by hand, the
others by the scheduler at 01:00 UTC:

| | per full run, 15 runs |
|---|---|
| wallets | 5,699 every run |
| blocks covered | 835,215 to 857,092 for the twelve 24-hour windows; 1,517,216 on the first run; 1,701,746 on 15 Oct (two days, after the resume night) |
| calls | 11,400 to 11,409 |
| CU | 1,367,790 to 1,368,870, mean **1,368,078** (spread 0.08%) |
| CU per wallet | 240.0 to 240.2 |
| wall-clock | 61.9 to 72.3 min, mean **65.4 min** |
| wallets that failed | 1 of 85,485 wallet refreshes (13 Oct, gave up after 10 retries); finished the next night for 240 CU |

CU is the job's own count at the published prices; it is not reconciled with the Alchemy dashboard. Each
run's CU is 120 x (Transfers calls) + 30 for two head lookups, e.g. 1,367,790 = 11,398 x 120 + 30.
All sixteen runs together logged 20,521,410 CU.

What the numbers say:

- **You pay per wallet, not per block.** The first run covered 1.8 times as many blocks as a normal
  night and cost 0.06% more than the mean; the two-day window on 15 October covered 2.0 times as many
  and cost 0.05% more. It holds for wallets under 1,000 transfers a run; the index leaves out five
  router-size addresses, each with over 1.5M transfers.
- **Extra pages are rare for daily windows.** 36 pages beyond the first in 170,970 queries over the
  15 full runs (0.02%); most nights needed 0 to 3, the two long windows 8 and 9. An older 8.8-day catch-up
  of the same job needed 1.5%, so long windows cost a little more.
- **The estimator.** `--dry-run` on a 5,699-address file with its default 2% allowance for extra pages
  prints 1,395,130 CU, 2.0% above the measured mean. With `--extra-page-share 0.00021` (the measured
  share, so fitted on the same data) it prints 1,368,130.
- **The Free plan (30M CU a month).** At 240 CU per wallet per day: 1,000 wallets use 7.2M a month (24%),
  2,000 use 14.4M (48%), 4,000 use 28.8M (96%). Our 5,699 wallets would use 41.0M over 30 daily runs,
  which is 137%. Our job stops itself for the month at 27M CU by its own count; in October 2026 that is
  projected to happen after the run of 22 October (20 full runs).
- **Throughput.** 11,400 calls in 62 to 72 minutes is 2.6 to 3.1 calls a second, or 315 to 368 CU a
  second sustained with 4 workers. The pricing page lists 500 CU/s for Free. Our job does not count its
  rate-limit retries, so we cannot say how much of that time was throttling.
- **Quiet wallets cost the same.** Between 35% and 71% of the 5,699 wallets had no transfers in a run's
  window (59% across the 15 full runs), and each still cost 240 CU. (Counted from the index database, not
  the log.)

### Whole-chain scans

Without `--wallets`, the cost follows volume: 120 CU per 1,000 transfers returned. Robinhood Chain is
busy and bursty. Short samples gave 9.5 transfers per block on 2026-10-03 (4,000 transfers filled only the
first 419 blocks of the live test's 600-block window), about 2.5 per block the same day (49 transfers in a
20-block window) and 13.3 per block on 2026-10-14 (4,000 transfers in 301 blocks). Volume varies several-fold, so try a small window first and keep `--max-cu` on.

On the Free plan, the cheapest way to read a long history for a modest wallet list is the per-wallet mode
above.

## Test

```bash
npm test               # 22 offline tests, no network, no key, no CU
npm run test:live      # runs against Robinhood Chain mainnet, public data only; needs .env; about 2,000 CU
```

The live test finds its own sample wallets in a one-minute window of recent blocks, so no wallet list ships
with this repo. Last full run, 2026-10-14 21:10 UTC, Free plan, 1,930 CU in total, all 7 steps passed:

| step | result |
|---|---|
| range | blocks 88,676,854 to 88,677,453 (600 blocks, about one minute, a minute behind the head) |
| 3 sample wallets, via the CLI | 6 queries, 6 pages, 4 rows, **720 CU**, exactly the dry-run minimum; 0 x 429 |
| latency, from the machine running the test | p50 470 ms, max 797 ms per call; Alchemy's own `x-envoy-upstream-service-time` p50 315 ms |
| per-wallet results vs whole-chain scan | 4 of 4 transfers seen in the scan came back in the per-wallet results |
| the API key | never in stdout, stderr or the output file (asserted) |
| `internal` category | rejected, see below |

## Limitations on Robinhood Chain today

All observed live on the Free plan on 2026-10-03 and again on 2026-10-14, with the same error messages; the first one was checked once more on 2026-10-17. The live test asserts the first one, so it fails when
Alchemy adds the `internal` category for this chain; it only records the others.

1. **No internal transfers in `alchemy_getAssetTransfers`.** With `category: ["internal"]` it answers
   `-32602: The 'internal' category is not supported for this network.` The Transfers docs list
   Ethereum, Polygon, Base and Arc for internal transfers. The Address Activity webhook docs also list
   Robinhood Chain; we have not tested webhooks. On a trading chain this matters: when someone sells a
   token for ETH, the payout can happen inside the call (a router unwrapping WETH, or a pool paying
   ETH). That payment is an internal transfer, so with `external` + `erc20` you see the token leave the
   wallet and nothing come back. Treating that as "no proceeds" misstates the profit and loss of wallets
   that sell for ETH. A workaround is below.
2. **`eth_getLogs` is capped at 10 blocks on Free** (`-32600: ... up to a 10 block range ... Upgrade to
   PAYG`). The chain makes about 9.9 blocks a second, so one day is about 86,000 calls and 5.1M CU.
   Sweeping events on Free is not practical; use Pay As You Go or another node for that.
3. **No traces on Free.** `trace_transaction` answers `not available on the ROBINHOOD_MAINNET`, and
   `debug_traceTransaction` answers `not available on the Free tier`. We did not test paid plans.
4. **Zero-value transfers are skipped** (`excludeZeroValue` is on, Alchemy's default), so they never
   appear in the output.
5. **CU is a client-side count.** The responses we looked at carry no CU header, only a trace id and the
   upstream service time. A JSON-RPC error is counted as billed, since we do not know that Alchemy waives
   it; rate-limit responses (HTTP 429, or a rate-limit error in the body) are retried and not counted, and
   a "monthly capacity" error stops the run at once. Check the per-app usage in the Alchemy dashboard
   before you quote CU numbers.
6. **Re-running an overlapping range with `--append` writes the same rows twice.** De-duplicate on
   `(wallet, direction, uid)`, or start each run at the previous `next_from_block`.

## Workaround for the internal-transfer gap

Cheapest first on the Free plan.

**1. Find candidates in the output.** A candidate is a transaction where the wallet sent an ERC-20 and
nothing at all came into that wallet in the same transaction. Needs both directions in the file:

```bash
jq -s 'group_by([.wallet, .tx])
       | map(select(any(.[]; .direction=="out" and .category=="erc20") and all(.[]; .direction=="out")))
       | map({wallet: .[0].wallet, tx: .[0].tx, block: .[0].block})' transfers.jsonl
```

Candidates are a superset of ETH-paid sells: plain token sends and liquidity deposits match too.

**2. Check each candidate with a balance delta**, 60 CU per transaction:

```
receipt = eth_getTransactionReceipt(tx)                     # 20 CU: from, gasUsed, effectiveGasPrice
after   = eth_getBalance(wallet, block)                     # 20 CU
before  = eth_getBalance(wallet, block - 1)                 # 20 CU
fee     = receipt.from == wallet ? gasUsed * effectiveGasPrice : 0
received_native = after - before + fee
```

It is exact when the wallet has no other balance-changing transaction in that block. We ran it by hand on
the one candidate in the live test's 9 output rows. The wallet sent the transaction, and the Transfers API
returned no inbound transfer to it in the whole block, yet its balance rose by **0.4396 ETH** after adding
the fee back (block 79,052,744, tx
`0x485c04bebc13dfe88f1e820a70fdf49611915abbf01e338a15a4f7b2939f7145`). The likeliest explanation is an
ETH-paid sell: an internal payment, which is exactly what the missing category would have returned.
The live test also runs this check on candidates from its whole-chain sample. In the 2026-10-14 run it
examined 8 candidates; 3 had been sent by the wallet itself (the test skips the rest, because it needs
the sender's fee), and 1 of those 3 had received 0.023 ETH that the Transfers API did not return. A few
examples are an illustration, not a rate.

**3. Other routes.** Sweep the router's swap event with `eth_getLogs` (a wider range needs Pay As You
Go), call `debug_traceTransaction` with `callTracer` (40 CU, Pay As You Go), or use an Address Activity
webhook, whose docs list internal transfers on Robinhood Chain (live data only, not history). We have not
tested any of these. Our own pipeline reads router swap events from the public Robinhood RPC and checks
samples with the balance delta above.

## Running it every day

```bash
# once a day (cron, launchd or a systemd timer): continue from where the last run stopped
NEXT=$(cat .next-block 2>/dev/null || echo 78678908)
node --env-file=.env recipe/index.mjs --wallets wallets.txt --from-block "$NEXT" \
  --append --max-cu 2000000 > run.json && jq -r .next_from_block run.json > .next-block
```

`run.json` holds the CU, calls, rows and latency of the run; append it to a log if you want a history.
We keep the same kind of one-line-per-run log for our own indexer, and the table above comes from it.
A run that stops at its budget (exit code 3) leaves a partial file and must not advance `.next-block`;
the `&&` above takes care of that.

## License

MIT, see `LICENSE`.
