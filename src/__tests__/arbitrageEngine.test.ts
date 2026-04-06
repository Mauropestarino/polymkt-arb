import { describe, expect, it, vi } from "vitest";
import { calculateNetProfitModel } from "../lib/arbitrageMath.js";
import { config as baseConfig, type BotConfig } from "../config.js";
import { RiskManager } from "../riskManager.js";
import type { MarketBookState } from "../types.js";
import type { WalletService } from "../wallet.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: true,
  minProfitThreshold: 0.005,
  slippageTolerance: 0.001,
  gasCostUsd: 0.05,
  maxTradeSize: 100,
  maxOpenNotional: 1_000,
  ...overrides,
});

const createWalletStub = ({
  feeRateBps = 0,
  balance = 10_000,
  allowance = 10_000,
}: {
  feeRateBps?: number;
  balance?: number;
  allowance?: number;
} = {}): WalletService =>
  ({
    publicClient: {
      getFeeRateBps: vi.fn().mockResolvedValue(feeRateBps),
    },
    getCollateralStatus: vi.fn().mockResolvedValue({
      balance,
      allowance,
      updatedAt: Date.now(),
    }),
  }) as unknown as WalletService;

const buildState = (
  yesAsk: number,
  noAsk: number,
  size = 100,
  overrides?: {
    yesAsks?: Array<{ price: number; size: number }>;
    noAsks?: Array<{ price: number; size: number }>;
  },
): MarketBookState => ({
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
    asks: overrides?.yesAsks ?? [{ price: yesAsk, size }],
    bestBid: undefined,
    bestAsk: yesAsk,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-token",
    marketId: "condition-1",
    bids: [],
    asks: overrides?.noAsks ?? [{ price: noAsk, size }],
    bestBid: undefined,
    bestAsk: noAsk,
    spread: undefined,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

describe("arbitrage profit model", () => {
  it("flags a true positive when net profit is above threshold", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.001 }),
      createWalletStub({ feeRateBps: 170 }),
      console as never,
    );

    const assessment = await riskManager.evaluate(buildState(0.48, 0.48, 100));

    expect(assessment.viable).toBe(true);
    expect(assessment.expectedProfitUsd).toBeGreaterThan(0);
    expect(assessment.expectedProfitPct).toBeGreaterThan(0.005);
  });

  it("rejects a true negative when gross edge is negative", async () => {
    const riskManager = new RiskManager(
      createTestConfig(),
      createWalletStub({ feeRateBps: 0 }),
      console as never,
    );

    const assessment = await riskManager.evaluate(buildState(0.5, 0.51, 100));

    expect(assessment.viable).toBe(false);
    expect(assessment.expectedProfitUsd).toBeLessThanOrEqual(0);
  });

  it("rejects an edge when fees eat the profit", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.001 }),
      createWalletStub({ feeRateBps: 1500 }),
      console as never,
    );

    const assessment = await riskManager.evaluate(buildState(0.485, 0.485, 100));
    const profitModel = calculateNetProfitModel({
      tradeSize: 100,
      totalSpendUsd: 97,
      feeLeg1Usd: 1.8,
      feeLeg2Usd: 1.8,
      gasCostUsd: 0.05,
      slippageTolerance: 0.001,
    });

    expect(assessment.viable).toBe(false);
    expect(profitModel.totalFeesUsd).toBeGreaterThan(0);
    expect(profitModel.netProfitUsd).toBeLessThanOrEqual(0);
  });

  it("rejects an edge when actual sweep slippage eats the spread", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.1 }),
      createWalletStub({ feeRateBps: 0 }),
      console as never,
    );

    const assessment = await riskManager.evaluate(
      buildState(0.48, 0.48, 100, {
        yesAsks: [
          { price: 0.48, size: 1 },
          { price: 0.52, size: 99 },
        ],
        noAsks: [
          { price: 0.48, size: 1 },
          { price: 0.52, size: 99 },
        ],
      }),
    );
    const profitModel = calculateNetProfitModel({
      tradeSize: 100,
      totalSpendUsd: 100,
      feeLeg1Usd: 0,
      feeLeg2Usd: 0,
      gasCostUsd: 0.05,
      slippageTolerance: 0.1,
      estimatedSlippageUsd: 4,
    });

    expect(assessment.viable).toBe(false);
    expect(profitModel.estimatedSlippageUsd).toBeGreaterThanOrEqual(4);
    expect(profitModel.netProfitUsd).toBeLessThanOrEqual(0);
  });
});
