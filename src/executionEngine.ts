import { OrderType, Side } from "@polymarket/clob-client";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { CtfSettlementService } from "./ctfSettlement.js";
import { PortfolioReconciler } from "./portfolioReconciler.js";
import type {
  CeilingAssessment,
  ExecutionResult,
  ExecutionStats,
  LateResolutionAssessment,
  NegRiskAssessment,
  OrderStatusSnapshot,
  PortfolioReconciliationResult,
  RiskAssessment,
  SettlementReceipt,
} from "./types.js";
import { round, sum, stableId, sleep, toTickSize } from "./lib/utils.js";
import { OrderBookStore } from "./orderBookStore.js";
import { RiskManager } from "./riskManager.js";
import { TradingGuard } from "./tradingGuard.js";
import { WalletService } from "./wallet.js";

const orderTypeMap = {
  FOK: OrderType.FOK,
  FAK: OrderType.FAK,
  GTC: OrderType.GTC,
} as const;

type ExecutionMode = "paper" | "backtest";
const EXECUTION_EPSILON = 0.000001;

type TrackedOrder = {
  orderId?: string;
  conditionId?: string;
  tokenId: string;
  expectedSize: number;
  expectedAveragePrice: number;
  side: "BUY" | "SELL";
};

type BinaryReconciliation = {
  orderIds: string[];
  hedgeOrderIds: string[];
  hedged: boolean;
  notes: string[];
  matchedShares: number;
  realizedSlippageUsd: number;
  yesSnapshot: OrderStatusSnapshot;
  noSnapshot: OrderStatusSnapshot;
  bothCovered: boolean;
  pairedMatchedSize: number;
  hasOpenOrders: boolean;
  fullyFlat: boolean;
};

type SingleOrderReconciliation = {
  orderIds: string[];
  matchedShares: number;
  realizedSlippageUsd: number;
  notes: string[];
  snapshot: OrderStatusSnapshot;
  fullyFilled: boolean;
  hasOpenOrders: boolean;
  fullyFlat: boolean;
};

type BasketReconciliation = {
  orderIds: string[];
  hedgeOrderIds: string[];
  hedged: boolean;
  notes: string[];
  matchedShares: number;
  realizedSlippageUsd: number;
  snapshots: OrderStatusSnapshot[];
  fullyCovered: boolean;
  hasOpenOrders: boolean;
  fullyFlat: boolean;
};

interface ExecutionEngineDependencies {
  ctfSettlement?: CtfSettlementService;
  portfolioReconciler?: PortfolioReconciler;
}

export class ExecutionEngine {
  private executionsAttempted = 0;
  private executionsSucceeded = 0;
  private executionsFailed = 0;
  private hedgesTriggered = 0;
  private filledShares = 0;
  private intendedShares = 0;
  private estimatedSlippageUsdTotal = 0;
  private realizedSlippageUsdTotal = 0;
  private readonly marketLocks = new Set<string>();

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly store: OrderBookStore,
    private readonly riskManager: RiskManager,
    private readonly tradingGuard: TradingGuard,
    private readonly logger: Logger,
    private readonly dependencies: ExecutionEngineDependencies = {},
  ) {}

  isBusy(conditionId: string): boolean {
    return this.marketLocks.has(conditionId);
  }

  getStats(): ExecutionStats {
    const fillRate =
      this.executionsAttempted > 0 ? this.executionsSucceeded / this.executionsAttempted : 0;
    const shareFillRate = this.intendedShares > 0 ? this.filledShares / this.intendedShares : 0;
    const estimatedSlippageUsdAverage =
      this.executionsAttempted > 0 ? this.estimatedSlippageUsdTotal / this.executionsAttempted : 0;
    const realizedSlippageUsdAverage =
      this.executionsAttempted > 0 ? this.realizedSlippageUsdTotal / this.executionsAttempted : 0;

    return {
      executionsAttempted: this.executionsAttempted,
      executionsSucceeded: this.executionsSucceeded,
      executionsFailed: this.executionsFailed,
      hedgesTriggered: this.hedgesTriggered,
      openNotionalUsd: this.riskManager.getOpenNotionalUsd(),
      filledShares: round(this.filledShares, 6),
      intendedShares: round(this.intendedShares, 6),
      fillRate: round(fillRate, 6),
      shareFillRate: round(shareFillRate, 6),
      estimatedSlippageUsdTotal: round(this.estimatedSlippageUsdTotal, 6),
      estimatedSlippageUsdAverage: round(estimatedSlippageUsdAverage, 6),
      realizedSlippageUsdTotal: round(this.realizedSlippageUsdTotal, 6),
      realizedSlippageUsdAverage: round(realizedSlippageUsdAverage, 6),
    };
  }

  async execute(assessment: RiskAssessment, modeOverride?: ExecutionMode): Promise<ExecutionResult> {
    const reservationId = stableId(
      "binary_arb",
      assessment.market.conditionId,
      String(assessment.timestamp),
      String(assessment.tradeSize),
    );
    const intendedShares = assessment.tradeSize * 2;

    if (!this.tradingGuard.isTradingEnabled()) {
      return this.buildTradingPausedResult(
        "binary_arb",
        assessment.market,
        assessment.tradeSize,
        assessment.expectedProfitUsd,
        assessment.estimatedSlippageUsd,
        modeOverride,
      );
    }

    this.recordAttempt(intendedShares, assessment.estimatedSlippageUsd);
    this.marketLocks.add(assessment.market.conditionId);

    if (!this.riskManager.reserve(reservationId, assessment.totalSpendUsd)) {
      this.marketLocks.delete(assessment.market.conditionId);
      this.executionsFailed += 1;
      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "binary_arb",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: ["Reservation rejected by max open notional rule."],
      };
    }

    let trackedOrders: TrackedOrder[] = [];
    let responses: Array<Record<string, unknown>> = [];
    let postAttempted = false;

    try {
      if (modeOverride === "backtest" || this.config.dryRun) {
        this.executionsSucceeded += 1;
        this.recordFill(intendedShares, 0);
        return {
          mode: modeOverride ?? "paper",
          success: true,
          strategyType: "binary_arb",
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: assessment.expectedProfitUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd: 0,
          orderIds: [],
          hedgeOrderIds: [],
          hedged: false,
          notes: ["Paper execution only; no order was posted."],
        };
      }

      const client = this.wallet.requireTradingClient();
      const orderType = orderTypeMap[this.config.executionOrderType];
      const negRisk = assessment.market.negRisk ?? false;
      const yesTickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.market.yesTokenId,
        assessment.market.tickSizeHint,
      );
      const noTickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.market.noTokenId,
        assessment.market.tickSizeHint,
      );

      const [yesOrder, noOrder] = await Promise.all([
        client.createOrder(
          {
            tokenID: assessment.market.yesTokenId,
            price: assessment.yes.worstPrice,
            size: assessment.tradeSize,
            side: Side.BUY,
          },
          { tickSize: yesTickSize, negRisk },
        ),
        client.createOrder(
          {
            tokenID: assessment.market.noTokenId,
            price: assessment.no.worstPrice,
            size: assessment.tradeSize,
            side: Side.BUY,
          },
          { tickSize: noTickSize, negRisk },
        ),
      ]);

      trackedOrders = [
        {
          tokenId: assessment.market.yesTokenId,
          expectedSize: assessment.tradeSize,
          expectedAveragePrice: assessment.yes.averagePrice,
          side: "BUY",
        },
        {
          tokenId: assessment.market.noTokenId,
          expectedSize: assessment.tradeSize,
          expectedAveragePrice: assessment.no.averagePrice,
          side: "BUY",
        },
      ];

      postAttempted = true;
      responses = (await client.postOrders([
        { order: yesOrder, orderType },
        { order: noOrder, orderType },
      ])) as Array<Record<string, unknown>>;
      trackedOrders = this.attachOrderIds(trackedOrders, responses);

      const reconciliation = await this.reconcileBinaryExecution(assessment, trackedOrders, responses);
      this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

      if (reconciliation.bothCovered || reconciliation.hedged) {
        return this.buildBinarySuccessResult(assessment, reservationId, reconciliation);
      }

      this.executionsFailed += 1;
      const notes = [...reconciliation.notes];
      if (!reconciliation.fullyFlat) {
        notes.push("Reservation retained due to partial live exposure.");
      }

      return {
        mode: "live",
        success: false,
        strategyType: "binary_arb",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        realizedSlippageUsd: reconciliation.realizedSlippageUsd,
        orderIds: reconciliation.orderIds,
        hedgeOrderIds: reconciliation.hedgeOrderIds,
        hedged: reconciliation.hedged,
        notes: [...notes, "Execution did not fully cover both sides."],
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "binary_execute");
      const notes: string[] = [];
      const recoveredResponses = this.extractRecoveredResponses(error);
      if (recoveredResponses.length > 0) {
        responses = recoveredResponses;
        trackedOrders = this.attachOrderIds(trackedOrders, responses);
      }

      if (postAttempted) {
        if (responses.length > 0 || trackedOrders.some((order) => Boolean(order.orderId))) {
          try {
            const reconciliation = await this.reconcileBinaryExecution(assessment, trackedOrders, responses);
            this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

            this.logger.warn(
              { error, market: assessment.market.slug, orderIds: reconciliation.orderIds },
              "Execution threw after order submission; reconciled live state",
            );

            if (reconciliation.bothCovered || reconciliation.hedged) {
              return this.buildBinarySuccessResult(assessment, reservationId, reconciliation, [
                error instanceof Error ? error.message : "Unknown execution error",
              ]);
            }

            this.executionsFailed += 1;
            notes.push(...reconciliation.notes);
            if (reconciliation.fullyFlat) {
              this.riskManager.release(reservationId);
              notes.push("Post-error reconciliation confirmed no residual exposure; reservation released.");
            } else {
              notes.push("Reservation retained after post-error reconciliation due to possible live exposure.");
            }
            return {
              mode: "live",
              success: false,
              strategyType: "binary_arb",
              market: assessment.market,
              timestamp: Date.now(),
              tradeSize: assessment.tradeSize,
              expectedProfitUsd: assessment.expectedProfitUsd,
              estimatedSlippageUsd: assessment.estimatedSlippageUsd,
              realizedSlippageUsd: reconciliation.realizedSlippageUsd,
              orderIds: reconciliation.orderIds,
              hedgeOrderIds: reconciliation.hedgeOrderIds,
              hedged: reconciliation.hedged,
              notes: [
                error instanceof Error ? error.message : "Unknown execution error",
                ...notes,
                "Execution did not fully cover both sides.",
              ],
            };
          } catch (reconciliationError) {
            notes.push(
              reconciliationError instanceof Error
                ? `Post-error reconciliation failed: ${reconciliationError.message}`
                : "Post-error reconciliation failed.",
            );
            notes.push("Reservation retained until manual reconciliation confirms no live exposure.");
          }
        } else {
          notes.push("Order submission crossed the exchange boundary before failing; reservation retained.");
          notes.push("Manual reconciliation is required because no order IDs were returned.");
        }
      } else {
        this.riskManager.release(reservationId);
      }

      this.executionsFailed += 1;
      this.logger.error({ error, market: assessment.market.slug }, "Execution failed");

      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "binary_arb",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: trackedOrders.map((order) => order.orderId ?? "").filter(Boolean),
        hedgeOrderIds: [],
        hedged: false,
        notes: [error instanceof Error ? error.message : "Unknown execution error", ...notes],
      };
    } finally {
      this.marketLocks.delete(assessment.market.conditionId);
    }
  }

  async executeCeiling(
    assessment: CeilingAssessment,
    modeOverride?: ExecutionMode,
  ): Promise<ExecutionResult> {
    const reservationId = stableId(
      "binary_ceiling",
      assessment.market.conditionId,
      String(assessment.timestamp),
      String(assessment.tradeSize),
    );
    const intendedShares = assessment.tradeSize * 2;

    if (!this.tradingGuard.isTradingEnabled()) {
      return this.buildTradingPausedResult(
        "binary_ceiling",
        assessment.market,
        assessment.tradeSize,
        assessment.expectedProfitUsd,
        assessment.estimatedSlippageUsd,
        modeOverride,
      );
    }

    this.recordAttempt(intendedShares, assessment.estimatedSlippageUsd);
    this.marketLocks.add(assessment.market.conditionId);

    if (!this.riskManager.reserve(reservationId, assessment.collateralRequiredUsd)) {
      this.marketLocks.delete(assessment.market.conditionId);
      this.executionsFailed += 1;
      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "binary_ceiling",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: ["Reservation rejected by max open notional rule."],
      };
    }

    let trackedOrders: TrackedOrder[] = [];
    let responses: Array<Record<string, unknown>> = [];
    let postAttempted = false;
    let splitReceipt: SettlementReceipt | undefined;

    try {
      if (modeOverride === "backtest" || this.config.dryRun) {
        this.executionsSucceeded += 1;
        this.recordFill(intendedShares, 0);
        return {
          mode: modeOverride ?? "paper",
          success: true,
          strategyType: "binary_ceiling",
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: assessment.expectedProfitUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd: 0,
          orderIds: [],
          hedgeOrderIds: [],
          hedged: false,
          notes: ["Paper execution only; no split or orders were posted."],
        };
      }

      splitReceipt = await this.performCeilingSplit(assessment);
      const client = this.wallet.requireTradingClient();
      const orderType = orderTypeMap[this.config.executionOrderType];
      const negRisk = assessment.market.negRisk ?? false;
      const yesTickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.market.yesTokenId,
        assessment.market.tickSizeHint,
      );
      const noTickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.market.noTokenId,
        assessment.market.tickSizeHint,
      );

      const [yesOrder, noOrder] = await Promise.all([
        client.createOrder(
          {
            tokenID: assessment.market.yesTokenId,
            price: assessment.yes.worstPrice,
            size: assessment.tradeSize,
            side: Side.SELL,
          },
          { tickSize: yesTickSize, negRisk },
        ),
        client.createOrder(
          {
            tokenID: assessment.market.noTokenId,
            price: assessment.no.worstPrice,
            size: assessment.tradeSize,
            side: Side.SELL,
          },
          { tickSize: noTickSize, negRisk },
        ),
      ]);

      trackedOrders = [
        {
          tokenId: assessment.market.yesTokenId,
          expectedSize: assessment.tradeSize,
          expectedAveragePrice: assessment.yes.averagePrice,
          side: "SELL",
        },
        {
          tokenId: assessment.market.noTokenId,
          expectedSize: assessment.tradeSize,
          expectedAveragePrice: assessment.no.averagePrice,
          side: "SELL",
        },
      ];

      postAttempted = true;
      responses = (await client.postOrders([
        { order: yesOrder, orderType },
        { order: noOrder, orderType },
      ])) as Array<Record<string, unknown>>;
      trackedOrders = this.attachOrderIds(trackedOrders, responses);

      const reconciliation = await this.reconcileCeilingExecution(assessment, trackedOrders, responses);
      this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

      if (reconciliation.bothCovered || reconciliation.hedged) {
        return this.buildCeilingSuccessResult(assessment, reservationId, reconciliation, splitReceipt);
      }

      this.executionsFailed += 1;
      return {
        mode: "live",
        success: false,
        strategyType: "binary_ceiling",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        realizedSlippageUsd: reconciliation.realizedSlippageUsd,
        orderIds: reconciliation.orderIds,
        hedgeOrderIds: reconciliation.hedgeOrderIds,
        hedged: reconciliation.hedged,
        settlementAction: splitReceipt.action,
        settlementTxHash: splitReceipt.txHash,
        settlementAmount: splitReceipt.amount,
        settlementBlockNumber: splitReceipt.blockNumber,
        notes: [
          `Split full set on-chain via tx ${splitReceipt.txHash}.`,
          ...reconciliation.notes,
          "Ceiling execution did not fully flatten both sides.",
          "Reservation retained due to possible open inventory.",
        ],
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "binary_ceiling_execute");
      const notes: string[] = splitReceipt
        ? [`Split full set on-chain via tx ${splitReceipt.txHash}.`]
        : [];
      const recoveredResponses = this.extractRecoveredResponses(error);
      if (recoveredResponses.length > 0) {
        responses = recoveredResponses;
        trackedOrders = this.attachOrderIds(trackedOrders, responses);
      }

      if (postAttempted) {
        if (responses.length > 0 || trackedOrders.some((order) => Boolean(order.orderId))) {
          try {
            const reconciliation = await this.reconcileCeilingExecution(assessment, trackedOrders, responses);
            this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

            this.logger.warn(
              { error, market: assessment.market.slug, orderIds: reconciliation.orderIds },
              "Ceiling execution threw after order submission; reconciled live state",
            );

            if (reconciliation.bothCovered || reconciliation.hedged) {
              if (!splitReceipt) {
                throw new Error("Ceiling execution recovered after order submission without a split receipt.");
              }
              return this.buildCeilingSuccessResult(
                assessment,
                reservationId,
                reconciliation,
                splitReceipt,
                [error instanceof Error ? error.message : "Unknown execution error"],
              );
            }

            this.executionsFailed += 1;
            notes.push(...reconciliation.notes);
            notes.push("Reservation retained after post-error reconciliation due to possible live inventory.");
            return {
              mode: "live",
              success: false,
              strategyType: "binary_ceiling",
              market: assessment.market,
              timestamp: Date.now(),
              tradeSize: assessment.tradeSize,
              expectedProfitUsd: assessment.expectedProfitUsd,
              estimatedSlippageUsd: assessment.estimatedSlippageUsd,
              realizedSlippageUsd: reconciliation.realizedSlippageUsd,
              orderIds: reconciliation.orderIds,
              hedgeOrderIds: reconciliation.hedgeOrderIds,
              hedged: reconciliation.hedged,
              settlementAction: splitReceipt?.action,
              settlementTxHash: splitReceipt?.txHash,
              settlementAmount: splitReceipt?.amount,
              settlementBlockNumber: splitReceipt?.blockNumber,
              notes: [
                error instanceof Error ? error.message : "Unknown execution error",
                ...notes,
                "Ceiling execution did not fully flatten both sides.",
              ],
            };
          } catch (reconciliationError) {
            notes.push(
              reconciliationError instanceof Error
                ? `Post-error reconciliation failed: ${reconciliationError.message}`
                : "Post-error reconciliation failed.",
            );
            notes.push("Reservation retained until manual reconciliation confirms the split inventory is flat.");
          }
        } else {
          notes.push("Order submission crossed the exchange boundary before failing; reservation retained.");
          notes.push("Manual reconciliation is required because no order IDs were returned.");
        }
      } else if (splitReceipt) {
        notes.push("Split succeeded before order submission failed; reservation retained for the paired inventory.");
      } else {
        this.riskManager.release(reservationId);
      }

      this.executionsFailed += 1;
      this.logger.error({ error, market: assessment.market.slug }, "Ceiling execution failed");

      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "binary_ceiling",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: trackedOrders.map((order) => order.orderId ?? "").filter(Boolean),
        hedgeOrderIds: [],
        hedged: false,
        settlementAction: splitReceipt?.action,
        settlementTxHash: splitReceipt?.txHash,
        settlementAmount: splitReceipt?.amount,
        settlementBlockNumber: splitReceipt?.blockNumber,
        notes: [error instanceof Error ? error.message : "Unknown execution error", ...notes],
      };
    } finally {
      this.marketLocks.delete(assessment.market.conditionId);
    }
  }

  async executeNegRisk(
    assessment: NegRiskAssessment,
    modeOverride?: ExecutionMode,
  ): Promise<ExecutionResult> {
    const reservationId = stableId(
      "neg_risk_arb",
      assessment.groupId,
      assessment.market.conditionId,
      String(assessment.timestamp),
      String(assessment.tradeSize),
    );
    const intendedShares =
      assessment.tradeSize +
      assessment.targetYesLegs.reduce((total, leg) => total + leg.outputSize, 0);

    if (!this.tradingGuard.isTradingEnabled()) {
      return {
        ...this.buildTradingPausedResult(
          "neg_risk_arb",
          assessment.market,
          assessment.tradeSize,
          assessment.expectedProfitUsd,
          assessment.estimatedSlippageUsd,
          modeOverride,
        ),
        groupId: assessment.groupId,
        groupSlug: assessment.groupSlug,
        groupQuestion: assessment.groupQuestion,
      };
    }

    this.recordAttempt(intendedShares, assessment.estimatedSlippageUsd);
    this.marketLocks.add(assessment.groupId);

    if (!this.riskManager.reserve(reservationId, assessment.totalSpendUsd)) {
      this.marketLocks.delete(assessment.groupId);
      this.executionsFailed += 1;
      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "neg_risk_arb",
        market: assessment.market,
        groupId: assessment.groupId,
        groupSlug: assessment.groupSlug,
        groupQuestion: assessment.groupQuestion,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: ["Reservation rejected by max open notional rule."],
      };
    }

    let sourceOrder: TrackedOrder | undefined;
    let sourceResponses: Array<Record<string, unknown>> = [];
    let sourcePostAttempted = false;
    let convertReceipt: SettlementReceipt | undefined;
    let basketOrders: TrackedOrder[] = [];
    let basketResponses: Array<Record<string, unknown>> = [];
    let basketPostAttempted = false;

    try {
      if (modeOverride === "backtest" || this.config.dryRun) {
        this.executionsSucceeded += 1;
        this.recordFill(intendedShares, 0);
        return {
          mode: modeOverride ?? "paper",
          success: true,
          strategyType: "neg_risk_arb",
          market: assessment.market,
          groupId: assessment.groupId,
          groupSlug: assessment.groupSlug,
          groupQuestion: assessment.groupQuestion,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: assessment.expectedProfitUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd: 0,
          orderIds: [],
          hedgeOrderIds: [],
          hedged: false,
          notes: ["Paper execution only; no neg-risk orders were posted."],
        };
      }

      const settlement = this.dependencies.ctfSettlement;
      if (!this.config.autoConvertNegRisk) {
        throw new Error("AUTO_CONVERT_NEG_RISK is disabled; neg-risk arb requires on-chain conversion.");
      }

      if (!settlement?.canConvertNegRisk()) {
        throw new Error("Neg-risk conversion is unavailable; configure the adapter and on-chain signer.");
      }

      const client = this.wallet.requireTradingClient();
      const orderType = orderTypeMap[this.config.executionOrderType];
      const sourceTickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.sourceNo.tokenId,
        assessment.market.tickSizeHint,
      );
      const sourceOrderPayload = await client.createOrder(
        {
          tokenID: assessment.sourceNo.tokenId,
          price: assessment.sourceNo.worstPrice,
          size: assessment.tradeSize,
          side: Side.BUY,
        },
        { tickSize: sourceTickSize, negRisk: true },
      );

      sourceOrder = {
        conditionId: assessment.market.conditionId,
        tokenId: assessment.sourceNo.tokenId,
        expectedSize: assessment.tradeSize,
        expectedAveragePrice: assessment.sourceNo.averagePrice,
        side: "BUY",
      };

      sourcePostAttempted = true;
      sourceResponses = (await client.postOrders([{ order: sourceOrderPayload, orderType }])) as Array<Record<string, unknown>>;
      [sourceOrder] = this.attachOrderIds([sourceOrder], sourceResponses);
      if (!sourceOrder) {
        throw new Error("Unable to track neg-risk source order after submission.");
      }

      const sourceReconciliation = await this.reconcileSingleOrderExecution(
        sourceOrder,
        sourceResponses,
        assessment.tradeSize,
      );
      this.recordFill(sourceReconciliation.matchedShares, sourceReconciliation.realizedSlippageUsd);

      if (!sourceReconciliation.fullyFilled) {
        return this.failNegRiskAfterSourceFill(
          assessment,
          reservationId,
          sourceReconciliation,
          sourceReconciliation.snapshot.matchedSize,
        );
      }

      convertReceipt = await settlement.convertNegRiskPosition(
        assessment.market.conditionId,
        assessment.negRiskMarketId,
        assessment.sourceOutcomeIndex,
        assessment.tradeSize,
      );

      const signedBasketOrders = await Promise.all(
        assessment.targetYesLegs.map(async (leg) => {
          const tickSize = this.resolveTickSize(
            leg.market.conditionId,
            leg.tokenId,
            leg.market.tickSizeHint,
          );
          const order = await client.createOrder(
            {
              tokenID: leg.tokenId,
              price: leg.worstPrice,
              size: leg.outputSize,
              side: Side.SELL,
            },
            { tickSize, negRisk: true },
          );

          return {
            conditionId: leg.market.conditionId,
            tokenId: leg.tokenId,
            expectedSize: leg.outputSize,
            expectedAveragePrice: leg.averagePrice,
            side: "SELL" as const,
            order,
          };
        }),
      );
      basketOrders = signedBasketOrders.map((entry) => ({
        conditionId: entry.conditionId,
        tokenId: entry.tokenId,
        expectedSize: entry.expectedSize,
        expectedAveragePrice: entry.expectedAveragePrice,
        side: entry.side,
      }));

      basketPostAttempted = true;
      basketResponses = await this.postSignedOrdersInBatches(
        client,
        signedBasketOrders.map((entry) => entry.order),
        orderType,
      );
      basketOrders = this.attachOrderIds(basketOrders, basketResponses);

      const basketReconciliation = await this.reconcileNegRiskExecution(
        assessment,
        basketOrders,
        basketResponses,
      );
      this.recordFill(basketReconciliation.matchedShares, basketReconciliation.realizedSlippageUsd);

      if (basketReconciliation.fullyCovered || basketReconciliation.hedged) {
        return this.buildNegRiskSuccessResult(
          assessment,
          reservationId,
          sourceReconciliation,
          basketReconciliation,
          convertReceipt,
        );
      }

      this.executionsFailed += 1;
      return {
        mode: "live",
        success: false,
        strategyType: "neg_risk_arb",
        market: assessment.market,
        groupId: assessment.groupId,
        groupSlug: assessment.groupSlug,
        groupQuestion: assessment.groupQuestion,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        realizedSlippageUsd:
          sourceReconciliation.realizedSlippageUsd + basketReconciliation.realizedSlippageUsd,
        orderIds: [
          ...sourceReconciliation.orderIds,
          ...basketReconciliation.orderIds,
        ],
        hedgeOrderIds: basketReconciliation.hedgeOrderIds,
        hedged: basketReconciliation.hedged,
        settlementAction: convertReceipt.action,
        settlementTxHash: convertReceipt.txHash,
        settlementAmount: convertReceipt.amount,
        settlementBlockNumber: convertReceipt.blockNumber,
        notes: [
          `Converted neg-risk basket on-chain via tx ${convertReceipt.txHash}.`,
          ...basketReconciliation.notes,
          "Neg-risk basket did not fully flatten converted YES inventory.",
          "Reservation retained due to possible residual exposure.",
        ],
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "neg_risk_execute");
      const notes: string[] = convertReceipt
        ? [`Converted neg-risk basket on-chain via tx ${convertReceipt.txHash}.`]
        : [];

      const recoveredSourceResponses = this.extractRecoveredResponses(error);
      if (recoveredSourceResponses.length > 0 && sourceResponses.length === 0) {
        sourceResponses = recoveredSourceResponses;
        if (sourceOrder) {
          [sourceOrder] = this.attachOrderIds([sourceOrder], sourceResponses);
        }
      }

      if (!convertReceipt && sourcePostAttempted && (sourceOrder?.orderId || sourceResponses.length > 0)) {
        try {
          const sourceReconciliation = await this.reconcileSingleOrderExecution(
            sourceOrder ?? {
              conditionId: assessment.market.conditionId,
              tokenId: assessment.sourceNo.tokenId,
              expectedSize: assessment.tradeSize,
              expectedAveragePrice: assessment.sourceNo.averagePrice,
              side: "BUY",
            },
            sourceResponses,
            assessment.tradeSize,
          );
          this.recordFill(sourceReconciliation.matchedShares, sourceReconciliation.realizedSlippageUsd);

          if (sourceReconciliation.snapshot.matchedSize > EXECUTION_EPSILON) {
            const unwind = await this.flattenTokenInventory(
              assessment.market.conditionId,
              assessment.sourceNo.tokenId,
              sourceReconciliation.snapshot.matchedSize,
              "source NO",
            );
            notes.push(...unwind.notes);
            if (unwind.hedged && !sourceReconciliation.hasOpenOrders) {
              this.riskManager.release(reservationId);
              notes.push("Reservation released after source NO unwind.");
            }
          } else if (sourceReconciliation.fullyFlat) {
            this.riskManager.release(reservationId);
            notes.push("Reservation released after failed neg-risk source order left no exposure.");
          }
        } catch (reconciliationError) {
          notes.push(
            reconciliationError instanceof Error
              ? `Post-error source reconciliation failed: ${reconciliationError.message}`
              : "Post-error source reconciliation failed.",
          );
          notes.push("Reservation retained until manual reconciliation confirms no live exposure.");
        }
      }

      const recoveredBasketResponses = this.extractRecoveredResponses(error);
      if (recoveredBasketResponses.length > 0 && basketResponses.length === 0) {
        basketResponses = recoveredBasketResponses;
        basketOrders = this.attachOrderIds(basketOrders, basketResponses);
      }

      if (convertReceipt && basketPostAttempted && (basketOrders.some((order) => Boolean(order.orderId)) || basketResponses.length > 0)) {
        try {
          const basketReconciliation = await this.reconcileNegRiskExecution(
            assessment,
            basketOrders,
            basketResponses,
          );
          this.recordFill(basketReconciliation.matchedShares, basketReconciliation.realizedSlippageUsd);

          if (basketReconciliation.fullyCovered || basketReconciliation.hedged) {
            return this.buildNegRiskSuccessResult(
              assessment,
              reservationId,
              {
                orderIds: sourceOrder?.orderId ? [sourceOrder.orderId] : [],
                matchedShares: assessment.tradeSize,
                realizedSlippageUsd: 0,
                notes: [],
                snapshot: this.buildFallbackSnapshot(
                  sourceOrder?.orderId,
                  assessment.tradeSize,
                  assessment.sourceNo.tokenId,
                  "BUY",
                ),
                fullyFilled: true,
                hasOpenOrders: false,
                fullyFlat: false,
              },
              basketReconciliation,
              convertReceipt,
              [error instanceof Error ? error.message : "Unknown execution error"],
            );
          }
        } catch (reconciliationError) {
          notes.push(
            reconciliationError instanceof Error
              ? `Post-error basket reconciliation failed: ${reconciliationError.message}`
              : "Post-error basket reconciliation failed.",
          );
        }
      }

      this.executionsFailed += 1;
      this.logger.error({ error, group: assessment.groupSlug }, "Neg-risk execution failed");

      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "neg_risk_arb",
        market: assessment.market,
        groupId: assessment.groupId,
        groupSlug: assessment.groupSlug,
        groupQuestion: assessment.groupQuestion,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: [
          ...(sourceOrder?.orderId ? [sourceOrder.orderId] : []),
          ...basketOrders.map((order) => order.orderId ?? "").filter(Boolean),
        ],
        hedgeOrderIds: [],
        hedged: false,
        settlementAction: convertReceipt?.action,
        settlementTxHash: convertReceipt?.txHash,
        settlementAmount: convertReceipt?.amount,
        settlementBlockNumber: convertReceipt?.blockNumber,
        notes: [error instanceof Error ? error.message : "Unknown execution error", ...notes],
      };
    } finally {
      this.marketLocks.delete(assessment.groupId);
    }
  }

  async executeLateResolution(
    assessment: LateResolutionAssessment,
    modeOverride?: ExecutionMode,
  ): Promise<ExecutionResult> {
    const reservationId = stableId(
      "late_resolution",
      assessment.market.conditionId,
      String(assessment.timestamp),
      String(assessment.tradeSize),
      assessment.resolvedOutcome,
    );
    const intendedShares = assessment.tradeSize;

    if (!this.tradingGuard.isTradingEnabled()) {
      return this.buildTradingPausedResult(
        "late_resolution",
        assessment.market,
        assessment.tradeSize,
        assessment.expectedProfitUsd,
        assessment.estimatedSlippageUsd,
        modeOverride,
        assessment.resolvedOutcome,
      );
    }

    this.recordAttempt(intendedShares, assessment.estimatedSlippageUsd);
    this.marketLocks.add(assessment.market.conditionId);

    if (!this.riskManager.reserve(reservationId, assessment.totalSpendUsd)) {
      this.marketLocks.delete(assessment.market.conditionId);
      this.executionsFailed += 1;
      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "late_resolution",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        resolvedOutcome: assessment.resolvedOutcome,
        notes: ["Reservation rejected by max open notional rule."],
      };
    }

    let trackedOrder: TrackedOrder | undefined;
    let responses: Array<Record<string, unknown>> = [];
    let postAttempted = false;

    try {
      if (modeOverride === "backtest" || this.config.dryRun) {
        this.executionsSucceeded += 1;
        this.recordFill(intendedShares, 0);
        return {
          mode: modeOverride ?? "paper",
          success: true,
          strategyType: "late_resolution",
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: assessment.expectedProfitUsd,
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd: 0,
          orderIds: [],
          hedgeOrderIds: [],
          hedged: false,
          resolvedOutcome: assessment.resolvedOutcome,
          notes: ["Paper execution only; no order was posted."],
        };
      }

      const client = this.wallet.requireTradingClient();
      const orderType = orderTypeMap[this.config.executionOrderType];
      const negRisk = assessment.market.negRisk ?? false;
      const tickSize = this.resolveTickSize(
        assessment.market.conditionId,
        assessment.leg.tokenId,
        assessment.market.tickSizeHint,
      );

      const order = await client.createOrder(
        {
          tokenID: assessment.leg.tokenId,
          price: assessment.leg.worstPrice,
          size: assessment.tradeSize,
          side: Side.BUY,
          },
        { tickSize, negRisk },
      );

      trackedOrder = {
        tokenId: assessment.leg.tokenId,
        expectedSize: assessment.tradeSize,
        expectedAveragePrice: assessment.leg.averagePrice,
        side: "BUY",
      };

      postAttempted = true;
      responses = (await client.postOrders([{ order, orderType }])) as Array<Record<string, unknown>>;
      [trackedOrder] = this.attachOrderIds([trackedOrder], responses);
      if (!trackedOrder) {
        throw new Error("Unable to track late-resolution order after submission.");
      }

      const reconciliation = await this.reconcileSingleOrderExecution(
        trackedOrder,
        responses,
        assessment.tradeSize,
      );
      this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

      if (reconciliation.fullyFilled) {
        return this.buildLateResolutionSuccessResult(assessment, reservationId, reconciliation);
      }

      this.executionsFailed += 1;
      const notes = [...reconciliation.notes];
      if (reconciliation.fullyFlat) {
        this.riskManager.release(reservationId);
        notes.push("Live reconciliation confirmed no residual exposure; reservation released.");
      }
      return {
        mode: "live",
        success: false,
        strategyType: "late_resolution",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        realizedSlippageUsd: reconciliation.realizedSlippageUsd,
        orderIds: reconciliation.orderIds,
        hedgeOrderIds: [],
        hedged: false,
        resolvedOutcome: assessment.resolvedOutcome,
        notes: reconciliation.fullyFlat
          ? [...notes, "Late-resolution order did not fully fill."]
          : [...notes, "Late-resolution order partially filled; reservation retained for open exposure."],
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "late_resolution_execute");
      const notes: string[] = [];
      const recoveredResponses = this.extractRecoveredResponses(error);
      if (recoveredResponses.length > 0) {
        responses = recoveredResponses;
        if (trackedOrder) {
          [trackedOrder] = this.attachOrderIds([trackedOrder], responses);
        }
      }

      if (postAttempted) {
        if (trackedOrder?.orderId || responses.length > 0) {
          try {
            const reconciliation = await this.reconcileSingleOrderExecution(
              trackedOrder ?? {
                tokenId: assessment.leg.tokenId,
                expectedSize: assessment.tradeSize,
                expectedAveragePrice: assessment.leg.averagePrice,
                side: "BUY",
              },
              responses,
              assessment.tradeSize,
            );
            this.recordFill(reconciliation.matchedShares, reconciliation.realizedSlippageUsd);

            this.logger.warn(
              {
                error,
                market: assessment.market.slug,
                orderIds: reconciliation.orderIds,
              },
              "Late-resolution execution threw after order submission; reconciled live state",
            );

            if (reconciliation.fullyFilled) {
              return this.buildLateResolutionSuccessResult(assessment, reservationId, reconciliation, [
                error instanceof Error ? error.message : "Unknown execution error",
              ]);
            }

            this.executionsFailed += 1;
            notes.push(...reconciliation.notes);
            if (reconciliation.fullyFlat) {
              this.riskManager.release(reservationId);
              notes.push("Post-error reconciliation confirmed no residual exposure; reservation released.");
            } else {
              notes.push("Reservation retained after post-error reconciliation due to possible live exposure.");
            }
            return {
              mode: "live",
              success: false,
              strategyType: "late_resolution",
              market: assessment.market,
              timestamp: Date.now(),
              tradeSize: assessment.tradeSize,
              expectedProfitUsd: assessment.expectedProfitUsd,
              estimatedSlippageUsd: assessment.estimatedSlippageUsd,
              realizedSlippageUsd: reconciliation.realizedSlippageUsd,
              orderIds: reconciliation.orderIds,
              hedgeOrderIds: [],
              hedged: false,
              resolvedOutcome: assessment.resolvedOutcome,
              notes: [
                error instanceof Error ? error.message : "Unknown execution error",
                ...notes,
                "Late-resolution order did not fully fill.",
              ],
            };
          } catch (reconciliationError) {
            notes.push(
              reconciliationError instanceof Error
                ? `Post-error reconciliation failed: ${reconciliationError.message}`
                : "Post-error reconciliation failed.",
            );
            notes.push("Reservation retained until manual reconciliation confirms no live exposure.");
          }
        } else {
          notes.push("Order submission crossed the exchange boundary before failing; reservation retained.");
          notes.push("Manual reconciliation is required because no order IDs were returned.");
        }
      } else {
        this.riskManager.release(reservationId);
      }

      this.executionsFailed += 1;
      this.logger.error({ error, market: assessment.market.slug }, "Late-resolution execution failed");

      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        strategyType: "late_resolution",
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        estimatedSlippageUsd: assessment.estimatedSlippageUsd,
        orderIds: trackedOrder?.orderId ? [trackedOrder.orderId] : [],
        hedgeOrderIds: [],
        hedged: false,
        resolvedOutcome: assessment.resolvedOutcome,
        notes: [error instanceof Error ? error.message : "Unknown execution error", ...notes],
      };
    } finally {
      this.marketLocks.delete(assessment.market.conditionId);
    }
  }

  private async pollOrderSnapshots(
    orders: TrackedOrder[],
    responses: Array<Record<string, unknown>>,
  ): Promise<OrderStatusSnapshot[]> {
    const client = this.wallet.requireTradingClient();
    const deadline = Date.now() + this.config.executionTimeoutMs;
    let snapshots = orders.map((order, index) =>
      this.buildFallbackSnapshot(order.orderId, order.expectedSize, order.tokenId, order.side, responses[index]),
    );

    while (Date.now() < deadline) {
      snapshots = await Promise.all(
        orders.map(async (order, index) => {
          if (!order.orderId) {
            return this.buildFallbackSnapshot(undefined, order.expectedSize, order.tokenId, order.side, responses[index]);
          }

          try {
            const payload = (await client.getOrder(order.orderId)) as unknown as Record<string, unknown>;
            const matchedSize = Number(payload.size_matched ?? payload.sizeMatched ?? 0);

            return {
              orderId: order.orderId,
              status: String(payload.status ?? payload.type ?? responses[index]?.status ?? "unknown"),
              originalSize: Number(payload.original_size ?? payload.originalSize ?? order.expectedSize),
              matchedSize,
              remainingSize: Number(
                payload.size_left ?? payload.sizeLeft ?? order.expectedSize - matchedSize,
              ),
              side: String(payload.side ?? order.side) === "SELL" ? "SELL" : "BUY",
              tokenId: String(payload.asset_id ?? payload.assetId ?? order.tokenId),
              associateTradeIds: Array.isArray(payload.associate_trades)
                ? payload.associate_trades.map((tradeId) => String(tradeId)).filter(Boolean)
                : [],
            } satisfies OrderStatusSnapshot;
          } catch (error) {
            this.tradingGuard.handleError(error, "poll_order_snapshots");
            return this.buildFallbackSnapshot(order.orderId, order.expectedSize, order.tokenId, order.side, responses[index]);
          }
        }),
      );

      const allStable = snapshots.every(
        (snapshot) =>
          snapshot.status.toLowerCase() === "matched" ||
          snapshot.remainingSize <= 0 ||
          snapshot.status.toLowerCase() === "cancelled" ||
          snapshot.status.toLowerCase() === "canceled",
      );

      if (allStable) {
        break;
      }

      await sleep(this.config.pollingIntervalMs);
    }

    return Promise.all(
      snapshots.map((snapshot, index) =>
        this.enrichSnapshotWithTrades(snapshot, orders[index]?.expectedAveragePrice ?? 0),
      ),
    );
  }

  private buildFallbackSnapshot(
    orderId: string | undefined,
    expectedSize: number,
    tokenId: string,
    side: "BUY" | "SELL",
    response?: Record<string, unknown>,
  ): OrderStatusSnapshot {
    const status = String(response?.status ?? "unknown").toLowerCase();
    const matchedSize = status === "matched" ? expectedSize : 0;

    return {
      orderId: orderId ?? "",
      status,
      originalSize: expectedSize,
      matchedSize,
      remainingSize: Math.max(0, expectedSize - matchedSize),
      side,
      tokenId,
      associateTradeIds: [],
    };
  }

  private attachOrderIds(
    orders: TrackedOrder[],
    responses: Array<Record<string, unknown>>,
  ): TrackedOrder[] {
    return orders.map((order, index) => ({
      ...order,
      orderId: order.orderId ?? String(responses[index]?.orderID ?? ""),
    }));
  }

  private async postSignedOrdersInBatches(
    client: ReturnType<WalletService["requireTradingClient"]>,
    orders: unknown[],
    orderType: OrderType,
  ): Promise<Array<Record<string, unknown>>> {
    const responses: Array<Record<string, unknown>> = [];

    for (let index = 0; index < orders.length; index += 15) {
      const batch = orders.slice(index, index + 15).map((order) => ({ order, orderType }));
      const batchResponses = (await client.postOrders(batch as never)) as Array<Record<string, unknown>>;
      responses.push(...batchResponses);
    }

    return responses;
  }

  private extractRecoveredResponses(error: unknown): Array<Record<string, unknown>> {
    if (
      typeof error === "object" &&
      error !== null &&
      "responses" in error &&
      Array.isArray((error as { responses?: unknown }).responses)
    ) {
      return (error as { responses: Array<Record<string, unknown>> }).responses;
    }

    return [];
  }

  private isTerminalSnapshot(snapshot: OrderStatusSnapshot): boolean {
    const status = snapshot.status.toLowerCase();
    return (
      status === "matched" ||
      status === "filled" ||
      status === "cancelled" ||
      status === "canceled" ||
      snapshot.remainingSize <= 0
    );
  }

  private async reconcileBinaryExecution(
    assessment: RiskAssessment,
    orders: TrackedOrder[],
    responses: Array<Record<string, unknown>>,
  ): Promise<BinaryReconciliation> {
    const snapshots = await this.pollOrderSnapshots(orders, responses);
    const yesSnapshot =
      snapshots[0] ??
      this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.yesTokenId, "BUY");
    const noSnapshot =
      snapshots[1] ??
      this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.noTokenId, "BUY");
    const notes: string[] = [];
    let hedgeOrderIds: string[] = [];
    let hedged = false;

    const imbalance = yesSnapshot.matchedSize - noSnapshot.matchedSize;
    if (Math.abs(imbalance) > EXECUTION_EPSILON) {
      const hedgeResult = await this.flattenImbalance(assessment, imbalance);
      hedged = hedgeResult.hedged;
      hedgeOrderIds = hedgeResult.hedgeOrderIds;
      notes.push(...hedgeResult.notes);
    }

    const matchedShares = yesSnapshot.matchedSize + noSnapshot.matchedSize;
    const realizedSlippageUsd =
      (yesSnapshot.realizedSlippageUsd ?? 0) + (noSnapshot.realizedSlippageUsd ?? 0);
    const bothCovered =
      yesSnapshot.matchedSize >= assessment.tradeSize - EXECUTION_EPSILON &&
      noSnapshot.matchedSize >= assessment.tradeSize - EXECUTION_EPSILON;
    const pairedMatchedSize = Math.min(yesSnapshot.matchedSize, noSnapshot.matchedSize);
    const hasOpenOrders = [yesSnapshot, noSnapshot].some(
      (snapshot) => !this.isTerminalSnapshot(snapshot),
    );
    const fullyFlat =
      !hasOpenOrders &&
      pairedMatchedSize <= EXECUTION_EPSILON &&
      (Math.abs(imbalance) <= EXECUTION_EPSILON || hedged);

    return {
      orderIds: orders.map((order) => order.orderId ?? "").filter(Boolean),
      hedgeOrderIds,
      hedged,
      notes,
      matchedShares,
      realizedSlippageUsd,
      yesSnapshot,
      noSnapshot,
      bothCovered,
      pairedMatchedSize,
      hasOpenOrders,
      fullyFlat,
    };
  }

  private async reconcileCeilingExecution(
    assessment: CeilingAssessment,
    orders: TrackedOrder[],
    responses: Array<Record<string, unknown>>,
  ): Promise<BinaryReconciliation> {
    const snapshots = await this.pollOrderSnapshots(orders, responses);
    const yesSnapshot =
      snapshots[0] ??
      this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.yesTokenId, "SELL");
    const noSnapshot =
      snapshots[1] ??
      this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.noTokenId, "SELL");
    const notes: string[] = [];
    let hedgeOrderIds: string[] = [];
    let hedged = false;

    const imbalance = yesSnapshot.matchedSize - noSnapshot.matchedSize;
    if (Math.abs(imbalance) > EXECUTION_EPSILON) {
      const hedgeResult = await this.flattenCeilingImbalance(assessment, imbalance);
      hedged = hedgeResult.hedged;
      hedgeOrderIds = hedgeResult.hedgeOrderIds;
      notes.push(...hedgeResult.notes);
    }

    const matchedShares = yesSnapshot.matchedSize + noSnapshot.matchedSize;
    const realizedSlippageUsd =
      (yesSnapshot.realizedSlippageUsd ?? 0) + (noSnapshot.realizedSlippageUsd ?? 0);
    const bothCovered =
      yesSnapshot.matchedSize >= assessment.tradeSize - EXECUTION_EPSILON &&
      noSnapshot.matchedSize >= assessment.tradeSize - EXECUTION_EPSILON;
    const pairedMatchedSize = Math.min(yesSnapshot.matchedSize, noSnapshot.matchedSize);
    const hasOpenOrders = [yesSnapshot, noSnapshot].some(
      (snapshot) => !this.isTerminalSnapshot(snapshot),
    );
    const fullyFlat =
      !hasOpenOrders &&
      (bothCovered || Math.abs(imbalance) <= EXECUTION_EPSILON || hedged);

    return {
      orderIds: orders.map((order) => order.orderId ?? "").filter(Boolean),
      hedgeOrderIds,
      hedged,
      notes,
      matchedShares,
      realizedSlippageUsd,
      yesSnapshot,
      noSnapshot,
      bothCovered,
      pairedMatchedSize,
      hasOpenOrders,
      fullyFlat,
    };
  }

  private async reconcileNegRiskExecution(
    assessment: NegRiskAssessment,
    orders: TrackedOrder[],
    responses: Array<Record<string, unknown>>,
  ): Promise<BasketReconciliation> {
    const snapshots = await this.pollOrderSnapshots(orders, responses);
    const notes: string[] = [];
    let hedgeOrderIds: string[] = [];
    let hedged = false;

    const residuals = snapshots
      .map((snapshot, index) => ({
        snapshot,
        order: orders[index],
        remainingSize: Math.max(0, (orders[index]?.expectedSize ?? 0) - snapshot.matchedSize),
      }))
      .filter((entry) => entry.remainingSize > EXECUTION_EPSILON && entry.order);

    if (residuals.length > 0) {
      const hedgeResults = await Promise.all(
        residuals.map((entry) =>
          this.flattenTokenInventory(
            entry.order!.conditionId ?? assessment.market.conditionId,
            entry.order!.tokenId,
            entry.remainingSize,
            `converted YES leg ${entry.order!.tokenId}`,
          ),
        ),
      );

      hedgeOrderIds = hedgeResults.flatMap((result) => result.hedgeOrderIds);
      notes.push(...hedgeResults.flatMap((result) => result.notes));
      hedged = hedgeResults.every((result) => result.hedged);
    }

    const matchedShares = sum(snapshots.map((snapshot) => snapshot.matchedSize));
    const realizedSlippageUsd = sum(
      snapshots.map((snapshot) => snapshot.realizedSlippageUsd ?? 0),
    );
    const fullyCovered = snapshots.every(
      (snapshot, index) =>
        snapshot.matchedSize >= (orders[index]?.expectedSize ?? 0) - EXECUTION_EPSILON,
    );
    const hasOpenOrders = snapshots.some((snapshot) => !this.isTerminalSnapshot(snapshot));
    const fullyFlat = !hasOpenOrders && (fullyCovered || hedged);

    return {
      orderIds: orders.map((order) => order.orderId ?? "").filter(Boolean),
      hedgeOrderIds,
      hedged,
      notes,
      matchedShares,
      realizedSlippageUsd,
      snapshots,
      fullyCovered,
      hasOpenOrders,
      fullyFlat,
    };
  }

  private async reconcileSingleOrderExecution(
    order: TrackedOrder,
    responses: Array<Record<string, unknown>>,
    expectedSize: number,
  ): Promise<SingleOrderReconciliation> {
    const [snapshot] = await this.pollOrderSnapshots([order], responses);
    const finalSnapshot =
      snapshot ?? this.buildFallbackSnapshot(order.orderId, expectedSize, order.tokenId, order.side);
    const matchedShares = finalSnapshot.matchedSize;
    const realizedSlippageUsd = finalSnapshot.realizedSlippageUsd ?? 0;
    const hasOpenOrders = !this.isTerminalSnapshot(finalSnapshot);
    const fullyFilled = matchedShares >= expectedSize - EXECUTION_EPSILON;
    const fullyFlat = !hasOpenOrders && matchedShares <= EXECUTION_EPSILON;

    return {
      orderIds: [order.orderId ?? ""].filter(Boolean),
      matchedShares,
      realizedSlippageUsd,
      notes: [],
      snapshot: finalSnapshot,
      fullyFilled,
      hasOpenOrders,
      fullyFlat,
    };
  }

  private async enrichSnapshotWithTrades(
    snapshot: OrderStatusSnapshot,
    expectedAveragePrice: number,
  ): Promise<OrderStatusSnapshot> {
    if (!snapshot.associateTradeIds?.length || snapshot.matchedSize <= 0) {
      return snapshot;
    }

    try {
      const client = this.wallet.requireTradingClient();
      const trades = (
        await Promise.all(
          snapshot.associateTradeIds.map((tradeId) => client.getTrades({ id: tradeId }, true)),
        )
      ).flat();
      const relevantTrades = trades.filter((trade) => String(trade.asset_id) === snapshot.tokenId);
      const totalFilledSize = sum(relevantTrades.map((trade) => Number(trade.size ?? 0)));

      if (totalFilledSize <= 0) {
        return snapshot;
      }

      const totalFilledCost = sum(
        relevantTrades.map((trade) => Number(trade.size ?? 0) * Number(trade.price ?? 0)),
      );
      const averageFillPrice = totalFilledCost / totalFilledSize;
      const slippagePerShare =
        snapshot.side === "SELL"
          ? expectedAveragePrice - averageFillPrice
          : averageFillPrice - expectedAveragePrice;

      return {
        ...snapshot,
        averageFillPrice: round(averageFillPrice, 6),
        realizedSlippageUsd: round(slippagePerShare * totalFilledSize, 6),
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "enrich_snapshot_trades");
      this.logger.debug({ error, orderId: snapshot.orderId }, "Unable to enrich snapshot with trade history");
      return snapshot;
    }
  }

  private async buildBinarySuccessResult(
    assessment: RiskAssessment,
    reservationId: string,
    reconciliation: BinaryReconciliation,
    baseNotes: string[] = [],
  ): Promise<ExecutionResult> {
    const notes = [...baseNotes, ...reconciliation.notes];
    let settlement: SettlementReceipt | undefined;
    let portfolioReconciliation: PortfolioReconciliationResult | undefined;

    if (reconciliation.fullyFlat) {
      this.riskManager.release(reservationId);
      notes.push("Live reconciliation confirmed no residual exposure; reservation released.");
    } else if (reconciliation.bothCovered) {
      const postFill = await this.handleBinaryPostFill(assessment);
      settlement = postFill.settlement;
      portfolioReconciliation = postFill.reconciliation;
      notes.push(...postFill.notes);

      if (postFill.releaseReservation) {
        this.riskManager.release(reservationId);
        notes.push("Reservation released after confirmed CTF settlement.");
      }
    }

    this.executionsSucceeded += 1;
    return {
      mode: "live",
      success: true,
      strategyType: "binary_arb",
      market: assessment.market,
      timestamp: Date.now(),
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      realizedProfitUsd:
        reconciliation.bothCovered || reconciliation.pairedMatchedSize > EXECUTION_EPSILON
          ? this.calculateRealizedProfit(
              assessment.grossEdgeUsd,
              assessment.totalFeesUsd,
              assessment.gasUsd,
              assessment.estimatedSlippageUsd,
              reconciliation.realizedSlippageUsd,
            )
          : undefined,
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      realizedSlippageUsd: reconciliation.realizedSlippageUsd,
      orderIds: reconciliation.orderIds,
      hedgeOrderIds: reconciliation.hedgeOrderIds,
      hedged: reconciliation.hedged,
      notes,
      settlementAction: settlement?.action,
      settlementTxHash: settlement?.txHash,
      settlementAmount: settlement?.amount,
      settlementBlockNumber: settlement?.blockNumber,
      reconciledAt: portfolioReconciliation?.reconciledAt,
      reconciliationSatisfied: portfolioReconciliation?.satisfied,
      reconciledPortfolioValueUsd: portfolioReconciliation?.totalValueUsd,
      reconciledPositionCount: portfolioReconciliation?.positions.length,
    };
  }

  private async buildCeilingSuccessResult(
    assessment: CeilingAssessment,
    reservationId: string,
    reconciliation: BinaryReconciliation,
    splitReceipt: SettlementReceipt,
    baseNotes: string[] = [],
  ): Promise<ExecutionResult> {
    const notes = [
      ...baseNotes,
      `Split full set on-chain via tx ${splitReceipt.txHash}.`,
      ...reconciliation.notes,
    ];
    const portfolioReconciliation = await this.reconcilePortfolio(
      assessment.market.conditionId,
      "flat",
    );
    notes.push(...portfolioReconciliation.notes);
    this.riskManager.release(reservationId);
    notes.push("Reservation released after ceiling arb completed.");

    this.executionsSucceeded += 1;
    return {
      mode: "live",
      success: true,
      strategyType: "binary_ceiling",
      market: assessment.market,
      timestamp: Date.now(),
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      realizedProfitUsd: this.calculateRealizedProfit(
        assessment.grossEdgeUsd,
        assessment.totalFeesUsd,
        assessment.gasUsd,
        assessment.estimatedSlippageUsd,
        reconciliation.realizedSlippageUsd,
      ),
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      realizedSlippageUsd: reconciliation.realizedSlippageUsd,
      orderIds: reconciliation.orderIds,
      hedgeOrderIds: reconciliation.hedgeOrderIds,
      hedged: reconciliation.hedged,
      notes,
      settlementAction: splitReceipt.action,
      settlementTxHash: splitReceipt.txHash,
      settlementAmount: splitReceipt.amount,
      settlementBlockNumber: splitReceipt.blockNumber,
      reconciledAt: portfolioReconciliation.reconciliation?.reconciledAt,
      reconciliationSatisfied: portfolioReconciliation.reconciliation?.satisfied,
      reconciledPortfolioValueUsd: portfolioReconciliation.reconciliation?.totalValueUsd,
      reconciledPositionCount: portfolioReconciliation.reconciliation?.positions.length,
    };
  }

  private async buildLateResolutionSuccessResult(
    assessment: LateResolutionAssessment,
    reservationId: string,
    reconciliation: SingleOrderReconciliation,
    baseNotes: string[] = [],
  ): Promise<ExecutionResult> {
    const notes = [...baseNotes, ...reconciliation.notes];
    if (reconciliation.fullyFlat) {
      this.riskManager.release(reservationId);
      notes.push("Live reconciliation confirmed no residual exposure; reservation released.");
    } else {
      notes.push("Reservation retained while the resolved-side inventory remains open.");
    }

    const portfolioReconciliation = await this.reconcilePortfolio(
      assessment.market.conditionId,
      "snapshot",
    );
    notes.push(...portfolioReconciliation.notes);

    this.executionsSucceeded += 1;
    return {
      mode: "live",
      success: true,
      strategyType: "late_resolution",
      market: assessment.market,
      timestamp: Date.now(),
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      realizedProfitUsd: this.calculateRealizedProfit(
        assessment.grossEdgeUsd,
        assessment.totalFeesUsd,
        assessment.gasUsd,
        assessment.estimatedSlippageUsd,
        reconciliation.realizedSlippageUsd,
      ),
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      realizedSlippageUsd: reconciliation.realizedSlippageUsd,
      orderIds: reconciliation.orderIds,
      hedgeOrderIds: [],
      hedged: false,
      resolvedOutcome: assessment.resolvedOutcome,
      notes,
      reconciledAt: portfolioReconciliation.reconciliation?.reconciledAt,
      reconciliationSatisfied: portfolioReconciliation.reconciliation?.satisfied,
      reconciledPortfolioValueUsd: portfolioReconciliation.reconciliation?.totalValueUsd,
      reconciledPositionCount: portfolioReconciliation.reconciliation?.positions.length,
    };
  }

  private async buildNegRiskSuccessResult(
    assessment: NegRiskAssessment,
    reservationId: string,
    sourceReconciliation: SingleOrderReconciliation,
    basketReconciliation: BasketReconciliation,
    convertReceipt: SettlementReceipt,
    baseNotes: string[] = [],
  ): Promise<ExecutionResult> {
    const notes = [
      ...baseNotes,
      `Converted neg-risk basket on-chain via tx ${convertReceipt.txHash}.`,
      ...basketReconciliation.notes,
    ];
    const portfolioReconciliation = await this.reconcilePortfolio(
      assessment.market.conditionId,
      "flat",
    );
    notes.push(...portfolioReconciliation.notes);
    this.riskManager.release(reservationId);
    notes.push("Reservation released after neg-risk arb completed.");

    this.executionsSucceeded += 1;
    return {
      mode: "live",
      success: true,
      strategyType: "neg_risk_arb",
      market: assessment.market,
      groupId: assessment.groupId,
      groupSlug: assessment.groupSlug,
      groupQuestion: assessment.groupQuestion,
      timestamp: Date.now(),
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      realizedProfitUsd: this.calculateRealizedProfit(
        assessment.grossEdgeUsd,
        assessment.totalFeesUsd,
        assessment.gasUsd,
        assessment.estimatedSlippageUsd,
        sourceReconciliation.realizedSlippageUsd + basketReconciliation.realizedSlippageUsd,
      ),
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      realizedSlippageUsd:
        sourceReconciliation.realizedSlippageUsd + basketReconciliation.realizedSlippageUsd,
      orderIds: [...sourceReconciliation.orderIds, ...basketReconciliation.orderIds],
      hedgeOrderIds: basketReconciliation.hedgeOrderIds,
      hedged: basketReconciliation.hedged,
      notes,
      settlementAction: convertReceipt.action,
      settlementTxHash: convertReceipt.txHash,
      settlementAmount: convertReceipt.amount,
      settlementBlockNumber: convertReceipt.blockNumber,
      reconciledAt: portfolioReconciliation.reconciliation?.reconciledAt,
      reconciliationSatisfied: portfolioReconciliation.reconciliation?.satisfied,
      reconciledPortfolioValueUsd: portfolioReconciliation.reconciliation?.totalValueUsd,
      reconciledPositionCount: portfolioReconciliation.reconciliation?.positions.length,
    };
  }

  private async failNegRiskAfterSourceFill(
    assessment: NegRiskAssessment,
    reservationId: string,
    sourceReconciliation: SingleOrderReconciliation,
    matchedSourceSize: number,
  ): Promise<ExecutionResult> {
    const notes = [...sourceReconciliation.notes];
    let hedgeOrderIds: string[] = [];
    let hedged = false;

    if (matchedSourceSize > EXECUTION_EPSILON) {
      const unwind = await this.flattenTokenInventory(
        assessment.market.conditionId,
        assessment.sourceNo.tokenId,
        matchedSourceSize,
        "source NO",
      );
      hedgeOrderIds = unwind.hedgeOrderIds;
      hedged = unwind.hedged;
      notes.push(...unwind.notes);
    }

    this.executionsFailed += 1;

    if ((sourceReconciliation.fullyFlat || hedged) && !sourceReconciliation.hasOpenOrders) {
      this.riskManager.release(reservationId);
      notes.push("Reservation released after source NO unwind.");
    } else {
      notes.push("Reservation retained due to possible residual source NO exposure.");
    }

    return {
      mode: "live",
      success: false,
      strategyType: "neg_risk_arb",
      market: assessment.market,
      groupId: assessment.groupId,
      groupSlug: assessment.groupSlug,
      groupQuestion: assessment.groupQuestion,
      timestamp: Date.now(),
      tradeSize: assessment.tradeSize,
      expectedProfitUsd: assessment.expectedProfitUsd,
      estimatedSlippageUsd: assessment.estimatedSlippageUsd,
      realizedSlippageUsd: sourceReconciliation.realizedSlippageUsd,
      orderIds: sourceReconciliation.orderIds,
      hedgeOrderIds,
      hedged,
      notes: [
        ...notes,
        matchedSourceSize > EXECUTION_EPSILON
          ? "Neg-risk source NO order did not fully fill."
          : "Neg-risk source NO order did not fill.",
      ],
    };
  }

  private async handleBinaryPostFill(
    assessment: RiskAssessment,
  ): Promise<{
    releaseReservation: boolean;
    settlement?: SettlementReceipt;
    reconciliation?: PortfolioReconciliationResult;
    notes: string[];
  }> {
    const notes: string[] = [];

    if (!this.config.autoMergeBinaryArb) {
      notes.push("Auto-merge disabled; paired YES/NO inventory kept open for manual settlement.");
      const reconciliation = await this.reconcilePortfolio(assessment.market.conditionId, "snapshot");
      notes.push(...reconciliation.notes);
      return {
        releaseReservation: false,
        reconciliation: reconciliation.reconciliation,
        notes,
      };
    }

    const settlement = this.dependencies.ctfSettlement;
    if (!settlement?.isEnabled()) {
      notes.push("Auto-merge enabled but CTF settlement is unavailable; reservation retained for the paired position.");
      const reconciliation = await this.reconcilePortfolio(assessment.market.conditionId, "snapshot");
      notes.push(...reconciliation.notes);
      return {
        releaseReservation: false,
        reconciliation: reconciliation.reconciliation,
        notes,
      };
    }

    try {
      const receipt = await settlement.mergeFullSet(
        assessment.market.conditionId,
        assessment.tradeSize,
      );
      notes.push(`Merged full set on-chain via tx ${receipt.txHash}.`);

      const reconciliation = await this.reconcilePortfolio(assessment.market.conditionId, "flat");
      notes.push(...reconciliation.notes);

      return {
        releaseReservation: true,
        settlement: receipt,
        reconciliation: reconciliation.reconciliation,
        notes,
      };
    } catch (error) {
      this.logger.error({ error, market: assessment.market.slug }, "CTF merge failed after full binary fill");
      notes.push(
        error instanceof Error
          ? `CTF merge failed: ${error.message}`
          : "CTF merge failed after both legs filled.",
      );

      const reconciliation = await this.reconcilePortfolio(assessment.market.conditionId, "snapshot");
      notes.push(...reconciliation.notes);

      return {
        releaseReservation: false,
        reconciliation: reconciliation.reconciliation,
        notes,
      };
    }
  }

  private async performCeilingSplit(assessment: CeilingAssessment): Promise<SettlementReceipt> {
    if (!this.config.autoSplitBinaryCeiling) {
      throw new Error("AUTO_SPLIT_BINARY_CEILING is disabled; ceiling arb requires an explicit split step.");
    }

    const settlement = this.dependencies.ctfSettlement;
    if (!settlement?.isEnabled()) {
      throw new Error("CTF settlement is unavailable; ceiling arb cannot split collateral into a full set.");
    }

    return settlement.splitFullSet(assessment.market.conditionId, assessment.tradeSize);
  }

  private async reconcilePortfolio(
    conditionId: string,
    expectation: "flat" | "snapshot",
  ): Promise<{
    reconciliation?: PortfolioReconciliationResult;
    notes: string[];
  }> {
    const reconciler = this.dependencies.portfolioReconciler;
    if (!reconciler) {
      return {
        notes: ["Portfolio reconciliation service is not configured."],
      };
    }

    try {
      const reconciliation = await reconciler.reconcileMarket(conditionId, expectation);
      return {
        reconciliation,
        notes: [...reconciliation.notes],
      };
    } catch (error) {
      this.logger.warn({ error, conditionId, expectation }, "Portfolio reconciliation failed");
      return {
        notes: [
          error instanceof Error
            ? `Portfolio reconciliation failed: ${error.message}`
            : "Portfolio reconciliation failed.",
        ],
      };
    }
  }

  private recordAttempt(intendedShares: number, estimatedSlippageUsd: number): void {
    this.executionsAttempted += 1;
    this.intendedShares += intendedShares;
    this.estimatedSlippageUsdTotal += estimatedSlippageUsd;
  }

  private recordFill(filledShares: number, realizedSlippageUsd: number): void {
    this.filledShares += filledShares;
    this.realizedSlippageUsdTotal += realizedSlippageUsd;
  }

  private calculateRealizedProfit(
    grossEdgeUsd: number,
    totalFeesUsd: number,
    gasUsd: number,
    estimatedSlippageUsd: number,
    realizedSlippageUsd?: number,
  ): number {
    const slippageUsd =
      realizedSlippageUsd !== undefined && Number.isFinite(realizedSlippageUsd)
        ? realizedSlippageUsd
        : estimatedSlippageUsd;

    return round(grossEdgeUsd - totalFeesUsd - gasUsd - slippageUsd, 6);
  }

  private resolveTickSize(
    conditionId: string,
    tokenId: string,
    fallback?: number,
  ) {
    const market = this.store.getMarket(conditionId);
    const liveTickSize =
      market?.yes.tokenId === tokenId
        ? market.yes.tickSize
        : market?.no.tokenId === tokenId
          ? market.no.tickSize
          : undefined;

    return toTickSize(liveTickSize ?? fallback);
  }

  private buildTradingPausedResult(
    strategyType: ExecutionResult["strategyType"],
    market: ExecutionResult["market"],
    tradeSize: number,
    expectedProfitUsd: number,
    estimatedSlippageUsd: number | undefined,
    modeOverride?: ExecutionMode,
    resolvedOutcome?: ExecutionResult["resolvedOutcome"],
  ): ExecutionResult {
    const status = this.tradingGuard.getStatus();
    const resumeAtNote = status.resumeAt
      ? ` until ${new Date(status.resumeAt).toISOString()}`
      : "";

    return {
      mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
      success: false,
      strategyType,
      market,
      timestamp: Date.now(),
      tradeSize,
      expectedProfitUsd,
      estimatedSlippageUsd,
      orderIds: [],
      hedgeOrderIds: [],
      hedged: false,
      resolvedOutcome,
      notes: [
        status.pauseReason
          ? `Trading paused by kill switch (${status.pauseReason})${resumeAtNote}.`
          : `Trading paused by kill switch${resumeAtNote}.`,
        status.pauseMessage ?? "Execution skipped while trading is paused.",
      ],
    };
  }

  private async flattenTokenInventory(
    conditionId: string,
    tokenId: string,
    size: number,
    label: string,
  ): Promise<{ hedged: boolean; hedgeOrderIds: string[]; notes: string[] }> {
    const client = this.wallet.requireTradingClient();
    const market = this.store.getMarket(conditionId);
    const tokenBook =
      market?.yes.tokenId === tokenId
        ? market.yes
        : market?.no.tokenId === tokenId
          ? market.no
          : undefined;
    const bestBid = tokenBook?.bestBid ?? tokenBook?.bids[0]?.price;

    if (!market || !tokenBook || !bestBid) {
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: [`Unable to flatten ${label}; no live bid is available.`],
      };
    }

    const tickSize = toTickSize(tokenBook.tickSize ?? market.market.tickSizeHint);
    const price = bestBid * (1 - this.config.hedgeSlippageTolerance);

    try {
      const response = (await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          price,
          amount: size,
          side: Side.SELL,
        },
        { tickSize, negRisk: market.market.negRisk ?? false },
        OrderType.FAK,
      )) as Record<string, unknown>;

      this.hedgesTriggered += 1;

      return {
        hedged: true,
        hedgeOrderIds: [String(response.orderID ?? "")].filter(Boolean),
        notes: [`Flattened ${size.toFixed(6)} ${label} via FAK SELL.`],
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "flatten_token_inventory");
      this.logger.error({ error, conditionId, tokenId }, "Failed to flatten token inventory");
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: [`Failed to flatten ${label}; manual intervention may be required.`],
      };
    }
  }

  private async flattenImbalance(
    assessment: RiskAssessment,
    imbalance: number,
  ): Promise<{ hedged: boolean; hedgeOrderIds: string[]; notes: string[] }> {
    const client = this.wallet.requireTradingClient();
    const notes: string[] = [];
    const hedgeTokenId = imbalance > 0 ? assessment.market.yesTokenId : assessment.market.noTokenId;
    const market = this.store.getMarket(assessment.market.conditionId);
    const hedgeBook = imbalance > 0 ? market?.yes : market?.no;
    const bestBid = hedgeBook?.bestBid ?? hedgeBook?.bids[0]?.price;

    if (!bestBid || !market) {
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: ["Imbalance detected but no hedge bid was available."],
      };
    }

    const price = bestBid * (1 - this.config.hedgeSlippageTolerance);
    const size = Math.abs(imbalance);
    const bookTickSize = hedgeBook?.tickSize;
    const tickSize = toTickSize(assessment.market.tickSizeHint ?? bookTickSize);

    try {
      const response = (await client.createAndPostMarketOrder(
        {
          tokenID: hedgeTokenId,
          price,
          amount: size,
          side: Side.SELL,
        },
        { tickSize, negRisk: assessment.market.negRisk ?? false },
        OrderType.FAK,
      )) as Record<string, unknown>;

      this.hedgesTriggered += 1;
      notes.push(`Flattened ${size.toFixed(6)} ${imbalance > 0 ? "YES" : "NO"} via FAK SELL hedge.`);

      return {
        hedged: true,
        hedgeOrderIds: [String(response.orderID ?? "")].filter(Boolean),
        notes,
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "flatten_imbalance");
      this.logger.error({ error, market: assessment.market.slug }, "Failed to hedge imbalance");
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: ["Imbalance hedge failed; manual intervention may be required."],
      };
    }
  }

  private async flattenCeilingImbalance(
    assessment: CeilingAssessment,
    imbalance: number,
  ): Promise<{ hedged: boolean; hedgeOrderIds: string[]; notes: string[] }> {
    const client = this.wallet.requireTradingClient();
    const notes: string[] = [];
    const hedgeTokenId = imbalance > 0 ? assessment.market.noTokenId : assessment.market.yesTokenId;
    const market = this.store.getMarket(assessment.market.conditionId);
    const hedgeBook = imbalance > 0 ? market?.no : market?.yes;
    const bestBid = hedgeBook?.bestBid ?? hedgeBook?.bids[0]?.price;

    if (!bestBid || !market) {
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: ["Ceiling imbalance detected but no hedge bid was available."],
      };
    }

    const price = bestBid * (1 - this.config.hedgeSlippageTolerance);
    const size = Math.abs(imbalance);
    const bookTickSize = hedgeBook?.tickSize;
    const tickSize = toTickSize(assessment.market.tickSizeHint ?? bookTickSize);

    try {
      const response = (await client.createAndPostMarketOrder(
        {
          tokenID: hedgeTokenId,
          price,
          amount: size,
          side: Side.SELL,
        },
        { tickSize, negRisk: assessment.market.negRisk ?? false },
        OrderType.FAK,
      )) as Record<string, unknown>;

      this.hedgesTriggered += 1;
      notes.push(
        `Flattened ${size.toFixed(6)} ${imbalance > 0 ? "NO" : "YES"} via FAK SELL ceiling hedge.`,
      );

      return {
        hedged: true,
        hedgeOrderIds: [String(response.orderID ?? "")].filter(Boolean),
        notes,
      };
    } catch (error) {
      this.tradingGuard.handleError(error, "flatten_ceiling_imbalance");
      this.logger.error({ error, market: assessment.market.slug }, "Failed to hedge ceiling imbalance");
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: ["Ceiling imbalance hedge failed; manual intervention may be required."],
      };
    }
  }
}
