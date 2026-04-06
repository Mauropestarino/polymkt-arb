import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { AlertService } from "./alerts.js";
import { CexPriceFeed } from "./cexPriceFeed.js";
import { CryptoMarketRegistry } from "./cryptoMarketRegistry.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { OrderBookStore } from "./orderBookStore.js";
import { TemporalArbRiskManager } from "./temporalArbRiskManager.js";
import type {
  CryptoSymbol,
  MarketBookState,
  OpportunityLogRecord,
  SpotPrice,
  TemporalArbAssessment,
  TemporalArbStats,
} from "./types.js";

interface ActiveTemporalOpportunityWindow {
  detectedAt: number;
  direction: "YES" | "NO";
  lastRecord: OpportunityLogRecord;
  lastAssessment: TemporalArbAssessment;
  countedViable: boolean;
  attemptedExecution: boolean;
}

const buildSymbolStats = (): TemporalArbStats["bySymbol"] => ({
  BTC: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
  ETH: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
  SOL: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
});

export class TemporalArbEngine extends EventEmitter {
  private readonly evaluationScheduled = new Set<string>();
  private readonly pendingConditionIds = new Set<string>();
  private readonly activeOpportunityWindows = new Map<string, ActiveTemporalOpportunityWindow>();
  private readonly consumedMarkets = new Map<string, number>();
  private readonly marketCooldownUntil = new Map<string, number>();
  private opportunitiesSeen = 0;
  private opportunitiesViable = 0;
  private opportunitiesExecuted = 0;
  private opportunitiesCaptured = 0;
  private totalOpportunityDurationMs = 0;
  private completedOpportunityCount = 0;
  private lastOpportunityAt?: number;
  private staleBooksSkipped = 0;
  private lastBookAgeMs?: number;
  private signalsGenerated = 0;
  private signalsRejectedByConfidence = 0;
  private signalsRejectedByFeed = 0;
  private staleFeedSkips = 0;
  private executedConfidenceTotal = 0;
  private executedEdgeTotal = 0;
  private readonly bySymbol = buildSymbolStats();

  constructor(
    private readonly config: BotConfig,
    private readonly registry: CryptoMarketRegistry,
    private readonly cexPriceFeed: CexPriceFeed,
    private readonly store: OrderBookStore,
    private readonly riskManager: TemporalArbRiskManager,
    private readonly executionEngine: ExecutionEngine,
    private readonly alerts: AlertService,
    private readonly journal: EventJournal,
    private readonly logger: Logger,
  ) {
    super();
  }

  /**
   * Returns temporal-arbitrage opportunity, execution, and feed-skip stats.
   */
  getStats(): TemporalArbStats {
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
      staleBooksSkipped: this.staleBooksSkipped,
      lastBookAgeMs: this.lastBookAgeMs,
      signalsGenerated: this.signalsGenerated,
      signalsRejectedByConfidence: this.signalsRejectedByConfidence,
      signalsRejectedByFeed: this.signalsRejectedByFeed,
      staleFeedSkips: this.staleFeedSkips,
      avgConfidenceOnExecution:
        this.opportunitiesExecuted > 0
          ? this.executedConfidenceTotal / this.opportunitiesExecuted
          : 0,
      avgEdgeOnExecution:
        this.opportunitiesExecuted > 0 ? this.executedEdgeTotal / this.opportunitiesExecuted : 0,
      bySymbol: {
        BTC: { ...this.bySymbol.BTC },
        ETH: { ...this.bySymbol.ETH },
        SOL: { ...this.bySymbol.SOL },
      },
    };
  }

  /**
   * Schedules temporal evaluations for all active crypto strike markets affected by a spot move.
   */
  handleSpotPrice(spot: SpotPrice): void {
    const now = Date.now();
    this.pruneState(now);

    for (const market of this.registry.getActiveMarketsForSymbol(spot.symbol, now)) {
      this.scheduleEvaluation(market.conditionId);
    }
  }

  /**
   * Re-evaluates a crypto strike market when its Polymarket book changes.
   */
  handleMarketUpdate(state: MarketBookState): void {
    const now = Date.now();
    this.pruneState(now);

    if (!this.registry.getMarket(state.market.conditionId)) {
      this.expireMarketOpportunities(state.market.conditionId, now);
      return;
    }

    this.scheduleEvaluation(state.market.conditionId);
  }

  private scheduleEvaluation(conditionId: string): void {
    if (this.evaluationScheduled.has(conditionId)) {
      this.pendingConditionIds.add(conditionId);
      return;
    }

    this.evaluationScheduled.add(conditionId);
    queueMicrotask(() => {
      void this.drainEvaluationQueue(conditionId);
    });
  }

  private async evaluateCondition(conditionId: string): Promise<void> {
    try {
      const now = Date.now();
      const market = this.registry.getMarket(conditionId);
      if (!market) {
        this.expireMarketOpportunities(conditionId, now);
        return;
      }

      if (market.windowEndMs <= now) {
        this.expireMarketOpportunities(conditionId, now);
        this.consumedMarkets.delete(conditionId);
        this.marketCooldownUntil.delete(conditionId);
        return;
      }

      const cooldownUntil = this.marketCooldownUntil.get(conditionId);
      if (cooldownUntil && cooldownUntil > now) {
        return;
      }

      if (this.consumedMarkets.has(conditionId)) {
        this.expireMarketOpportunities(conditionId, now);
        return;
      }

      const spot = this.cexPriceFeed.getPrice(market.symbol);
      if (!spot) {
        this.signalsRejectedByFeed += 1;
        this.expireMarketOpportunities(conditionId, now);
        this.logger.debug({ conditionId, symbol: market.symbol }, "Skipping temporal arb: no spot price available");
        return;
      }

      if (this.cexPriceFeed.isStale(market.symbol)) {
        this.signalsRejectedByFeed += 1;
        this.staleFeedSkips += 1;
        this.expireMarketOpportunities(conditionId, now);
        this.logger.debug(
          { conditionId, symbol: market.symbol },
          "Skipping temporal arb because the selected CEX feed is stale",
        );
        return;
      }

      const state = this.store.getMarket(conditionId);
      if (!state) {
        return;
      }

      const bookAgeMs = Math.max(0, now - state.lastUpdatedAt);
      this.lastBookAgeMs = bookAgeMs;
      if (bookAgeMs > this.config.maxBookAgeMs) {
        this.staleBooksSkipped += 1;
        this.logger.debug(
          { conditionId, bookAgeMs, maxBookAgeMs: this.config.maxBookAgeMs },
          "Skipping temporal arb because the Polymarket book is stale",
        );
        return;
      }

      const assessment = await this.riskManager.evaluate(market, state, spot, now);
      this.signalsGenerated += 1;
      const opportunityKey = this.buildOpportunityKey(conditionId, assessment.signal.direction);
      const oppositeKey = this.buildOpportunityKey(
        conditionId,
        assessment.signal.direction === "YES" ? "NO" : "YES",
      );
      this.finalizeOpportunity(oppositeKey, now);

      let activeWindow = this.activeOpportunityWindows.get(opportunityKey);
      if (!activeWindow) {
        this.opportunitiesSeen += 1;
        this.bySymbol[market.symbol].opportunitiesSeen += 1;
        activeWindow = {
          detectedAt: now,
          direction: assessment.signal.direction,
          countedViable: false,
          attemptedExecution: false,
          lastRecord: {
            type: "opportunity",
            timestamp: assessment.timestamp,
            marketId: conditionId,
            slug: market.slug,
            question: market.question,
            strategyType: "temporal_arb",
            arb: assessment.signal.polymarketPrice,
            tradeSize: assessment.tradeSize,
            expectedProfitUsd: assessment.expectedProfitUsd,
            expectedProfitPct: assessment.expectedProfitPct,
            viable: assessment.viable,
            symbol: market.symbol,
            spotPrice: assessment.signal.spotPrice,
            strikePrice: assessment.signal.strikePrice,
            normalizedEdge: assessment.signal.normalizedEdge,
            timeRemainingMs: assessment.signal.timeRemainingMs,
            resolutionConfidence: assessment.signal.resolutionConfidence,
            spotAgeMs: Math.max(0, now - assessment.signal.spotReceivedAt),
            detectedAt: now,
            reason: assessment.reason ?? "Temporal risk assessment pending",
          },
          lastAssessment: assessment,
        };
        this.activeOpportunityWindows.set(opportunityKey, activeWindow);
      }

      this.lastOpportunityAt = now;

      const opportunityRecord: OpportunityLogRecord = {
        type: "opportunity",
        timestamp: assessment.timestamp,
        marketId: conditionId,
        slug: market.slug,
        question: market.question,
        strategyType: "temporal_arb",
        arb: assessment.signal.polymarketPrice,
        tradeSize: assessment.tradeSize,
        grossEdgeUsd: assessment.signal.impliedEdgeUsd,
        totalFeesUsd: assessment.totalFeesUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        gasUsd: assessment.gasUsd,
        expectedProfitUsd: assessment.expectedProfitUsd,
        expectedProfitPct: assessment.expectedProfitPct,
        viable: assessment.viable,
        symbol: market.symbol,
        spotPrice: assessment.signal.spotPrice,
        strikePrice: assessment.signal.strikePrice,
        normalizedEdge: assessment.signal.normalizedEdge,
        timeRemainingMs: assessment.signal.timeRemainingMs,
        resolutionConfidence: assessment.signal.resolutionConfidence,
        spotAgeMs: Math.max(0, now - assessment.signal.spotReceivedAt),
        detectedAt: activeWindow.detectedAt,
        reason: assessment.reason,
      };

      activeWindow.lastRecord = opportunityRecord;
      activeWindow.lastAssessment = assessment;
      this.emit("opportunity", opportunityRecord);

      if (!assessment.viable) {
        if (assessment.reason?.toLowerCase().includes("confidence")) {
          this.signalsRejectedByConfidence += 1;
        }
        this.marketCooldownUntil.set(conditionId, now + this.getCooldownMs());
        this.logger.debug(
          {
            conditionId,
            slug: market.slug,
            symbol: market.symbol,
            confidence: assessment.signal.resolutionConfidence,
            edge: assessment.signal.normalizedEdge,
            reason: assessment.reason,
          },
          "Temporal opportunity rejected by risk manager",
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

      if (this.executionEngine.isBusy(conditionId)) {
        return;
      }

      if (!activeWindow.attemptedExecution) {
        this.opportunitiesCaptured += 1;
        activeWindow.attemptedExecution = true;
      }

      this.riskManager.markOpportunityTriggered(opportunityKey, now);
      this.marketCooldownUntil.set(conditionId, now + this.getCooldownMs());
      await this.alerts.notifyOpportunity(assessment);

      const result = await this.executionEngine.executeTemporal(assessment);
      this.consumedMarkets.set(conditionId, result.timestamp);
      if (result.success) {
        this.opportunitiesExecuted += 1;
        this.executedConfidenceTotal += assessment.resolutionConfidence;
        this.executedEdgeTotal += assessment.signal.normalizedEdge;
        this.bySymbol[market.symbol].opportunitiesExecuted += 1;
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
        tradeSize: result.tradeSize,
        expectedProfitUsd: result.expectedProfitUsd,
        realizedProfitUsd: result.realizedProfitUsd,
        estimatedSlippageUsd: result.estimatedSlippageUsd,
        realizedSlippageUsd: result.realizedSlippageUsd,
        orderIds: result.orderIds,
        hedgeOrderIds: result.hedgeOrderIds,
        notes: result.notes,
        symbol: market.symbol,
        spotPrice: assessment.signal.spotPrice,
        strikePrice: assessment.signal.strikePrice,
        normalizedEdge: assessment.signal.normalizedEdge,
        timeRemainingMs: assessment.signal.timeRemainingMs,
        resolutionConfidence: assessment.resolutionConfidence,
        spotAgeMs: Math.max(0, result.timestamp - assessment.signal.spotReceivedAt),
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
      this.expireMarketOpportunities(conditionId, Date.now());
    } catch (error) {
      this.logger.error({ error, conditionId }, "Temporal arb evaluation failed");
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

  private expireMarketOpportunities(conditionId: string, expiredAt: number): void {
    for (const key of [...this.activeOpportunityWindows.keys()]) {
      if (key.startsWith(`${conditionId}:`)) {
        this.finalizeOpportunity(key, expiredAt);
      }
    }
  }

  private buildOpportunityKey(conditionId: string, direction: "YES" | "NO"): string {
    return `${conditionId}:${direction}`;
  }

  private async drainEvaluationQueue(conditionId: string): Promise<void> {
    try {
      let shouldContinue = true;

      while (shouldContinue) {
        this.pendingConditionIds.delete(conditionId);
        await this.evaluateCondition(conditionId);
        shouldContinue = this.pendingConditionIds.has(conditionId);
      }
    } finally {
      this.evaluationScheduled.delete(conditionId);
      if (this.pendingConditionIds.has(conditionId)) {
        this.scheduleEvaluation(conditionId);
      }
    }
  }

  private pruneState(now: number): void {
    for (const [conditionId, consumedAt] of this.consumedMarkets.entries()) {
      if (now - consumedAt > this.config.temporalArbMaxLookaheadMs) {
        this.consumedMarkets.delete(conditionId);
      }
    }

    for (const [conditionId, cooldownUntil] of this.marketCooldownUntil.entries()) {
      if (cooldownUntil <= now) {
        this.marketCooldownUntil.delete(conditionId);
      }
    }
  }

  private getCooldownMs(): number {
    return Math.max(this.config.temporalArbCooldownMs, 5_000);
  }
}
