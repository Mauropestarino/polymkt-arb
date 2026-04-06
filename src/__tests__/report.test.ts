import { describe, expect, it } from "vitest";
import type { OpportunityReportRow, TradeReportRow } from "../report.js";
import { summarizeReport } from "../report.js";

describe("report summary", () => {
  it("keeps expected pnl separate from shadow realized pnl in paper mode", () => {
    const trades: TradeReportRow[] = [
      {
        type: "trade",
        timestamp: 1_000,
        success: true,
        mode: "paper",
        marketId: "market-paper",
        slug: "market-paper",
        question: "Paper market",
        strategyType: "binary_arb",
        tradeSize: 10,
        expectedProfitUsd: 2,
        estimatedSlippageUsd: 0.1,
        shadowFillSuccess: true,
        shadowLatencyMs: 150,
        shadowRealizedProfitUsd: 0.6,
        shadowRealizedSlippageUsd: 0.2,
        orderIds: [],
        hedgeOrderIds: [],
        notes: [],
      },
      {
        type: "trade",
        timestamp: 2_000,
        success: true,
        mode: "live",
        marketId: "market-live",
        slug: "market-live",
        question: "Live market",
        strategyType: "binary_ceiling",
        tradeSize: 5,
        expectedProfitUsd: 1.2,
        realizedProfitUsd: 0.9,
        estimatedSlippageUsd: 0.05,
        realizedSlippageUsd: 0.03,
        orderIds: ["live-1"],
        hedgeOrderIds: [],
        notes: [],
      },
    ];

    const summary = summarizeReport(trades, []);

    expect(summary.total.totalExpectedPnlUsd).toBe(3.2);
    expect(summary.total.totalRealizedPnlUsd).toBe(0.9);
    expect(summary.total.totalShadowRealizedPnlUsd).toBe(0.6);
    expect(summary.total.shadowAttempts).toBe(1);
    expect(summary.total.shadowSuccesses).toBe(1);

    const paperBucket = summary.byMode.find((bucket) => bucket.label === "paper");
    expect(paperBucket?.totalRealizedPnlUsd).toBe(0);
    expect(paperBucket?.totalShadowRealizedPnlUsd).toBe(0.6);
  });

  it("surfaces neg-risk near misses ordered by closest threshold delta", () => {
    const opportunities: OpportunityReportRow[] = [
      {
        type: "opportunity",
        timestamp: 1_000,
        marketId: "neg-1",
        slug: "neg-1",
        question: "Neg 1",
        strategyType: "neg_risk_arb",
        arb: 0.03,
        rawSpreadUsd: 0.03,
        tradeSize: 10,
        sourceNoCostUsd: 7.1,
        targetYesProceedsUsd: 7.2,
        convertFeeBps: 25,
        totalFeesUsd: 0.03,
        estimatedSlippageUsd: 0.02,
        gasUsd: 0.05,
        expectedProfitUsd: 0.01,
        expectedProfitPct: 0.0014,
        requiredProfitUsd: 0.0355,
        thresholdDeltaUsd: -0.0255,
        viable: false,
        reason: "No candidate size cleared min profit for neg-risk arb after fees, gas, and slippage.",
      },
      {
        type: "opportunity",
        timestamp: 2_000,
        marketId: "neg-2",
        slug: "neg-2",
        question: "Neg 2",
        strategyType: "neg_risk_arb",
        arb: 0.05,
        rawSpreadUsd: 0.05,
        tradeSize: 10,
        sourceNoCostUsd: 6.8,
        targetYesProceedsUsd: 6.86,
        convertFeeBps: 25,
        totalFeesUsd: 0.015,
        estimatedSlippageUsd: 0.01,
        gasUsd: 0.05,
        expectedProfitUsd: 0.02,
        expectedProfitPct: 0.0029,
        requiredProfitUsd: 0.034,
        thresholdDeltaUsd: -0.014,
        viable: false,
        reason: "No candidate size cleared min profit for neg-risk arb after fees, gas, and slippage.",
      },
      {
        type: "opportunity",
        timestamp: 3_000,
        marketId: "binary-1",
        slug: "binary-1",
        question: "Binary",
        strategyType: "binary_arb",
        arb: 0.96,
        tradeSize: 10,
        expectedProfitUsd: 0.2,
        expectedProfitPct: 0.02,
        viable: true,
      },
    ];

    const summary = summarizeReport([], opportunities);

    expect(summary.negRiskNearMisses).toHaveLength(2);
    expect(summary.negRiskNearMisses[0]?.marketId).toBe("neg-2");
    expect(summary.negRiskNearMisses[0]?.thresholdDeltaUsd).toBe(-0.014);
    expect(summary.negRiskNearMisses[1]?.marketId).toBe("neg-1");
  });

  it("summarizes shadow fill reasons globally and by strategy", () => {
    const trades: TradeReportRow[] = [
      {
        type: "trade",
        timestamp: 1_000,
        success: false,
        mode: "paper",
        marketId: "market-1",
        slug: "market-1",
        question: "Market 1",
        strategyType: "binary_arb",
        tradeSize: 10,
        expectedProfitUsd: 0.4,
        shadowFillSuccess: false,
        shadowFillReason: "No asks remained inside the shadow limit price.",
        orderIds: [],
        hedgeOrderIds: [],
        notes: [],
      },
      {
        type: "trade",
        timestamp: 2_000,
        success: false,
        mode: "paper",
        marketId: "market-2",
        slug: "market-2",
        question: "Market 2",
        strategyType: "binary_arb",
        tradeSize: 11,
        expectedProfitUsd: 0.5,
        shadowFillSuccess: false,
        shadowFillReason: "No asks remained inside the shadow limit price.",
        orderIds: [],
        hedgeOrderIds: [],
        notes: [],
      },
      {
        type: "trade",
        timestamp: 3_000,
        success: false,
        mode: "paper",
        marketId: "market-3",
        slug: "market-3",
        question: "Market 3",
        strategyType: "binary_ceiling",
        tradeSize: 9,
        expectedProfitUsd: 0.3,
        shadowFillSuccess: false,
        shadowFillReason: "No bids remained inside the shadow limit price.",
        orderIds: [],
        hedgeOrderIds: [],
        notes: [],
      },
    ];

    const summary = summarizeReport(trades, []);

    expect(summary.shadowFillReasons[0]).toEqual({
      reason: "No asks remained inside the shadow limit price.",
      count: 2,
    });
    expect(summary.shadowFillReasonsByStrategy).toEqual([
      {
        strategy: "binary_arb",
        reasons: [
          {
            reason: "No asks remained inside the shadow limit price.",
            count: 2,
          },
        ],
      },
      {
        strategy: "binary_ceiling",
        reasons: [
          {
            reason: "No bids remained inside the shadow limit price.",
            count: 1,
          },
        ],
      },
    ]);
  });
});
