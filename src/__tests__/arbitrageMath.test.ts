import { describe, expect, it } from "vitest";
import { calculateNetProfitModel } from "../lib/arbitrageMath.js";

describe("calculateNetProfitModel", () => {
  it("flags a true positive when the paired buy remains profitable", () => {
    const result = calculateNetProfitModel({
      tradeSize: 50,
      totalSpendUsd: 48,
      feeLeg1Usd: 0.048,
      feeLeg2Usd: 0.048,
      gasCostUsd: 0.05,
      slippageTolerance: 0.01,
    });

    expect(result.netProfitUsd).toBeGreaterThan(0);
    expect(result.netProfitPct).toBeGreaterThan(0.005);
  });

  it("rejects a true negative when the gross edge is already gone", () => {
    const result = calculateNetProfitModel({
      tradeSize: 50,
      totalSpendUsd: 50.5,
      feeLeg1Usd: 0.05,
      feeLeg2Usd: 0.051,
      gasCostUsd: 0.05,
      slippageTolerance: 0.01,
    });

    expect(result.netProfitUsd).toBeLessThanOrEqual(0);
    expect(result.netProfitPct).toBeLessThanOrEqual(0);
  });

  it("rejects an edge when fees eat the profit", () => {
    const result = calculateNetProfitModel({
      tradeSize: 100,
      totalSpendUsd: 97,
      feeLeg1Usd: 1.8,
      feeLeg2Usd: 1.8,
      gasCostUsd: 0.05,
      slippageTolerance: 0.001,
    });

    expect(result.totalFeesUsd).toBeGreaterThan(0);
    expect(result.netProfitUsd).toBeLessThanOrEqual(0);
  });

  it("rejects an edge when explicit sweep slippage eats the spread", () => {
    const result = calculateNetProfitModel({
      tradeSize: 100,
      totalSpendUsd: 96,
      feeLeg1Usd: 0,
      feeLeg2Usd: 0,
      gasCostUsd: 0.05,
      slippageTolerance: 0.01,
      estimatedSlippageUsd: 4.8,
    });

    expect(result.estimatedSlippageUsd).toBe(4.8);
    expect(result.netProfitUsd).toBeLessThanOrEqual(0);
  });
});
