# Polymarket Arbitrage Bot

Production-oriented Node.js + TypeScript bot for scanning Polymarket binary markets, detecting `YES + NO < 1` opportunities, and optionally executing paired trades through the Polymarket CLOB. It also supports a second edge source for late-resolution signals, where an external feed marks the winning side before the market fully reprices.

## What it does

- Fetches active markets from the Polymarket Gamma markets API
- Seeds live order books, then stays synced through the market WebSocket
- Tracks best bid/ask for YES and NO tokens
- Evaluates arbitrage after slippage, fees, gas, liquidity depth, and wallet constraints
- Supports late-resolution signals from a local NDJSON feed
- Places paired buy orders with `FOK` or `FAK`
- Handles partial fills in `FAK` mode by attempting to flatten unmatched exposure
- Logs opportunities, trades, errors, and optional market snapshots to local NDJSON files
- Supports Telegram/webhook alerts
- Includes a simple CLI dashboard
- Includes a replay-style backtest mode over persisted snapshots

## Project structure

- [./src/marketScanner.ts](./src/marketScanner.ts)
- [./src/arbitrageEngine.ts](./src/arbitrageEngine.ts)
- [./src/executionEngine.ts](./src/executionEngine.ts)
- [./src/riskManager.ts](./src/riskManager.ts)
- [./src/wallet.ts](./src/wallet.ts)
- [./src/config.ts](./src/config.ts)
- [./src/main.ts](./src/main.ts)

## Requirements

- Node.js 22+
- npm 11+
- A Polygon / Polymarket-compatible private key for live trading
- Sufficient USDC and approvals in the configured Polymarket funder wallet

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
Copy-Item .env.example .env
```

3. Start in paper mode first:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
npm start
```

## Key env vars

- `DRY_RUN=true`: scan and simulate only
- `PRIVATE_KEY=...`: required for live execution
- `POLY_SIGNATURE_TYPE=0|1|2`: 0 for EOA, 1 for Magic proxy, 2 for Gnosis Safe / browser-wallet proxy
- `FUNDER_ADDRESS=...`: required when signature type is `1` or `2`
- `MIN_PROFIT_THRESHOLD=0.005`: minimum post-cost edge after fees, gas, and estimated slippage
- `MAX_TRADE_SIZE=50`: conservative starter size per leg
- `MAX_OPEN_NOTIONAL=200`: conservative starter capital cap
- `MAX_BOOK_AGE_MS=300`: skip binary arb attempts when the local book is older than this
- `SLIPPAGE_TOLERANCE=0.01`: max sweep beyond top ask when sizing
- `EXECUTION_ORDER_TYPE=FOK|FAK|GTC`: `FOK` is safest for paired arb; `FAK` allows partials and hedge logic
- `BINARY_ARB_EXECUTION_MODE=FOK|FAK`: keep `FOK` as the default for the first `us-east` validation run
- `ENABLE_ORDERBOOK_PERSISTENCE=true`: required if you want local snapshot replay backtests
- `ENABLE_LATE_RESOLUTION_STRATEGY=true`: enables the second strategy using `LATE_RESOLUTION_SIGNAL_FILE`
- `LATE_RESOLUTION_SIGNAL_FILE=./data/resolution-signals.ndjson`: local feed of winning-side signals
- `ENABLE_TEMPORAL_ARB_STRATEGY=true`: enables the crypto candle lag strategy
- `ENABLE_CEX_PRICE_FEED=true`: turns on the Binance/Coinbase spot feed required by `temporal_arb`
- `TEMPORAL_ARB_ESTIMATED_LATENCY_MS=250`: local round-trip estimate used to discount confidence
- `USE_GCP_SECRET_MANAGER=true`: load `PRIVATE_KEY` from Google Secret Manager instead of `.env`
- `HEALTH_PORT=3001`: lightweight health/metrics HTTP endpoint
- `examples/resolution-signals.example.ndjson`: sample payload for the late-resolution feed

## Temporal Arbitrage Strategy

`temporal_arb` watches real-time CEX spot prices for `BTC`, `ETH`, and `SOL`, then compares them with Polymarket crypto strike markets such as "Will BTC be above $95,000 at 12:15 UTC?". When spot has already moved meaningfully beyond the strike and Polymarket still prices the likely winner cheaply, the bot places a single-leg `FOK` buy on that side.

Enable it with:

```env
ENABLE_TEMPORAL_ARB_STRATEGY=true
ENABLE_CEX_PRICE_FEED=true
CEX_PRIMARY_EXCHANGE=binance
MIN_TEMPORAL_ARB_CONFIDENCE=0.82
MAX_TEMPORAL_ARB_TRADE_SIZE=30
TEMPORAL_ARB_MIN_TIME_REMAINING_MS=8000
TEMPORAL_ARB_MAX_SPOT_AGE_MS=2000
TEMPORAL_ARB_ESTIMATED_LATENCY_MS=250
```

The confidence model is intentionally simple and conservative. It starts from strike distance plus time-to-close, then discounts confidence for stale spot data, wide CEX spreads, wide Polymarket spreads, and unusually high latency. The engine will not trade below the hard safety floors: `0.70` confidence, `0.03%` normalized edge, `5s` remaining, or `5s` spot age.

Recommended local setup:

- keep `DRY_RUN=true` until you have measured latency
- use `npm run latency:measure` and set `TEMPORAL_ARB_ESTIMATED_LATENCY_MS` to a conservative `p90` or `p99`
- start with `MAX_TEMPORAL_ARB_TRADE_SIZE=10-30`
- leave `TEMPORAL_ARB_MIN_TIME_REMAINING_MS=8000` unless your end-to-end latency is consistently lower

Known limitations:

- this edge is more fragile outside low-latency regions, especially far from US-East infrastructure
- it depends on raw WebSocket feed quality from Binance/Coinbase and will skip signals if the spot feed goes stale
- successful fills leave directional inventory open until resolution or manual unwind, so per-symbol exposure is capped conservatively

Dashboard interpretation:

- `Temporal arb: seen=... exec=...` shows opportunity windows seen and filled
- `conf_avg` is the average confidence on successful executions
- `btc / eth / sol` show executions by symbol
- `feedAge` and `[LIVE|STALE]` summarize whether the selected CEX feed is currently fresh enough for temporal signals

## Backtesting

Enable orderbook persistence during live or paper runs:

```bash
$env:ENABLE_ORDERBOOK_PERSISTENCE='true'
npm run dev
```

Then replay the snapshots:

```bash
$env:BOT_MODE='backtest'
npm run backtest
```

This backtest is a replay of recorded book snapshots, not a full matching-engine simulation. It is useful for signal evaluation, not exact fill attribution.

## Operational notes

- Start with `DRY_RUN=true` and verify balances, allowances, and account type.
- `FOK` is the recommended default because it minimizes one-leg execution risk.
- The bot treats arbitrage profit as locked-in only after both legs are filled; otherwise it attempts to flatten imbalance in `FAK` mode.
- Open notional is tracked locally through the configured cap. Successful filled pairs keep capital reserved because they remain outstanding until manually unwound or resolved.
- The current validation path is intentionally narrowed to `binary_arb`. Disable `binary_ceiling`, `neg_risk`, and `late_resolution` for the next latency-focused run.
- Late-resolution trades only run when a matching signal exists in `LATE_RESOLUTION_SIGNAL_FILE`. One JSON object per line is expected, for example:

```json
{"conditionId":"0xabc...","resolvedOutcome":"YES","source":"sports_feed","resolvedAt":1764547200000}
```

- Fees on Polymarket can be market-dependent. The bot fetches fee-rate bps from CLOB and uses a conservative fee model.
- Geographical restrictions, exchange rules, and account requirements still apply. This code does not bypass them.

## `us-east` paper validation runbook

The next meaningful validation step is a `48h` paper run from `us-east`, not another long run from Buenos Aires. The goal is to isolate latency and measure whether `binary_arb` becomes fillable when the bot is physically close to the matching engine.

### Recommended target

- Provider: DigitalOcean
- Region: `nyc3`
- Image: Ubuntu `24.04`
- Size: `1 vCPU / 1 GB RAM`
- Firewall:
  - allow `22/tcp`
  - allow `3001/tcp` only from your IP

### Deploy steps

1. SSH into the VPS and install Node.js 22 and git.
2. Clone the repo into `/opt/polymkt-arb`.
3. Run `npm ci`.
4. Create a paper-only env file outside the repo at `/etc/polymkt-arb/polymkt-arb.env`.
5. Set permissions to `600` and make the same user that runs PM2 own the file.
6. Export that env before starting PM2, or source it from the shell profile used by PM2.
7. Run `npm run build`.
8. Run `npm run pm2:start`.

Example bootstrap:

```bash
sudo apt-get update
sudo apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo mkdir -p /opt/polymkt-arb /etc/polymkt-arb
sudo chown "$USER":"$USER" /opt/polymkt-arb
git clone https://github.com/Mauropestarino/polymkt-arb /opt/polymkt-arb
cd /opt/polymkt-arb
npm ci
sudo install -m 600 /dev/null /etc/polymkt-arb/polymkt-arb.env
npm run build
source /etc/polymkt-arb/polymkt-arb.env
npm run pm2:start
```

### Exact paper env for the `us-east` run

Keep this run focused on `binary_arb` only:

```env
BOT_MODE=live
DRY_RUN=true
EXECUTION_ORDER_TYPE=FOK
BINARY_ARB_EXECUTION_MODE=FOK
MAX_TRADE_SIZE=50
MAX_OPEN_NOTIONAL=200
MIN_MARKET_LIQUIDITY=250
MIN_PROFIT_THRESHOLD=0.005
MAX_MARKETS=200
MAX_BOOK_AGE_MS=300
PAPER_SHADOW_LATENCY_MS=150
ENABLE_BINARY_CEILING_STRATEGY=false
ENABLE_NEG_RISK_STRATEGY=false
ENABLE_LATE_RESOLUTION_STRATEGY=false
ENABLE_ORDERBOOK_PERSISTENCE=false
HEALTH_PORT=3001
LOG_DIR=./data/run-us-east-binary-arb-fok
PRIVATE_KEY=
POLY_API_KEY=
POLY_API_SECRET=
POLY_API_PASSPHRASE=
```

### What to watch during the run

- `http://<server-ip>:3001/health`
- `http://<server-ip>:3001/metrics`
- `http://<server-ip>:3001/dashboard`

Approval thresholds for the `48h` paper run:

- `shadow_fill_rate >= 15%`
- `trades_attempted >= 10`
- `effective shadow PnL > 0`
- `average opportunity duration >= 1.5s`
- `open_reservations_count = 0` at the end
- `ws_disconnect_total <= 2` per `24h`
- no feed stall longer than `60s`

Decision rules:

- `shadow_fill_rate < 15%`: abandon `binary_arb` as the first live edge
- `15% <= shadow_fill_rate < 30%`: keep paper mode and open a `FAK + hedge` experiment
- `shadow_fill_rate >= 30%`: keep `FOK` for the first micro-live

## First micro-live, only if the remote paper run passes

Do not turn on live capital unless the `us-east` paper run passes the thresholds above.

```env
BOT_MODE=live
DRY_RUN=false
EXECUTION_ORDER_TYPE=FOK
BINARY_ARB_EXECUTION_MODE=FOK
MAX_TRADE_SIZE=5
MAX_OPEN_NOTIONAL=25
MIN_MARKET_LIQUIDITY=250
MIN_PROFIT_THRESHOLD=0.005
MAX_MARKETS=200
MAX_BOOK_AGE_MS=300
ENABLE_BINARY_CEILING_STRATEGY=false
ENABLE_NEG_RISK_STRATEGY=false
ENABLE_LATE_RESOLUTION_STRATEGY=false
AUTO_MERGE_BINARY_ARB=true
```

Operational guardrails:

- capital: `$100-150 USDC`
- duration: `2-4h`
- one PM2 instance only
- keep the live key outside the repo and outside the workspace `.env`
- on DigitalOcean, store the env in `/etc/polymkt-arb/polymkt-arb.env`

## Output files

When running, the bot writes:

- `data/bot.log`
- `data/opportunities.ndjson`
- `data/trades.ndjson`
- `data/errors.ndjson`
- `data/orderbooks.ndjson` when snapshot persistence is enabled

## Example `.env`

```env
CLOB_API_URL=https://clob.polymarket.com
MARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
CHAIN_ID=137
BOT_MODE=live
DRY_RUN=true
MIN_PROFIT_THRESHOLD=0.005
MAX_TRADE_SIZE=50
MAX_OPEN_NOTIONAL=200
SLIPPAGE_TOLERANCE=0.01
EXECUTION_ORDER_TYPE=FOK
ENABLE_LATE_RESOLUTION_STRATEGY=true
LATE_RESOLUTION_SIGNAL_FILE=./data/resolution-signals.ndjson
PRIVATE_KEY=
POLY_SIGNATURE_TYPE=0
```
