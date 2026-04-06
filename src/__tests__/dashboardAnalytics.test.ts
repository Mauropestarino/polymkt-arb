import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardAnalyticsService } from "../dashboardAnalytics.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dirPath) => rm(dirPath, { force: true, recursive: true })),
  );
});

const createLogDir = async (): Promise<string> => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "polymarket-dashboard-"));
  tempDirs.push(dirPath);
  return dirPath;
};

describe("DashboardAnalyticsService", () => {
  it("aggregates trades, opportunities, and errors from ndjson logs", async () => {
    const logDir = await createLogDir();

    await writeFile(
      path.join(logDir, "trades.2026-04-01.ndjson"),
      [
        {
          type: "trade",
          timestamp: 1_000,
          success: true,
          mode: "paper",
          marketId: "mkt-a",
          slug: "market-a",
          question: "Question A",
          strategyType: "binary_arb",
          tradeSize: 15,
          expectedProfitUsd: 1.2,
          shadowFillSuccess: true,
          shadowFillReason: "Shadow fill remained executable after 150ms.",
          shadowLatencyMs: 150,
          shadowRealizedProfitUsd: 1.1,
          estimatedSlippageUsd: 0.1,
          shadowRealizedSlippageUsd: 0.05,
          orderIds: ["ord-1", "ord-2"],
          hedgeOrderIds: [],
          notes: ["filled cleanly"],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(logDir, "trades.ndjson"),
      [
        {
          type: "trade",
          timestamp: 2_000,
          success: false,
          mode: "live",
          marketId: "mkt-b",
          slug: "market-b",
          question: "Question B",
          strategyType: "binary_ceiling",
          tradeSize: 8,
          expectedProfitUsd: 0.7,
          realizedProfitUsd: -0.2,
          estimatedSlippageUsd: 0.04,
          realizedSlippageUsd: 0.09,
          orderIds: ["ord-3"],
          hedgeOrderIds: ["hedge-1"],
          notes: ["hedge required"],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(logDir, "opportunities.ndjson"),
      [
        {
          type: "opportunity",
          timestamp: 1_500,
          marketId: "mkt-a",
          slug: "market-a",
          question: "Question A",
          strategyType: "binary_arb",
          arb: 0.9,
          tradeSize: 15,
          expectedProfitUsd: 1.2,
          expectedProfitPct: 0.08,
          viable: true,
          opportunity_duration_ms: 120,
        },
        {
          type: "opportunity",
          timestamp: 1_700,
          marketId: "mkt-c",
          slug: "market-c",
          question: "Question C",
          strategyType: "binary_ceiling",
          arb: 0.99,
          tradeSize: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          viable: false,
          reason: "No candidate size cleared min profit after slippage, fees, and gas.",
          opportunity_duration_ms: 80,
        },
        {
          type: "opportunity",
          timestamp: 1_900,
          marketId: "mkt-neg",
          slug: "market-neg",
          question: "Question Neg",
          strategyType: "neg_risk_arb",
          arb: 1.01,
          tradeSize: 12,
          expectedProfitUsd: -0.01,
          expectedProfitPct: -0.0002,
          viable: false,
          reason: "No candidate size cleared min profit for neg-risk arb after fees, gas, and slippage.",
          opportunity_duration_ms: 3100,
          rawSpreadUsd: 0.18,
          sourceNoCostUsd: 5.12,
          targetYesProceedsUsd: 5.22,
          convertFeeBps: 10,
          totalFeesUsd: 0.04,
          estimatedSlippageUsd: 0.03,
          gasUsd: 0.05,
          thresholdDeltaUsd: -0.02,
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(logDir, "errors.ndjson"),
      [
        {
          type: "error",
          timestamp: 2_100,
          context: {
            source: "market_scanner",
            event: "websocket_close",
            reconnects: 2,
          },
          error: {
            message: "Market WebSocket disconnected",
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      "utf8",
    );

    const analytics = await new DashboardAnalyticsService(logDir).getAnalytics();

    expect(analytics.tradeSummary.totalTrades).toBe(2);
    expect(analytics.tradeSummary.successfulTrades).toBe(1);
    expect(analytics.tradeSummary.failedTrades).toBe(1);
    expect(analytics.tradeSummary.submittedOrders).toBe(3);
    expect(analytics.tradeSummary.submittedHedgeOrders).toBe(1);
    expect(analytics.tradeSummary.totalRealizedProfitUsd).toBeCloseTo(-0.2);
    expect(analytics.tradeSummary.totalShadowRealizedProfitUsd).toBeCloseTo(1.1);
    expect(analytics.tradeSummary.shadowAttempts).toBe(1);
    expect(analytics.tradeSummary.shadowSuccesses).toBe(1);
    expect(analytics.tradeSummary.topShadowFillReasons).toEqual([
      {
        label: "Shadow fill remained executable after 150ms.",
        count: 1,
      },
    ]);
    expect(analytics.tradeSummary.uniqueMarkets).toBe(2);
    expect(analytics.totalErrors).toBe(1);
    expect(analytics.opportunitySummary.total).toBe(3);
    expect(analytics.opportunitySummary.viable).toBe(1);
    expect(analytics.opportunitySummary.rejected).toBe(2);
    expect(analytics.opportunitySummary.topRejectionReasons[0]).toEqual({
      label: "No candidate size cleared min profit after slippage, fees, and gas.",
      count: 1,
    });
    expect(analytics.recentTrades[0]?.slug).toBe("market-b");
    expect(analytics.recentErrors[0]?.source).toBe("market_scanner");
    expect(analytics.strategyPerformance[0]?.strategyType).toBe("binary_arb");
    expect(analytics.negRiskNearMisses[0]?.slug).toBe("market-neg");
    expect(analytics.shadowFillReasonsByStrategy[0]).toEqual({
      strategyType: "binary_arb",
      reasons: [
        {
          label: "Shadow fill remained executable after 150ms.",
          count: 1,
        },
      ],
    });
    expect(
      analytics.profitSeries[analytics.profitSeries.length - 1]?.cumulativeRealizedProfitUsd,
    ).toBeCloseTo(-0.2);
    expect(
      analytics.profitSeries[analytics.profitSeries.length - 1]?.cumulativeShadowRealizedProfitUsd,
    ).toBeCloseTo(1.1);
  });
});
