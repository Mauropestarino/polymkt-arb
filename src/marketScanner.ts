import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { MarketBookState, MarketDefinition, OrderBookLevel } from "./types.js";
import { chunk, parseArrayField, round, safeJsonParse } from "./lib/utils.js";
import { OrderBookStore } from "./orderBookStore.js";
import { EventJournal } from "./lib/journal.js";
import { WalletService } from "./wallet.js";

type RawMarket = Record<string, unknown>;

export class MarketScanner extends EventEmitter {
  private websocket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnects = 0;
  private stopped = false;
  private lastMessageAt?: number;

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly store: OrderBookStore,
    private readonly journal: EventJournal,
    private readonly logger: Logger,
  ) {
    super();
  }

  async start(): Promise<MarketDefinition[]> {
    this.logger.info("Fetching active markets from Gamma API");
    const markets = await this.fetchActiveMarkets();
    this.store.registerMarkets(markets);
    this.logger.info({ markets: markets.length }, "Seeding order books from CLOB");
    await this.seedOrderBooks(markets);
    this.logger.info("Connecting to Polymarket market WebSocket");
    await this.connectWebSocket();
    return markets;
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.websocket) {
      this.websocket.close();
      this.websocket = undefined;
    }
  }

  getStats(): {
    marketsTracked: number;
    tokensTracked: number;
    websocketConnected: boolean;
    websocketReconnects: number;
    lastMessageAt?: number;
  } {
    return {
      marketsTracked: this.store.getAllMarkets().length,
      tokensTracked: this.store.getTrackedTokenIds().length,
      websocketConnected: this.websocket?.readyState === WebSocket.OPEN,
      websocketReconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt,
    };
  }

  private async fetchActiveMarkets(): Promise<MarketDefinition[]> {
    const markets: MarketDefinition[] = [];
    let offset = 0;
    const pageSize = Math.min(this.config.marketPageSize, 100);

    while (!this.stopped) {
      const url = new URL("/markets", this.config.gammaApiUrl);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", "volume");
      url.searchParams.set("ascending", "false");

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Unable to fetch Gamma markets: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as RawMarket[];

      const pageMarkets = payload
        .map((market) => this.normalizeMarket(market))
        .filter((market): market is MarketDefinition => market !== undefined);

      markets.push(...pageMarkets);

      if (this.config.maxMarkets > 0 && markets.length >= this.config.maxMarkets) {
        break;
      }

      if (payload.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    const deduped = [...new Map(markets.map((market) => [market.conditionId, market])).values()];
    const limited = this.config.maxMarkets > 0 ? deduped.slice(0, this.config.maxMarkets) : deduped;

    this.logger.info(
      { discovered: deduped.length, selected: limited.length },
      "Active markets fetched from CLOB",
    );

    return limited;
  }

  private normalizeMarket(raw: RawMarket): MarketDefinition | undefined {
    const active = Boolean(raw.active);
    const closed = Boolean(raw.closed);
    const archived = Boolean(raw.archived);
    const acceptingOrders = raw.accepting_orders ?? raw.acceptingOrders;
    const enableOrderBook = raw.enable_order_book ?? raw.enableOrderBook;

    if (!active || closed || archived || acceptingOrders === false || enableOrderBook === false) {
      return undefined;
    }

    const liquidity = Number(raw.liquidity ?? raw.liquidity_num ?? raw.liquidityNum ?? 0);
    if (liquidity < this.config.minMarketLiquidity) {
      return undefined;
    }

    const tokens = Array.isArray(raw.tokens) ? (raw.tokens as Array<Record<string, unknown>>) : [];

    let yesTokenId = "";
    let noTokenId = "";
    let yesLabel = "Yes";
    let noLabel = "No";

    if (tokens.length >= 2) {
      for (const token of tokens) {
        const outcome = String(token.outcome ?? "").trim();
        const tokenId = String(token.token_id ?? token.tokenID ?? "");

        if (outcome.toLowerCase() === "yes") {
          yesTokenId = tokenId;
          yesLabel = outcome;
        }

        if (outcome.toLowerCase() === "no") {
          noTokenId = tokenId;
          noLabel = outcome;
        }
      }
    }

    if (!yesTokenId || !noTokenId) {
      const outcomes = parseArrayField((raw.outcomes as string | string[]) ?? []);
      const clobTokenIds = parseArrayField((raw.clobTokenIds as string | string[]) ?? []);

      if (outcomes.length !== 2 || clobTokenIds.length !== 2) {
        return undefined;
      }

      const yesIndex = outcomes.findIndex((value) => value.trim().toLowerCase() === "yes");
      const noIndex = outcomes.findIndex((value) => value.trim().toLowerCase() === "no");

      if (yesIndex === -1 || noIndex === -1) {
        return undefined;
      }

      yesTokenId = clobTokenIds[yesIndex] ?? "";
      noTokenId = clobTokenIds[noIndex] ?? "";
      yesLabel = outcomes[yesIndex] ?? "Yes";
      noLabel = outcomes[noIndex] ?? "No";
    }

    if (!yesTokenId || !noTokenId) {
      this.logger.debug(
        {
          slug: String(raw.market_slug ?? raw.slug ?? ""),
          question: String(raw.question ?? raw.title ?? ""),
          outcomes: raw.outcomes ?? tokens.map((token) => token.outcome),
        },
        "Skipping non-binary market without YES/NO outcomes",
      );
      return undefined;
    }

    return {
      id: String(raw.market_id ?? raw.id ?? raw.slug ?? raw.question ?? ""),
      conditionId: String(raw.condition_id ?? raw.conditionId ?? raw.market ?? ""),
      slug: String(raw.market_slug ?? raw.slug ?? ""),
      question: String(raw.question ?? raw.title ?? ""),
      category: typeof raw.category === "string" ? raw.category : undefined,
      active,
      closed,
      liquidity: round(liquidity, 6),
      volume24hr: Number(raw.volume_24hr ?? raw.volume24hr ?? 0),
      yesTokenId,
      noTokenId,
      yesLabel,
      noLabel,
      tickSizeHint: raw.minimum_tick_size
        ? Number(raw.minimum_tick_size)
        : raw.orderPriceMinTickSize
          ? Number(raw.orderPriceMinTickSize)
          : undefined,
      minOrderSize: raw.minimum_order_size
        ? Number(raw.minimum_order_size)
        : raw.orderMinSize
          ? Number(raw.orderMinSize)
          : undefined,
      negRisk:
        typeof raw.neg_risk === "boolean"
          ? raw.neg_risk
          : typeof raw.negRisk === "boolean"
            ? raw.negRisk
            : undefined,
      makerBaseFee: raw.maker_base_fee ? Number(raw.maker_base_fee) : raw.makerBaseFee ? Number(raw.makerBaseFee) : undefined,
      takerBaseFee: raw.taker_base_fee ? Number(raw.taker_base_fee) : raw.takerBaseFee ? Number(raw.takerBaseFee) : undefined,
    };
  }

  private async seedOrderBooks(markets: MarketDefinition[]): Promise<void> {
    const tokenIds = markets.flatMap((market) => [market.yesTokenId, market.noTokenId]);
    const batches = chunk(tokenIds, this.config.bookSeedConcurrency);

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (tokenId) => {
          try {
            const book = (await this.wallet.publicClient.getOrderBook(tokenId)) as {
              bids: Array<{ price: string; size: string }>;
              asks: Array<{ price: string; size: string }>;
              tick_size?: string;
              min_order_size?: string;
              neg_risk?: boolean;
            };

            const state = this.store.applySnapshot(
              tokenId,
              this.mapLevels(book.bids ?? []),
              this.mapLevels(book.asks ?? []),
              Date.now(),
              {
                tickSize: book.tick_size ? Number(book.tick_size) : undefined,
                minOrderSize: book.min_order_size ? Number(book.min_order_size) : undefined,
                negRisk: book.neg_risk,
              },
            );

            if (state) {
              this.persistSnapshot(state);
            }
          } catch (error) {
            this.logger.debug({ error, tokenId }, "Unable to seed order book");
          }
        }),
      );
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const websocket = new WebSocket(this.config.marketWsUrl);
    this.websocket = websocket;

    websocket.on("open", () => {
      this.logger.info("Connected to Polymarket market WebSocket");
      this.subscribeToTrackedTokens();
      this.heartbeat = setInterval(() => {
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({}));
        }
      }, this.config.heartbeatIntervalMs);
      this.heartbeat.unref();
    });

    websocket.on("message", (payload) => {
      this.lastMessageAt = Date.now();
      const parsed = safeJsonParse<unknown>(payload.toString());
      const messages = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      for (const message of messages) {
        this.handleSocketMessage(message as Record<string, unknown>);
      }
    });

    websocket.on("close", () => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }

      if (!this.stopped) {
        this.reconnects += 1;
        this.logger.warn({ reconnects: this.reconnects }, "Market WebSocket disconnected, scheduling reconnect");
        this.scheduleReconnect();
      }
    });

    websocket.on("error", (error) => {
      this.logger.warn({ error }, "Market WebSocket error");
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    const delay = Math.min(
      this.config.wsReconnectBaseMs * 2 ** Math.min(this.reconnects, 6),
      this.config.wsReconnectMaxMs,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connectWebSocket();
      } catch (error) {
        this.logger.error({ error }, "Failed to reconnect market WebSocket");
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  private subscribeToTrackedTokens(): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const tokenIds = this.store.getTrackedTokenIds();
    const batches = chunk(tokenIds, this.config.marketSubscriptionChunkSize);
    const [initialBatch, ...additionalBatches] = batches;

    if (initialBatch && initialBatch.length > 0) {
      this.websocket.send(
        JSON.stringify({
          type: "market",
          assets_ids: initialBatch,
          custom_feature_enabled: true,
        }),
      );
    }

    for (const batch of additionalBatches) {
      this.websocket.send(
        JSON.stringify({
          operation: "subscribe",
          assets_ids: batch,
        }),
      );
    }
  }

  private handleSocketMessage(message: Record<string, unknown>): void {
    const eventType = String(message.event_type ?? "");

    switch (eventType) {
      case "book": {
        const assetId = String(message.asset_id ?? "");
        const state = this.store.applySnapshot(
          assetId,
          this.mapLevels((message.bids as Array<{ price: string; size: string }>) ?? []),
          this.mapLevels((message.asks as Array<{ price: string; size: string }>) ?? []),
          Number(message.timestamp ?? Date.now()),
        );
        this.onMarketState(state);
        break;
      }
      case "price_change": {
        const changes = Array.isArray(message.price_changes)
          ? (message.price_changes as Array<Record<string, unknown>>)
          : [];
        const timestamp = Number(message.timestamp ?? Date.now());

        for (const change of changes) {
          const assetId = String(change.asset_id ?? "");
          const state = this.store.applyPriceChange(
            assetId,
            {
              price: Number(change.price ?? 0),
              size: Number(change.size ?? 0),
            },
            String(change.side ?? "BUY") === "SELL" ? "SELL" : "BUY",
            change.best_bid !== undefined ? Number(change.best_bid) : undefined,
            change.best_ask !== undefined ? Number(change.best_ask) : undefined,
            timestamp,
          );
          this.onMarketState(state);
        }
        break;
      }
      case "best_bid_ask": {
        const assetId = String(message.asset_id ?? "");
        const state = this.store.applyBestBidAsk(
          assetId,
          message.best_bid !== undefined ? Number(message.best_bid) : undefined,
          message.best_ask !== undefined ? Number(message.best_ask) : undefined,
          Number(message.timestamp ?? Date.now()),
        );
        this.onMarketState(state);
        break;
      }
      case "new_market": {
        const market = this.normalizeMarket({
          id: message.id,
          market_id: message.id,
          condition_id: message.condition_id ?? message.market,
          market_slug: message.slug,
          question: message.question,
          active: message.active,
          closed: false,
          liquidity: 0,
          outcomes: message.outcomes,
          clobTokenIds: message.clob_token_ids,
          orderPriceMinTickSize: message.order_price_min_tick_size,
          category: Array.isArray(message.tags) ? (message.tags as string[])[0] : undefined,
        });

        if (market) {
          this.store.registerMarket(market);
          this.logger.info({ market: market.slug }, "Subscribed to newly listed market");
          this.subscribeToTrackedTokens();
        }
        break;
      }
      case "market_resolved": {
        const conditionId = String(message.condition_id ?? message.market ?? "");
        if (conditionId) {
          this.store.markResolved(conditionId);
        }
        break;
      }
      default:
        break;
    }
  }

  private onMarketState(state: MarketBookState | undefined): void {
    if (!state) {
      return;
    }

    this.persistSnapshot(state);
    this.emit("marketUpdate", state);
  }

  private persistSnapshot(state: MarketBookState): void {
    const snapshot = this.store.toSnapshot(state.market.conditionId);
    if (snapshot) {
      this.journal.logSnapshot(snapshot);
    }
  }

  private mapLevels(levels: Array<{ price: string; size: string }>): OrderBookLevel[] {
    return levels.map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }));
  }
}
