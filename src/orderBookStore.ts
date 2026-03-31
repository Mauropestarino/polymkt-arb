import type {
  MarketBookState,
  MarketDefinition,
  OrderBookLevel,
  PersistedMarketSnapshot,
  TokenBookState,
} from "./types.js";
import { sortAsksAsc, sortBidsDesc, upsertLevel } from "./lib/utils.js";

export class OrderBookStore {
  private readonly marketsByConditionId = new Map<string, MarketDefinition>();
  private readonly tokenToConditionId = new Map<string, string>();
  private readonly booksByTokenId = new Map<string, TokenBookState>();

  registerMarkets(markets: MarketDefinition[]): void {
    for (const market of markets) {
      this.registerMarket(market);
    }
  }

  registerMarket(market: MarketDefinition): void {
    this.marketsByConditionId.set(market.conditionId, market);
    this.tokenToConditionId.set(market.yesTokenId, market.conditionId);
    this.tokenToConditionId.set(market.noTokenId, market.conditionId);

    const yes = this.booksByTokenId.get(market.yesTokenId);
    if (!yes) {
      this.booksByTokenId.set(market.yesTokenId, this.createEmptyBook(market.yesTokenId, market.conditionId));
    }

    const no = this.booksByTokenId.get(market.noTokenId);
    if (!no) {
      this.booksByTokenId.set(market.noTokenId, this.createEmptyBook(market.noTokenId, market.conditionId));
    }
  }

  markResolved(conditionId: string): void {
    const market = this.marketsByConditionId.get(conditionId);
    if (market) {
      this.marketsByConditionId.set(conditionId, { ...market, active: false, closed: true });
    }
  }

  applySnapshot(
    tokenId: string,
    bids: OrderBookLevel[],
    asks: OrderBookLevel[],
    timestamp: number,
    metadata?: {
      tickSize?: number;
      minOrderSize?: number;
      negRisk?: boolean;
    },
  ): MarketBookState | undefined {
    const book = this.ensureBook(tokenId);
    if (!book) {
      return undefined;
    }

    book.bids = sortBidsDesc(bids);
    book.asks = sortAsksAsc(asks);
    book.bestBid = book.bids[0]?.price;
    book.bestAsk = book.asks[0]?.price;
    book.spread =
      book.bestAsk !== undefined && book.bestBid !== undefined ? book.bestAsk - book.bestBid : undefined;
    book.lastUpdatedAt = timestamp;

    if (metadata) {
      book.tickSize = metadata.tickSize ?? book.tickSize;
      book.minOrderSize = metadata.minOrderSize ?? book.minOrderSize;
      book.negRisk = metadata.negRisk ?? book.negRisk;
    }

    return this.getMarketByToken(tokenId);
  }

  applyPriceChange(
    tokenId: string,
    level: OrderBookLevel,
    side: "BUY" | "SELL",
    bestBid: number | undefined,
    bestAsk: number | undefined,
    timestamp: number,
  ): MarketBookState | undefined {
    const book = this.ensureBook(tokenId);
    if (!book) {
      return undefined;
    }

    if (side === "BUY") {
      book.bids = upsertLevel(book.bids, level, "bids");
    } else {
      book.asks = upsertLevel(book.asks, level, "asks");
    }

    book.bestBid = bestBid ?? book.bids[0]?.price;
    book.bestAsk = bestAsk ?? book.asks[0]?.price;
    book.spread =
      book.bestAsk !== undefined && book.bestBid !== undefined ? book.bestAsk - book.bestBid : undefined;
    book.lastUpdatedAt = timestamp;

    return this.getMarketByToken(tokenId);
  }

  applyBestBidAsk(
    tokenId: string,
    bestBid: number | undefined,
    bestAsk: number | undefined,
    timestamp: number,
  ): MarketBookState | undefined {
    const book = this.ensureBook(tokenId);
    if (!book) {
      return undefined;
    }

    book.bestBid = bestBid;
    book.bestAsk = bestAsk;
    book.spread =
      bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : book.spread;
    book.lastUpdatedAt = timestamp;

    return this.getMarketByToken(tokenId);
  }

  getMarket(conditionId: string): MarketBookState | undefined {
    const market = this.marketsByConditionId.get(conditionId);
    if (!market) {
      return undefined;
    }

    const yes = this.booksByTokenId.get(market.yesTokenId);
    const no = this.booksByTokenId.get(market.noTokenId);
    if (!yes || !no) {
      return undefined;
    }

    return {
      market,
      yes: { ...yes, bids: [...yes.bids], asks: [...yes.asks] },
      no: { ...no, bids: [...no.bids], asks: [...no.asks] },
      lastUpdatedAt: Math.max(yes.lastUpdatedAt, no.lastUpdatedAt),
    };
  }

  getMarketByToken(tokenId: string): MarketBookState | undefined {
    const conditionId = this.tokenToConditionId.get(tokenId);
    if (!conditionId) {
      return undefined;
    }

    return this.getMarket(conditionId);
  }

  getAllMarkets(): MarketDefinition[] {
    return [...this.marketsByConditionId.values()];
  }

  getTrackedTokenIds(): string[] {
    return [...this.booksByTokenId.keys()];
  }

  toSnapshot(conditionId: string): PersistedMarketSnapshot | undefined {
    const state = this.getMarket(conditionId);
    if (!state) {
      return undefined;
    }

    return {
      type: "market_snapshot",
      timestamp: state.lastUpdatedAt,
      market: state.market,
      yes: state.yes,
      no: state.no,
    };
  }

  private ensureBook(tokenId: string): TokenBookState | undefined {
    const book = this.booksByTokenId.get(tokenId);
    if (book) {
      return book;
    }

    const conditionId = this.tokenToConditionId.get(tokenId);
    if (!conditionId) {
      return undefined;
    }

    const fresh = this.createEmptyBook(tokenId, conditionId);
    this.booksByTokenId.set(tokenId, fresh);
    return fresh;
  }

  private createEmptyBook(tokenId: string, marketId: string): TokenBookState {
    return {
      tokenId,
      marketId,
      bids: [],
      asks: [],
      lastUpdatedAt: 0,
    };
  }
}
