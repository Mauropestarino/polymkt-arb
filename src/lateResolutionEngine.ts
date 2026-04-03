import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  LateResolutionAssessment,
  LateResolutionSignal,
  LateResolutionStats,
  MarketBookState,
  OpportunityLogRecord,
} from "./types.js";
import { AlertService } from "./alerts.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { ResolutionSignalStore } from "./resolutionSignalStore.js";
import { RiskManager } from "./riskManager.js";

interface ActiveLateResolutionWindow {
  detectedAt: number;
  signal: LateResolutionSignal;
  lastRecord: OpportunityLogRecord;
  lastAssessment: LateResolutionAssessment;
  countedViable: boolean;
  attemptedExecution: boolean;
}

export class LateResolutionEngine extends EventEmitter {
  private readonly evaluationScheduled = new Set<string>();
  private readonly pendingStates = new Map<string, MarketBookState>();
  private readonly activeOpportunityWindows = new Map<string, ActiveLateResolutionWindow>();
  private readonly consumedSignalExecutions = new Map<string, number>();
  private opportunitiesSeen = 0;
  private opportunitiesViable = 0;
  private opportunitiesExecuted = 0;
  private opportunitiesCaptured = 0;
  private totalOpportunityDurationMs = 0;
  private completedOpportunityCount = 0;
  private lastOpportunityAt?: number;

  constructor(
    private readonly config: BotConfig,
    private readonly signalStore: ResolutionSignalStore,
    private readonly riskManager: RiskManager,
    private readonly executionEngine: ExecutionEngine,
    private readonly alerts: AlertService,
    private readonly journal: EventJournal,
    private readonly logger: Logger,
  ) {
    super();
  }

  getStats(): LateResolutionStats {
    return {
      opportunitiesSeen: this.opportunitiesSeen,
      opportunitiesViable: this.opportunitiesViable,
      opportunitiesExecuted: this.opportunitiesExecuted,
      opportunitiesCaptured: this.opportunitiesCaptured,
      averageOpportunityDurationMs:
        this.completedOpportunityCount > 0
          ? this.totalOpportunityDurationMs / this.completedOpportunityCount
          : undefined,
      completedOpportunityCount: this.completedOpportunityCount,
      totalOpportunityDurationMs: this.totalOpportunityDurationMs,
      lastOpportunityAt: this.lastOpportunityAt,
    };
  }

  handleMarketUpdate(state: MarketBookState): void {
    const conditionId = state.market.conditionId;
    if (this.evaluationScheduled.has(conditionId)) {
      this.pendingStates.set(conditionId, state);
      return;
    }

    this.evaluationScheduled.add(conditionId);
    queueMicrotask(() => {
      void this.drainEvaluationQueue(conditionId, state);
    });
  }

  private async evaluateMarket(state: MarketBookState): Promise<void> {
    const now = Date.now();
    this.pruneConsumedSignals(now);
    const signal = this.signalStore.getSignal(state.market, now);
    if (!signal) {
      this.expireMarketOpportunities(state.market.conditionId, now);
      return;
    }

    const opportunityKey = this.buildOpportunityKey(state.market.conditionId, signal.resolvedOutcome);
    const signalExecutionKey = this.buildSignalExecutionKey(state.market.conditionId, signal);
    const oppositeKey = this.buildOpportunityKey(
      state.market.conditionId,
      signal.resolvedOutcome === "YES" ? "NO" : "YES",
    );

    this.finalizeOpportunity(oppositeKey, now);

    if (this.consumedSignalExecutions.has(signalExecutionKey)) {
      this.finalizeOpportunity(opportunityKey, now);
      return;
    }

    const assessment = await this.riskManager.evaluateLateResolution(
      state,
      signal.resolvedOutcome,
      signal.source,
    );

    if (!assessment.viable) {
      this.finalizeOpportunity(opportunityKey, now);
      if (assessment.reason) {
        this.logger.debug(
          {
            market: state.market.slug,
            strategy: "late_resolution",
            resolvedOutcome: signal.resolvedOutcome,
            tradeSize: assessment.tradeSize,
            expectedProfitUsd: assessment.expectedProfitUsd,
            expectedProfitPct: assessment.expectedProfitPct,
            grossEdgeUsd: assessment.grossEdgeUsd,
            totalFeesUsd: assessment.totalFeesUsd,
            estimatedSlippageUsd: assessment.estimatedSlippageUsd,
            gasUsd: assessment.gasUsd,
            reason: assessment.reason,
          },
          "Late-resolution opportunity rejected by risk manager",
        );
      }
      return;
    }

    let activeWindow = this.activeOpportunityWindows.get(opportunityKey);
    if (activeWindow) {
      const activeSignalKey = this.buildSignalExecutionKey(state.market.conditionId, activeWindow.signal);
      if (activeSignalKey !== signalExecutionKey) {
        this.finalizeOpportunity(opportunityKey, now);
        activeWindow = undefined;
      }
    }

    if (!activeWindow) {
      this.opportunitiesSeen += 1;
      activeWindow = {
        detectedAt: now,
        signal,
        countedViable: false,
        attemptedExecution: false,
        lastRecord: {
          type: "opportunity",
          timestamp: assessment.timestamp,
          marketId: state.market.conditionId,
          slug: state.market.slug,
          question: state.market.question,
          strategyType: "late_resolution",
          resolvedOutcome: signal.resolvedOutcome,
          arb: assessment.leg.bestAsk,
          tradeSize: assessment.tradeSize,
          grossEdgeUsd: assessment.grossEdgeUsd,
          totalFeesUsd: assessment.totalFeesUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          expectedProfitUsd: assessment.expectedProfitUsd,
          expectedProfitPct: assessment.expectedProfitPct,
          viable: true,
          detectedAt: now,
          reason: "Late-resolution risk assessment pending",
        },
        lastAssessment: assessment,
      };
      this.activeOpportunityWindows.set(opportunityKey, activeWindow);
    }

    this.lastOpportunityAt = now;

    const opportunityRecord: OpportunityLogRecord = {
      type: "opportunity",
      timestamp: assessment.timestamp,
      marketId: state.market.conditionId,
      slug: state.market.slug,
      question: state.market.question,
      strategyType: "late_resolution",
      resolvedOutcome: signal.resolvedOutcome,
      arb: assessment.leg.bestAsk,
      tradeSize: assessment.tradeSize,
      grossEdgeUsd: assessment.grossEdgeUsd,
      totalFeesUsd: assessment.totalFeesUsd,
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      expectedProfitUsd: assessment.expectedProfitUsd,
      expectedProfitPct: assessment.expectedProfitPct,
      viable: assessment.viable,
      detectedAt: activeWindow.detectedAt,
      reason: assessment.reason,
    };

    activeWindow.signal = signal;
    activeWindow.lastAssessment = assessment;
    activeWindow.lastRecord = opportunityRecord;
    this.emit("opportunity", opportunityRecord);

    if (!activeWindow.countedViable) {
      this.opportunitiesViable += 1;
      activeWindow.countedViable = true;
    }

    if (!this.riskManager.canTriggerOpportunity(opportunityKey, now)) {
      return;
    }

    if (this.executionEngine.isBusy(state.market.conditionId)) {
      return;
    }

    if (!activeWindow.attemptedExecution) {
      this.opportunitiesCaptured += 1;
      activeWindow.attemptedExecution = true;
    }

    this.riskManager.markOpportunityTriggered(opportunityKey, now);
    await this.alerts.notifyOpportunity(assessment);

    const result = await this.executionEngine.executeLateResolution(assessment);
    this.consumedSignalExecutions.set(signalExecutionKey, result.timestamp);
    if (result.success) {
      this.opportunitiesExecuted += 1;
    }

    this.journal.logTrade({
      type: "trade",
      timestamp: result.timestamp,
      success: result.success,
      mode: result.mode,
      marketId: result.market.conditionId,
      slug: result.market.slug,
      question: result.market.question,
      strategyType: result.strategyType,
      resolvedOutcome: result.resolvedOutcome,
      tradeSize: result.tradeSize,
      expectedProfitUsd: result.expectedProfitUsd,
      realizedProfitUsd: result.realizedProfitUsd,
      estimatedSlippageUsd: result.estimatedSlippageUsd,
      realizedSlippageUsd: result.realizedSlippageUsd,
      orderIds: result.orderIds,
      hedgeOrderIds: result.hedgeOrderIds,
      notes: result.notes,
      settlementAction: result.settlementAction,
      settlementTxHash: result.settlementTxHash,
      settlementAmount: result.settlementAmount,
      settlementBlockNumber: result.settlementBlockNumber,
      reconciledAt: result.reconciledAt,
      reconciliationSatisfied: result.reconciliationSatisfied,
      reconciledPortfolioValueUsd: result.reconciledPortfolioValueUsd,
      reconciledPositionCount: result.reconciledPositionCount,
      shadowFillSuccess: result.shadowFillSuccess,
      shadowFillReason: result.shadowFillReason,
      shadowLatencyMs: result.shadowLatencyMs,
      shadowRealizedProfitUsd: result.shadowRealizedProfitUsd,
      shadowRealizedSlippageUsd: result.shadowRealizedSlippageUsd,
    });

    await this.alerts.notifyTrade(result);
    this.finalizeOpportunity(opportunityKey, Date.now());
  }

  private expireMarketOpportunities(conditionId: string, expiredAt: number): void {
    for (const key of [...this.activeOpportunityWindows.keys()]) {
      if (key.startsWith(`${conditionId}:`)) {
        this.finalizeOpportunity(key, expiredAt);
      }
    }
  }

  private finalizeOpportunity(opportunityKey: string, expiredAt: number): void {
    const activeWindow = this.activeOpportunityWindows.get(opportunityKey);
    if (!activeWindow) {
      return;
    }

    this.activeOpportunityWindows.delete(opportunityKey);
    const durationMs = Math.max(0, expiredAt - activeWindow.detectedAt);
    this.totalOpportunityDurationMs += durationMs;
    this.completedOpportunityCount += 1;
    this.journal.logOpportunity({
      ...activeWindow.lastRecord,
      expiredAt,
      opportunity_duration_ms: durationMs,
    });
  }

  private buildOpportunityKey(conditionId: string, outcome: "YES" | "NO"): string {
    return `${conditionId}:${outcome}`;
  }

  private buildSignalExecutionKey(conditionId: string, signal: LateResolutionSignal): string {
    return [
      conditionId,
      signal.resolvedOutcome,
      signal.source,
      String(signal.resolvedAt),
    ].join(":");
  }

  private pruneConsumedSignals(now: number): void {
    for (const [key, consumedAt] of this.consumedSignalExecutions.entries()) {
      if (now - consumedAt > this.config.lateResolutionMaxSignalAgeMs) {
        this.consumedSignalExecutions.delete(key);
      }
    }
  }

  private async drainEvaluationQueue(
    conditionId: string,
    initialState: MarketBookState,
  ): Promise<void> {
    try {
      let nextState: MarketBookState | undefined = initialState;

      while (true) {
        if (!nextState) {
          break;
        }

        await this.evaluateMarket(nextState);
        nextState = this.pendingStates.get(conditionId);
        this.pendingStates.delete(conditionId);
      }
    } finally {
      this.evaluationScheduled.delete(conditionId);

      if (this.pendingStates.has(conditionId)) {
        this.handleMarketUpdate(this.pendingStates.get(conditionId)!);
      }
    }
  }
}
