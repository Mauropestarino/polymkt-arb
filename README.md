# Polymarket Arbitrage Bot

Production-oriented Node.js + TypeScript bot for scanning Polymarket binary markets, detecting `YES + NO < 1` opportunities, and optionally executing paired trades through the Polymarket CLOB.

## What it does

- Fetches active markets from the Polymarket CLOB markets endpoint
- Seeds live order books, then stays synced through the market WebSocket
- Tracks best bid/ask for YES and NO tokens
- Evaluates arbitrage after slippage, fees, gas, liquidity depth, and wallet constraints
- Places paired buy orders with `FOK` or `FAK`
- Handles partial fills in `FAK` mode by attempting to flatten unmatched exposure
- Logs opportunities, trades, errors, and optional market snapshots to local NDJSON files
- Supports Telegram/webhook alerts
- Includes a simple CLI dashboard
- Includes a replay-style backtest mode over persisted snapshots

## Project structure

- [src/marketScanner.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/marketScanner.ts)
- [src/arbitrageEngine.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/arbitrageEngine.ts)
- [src/executionEngine.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/executionEngine.ts)
- [src/riskManager.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/riskManager.ts)
- [src/wallet.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/wallet.ts)
- [src/config.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/config.ts)
- [src/main.ts](/C:/Users/pesta/OneDrive/Escritorio/polymarket/src/main.ts)

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
- `MIN_PROFIT_THRESHOLD=0.01`: minimum post-cost edge
- `MAX_TRADE_SIZE=100`: gross shares per leg
- `SLIPPAGE_TOLERANCE=0.02`: max sweep beyond top ask when sizing
- `EXECUTION_ORDER_TYPE=FOK|FAK|GTC`: `FOK` is safest for paired arb; `FAK` allows partials and hedge logic
- `ENABLE_ORDERBOOK_PERSISTENCE=true`: required if you want local snapshot replay backtests

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
MIN_PROFIT_THRESHOLD=0.01
MAX_TRADE_SIZE=100
SLIPPAGE_TOLERANCE=0.02
EXECUTION_ORDER_TYPE=FOK
PRIVATE_KEY=0xyour_private_key
POLY_SIGNATURE_TYPE=0
```
