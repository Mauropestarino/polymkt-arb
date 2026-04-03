import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { config as loadDotEnv } from "dotenv";
import type { ResolutionOutcome, StrategyType } from "./types.js";

loadDotEnv();

type Mode = "live" | "paper" | "backtest";

export interface TradeReportRow {
  type: "trade";
  timestamp: number;
  success: boolean;
  mode: Mode;
  marketId: string;
  slug: string;
  question: string;
  strategyType?: StrategyType;
  resolvedOutcome?: ResolutionOutcome;
  tradeSize: number;
  expectedProfitUsd: number;
  realizedProfitUsd?: number;
  estimatedSlippageUsd?: number;
  realizedSlippageUsd?: number;
  shadowFillSuccess?: boolean;
  shadowFillReason?: string;
  shadowLatencyMs?: number;
  shadowRealizedProfitUsd?: number;
  shadowRealizedSlippageUsd?: number;
  orderIds: string[];
  hedgeOrderIds: string[];
  notes: string[];
}

export interface OpportunityReportRow {
  type: "opportunity";
  timestamp: number;
  marketId: string;
  slug: string;
  question: string;
  strategyType?: StrategyType;
  resolvedOutcome?: ResolutionOutcome;
  arb: number;
  rawSpreadUsd?: number;
  tradeSize: number;
  sourceNoCostUsd?: number;
  targetYesProceedsUsd?: number;
  convertFeeBps?: number;
  convertOutputSize?: number;
  totalFeesUsd?: number;
  estimatedSlippageUsd?: number;
  gasUsd?: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  requiredProfitUsd?: number;
  thresholdDeltaUsd?: number;
  viable: boolean;
  detectedAt?: number;
  expiredAt?: number;
  opportunity_duration_ms?: number;
  reason?: string;
}

export interface BucketStats {
  label: string;
  trades: number;
  successes: number;
  failures: number;
  winCount: number;
  totalTradeSize: number;
  totalExpectedPnlUsd: number;
  totalRealizedPnlUsd: number;
  totalShadowRealizedPnlUsd: number;
  totalEstimatedSlippageUsd: number;
  totalRealizedSlippageUsd: number;
  totalShadowRealizedSlippageUsd: number;
  shadowAttempts: number;
  shadowSuccesses: number;
}

interface OpportunityStats {
  total: number;
  viable: number;
  nonViable: number;
  positiveExpectedProfit: number;
  totalDurationMs: number;
  completedDurations: number;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export interface ReportSummary {
  total: BucketStats;
  byStrategy: BucketStats[];
  byMode: BucketStats[];
  opportunityStats: OpportunityStats;
  opportunityByStrategy: Array<{
    strategy: string;
    stats: OpportunityStats;
  }>;
  rejectionReasons: Array<{ reason: string; count: number }>;
  shadowFillReasons: Array<{ reason: string; count: number }>;
  shadowFillReasonsByStrategy: Array<{
    strategy: string;
    reasons: Array<{ reason: string; count: number }>;
  }>;
  negRiskNearMisses: OpportunityReportRow[];
  firstTimestamp?: number;
  lastTimestamp?: number;
}

const cliArgs = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [key, ...rest] = argument.slice(2).split("=");
      return [key, rest.join("=")] as const;
    }),
);

const resolveTradesPath = (): string => {
  const cliFile = cliArgs.get("file");
  if (cliFile) {
    return path.resolve(process.cwd(), cliFile);
  }

  const logDir = process.env.LOG_DIR?.trim() || "./data";
  return path.resolve(process.cwd(), logDir, "trades.ndjson");
};

const resolveOpportunitiesPath = (): string => {
  const cliFile = cliArgs.get("opportunities-file");
  if (cliFile) {
    return path.resolve(process.cwd(), cliFile);
  }

  const logDir = process.env.LOG_DIR?.trim() || "./data";
  return path.resolve(process.cwd(), logDir, "opportunities.ndjson");
};

const formatUsd = (value: number): string => `$${value.toFixed(4)}`;
const formatPct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const formatTimestamp = (value?: number): string =>
  value ? new Date(value).toLocaleString("es-AR", { hour12: false }) : "n/a";
const formatMs = (value?: number): string =>
  value === undefined ? "n/a" : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;

const createBucket = (label: string): BucketStats => ({
  label,
  trades: 0,
  successes: 0,
  failures: 0,
  winCount: 0,
  totalTradeSize: 0,
  totalExpectedPnlUsd: 0,
  totalRealizedPnlUsd: 0,
  totalShadowRealizedPnlUsd: 0,
  totalEstimatedSlippageUsd: 0,
  totalRealizedSlippageUsd: 0,
  totalShadowRealizedSlippageUsd: 0,
  shadowAttempts: 0,
  shadowSuccesses: 0,
});

const createOpportunityStats = (): OpportunityStats => ({
  total: 0,
  viable: 0,
  nonViable: 0,
  positiveExpectedProfit: 0,
  totalDurationMs: 0,
  completedDurations: 0,
  minDurationMs: undefined,
  maxDurationMs: undefined,
});

const getEffectivePnl = (row: TradeReportRow): number => {
  if (row.mode === "paper") {
    return Number(row.shadowRealizedProfitUsd ?? 0);
  }

  return Number(row.realizedProfitUsd ?? 0);
};

const updateBucket = (bucket: BucketStats, row: TradeReportRow): void => {
  const expectedPnl = Number(row.expectedProfitUsd ?? 0);
  const realizedPnl = Number(row.realizedProfitUsd ?? 0);
  const shadowRealizedPnl = Number(row.mode === "paper" ? row.shadowRealizedProfitUsd ?? 0 : 0);
  const estimatedSlippage = Number(row.estimatedSlippageUsd ?? 0);
  const realizedSlippage = Number(row.realizedSlippageUsd ?? 0);
  const shadowRealizedSlippage = Number(
    row.mode === "paper" ? row.shadowRealizedSlippageUsd ?? 0 : 0,
  );
  const effectivePnl = getEffectivePnl(row);

  bucket.trades += 1;
  bucket.totalTradeSize += Number(row.tradeSize ?? 0);
  bucket.totalExpectedPnlUsd += expectedPnl;
  bucket.totalRealizedPnlUsd += realizedPnl;
  bucket.totalShadowRealizedPnlUsd += shadowRealizedPnl;
  bucket.totalEstimatedSlippageUsd += estimatedSlippage;
  bucket.totalRealizedSlippageUsd += realizedSlippage;
  bucket.totalShadowRealizedSlippageUsd += shadowRealizedSlippage;

  if (row.mode === "paper") {
    bucket.shadowAttempts += 1;
    if (row.shadowFillSuccess) {
      bucket.shadowSuccesses += 1;
    }
  }

  if (row.success) {
    bucket.successes += 1;
  } else {
    bucket.failures += 1;
  }

  if (effectivePnl > 0) {
    bucket.winCount += 1;
  }
};

const updateOpportunityStats = (stats: OpportunityStats, row: OpportunityReportRow): void => {
  stats.total += 1;
  if (row.viable) {
    stats.viable += 1;
  } else {
    stats.nonViable += 1;
  }

  if (Number(row.expectedProfitUsd ?? 0) > 0) {
    stats.positiveExpectedProfit += 1;
  }

  if (typeof row.opportunity_duration_ms === "number") {
    stats.completedDurations += 1;
    stats.totalDurationMs += row.opportunity_duration_ms;
    stats.minDurationMs =
      stats.minDurationMs === undefined
        ? row.opportunity_duration_ms
        : Math.min(stats.minDurationMs, row.opportunity_duration_ms);
    stats.maxDurationMs =
      stats.maxDurationMs === undefined
        ? row.opportunity_duration_ms
        : Math.max(stats.maxDurationMs, row.opportunity_duration_ms);
  }
};

export const summarizeReport = (
  tradeRows: TradeReportRow[],
  opportunityRows: OpportunityReportRow[],
): ReportSummary => {
  const total = createBucket("total");
  const byStrategy = new Map<string, BucketStats>();
  const byMode = new Map<string, BucketStats>();
  const opportunityStats = createOpportunityStats();
  const opportunityByStrategy = new Map<string, OpportunityStats>();
  const rejectionReasons = new Map<string, number>();
  const shadowFillReasons = new Map<string, number>();
  const shadowFillReasonsByStrategy = new Map<string, Map<string, number>>();
  const negRiskNearMisses: OpportunityReportRow[] = [];

  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  for (const row of tradeRows) {
    updateBucket(total, row);

    const strategyKey = row.strategyType ?? "unknown";
    const strategyBucket = byStrategy.get(strategyKey) ?? createBucket(strategyKey);
    updateBucket(strategyBucket, row);
    byStrategy.set(strategyKey, strategyBucket);

    const modeBucket = byMode.get(row.mode) ?? createBucket(row.mode);
    updateBucket(modeBucket, row);
    byMode.set(row.mode, modeBucket);

    if (row.mode === "paper" && row.shadowFillReason) {
      shadowFillReasons.set(
        row.shadowFillReason,
        (shadowFillReasons.get(row.shadowFillReason) ?? 0) + 1,
      );
      const perStrategyReasons =
        shadowFillReasonsByStrategy.get(strategyKey) ?? new Map<string, number>();
      perStrategyReasons.set(
        row.shadowFillReason,
        (perStrategyReasons.get(row.shadowFillReason) ?? 0) + 1,
      );
      shadowFillReasonsByStrategy.set(strategyKey, perStrategyReasons);
    }

    firstTimestamp = firstTimestamp === undefined ? row.timestamp : Math.min(firstTimestamp, row.timestamp);
    lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp);
  }

  for (const row of opportunityRows) {
    updateOpportunityStats(opportunityStats, row);

    const strategyKey = row.strategyType ?? "unknown";
    const strategyStats = opportunityByStrategy.get(strategyKey) ?? createOpportunityStats();
    updateOpportunityStats(strategyStats, row);
    opportunityByStrategy.set(strategyKey, strategyStats);

    if (!row.viable && row.reason) {
      rejectionReasons.set(row.reason, (rejectionReasons.get(row.reason) ?? 0) + 1);
    }

    if (
      row.strategyType === "neg_risk_arb" &&
      !row.viable &&
      typeof row.thresholdDeltaUsd === "number"
    ) {
      negRiskNearMisses.push(row);
    }

    firstTimestamp = firstTimestamp === undefined ? row.timestamp : Math.min(firstTimestamp, row.timestamp);
    lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp);
  }

  return {
    total,
    byStrategy: [...byStrategy.values()].sort(
      (left, right) =>
        right.totalRealizedPnlUsd +
        right.totalShadowRealizedPnlUsd -
        (left.totalRealizedPnlUsd + left.totalShadowRealizedPnlUsd),
    ),
    byMode: [...byMode.values()].sort(
      (left, right) =>
        right.totalRealizedPnlUsd +
        right.totalShadowRealizedPnlUsd -
        (left.totalRealizedPnlUsd + left.totalShadowRealizedPnlUsd),
    ),
    opportunityStats,
    opportunityByStrategy: [...opportunityByStrategy.entries()]
      .map(([strategy, stats]) => ({ strategy, stats }))
      .sort((left, right) => right.stats.total - left.stats.total),
    rejectionReasons: [...rejectionReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    shadowFillReasons: [...shadowFillReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    shadowFillReasonsByStrategy: [...shadowFillReasonsByStrategy.entries()]
      .map(([strategy, reasons]) => ({
        strategy,
        reasons: [...reasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 5),
      }))
      .sort((left, right) => {
        const leftCount = left.reasons.reduce((total, entry) => total + entry.count, 0);
        const rightCount = right.reasons.reduce((total, entry) => total + entry.count, 0);
        return rightCount - leftCount;
      }),
    negRiskNearMisses: negRiskNearMisses
      .sort(
        (left, right) =>
          Number(right.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY) -
          Number(left.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY),
      )
      .slice(0, 20),
    firstTimestamp,
    lastTimestamp,
  };
};

const printBucketTable = (title: string, buckets: BucketStats[]): void => {
  if (buckets.length === 0) {
    return;
  }

  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.table(
    buckets.map((bucket) => ({
      bucket: bucket.label,
      trades: bucket.trades,
      success: bucket.successes,
      failures: bucket.failures,
      win_rate: formatPct(bucket.trades > 0 ? bucket.winCount / bucket.trades : 0),
      avg_expected: formatUsd(bucket.trades > 0 ? bucket.totalExpectedPnlUsd / bucket.trades : 0),
      actual_realized: formatUsd(bucket.totalRealizedPnlUsd),
      shadow_realized: formatUsd(bucket.totalShadowRealizedPnlUsd),
      effective_pnl: formatUsd(bucket.totalRealizedPnlUsd + bucket.totalShadowRealizedPnlUsd),
      shadow_fill_rate:
        bucket.shadowAttempts > 0 ? formatPct(bucket.shadowSuccesses / bucket.shadowAttempts) : "n/a",
      avg_size: bucket.trades > 0 ? Number((bucket.totalTradeSize / bucket.trades).toFixed(4)) : 0,
      est_slippage: formatUsd(bucket.totalEstimatedSlippageUsd),
      actual_slippage: formatUsd(bucket.totalRealizedSlippageUsd),
      shadow_slippage: formatUsd(bucket.totalShadowRealizedSlippageUsd),
    })),
  );
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readNdjsonFile = async <T extends { type?: string }>(
  filePath: string,
  expectedType: string,
): Promise<T[]> => {
  const rows: T[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    try {
      const row = JSON.parse(line) as T;
      if (row?.type === expectedType) {
        rows.push(row);
      }
    } catch {
      continue;
    }
  }

  return rows;
};

const printSummary = (
  summary: ReportSummary,
  tradesPath: string,
  opportunitiesPath: string,
  hasTradesFile: boolean,
  hasOpportunitiesFile: boolean,
): void => {
  const effectivePnlUsd =
    summary.total.totalRealizedPnlUsd + summary.total.totalShadowRealizedPnlUsd;

  console.log("Polymarket Bot Report");
  console.log("=====================");
  console.log(`Trades file: ${hasTradesFile ? tradesPath : `${tradesPath} (missing)`}`);
  console.log(
    `Opportunities file: ${hasOpportunitiesFile ? opportunitiesPath : `${opportunitiesPath} (missing)`}`,
  );
  console.log(
    `Range: ${formatTimestamp(summary.firstTimestamp)} -> ${formatTimestamp(summary.lastTimestamp)}`,
  );
  console.log(`Trades: ${summary.total.trades}`);
  console.log(`Successful: ${summary.total.successes}`);
  console.log(`Failed: ${summary.total.failures}`);
  console.log(
    `Win rate: ${formatPct(summary.total.trades > 0 ? summary.total.winCount / summary.total.trades : 0)}`,
  );
  console.log(`Expected PnL: ${formatUsd(summary.total.totalExpectedPnlUsd)}`);
  console.log(`Actual Realized PnL: ${formatUsd(summary.total.totalRealizedPnlUsd)}`);
  console.log(`Shadow Realized PnL: ${formatUsd(summary.total.totalShadowRealizedPnlUsd)}`);
  console.log(`Effective PnL View: ${formatUsd(effectivePnlUsd)}`);
  console.log(
    `Average Effective PnL / trade: ${formatUsd(
      summary.total.trades > 0 ? effectivePnlUsd / summary.total.trades : 0,
    )}`,
  );
  console.log(`Estimated slippage total: ${formatUsd(summary.total.totalEstimatedSlippageUsd)}`);
  console.log(`Actual realized slippage total: ${formatUsd(summary.total.totalRealizedSlippageUsd)}`);
  console.log(
    `Shadow realized slippage total: ${formatUsd(summary.total.totalShadowRealizedSlippageUsd)}`,
  );
  console.log(
    `Paper shadow fill rate: ${
      summary.total.shadowAttempts > 0
        ? formatPct(summary.total.shadowSuccesses / summary.total.shadowAttempts)
        : "n/a"
    }`,
  );
  console.log(`Opportunities: ${summary.opportunityStats.total}`);
  console.log(`Opportunities viable: ${summary.opportunityStats.viable}`);
  console.log(`Opportunities rejected: ${summary.opportunityStats.nonViable}`);
  console.log(
    `Average opportunity duration: ${formatMs(
      summary.opportunityStats.completedDurations > 0
        ? summary.opportunityStats.totalDurationMs / summary.opportunityStats.completedDurations
        : undefined,
    )}`,
  );
  console.log(`Shortest opportunity: ${formatMs(summary.opportunityStats.minDurationMs)}`);
  console.log(`Longest opportunity: ${formatMs(summary.opportunityStats.maxDurationMs)}`);

  printBucketTable("By Strategy", summary.byStrategy);
  printBucketTable("By Mode", summary.byMode);

  if (summary.opportunityByStrategy.length > 0) {
    console.log("\nOpportunity Summary");
    console.log("-------------------");
    console.table(
      summary.opportunityByStrategy.map(({ strategy, stats }) => ({
        strategy,
        total: stats.total,
        viable: stats.viable,
        rejected: stats.nonViable,
        positive_expected_profit: stats.positiveExpectedProfit,
        avg_duration: formatMs(
          stats.completedDurations > 0 ? stats.totalDurationMs / stats.completedDurations : undefined,
        ),
        max_duration: formatMs(stats.maxDurationMs),
      })),
    );
  }

  if (summary.rejectionReasons.length > 0) {
    console.log("\nTop Rejection Reasons");
    console.log("---------------------");
    console.table(summary.rejectionReasons.map((entry) => ({ count: entry.count, reason: entry.reason })));
  }

  if (summary.shadowFillReasons.length > 0) {
    console.log("\nShadow Fill Reasons");
    console.log("-------------------");
    console.table(summary.shadowFillReasons.map((entry) => ({ count: entry.count, reason: entry.reason })));
  }

  if (summary.shadowFillReasonsByStrategy.length > 0) {
    console.log("\nShadow Fill Reasons By Strategy");
    console.log("-------------------------------");
    console.table(
      summary.shadowFillReasonsByStrategy.flatMap((entry) =>
        entry.reasons.map((reason) => ({
          strategy: entry.strategy,
          count: reason.count,
          reason: reason.reason,
        })),
      ),
    );
  }

  if (summary.negRiskNearMisses.length > 0) {
    console.log("\nNeg-Risk Near Misses");
    console.log("--------------------");
    console.table(
      summary.negRiskNearMisses.map((row) => ({
        market: row.slug,
        raw_spread: formatUsd(Number(row.rawSpreadUsd ?? row.arb ?? 0)),
        source_no_cost: formatUsd(Number(row.sourceNoCostUsd ?? 0)),
        target_yes_sum: formatUsd(Number(row.targetYesProceedsUsd ?? 0)),
        convert_fee_bps: Number(row.convertFeeBps ?? 0),
        fees: formatUsd(Number(row.totalFeesUsd ?? 0)),
        gas: formatUsd(Number(row.gasUsd ?? 0)),
        slippage: formatUsd(Number(row.estimatedSlippageUsd ?? 0)),
        expected_pnl: formatUsd(Number(row.expectedProfitUsd ?? 0)),
        required_pnl: formatUsd(Number(row.requiredProfitUsd ?? 0)),
        threshold_delta: formatUsd(Number(row.thresholdDeltaUsd ?? 0)),
        reason: row.reason ?? "n/a",
      })),
    );
  }
};

const main = async (): Promise<void> => {
  const tradesPath = resolveTradesPath();
  const opportunitiesPath = resolveOpportunitiesPath();
  const hasTradesFile = await fileExists(tradesPath);
  const hasOpportunitiesFile = await fileExists(opportunitiesPath);

  const tradeRows = hasTradesFile
    ? await readNdjsonFile<TradeReportRow>(tradesPath, "trade")
    : [];
  const opportunityRows = hasOpportunitiesFile
    ? await readNdjsonFile<OpportunityReportRow>(opportunitiesPath, "opportunity")
    : [];
  const summary = summarizeReport(tradeRows, opportunityRows);

  printSummary(summary, tradesPath, opportunitiesPath, hasTradesFile, hasOpportunitiesFile);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error while building trade report.";
    console.error(`Unable to generate report: ${message}`);
    process.exitCode = 1;
  });
}
