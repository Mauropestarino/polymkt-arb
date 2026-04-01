import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ArbitrageEngineStats,
  MarketBookState,
  NegRiskAssessment,
  NegRiskGroup,
  OpportunityLogRecord,
} from "./types.js";
import { AlertService } from "./alerts.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { OrderBookStore } from "./orderBookStore.js";
import { NegRiskCatalog } from "./negRiskCatalog.js";
import { RiskManager } from "./riskManager.js";

interface ActiveOpportunityWindow {
  detectedAt: number;
  lastRecord: OpportunityLogRecord;
  lastAssessment: NegRiskAssessment;
  countedViable: boolean;
  attemptedExecution: boolean;
}

export class NegRiskEngine extends EventEmitter {
  private readonly evaluationScheduled = new Set<string>();
  private readonly pendingGroups = new Set<string>();
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
    private readonly catalog: NegRiskCatalog,
    private readonly store: OrderBookStore,
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
    };
  }

  handleMarketUpdate(state: MarketBookState): void {
    const group = this.catalog.getGroupByConditionId(state.market.conditionId);
    if (!group) {
      return;
    }

    if (this.evaluationScheduled.has(group.id)) {
      this.pendingGroups.add(group.id);
      return;
    }

    this.evaluationScheduled.add(group.id);
    queueMicrotask(() => {
      void this.drainEvaluationQueue(group.id);
    });
  }

  private async drainEvaluationQueue(groupId: string): Promise<void> {
    try {
      while (true) {
        this.pendingGroups.delete(groupId);
        await this.evaluateGroup(groupId);
        if (!this.pendingGroups.has(groupId)) {
          break;
        }
      }
    } finally {
      this.evaluationScheduled.delete(groupId);
      if (this.pendingGroups.has(groupId)) {
        this.handlePendingGroup(groupId);
      }
    }
  }

  private handlePendingGroup(groupId: string): void {
    const group = this.catalog.getGroupById(groupId);
    if (!group) {
      this.pendingGroups.delete(groupId);
      return;
    }

    const firstState = this.store.getMarket(group.members[0]?.conditionId ?? "");
    if (!firstState) {
      return;
    }

    this.handleMarketUpdate(firstState);
  }

  private async evaluateGroup(groupId: string): Promise<void> {
    const group = this.catalog.getGroupById(groupId);
    if (!group) {
      return;
    }

    const statesByConditionId = new Map<string, MarketBookState>();
    for (const member of group.members) {
      const state = this.store.getMarket(member.conditionId);
      if (state) {
        statesByConditionId.set(member.conditionId, state);
      }
    }

    for (const member of group.members) {
      const sourceState = statesByConditionId.get(member.conditionId);
      if (!sourceState) {
        this.finalizeOpportunity(this.buildOpportunityKey(group.id, member.conditionId), Date.now());
        continue;
      }

      const targetStates = group.members
        .filter((candidate) => candidate.conditionId !== member.conditionId)
        .map((candidate) => statesByConditionId.get(candidate.conditionId))
        .filter((state): state is MarketBookState => Boolean(state));

      await this.evaluateSource(group, sourceState, targetStates);
    }
  }

  private async evaluateSource(
    group: NegRiskGroup,
    sourceState: MarketBookState,
    targetStates: MarketBookState[],
  ): Promise<void> {
    const now = Date.now();
    const sourceMember = group.members.find(
      (member) => member.conditionId === sourceState.market.conditionId,
    );
    if (!sourceMember) {
      return;
    }

    const bestNoAsk = sourceState.no.bestAsk ?? sourceState.no.asks[0]?.price;
    const convertMultiplier = 1 - (group.convertFeeBps / 10_000);
    const bestSyntheticProceeds =
      convertMultiplier > 0
        ? targetStates.reduce((total, state) => total + (state.yes.bestBid ?? state.yes.bids[0]?.price ?? 0), 0) * convertMultiplier
        : 0;
    const rawSpread =
      bestNoAsk !== undefined && targetStates.length === group.members.length - 1
        ? bestSyntheticProceeds - bestNoAsk
        : 0;
    const opportunityKey = this.buildOpportunityKey(group.id, sourceState.market.conditionId);

    if (bestNoAsk === undefined || targetStates.length !== group.members.length - 1 || rawSpread <= this.config.arbitrageBuffer) {
      this.finalizeOpportunity(opportunityKey, now);
      return;
    }

    let activeWindow = this.activeOpportunityWindows.get(opportunityKey);
    if (!activeWindow) {
      this.opportunitiesSeen += 1;
      activeWindow = {
        detectedAt: now,
        countedViable: false,
        attemptedExecution: false,
        lastRecord: {
          type: "opportunity",
          timestamp: now,
          marketId: sourceState.market.conditionId,
          slug: sourceState.market.slug,
          question: sourceState.market.question,
          groupId: group.id,
          groupSlug: group.slug,
          groupQuestion: group.title,
          strategyType: "neg_risk_arb",
          arb: rawSpread,
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
          strategyType: "neg_risk_arb",
          market: sourceState.market,
          timestamp: now,
          tradeSize: 0,
          groupId: group.id,
          groupSlug: group.slug,
          groupQuestion: group.title,
          sourceOutcomeIndex: sourceMember.outcomeIndex,
          negRiskMarketId: group.negRiskMarketId,
          convertFeeBps: group.convertFeeBps,
          convertOutputSize: 0,
          sourceNo: {
            tokenId: sourceState.market.noTokenId,
            requestedSize: 0,
            executableSize: 0,
            totalCost: 0,
            averagePrice: 0,
            worstPrice: 0,
            slippagePct: 0,
            levelsConsumed: 0,
            bestAsk: 0,
            fee: {
              feeRateBps: 0,
              feeRate: 0,
              feeExponent: 1,
              feeUsd: 0,
              feeShares: 0,
            },
          },
          targetYesLegs: [],
          arb: rawSpread,
          grossEdgeUsd: 0,
          totalFeesUsd: 0,
          estimatedSlippageUsd: 0,
          totalSpendUsd: 0,
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
    const assessment = await this.riskManager.evaluateNegRisk(group, sourceState, targetStates);
    const opportunityRecord: OpportunityLogRecord = {
      type: "opportunity",
      timestamp: assessment.timestamp,
      marketId: sourceState.market.conditionId,
      slug: sourceState.market.slug,
      question: sourceState.market.question,
      groupId: group.id,
      groupSlug: group.slug,
      groupQuestion: group.title,
      strategyType: "neg_risk_arb",
      arb: assessment.arb,
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
          group: group.slug,
          source: sourceState.market.slug,
          arb: assessment.arb,
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          reason: assessment.reason,
        },
        "Neg-risk opportunity rejected by risk manager",
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

    if (this.executionEngine.isBusy(group.id)) {
      return;
    }

    if (!activeWindow.attemptedExecution) {
      this.opportunitiesCaptured += 1;
      activeWindow.attemptedExecution = true;
    }

    this.riskManager.markOpportunityTriggered(opportunityKey, now);
    await this.alerts.notifyOpportunity(assessment);

    const result = await this.executionEngine.executeNegRisk(assessment);
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
      groupId: result.groupId,
      groupSlug: result.groupSlug,
      groupQuestion: result.groupQuestion,
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
    });

    await this.alerts.notifyTrade(result);
  }

  private buildOpportunityKey(groupId: string, sourceConditionId: string): string {
    return `${groupId}:${sourceConditionId}`;
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
}
