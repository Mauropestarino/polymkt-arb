export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  liquidity?: string | number;
  liquidityNum?: number;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: number;
  category?: string;
  outcomes: string | string[];
  clobTokenIds: string | string[];
  orderPriceMinTickSize?: string | number;
  orderMinSize?: string | number;
  negRisk?: boolean;
  makerBaseFee?: number;
  takerBaseFee?: number;
}

export interface MarketDefinition {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  category?: string;
  active: boolean;
  closed: boolean;
  liquidity: number;
  volume24hr: number;
  yesTokenId: string;
  noTokenId: string;
  yesLabel: string;
  noLabel: string;
  tickSizeHint?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  makerBaseFee?: number;
  takerBaseFee?: number;
}

export interface TokenBookState {
  tokenId: string;
  marketId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  lastUpdatedAt: number;
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
}

export interface MarketBookState {
  market: MarketDefinition;
  yes: TokenBookState;
  no: TokenBookState;
  lastUpdatedAt: number;
}

export interface FillEstimate {
  requestedSize: number;
  executableSize: number;
  totalCost: number;
  averagePrice: number;
  worstPrice: number;
  slippagePct: number;
  levelsConsumed: number;
}

export interface FeeEstimate {
  feeRateBps: number;
  feeRate: number;
  feeExponent: number;
  feeUsd: number;
  feeShares: number;
}

export interface RiskAssessment {
  viable: boolean;
  reason?: string;
  market: MarketDefinition;
  timestamp: number;
  tradeSize: number;
  yes: FillEstimate & {
    bestAsk: number;
    fee: FeeEstimate;
  };
  no: FillEstimate & {
    bestAsk: number;
    fee: FeeEstimate;
  };
  arb: number;
  guaranteedPayoutUsd: number;
  totalSpendUsd: number;
  gasUsd: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  netEdgePerShare: number;
}

export interface OrderStatusSnapshot {
  orderId: string;
  status: string;
  originalSize: number;
  matchedSize: number;
  remainingSize: number;
  side: "BUY" | "SELL";
  tokenId: string;
}

export interface ExecutionResult {
  mode: "live" | "paper" | "backtest";
  success: boolean;
  market: MarketDefinition;
  timestamp: number;
  tradeSize: number;
  expectedProfitUsd: number;
  realizedProfitUsd?: number;
  orderIds: string[];
  notes: string[];
  hedged: boolean;
  hedgeOrderIds: string[];
}

export interface OpportunityLogRecord {
  type: "opportunity";
  timestamp: number;
  marketId: string;
  slug: string;
  question: string;
  arb: number;
  tradeSize: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  viable: boolean;
  reason?: string;
}

export interface TradeLogRecord {
  type: "trade";
  timestamp: number;
  success: boolean;
  mode: "live" | "paper" | "backtest";
  marketId: string;
  slug: string;
  question: string;
  tradeSize: number;
  expectedProfitUsd: number;
  realizedProfitUsd?: number;
  orderIds: string[];
  hedgeOrderIds: string[];
  notes: string[];
}

export interface PersistedMarketSnapshot {
  type: "market_snapshot";
  timestamp: number;
  market: MarketDefinition;
  yes: TokenBookState;
  no: TokenBookState;
}

export interface MarketScannerStats {
  marketsTracked: number;
  tokensTracked: number;
  websocketConnected: boolean;
  websocketReconnects: number;
  lastMessageAt?: number;
}

export interface ArbitrageEngineStats {
  opportunitiesSeen: number;
  opportunitiesViable: number;
  opportunitiesExecuted: number;
  lastOpportunityAt?: number;
}

export interface ExecutionStats {
  executionsAttempted: number;
  executionsSucceeded: number;
  executionsFailed: number;
  hedgesTriggered: number;
  openNotionalUsd: number;
}

export interface DashboardSnapshot {
  startedAt: number;
  scanner: MarketScannerStats;
  arbitrage: ArbitrageEngineStats;
  execution: ExecutionStats;
  recentOpportunities: OpportunityLogRecord[];
}
