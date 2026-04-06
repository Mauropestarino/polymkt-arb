import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { ExecutionEngine } from "../executionEngine.js";
import { TradingGuard } from "../tradingGuard.js";
import type { CeilingAssessment, NegRiskAssessment, RiskAssessment } from "../types.js";
import type { OrderBookStore } from "../orderBookStore.js";
import type { RiskManager } from "../riskManager.js";
import type { WalletService } from "../wallet.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: false,
  executionOrderType: "FOK",
  pollingIntervalMs: 1,
  executionTimeoutMs: 10,
  hedgeSlippageTolerance: 0.02,
  ...overrides,
});

const buildAssessment = (): RiskAssessment => ({
  viable: true,
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
  timestamp: 1_710_000_000_000,
  direction: "YES_high",
  tradeSize: 10,
  yes: {
    requestedSize: 10,
    executableSize: 10,
    totalCost: 4.8,
    averagePrice: 0.48,
    worstPrice: 0.48,
    slippagePct: 0,
    levelsConsumed: 1,
    bestAsk: 0.48,
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
    totalCost: 4.8,
    averagePrice: 0.48,
    worstPrice: 0.48,
    slippagePct: 0,
    levelsConsumed: 1,
    bestAsk: 0.48,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  arb: 0.96,
  guaranteedPayoutUsd: 10,
  grossEdgeUsd: 0.4,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0.05,
  totalSpendUsd: 9.6,
  gasUsd: 0.05,
  expectedProfitUsd: 0.3,
  expectedProfitPct: 0.03125,
  netEdgePerShare: 0.03,
});

const buildCeilingAssessment = (): CeilingAssessment => ({
  viable: true,
  strategyType: "binary_ceiling",
  market: buildAssessment().market,
  timestamp: 1_710_000_000_000,
  direction: "YES_high",
  tradeSize: 10,
  yes: {
    requestedSize: 10,
    executableSize: 10,
    totalCost: 5.2,
    averagePrice: 0.52,
    worstPrice: 0.52,
    slippagePct: 0,
    levelsConsumed: 1,
    bestBid: 0.52,
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
    totalCost: 5.1,
    averagePrice: 0.51,
    worstPrice: 0.51,
    slippagePct: 0,
    levelsConsumed: 1,
    bestBid: 0.51,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  arb: 1.03,
  collateralRequiredUsd: 10,
  grossEdgeUsd: 0.3,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0.05,
  totalProceedsUsd: 10.3,
  gasUsd: 0.05,
  expectedProfitUsd: 0.2,
  expectedProfitPct: 0.02,
  netEdgePerShare: 0.02,
});

const buildNegRiskAssessment = (): NegRiskAssessment => ({
  viable: true,
  strategyType: "neg_risk_arb",
  market: {
    ...buildAssessment().market,
    id: "market-a",
    conditionId: "condition-a",
    slug: "candidate-a",
    question: "Candidate A wins?",
    yesTokenId: "yes-a",
    noTokenId: "no-a",
    negRisk: true,
  },
  timestamp: 1_710_000_000_000,
  tradeSize: 10,
  groupId: "0xgroup",
  groupSlug: "election",
  groupQuestion: "Election winner",
  sourceOutcomeIndex: 0,
  negRiskMarketId: "0xgroup",
  convertFeeBps: 0,
  convertOutputSize: 10,
  sourceNo: {
    requestedSize: 10,
    executableSize: 10,
    totalCost: 7,
    averagePrice: 0.7,
    worstPrice: 0.7,
    slippagePct: 0,
    levelsConsumed: 1,
    tokenId: "no-a",
    bestAsk: 0.7,
    fee: {
      feeRateBps: 0,
      feeRate: 0,
      feeExponent: 1,
      feeUsd: 0,
      feeShares: 0,
    },
  },
  targetYesLegs: [
    {
      requestedSize: 10,
      executableSize: 10,
      totalCost: 4.2,
      averagePrice: 0.42,
      worstPrice: 0.42,
      slippagePct: 0,
      levelsConsumed: 1,
      market: {
        ...buildAssessment().market,
        id: "market-b",
        conditionId: "condition-b",
        slug: "candidate-b",
        question: "Candidate B wins?",
        yesTokenId: "yes-b",
        noTokenId: "no-b",
        negRisk: true,
      },
      tokenId: "yes-b",
      bestBid: 0.42,
      fee: {
        feeRateBps: 0,
        feeRate: 0,
        feeExponent: 1,
        feeUsd: 0,
        feeShares: 0,
      },
      outcomeIndex: 1,
      outputSize: 10,
    },
    {
      requestedSize: 10,
      executableSize: 10,
      totalCost: 3.7,
      averagePrice: 0.37,
      worstPrice: 0.37,
      slippagePct: 0,
      levelsConsumed: 1,
      market: {
        ...buildAssessment().market,
        id: "market-c",
        conditionId: "condition-c",
        slug: "candidate-c",
        question: "Candidate C wins?",
        yesTokenId: "yes-c",
        noTokenId: "no-c",
        negRisk: true,
      },
      tokenId: "yes-c",
      bestBid: 0.37,
      fee: {
        feeRateBps: 0,
        feeRate: 0,
        feeExponent: 1,
        feeUsd: 0,
        feeShares: 0,
      },
      outcomeIndex: 2,
      outputSize: 10,
    },
  ],
  arb: 0.09,
  grossEdgeUsd: 0.9,
  totalFeesUsd: 0,
  estimatedSlippageUsd: 0.05,
  totalSpendUsd: 7,
  totalProceedsUsd: 7.9,
  gasUsd: 0.05,
  expectedProfitUsd: 0.85,
  expectedProfitPct: 0.121429,
  netEdgePerShare: 0.085,
});

const createLoggerStub = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as const;

const createRiskManagerStub = () => {
  const release = vi.fn();

  return {
    riskManager: {
      reserve: vi.fn().mockReturnValue(true),
      release,
      getOpenNotionalUsd: vi.fn().mockReturnValue(0),
    } as unknown as RiskManager,
    release,
  };
};

const createStoreStub = () =>
  ({
    getMarket: vi.fn().mockReturnValue({
      market: buildAssessment().market,
      yes: {
        tokenId: "yes-token",
        marketId: "condition-1",
        bids: [{ price: 0.47, size: 100 }],
        asks: [{ price: 0.48, size: 100 }],
        bestBid: 0.47,
        bestAsk: 0.48,
        spread: 0.01,
        lastUpdatedAt: Date.now(),
      },
      no: {
        tokenId: "no-token",
        marketId: "condition-1",
        bids: [{ price: 0.47, size: 100 }],
        asks: [{ price: 0.48, size: 100 }],
        bestBid: 0.47,
        bestAsk: 0.48,
        spread: 0.01,
        lastUpdatedAt: Date.now(),
      },
      lastUpdatedAt: Date.now(),
    }),
  }) as unknown as OrderBookStore;

const createPaperBinaryStoreStub = (options?: {
  yesAsks?: Array<{ price: number; size: number }>;
  noAsks?: Array<{ price: number; size: number }>;
}) =>
  ({
    getMarket: vi.fn().mockReturnValue({
      market: buildAssessment().market,
      yes: {
        tokenId: "yes-token",
        marketId: "condition-1",
        bids: [{ price: 0.47, size: 100 }],
        asks: options?.yesAsks ?? [{ price: 0.48, size: 100 }],
        bestBid: 0.47,
        bestAsk: options?.yesAsks?.[0]?.price ?? 0.48,
        spread: 0.01,
        lastUpdatedAt: Date.now(),
      },
      no: {
        tokenId: "no-token",
        marketId: "condition-1",
        bids: [{ price: 0.47, size: 100 }],
        asks: options?.noAsks ?? [{ price: 0.48, size: 100 }],
        bestBid: 0.47,
        bestAsk: options?.noAsks?.[0]?.price ?? 0.48,
        spread: 0.01,
        lastUpdatedAt: Date.now(),
      },
      lastUpdatedAt: Date.now(),
    }),
  }) as unknown as OrderBookStore;

const createNegRiskStoreStub = () =>
  ({
    getMarket: vi.fn().mockImplementation((conditionId: string) => {
      if (conditionId === "condition-a") {
        return {
          market: buildNegRiskAssessment().market,
          yes: {
            tokenId: "yes-a",
            marketId: "condition-a",
            bids: [{ price: 0.29, size: 100 }],
            asks: [{ price: 0.31, size: 100 }],
            bestBid: 0.29,
            bestAsk: 0.31,
            spread: 0.02,
            lastUpdatedAt: Date.now(),
          },
          no: {
            tokenId: "no-a",
            marketId: "condition-a",
            bids: [{ price: 0.69, size: 100 }],
            asks: [{ price: 0.7, size: 100 }],
            bestBid: 0.69,
            bestAsk: 0.7,
            spread: 0.01,
            lastUpdatedAt: Date.now(),
          },
          lastUpdatedAt: Date.now(),
        };
      }

      if (conditionId === "condition-b") {
        return {
          market: buildNegRiskAssessment().targetYesLegs[0]!.market,
          yes: {
            tokenId: "yes-b",
            marketId: "condition-b",
            bids: [{ price: 0.42, size: 100 }],
            asks: [{ price: 0.43, size: 100 }],
            bestBid: 0.42,
            bestAsk: 0.43,
            spread: 0.01,
            lastUpdatedAt: Date.now(),
          },
          no: {
            tokenId: "no-b",
            marketId: "condition-b",
            bids: [{ price: 0.57, size: 100 }],
            asks: [{ price: 0.58, size: 100 }],
            bestBid: 0.57,
            bestAsk: 0.58,
            spread: 0.01,
            lastUpdatedAt: Date.now(),
          },
          lastUpdatedAt: Date.now(),
        };
      }

      return {
        market: buildNegRiskAssessment().targetYesLegs[1]!.market,
        yes: {
          tokenId: "yes-c",
          marketId: "condition-c",
          bids: [{ price: 0.37, size: 100 }],
          asks: [{ price: 0.38, size: 100 }],
          bestBid: 0.37,
          bestAsk: 0.38,
          spread: 0.01,
          lastUpdatedAt: Date.now(),
        },
        no: {
          tokenId: "no-c",
          marketId: "condition-c",
          bids: [{ price: 0.62, size: 100 }],
          asks: [{ price: 0.63, size: 100 }],
          bestBid: 0.62,
          bestAsk: 0.63,
          spread: 0.01,
          lastUpdatedAt: Date.now(),
        },
        lastUpdatedAt: Date.now(),
      };
    }),
  }) as unknown as OrderBookStore;

const createTradingGuardStub = () =>
  ({
    isTradingEnabled: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ tradingEnabled: true }),
    handleError: vi.fn(),
  }) as unknown as TradingGuard;

describe("execution engine live safeguards", () => {
  it("uses shadow fills in paper mode when both legs still fit after the latency window", async () => {
    const wallet = {} as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const engine = new ExecutionEngine(
      createTestConfig({ dryRun: true, paperShadowLatencyMs: 0 }),
      wallet,
      createPaperBinaryStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
    );

    const result = await engine.execute(buildAssessment());

    expect(result.mode).toBe("paper");
    expect(result.success).toBe(true);
    expect(result.shadowFillSuccess).toBe(true);
    expect(result.shadowRealizedProfitUsd).toBeCloseTo(0.35, 6);
    expect(result.shadowRealizedSlippageUsd).toBe(0);
    expect(result.realizedProfitUsd).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    expect(engine.getStats().shadowFillRate).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reservation_reserved", strategy: "binary_arb" }),
      "Reserved execution notional",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reservation_released", reason: expect.stringContaining("Paper shadow fill completed") }),
      "Released reserved execution notional",
    );
  });

  it("fails paper mode when the shadow book no longer supports both legs", async () => {
    const wallet = {} as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const engine = new ExecutionEngine(
      createTestConfig({
        dryRun: true,
        paperShadowLatencyMs: 0,
      }),
      wallet,
      createPaperBinaryStoreStub({
        yesAsks: [{ price: 0.48, size: 100 }],
        noAsks: [{ price: 0.49, size: 5 }],
      }),
      riskManager,
      tradingGuard,
      logger as never,
    );

    const result = await engine.execute(buildAssessment());

    expect(result.mode).toBe("paper");
    expect(result.success).toBe(false);
    expect(result.shadowFillSuccess).toBe(false);
    expect(result.shadowRealizedProfitUsd).toBeUndefined();
    expect(result.shadowFillReason).toContain("No asks remained inside the shadow limit price.");
    expect(release).toHaveBeenCalledTimes(1);
    expect(engine.getStats().shadowFillRate).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reservation_released", reason: expect.stringContaining("Paper shadow fill failed") }),
      "Released reserved execution notional",
    );
  });

  it("hedges asymmetric FOK fills instead of leaving one-sided exposure", async () => {
    const tradingClient = {
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
      postOrders: vi.fn().mockResolvedValue([{ orderID: "yes-order" }, { orderID: "no-order" }]),
      getOrder: vi.fn().mockImplementation(async (orderId: string) => {
        if (orderId === "yes-order") {
          return {
            status: "matched",
            original_size: 10,
            size_matched: 10,
            size_left: 0,
            asset_id: "yes-token",
          };
        }

        return {
          status: "canceled",
          original_size: 10,
          size_matched: 0,
          size_left: 10,
          asset_id: "no-token",
        };
      }),
      getTrades: vi.fn().mockResolvedValue([]),
      createAndPostMarketOrder: vi.fn().mockResolvedValue({ orderID: "hedge-1" }),
    };
    const wallet = {
      requireTradingClient: vi.fn().mockReturnValue(tradingClient),
    } as unknown as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const engine = new ExecutionEngine(
      createTestConfig(),
      wallet,
      createStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
    );

    const result = await engine.execute(buildAssessment());

    expect(result.success).toBe(true);
    expect(result.hedged).toBe(true);
    expect(result.orderIds).toEqual(["yes-order", "no-order"]);
    expect(result.hedgeOrderIds).toEqual(["hedge-1"]);
    expect(result.notes.some((note) => note.includes("Flattened 10.000000 YES"))).toBe(true);
    expect(result.notes.some((note) => note.includes("reservation released"))).toBe(true);
    expect(tradingClient.createAndPostMarketOrder).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retains the reservation when order submission fails after the exchange boundary", async () => {
    const tradingClient = {
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
      postOrders: vi.fn().mockRejectedValue(new Error("socket reset")),
      getOrder: vi.fn(),
      getTrades: vi.fn().mockResolvedValue([]),
      createAndPostMarketOrder: vi.fn(),
    };
    const wallet = {
      requireTradingClient: vi.fn().mockReturnValue(tradingClient),
    } as unknown as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const engine = new ExecutionEngine(
      createTestConfig(),
      wallet,
      createStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
    );

    const result = await engine.execute(buildAssessment());

    expect(result.success).toBe(false);
    expect(result.notes.some((note) => note.includes("Manual reconciliation is required"))).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(tradingClient.getOrder).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "reservation_retained", strategy: "binary_arb" }),
      "Retained reservation due to unresolved exposure",
    );
  });

  it("merges a fully covered binary arb and reconciles the portfolio", async () => {
    const tradingClient = {
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
      postOrders: vi.fn().mockResolvedValue([{ orderID: "yes-order" }, { orderID: "no-order" }]),
      getOrder: vi.fn().mockResolvedValueOnce({
        status: "matched",
        original_size: 10,
        size_matched: 10,
        size_left: 0,
        asset_id: "yes-token",
      }).mockResolvedValueOnce({
        status: "matched",
        original_size: 10,
        size_matched: 10,
        size_left: 0,
        asset_id: "no-token",
      }),
      getTrades: vi.fn().mockResolvedValue([]),
      createAndPostMarketOrder: vi.fn(),
    };
    const wallet = {
      requireTradingClient: vi.fn().mockReturnValue(tradingClient),
    } as unknown as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const ctfSettlement = {
      isEnabled: vi.fn().mockReturnValue(true),
      mergeFullSet: vi.fn().mockResolvedValue({
        action: "merge",
        conditionId: "condition-1",
        amount: 10,
        txHash: "0xmerge",
        blockNumber: 321,
        gasUsed: "42000",
        confirmedAt: Date.now(),
      }),
    };
    const portfolioReconciler = {
      reconcileMarket: vi.fn().mockResolvedValue({
        user: "0xuser",
        conditionId: "condition-1",
        expectation: "flat",
        satisfied: true,
        attempts: 1,
        reconciledAt: Date.now(),
        positions: [],
        totalValueUsd: 99,
        notes: ["Market reconciled flat after 1 attempt(s)."],
      }),
    };
    const engine = new ExecutionEngine(
      createTestConfig({ autoMergeBinaryArb: true }),
      wallet,
      createStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
      {
        ctfSettlement: ctfSettlement as never,
        portfolioReconciler: portfolioReconciler as never,
      },
    );

    const result = await engine.execute(buildAssessment());

    expect(result.success).toBe(true);
    expect(result.settlementAction).toBe("merge");
    expect(result.settlementTxHash).toBe("0xmerge");
    expect(result.reconciliationSatisfied).toBe(true);
    expect(result.reconciledPortfolioValueUsd).toBe(99);
    expect(ctfSettlement.mergeFullSet).toHaveBeenCalledWith("condition-1", 10);
    expect(portfolioReconciler.reconcileMarket).toHaveBeenCalledWith("condition-1", "flat");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("splits collateral and executes a fully covered ceiling arb", async () => {
    const tradingClient = {
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
      postOrders: vi.fn().mockResolvedValue([{ orderID: "yes-sell" }, { orderID: "no-sell" }]),
      getOrder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "matched",
          original_size: 10,
          size_matched: 10,
          size_left: 0,
          asset_id: "yes-token",
        })
        .mockResolvedValueOnce({
          status: "matched",
          original_size: 10,
          size_matched: 10,
          size_left: 0,
          asset_id: "no-token",
        }),
      getTrades: vi.fn().mockResolvedValue([]),
      createAndPostMarketOrder: vi.fn(),
    };
    const wallet = {
      requireTradingClient: vi.fn().mockReturnValue(tradingClient),
    } as unknown as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const ctfSettlement = {
      isEnabled: vi.fn().mockReturnValue(true),
      splitFullSet: vi.fn().mockResolvedValue({
        action: "split",
        conditionId: "condition-1",
        amount: 10,
        txHash: "0xsplit",
        blockNumber: 654,
        gasUsed: "43000",
        confirmedAt: Date.now(),
      }),
    };
    const portfolioReconciler = {
      reconcileMarket: vi.fn().mockResolvedValue({
        user: "0xuser",
        conditionId: "condition-1",
        expectation: "flat",
        satisfied: true,
        attempts: 1,
        reconciledAt: Date.now(),
        positions: [],
        totalValueUsd: 101,
        notes: ["Market reconciled flat after 1 attempt(s)."],
      }),
    };
    const engine = new ExecutionEngine(
      createTestConfig({ autoSplitBinaryCeiling: true }),
      wallet,
      createStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
      {
        ctfSettlement: ctfSettlement as never,
        portfolioReconciler: portfolioReconciler as never,
      },
    );

    const result = await engine.executeCeiling(buildCeilingAssessment());

    expect(result.success).toBe(true);
    expect(result.strategyType).toBe("binary_ceiling");
    expect(result.settlementAction).toBe("split");
    expect(result.settlementTxHash).toBe("0xsplit");
    expect(result.reconciliationSatisfied).toBe(true);
    expect(ctfSettlement.splitFullSet).toHaveBeenCalledWith("condition-1", 10);
    expect(portfolioReconciler.reconcileMarket).toHaveBeenCalledWith("condition-1", "flat");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("converts a neg-risk NO fill and sells the resulting YES basket", async () => {
    const tradingClient = {
      createOrder: vi.fn().mockResolvedValue({ signed: true }),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce([{ orderID: "source-no" }])
        .mockResolvedValueOnce([{ orderID: "yes-b-sell" }, { orderID: "yes-c-sell" }]),
      getOrder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "matched",
          original_size: 10,
          size_matched: 10,
          size_left: 0,
          asset_id: "no-a",
        })
        .mockResolvedValueOnce({
          status: "matched",
          original_size: 10,
          size_matched: 10,
          size_left: 0,
          asset_id: "yes-b",
        })
        .mockResolvedValueOnce({
          status: "matched",
          original_size: 10,
          size_matched: 10,
          size_left: 0,
          asset_id: "yes-c",
        }),
      getTrades: vi.fn().mockResolvedValue([]),
      createAndPostMarketOrder: vi.fn(),
    };
    const wallet = {
      requireTradingClient: vi.fn().mockReturnValue(tradingClient),
    } as unknown as WalletService;
    const { riskManager, release } = createRiskManagerStub();
    const tradingGuard = createTradingGuardStub();
    const logger = createLoggerStub();
    const ctfSettlement = {
      canConvertNegRisk: vi.fn().mockReturnValue(true),
      convertNegRiskPosition: vi.fn().mockResolvedValue({
        action: "convert",
        conditionId: "condition-a",
        amount: 10,
        txHash: "0xconvert",
        blockNumber: 777,
        gasUsed: "45000",
        confirmedAt: Date.now(),
      }),
    };
    const portfolioReconciler = {
      reconcileMarket: vi.fn().mockResolvedValue({
        user: "0xuser",
        conditionId: "condition-a",
        expectation: "flat",
        satisfied: true,
        attempts: 1,
        reconciledAt: Date.now(),
        positions: [],
        totalValueUsd: 102,
        notes: ["Market reconciled flat after 1 attempt(s)."],
      }),
    };
    const engine = new ExecutionEngine(
      createTestConfig({ autoConvertNegRisk: true }),
      wallet,
      createNegRiskStoreStub(),
      riskManager,
      tradingGuard,
      logger as never,
      {
        ctfSettlement: ctfSettlement as never,
        portfolioReconciler: portfolioReconciler as never,
      },
    );

    const result = await engine.executeNegRisk(buildNegRiskAssessment());

    expect(result.success).toBe(true);
    expect(result.strategyType).toBe("neg_risk_arb");
    expect(result.settlementAction).toBe("convert");
    expect(result.settlementTxHash).toBe("0xconvert");
    expect(result.groupId).toBe("0xgroup");
    expect(result.orderIds).toEqual(["source-no", "yes-b-sell", "yes-c-sell"]);
    expect(ctfSettlement.convertNegRiskPosition).toHaveBeenCalledWith(
      "condition-a",
      "0xgroup",
      0,
      10,
    );
    expect(portfolioReconciler.reconcileMarket).toHaveBeenCalledWith("condition-a", "flat");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
