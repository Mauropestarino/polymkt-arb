import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { RiskManager } from "../riskManager.js";
import type { MarketBookState, NegRiskGroup } from "../types.js";
import type { WalletService } from "../wallet.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  dryRun: true,
  maxOpenNotional: 100,
  opportunityCooldownMs: 3_000,
  ...overrides,
});

const createWalletStub = (): WalletService =>
  ({
    publicClient: {
      getFeeRateBps: vi.fn().mockResolvedValue(0),
    },
    getCollateralStatus: vi.fn().mockResolvedValue({
      balance: 10_000,
      allowance: 10_000,
      updatedAt: Date.now(),
    }),
  }) as unknown as WalletService;

const buildState = (): MarketBookState => ({
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
    asks: [{ price: 0.48, size: 100 }],
    bestAsk: 0.48,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-token",
    marketId: "condition-1",
    bids: [],
    asks: [{ price: 0.48, size: 100 }],
    bestAsk: 0.48,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildCeilingState = (): MarketBookState => ({
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
    bids: [{ price: 0.52, size: 100 }],
    asks: [],
    bestBid: 0.52,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-token",
    marketId: "condition-1",
    bids: [{ price: 0.51, size: 100 }],
    asks: [],
    bestBid: 0.51,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildNegRiskSourceState = (): MarketBookState => ({
  market: {
    ...buildState().market,
    id: "market-a",
    conditionId: "condition-a",
    slug: "candidate-a",
    question: "Candidate A wins?",
    yesTokenId: "yes-a",
    noTokenId: "no-a",
    negRisk: true,
  },
  yes: {
    tokenId: "yes-a",
    marketId: "condition-a",
    bids: [{ price: 0.29, size: 100 }],
    asks: [{ price: 0.31, size: 100 }],
    bestBid: 0.29,
    bestAsk: 0.31,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: "no-a",
    marketId: "condition-a",
    bids: [{ price: 0.68, size: 100 }],
    asks: [{ price: 0.70, size: 100 }],
    bestBid: 0.68,
    bestAsk: 0.70,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildNegRiskTargetState = (
  conditionId: string,
  slug: string,
  question: string,
  yesBid: number,
): MarketBookState => ({
  market: {
    ...buildState().market,
    id: slug,
    conditionId,
    slug,
    question,
    yesTokenId: `yes-${conditionId}`,
    noTokenId: `no-${conditionId}`,
    negRisk: true,
  },
  yes: {
    tokenId: `yes-${conditionId}`,
    marketId: conditionId,
    bids: [{ price: yesBid, size: 100 }],
    asks: [{ price: yesBid + 0.01, size: 100 }],
    bestBid: yesBid,
    bestAsk: yesBid + 0.01,
    lastUpdatedAt: Date.now(),
  },
  no: {
    tokenId: `no-${conditionId}`,
    marketId: conditionId,
    bids: [{ price: 1 - yesBid - 0.01, size: 100 }],
    asks: [{ price: 1 - yesBid, size: 100 }],
    bestBid: 1 - yesBid - 0.01,
    bestAsk: 1 - yesBid,
    lastUpdatedAt: Date.now(),
  },
  lastUpdatedAt: Date.now(),
});

const buildNegRiskGroup = (): NegRiskGroup => ({
  id: "0xgroup",
  eventId: "event-1",
  slug: "election",
  title: "Election winner",
  negRiskMarketId: "0xgroup",
  convertFeeBps: 0,
  augmented: false,
  members: [
    {
      conditionId: "condition-a",
      marketId: "market-a",
      slug: "candidate-a",
      question: "Candidate A wins?",
      outcomeIndex: 0,
    },
    {
      conditionId: "condition-b",
      marketId: "market-b",
      slug: "candidate-b",
      question: "Candidate B wins?",
      outcomeIndex: 1,
    },
    {
      conditionId: "condition-c",
      marketId: "market-c",
      slug: "candidate-c",
      question: "Candidate C wins?",
      outcomeIndex: 2,
    },
  ],
});

describe("risk manager guardrails", () => {
  it("blocks trades when open notional reaches the configured cap", () => {
    const riskManager = new RiskManager(createTestConfig({ maxOpenNotional: 100 }), createWalletStub(), console as never);

    expect(riskManager.reserve("first", 100)).toBe(true);
    expect(riskManager.reserve("second", 1)).toBe(false);
  });

  it("enforces cooldown for the same market-direction key", () => {
    const riskManager = new RiskManager(
      createTestConfig({ opportunityCooldownMs: 3_000 }),
      createWalletStub(),
      console as never,
    );

    const key = "condition-1:YES_high";
    riskManager.markOpportunityTriggered(key, 1_000);

    expect(riskManager.canTriggerOpportunity(key, 2_000)).toBe(false);
    expect(riskManager.canTriggerOpportunity(key, 4_100)).toBe(true);
  });

  it("uses the official taker fee formula C * feeRate * p * (1-p)", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.01, maxTradeSize: 50 }),
      ({
        publicClient: {
          getFeeRateBps: vi.fn().mockResolvedValue(100),
        },
        getCollateralStatus: vi.fn().mockResolvedValue({
          balance: 10_000,
          allowance: 10_000,
          updatedAt: Date.now(),
        }),
      }) as unknown as WalletService,
      console as never,
    );

    const assessment = await riskManager.evaluate(buildState(), { skipBalanceChecks: true });
    const expectedFeePerLeg = assessment.tradeSize * 0.01 * 0.48 * (1 - 0.48);

    expect(assessment.viable).toBe(true);
    expect(assessment.totalFeesUsd).toBeCloseTo(expectedFeePerLeg * 2, 6);
    expect(assessment.yes.fee.feeUsd).toBeCloseTo(expectedFeePerLeg, 6);
    expect(assessment.no.fee.feeUsd).toBeCloseTo(expectedFeePerLeg, 6);
  });

  it("detects a viable ceiling arb when bid_yes + bid_no clears 1 after costs", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.01, gasCostUsd: 0.05, maxTradeSize: 100 }),
      createWalletStub(),
      console as never,
    );

    const assessment = await riskManager.evaluateCeiling(buildCeilingState(), { skipBalanceChecks: true });

    expect(assessment.viable).toBe(true);
    expect(assessment.strategyType).toBe("binary_ceiling");
    expect(assessment.expectedProfitUsd).toBeGreaterThan(0);
    expect(assessment.collateralRequiredUsd).toBe(100);
    expect(assessment.totalProceedsUsd).toBe(103);
  });

  it("detects a viable neg-risk arb when converted YES legs exceed the source NO cost", async () => {
    const riskManager = new RiskManager(
      createTestConfig({ slippageTolerance: 0.01, gasCostUsd: 0.05, maxTradeSize: 100 }),
      createWalletStub(),
      console as never,
    );

    const assessment = await riskManager.evaluateNegRisk(
      buildNegRiskGroup(),
      buildNegRiskSourceState(),
      [
        buildNegRiskTargetState("condition-b", "candidate-b", "Candidate B wins?", 0.42),
        buildNegRiskTargetState("condition-c", "candidate-c", "Candidate C wins?", 0.37),
      ],
      { skipBalanceChecks: true },
    );

    expect(assessment.viable).toBe(true);
    expect(assessment.strategyType).toBe("neg_risk_arb");
    expect(assessment.tradeSize).toBe(100);
    expect(assessment.totalSpendUsd).toBe(70);
    expect(assessment.totalProceedsUsd).toBe(79);
    expect(assessment.expectedProfitUsd).toBeGreaterThan(0);
    expect(assessment.targetYesLegs).toHaveLength(2);
  });
});
