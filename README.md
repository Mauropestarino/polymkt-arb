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
- `SLIPPAGE_TOLERANCE=0.01`: max sweep beyond top ask when sizing
- `EXECUTION_ORDER_TYPE=FOK|FAK|GTC`: `FOK` is safest for paired arb; `FAK` allows partials and hedge logic
- `ENABLE_ORDERBOOK_PERSISTENCE=true`: required if you want local snapshot replay backtests
- `ENABLE_LATE_RESOLUTION_STRATEGY=true`: enables the second strategy using `LATE_RESOLUTION_SIGNAL_FILE`
- `LATE_RESOLUTION_SIGNAL_FILE=./data/resolution-signals.ndjson`: local feed of winning-side signals
- `USE_GCP_SECRET_MANAGER=true`: load `PRIVATE_KEY` from Google Secret Manager instead of `.env`
- `HEALTH_PORT=3001`: lightweight health/metrics HTTP endpoint
- `examples/resolution-signals.example.ndjson`: sample payload for the late-resolution feed

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
- Late-resolution trades only run when a matching signal exists in `LATE_RESOLUTION_SIGNAL_FILE`. One JSON object per line is expected, for example:

```json
{"conditionId":"0xabc...","resolvedOutcome":"YES","source":"sports_feed","resolvedAt":1764547200000}
```

- Fees on Polymarket can be market-dependent. The bot fetches fee-rate bps from CLOB and uses a conservative fee model.
- Geographical restrictions, exchange rules, and account requirements still apply. This code does not bypass them.

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
