import type { ArbitrageDirection, NetProfitModelInput, NetProfitModelOutput } from "../types.js";
import { round } from "./utils.js";

export const deriveOpportunityDirection = (
  yesAsk: number,
  noAsk: number,
): ArbitrageDirection => {
  return yesAsk >= noAsk ? "YES_high" : "NO_high";
};

export const calculateNetProfitModel = (
  input: NetProfitModelInput,
): NetProfitModelOutput => {
  const grossEdgeUsd = input.tradeSize - input.totalSpendUsd;
  const totalFeesUsd = input.feeLeg1Usd + input.feeLeg2Usd;

  // Model slippage as a haircut on deployed capital, averaged across both legs.
  const estimatedSlippageUsd = input.totalSpendUsd * input.slippageTolerance;
  const netProfitUsd =
    grossEdgeUsd -
    totalFeesUsd -
    input.gasCostUsd -
    estimatedSlippageUsd;
  const netProfitPct = input.totalSpendUsd > 0 ? netProfitUsd / input.totalSpendUsd : 0;

  return {
    grossEdgeUsd: round(grossEdgeUsd, 6),
    totalFeesUsd: round(totalFeesUsd, 6),
    estimatedSlippageUsd: round(estimatedSlippageUsd, 6),
    netProfitUsd: round(netProfitUsd, 6),
    netProfitPct: round(netProfitPct, 6),
  };
};
