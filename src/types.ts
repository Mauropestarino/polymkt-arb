export interface OrderBookLevel {
  price: number;
  size: number;
}

export type ArbitrageDirection = "YES_high" | "NO_high";
export type StrategyType =
  | "binary_arb"
  | "binary_ceiling"
  | "neg_risk_arb"
  | "late_resolution";
export type ResolutionOutcome = "YES" | "NO";

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
  direction: ArbitrageDirection;
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
  grossEdgeUsd: number;
  totalFeesUsd: number;
  estimatedSlippageUsd: number;
  totalSpendUsd: number;
  gasUsd: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  netEdgePerShare: number;
}

export interface CeilingAssessment {
  viable: boolean;
  reason?: string;
  strategyType: "binary_ceiling";
  market: MarketDefinition;
  timestamp: number;
  direction: ArbitrageDirection;
  tradeSize: number;
  yes: FillEstimate & {
    bestBid: number;
    fee: FeeEstimate;
  };
  no: FillEstimate & {
    bestBid: number;
    fee: FeeEstimate;
  };
  arb: number;
  collateralRequiredUsd: number;
  grossEdgeUsd: number;
  totalFeesUsd: number;
  estimatedSlippageUsd: number;
  totalProceedsUsd: number;
  gasUsd: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  netEdgePerShare: number;
}

export interface NegRiskGroupMember {
  conditionId: string;
  marketId: string;
  slug: string;
  question: string;
  outcomeIndex: number;
}

export interface NegRiskGroup {
  id: string;
  eventId: string;
  slug: string;
  title: string;
  negRiskMarketId: string;
  convertFeeBps: number;
  augmented: boolean;
  members: NegRiskGroupMember[];
}

export interface NegRiskAssessment {
  viable: boolean;
  reason?: string;
  strategyType: "neg_risk_arb";
  market: MarketDefinition;
  timestamp: number;
  tradeSize: number;
  groupId: string;
  groupSlug: string;
  groupQuestion: string;
  sourceOutcomeIndex: number;
  negRiskMarketId: string;
  convertFeeBps: number;
  convertOutputSize: number;
  sourceNo: FillEstimate & {
    tokenId: string;
    bestAsk: number;
    fee: FeeEstimate;
  };
  targetYesLegs: Array<
    FillEstimate & {
      market: MarketDefinition;
      tokenId: string;
      bestBid: number;
      fee: FeeEstimate;
      outcomeIndex: number;
      outputSize: number;
    }
  >;
  arb: number;
  grossEdgeUsd: number;
  totalFeesUsd: number;
  estimatedSlippageUsd: number;
  totalSpendUsd: number;
  totalProceedsUsd: number;
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
  averageFillPrice?: number;
  realizedSlippageUsd?: number;
  associateTradeIds?: string[];
}

export interface SettlementReceipt {
  action: "merge" | "split" | "redeem" | "convert";
  conditionId: string;
  amount: number;
  txHash: string;
  blockNumber?: number;
  gasUsed?: string;
  confirmedAt: number;
}

export interface PortfolioPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  percentRealizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface PortfolioValueSnapshot {
  user: string;
  value: number;
}

export interface PortfolioReconciliationResult {
  user: string;
  conditionId: string;
  expectation: "flat" | "snapshot";
  satisfied: boolean;
  attempts: number;
  reconciledAt: number;
  positions: PortfolioPosition[];
  totalValueUsd?: number;
  notes: string[];
}

export interface ExecutionResult {
  mode: "live" | "paper" | "backtest";
  success: boolean;
  strategyType: StrategyType;
  market: MarketDefinition;
  groupId?: string;
  groupSlug?: string;
  groupQuestion?: string;
  timestamp: number;
  tradeSize: number;
  resolvedOutcome?: ResolutionOutcome;
  expectedProfitUsd: number;
  realizedProfitUsd?: number;
  estimatedSlippageUsd?: number;
  realizedSlippageUsd?: number;
  orderIds: string[];
  notes: string[];
  hedged: boolean;
  hedgeOrderIds: string[];
  settlementAction?: SettlementReceipt["action"];
  settlementTxHash?: string;
  settlementAmount?: number;
  settlementBlockNumber?: number;
  reconciledAt?: number;
  reconciliationSatisfied?: boolean;
  reconciledPortfolioValueUsd?: number;
  reconciledPositionCount?: number;
}

export interface OpportunityLogRecord {
  type: "opportunity";
  timestamp: number;
  marketId: string;
  slug: string;
  question: string;
  groupId?: string;
  groupSlug?: string;
  groupQuestion?: string;
  strategyType?: StrategyType;
  resolvedOutcome?: ResolutionOutcome;
  direction?: ArbitrageDirection;
  arb: number;
  tradeSize: number;
  grossEdgeUsd?: number;
  totalFeesUsd?: number;
  estimatedSlippageUsd?: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  viable: boolean;
  detectedAt?: number;
  expiredAt?: number;
  opportunity_duration_ms?: number;
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
  groupId?: string;
  groupSlug?: string;
  groupQuestion?: string;
  strategyType?: StrategyType;
  resolvedOutcome?: ResolutionOutcome;
  tradeSize: number;
  expectedProfitUsd: number;
  realizedProfitUsd?: number;
  estimatedSlippageUsd?: number;
  realizedSlippageUsd?: number;
  orderIds: string[];
  hedgeOrderIds: string[];
  notes: string[];
  settlementAction?: SettlementReceipt["action"];
  settlementTxHash?: string;
  settlementAmount?: number;
  settlementBlockNumber?: number;
  reconciledAt?: number;
  reconciliationSatisfied?: boolean;
  reconciledPortfolioValueUsd?: number;
  reconciledPositionCount?: number;
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
  opportunitiesCaptured: number;
  averageOpportunityDurationMs?: number;
  completedOpportunityCount: number;
  totalOpportunityDurationMs: number;
  lastOpportunityAt?: number;
}

export interface LateResolutionStats {
  opportunitiesSeen: number;
  opportunitiesViable: number;
  opportunitiesExecuted: number;
  opportunitiesCaptured: number;
  averageOpportunityDurationMs?: number;
  completedOpportunityCount: number;
  totalOpportunityDurationMs: number;
  lastOpportunityAt?: number;
}

export interface ExecutionStats {
  executionsAttempted: number;
  executionsSucceeded: number;
  executionsFailed: number;
  hedgesTriggered: number;
  openNotionalUsd: number;
  filledShares: number;
  intendedShares: number;
  fillRate: number;
  shareFillRate: number;
  estimatedSlippageUsdTotal: number;
  estimatedSlippageUsdAverage: number;
  realizedSlippageUsdTotal: number;
  realizedSlippageUsdAverage: number;
}

export type TradingPauseReason =
  | "rate_limit"
  | "matching_engine_restart"
  | "cancel_only"
  | "trading_disabled";

export interface TradingGuardStatus {
  tradingEnabled: boolean;
  pauseReason?: TradingPauseReason;
  pauseMessage?: string;
  pausedAt?: number;
  resumeAt?: number;
}

export interface RuntimeState {
  startedAt: number;
  dryRun: boolean;
  getMarketsTracked(): number;
  getOpenNotionalUsd(): number;
  getOpportunitiesDetected(): number;
  getViableOpportunities(): number;
  getTradesExecuted(): number;
  getTradesAttempted(): number;
  getFillRate(): number;
  getShareFillRate(): number;
  getOpportunityCaptureRate(): number;
  getAverageOpportunityDurationMs(): number;
  getEstimatedSlippageUsdTotal(): number;
  getRealizedSlippageUsdTotal(): number;
  getErrorsTotal(): number;
  getTradingEnabled(): boolean;
  getTradingPauseReason(): string | undefined;
  getTradingResumeAt(): number | undefined;
}

export interface NetProfitModelInput {
  tradeSize: number;
  totalSpendUsd: number;
  feeLeg1Usd: number;
  feeLeg2Usd: number;
  gasCostUsd: number;
  slippageTolerance: number;
  estimatedSlippageUsd?: number;
}

export interface NetProfitModelOutput {
  grossEdgeUsd: number;
  totalFeesUsd: number;
  estimatedSlippageUsd: number;
  netProfitUsd: number;
  netProfitPct: number;
}

export interface DashboardSnapshot {
  startedAt: number;
  scanner: MarketScannerStats;
  arbitrage: ArbitrageEngineStats;
  ceilingArbitrage?: ArbitrageEngineStats;
  negRiskArbitrage?: ArbitrageEngineStats;
  lateResolution?: LateResolutionStats;
  execution: ExecutionStats;
  tradingGuard?: TradingGuardStatus;
  recentOpportunities: OpportunityLogRecord[];
}

export interface LateResolutionSignal {
  conditionId?: string;
  marketId?: string;
  slug?: string;
  resolvedOutcome: ResolutionOutcome;
  source: string;
  resolvedAt: number;
  note?: string;
}

export interface LateResolutionAssessment {
  viable: boolean;
  reason?: string;
  strategyType: "late_resolution";
  market: MarketDefinition;
  timestamp: number;
  resolvedOutcome: ResolutionOutcome;
  tradeSize: number;
  leg: FillEstimate & {
    tokenId: string;
    bestAsk: number;
    fee: FeeEstimate;
  };
  grossEdgeUsd: number;
  totalFeesUsd: number;
  estimatedSlippageUsd: number;
  totalSpendUsd: number;
  gasUsd: number;
  expectedProfitUsd: number;
  expectedProfitPct: number;
  source: string;
}
