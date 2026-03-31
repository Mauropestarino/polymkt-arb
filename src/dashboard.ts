import type { ArbitrageEngineStats, DashboardSnapshot, ExecutionStats, MarketScannerStats, OpportunityLogRecord } from "./types.js";
import { formatPct, formatUsd } from "./lib/utils.js";

export class CliDashboard {
  private readonly recentOpportunities: OpportunityLogRecord[] = [];
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly startedAt: number,
    private readonly getScannerStats: () => MarketScannerStats,
    private readonly getArbitrageStats: () => ArbitrageEngineStats,
    private readonly getExecutionStats: () => ExecutionStats,
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
      execution: this.getExecutionStats(),
      recentOpportunities: [...this.recentOpportunities],
    };
  }

  private render(): void {
    const snapshot = this.snapshot();
    const uptimeSeconds = Math.max(1, Math.floor((Date.now() - snapshot.startedAt) / 1000));

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
      `Opportunities: seen=${snapshot.arbitrage.opportunitiesSeen} viable=${snapshot.arbitrage.opportunitiesViable} executed=${snapshot.arbitrage.opportunitiesExecuted}`,
    );
    console.log(
      `Executions: attempted=${snapshot.execution.executionsAttempted} success=${snapshot.execution.executionsSucceeded} failed=${snapshot.execution.executionsFailed} hedges=${snapshot.execution.hedgesTriggered} openNotional=${formatUsd(snapshot.execution.openNotionalUsd)}`,
    );

    if (snapshot.recentOpportunities.length === 0) {
      console.log("\nNo opportunities logged yet.");
      return;
    }

    console.log("\nRecent opportunities:");
    for (const record of snapshot.recentOpportunities) {
      console.log(
        `- ${record.slug}: arb=${record.arb.toFixed(4)} size=${record.tradeSize.toFixed(3)} pnl=${formatUsd(
          record.expectedProfitUsd,
        )} edge=${formatPct(record.expectedProfitPct)} viable=${record.viable}`,
      );
    }
  }
}
