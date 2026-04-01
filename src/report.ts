import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { config as loadDotEnv } from "dotenv";
import type { ResolutionOutcome, StrategyType } from "./types.js";

loadDotEnv();

type Mode = "live" | "paper" | "backtest";

interface TradeReportRow {
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
  orderIds: string[];
  hedgeOrderIds: string[];
  notes: string[];
}

interface OpportunityReportRow {
  type: "opportunity";
  timestamp: number;
  marketId: string;
  slug: string;
  question: string;
  strategyType?: StrategyType;
  resolvedOutcome?: ResolutionOutcome;
  arb: number;
  tradeSize: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  viable: boolean;
  detectedAt?: number;
  expiredAt?: number;
  opportunity_duration_ms?: number;
  reason?: string;
}

interface BucketStats {
  label: string;
  trades: number;
  successes: number;
  failures: number;
  winCount: number;
  totalTradeSize: number;
  totalExpectedPnlUsd: number;
  totalRealizedPnlUsd: number;
  totalEstimatedSlippageUsd: number;
  totalRealizedSlippageUsd: number;
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
  totalEstimatedSlippageUsd: 0,
  totalRealizedSlippageUsd: 0,
});

const updateBucket = (bucket: BucketStats, row: TradeReportRow): void => {
  const realizedPnl = Number(row.realizedProfitUsd ?? row.expectedProfitUsd ?? 0);
  const expectedPnl = Number(row.expectedProfitUsd ?? 0);
  const estimatedSlippage = Number(row.estimatedSlippageUsd ?? 0);
  const realizedSlippage = Number(row.realizedSlippageUsd ?? 0);

  bucket.trades += 1;
  bucket.totalTradeSize += Number(row.tradeSize ?? 0);
  bucket.totalExpectedPnlUsd += expectedPnl;
  bucket.totalRealizedPnlUsd += realizedPnl;
  bucket.totalEstimatedSlippageUsd += estimatedSlippage;
  bucket.totalRealizedSlippageUsd += realizedSlippage;

  if (row.success) {
    bucket.successes += 1;
  } else {
    bucket.failures += 1;
  }

  if (realizedPnl > 0) {
    bucket.winCount += 1;
  }
};

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
      avg_pnl: formatUsd(bucket.trades > 0 ? bucket.totalRealizedPnlUsd / bucket.trades : 0),
      total_pnl: formatUsd(bucket.totalRealizedPnlUsd),
      avg_size: bucket.trades > 0 ? Number((bucket.totalTradeSize / bucket.trades).toFixed(4)) : 0,
      est_slippage: formatUsd(bucket.totalEstimatedSlippageUsd),
      real_slippage: formatUsd(bucket.totalRealizedSlippageUsd),
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

const main = async (): Promise<void> => {
  const tradesPath = resolveTradesPath();
  const opportunitiesPath = resolveOpportunitiesPath();
  const hasTradesFile = await fileExists(tradesPath);
  const hasOpportunitiesFile = await fileExists(opportunitiesPath);

  const total = createBucket("total");
  const byStrategy = new Map<string, BucketStats>();
  const byMode = new Map<string, BucketStats>();
  const opportunityStats = createOpportunityStats();
  const opportunityByStrategy = new Map<string, OpportunityStats>();
  const rejectionReasons = new Map<string, number>();

  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;

  if (hasTradesFile) {
    const rl = readline.createInterface({
      input: createReadStream(tradesPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      let row: TradeReportRow | undefined;
      try {
        row = JSON.parse(line) as TradeReportRow;
      } catch {
        continue;
      }

      if (!row || row.type !== "trade") {
        continue;
      }

      updateBucket(total, row);

      const strategyKey = row.strategyType ?? "unknown";
      const strategyBucket = byStrategy.get(strategyKey) ?? createBucket(strategyKey);
      updateBucket(strategyBucket, row);
      byStrategy.set(strategyKey, strategyBucket);

      const modeBucket = byMode.get(row.mode) ?? createBucket(row.mode);
      updateBucket(modeBucket, row);
      byMode.set(row.mode, modeBucket);

      firstTimestamp = firstTimestamp === undefined ? row.timestamp : Math.min(firstTimestamp, row.timestamp);
      lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp);
    }
  }

  if (hasOpportunitiesFile) {
    const rl = readline.createInterface({
      input: createReadStream(opportunitiesPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      let row: OpportunityReportRow | undefined;
      try {
        row = JSON.parse(line) as OpportunityReportRow;
      } catch {
        continue;
      }

      if (!row || row.type !== "opportunity") {
        continue;
      }

      updateOpportunityStats(opportunityStats, row);

      const strategyKey = row.strategyType ?? "unknown";
      const strategyStats = opportunityByStrategy.get(strategyKey) ?? createOpportunityStats();
      updateOpportunityStats(strategyStats, row);
      opportunityByStrategy.set(strategyKey, strategyStats);

      if (!row.viable && row.reason) {
        rejectionReasons.set(row.reason, (rejectionReasons.get(row.reason) ?? 0) + 1);
      }

      firstTimestamp = firstTimestamp === undefined ? row.timestamp : Math.min(firstTimestamp, row.timestamp);
      lastTimestamp = lastTimestamp === undefined ? row.timestamp : Math.max(lastTimestamp, row.timestamp);
    }
  }

  console.log("Polymarket Bot Report");
  console.log("=====================");
  console.log(`Trades file: ${hasTradesFile ? tradesPath : `${tradesPath} (missing)`}`);
  console.log(`Opportunities file: ${hasOpportunitiesFile ? opportunitiesPath : `${opportunitiesPath} (missing)`}`);
  console.log(`Range: ${formatTimestamp(firstTimestamp)} -> ${formatTimestamp(lastTimestamp)}`);
  console.log(`Trades: ${total.trades}`);
  console.log(`Successful: ${total.successes}`);
  console.log(`Failed: ${total.failures}`);
  console.log(`Win rate: ${formatPct(total.trades > 0 ? total.winCount / total.trades : 0)}`);
  console.log(`Expected PnL: ${formatUsd(total.totalExpectedPnlUsd)}`);
  console.log(`Realized PnL: ${formatUsd(total.totalRealizedPnlUsd)}`);
  console.log(`Average PnL / trade: ${formatUsd(total.trades > 0 ? total.totalRealizedPnlUsd / total.trades : 0)}`);
  console.log(`Estimated slippage total: ${formatUsd(total.totalEstimatedSlippageUsd)}`);
  console.log(`Realized slippage total: ${formatUsd(total.totalRealizedSlippageUsd)}`);
  console.log(`Opportunities: ${opportunityStats.total}`);
  console.log(`Opportunities viable: ${opportunityStats.viable}`);
  console.log(`Opportunities rejected: ${opportunityStats.nonViable}`);
  console.log(
    `Average opportunity duration: ${formatMs(
      opportunityStats.completedDurations > 0
        ? opportunityStats.totalDurationMs / opportunityStats.completedDurations
        : undefined,
    )}`,
  );
  console.log(`Shortest opportunity: ${formatMs(opportunityStats.minDurationMs)}`);
  console.log(`Longest opportunity: ${formatMs(opportunityStats.maxDurationMs)}`);

  printBucketTable(
    "By Strategy",
    [...byStrategy.values()].sort((left, right) => right.totalRealizedPnlUsd - left.totalRealizedPnlUsd),
  );
  printBucketTable(
    "By Mode",
    [...byMode.values()].sort((left, right) => right.totalRealizedPnlUsd - left.totalRealizedPnlUsd),
  );

  if (opportunityByStrategy.size > 0) {
    console.log("\nOpportunity Summary");
    console.log("-------------------");
    console.table(
      [...opportunityByStrategy.entries()]
        .map(([strategy, stats]) => ({
          strategy,
          total: stats.total,
          viable: stats.viable,
          rejected: stats.nonViable,
          positive_expected_profit: stats.positiveExpectedProfit,
          avg_duration: formatMs(
            stats.completedDurations > 0 ? stats.totalDurationMs / stats.completedDurations : undefined,
          ),
          max_duration: formatMs(stats.maxDurationMs),
        }))
        .sort((left, right) => right.total - left.total),
    );
  }

  if (rejectionReasons.size > 0) {
    console.log("\nTop Rejection Reasons");
    console.log("---------------------");
    console.table(
      [...rejectionReasons.entries()]
        .map(([reason, count]) => ({ count, reason }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 10),
    );
  }
};

await main().catch((error) => {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown error while building trade report.";
  console.error(`Unable to generate report: ${message}`);
  process.exitCode = 1;
});
