import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { CexPriceFeed } from "../cexPriceFeed.js";
import { CryptoMarketRegistry } from "../cryptoMarketRegistry.js";
import { TemporalArbEngine } from "../temporalArbEngine.js";
import { TemporalArbRiskManager } from "../temporalArbRiskManager.js";
import type {
  CryptoStrikeMarket,
  MarketBookState,
  MarketDefinition,
  SpotPrice,
} from "../types.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: true,
  enableTemporalArbStrategy: true,
  enableCexPriceFeed: true,
  cexPrimaryExchange: "binance",
  cexSymbols: ["BTC", "ETH", "SOL"],
  cexFeedStaleThresholdMs: 100,
  cexFeedReconnectBaseMs: 10,
  cexFeedReconnectMaxMs: 100,
  minTemporalArbConfidence: 0.82,
  maxTemporalArbTradeSize: 30,
  temporalArbCooldownMs: 8_000,
  temporalArbMinTimeRemainingMs: 8_000,
  temporalArbMaxLookaheadMs: 12 * 60 * 60 * 1000,
  temporalArbMaxSpotAgeMs: 2_000,
  temporalArbEstimatedLatencyMs: 250,
  ...overrides,
});

const createLoggerStub = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as const;

const createWalletStub = () =>
  ({
    publicClient: {
      getFeeRateBps: vi.fn().mockResolvedValue(0),
    },
    getCollateralStatus: vi.fn().mockResolvedValue({
      balance: Number.POSITIVE_INFINITY,
      allowance: Number.POSITIVE_INFINITY,
      updatedAt: Date.now(),
    }),
    getProfileAddress: vi.fn().mockReturnValue(undefined),
  }) as const;

const buildMarketDefinition = (overrides: Partial<MarketDefinition> = {}): MarketDefinition => ({
  id: "market-btc",
  conditionId: "condition-btc",
  slug: "btc-above-95000-1215",
  question: "Will BTC be above $95,000 at 12:15 UTC?",
  category: "crypto",
  endDate: "2026-04-06T12:15:00.000Z",
  active: true,
  closed: false,
  liquidity: 10_000,
  volume24hr: 25_000,
  yesTokenId: "yes-token",
  noTokenId: "no-token",
  yesLabel: "Yes",
  noLabel: "No",
  tickSizeHint: 0.01,
  minOrderSize: 1,
  negRisk: false,
  makerBaseFee: 0,
  takerBaseFee: 0,
  ...overrides,
});

const buildCryptoMarket = (overrides: Partial<CryptoStrikeMarket> = {}): CryptoStrikeMarket => ({
  conditionId: "condition-btc",
  slug: "btc-above-95000-1215",
  question: "Will BTC be above $95,000 at 12:15 UTC?",
  symbol: "BTC",
  strikePrice: 95_000,
  windowEndMs: Date.parse("2026-04-06T12:15:00.000Z"),
  windowDurationMinutes: 15,
  yesTokenId: "yes-token",
  noTokenId: "no-token",
  negRisk: false,
  tickSizeHint: 0.01,
  ...overrides,
});

const buildState = (overrides: Partial<MarketBookState> = {}): MarketBookState => {
  const market = buildMarketDefinition();
  return {
    market,
    yes: {
      tokenId: market.yesTokenId,
      marketId: market.conditionId,
      bids: [{ price: 0.48, size: 40 }],
      asks: [{ price: 0.52, size: 40 }],
      bestBid: 0.48,
      bestAsk: 0.52,
      spread: 0.04,
      lastUpdatedAt: Date.now(),
    },
    no: {
      tokenId: market.noTokenId,
      marketId: market.conditionId,
      bids: [{ price: 0.45, size: 40 }],
      asks: [{ price: 0.49, size: 40 }],
      bestBid: 0.45,
      bestAsk: 0.49,
      spread: 0.04,
      lastUpdatedAt: Date.now(),
    },
    lastUpdatedAt: Date.now(),
    ...overrides,
  };
};

const buildSpot = (overrides: Partial<SpotPrice> = {}): SpotPrice => ({
  symbol: "BTC",
  price: 95_600,
  bidPrice: 95_590,
  askPrice: 95_610,
  receivedAt: Date.now(),
  exchange: "binance",
  latencyEstimateMs: 150,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("temporal arb confidence model", () => {
  it("produces high confidence for large edge near expiry", () => {
    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );

    const confidence = manager.calculateResolutionConfidence({
      normalizedEdge: 0.01,
      timeRemainingMs: 10_000,
      spotAgeMs: 50,
      cexSpreadPct: 0.0002,
      polymarketSpread: 0.02,
      latencyEstimateMs: 250,
    });

    expect(confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("stays below the minimum threshold for marginal setups", () => {
    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );

    const confidence = manager.calculateResolutionConfidence({
      normalizedEdge: 0.0005,
      timeRemainingMs: 600_000,
      spotAgeMs: 50,
      cexSpreadPct: 0.0002,
      polymarketSpread: 0.02,
      latencyEstimateMs: 250,
    });

    expect(confidence).toBeLessThan(createTestConfig().minTemporalArbConfidence);
  });

  it("returns the mid-tier confidence bucket around a 0.3% edge", () => {
    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );

    const confidence = manager.calculateResolutionConfidence({
      normalizedEdge: 0.003,
      timeRemainingMs: 60_000,
      spotAgeMs: 50,
      cexSpreadPct: 0.0002,
      polymarketSpread: 0.02,
      latencyEstimateMs: 250,
    });

    expect(confidence).toBeGreaterThanOrEqual(0.88);
    expect(confidence).toBeLessThanOrEqual(0.95);
  });
});

describe("temporal arb EV model", () => {
  it("matches the expected EV formula for a positive setup", () => {
    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );

    const expected = manager.calculateExpectedProfitUsd(0.92, 0.55, 20, 0, 0, 0);

    expect(expected).toBe(7.4);
  });

  it("returns negative EV when confidence trails price", () => {
    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );

    const expected = manager.calculateExpectedProfitUsd(0.8, 0.82, 20, 0, 0, 0);

    expect(expected).toBeLessThan(0);
  });
});

describe("crypto market registry parsing", () => {
  it("extracts symbols and strikes from crypto questions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));

    const registry = new CryptoMarketRegistry(createTestConfig(), createLoggerStub() as never);
    registry.refresh([
      buildMarketDefinition(),
      buildMarketDefinition({
        id: "market-eth",
        conditionId: "condition-eth",
        slug: "eth-above-3200-1500",
        question: "ETH above 3200 at 15:00?",
        endDate: "2026-04-06T15:00:00.000Z",
      }),
      buildMarketDefinition({
        id: "market-sol",
        conditionId: "condition-sol",
        slug: "sol-hit-200",
        question: "Will SOL hit $200 by end of candle?",
        endDate: "2026-04-06T12:10:00.000Z",
      }),
      buildMarketDefinition({
        id: "market-nfl",
        conditionId: "condition-nfl",
        slug: "super-bowl",
        question: "Will the 49ers win the Super Bowl?",
        endDate: "2026-04-06T12:10:00.000Z",
      }),
    ]);

    expect(registry.getMarket("condition-btc")).toMatchObject({
      symbol: "BTC",
      strikePrice: 95_000,
    });
    expect(registry.getMarket("condition-eth")).toMatchObject({
      symbol: "ETH",
      strikePrice: 3_200,
    });
    expect(registry.getMarket("condition-sol")).toMatchObject({
      symbol: "SOL",
      strikePrice: 200,
    });
    expect(registry.getMarket("condition-nfl")).toBeUndefined();
  });
});

describe("temporal arb signal guards", () => {
  it("rejects confidence below the hard floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:10:00.000Z"));

    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );
    const assessment = await manager.evaluate(
      buildCryptoMarket({
        windowEndMs: Date.parse("2026-04-06T12:19:00.000Z"),
      }),
      buildState(),
      buildSpot({
        price: 95_028.5,
        bidPrice: 95_028,
        askPrice: 95_029,
      }),
      Date.now(),
    );

    expect(assessment.viable).toBe(false);
    expect(assessment.reason).toContain("confidence");
  });

  it("rejects time remaining below five seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:14:56.000Z"));

    const manager = new TemporalArbRiskManager(
      createTestConfig({
        temporalArbMinTimeRemainingMs: 1_000,
      }),
      createWalletStub() as never,
      createLoggerStub() as never,
    );
    const assessment = await manager.evaluate(
      buildCryptoMarket(),
      buildState(),
      buildSpot(),
      Date.now(),
    );

    expect(assessment.viable).toBe(false);
    expect(assessment.reason).toContain("Time remaining");
  });

  it("rejects stale spot prices above the five-second hard cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:10:00.000Z"));

    const manager = new TemporalArbRiskManager(
      createTestConfig({
        temporalArbMaxSpotAgeMs: 10_000,
      }),
      createWalletStub() as never,
      createLoggerStub() as never,
    );
    const now = Date.now();
    const assessment = await manager.evaluate(
      buildCryptoMarket({
        windowEndMs: Date.parse("2026-04-06T12:20:00.000Z"),
      }),
      buildState(),
      buildSpot({ receivedAt: now - 5_100 }),
      now,
    );

    expect(assessment.viable).toBe(false);
    expect(assessment.reason).toContain("Spot age");
  });

  it("rejects normalized edges below the hard 0.03% floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:10:00.000Z"));

    const manager = new TemporalArbRiskManager(
      createTestConfig(),
      createWalletStub() as never,
      createLoggerStub() as never,
    );
    const assessment = await manager.evaluate(
      buildCryptoMarket({
        windowEndMs: Date.parse("2026-04-06T12:20:00.000Z"),
      }),
      buildState(),
      buildSpot({
        price: 95_020,
        bidPrice: 95_019,
        askPrice: 95_021,
      }),
      Date.now(),
    );

    expect(assessment.viable).toBe(false);
    expect(assessment.reason).toContain("Normalized edge");
  });
});

describe("cex price feed staleness", () => {
  it("marks a symbol stale after the configured threshold elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:10:00.000Z"));

    const feed = new CexPriceFeed(createTestConfig({ cexFeedStaleThresholdMs: 100 }), createLoggerStub() as never);
    const handleParsedSpot = Reflect.get(feed, "handleParsedSpot") as (
      exchange: "binance" | "coinbase",
      spot: SpotPrice,
    ) => void;
    const checkStaleness = Reflect.get(feed, "checkStaleness") as () => void;

    handleParsedSpot.call(feed, "binance", buildSpot({ receivedAt: Date.now() }));
    expect(feed.isStale("BTC")).toBe(false);

    vi.advanceTimersByTime(150);
    checkStaleness.call(feed);

    expect(feed.isStale("BTC")).toBe(true);
  });

  it("increments staleFeedSkips when the engine sees only stale spot data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:10:00.000Z"));

    const market = buildMarketDefinition({
      endDate: "2026-04-06T12:20:00.000Z",
    });
    const registry = new CryptoMarketRegistry(createTestConfig(), createLoggerStub() as never);
    registry.refresh([market]);

    const riskManager = {
      evaluate: vi.fn(),
      canTriggerOpportunity: vi.fn().mockReturnValue(true),
      markOpportunityTriggered: vi.fn(),
    };
    const feed = {
      getPrice: vi.fn().mockReturnValue(buildSpot()),
      isStale: vi.fn().mockReturnValue(true),
    };
    const store = {
      getMarket: vi.fn().mockReturnValue(buildState({ market })),
    };
    const executionEngine = {
      isBusy: vi.fn().mockReturnValue(false),
      executeTemporal: vi.fn(),
    };
    const alerts = {
      notifyOpportunity: vi.fn().mockResolvedValue(undefined),
      notifyTrade: vi.fn().mockResolvedValue(undefined),
    };
    const journal = {
      logTrade: vi.fn(),
      logOpportunity: vi.fn(),
    };

    const engine = new TemporalArbEngine(
      createTestConfig(),
      registry,
      feed as never,
      store as never,
      riskManager as never,
      executionEngine as never,
      alerts as never,
      journal as never,
      createLoggerStub() as never,
    );

    engine.handleMarketUpdate(buildState({ market }));
    await Promise.resolve();
    await Promise.resolve();

    expect(engine.getStats().staleFeedSkips).toBe(1);
    expect(riskManager.evaluate).not.toHaveBeenCalled();
  });
});
