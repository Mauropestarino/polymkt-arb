import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { detectCryptoSymbol } from "./cryptoMarketRegistry.js";
import { DataApiClient } from "./dataApi.js";
import { round } from "./lib/utils.js";
import type {
  CryptoStrikeMarket,
  CryptoSymbol,
  FeeEstimate,
  FillEstimate,
  MarketBookState,
  MarketDefinition,
  SpotPrice,
  TemporalArbAssessment,
  TemporalArbSignal,
} from "./types.js";
import { WalletService } from "./wallet.js";

const HARD_MIN_CONFIDENCE = 0.7;
const HARD_MIN_TIME_REMAINING_MS = 5_000;
const HARD_MAX_SPOT_AGE_MS = 5_000;
const HARD_MIN_NORMALIZED_EDGE = 0.0003;
const HARD_MIN_COOLDOWN_MS = 5_000;
const PER_SYMBOL_EXPOSURE_MULTIPLIER = 3;
const POSITION_SIZE_EPSILON = 0.000001;

type TemporalExposureReservation = {
  symbol: CryptoSymbol;
  amountUsd: number;
  reservedAt: number;
};

type ConfidenceInput = {
  normalizedEdge: number;
  timeRemainingMs: number;
  spotAgeMs: number;
  cexSpreadPct: number;
  polymarketSpread: number;
  latencyEstimateMs: number;
};

const buildEmptyFillEstimate = (): FillEstimate => ({
  requestedSize: 0,
  executableSize: 0,
  totalCost: 0,
  averagePrice: 0,
  worstPrice: 0,
  slippagePct: 0,
  levelsConsumed: 0,
});

const buildEmptyFeeEstimate = (): FeeEstimate => ({
  feeRateBps: 0,
  feeRate: 0,
  feeExponent: 1,
  feeUsd: 0,
  feeShares: 0,
});

const buildEmptyAssessment = (
  market: CryptoStrikeMarket,
  direction: "YES" | "NO",
  spotPrice: SpotPrice,
  polymarketPrice: number,
  now: number,
): TemporalArbAssessment => ({
  viable: false,
  strategyType: "temporal_arb",
  market,
  signal: {
    market,
    symbol: market.symbol,
    spotPrice: spotPrice.price,
    strikePrice: market.strikePrice,
    direction,
    normalizedEdge: round(Math.abs(spotPrice.price - market.strikePrice) / market.strikePrice, 6),
    timeRemainingMs: Math.max(0, market.windowEndMs - now),
    resolutionConfidence: 0,
    spotSource: spotPrice.exchange,
    spotReceivedAt: spotPrice.receivedAt,
    polymarketPrice,
    impliedEdgeUsd: 0,
    timestamp: now,
  },
  tradeSize: 0,
  leg: {
    ...buildEmptyFillEstimate(),
    tokenId: direction === "YES" ? market.yesTokenId : market.noTokenId,
    bestAsk: polymarketPrice,
    fee: buildEmptyFeeEstimate(),
  },
  resolutionConfidence: 0,
  expectedPayout: 1,
  expectedProfitUsd: 0,
  expectedProfitPct: 0,
  estimatedSlippageUsd: 0,
  totalFeesUsd: 0,
  gasUsd: 0,
  totalSpendUsd: 0,
  timestamp: now,
});

export class TemporalArbRiskManager {
  private readonly dataApi: DataApiClient;
  private readonly feeRateCache = new Map<string, { value: number; updatedAt: number }>();
  private readonly cooldownByOpportunityKey = new Map<string, number>();
  private readonly exposureReservations = new Map<string, TemporalExposureReservation>();
  private portfolioExposureCache?: {
    updatedAt: number;
    bySymbol: Record<CryptoSymbol, number>;
  };

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly logger: Logger,
  ) {
    this.dataApi = new DataApiClient(config, logger);
  }

  /**
   * Returns whether the temporal engine may attempt the same opportunity key again.
   */
  canTriggerOpportunity(opportunityKey: string, now = Date.now()): boolean {
    const cooldownMs = Math.max(this.config.temporalArbCooldownMs, HARD_MIN_COOLDOWN_MS);
    const lastTriggeredAt = this.cooldownByOpportunityKey.get(opportunityKey) ?? 0;
    return now - lastTriggeredAt >= cooldownMs;
  }

  /**
   * Records the last trigger timestamp for temporal-opportunity deduplication.
   */
  markOpportunityTriggered(opportunityKey: string, now = Date.now()): void {
    this.cooldownByOpportunityKey.set(opportunityKey, now);
  }

  /**
   * Reserves symbol-specific temporal exposure that should remain tracked while inventory is open.
   */
  reserveSymbolExposure(reservationId: string, symbol: CryptoSymbol, amountUsd: number): boolean {
    const limitUsd = this.config.maxTemporalArbTradeSize * PER_SYMBOL_EXPOSURE_MULTIPLIER;
    const nextExposure = this.getReservedExposureBySymbol(symbol) + amountUsd;
    if (nextExposure > limitUsd) {
      return false;
    }

    this.exposureReservations.set(reservationId, {
      symbol,
      amountUsd: round(amountUsd, 6),
      reservedAt: Date.now(),
    });
    return true;
  }

  /**
   * Releases a previously reserved temporal symbol exposure entry.
   */
  releaseSymbolExposure(reservationId: string): void {
    this.exposureReservations.delete(reservationId);
  }

  /**
   * Computes the confidence that the market resolves in the currently implied direction.
   */
  calculateResolutionConfidence(input: ConfidenceInput): number {
    let confidence = 0;

    if (input.normalizedEdge >= 0.005 && input.timeRemainingMs <= 30_000) {
      confidence = 0.97;
    } else if (input.normalizedEdge >= 0.003 && input.timeRemainingMs <= 60_000) {
      confidence = 0.92;
    } else if (input.normalizedEdge >= 0.002 && input.timeRemainingMs <= 120_000) {
      confidence = 0.87;
    } else if (input.normalizedEdge >= 0.001 && input.timeRemainingMs <= 300_000) {
      confidence = 0.78;
    } else if (input.normalizedEdge >= 0.0005 && input.timeRemainingMs <= 600_000) {
      confidence = 0.65;
    }

    if (input.spotAgeMs > 200) {
      confidence -= Math.ceil((input.spotAgeMs - 200) / 100) * 0.005;
    }

    if (input.cexSpreadPct > 0.001) {
      confidence -= Math.min(0.03, (input.cexSpreadPct - 0.001) * 10);
    }

    if (input.polymarketSpread > 0.05) {
      confidence -= Math.min(0.03, (input.polymarketSpread - 0.05) * 0.4);
    }

    if (input.latencyEstimateMs > 2_000) {
      confidence -= 0.02;
    }

    return round(Math.max(0, Math.min(confidence, 0.999)), 6);
  }

  /**
   * Computes expected profit in USD after fees, gas, and estimated slippage.
   */
  calculateExpectedProfitUsd(
    confidence: number,
    price: number,
    tradeSize: number,
    totalFeesUsd: number,
    gasUsd: number,
    estimatedSlippageUsd: number,
  ): number {
    return round(
      (tradeSize * (confidence - price)) - totalFeesUsd - gasUsd - estimatedSlippageUsd,
      6,
    );
  }

  /**
   * Evaluates whether a temporal-arb signal is executable with positive EV and safe confidence.
   */
  async evaluate(
    market: CryptoStrikeMarket,
    bookState: MarketBookState,
    spotPrice: SpotPrice,
    now = Date.now(),
  ): Promise<TemporalArbAssessment> {
    try {
      const direction: "YES" | "NO" =
        spotPrice.price >= market.strikePrice ? "YES" : "NO";
      const targetBook = direction === "YES" ? bookState.yes : bookState.no;
      const bestAsk = targetBook.bestAsk ?? targetBook.asks[0]?.price ?? 0;
      const bestBid = targetBook.bestBid ?? targetBook.bids[0]?.price;
      const failure = buildEmptyAssessment(market, direction, spotPrice, bestAsk, now);

      if (spotPrice.receivedAt > now + 1_000) {
        return { ...failure, reason: "Clock skew detected between local timestamps and spot feed." };
      }

      const timeRemainingMs = market.windowEndMs - now;
      const minTimeRemainingMs = Math.max(
        this.config.temporalArbMinTimeRemainingMs,
        HARD_MIN_TIME_REMAINING_MS,
      );
      if (timeRemainingMs < minTimeRemainingMs) {
        return { ...failure, reason: `Time remaining ${timeRemainingMs}ms is below temporal floor.` };
      }

      if (timeRemainingMs > this.config.temporalArbMaxLookaheadMs) {
        return {
          ...failure,
          reason: `Time remaining ${timeRemainingMs}ms exceeds temporal lookahead window.`,
        };
      }

      const spotAgeMs = Math.max(0, now - spotPrice.receivedAt);
      const maxSpotAgeMs = Math.min(this.config.temporalArbMaxSpotAgeMs, HARD_MAX_SPOT_AGE_MS);
      if (spotAgeMs > maxSpotAgeMs) {
        return { ...failure, reason: `Spot age ${spotAgeMs}ms is above the configured guard.` };
      }

      const bookAgeMs = Math.max(0, now - bookState.lastUpdatedAt);
      if (bookAgeMs > this.config.maxBookAgeMs) {
        return { ...failure, reason: `Book age ${bookAgeMs}ms exceeds MAX_BOOK_AGE_MS.` };
      }

      const normalizedEdge = Math.abs(spotPrice.price - market.strikePrice) / market.strikePrice;
      if (normalizedEdge < HARD_MIN_NORMALIZED_EDGE) {
        return {
          ...failure,
          reason: `Normalized edge ${round(normalizedEdge, 6)} is below the hard temporal floor.`,
        };
      }

      if (bestAsk <= 0) {
        return { ...failure, reason: "Missing best ask on the directional temporal leg." };
      }

      const allowedAsks = targetBook.asks.filter(
        (level) => level.price <= bestAsk * (1 + this.config.slippageTolerance),
      );
      if (allowedAsks.length === 0) {
        return { ...failure, reason: "No executable ask depth inside slippage tolerance." };
      }

      const feeRateBps = await this.getFeeRateBps(bookState.market, targetBook.tokenId);
      if (!this.config.allowFeeMarkets && feeRateBps > 0) {
        return { ...failure, reason: "Fee-enabled market skipped by configuration." };
      }

      const cexSpreadPct =
        spotPrice.price > 0
          ? Math.max(0, (spotPrice.askPrice - spotPrice.bidPrice) / spotPrice.price)
          : 0;
      const polymarketSpread =
        bestBid !== undefined ? Math.max(0, bestAsk - bestBid) : 0;
      const latencyEstimateMs = Math.max(
        this.config.temporalArbEstimatedLatencyMs,
        spotPrice.latencyEstimateMs ?? 0,
      );
      const confidence = this.calculateResolutionConfidence({
        normalizedEdge,
        timeRemainingMs,
        spotAgeMs,
        cexSpreadPct,
        polymarketSpread,
        latencyEstimateMs,
      });
      const confidenceFloor = Math.max(this.config.minTemporalArbConfidence, HARD_MIN_CONFIDENCE);
      if (confidence < confidenceFloor) {
        return {
          ...failure,
          signal: {
            ...failure.signal,
            normalizedEdge: round(normalizedEdge, 6),
            timeRemainingMs,
            resolutionConfidence: confidence,
          },
          resolutionConfidence: confidence,
          reason: `Resolution confidence ${confidence.toFixed(3)} is below the temporal threshold.`,
        };
      }

      const cumulativeSize = allowedAsks.reduce((total, level) => total + level.size, 0);
      const maxTradeSize = Math.min(this.config.maxTemporalArbTradeSize, cumulativeSize);
      const candidateSizes = this.buildCandidateSizes(allowedAsks, maxTradeSize);
      const symbolExposureUsd = await this.getTotalExposureBySymbol(market.symbol);
      const symbolExposureLimitUsd =
        this.config.maxTemporalArbTradeSize * PER_SYMBOL_EXPOSURE_MULTIPLIER;
      let bestAssessment: TemporalArbAssessment | undefined;

      for (const candidateSize of candidateSizes.toSorted((left, right) => right - left)) {
        const fill = this.estimateBuyFill(allowedAsks, candidateSize);
        if (fill.executableSize < candidateSize) {
          continue;
        }

        const fee = this.estimateFee(bookState.market, fill, feeRateBps);
        const totalSpendUsd = fill.totalCost;
        const estimatedSlippageUsd = this.estimateSweepSlippageUsd(fill, bestAsk);
        const expectedProfitUsd = this.calculateExpectedProfitUsd(
          confidence,
          fill.averagePrice,
          candidateSize,
          fee.feeUsd,
          this.config.gasCostUsd,
          estimatedSlippageUsd,
        );
        const expectedProfitPct = totalSpendUsd > 0 ? expectedProfitUsd / totalSpendUsd : 0;

        if (expectedProfitUsd <= 0 || expectedProfitPct < this.config.minProfitThreshold) {
          continue;
        }

        if (symbolExposureUsd + totalSpendUsd > symbolExposureLimitUsd) {
          return {
            ...failure,
            signal: {
              ...failure.signal,
              normalizedEdge: round(normalizedEdge, 6),
              timeRemainingMs,
              resolutionConfidence: confidence,
            },
            resolutionConfidence: confidence,
            reason: `Per-symbol temporal exposure cap reached for ${market.symbol}.`,
          };
        }

        const collateral = await this.wallet.getCollateralStatus();
        if (collateral.balance < totalSpendUsd) {
          return {
            ...failure,
            reason: `Insufficient balance. need=${totalSpendUsd.toFixed(4)} balance=${collateral.balance.toFixed(4)}`,
          };
        }

        if (collateral.allowance < totalSpendUsd) {
          return {
            ...failure,
            reason: `Insufficient allowance. need=${totalSpendUsd.toFixed(4)} allowance=${collateral.allowance.toFixed(4)}`,
          };
        }

        const assessment: TemporalArbAssessment = {
          viable: true,
          strategyType: "temporal_arb",
          market,
          signal: {
            market,
            symbol: market.symbol,
            spotPrice: round(spotPrice.price, 6),
            strikePrice: round(market.strikePrice, 6),
            direction,
            normalizedEdge: round(normalizedEdge, 6),
            timeRemainingMs,
            resolutionConfidence: confidence,
            spotSource: spotPrice.exchange,
            spotReceivedAt: spotPrice.receivedAt,
            polymarketPrice: round(bestAsk, 6),
            impliedEdgeUsd: round(
              ((1 - fill.averagePrice) * candidateSize) - fee.feeUsd - this.config.gasCostUsd,
              6,
            ),
            timestamp: now,
          },
          tradeSize: round(candidateSize, 6),
          leg: {
            ...fill,
            tokenId: targetBook.tokenId,
            bestAsk,
            fee,
          },
          resolutionConfidence: confidence,
          expectedPayout: 1,
          expectedProfitUsd: round(expectedProfitUsd, 6),
          expectedProfitPct: round(expectedProfitPct, 6),
          estimatedSlippageUsd: round(estimatedSlippageUsd, 6),
          totalFeesUsd: round(fee.feeUsd, 6),
          gasUsd: this.config.gasCostUsd,
          totalSpendUsd: round(totalSpendUsd, 6),
          timestamp: now,
        };

        if (!bestAssessment || assessment.expectedProfitUsd > bestAssessment.expectedProfitUsd) {
          bestAssessment = assessment;
        }
      }

      return (
        bestAssessment ?? {
          ...failure,
          signal: {
            ...failure.signal,
            normalizedEdge: round(normalizedEdge, 6),
            timeRemainingMs,
            resolutionConfidence: confidence,
          },
          resolutionConfidence: confidence,
          reason: "No candidate size cleared temporal EV after fees, gas, and slippage.",
        }
      );
    } catch (error) {
      const direction: "YES" | "NO" = spotPrice.price >= market.strikePrice ? "YES" : "NO";
      const failure = buildEmptyAssessment(
        market,
        direction,
        spotPrice,
        direction === "YES"
          ? bookState.yes.bestAsk ?? bookState.yes.asks[0]?.price ?? 0
          : bookState.no.bestAsk ?? bookState.no.asks[0]?.price ?? 0,
        now,
      );
      this.logger.error({ error, conditionId: market.conditionId }, "Temporal risk evaluation failed");
      return {
        ...failure,
        reason: error instanceof Error ? error.message : "Temporal risk evaluation failed.",
      };
    }
  }

  private buildCandidateSizes(
    asks: Array<{ price: number; size: number }>,
    maxSize: number,
  ): number[] {
    if (maxSize <= 0) {
      return [];
    }

    const sizes = new Set<number>();
    let cumulative = 0;
    for (const level of asks) {
      cumulative += level.size;
      sizes.add(round(Math.min(cumulative, maxSize), 6));
    }

    sizes.add(round(maxSize, 6));
    return [...sizes].filter((size) => size > 0 && size <= maxSize);
  }

  private estimateBuyFill(
    levels: Array<{ price: number; size: number }>,
    requestedSize: number,
  ): FillEstimate {
    let remaining = requestedSize;
    let totalCost = 0;
    let levelsConsumed = 0;
    let worstPrice = 0;

    for (const level of levels) {
      if (remaining <= 0) {
        break;
      }

      const take = Math.min(level.size, remaining);
      if (take <= 0) {
        continue;
      }

      totalCost += take * level.price;
      remaining -= take;
      levelsConsumed += 1;
      worstPrice = level.price;
    }

    const executableSize = requestedSize - remaining;
    const averagePrice = executableSize > 0 ? totalCost / executableSize : 0;
    const bestAsk = levels[0]?.price ?? averagePrice;
    const slippagePct = bestAsk > 0 ? (worstPrice - bestAsk) / bestAsk : 0;

    return {
      requestedSize: round(requestedSize, 6),
      executableSize: round(executableSize, 6),
      totalCost: round(totalCost, 6),
      averagePrice: round(averagePrice, 6),
      worstPrice: round(worstPrice, 6),
      slippagePct: round(slippagePct, 6),
      levelsConsumed,
    };
  }

  private estimateFee(
    market: MarketDefinition,
    fill: FillEstimate,
    feeRateBps: number,
  ): FeeEstimate {
    const feeRate = feeRateBps / 10_000;
    const p = fill.averagePrice;
    const feeUsd = fill.executableSize * feeRate * p * (1 - p);
    const feeShares = p > 0 ? feeUsd / p : 0;

    return {
      feeRateBps,
      feeRate: round(feeRate, 6),
      feeExponent: this.getFeeExponent(market),
      feeUsd: round(feeUsd, 6),
      feeShares: round(feeShares, 6),
    };
  }

  private estimateSweepSlippageUsd(fill: FillEstimate, bestAsk: number): number {
    if (fill.executableSize <= 0 || bestAsk <= 0) {
      return 0;
    }

    const baselineCost = fill.executableSize * bestAsk;
    return round(Math.max(0, fill.totalCost - baselineCost), 6);
  }

  private getFeeExponent(market: MarketDefinition): number {
    const category = market.category?.toLowerCase() ?? "";
    return category.includes("crypto") ? 2 : 1;
  }

  private async getFeeRateBps(market: MarketDefinition, tokenId: string): Promise<number> {
    const cached = this.feeRateCache.get(tokenId);
    if (cached && Date.now() - cached.updatedAt < this.config.feeCacheTtlMs) {
      return cached.value;
    }

    let value = 0;
    try {
      value = await this.wallet.publicClient.getFeeRateBps(tokenId);
    } catch (error) {
      this.logger.debug(
        { error, tokenId },
        "Failed to fetch temporal fee rate bps, falling back to market fee hints",
      );
      value = market.takerBaseFee ?? market.makerBaseFee ?? 0;
    }

    this.feeRateCache.set(tokenId, { value, updatedAt: Date.now() });
    return value;
  }

  private getReservedExposureBySymbol(symbol: CryptoSymbol): number {
    let total = 0;
    for (const reservation of this.exposureReservations.values()) {
      if (reservation.symbol === symbol) {
        total += reservation.amountUsd;
      }
    }
    return round(total, 6);
  }

  private async getTotalExposureBySymbol(symbol: CryptoSymbol): Promise<number> {
    const portfolioExposure = await this.getPortfolioExposureBySymbol(symbol);
    return round(portfolioExposure + this.getReservedExposureBySymbol(symbol), 6);
  }

  private async getPortfolioExposureBySymbol(symbol: CryptoSymbol): Promise<number> {
    const now = Date.now();
    if (
      this.portfolioExposureCache &&
      now - this.portfolioExposureCache.updatedAt < this.config.balanceCacheTtlMs
    ) {
      return this.portfolioExposureCache.bySymbol[symbol];
    }

    const profileAddress = this.wallet.getProfileAddress();
    if (!profileAddress) {
      return 0;
    }

    try {
      const positions = await this.dataApi.getPositions({
        user: profileAddress,
        sizeThreshold: 0,
        limit: 500,
      });
      const bySymbol: Record<CryptoSymbol, number> = {
        BTC: 0,
        ETH: 0,
        SOL: 0,
      };

      for (const position of positions) {
        if (Math.abs(position.size) <= POSITION_SIZE_EPSILON) {
          continue;
        }

        const detectedSymbol = detectCryptoSymbol(
          [position.title, position.slug, position.eventSlug, position.outcome]
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .join(" "),
        );
        if (!detectedSymbol) {
          continue;
        }

        const exposureUsd =
          Math.abs(
            position.currentValue ??
              position.initialValue ??
              position.size * (position.avgPrice ?? position.curPrice ?? 0),
          ) || 0;
        bySymbol[detectedSymbol] += exposureUsd;
      }

      this.portfolioExposureCache = {
        updatedAt: now,
        bySymbol: {
          BTC: round(bySymbol.BTC, 6),
          ETH: round(bySymbol.ETH, 6),
          SOL: round(bySymbol.SOL, 6),
        },
      };
      return this.portfolioExposureCache.bySymbol[symbol];
    } catch (error) {
      this.logger.warn({ error, symbol }, "Unable to refresh temporal symbol exposure from Data API");
      return this.portfolioExposureCache?.bySymbol[symbol] ?? 0;
    }
  }
}
