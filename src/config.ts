import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";

loadDotEnv();

const booleanish = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }

  return value;
}, z.boolean());

const numberish = z.preprocess((value) => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }

  return value;
}, z.number());

const stringish = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  return value;
}, z.string().optional());

const cliArgs = new Map<string, string>(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [rawKey = "", ...rest] = argument.slice(2).split("=");
      const key = rawKey.trim();
      return [key.toLowerCase(), rest.length > 0 ? rest.join("=") : "true"] as [string, string];
    })
    .filter((entry) => entry[0].length > 0),
);

const envOrArg = (name: string, fallback?: string): string | undefined => {
  const cliValue = cliArgs.get(name.toLowerCase());
  if (cliValue !== undefined) {
    return cliValue;
  }

  return process.env[name] ?? fallback;
};

const intNumber = () => z.coerce.number().int();
const positiveInt = () => intNumber().positive();
const nonNegativeInt = () => intNumber().nonnegative();
const positiveNumber = () => z.coerce.number().positive();
const nonNegativeNumber = () => z.coerce.number().nonnegative();

const schema = z
  .object({
    cwd: z.string(),
    clobApiUrl: z.string().url(),
    gammaApiUrl: z.string().url(),
    marketWsUrl: z.string().url(),
    userWsUrl: z.string().url(),
    chainId: positiveInt(),
    botMode: z.enum(["live", "backtest"]),
    dryRun: booleanish,
    logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
    logDir: z.string(),
    marketPageSize: positiveInt(),
    maxMarkets: nonNegativeInt(),
    minMarketLiquidity: nonNegativeNumber(),
    pollingIntervalMs: positiveInt(),
    heartbeatIntervalMs: positiveInt(),
    wsReconnectBaseMs: positiveInt(),
    wsReconnectMaxMs: positiveInt(),
    marketSubscriptionChunkSize: positiveInt(),
    bookSeedConcurrency: positiveInt(),
    feeCacheTtlMs: positiveInt(),
    balanceCacheTtlMs: positiveInt(),
    minProfitThreshold: nonNegativeNumber(),
    arbitrageBuffer: nonNegativeNumber(),
    maxTradeSize: positiveNumber(),
    maxOpenNotional: positiveNumber(),
    slippageTolerance: nonNegativeNumber(),
    hedgeSlippageTolerance: nonNegativeNumber(),
    minOrderbookLevels: positiveInt(),
    executionOrderType: z.enum(["FOK", "FAK", "GTC"]),
    executionTimeoutMs: positiveInt(),
    opportunityCooldownMs: nonNegativeInt(),
    gasCostUsd: nonNegativeNumber(),
    allowFeeMarkets: booleanish,
    enableOrderbookPersistence: booleanish,
    backtestFile: z.string(),
    backtestMaxLines: nonNegativeInt(),
    privateKey: stringish,
    polySignatureType: z.enum(["0", "1", "2"]).transform(Number),
    funderAddress: stringish,
    polyApiKey: stringish,
    polyApiSecret: stringish,
    polyApiPassphrase: stringish,
    apiKeyNonce: stringish,
    webhookUrl: stringish,
    telegramBotToken: stringish,
    telegramChatId: stringish,
  })
  .superRefine((value, ctx) => {
    const hasApiCreds =
      Boolean(value.polyApiKey) ||
      Boolean(value.polyApiSecret) ||
      Boolean(value.polyApiPassphrase);

    if (hasApiCreds && (!value.polyApiKey || !value.polyApiSecret || !value.polyApiPassphrase)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "POLY_API_KEY, POLY_API_SECRET, and POLY_API_PASSPHRASE must be provided together.",
      });
    }

    if ((value.botMode === "live" && !value.dryRun) || value.polySignatureType !== 0) {
      if (!value.privateKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PRIVATE_KEY is required for live execution or non-EOA Polymarket accounts.",
        });
      }
    }

    if (value.polySignatureType !== 0 && !value.funderAddress) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "FUNDER_ADDRESS is required when POLY_SIGNATURE_TYPE is 1 or 2.",
      });
    }
  });

const parsed = schema.parse({
  cwd: process.cwd(),
  clobApiUrl: envOrArg("CLOB_API_URL", "https://clob.polymarket.com"),
  gammaApiUrl: envOrArg("GAMMA_API_URL", "https://gamma-api.polymarket.com"),
  marketWsUrl: envOrArg("MARKET_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  userWsUrl: envOrArg("USER_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  chainId: envOrArg("CHAIN_ID", "137"),
  botMode: envOrArg("BOT_MODE", envOrArg("MODE", "live"))?.toLowerCase(),
  dryRun: envOrArg("DRY_RUN", "true"),
  logLevel: envOrArg("LOG_LEVEL", "info")?.toLowerCase(),
  logDir: envOrArg("LOG_DIR", "./data"),
  marketPageSize: envOrArg("MARKET_PAGE_SIZE", "200"),
  maxMarkets: envOrArg("MAX_MARKETS", "0"),
  minMarketLiquidity: envOrArg("MIN_MARKET_LIQUIDITY", "250"),
  pollingIntervalMs: envOrArg("POLLING_INTERVAL_MS", "250"),
  heartbeatIntervalMs: envOrArg("HEARTBEAT_INTERVAL_MS", "10000"),
  wsReconnectBaseMs: envOrArg("WS_RECONNECT_BASE_MS", "1000"),
  wsReconnectMaxMs: envOrArg("WS_RECONNECT_MAX_MS", "15000"),
  marketSubscriptionChunkSize: envOrArg("MARKET_SUBSCRIPTION_CHUNK_SIZE", "250"),
  bookSeedConcurrency: envOrArg("BOOK_SEED_CONCURRENCY", "20"),
  feeCacheTtlMs: envOrArg("FEE_CACHE_TTL_MS", "300000"),
  balanceCacheTtlMs: envOrArg("BALANCE_CACHE_TTL_MS", "5000"),
  minProfitThreshold: envOrArg("MIN_PROFIT_THRESHOLD", "0.01"),
  arbitrageBuffer: envOrArg("ARBITRAGE_BUFFER", "0.002"),
  maxTradeSize: envOrArg("MAX_TRADE_SIZE", "100"),
  maxOpenNotional: envOrArg("MAX_OPEN_NOTIONAL", "1000"),
  slippageTolerance: envOrArg("SLIPPAGE_TOLERANCE", "0.02"),
  hedgeSlippageTolerance: envOrArg("HEDGE_SLIPPAGE_TOLERANCE", "0.03"),
  minOrderbookLevels: envOrArg("MIN_ORDERBOOK_LEVELS", "1"),
  executionOrderType: envOrArg("EXECUTION_ORDER_TYPE", "FOK")?.toUpperCase(),
  executionTimeoutMs: envOrArg("EXECUTION_TIMEOUT_MS", "1500"),
  opportunityCooldownMs: envOrArg("OPPORTUNITY_COOLDOWN_MS", "3000"),
  gasCostUsd: envOrArg("GAS_COST_USD", "0.05"),
  allowFeeMarkets: envOrArg("ALLOW_FEE_MARKETS", "true"),
  enableOrderbookPersistence: envOrArg("ENABLE_ORDERBOOK_PERSISTENCE", "false"),
  backtestFile: envOrArg("BACKTEST_FILE", "./data/orderbooks.ndjson"),
  backtestMaxLines: envOrArg("BACKTEST_MAX_LINES", "0"),
  privateKey: envOrArg("PRIVATE_KEY"),
  polySignatureType: envOrArg("POLY_SIGNATURE_TYPE", "0"),
  funderAddress: envOrArg("FUNDER_ADDRESS"),
  polyApiKey: envOrArg("POLY_API_KEY"),
  polyApiSecret: envOrArg("POLY_API_SECRET"),
  polyApiPassphrase: envOrArg("POLY_API_PASSPHRASE"),
  apiKeyNonce: envOrArg("API_KEY_NONCE"),
  webhookUrl: envOrArg("WEBHOOK_URL"),
  telegramBotToken: envOrArg("TELEGRAM_BOT_TOKEN"),
  telegramChatId: envOrArg("TELEGRAM_CHAT_ID"),
});

export const config = {
  ...parsed,
  logDir: path.resolve(parsed.cwd, parsed.logDir),
  backtestFile: path.resolve(parsed.cwd, parsed.backtestFile),
} as const;

export type BotConfig = typeof config;
