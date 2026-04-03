import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ArbitrageDirection,
  ArbitrageEngineStats,
  CeilingAssessment,
  MarketBookState,
  OpportunityLogRecord,
} from "./types.js";
import { AlertService } from "./alerts.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { deriveOpportunityDirection } from "./lib/arbitrageMath.js";
import { RiskManager } from "./riskManager.js";

interface ActiveOpportunityWindow {
  detectedAt: number;
  direction: ArbitrageDirection;
  lastRecord: OpportunityLogRecord;
  lastAssessment: CeilingAssessment;
  countedViable: boolean;
  attemptedExecution: boolean;
}

export class CeilingArbitrageEngine extends EventEmitter {
  private readonly evaluationScheduled = new Set<string>();
  private readonly pendingStates = new Map<string, MarketBookState>();
  private readonly activeOpportunityWindows = new Map<string, ActiveOpportunityWindow>();
  private opportunitiesSeen = 0;
  private opportunitiesViable = 0;
  private opportunitiesExecuted = 0;
  private opportunitiesCaptured = 0;
  private totalOpportunityDurationMs = 0;
  private completedOpportunityCount = 0;
  private lastOpportunityAt?: number;

  constructor(
    private readonly config: BotConfig,
    private readonly riskManager: RiskManager,
    private readonly executionEngine: ExecutionEngine,
    private readonly alerts: AlertService,
    private readonly journal: EventJournal,
    private readonly logger: Logger,
  ) {
    super();
  }

  getStats(): ArbitrageEngineStats {
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
      staleBooksSkipped: 0,
      lastBookAgeMs: undefined,
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
    const bestYesBid = state.yes.bestBid ?? state.yes.bids[0]?.price;
    const bestNoBid = state.no.bestBid ?? state.no.bids[0]?.price;
    if (bestYesBid === undefined || bestNoBid === undefined) {
      this.expireMarketOpportunities(state.market.conditionId, Date.now());
      return;
    }

    const arb = bestYesBid + bestNoBid;
    if (arb <= 1 + this.config.arbitrageBuffer) {
      this.expireMarketOpportunities(state.market.conditionId, Date.now());
      return;
    }

    const now = Date.now();
    const direction = deriveOpportunityDirection(bestYesBid, bestNoBid);
    const opportunityKey = this.buildOpportunityKey(state.market.conditionId, direction);
    const oppositeKey = this.buildOpportunityKey(
      state.market.conditionId,
      direction === "YES_high" ? "NO_high" : "YES_high",
    );

    this.finalizeOpportunity(oppositeKey, now);

    let activeWindow = this.activeOpportunityWindows.get(opportunityKey);
    if (!activeWindow) {
      this.opportunitiesSeen += 1;
      activeWindow = {
        detectedAt: now,
        direction,
        countedViable: false,
        attemptedExecution: false,
        lastRecord: {
          type: "opportunity",
          timestamp: now,
          marketId: state.market.conditionId,
          slug: state.market.slug,
          question: state.market.question,
          strategyType: "binary_ceiling",
          direction,
          arb,
          tradeSize: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          viable: false,
          detectedAt: now,
          reason: "Risk assessment pending",
        },
        lastAssessment: {
          viable: false,
          reason: "Pending first assessment",
          strategyType: "binary_ceiling",
          market: state.market,
          timestamp: now,
          direction,
          tradeSize: 0,
          yes: {
            requestedSize: 0,
            executableSize: 0,
            totalCost: 0,
            averagePrice: 0,
            worstPrice: 0,
            slippagePct: 0,
            levelsConsumed: 0,
            bestBid: 0,
            fee: {
              feeRateBps: 0,
              feeRate: 0,
              feeExponent: 1,
              feeUsd: 0,
              feeShares: 0,
            },
          },
          no: {
            requestedSize: 0,
            executableSize: 0,
            totalCost: 0,
            averagePrice: 0,
            worstPrice: 0,
            slippagePct: 0,
            levelsConsumed: 0,
            bestBid: 0,
            fee: {
              feeRateBps: 0,
              feeRate: 0,
              feeExponent: 1,
              feeUsd: 0,
              feeShares: 0,
            },
          },
          arb,
          collateralRequiredUsd: 0,
          grossEdgeUsd: 0,
          totalFeesUsd: 0,
          estimatedSlippageUsd: 0,
          totalProceedsUsd: 0,
          gasUsd: 0,
          expectedProfitUsd: 0,
          expectedProfitPct: 0,
          netEdgePerShare: 0,
        },
      };
      this.activeOpportunityWindows.set(opportunityKey, activeWindow);
    }

    this.lastOpportunityAt = now;

    const assessment = await this.riskManager.evaluateCeiling(state);
    const opportunityRecord: OpportunityLogRecord = {
      type: "opportunity",
      timestamp: assessment.timestamp,
      marketId: state.market.conditionId,
      slug: state.market.slug,
      question: state.market.question,
      strategyType: "binary_ceiling",
      direction,
      arb,
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

    activeWindow.lastAssessment = assessment;
    activeWindow.lastRecord = opportunityRecord;
    this.emit("opportunity", opportunityRecord);

    if (!assessment.viable) {
      this.logger.debug(
        {
          market: state.market.slug,
          arb,
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          expectedProfitPct: assessment.expectedProfitPct,
          grossEdgeUsd: assessment.grossEdgeUsd,
          totalFeesUsd: assessment.totalFeesUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          gasUsd: assessment.gasUsd,
          reason: assessment.reason,
        },
        "Ceiling opportunity rejected by risk manager",
      );
      return;
    }

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

    const result = await this.executionEngine.executeCeiling(assessment);
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

  private buildOpportunityKey(conditionId: string, direction: ArbitrageDirection): string {
    return `${conditionId}:${direction}`;
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
