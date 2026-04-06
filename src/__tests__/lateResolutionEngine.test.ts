import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { LateResolutionEngine } from "../lateResolutionEngine.js";
import type {
  ExecutionResult,
  LateResolutionAssessment,
  LateResolutionSignal,
  MarketBookState,
} from "../types.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: true,
  lateResolutionMaxSignalAgeMs: 900_000,
  ...overrides,
});

const buildState = (): MarketBookState => ({
  market: {
    id: "market-1",
    conditionId: "condition-1",
    slug: "peru-vs-honduras-btts",
    question: "Peru vs. Honduras: Both Teams to Score",
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
    asks: [{ price: 0.999, size: 100 }],
    bestBid: undefined,
    bestAsk: 0.999,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-token",
    marketId: "condition-1",
    bids: [],
    asks: [{ price: 0.001, size: 100 }],
    bestBid: undefined,
    bestAsk: 0.001,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildSignal = (): LateResolutionSignal => ({
  conditionId: "condition-1",
  resolvedOutcome: "NO",
  source: "manual_test",
  resolvedAt: Date.now(),
});

const buildAssessment = (): LateResolutionAssessment => ({
  viable: true,
  strategyType: "late_resolution",
  market: buildState().market,
  timestamp: Date.now(),
  resolvedOutcome: "NO",
  tradeSize: 5,
  leg: {
    tokenId: "no-token",
    requestedSize: 5,
    executableSize: 5,
    totalCost: 0.005,
    averagePrice: 0.001,
    worstPrice: 0.001,
    slippagePct: 0,
    levelsConsumed: 1,
    bestAsk: 0.001,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  grossEdgeUsd: 4.995,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0.00005,
  totalSpendUsd: 0.005,
  gasUsd: 0.05,
  expectedProfitUsd: 4.94495,
  expectedProfitPct: 988.99,
  source: "manual_test",
});

describe("late resolution engine", () => {
  it("executes a given signal only once", async () => {
    const state = buildState();
    const signal = buildSignal();
    const assessment = buildAssessment();

    const signalStore = {
      getSignal: vi.fn().mockReturnValue(signal),
    };
    const riskManager = {
      evaluateLateResolution: vi.fn().mockResolvedValue(assessment),
      canTriggerOpportunity: vi.fn().mockReturnValue(true),
      markOpportunityTriggered: vi.fn(),
    };
    const executionResult: ExecutionResult = {
      mode: "paper",
      success: true,
      strategyType: "late_resolution",
      market: state.market,
      timestamp: Date.now(),
      tradeSize: 5,
      resolvedOutcome: "NO",
      expectedProfitUsd: 4.94495,
      realizedProfitUsd: 4.94495,
      estimatedSlippageUsd: 0.00005,
      realizedSlippageUsd: 0,
      orderIds: [],
      hedgeOrderIds: [],
      hedged: false,
      notes: ["Paper execution only; no order was posted."],
    };
    const executionEngine = {
      isBusy: vi.fn().mockReturnValue(false),
      executeLateResolution: vi.fn().mockResolvedValue(executionResult),
    };
    const alerts = {
      notifyOpportunity: vi.fn().mockResolvedValue(undefined),
      notifyTrade: vi.fn().mockResolvedValue(undefined),
    };
    const journal = {
      logTrade: vi.fn(),
      logOpportunity: vi.fn(),
    };

    const engine = new LateResolutionEngine(
      createTestConfig(),
      signalStore as never,
      riskManager as never,
      executionEngine as never,
      alerts as never,
      journal as never,
      console as never,
    );

    engine.handleMarketUpdate(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.handleMarketUpdate(state);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executionEngine.executeLateResolution).toHaveBeenCalledTimes(1);
    expect(alerts.notifyOpportunity).toHaveBeenCalledTimes(1);
    expect(journal.logTrade).toHaveBeenCalledTimes(1);
  });
});
