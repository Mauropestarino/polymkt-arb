import type {
  ArbitrageEngineStats,
  DashboardSnapshot,
  ExecutionStats,
  LateResolutionStats,
  MarketScannerStats,
  OpportunityLogRecord,
} from "./types.js";
import { formatMs, formatPct, formatUsd } from "./lib/utils.js";

export class CliDashboard {
  private readonly recentOpportunities: OpportunityLogRecord[] = [];
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly startedAt: number,
    private readonly getScannerStats: () => MarketScannerStats,
    private readonly getArbitrageStats: () => ArbitrageEngineStats,
    private readonly getExecutionStats: () => ExecutionStats,
    private readonly getLateResolutionStats?: () => LateResolutionStats,
  ) {}

  pushOpportunity(record: OpportunityLogRecord): void {
    this.recentOpportunities.unshift(record);
    if (this.recentOpportunities.length > 5) {
      this.recentOpportunities.length = 5;
    }
  }

  start(refreshIntervalMs: number): void {
    this.render();
    this.interval = setInterval(() => this.render(), refreshIntervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  snapshot(): DashboardSnapshot {
    return {
      startedAt: this.startedAt,
      scanner: this.getScannerStats(),
      arbitrage: this.getArbitrageStats(),
      lateResolution: this.getLateResolutionStats?.(),
      execution: this.getExecutionStats(),
      recentOpportunities: [...this.recentOpportunities],
    };
  }

  private render(): void {
    const snapshot = this.snapshot();
    const uptimeSeconds = Math.max(1, Math.floor((Date.now() - snapshot.startedAt) / 1000));
    const totalOpportunitiesSeen =
      snapshot.arbitrage.opportunitiesSeen + (snapshot.lateResolution?.opportunitiesSeen ?? 0);
    const totalCapturedOpportunities =
      snapshot.arbitrage.opportunitiesCaptured + (snapshot.lateResolution?.opportunitiesCaptured ?? 0);
    const captureRate =
      totalOpportunitiesSeen > 0
        ? totalCapturedOpportunities / totalOpportunitiesSeen
        : 0;

    console.clear();
    console.log("Polymarket Arbitrage Bot");
    console.log("========================");
    console.log(`Uptime: ${uptimeSeconds}s`);
    console.log(
      `Markets: ${snapshot.scanner.marketsTracked} | Tokens: ${snapshot.scanner.tokensTracked} | WS: ${
        snapshot.scanner.websocketConnected ? "connected" : "disconnected"
      } | Reconnects: ${snapshot.scanner.websocketReconnects}`,
    );
    console.log(
      `Last WS msg: ${
        snapshot.scanner.lastMessageAt
          ? formatMs(Date.now() - snapshot.scanner.lastMessageAt)
          : "n/a"
      } ago`,
    );
    console.log(
      `Binary arb: seen=${snapshot.arbitrage.opportunitiesSeen} captured=${snapshot.arbitrage.opportunitiesCaptured} viable=${snapshot.arbitrage.opportunitiesViable} executed=${snapshot.arbitrage.opportunitiesExecuted} avgDur=${formatMs(snapshot.arbitrage.averageOpportunityDurationMs)}`,
    );
    console.log(
      `Late resolution: seen=${snapshot.lateResolution?.opportunitiesSeen ?? 0} captured=${snapshot.lateResolution?.opportunitiesCaptured ?? 0} viable=${snapshot.lateResolution?.opportunitiesViable ?? 0} executed=${snapshot.lateResolution?.opportunitiesExecuted ?? 0} avgDur=${formatMs(snapshot.lateResolution?.averageOpportunityDurationMs)}`,
    );
    console.log(
      `Executions: attempted=${snapshot.execution.executionsAttempted} success=${snapshot.execution.executionsSucceeded} failed=${snapshot.execution.executionsFailed} hedges=${snapshot.execution.hedgesTriggered} fillRate=${formatPct(snapshot.execution.fillRate)} shareFill=${formatPct(snapshot.execution.shareFillRate)} openNotional=${formatUsd(snapshot.execution.openNotionalUsd)}`,
    );
    console.log(
      `Slippage: estimated=${formatUsd(snapshot.execution.estimatedSlippageUsdTotal)} realized=${formatUsd(snapshot.execution.realizedSlippageUsdTotal)}`,
    );
    console.log(`Capture rate: ${formatPct(captureRate)}`);

    if (snapshot.recentOpportunities.length === 0) {
      console.log("\nNo opportunities logged yet.");
      return;
    }

    console.log("\nRecent opportunities:");
    for (const record of snapshot.recentOpportunities) {
      const reasonSuffix = !record.viable && record.reason ? ` reason=${record.reason}` : "";
      console.log(
        `- [${record.strategyType ?? "binary_arb"}] ${record.slug}: ref=${record.arb.toFixed(4)} size=${record.tradeSize.toFixed(3)} pnl=${formatUsd(
          record.expectedProfitUsd,
        )} edge=${formatPct(record.expectedProfitPct)} viable=${record.viable}${reasonSuffix}`,
      );
    }
  }
}
