import { describe, expect, it, vi } from "vitest";
import { ArbitrageEngine } from "../arbitrageEngine.js";
import { config as baseConfig, type BotConfig } from "../config.js";
import type { ExecutionResult, MarketBookState, RiskAssessment } from "../types.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: true,
  arbitrageBuffer: 0.002,
  ...overrides,
});

const buildState = (yesAsk: number, noAsk: number): MarketBookState => ({
  market: {
    id: "market-1",
    conditionId: "condition-1",
    slug: "synthetic-market",
    question: "Synthetic market",
    category: "sports",
    active: true,
    closed: false,
    liquidity: 10_000,
    volume24hr: 10_000,
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    yesLabel: "Yes",
    noLabel: "No",
    tickSizeHint: 0.01,
    minOrderSize: 1,
    negRisk: false,
    makerBaseFee: 0,
    takerBaseFee: 0,
  },
  yes: {
    tokenId: "yes-token",
    marketId: "condition-1",
    bids: [],
    asks: [{ price: yesAsk, size: 100 }],
    bestBid: undefined,
    bestAsk: yesAsk,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-token",
    marketId: "condition-1",
    bids: [],
    asks: [{ price: noAsk, size: 100 }],
    bestBid: undefined,
    bestAsk: noAsk,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildFailureAssessment = (state: MarketBookState): RiskAssessment => ({
  viable: false,
  reason: "No candidate size cleared min profit after slippage, fees, and gas.",
  market: state.market,
  timestamp: Date.now(),
  direction: "YES_high",
  tradeSize: 0,
  yes: {
    requestedSize: 0,
    executableSize: 0,
    totalCost: 0,
    averagePrice: 0,
    worstPrice: 0,
    slippagePct: 0,
    levelsConsumed: 0,
    bestAsk: state.yes.bestAsk ?? 0,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  no: {
    requestedSize: 0,
    executableSize: 0,
    totalCost: 0,
    averagePrice: 0,
    worstPrice: 0,
    slippagePct: 0,
    levelsConsumed: 0,
    bestAsk: state.no.bestAsk ?? 0,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  arb: (state.yes.bestAsk ?? 0) + (state.no.bestAsk ?? 0),
  guaranteedPayoutUsd: 0,
  grossEdgeUsd: 0,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0,
  totalSpendUsd: 0,
  gasUsd: 0.05,
  expectedProfitUsd: 0,
  expectedProfitPct: 0,
  netEdgePerShare: 0,
});

const buildViableAssessment = (state: MarketBookState): RiskAssessment => ({
  viable: true,
  reason: undefined,
  market: state.market,
  timestamp: Date.now(),
  direction: "YES_high",
  tradeSize: 10,
  yes: {
    requestedSize: 10,
    executableSize: 10,
    totalCost: 4.9,
    averagePrice: state.yes.bestAsk ?? 0.49,
    worstPrice: state.yes.bestAsk ?? 0.49,
    slippagePct: 0,
    levelsConsumed: 1,
    bestAsk: state.yes.bestAsk ?? 0.49,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  no: {
    requestedSize: 10,
    executableSize: 10,
    totalCost: 4.9,
    averagePrice: state.no.bestAsk ?? 0.49,
    worstPrice: state.no.bestAsk ?? 0.49,
    slippagePct: 0,
    levelsConsumed: 1,
    bestAsk: state.no.bestAsk ?? 0.49,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  arb: (state.yes.bestAsk ?? 0) + (state.no.bestAsk ?? 0),
  guaranteedPayoutUsd: 10,
  grossEdgeUsd: 0.2,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0,
  totalSpendUsd: 9.8,
  gasUsd: 0.05,
  expectedProfitUsd: 0.15,
  expectedProfitPct: 0.015,
  netEdgePerShare: 0.015,
});

const buildExecutionResult = (state: MarketBookState): ExecutionResult => ({
  mode: "paper",
  success: true,
  strategyType: "binary_arb",
  market: state.market,
  timestamp: Date.now(),
  tradeSize: 10,
  expectedProfitUsd: 0.15,
  realizedProfitUsd: 0,
  estimatedSlippageUsd: 0,
  realizedSlippageUsd: 0,
  orderIds: [],
  notes: ["shadow fill remained executable"],
  hedged: false,
  hedgeOrderIds: [],
  shadowFillSuccess: true,
  shadowFillReason: "Shadow fill remained executable after 150ms.",
  shadowLatencyMs: 150,
  shadowRealizedProfitUsd: 0.12,
  shadowRealizedSlippageUsd: 0,
});

describe("arbitrage lifecycle", () => {
  it("persists the rejection reason even when the edge expires during async evaluation", async () => {
    const arbState = buildState(0.49, 0.49);
    const expiredState = buildState(0.55, 0.55);

    const riskManager = {
      evaluate: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return buildFailureAssessment(arbState);
      }),
      canTriggerOpportunity: vi.fn().mockReturnValue(true),
      markOpportunityTriggered: vi.fn(),
    };
    const executionEngine = {
      isBusy: vi.fn().mockReturnValue(false),
      execute: vi.fn(),
    };
    const alerts = {
      notifyOpportunity: vi.fn().mockResolvedValue(undefined),
      notifyTrade: vi.fn().mockResolvedValue(undefined),
    };
    const journal = {
      logOpportunity: vi.fn(),
      logTrade: vi.fn(),
    };

    const engine = new ArbitrageEngine(
      createTestConfig(),
      riskManager as never,
      executionEngine as never,
      alerts as never,
      journal as never,
      console as never,
    );

    engine.handleMarketUpdate(arbState);
    engine.handleMarketUpdate(expiredState);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(riskManager.evaluate).toHaveBeenCalledTimes(1);
    expect(executionEngine.execute).not.toHaveBeenCalled();
    expect(journal.logTrade).not.toHaveBeenCalled();
    expect(journal.logOpportunity).toHaveBeenCalledTimes(1);
    expect(journal.logOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: "condition-1",
        viable: false,
        reason: "No candidate size cleared min profit after slippage, fees, and gas.",
      }),
    );
  });

  it("skips execution and counts stale books when the market snapshot is too old", async () => {
    const staleState = {
      ...buildState(0.49, 0.49),
      lastUpdatedAt: Date.now() - 1_000,
    };

    const riskManager = {
      evaluate: vi.fn().mockResolvedValue(buildViableAssessment(staleState)),
      canTriggerOpportunity: vi.fn().mockReturnValue(true),
      markOpportunityTriggered: vi.fn(),
    };
    const executionEngine = {
      isBusy: vi.fn().mockReturnValue(false),
      execute: vi.fn(),
    };
    const alerts = {
      notifyOpportunity: vi.fn().mockResolvedValue(undefined),
      notifyTrade: vi.fn().mockResolvedValue(undefined),
    };
    const journal = {
      logOpportunity: vi.fn(),
      logTrade: vi.fn(),
    };

    const engine = new ArbitrageEngine(
      createTestConfig({ maxBookAgeMs: 50 }),
      riskManager as never,
      executionEngine as never,
      alerts as never,
      journal as never,
      console as never,
    );

    engine.handleMarketUpdate(staleState);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(riskManager.evaluate).toHaveBeenCalledTimes(1);
    expect(executionEngine.execute).not.toHaveBeenCalled();
    expect(engine.getStats().staleBooksSkipped).toBe(1);
    expect(engine.getStats().lastBookAgeMs).toBeGreaterThan(50);
    expect(riskManager.markOpportunityTriggered).not.toHaveBeenCalled();
  });

  it("lets fresh books execute normally when they are inside the freshness budget", async () => {
    const freshState = buildState(0.49, 0.49);

    const riskManager = {
      evaluate: vi.fn().mockResolvedValue(buildViableAssessment(freshState)),
      canTriggerOpportunity: vi.fn().mockReturnValue(true),
      markOpportunityTriggered: vi.fn(),
    };
    const executionEngine = {
      isBusy: vi.fn().mockReturnValue(false),
      execute: vi.fn().mockResolvedValue(buildExecutionResult(freshState)),
    };
    const alerts = {
      notifyOpportunity: vi.fn().mockResolvedValue(undefined),
      notifyTrade: vi.fn().mockResolvedValue(undefined),
    };
    const journal = {
      logOpportunity: vi.fn(),
      logTrade: vi.fn(),
    };

    const engine = new ArbitrageEngine(
      createTestConfig({ maxBookAgeMs: 500 }),
      riskManager as never,
      executionEngine as never,
      alerts as never,
      journal as never,
      console as never,
    );

    engine.handleMarketUpdate(freshState);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executionEngine.execute).toHaveBeenCalledTimes(1);
    expect(journal.logTrade).toHaveBeenCalledTimes(1);
    expect(engine.getStats().staleBooksSkipped).toBe(0);
    expect(engine.getStats().lastBookAgeMs).toBeLessThanOrEqual(500);
  });
});
