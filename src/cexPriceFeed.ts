import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";
import WebSocket from "ws";
import type { BotConfig } from "./config.js";
import { computeBackoffDelay, safeJsonParse } from "./lib/utils.js";
import type {
  CexExchange,
  CexFeedStats,
  CexPriceFeedStatus,
  CryptoSymbol,
  SpotPrice,
} from "./types.js";

const BINANCE_SYMBOL_MAP: Record<CryptoSymbol, string> = {
  BTC: "btcusdt",
  ETH: "ethusdt",
  SOL: "solusdt",
};

const COINBASE_PRODUCT_MAP: Record<CryptoSymbol, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
};

type ExchangeConnectionState = {
  connected: boolean;
  disconnects: number;
  reconnectAttempts: number;
  lastMessageAt?: number;
};

type BinanceTickerMessage = {
  s?: string;
  b?: string;
  a?: string;
  c?: string;
  E?: number;
  T?: number;
};

type CoinbaseTickerEntry = {
  product_id?: string;
  price?: string;
  best_bid?: string;
  best_ask?: string;
  time?: string;
};

type CoinbaseMessage = {
  channel?: string;
  type?: string;
  timestamp?: string;
  events?: Array<{
    type?: string;
    tickers?: CoinbaseTickerEntry[];
  }>;
  product_id?: string;
  price?: string;
  best_bid?: string;
  best_ask?: string;
  time?: string;
};

const toFiniteNumber = (value: string | number | undefined): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const fromExchangeProduct = (
  exchange: CexExchange,
  identifier: string | undefined,
): CryptoSymbol | undefined => {
  if (!identifier) {
    return undefined;
  }

  const normalized = identifier.toUpperCase();
  if (exchange === "binance") {
    if (normalized === "BTCUSDT") {
      return "BTC";
    }
    if (normalized === "ETHUSDT") {
      return "ETH";
    }
    if (normalized === "SOLUSDT") {
      return "SOL";
    }
    return undefined;
  }

  if (normalized === "BTC-USD") {
    return "BTC";
  }
  if (normalized === "ETH-USD") {
    return "ETH";
  }
  if (normalized === "SOL-USD") {
    return "SOL";
  }

  return undefined;
};

const createExchangeState = (): ExchangeConnectionState => ({
  connected: false,
  disconnects: 0,
  reconnectAttempts: 0,
  lastMessageAt: undefined,
});

export class CexPriceFeed extends EventEmitter {
  private readonly binanceSockets = new Map<CryptoSymbol, WebSocket>();
  private readonly binanceReconnectAttempts = new Map<CryptoSymbol, number>();
  private readonly binanceReconnectTimers = new Map<CryptoSymbol, NodeJS.Timeout>();
  private readonly latestByExchange = {
    binance: new Map<CryptoSymbol, SpotPrice>(),
    coinbase: new Map<CryptoSymbol, SpotPrice>(),
  };
  private readonly exchangeStates: Record<CexExchange, ExchangeConnectionState> = {
    binance: createExchangeState(),
    coinbase: createExchangeState(),
  };
  private readonly activeExchangeBySymbol = new Map<CryptoSymbol, CexExchange>();
  private readonly lastSwitchAtBySymbol = new Map<CryptoSymbol, number>();
  private readonly lastPublishedKeyBySymbol = new Map<CryptoSymbol, string>();
  private readonly staleCountsBySymbol = new Map<CryptoSymbol, number>();
  private readonly staleSymbols = new Set<CryptoSymbol>();
  private coinbaseSocket?: WebSocket;
  private coinbaseReconnectTimer?: NodeJS.Timeout;
  private coinbaseReconnectAttempt = 0;
  private staleCheckTimer?: NodeJS.Timeout;
  private stopped = true;
  private lastBothFeedsDownAt?: number;
  private readonly wallClockAnchorMs = Date.now();
  private readonly performanceAnchorMs = performance.now();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    super();
  }

  /**
   * Starts the primary and fallback CEX feeds and begins staleness monitoring.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.startBinance();
    this.startCoinbase();
    this.startStaleMonitor();
  }

  /**
   * Stops all WebSocket connections and background timers for the CEX feeds.
   */
  stop(): void {
    this.stopped = true;

    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = undefined;
    }

    for (const timer of this.binanceReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.binanceReconnectTimers.clear();

    if (this.coinbaseReconnectTimer) {
      clearTimeout(this.coinbaseReconnectTimer);
      this.coinbaseReconnectTimer = undefined;
    }

    for (const socket of this.binanceSockets.values()) {
      socket.removeAllListeners();
      socket.close();
    }
    this.binanceSockets.clear();

    if (this.coinbaseSocket) {
      this.coinbaseSocket.removeAllListeners();
      this.coinbaseSocket.close();
      this.coinbaseSocket = undefined;
    }

    this.exchangeStates.binance.connected = false;
    this.exchangeStates.coinbase.connected = false;
  }

  /**
   * Returns the latest selected spot price for the requested symbol.
   */
  getPrice(symbol: CryptoSymbol): SpotPrice | undefined {
    return this.selectFreshSpot(symbol, Date.now()) ?? this.selectSpot(symbol);
  }

  /**
   * Returns whether the current selected feed for the symbol is stale.
   */
  isStale(symbol: CryptoSymbol): boolean {
    return this.isSymbolStale(symbol, Date.now());
  }

  /**
   * Returns a detailed feed-health snapshot for metrics and diagnostics.
   */
  getStats(): CexFeedStats {
    const staleCount = [...this.staleCountsBySymbol.values()].reduce((total, value) => total + value, 0);
    const symbols = Object.fromEntries(
      this.config.cexSymbols.map((symbol) => {
        const selected = this.selectSpot(symbol);
        return [
          symbol,
          {
            stale: this.isStale(symbol),
            lastUpdateAt: selected?.receivedAt,
            activeExchange: this.activeExchangeBySymbol.get(symbol),
            lastSwitchAt: this.lastSwitchAtBySymbol.get(symbol),
            lastLatencyEstimateMs: selected?.latencyEstimateMs,
            staleCount: this.staleCountsBySymbol.get(symbol) ?? 0,
          },
        ];
      }),
    ) as CexFeedStats["symbols"];

    return {
      connected: this.exchangeStates.binance.connected || this.exchangeStates.coinbase.connected,
      primaryExchange: this.config.cexPrimaryExchange,
      trackedSymbols: [...this.config.cexSymbols],
      disconnectCount:
        this.exchangeStates.binance.disconnects + this.exchangeStates.coinbase.disconnects,
      staleCount,
      lastBothFeedsDownAt: this.lastBothFeedsDownAt,
      exchanges: {
        binance: { ...this.exchangeStates.binance },
        coinbase: { ...this.exchangeStates.coinbase },
      },
      symbols,
    };
  }

  /**
   * Returns a compact feed-health view for dashboard rendering.
   */
  getStatus(): CexPriceFeedStatus {
    const now = Date.now();
    const feedAgeMsBySymbol = Object.fromEntries(
      this.config.cexSymbols.map((symbol) => {
        const selected = this.selectSpot(symbol);
        return [symbol, selected ? Math.max(0, now - selected.receivedAt) : undefined];
      }),
    ) as CexPriceFeedStatus["feedAgeMsBySymbol"];
    const staleSymbols = this.config.cexSymbols.filter((symbol) => this.isSymbolStale(symbol, now));
    const maxActiveFeedAgeMs = Object.values(feedAgeMsBySymbol)
      .filter((value): value is number => typeof value === "number")
      .reduce<number | undefined>(
        (maxValue, value) => (maxValue === undefined ? value : Math.max(maxValue, value)),
        undefined,
      );
    const stats = this.getStats();

    return {
      connected: stats.connected,
      live: stats.connected && staleSymbols.length === 0,
      primaryExchange: stats.primaryExchange,
      activeExchangeBySymbol: Object.fromEntries(
        this.config.cexSymbols.map((symbol) => [symbol, this.activeExchangeBySymbol.get(symbol)]),
      ) as CexPriceFeedStatus["activeExchangeBySymbol"],
      feedAgeMsBySymbol,
      maxActiveFeedAgeMs,
      staleSymbols,
      disconnectCount: stats.disconnectCount,
      staleCount: stats.staleCount,
    };
  }

  private startBinance(): void {
    for (const symbol of this.config.cexSymbols) {
      this.connectBinanceSymbol(symbol);
    }
  }

  private connectBinanceSymbol(symbol: CryptoSymbol): void {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket(
      `wss://stream.binance.com:9443/ws/${BINANCE_SYMBOL_MAP[symbol]}@ticker`,
    );
    this.binanceSockets.set(symbol, socket);

    socket.on("open", () => {
      this.binanceReconnectAttempts.set(symbol, 0);
      this.exchangeStates.binance.connected = this.hasOpenBinanceSocket();
      this.logger.info({ exchange: "binance", symbol }, "Connected CEX spot feed");
    });

    socket.on("message", (buffer) => {
      const payload = safeJsonParse<BinanceTickerMessage>(buffer.toString());
      if (!payload) {
        return;
      }
      this.exchangeStates.binance.lastMessageAt = Date.now();
      const parsed = this.parseBinanceTicker(payload);
      if (parsed) {
        this.handleParsedSpot("binance", parsed);
      }
    });

    socket.on("error", (error) => {
      this.logger.warn({ error, exchange: "binance", symbol }, "Binance spot feed error");
    });

    socket.on("close", () => {
      this.exchangeStates.binance.disconnects += 1;
      this.exchangeStates.binance.connected = this.hasOpenBinanceSocket();
      this.scheduleBinanceReconnect(symbol);
    });
  }

  private scheduleBinanceReconnect(symbol: CryptoSymbol): void {
    if (this.stopped) {
      return;
    }

    const attempt = (this.binanceReconnectAttempts.get(symbol) ?? 0) + 1;
    this.binanceReconnectAttempts.set(symbol, attempt);
    this.exchangeStates.binance.reconnectAttempts += 1;
    const delayMs = computeBackoffDelay(
      this.config.cexFeedReconnectBaseMs,
      this.config.cexFeedReconnectMaxMs,
      attempt - 1,
    );

    const timer = setTimeout(() => {
      this.binanceReconnectTimers.delete(symbol);
      this.connectBinanceSymbol(symbol);
    }, delayMs);
    timer.unref();
    this.binanceReconnectTimers.set(symbol, timer);
  }

  private startCoinbase(): void {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket("wss://advanced-trade-api.coinbase.com/ws");
    this.coinbaseSocket = socket;

    socket.on("open", () => {
      this.coinbaseReconnectAttempt = 0;
      this.exchangeStates.coinbase.connected = true;
      const productIds = this.config.cexSymbols.map((symbol) => COINBASE_PRODUCT_MAP[symbol]);
      socket.send(
        JSON.stringify({
          type: "subscribe",
          channel: "ticker_batch",
          product_ids: productIds,
        }),
      );
      this.logger.info({ exchange: "coinbase", products: productIds }, "Connected CEX spot feed");
    });

    socket.on("message", (buffer) => {
      const payload = safeJsonParse<CoinbaseMessage>(buffer.toString());
      if (!payload) {
        return;
      }
      this.exchangeStates.coinbase.lastMessageAt = Date.now();
      for (const parsed of this.parseCoinbaseTickers(payload)) {
        this.handleParsedSpot("coinbase", parsed);
      }
    });

    socket.on("error", (error) => {
      this.logger.warn({ error, exchange: "coinbase" }, "Coinbase spot feed error");
    });

    socket.on("close", () => {
      this.exchangeStates.coinbase.disconnects += 1;
      this.exchangeStates.coinbase.connected = false;
      this.scheduleCoinbaseReconnect();
    });
  }

  private scheduleCoinbaseReconnect(): void {
    if (this.stopped) {
      return;
    }

    this.coinbaseReconnectAttempt += 1;
    this.exchangeStates.coinbase.reconnectAttempts += 1;
    const delayMs = computeBackoffDelay(
      this.config.cexFeedReconnectBaseMs,
      this.config.cexFeedReconnectMaxMs,
      this.coinbaseReconnectAttempt - 1,
    );
    this.coinbaseReconnectTimer = setTimeout(() => {
      this.coinbaseReconnectTimer = undefined;
      this.startCoinbase();
    }, delayMs);
    this.coinbaseReconnectTimer.unref();
  }

  private parseBinanceTicker(message: BinanceTickerMessage): SpotPrice | undefined {
    const symbol = fromExchangeProduct("binance", message.s);
    const price = toFiniteNumber(message.c);
    const bidPrice = toFiniteNumber(message.b);
    const askPrice = toFiniteNumber(message.a);
    if (!symbol || price === undefined || bidPrice === undefined || askPrice === undefined) {
      return undefined;
    }

    const serverTimestampMs = toFiniteNumber(message.E) ?? toFiniteNumber(message.T);
    return {
      symbol,
      price,
      bidPrice,
      askPrice,
      receivedAt: this.nowHighResolutionMs(),
      exchange: "binance",
      serverTimestampMs,
      latencyEstimateMs:
        serverTimestampMs !== undefined ? Math.max(0, Date.now() - serverTimestampMs) : undefined,
    };
  }

  private parseCoinbaseTickers(message: CoinbaseMessage): SpotPrice[] {
    const parsed: SpotPrice[] = [];
    const directTicker: CoinbaseTickerEntry[] =
      message.product_id && message.price
        ? [
            {
              product_id: message.product_id,
              price: message.price,
              best_bid: message.best_bid,
              best_ask: message.best_ask,
              time: message.time ?? message.timestamp,
            },
          ]
        : [];
    const entries = [
      ...directTicker,
      ...(message.events?.flatMap((event) => event.tickers ?? []) ?? []),
    ];

    for (const entry of entries) {
      const symbol = fromExchangeProduct("coinbase", entry.product_id);
      const price = toFiniteNumber(entry.price);
      const bidPrice = toFiniteNumber(entry.best_bid);
      const askPrice = toFiniteNumber(entry.best_ask);
      if (!symbol || price === undefined || bidPrice === undefined || askPrice === undefined) {
        continue;
      }

      const serverTimestampMs =
        typeof entry.time === "string" ? Date.parse(entry.time) : undefined;
      parsed.push({
        symbol,
        price,
        bidPrice,
        askPrice,
        receivedAt: this.nowHighResolutionMs(),
        exchange: "coinbase",
        serverTimestampMs: Number.isFinite(serverTimestampMs) ? serverTimestampMs : undefined,
        latencyEstimateMs:
          Number.isFinite(serverTimestampMs) && serverTimestampMs !== undefined
            ? Math.max(0, Date.now() - serverTimestampMs)
            : undefined,
      });
    }

    return parsed;
  }

  private handleParsedSpot(exchange: CexExchange, spot: SpotPrice): void {
    this.latestByExchange[exchange].set(spot.symbol, spot);
    this.refreshSelectedSpot(spot.symbol);
  }

  private refreshSelectedSpot(symbol: CryptoSymbol): void {
    const now = Date.now();
    const selected = this.selectFreshSpot(symbol, now) ?? this.selectSpot(symbol);
    if (!selected) {
      return;
    }

    const previousExchange = this.activeExchangeBySymbol.get(symbol);
    if (previousExchange !== selected.exchange) {
      this.activeExchangeBySymbol.set(symbol, selected.exchange);
      this.lastSwitchAtBySymbol.set(symbol, now);
      if (previousExchange) {
        this.logger.warn(
          {
            symbol,
            previousExchange,
            nextExchange: selected.exchange,
            staleThresholdMs: this.config.cexFeedStaleThresholdMs,
          },
          "Switching active CEX spot source",
        );
      }
    }

    const publishKey = [
      selected.exchange,
      selected.receivedAt.toFixed(3),
      selected.price.toFixed(6),
      selected.bidPrice.toFixed(6),
      selected.askPrice.toFixed(6),
    ].join(":");
    if (this.lastPublishedKeyBySymbol.get(symbol) === publishKey) {
      return;
    }

    this.lastPublishedKeyBySymbol.set(symbol, publishKey);
    this.emit("priceUpdate", selected);
  }

  private startStaleMonitor(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
    }

    const intervalMs = Math.max(250, Math.min(this.config.cexFeedStaleThresholdMs / 2, 1000));
    this.staleCheckTimer = setInterval(() => {
      this.checkStaleness();
    }, intervalMs);
    this.staleCheckTimer.unref();
  }

  private checkStaleness(): void {
    const now = Date.now();

    for (const symbol of this.config.cexSymbols) {
      this.refreshSelectedSpot(symbol);
      const stale = this.isSymbolStale(symbol, now);
      const wasStale = this.staleSymbols.has(symbol);
      if (stale && !wasStale) {
        this.staleSymbols.add(symbol);
        this.staleCountsBySymbol.set(symbol, (this.staleCountsBySymbol.get(symbol) ?? 0) + 1);
        this.emit("stale", { symbol, timestamp: now });
      }

      if (!stale && wasStale) {
        this.staleSymbols.delete(symbol);
      }
    }

    if (!this.exchangeStates.binance.connected && !this.exchangeStates.coinbase.connected) {
      if (!this.lastBothFeedsDownAt || now - this.lastBothFeedsDownAt >= 60_000) {
        this.lastBothFeedsDownAt = now;
        this.logger.error("Both CEX spot feeds are disconnected; temporal arb signals are disabled");
      }
    }
  }

  private isSymbolStale(symbol: CryptoSymbol, now: number): boolean {
    const selected = this.selectFreshSpot(symbol, now) ?? this.selectSpot(symbol);
    if (!selected) {
      return true;
    }

    return now - selected.receivedAt > this.config.cexFeedStaleThresholdMs;
  }

  private selectFreshSpot(symbol: CryptoSymbol, now: number): SpotPrice | undefined {
    const exchangePriority = this.getExchangePriority();
    for (const exchange of exchangePriority) {
      const candidate = this.latestByExchange[exchange].get(symbol);
      if (!candidate) {
        continue;
      }

      if (now - candidate.receivedAt <= this.config.cexFeedStaleThresholdMs) {
        return candidate;
      }
    }

    return undefined;
  }

  private selectSpot(symbol: CryptoSymbol): SpotPrice | undefined {
    const exchangePriority = this.getExchangePriority();
    let newest: SpotPrice | undefined;
    for (const exchange of exchangePriority) {
      const candidate = this.latestByExchange[exchange].get(symbol);
      if (!candidate) {
        continue;
      }

      if (!newest || candidate.receivedAt > newest.receivedAt) {
        newest = candidate;
      }

      if (exchange === this.config.cexPrimaryExchange) {
        return candidate;
      }
    }

    return newest;
  }

  private getExchangePriority(): CexExchange[] {
    return this.config.cexPrimaryExchange === "binance"
      ? ["binance", "coinbase"]
      : ["coinbase", "binance"];
  }

  private nowHighResolutionMs(): number {
    return this.wallClockAnchorMs + (performance.now() - this.performanceAnchorMs);
  }

  private hasOpenBinanceSocket(): boolean {
    return [...this.binanceSockets.values()].some((socket) => socket.readyState === WebSocket.OPEN);
  }
}
