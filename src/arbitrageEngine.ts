import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ArbitrageEngineStats,
  MarketBookState,
  OpportunityLogRecord,
} from "./types.js";
import { AlertService } from "./alerts.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { RiskManager } from "./riskManager.js";

export class ArbitrageEngine extends EventEmitter {
  private readonly evaluationScheduled = new Set<string>();
  private readonly cooldownByMarket = new Map<string, number>();
  private opportunitiesSeen = 0;
  private opportunitiesViable = 0;
  private opportunitiesExecuted = 0;
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
      lastOpportunityAt: this.lastOpportunityAt,
    };
  }

  handleMarketUpdate(state: MarketBookState): void {
    if (this.evaluationScheduled.has(state.market.conditionId)) {
      return;
    }

    this.evaluationScheduled.add(state.market.conditionId);
    queueMicrotask(async () => {
      this.evaluationScheduled.delete(state.market.conditionId);
      await this.evaluateMarket(state);
    });
  }

  private async evaluateMarket(state: MarketBookState): Promise<void> {
    const bestYesAsk = state.yes.bestAsk ?? state.yes.asks[0]?.price;
    const bestNoAsk = state.no.bestAsk ?? state.no.asks[0]?.price;
    if (bestYesAsk === undefined || bestNoAsk === undefined) {
      return;
    }

    const arb = bestYesAsk + bestNoAsk;
    if (arb >= 1 - this.config.arbitrageBuffer) {
      return;
    }

    this.opportunitiesSeen += 1;
    this.lastOpportunityAt = Date.now();

    const assessment = await this.riskManager.evaluate(state);
    const opportunityRecord: OpportunityLogRecord = {
      type: "opportunity",
      timestamp: assessment.timestamp,
      marketId: state.market.conditionId,
      slug: state.market.slug,
      question: state.market.question,
      arb,
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      expectedProfitPct: assessment.expectedProfitPct,
      viable: assessment.viable,
      reason: assessment.reason,
    };

    this.journal.logOpportunity(opportunityRecord);
    this.emit("opportunity", opportunityRecord);

    if (!assessment.viable) {
      this.logger.debug(
        { market: state.market.slug, reason: assessment.reason },
        "Opportunity rejected by risk manager",
      );
      return;
    }

    this.opportunitiesViable += 1;

    const lastTriggeredAt = this.cooldownByMarket.get(state.market.conditionId) ?? 0;
    if (Date.now() - lastTriggeredAt < this.config.opportunityCooldownMs) {
      return;
    }

    if (this.executionEngine.isBusy(state.market.conditionId)) {
      return;
    }

    this.cooldownByMarket.set(state.market.conditionId, Date.now());
    await this.alerts.notifyOpportunity(assessment);

    const result = await this.executionEngine.execute(assessment);
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
      tradeSize: result.tradeSize,
      expectedProfitUsd: result.expectedProfitUsd,
      realizedProfitUsd: result.realizedProfitUsd,
      orderIds: result.orderIds,
      hedgeOrderIds: result.hedgeOrderIds,
      notes: result.notes,
    });

    await this.alerts.notifyTrade(result);
  }
}
