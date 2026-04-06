import type {
  ArbitrageEngineStats,
  CexPriceFeedStatus,
  DashboardSnapshot,
  ExecutionStats,
  LateResolutionStats,
  MarketScannerStats,
  OpportunityLogRecord,
  TemporalArbStats,
  TradingGuardStatus,
} from "./types.js";
import { formatMs, formatPct, formatUsd } from "./lib/utils.js";

export class CliDashboard {
  private readonly recentOpportunities: OpportunityLogRecord[] = [];
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly startedAt: number,
    private readonly getScannerStats: () => MarketScannerStats,
    private readonly getArbitrageStats: () => ArbitrageEngineStats,
    private readonly getCeilingArbitrageStats: (() => ArbitrageEngineStats | undefined) | undefined,
    private readonly getNegRiskArbitrageStats: (() => ArbitrageEngineStats | undefined) | undefined,
    private readonly getExecutionStats: () => ExecutionStats,
    private readonly getLateResolutionStats?: () => LateResolutionStats,
    private readonly getTemporalArbStats?: () => TemporalArbStats | undefined,
    private readonly getCexFeedStatus?: () => CexPriceFeedStatus | undefined,
    private readonly getTradingGuardStatus?: () => TradingGuardStatus,
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
      ceilingArbitrage: this.getCeilingArbitrageStats?.(),
      negRiskArbitrage: this.getNegRiskArbitrageStats?.(),
      lateResolution: this.getLateResolutionStats?.(),
      temporalArb: this.getTemporalArbStats?.(),
      execution: this.getExecutionStats(),
      cexFeedStatus: this.getCexFeedStatus?.(),
      tradingGuard: this.getTradingGuardStatus?.(),
      recentOpportunities: [...this.recentOpportunities],
    };
  }

  private render(): void {
    const snapshot = this.snapshot();
    const uptimeSeconds = Math.max(1, Math.floor((Date.now() - snapshot.startedAt) / 1000));
    const totalOpportunitiesSeen =
      snapshot.arbitrage.opportunitiesSeen +
      (snapshot.ceilingArbitrage?.opportunitiesSeen ?? 0) +
      (snapshot.negRiskArbitrage?.opportunitiesSeen ?? 0) +
      (snapshot.lateResolution?.opportunitiesSeen ?? 0) +
      (snapshot.temporalArb?.opportunitiesSeen ?? 0);
    const totalCapturedOpportunities =
      snapshot.arbitrage.opportunitiesCaptured +
      (snapshot.ceilingArbitrage?.opportunitiesCaptured ?? 0) +
      (snapshot.negRiskArbitrage?.opportunitiesCaptured ?? 0) +
      (snapshot.lateResolution?.opportunitiesCaptured ?? 0) +
      (snapshot.temporalArb?.opportunitiesCaptured ?? 0);
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
      } | Reconnects: ${snapshot.scanner.websocketReconnects} | Disconnects: ${snapshot.scanner.websocketDisconnects}`,
    );
    console.log(
      `Last WS msg: ${
        snapshot.scanner.lastMessageAt
          ? formatMs(Date.now() - snapshot.scanner.lastMessageAt)
          : "n/a"
      } ago`,
    );
    console.log(
      `Binary arb: seen=${snapshot.arbitrage.opportunitiesSeen} captured=${snapshot.arbitrage.opportunitiesCaptured} viable=${snapshot.arbitrage.opportunitiesViable} executed=${snapshot.arbitrage.opportunitiesExecuted} avgDur=${formatMs(snapshot.arbitrage.averageOpportunityDurationMs)} staleSkips=${snapshot.arbitrage.staleBooksSkipped} lastBookAge=${formatMs(snapshot.arbitrage.lastBookAgeMs)}`,
    );
    console.log(
      `Binary ceiling: seen=${snapshot.ceilingArbitrage?.opportunitiesSeen ?? 0} captured=${snapshot.ceilingArbitrage?.opportunitiesCaptured ?? 0} viable=${snapshot.ceilingArbitrage?.opportunitiesViable ?? 0} executed=${snapshot.ceilingArbitrage?.opportunitiesExecuted ?? 0} avgDur=${formatMs(snapshot.ceilingArbitrage?.averageOpportunityDurationMs)}`,
    );
    console.log(
      `Neg risk: seen=${snapshot.negRiskArbitrage?.opportunitiesSeen ?? 0} captured=${snapshot.negRiskArbitrage?.opportunitiesCaptured ?? 0} viable=${snapshot.negRiskArbitrage?.opportunitiesViable ?? 0} executed=${snapshot.negRiskArbitrage?.opportunitiesExecuted ?? 0} avgDur=${formatMs(snapshot.negRiskArbitrage?.averageOpportunityDurationMs)}`,
    );
    console.log(
      `Late resolution: seen=${snapshot.lateResolution?.opportunitiesSeen ?? 0} captured=${snapshot.lateResolution?.opportunitiesCaptured ?? 0} viable=${snapshot.lateResolution?.opportunitiesViable ?? 0} executed=${snapshot.lateResolution?.opportunitiesExecuted ?? 0} avgDur=${formatMs(snapshot.lateResolution?.averageOpportunityDurationMs)}`,
    );
    console.log(
      `Temporal arb: seen=${snapshot.temporalArb?.opportunitiesSeen ?? 0} exec=${snapshot.temporalArb?.opportunitiesExecuted ?? 0} conf_avg=${(snapshot.temporalArb?.avgConfidenceOnExecution ?? 0).toFixed(2)} btc=${snapshot.temporalArb?.bySymbol.BTC.opportunitiesExecuted ?? 0} eth=${snapshot.temporalArb?.bySymbol.ETH.opportunitiesExecuted ?? 0} sol=${snapshot.temporalArb?.bySymbol.SOL.opportunitiesExecuted ?? 0} feedAge=${formatMs(snapshot.cexFeedStatus?.maxActiveFeedAgeMs)} [${
        snapshot.cexFeedStatus?.live ? "LIVE" : "STALE"
      }]`,
    );
    console.log(
      `Executions: attempted=${snapshot.execution.executionsAttempted} success=${snapshot.execution.executionsSucceeded} failed=${snapshot.execution.executionsFailed} hedges=${snapshot.execution.hedgesTriggered} fillRate=${formatPct(snapshot.execution.fillRate)} shadowFill=${formatPct(snapshot.execution.shadowFillRate)} shareFill=${formatPct(snapshot.execution.shareFillRate)} openNotional=${formatUsd(snapshot.execution.openNotionalUsd)} reservations=${snapshot.execution.openReservationsCount}`,
    );
    if (snapshot.tradingGuard) {
      console.log(
        `Trading: ${
          snapshot.tradingGuard.tradingEnabled ? "enabled" : "paused"
        }${
          snapshot.tradingGuard.pauseReason ? ` (${snapshot.tradingGuard.pauseReason})` : ""
        }${
          snapshot.tradingGuard.resumeAt
            ? ` resume=${new Date(snapshot.tradingGuard.resumeAt).toLocaleTimeString("es-AR", { hour12: false })}`
            : ""
        }`,
      );
    }
    console.log(
      `Slippage: estimated=${formatUsd(snapshot.execution.estimatedSlippageUsdTotal)} realized=${formatUsd(snapshot.execution.realizedSlippageUsdTotal)}`,
    );
    if (snapshot.execution.lastRetainedReservationReason) {
      console.log(
        `Reservations: lastRetain="${snapshot.execution.lastRetainedReservationReason}"`,
      );
    }
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
