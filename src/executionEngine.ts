import { OrderType, Side } from "@polymarket/clob-client";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ExecutionResult,
  ExecutionStats,
  OrderStatusSnapshot,
  RiskAssessment,
} from "./types.js";
import { stableId, sleep, toTickSize } from "./lib/utils.js";
import { OrderBookStore } from "./orderBookStore.js";
import { RiskManager } from "./riskManager.js";
import { WalletService } from "./wallet.js";

const orderTypeMap = {
  FOK: OrderType.FOK,
  FAK: OrderType.FAK,
  GTC: OrderType.GTC,
} as const;

export class ExecutionEngine {
  private executionsAttempted = 0;
  private executionsSucceeded = 0;
  private executionsFailed = 0;
  private hedgesTriggered = 0;
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
    return {
      executionsAttempted: this.executionsAttempted,
      executionsSucceeded: this.executionsSucceeded,
      executionsFailed: this.executionsFailed,
      hedgesTriggered: this.hedgesTriggered,
      openNotionalUsd: this.riskManager.getOpenNotionalUsd(),
    };
  }

  async execute(assessment: RiskAssessment, modeOverride?: "paper" | "backtest"): Promise<ExecutionResult> {
    const reservationId = stableId(
      assessment.market.conditionId,
      String(assessment.timestamp),
      String(assessment.tradeSize),
    );

    this.executionsAttempted += 1;
    this.marketLocks.add(assessment.market.conditionId);

    if (!this.riskManager.reserve(reservationId, assessment.totalSpendUsd)) {
      this.marketLocks.delete(assessment.market.conditionId);
      this.executionsFailed += 1;
      return {
        mode: modeOverride ?? (this.config.dryRun ? "paper" : "live"),
        success: false,
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: ["Reservation rejected by max open notional rule."],
      };
    }

    try {
      if (modeOverride === "backtest" || this.config.dryRun) {
        this.executionsSucceeded += 1;
        return {
          mode: modeOverride ?? "paper",
          success: true,
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: assessment.expectedProfitUsd,
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

      const orderIds = responses
        .map((response) => String(response.orderID ?? ""))
        .filter(Boolean);

      const snapshots = await this.pollOrderSnapshots(
        [
          {
            tokenId: assessment.market.yesTokenId,
            expectedSize: assessment.tradeSize,
            orderId: orderIds[0],
            side: "BUY",
          },
          {
            tokenId: assessment.market.noTokenId,
            expectedSize: assessment.tradeSize,
            orderId: orderIds[1],
            side: "BUY",
          },
        ],
        responses,
      );

      const yesSnapshot = snapshots[0] ?? this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.yesTokenId, "BUY");
      const noSnapshot = snapshots[1] ?? this.buildFallbackSnapshot(undefined, assessment.tradeSize, assessment.market.noTokenId, "BUY");
      let hedgeOrderIds: string[] = [];
      let hedged = false;
      const notes: string[] = [];

      if (this.config.executionOrderType === "FAK") {
        const imbalance = yesSnapshot.matchedSize - noSnapshot.matchedSize;
        if (Math.abs(imbalance) > 0.000001) {
          const hedgeResult = await this.flattenImbalance(assessment, imbalance);
          hedged = hedgeResult.hedged;
          hedgeOrderIds = hedgeResult.hedgeOrderIds;
          notes.push(...hedgeResult.notes);
        }
      }

      const bothCovered =
        yesSnapshot.matchedSize >= assessment.tradeSize - 0.000001 &&
        noSnapshot.matchedSize >= assessment.tradeSize - 0.000001;

      if (bothCovered || hedged || this.config.executionOrderType === "FOK") {
        this.executionsSucceeded += 1;
        if (!bothCovered && this.config.executionOrderType === "FOK") {
          notes.push("Expected FOK to fully match or cancel; verify fills on exchange.");
        }

        return {
          mode: "live",
          success: true,
          market: assessment.market,
          timestamp: Date.now(),
          tradeSize: assessment.tradeSize,
          expectedProfitUsd: assessment.expectedProfitUsd,
          realizedProfitUsd: bothCovered ? assessment.expectedProfitUsd : undefined,
          orderIds,
          hedgeOrderIds,
          hedged,
          notes,
        };
      }

      this.executionsFailed += 1;
      this.riskManager.release(reservationId);
      return {
        mode: "live",
        success: false,
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
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
        market: assessment.market,
        timestamp: Date.now(),
        tradeSize: assessment.tradeSize,
        expectedProfitUsd: assessment.expectedProfitUsd,
        orderIds: [],
        hedgeOrderIds: [],
        hedged: false,
        notes: [error instanceof Error ? error.message : "Unknown execution error"],
      };
    } finally {
      this.marketLocks.delete(assessment.market.conditionId);
    }
  }

  private async pollOrderSnapshots(
    orders: Array<{ orderId?: string; tokenId: string; expectedSize: number; side: "BUY" | "SELL" }>,
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

    return snapshots;
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
    };
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
