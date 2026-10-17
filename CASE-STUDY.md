# Predge indexes 5,699 Robinhood Chain wallets every night on Alchemy's Free plan

*Case study draft, 17 October 2026. Figures cover 15 full nightly runs, 2 to 17 October 2026, plus one short resume run on 14 October.*

| 5,699 | 1.37M CU | 240 CU | 65.4 min | 1 in 85,485 |
|---|---|---|---|---|
| wallets refreshed every night | per nightly run | per wallet per run | mean wall-clock per run | wallet refreshes that failed (finished the next night) |

## About Predge

Predge ([predge.io](https://predge.io)) builds data services for on-chain markets. On Robinhood Chain it keeps a daily history of the ERC-20 and top-level ETH transfers of a fixed set of 5,699 wallets. This case study covers the infrastructure only.

## The challenge

Robinhood Chain is fast. Our twelve 24-hour windows between 4 and 17 October held 835,215 to 857,092 blocks each, about 9.8 blocks a second. Anything priced per block pays for all of them.

We wanted a daily refresh that:

- fits inside Alchemy's Free plan (30M compute units a month, 500 CU/s);
- has a cost we know before a run starts, so the job can stop itself before the monthly cap;
- survives interruptions without gaps or double counting.

Sweeping events with `eth_getLogs` was not an option on the Free plan: it accepts at most 10 blocks per call, which at Robinhood Chain's speed is about 85,000 calls a day.

## The solution

A nightly job built on `alchemy_getAssetTransfers`:

- **Two queries per wallet.** One with `fromAddress`, one with `toAddress`, categories `external` and `erc20`, `withMetadata` on, up to 1,000 transfers per page, following `pageKey` when needed.
- **Frozen range, resumable runs.** Each run fixes its target block first. A wallet counts as done only after both queries are stored, so an interrupted run resumes over the same range.
- **A budget guard.** Each run appends one line to a log (end time, exit code, seconds, CU). The job skips further runs for the month once that log reaches 27M CU.
- **Token identity by contract.** `rawContract.address` identifies the token. Tickers are not unique on Robinhood Chain: in one 4,000-transfer sample on 14 October, 221 contracts used 202 tickers.

We have open-sourced the pattern as a recipe, MIT licensed, with a CU dry run, 22 offline tests and a live mainnet test: [github.com/predgeAI/rh-chain-alchemy-indexer](https://github.com/predgeAI/rh-chain-alchemy-indexer).

## The results

| | 15 full nightly runs, 2 to 17 Oct 2026 |
|---|---|
| Wallets per run | 5,699 |
| Blocks per run | 835,215 to 857,092 (24-hour windows); 1,517,216 on the first run; 1,701,746 on 15 Oct (two-day window) |
| API calls per run | 11,400 to 11,409 |
| CU per run | 1,367,790 to 1,368,870, mean 1,368,078 |
| Wall-clock per run | 61.9 to 72.3 min, mean 65.4 min |
| Wallet refreshes completed on first attempt | 85,484 of 85,485 |

- **Cost follows wallets, not blocks.** Every run cost 240.0 to 240.2 CU per wallet. The first run covered 1.8 times as many blocks as a normal night and cost 0.06% more; a two-day window on 15 October covered 2.0 times as many and cost 0.05% more. Pages beyond the first were about 0.02% of queries (36 in 170,970). This holds for wallets with fewer than 1,000 transfers a day; five router-size addresses are left out of the index.
- **Predictable spend.** The spread between the cheapest and the most expensive run was 0.08%. The recipe's dry run, with its default 2% allowance for extra pages, estimates 1,395,130 CU for this wallet list, 2.0% above the measured mean.
- **Throughput.** Four workers sustained 315 to 368 CU a second, 2.6 to 3.1 calls a second.
- **Reliability.** In 15 full runs one wallet query gave up after 10 retries (13 October). The next night's run finished it for 240 CU, and no block range was lost.
- **Free-plan fit.** A daily refresh of 5,699 wallets would take 41.0M CU over a 30-day month, 137% of the Free plan. The guard holds us to about 20 runs a month. At 240 CU per wallet per day, the Free plan covers a daily refresh of up to about 4,100 wallets.

How we measured: CU is our client's count of calls at Alchemy's published prices (120 CU per Transfers call), not yet reconciled with the Alchemy dashboard. Our client retries rate-limited requests but does not count them, so the figures above give completion per wallet, not a request-level success rate.

## What we would like to see on Robinhood Chain

- **Internal transfers in `alchemy_getAssetTransfers`.** With `category: ["internal"]` the API answers `-32602: The 'internal' category is not supported for this network` (checked 3, 14 and 17 October). On a trading chain this matters: when a wallet sells a token for ETH, the payout is often an internal transfer, so the API shows the token leaving and nothing coming back. The Address Activity webhook docs list internal transfers on Robinhood Chain; we have not tested webhooks.
- **Pay for activity.** Between 35% and 71% of our wallets had no transfers on a given night (59% across the 15 full runs), and each empty answer still cost 240 CU. A multi-address query would help.
- **Wider `eth_getLogs` on Free.** At 10 blocks per call, one call covers about a second of Robinhood Chain. A cap in time rather than blocks would suit a fast chain.
- **Traces.** `trace_transaction` is not available on Robinhood Chain mainnet, and `debug_traceTransaction` is not available on the Free plan (checked 14 October).

## What's next

- Reconcile our CU count with the Alchemy dashboard and add a rate-limit counter to the job.
- Test Address Activity webhooks for internal ETH transfers on Robinhood Chain.
