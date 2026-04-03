import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type {
  DashboardActivityItem,
  DashboardErrorSummary,
  DashboardLogAnalytics,
  DashboardModePerformance,
  DashboardOpportunityStrategySummary,
  DashboardOpportunitySummary,
  DashboardProfitPoint,
  DashboardReasonCount,
  DashboardStrategyReasonSummary,
  DashboardStrategyKey,
  DashboardStrategyPerformance,
  DashboardTradeSummary,
  ErrorLogRecord,
  OpportunityLogRecord,
  TradeLogRecord,
} from "./types.js";

type LogFileInfo = {
  filePath: string;
  name: string;
  size: number;
  mtimeMs: number;
};

type StrategyAccumulator = {
  strategyType: DashboardStrategyKey;
  trades: number;
  successes: number;
  failures: number;
  hedgedTrades: number;
  totalTradeSize: number;
  totalExpectedProfitUsd: number;
  totalRealizedProfitUsd: number;
  totalShadowRealizedProfitUsd: number;
  totalEstimatedSlippageUsd: number;
  totalRealizedSlippageUsd: number;
  totalShadowRealizedSlippageUsd: number;
  winningTrades: number;
  shadowAttempts: number;
  shadowSuccesses: number;
};

type ModeAccumulator = {
  mode: TradeLogRecord["mode"];
  trades: number;
  successes: number;
  failures: number;
  totalRealizedProfitUsd: number;
  totalShadowRealizedProfitUsd: number;
  shadowAttempts: number;
  shadowSuccesses: number;
};

type OpportunityAccumulator = {
  strategyType: DashboardStrategyKey;
  total: number;
  viable: number;
  rejected: number;
  totalDurationMs: number;
  completedDurations: number;
};

type ProfitEvent = {
  timestamp: number;
  expectedProfitUsd: number;
  realizedProfitUsd: number;
  shadowRealizedProfitUsd: number;
};

const RECENT_TRADES_LIMIT = 10;
const RECENT_OPPORTUNITIES_LIMIT = 10;
const RECENT_ERRORS_LIMIT = 8;
const ACTIVITY_FEED_LIMIT = 18;
const PROFIT_SERIES_LIMIT = 72;

const emptyTradeSummary = (): DashboardTradeSummary => ({
  totalTrades: 0,
  successfulTrades: 0,
  failedTrades: 0,
  successRate: 0,
  hedgedTrades: 0,
  totalTradeSize: 0,
  averageTradeSize: 0,
  totalExpectedProfitUsd: 0,
  totalRealizedProfitUsd: 0,
  totalShadowRealizedProfitUsd: 0,
  averageRealizedProfitUsd: 0,
  averageShadowRealizedProfitUsd: 0,
  totalEstimatedSlippageUsd: 0,
  totalRealizedSlippageUsd: 0,
  totalShadowRealizedSlippageUsd: 0,
  submittedOrders: 0,
  submittedHedgeOrders: 0,
  uniqueMarkets: 0,
  latestTradeAt: undefined,
  shadowAttempts: 0,
  shadowSuccesses: 0,
  shadowFillRate: 0,
  topShadowFillReasons: [],
});

const emptyOpportunitySummary = (): DashboardOpportunitySummary => ({
  total: 0,
  viable: 0,
  rejected: 0,
  viableRate: 0,
  positiveExpectedProfit: 0,
  averageDurationMs: undefined,
  minDurationMs: undefined,
  maxDurationMs: undefined,
  topRejectionReasons: [],
});

const toNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const round = (value: number, digits = 6): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const asStrategyKey = (value: TradeLogRecord["strategyType"] | OpportunityLogRecord["strategyType"]): DashboardStrategyKey =>
  value ?? "unknown";

const pushRecent = <T extends { timestamp: number }>(collection: T[], item: T, limit: number): void => {
  if (collection.length < limit) {
    collection.push(item);
    return;
  }

  let oldestIndex = 0;
  for (let index = 1; index < collection.length; index += 1) {
    if (collection[index]!.timestamp < collection[oldestIndex]!.timestamp) {
      oldestIndex = index;
    }
  }

  if (item.timestamp > collection[oldestIndex]!.timestamp) {
    collection[oldestIndex] = item;
  }
};

const finalizeRecent = <T extends { timestamp: number }>(collection: T[]): T[] =>
  [...collection].sort((left, right) => right.timestamp - left.timestamp);

const compressSeries = (series: DashboardProfitPoint[], limit: number): DashboardProfitPoint[] => {
  if (series.length <= limit) {
    return series;
  }

  const compressed: DashboardProfitPoint[] = [];
  const step = (series.length - 1) / (limit - 1);

  for (let index = 0; index < limit; index += 1) {
    const pointIndex = Math.round(index * step);
    compressed.push(series[pointIndex]!);
  }

  return compressed;
};

const createStrategyAccumulator = (strategyType: DashboardStrategyKey): StrategyAccumulator => ({
  strategyType,
  trades: 0,
  successes: 0,
  failures: 0,
  hedgedTrades: 0,
  totalTradeSize: 0,
  totalExpectedProfitUsd: 0,
  totalRealizedProfitUsd: 0,
  totalShadowRealizedProfitUsd: 0,
  totalEstimatedSlippageUsd: 0,
  totalRealizedSlippageUsd: 0,
  totalShadowRealizedSlippageUsd: 0,
  winningTrades: 0,
  shadowAttempts: 0,
  shadowSuccesses: 0,
});

const createModeAccumulator = (mode: TradeLogRecord["mode"]): ModeAccumulator => ({
  mode,
  trades: 0,
  successes: 0,
  failures: 0,
  totalRealizedProfitUsd: 0,
  totalShadowRealizedProfitUsd: 0,
  shadowAttempts: 0,
  shadowSuccesses: 0,
});

const createOpportunityAccumulator = (
  strategyType: DashboardStrategyKey,
): OpportunityAccumulator => ({
  strategyType,
  total: 0,
  viable: 0,
  rejected: 0,
  totalDurationMs: 0,
  completedDurations: 0,
});

const summarizeError = (row: ErrorLogRecord): DashboardErrorSummary => {
  const context = row.context ?? {};
  const source = typeof context.source === "string" ? context.source : undefined;
  const event = typeof context.event === "string" ? context.event : undefined;
  const reconnects =
    typeof context.reconnects === "number" ? context.reconnects : undefined;
  let message = "Unknown error";

  if (typeof row.error === "string") {
    message = row.error;
  } else if (row.error && typeof row.error === "object") {
    const candidate = (row.error as { message?: unknown }).message;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      message = candidate;
    }
  }

  return {
    timestamp: row.timestamp,
    message,
    source,
    event,
    reconnects,
  };
};

const toActivityFromTrade = (row: TradeLogRecord): DashboardActivityItem => ({
  type: "trade",
  timestamp: row.timestamp,
  title: row.success ? "Trade executed" : "Trade failed",
  detail: `${row.slug} | ${asStrategyKey(row.strategyType)} | pnl ${round(
    toNumber(
      row.mode === "paper"
        ? row.shadowRealizedProfitUsd ?? 0
        : row.realizedProfitUsd ?? 0,
    ),
    4,
  )} USD`,
  tone: row.success ? "positive" : "danger",
});

const toActivityFromOpportunity = (row: OpportunityLogRecord): DashboardActivityItem => ({
  type: "opportunity",
  timestamp: row.timestamp,
  title: row.viable ? "Opportunity captured" : "Opportunity rejected",
  detail: row.viable
    ? `${row.slug} | edge ${round(toNumber(row.expectedProfitUsd), 4)} USD`
    : `${row.slug} | ${row.reason ?? "No reason reported"}`,
  tone: row.viable ? "warning" : "neutral",
});

const toActivityFromError = (row: DashboardErrorSummary): DashboardActivityItem => ({
  type: "error",
  timestamp: row.timestamp,
  title: row.source ? `Error in ${row.source}` : "Runtime error",
  detail: row.message,
  tone: "danger",
});

const buildProfitSeries = (events: ProfitEvent[]): DashboardProfitPoint[] => {
  const sorted = [...events].sort((left, right) => left.timestamp - right.timestamp);
  let cumulativeExpectedProfitUsd = 0;
  let cumulativeRealizedProfitUsd = 0;
  let cumulativeShadowRealizedProfitUsd = 0;

  const series = sorted.map((event, index) => {
    cumulativeExpectedProfitUsd += event.expectedProfitUsd;
    cumulativeRealizedProfitUsd += event.realizedProfitUsd;
    cumulativeShadowRealizedProfitUsd += event.shadowRealizedProfitUsd;

    return {
      timestamp: event.timestamp,
      cumulativeExpectedProfitUsd: round(cumulativeExpectedProfitUsd),
      cumulativeRealizedProfitUsd: round(cumulativeRealizedProfitUsd),
      cumulativeShadowRealizedProfitUsd: round(cumulativeShadowRealizedProfitUsd),
      tradeCount: index + 1,
    };
  });

  return compressSeries(series, PROFIT_SERIES_LIMIT);
};

const createEmptyAnalytics = (): DashboardLogAnalytics => ({
  generatedAt: Date.now(),
  firstEventAt: undefined,
  lastEventAt: undefined,
  totalErrors: 0,
  latestErrorAt: undefined,
  tradeSummary: emptyTradeSummary(),
  strategyPerformance: [],
  modePerformance: [],
  opportunitySummary: emptyOpportunitySummary(),
  opportunityByStrategy: [],
  recentTrades: [],
  recentOpportunities: [],
  negRiskNearMisses: [],
  shadowFillReasons: [],
  shadowFillReasonsByStrategy: [],
  recentErrors: [],
  profitSeries: [],
  activityFeed: [],
});

export class DashboardAnalyticsService {
  private cache?: {
    signature: string;
    analytics: DashboardLogAnalytics;
  };

  constructor(private readonly logDir: string) {}

  async getAnalytics(): Promise<DashboardLogAnalytics> {
    const [tradeFiles, opportunityFiles, errorFiles] = await Promise.all([
      this.listLogFiles("trades"),
      this.listLogFiles("opportunities"),
      this.listLogFiles("errors"),
    ]);

    const signature = [tradeFiles, opportunityFiles, errorFiles]
      .flat()
      .map((file) => `${file.name}:${file.size}:${file.mtimeMs}`)
      .join("|");

    if (this.cache?.signature === signature) {
      return this.cache.analytics;
    }

    const analytics = await this.buildAnalytics(tradeFiles, opportunityFiles, errorFiles);
    this.cache = {
      signature,
      analytics,
    };

    return analytics;
  }

  private async listLogFiles(baseName: string): Promise<LogFileInfo[]> {
    try {
      const entries = await readdir(this.logDir, { withFileTypes: true });
      const candidates = entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".ndjson") &&
            (entry.name === `${baseName}.ndjson` || entry.name.startsWith(`${baseName}.`)),
        )
        .map((entry) => entry.name)
        .sort();

      const files = await Promise.all(
        candidates.map(async (name) => {
          const filePath = path.resolve(this.logDir, name);
          const metadata = await stat(filePath);
          return {
            filePath,
            name,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
          };
        }),
      );

      return files;
    } catch {
      return [];
    }
  }

  private async buildAnalytics(
    tradeFiles: LogFileInfo[],
    opportunityFiles: LogFileInfo[],
    errorFiles: LogFileInfo[],
  ): Promise<DashboardLogAnalytics> {
    if (tradeFiles.length === 0 && opportunityFiles.length === 0 && errorFiles.length === 0) {
      return createEmptyAnalytics();
    }

    const tradeSummary = emptyTradeSummary();
    const opportunitySummary = emptyOpportunitySummary();
    const uniqueMarkets = new Set<string>();
    const strategyBuckets = new Map<DashboardStrategyKey, StrategyAccumulator>();
    const modeBuckets = new Map<TradeLogRecord["mode"], ModeAccumulator>();
    const opportunityBuckets = new Map<DashboardStrategyKey, OpportunityAccumulator>();
    const rejectionReasons = new Map<string, number>();
    const shadowFillReasons = new Map<string, number>();
    const shadowFillReasonsByStrategy = new Map<DashboardStrategyKey, Map<string, number>>();
    const recentTrades: TradeLogRecord[] = [];
    const recentOpportunities: OpportunityLogRecord[] = [];
    const negRiskNearMisses: OpportunityLogRecord[] = [];
    const recentErrors: DashboardErrorSummary[] = [];
    const activityFeed: DashboardActivityItem[] = [];
    const profitEvents: ProfitEvent[] = [];
    let firstEventAt: number | undefined;
    let lastEventAt: number | undefined;
    let totalErrors = 0;
    let latestErrorAt: number | undefined;

    const registerTimestamp = (timestamp: number): void => {
      firstEventAt = firstEventAt === undefined ? timestamp : Math.min(firstEventAt, timestamp);
      lastEventAt = lastEventAt === undefined ? timestamp : Math.max(lastEventAt, timestamp);
    };

    for (const file of tradeFiles) {
      const lines = readline.createInterface({
        input: createReadStream(file.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let row: TradeLogRecord | undefined;
        try {
          row = JSON.parse(line) as TradeLogRecord;
        } catch {
          continue;
        }

        if (!row || row.type !== "trade") {
          continue;
        }

        registerTimestamp(row.timestamp);
        tradeSummary.totalTrades += 1;
        tradeSummary.totalTradeSize += toNumber(row.tradeSize);
        tradeSummary.totalExpectedProfitUsd += toNumber(row.expectedProfitUsd);
        const actualRealizedProfitUsd = toNumber(row.realizedProfitUsd);
        const shadowRealizedProfitUsd =
          row.mode === "paper" ? toNumber(row.shadowRealizedProfitUsd) : 0;
        const actualRealizedSlippageUsd = toNumber(row.realizedSlippageUsd);
        const shadowRealizedSlippageUsd =
          row.mode === "paper" ? toNumber(row.shadowRealizedSlippageUsd) : 0;
        const effectiveProfitUsd =
          row.mode === "paper" ? shadowRealizedProfitUsd : actualRealizedProfitUsd;

        tradeSummary.totalRealizedProfitUsd += actualRealizedProfitUsd;
        tradeSummary.totalShadowRealizedProfitUsd += shadowRealizedProfitUsd;
        tradeSummary.totalEstimatedSlippageUsd += toNumber(row.estimatedSlippageUsd);
        tradeSummary.totalRealizedSlippageUsd += actualRealizedSlippageUsd;
        tradeSummary.totalShadowRealizedSlippageUsd += shadowRealizedSlippageUsd;
        tradeSummary.submittedOrders += row.orderIds.length;
        tradeSummary.submittedHedgeOrders += row.hedgeOrderIds.length;
        tradeSummary.latestTradeAt =
          tradeSummary.latestTradeAt === undefined
            ? row.timestamp
            : Math.max(tradeSummary.latestTradeAt, row.timestamp);

        if (row.success) {
          tradeSummary.successfulTrades += 1;
        } else {
          tradeSummary.failedTrades += 1;
        }

        if (row.hedgeOrderIds.length > 0) {
          tradeSummary.hedgedTrades += 1;
        }
        const strategyType = asStrategyKey(row.strategyType);
        if (row.mode === "paper") {
          tradeSummary.shadowAttempts += 1;
          if (row.shadowFillSuccess) {
            tradeSummary.shadowSuccesses += 1;
          }
          if (row.shadowFillReason) {
            shadowFillReasons.set(
              row.shadowFillReason,
              (shadowFillReasons.get(row.shadowFillReason) ?? 0) + 1,
            );
            const byStrategyReasons =
              shadowFillReasonsByStrategy.get(strategyType) ?? new Map<string, number>();
            byStrategyReasons.set(
              row.shadowFillReason,
              (byStrategyReasons.get(row.shadowFillReason) ?? 0) + 1,
            );
            shadowFillReasonsByStrategy.set(strategyType, byStrategyReasons);
          }
        }

        uniqueMarkets.add(row.marketId);
        const strategyBucket =
          strategyBuckets.get(strategyType) ?? createStrategyAccumulator(strategyType);
        strategyBucket.trades += 1;
        strategyBucket.totalTradeSize += toNumber(row.tradeSize);
        strategyBucket.totalExpectedProfitUsd += toNumber(row.expectedProfitUsd);
        strategyBucket.totalRealizedProfitUsd += actualRealizedProfitUsd;
        strategyBucket.totalShadowRealizedProfitUsd += shadowRealizedProfitUsd;
        strategyBucket.totalEstimatedSlippageUsd += toNumber(row.estimatedSlippageUsd);
        strategyBucket.totalRealizedSlippageUsd += actualRealizedSlippageUsd;
        strategyBucket.totalShadowRealizedSlippageUsd += shadowRealizedSlippageUsd;
        if (row.success) {
          strategyBucket.successes += 1;
        } else {
          strategyBucket.failures += 1;
        }
        if (row.hedgeOrderIds.length > 0) {
          strategyBucket.hedgedTrades += 1;
        }
        if (effectiveProfitUsd > 0) {
          strategyBucket.winningTrades += 1;
        }
        if (row.mode === "paper") {
          strategyBucket.shadowAttempts += 1;
          if (row.shadowFillSuccess) {
            strategyBucket.shadowSuccesses += 1;
          }
        }
        strategyBuckets.set(strategyType, strategyBucket);

        const modeBucket = modeBuckets.get(row.mode) ?? createModeAccumulator(row.mode);
        modeBucket.trades += 1;
        modeBucket.totalRealizedProfitUsd += actualRealizedProfitUsd;
        modeBucket.totalShadowRealizedProfitUsd += shadowRealizedProfitUsd;
        if (row.success) {
          modeBucket.successes += 1;
        } else {
          modeBucket.failures += 1;
        }
        if (row.mode === "paper") {
          modeBucket.shadowAttempts += 1;
          if (row.shadowFillSuccess) {
            modeBucket.shadowSuccesses += 1;
          }
        }
        modeBuckets.set(row.mode, modeBucket);

        pushRecent(recentTrades, row, RECENT_TRADES_LIMIT);
        pushRecent(activityFeed, toActivityFromTrade(row), ACTIVITY_FEED_LIMIT);
        profitEvents.push({
          timestamp: row.timestamp,
          expectedProfitUsd: toNumber(row.expectedProfitUsd),
          realizedProfitUsd: actualRealizedProfitUsd,
          shadowRealizedProfitUsd,
        });
      }
    }

    for (const file of opportunityFiles) {
      const lines = readline.createInterface({
        input: createReadStream(file.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let row: OpportunityLogRecord | undefined;
        try {
          row = JSON.parse(line) as OpportunityLogRecord;
        } catch {
          continue;
        }

        if (!row || row.type !== "opportunity") {
          continue;
        }

        registerTimestamp(row.timestamp);
        opportunitySummary.total += 1;
        if (row.viable) {
          opportunitySummary.viable += 1;
        } else {
          opportunitySummary.rejected += 1;
        }
        if (toNumber(row.expectedProfitUsd) > 0) {
          opportunitySummary.positiveExpectedProfit += 1;
        }
        if (typeof row.opportunity_duration_ms === "number") {
          opportunitySummary.averageDurationMs =
            (opportunitySummary.averageDurationMs ?? 0) + row.opportunity_duration_ms;
          opportunitySummary.minDurationMs =
            opportunitySummary.minDurationMs === undefined
              ? row.opportunity_duration_ms
              : Math.min(opportunitySummary.minDurationMs, row.opportunity_duration_ms);
          opportunitySummary.maxDurationMs =
            opportunitySummary.maxDurationMs === undefined
              ? row.opportunity_duration_ms
              : Math.max(opportunitySummary.maxDurationMs, row.opportunity_duration_ms);
        }
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

        const strategyType = asStrategyKey(row.strategyType);
        const bucket =
          opportunityBuckets.get(strategyType) ?? createOpportunityAccumulator(strategyType);
        bucket.total += 1;
        if (row.viable) {
          bucket.viable += 1;
        } else {
          bucket.rejected += 1;
        }
        if (typeof row.opportunity_duration_ms === "number") {
          bucket.totalDurationMs += row.opportunity_duration_ms;
          bucket.completedDurations += 1;
        }
        opportunityBuckets.set(strategyType, bucket);

        pushRecent(recentOpportunities, row, RECENT_OPPORTUNITIES_LIMIT);
        pushRecent(activityFeed, toActivityFromOpportunity(row), ACTIVITY_FEED_LIMIT);
      }
    }

    let completedDurationCount = 0;
    const totalDurationMs = opportunitySummary.averageDurationMs ?? 0;
    for (const bucket of opportunityBuckets.values()) {
      completedDurationCount += bucket.completedDurations;
    }
    opportunitySummary.averageDurationMs =
      completedDurationCount > 0 ? totalDurationMs / completedDurationCount : undefined;
    opportunitySummary.viableRate =
      opportunitySummary.total > 0 ? opportunitySummary.viable / opportunitySummary.total : 0;
    opportunitySummary.topRejectionReasons = [...rejectionReasons.entries()]
      .map(([label, count]): DashboardReasonCount => ({ label, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6);

    for (const file of errorFiles) {
      const lines = readline.createInterface({
        input: createReadStream(file.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        let row: ErrorLogRecord | undefined;
        try {
          row = JSON.parse(line) as ErrorLogRecord;
        } catch {
          continue;
        }

        if (!row || row.type !== "error") {
          continue;
        }

        registerTimestamp(row.timestamp);
        totalErrors += 1;
        latestErrorAt =
          latestErrorAt === undefined ? row.timestamp : Math.max(latestErrorAt, row.timestamp);

        const summary = summarizeError(row);
        pushRecent(recentErrors, summary, RECENT_ERRORS_LIMIT);
        pushRecent(activityFeed, toActivityFromError(summary), ACTIVITY_FEED_LIMIT);
      }
    }

    tradeSummary.successRate =
      tradeSummary.totalTrades > 0
        ? tradeSummary.successfulTrades / tradeSummary.totalTrades
        : 0;
    tradeSummary.averageTradeSize =
      tradeSummary.totalTrades > 0 ? tradeSummary.totalTradeSize / tradeSummary.totalTrades : 0;
    tradeSummary.averageRealizedProfitUsd =
      tradeSummary.totalTrades > 0
        ? tradeSummary.totalRealizedProfitUsd / tradeSummary.totalTrades
        : 0;
    tradeSummary.averageShadowRealizedProfitUsd =
      tradeSummary.totalTrades > 0
        ? tradeSummary.totalShadowRealizedProfitUsd / tradeSummary.totalTrades
        : 0;
    tradeSummary.shadowFillRate =
      tradeSummary.shadowAttempts > 0
        ? tradeSummary.shadowSuccesses / tradeSummary.shadowAttempts
        : 0;
    tradeSummary.topShadowFillReasons = [...shadowFillReasons.entries()]
      .map(([label, count]): DashboardReasonCount => ({ label, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 3);
    tradeSummary.uniqueMarkets = uniqueMarkets.size;

    const strategyPerformance = [...strategyBuckets.values()]
      .map(
        (bucket): DashboardStrategyPerformance => ({
          strategyType: bucket.strategyType,
          trades: bucket.trades,
          successes: bucket.successes,
          failures: bucket.failures,
          hedgedTrades: bucket.hedgedTrades,
          winRate: bucket.trades > 0 ? bucket.winningTrades / bucket.trades : 0,
          totalTradeSize: round(bucket.totalTradeSize),
          averageTradeSize: bucket.trades > 0 ? round(bucket.totalTradeSize / bucket.trades) : 0,
          totalExpectedProfitUsd: round(bucket.totalExpectedProfitUsd),
          totalRealizedProfitUsd: round(bucket.totalRealizedProfitUsd),
          totalShadowRealizedProfitUsd: round(bucket.totalShadowRealizedProfitUsd),
          averageRealizedProfitUsd:
            bucket.trades > 0 ? round(bucket.totalRealizedProfitUsd / bucket.trades) : 0,
          averageShadowRealizedProfitUsd:
            bucket.trades > 0 ? round(bucket.totalShadowRealizedProfitUsd / bucket.trades) : 0,
          totalEstimatedSlippageUsd: round(bucket.totalEstimatedSlippageUsd),
          totalRealizedSlippageUsd: round(bucket.totalRealizedSlippageUsd),
          totalShadowRealizedSlippageUsd: round(bucket.totalShadowRealizedSlippageUsd),
          shadowAttempts: bucket.shadowAttempts,
          shadowSuccesses: bucket.shadowSuccesses,
          shadowFillRate:
            bucket.shadowAttempts > 0 ? round(bucket.shadowSuccesses / bucket.shadowAttempts) : 0,
        }),
      )
      .sort(
        (left, right) =>
          right.totalRealizedProfitUsd +
          right.totalShadowRealizedProfitUsd -
          (left.totalRealizedProfitUsd + left.totalShadowRealizedProfitUsd),
      );

    const modePerformance = [...modeBuckets.values()]
      .map(
        (bucket): DashboardModePerformance => ({
          mode: bucket.mode,
          trades: bucket.trades,
          successes: bucket.successes,
          failures: bucket.failures,
          successRate: bucket.trades > 0 ? bucket.successes / bucket.trades : 0,
          totalRealizedProfitUsd: round(bucket.totalRealizedProfitUsd),
          totalShadowRealizedProfitUsd: round(bucket.totalShadowRealizedProfitUsd),
          shadowAttempts: bucket.shadowAttempts,
          shadowSuccesses: bucket.shadowSuccesses,
          shadowFillRate:
            bucket.shadowAttempts > 0 ? round(bucket.shadowSuccesses / bucket.shadowAttempts) : 0,
        }),
      )
      .sort(
        (left, right) =>
          right.totalRealizedProfitUsd +
          right.totalShadowRealizedProfitUsd -
          (left.totalRealizedProfitUsd + left.totalShadowRealizedProfitUsd),
      );

    const opportunityByStrategy = [...opportunityBuckets.values()]
      .map(
        (bucket): DashboardOpportunityStrategySummary => ({
          strategyType: bucket.strategyType,
          total: bucket.total,
          viable: bucket.viable,
          rejected: bucket.rejected,
          viableRate: bucket.total > 0 ? bucket.viable / bucket.total : 0,
          averageDurationMs:
            bucket.completedDurations > 0 ? bucket.totalDurationMs / bucket.completedDurations : undefined,
        }),
      )
      .sort((left, right) => right.total - left.total);

    const shadowFillReasonBreakdown: DashboardStrategyReasonSummary[] = [
      ...shadowFillReasonsByStrategy.entries(),
    ]
      .map(([strategyType, reasons]) => ({
        strategyType,
        reasons: [...reasons.entries()]
          .map(([label, count]): DashboardReasonCount => ({ label, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 3),
      }))
      .sort((left, right) => {
        const leftCount = left.reasons.reduce((total, entry) => total + entry.count, 0);
        const rightCount = right.reasons.reduce((total, entry) => total + entry.count, 0);
        return rightCount - leftCount;
      });

    return {
      generatedAt: Date.now(),
      firstEventAt,
      lastEventAt,
      totalErrors,
      latestErrorAt,
      tradeSummary: {
        ...tradeSummary,
        totalTradeSize: round(tradeSummary.totalTradeSize),
        averageTradeSize: round(tradeSummary.averageTradeSize),
        totalExpectedProfitUsd: round(tradeSummary.totalExpectedProfitUsd),
        totalRealizedProfitUsd: round(tradeSummary.totalRealizedProfitUsd),
        totalShadowRealizedProfitUsd: round(tradeSummary.totalShadowRealizedProfitUsd),
        averageRealizedProfitUsd: round(tradeSummary.averageRealizedProfitUsd),
        averageShadowRealizedProfitUsd: round(tradeSummary.averageShadowRealizedProfitUsd),
        totalEstimatedSlippageUsd: round(tradeSummary.totalEstimatedSlippageUsd),
        totalRealizedSlippageUsd: round(tradeSummary.totalRealizedSlippageUsd),
        totalShadowRealizedSlippageUsd: round(tradeSummary.totalShadowRealizedSlippageUsd),
        shadowFillRate: round(tradeSummary.shadowFillRate),
      },
      strategyPerformance,
      modePerformance,
      opportunitySummary,
      opportunityByStrategy,
      recentTrades: finalizeRecent(recentTrades),
      recentOpportunities: finalizeRecent(recentOpportunities),
      negRiskNearMisses: [...negRiskNearMisses]
        .sort(
          (left, right) =>
            Number(right.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY) -
            Number(left.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY),
        )
        .slice(0, 6),
      shadowFillReasons: [...shadowFillReasons.entries()]
        .map(([label, count]): DashboardReasonCount => ({ label, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 6),
      shadowFillReasonsByStrategy: shadowFillReasonBreakdown,
      recentErrors: finalizeRecent(recentErrors),
      profitSeries: buildProfitSeries(profitEvents),
      activityFeed: finalizeRecent(activityFeed),
    };
  }
}
