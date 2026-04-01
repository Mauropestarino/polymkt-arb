import { OrderType, Side } from "@polymarket/clob-client";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ExecutionResult,
  ExecutionStats,
  LateResolutionAssessment,
  OrderStatusSnapshot,
  RiskAssessment,
} from "./types.js";
import { round, sum, stableId, sleep, toTickSize } from "./lib/utils.js";
import { OrderBookStore } from "./orderBookStore.js";
import { RiskManager } from "./riskManager.js";
import { WalletService } from "./wallet.js";

const orderTypeMap = {
  FOK: OrderType.FOK,
  FAK: OrderType.FAK,
  GTC: OrderType.GTC,
} as const;

type ExecutionMode = "paper" | "backtest";

type TrackedOrder = {
  orderId?: string;
  tokenId: string;
  expectedSize: number;
  expectedAveragePrice: number;
  side: "BUY" | "SELL";
};

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
    private readonly logger: Logger,
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
      const tickSize = toTickSize(assessment.market.tickSizeHint);
      const negRisk = assessment.market.negRisk ?? false;

      const [yesOrder, noOrder] = await Promise.all([
        client.createOrder(
          {
            tokenID: assessment.market.yesTokenId,
            price: assessment.yes.worstPrice,
            size: assessment.tradeSize,
            side: Side.BUY,
          },
          { tickSize, negRisk },
        ),
        client.createOrder(
          {
            tokenID: assessment.market.noTokenId,
            price: assessment.no.worstPrice,
            size: assessment.tradeSize,
            side: Side.BUY,
          },
          { tickSize, negRisk },
        ),
      ]);

      const responses = (await client.postOrders([
        { order: yesOrder, orderType },
        { order: noOrder, orderType },
      ])) as Array<Record<string, unknown>>;

      const orderIds = responses.map((response) => String(response.orderID ?? "")).filter(Boolean);
      const snapshots = await this.pollOrderSnapshots(
        [
          {
            tokenId: assessment.market.yesTokenId,
            expectedSize: assessment.tradeSize,
            expectedAveragePrice: assessment.yes.averagePrice,
            orderId: orderIds[0],
            side: "BUY",
          },
          {
            tokenId: assessment.market.noTokenId,
            expectedSize: assessment.tradeSize,
            expectedAveragePrice: assessment.no.averagePrice,
            orderId: orderIds[1],
            side: "BUY",
          },
        ],
        responses,
      );

      const yesSnapshot =
        snapshots[0] ??
        this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.yesTokenId, "BUY");
      const noSnapshot =
        snapshots[1] ??
        this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.noTokenId, "BUY");
      const notes: string[] = [];
      let hedgeOrderIds: string[] = [];
      let hedged = false;

      if (this.config.executionOrderType === "FAK") {
        const imbalance = yesSnapshot.matchedSize - noSnapshot.matchedSize;
        if (Math.abs(imbalance) > 0.000001) {
          const hedgeResult = await this.flattenImbalance(assessment, imbalance);
          hedged = hedgeResult.hedged;
          hedgeOrderIds = hedgeResult.hedgeOrderIds;
          notes.push(...hedgeResult.notes);
        }
      }

      const matchedShares = yesSnapshot.matchedSize + noSnapshot.matchedSize;
      const realizedSlippageUsd =
        (yesSnapshot.realizedSlippageUsd ?? 0) + (noSnapshot.realizedSlippageUsd ?? 0);
      const bothCovered =
        yesSnapshot.matchedSize >= assessment.tradeSize - 0.000001 &&
        noSnapshot.matchedSize >= assessment.tradeSize - 0.000001;

      this.recordFill(matchedShares, realizedSlippageUsd);

      if (bothCovered || hedged) {
        this.executionsSucceeded += 1;
        return {
          mode: "live",
          success: true,
          strategyType: "binary_arb",
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: this.calculateRealizedProfit(
            assessment.grossEdgeUsd,
            assessment.totalFeesUsd,
            assessment.gasUsd,
            assessment.estimatedSlippageUsd,
            realizedSlippageUsd,
          ),
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd,
          orderIds,
          hedgeOrderIds,
          hedged,
          notes,
        };
      }

      this.executionsFailed += 1;
      if (matchedShares <= 0.000001) {
        this.riskManager.release(reservationId);
      } else {
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
        realizedSlippageUsd,
        orderIds,
        hedgeOrderIds,
        hedged,
        notes: [...notes, "Execution did not fully cover both sides."],
      };
    } catch (error) {
      this.executionsFailed += 1;
      this.riskManager.release(reservationId);
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
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: [error instanceof Error ? error.message : "Unknown execution error"],
      };
    } finally {
      this.marketLocks.delete(assessment.market.conditionId);
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
      const tickSize = toTickSize(assessment.market.tickSizeHint);
      const negRisk = assessment.market.negRisk ?? false;

      const order = await client.createOrder(
        {
          tokenID: assessment.leg.tokenId,
          price: assessment.leg.worstPrice,
          size: assessment.tradeSize,
          side: Side.BUY,
        },
        { tickSize, negRisk },
      );

      const responses = (await client.postOrders([{ order, orderType }])) as Array<Record<string, unknown>>;
      const orderIds = responses.map((response) => String(response.orderID ?? "")).filter(Boolean);
      const [snapshot] = await this.pollOrderSnapshots(
        [
          {
            tokenId: assessment.leg.tokenId,
            expectedSize: assessment.tradeSize,
            expectedAveragePrice: assessment.leg.averagePrice,
            orderId: orderIds[0],
            side: "BUY",
          },
        ],
        responses,
      );

      const finalSnapshot =
        snapshot ??
        this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.leg.tokenId, "BUY");
      const matchedShares = finalSnapshot.matchedSize;
      const realizedSlippageUsd = finalSnapshot.realizedSlippageUsd ?? 0;

      this.recordFill(matchedShares, realizedSlippageUsd);

      if (matchedShares >= assessment.tradeSize - 0.000001) {
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
            realizedSlippageUsd,
          ),
          estimatedSlippageUsd: assessment.estimatedSlippageUsd,
          realizedSlippageUsd,
          orderIds,
          hedgeOrderIds: [],
          hedged: false,
          resolvedOutcome: assessment.resolvedOutcome,
          notes: [],
        };
      }

      this.executionsFailed += 1;
      if (matchedShares <= 0.000001) {
        this.riskManager.release(reservationId);
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
        realizedSlippageUsd,
        orderIds,
        hedgeOrderIds: [],
        hedged: false,
        resolvedOutcome: assessment.resolvedOutcome,
        notes:
          matchedShares <= 0.000001
            ? ["Late-resolution order did not fully fill."]
            : ["Late-resolution order partially filled; reservation retained for open exposure."],
      };
    } catch (error) {
      this.executionsFailed += 1;
      this.riskManager.release(reservationId);
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
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        resolvedOutcome: assessment.resolvedOutcome,
        notes: [error instanceof Error ? error.message : "Unknown execution error"],
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
          } catch {
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

      return {
        ...snapshot,
        averageFillPrice: round(averageFillPrice, 6),
        realizedSlippageUsd: round((averageFillPrice - expectedAveragePrice) * totalFilledSize, 6),
      };
    } catch (error) {
      this.logger.debug({ error, orderId: snapshot.orderId }, "Unable to enrich snapshot with trade history");
      return snapshot;
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
      this.logger.error({ error, market: assessment.market.slug }, "Failed to hedge imbalance");
      return {
        hedged: false,
        hedgeOrderIds: [],
        notes: ["Imbalance hedge failed; manual intervention may be required."],
      };
    }
  }
}
