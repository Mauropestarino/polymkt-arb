import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  FeeEstimate,
  FillEstimate,
  LateResolutionAssessment,
  MarketBookState,
  MarketDefinition,
  ResolutionOutcome,
  RiskAssessment,
} from "./types.js";
import { calculateNetProfitModel, deriveOpportunityDirection } from "./lib/arbitrageMath.js";
import { round, sum } from "./lib/utils.js";
import { WalletService } from "./wallet.js";

export class RiskManager {
  private readonly feeRateCache = new Map<string, { value: number; updatedAt: number }>();
  private readonly reservations = new Map<string, number>();
  private readonly cooldownByOpportunityKey = new Map<string, number>();

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly logger: Logger,
  ) {}

  getOpenNotionalUsd(): number {
    return sum([...this.reservations.values()]);
  }

  reserve(reservationId: string, amountUsd: number): boolean {
    if (this.getOpenNotionalUsd() + amountUsd > this.config.maxOpenNotional) {
      return false;
    }

    this.reservations.set(reservationId, amountUsd);
    return true;
  }

  release(reservationId: string): void {
    this.reservations.delete(reservationId);
  }

  canTriggerOpportunity(opportunityKey: string, now = Date.now()): boolean {
    const lastTriggeredAt = this.cooldownByOpportunityKey.get(opportunityKey) ?? 0;
    return now - lastTriggeredAt >= this.config.opportunityCooldownMs;
  }

  markOpportunityTriggered(opportunityKey: string, now = Date.now()): void {
    this.cooldownByOpportunityKey.set(opportunityKey, now);
  }

  async evaluate(state: MarketBookState, options?: { skipBalanceChecks?: boolean }): Promise<RiskAssessment> {
    const now = Date.now();
    const bestYesAsk = state.yes.bestAsk ?? state.yes.asks[0]?.price;
    const bestNoAsk = state.no.bestAsk ?? state.no.asks[0]?.price;
    const direction =
      bestYesAsk !== undefined && bestNoAsk !== undefined
        ? deriveOpportunityDirection(bestYesAsk, bestNoAsk)
        : "YES_high";

    const baseFailure = this.buildFailure(state.market, now, direction, "Missing best ask on one or both legs.");
    if (bestYesAsk === undefined || bestNoAsk === undefined) {
      return baseFailure;
    }

    const roughArb = bestYesAsk + bestNoAsk;
    if (roughArb >= 1 - this.config.arbitrageBuffer) {
      return this.buildFailure(
        state.market,
        now,
        direction,
        `Raw arb ${roughArb.toFixed(5)} does not clear buffer ${this.config.arbitrageBuffer.toFixed(5)}.`,
      );
    }

    if (state.yes.asks.length < this.config.minOrderbookLevels || state.no.asks.length < this.config.minOrderbookLevels) {
      return this.buildFailure(
        state.market,
        now,
        direction,
        `Insufficient ask depth. yesLevels=${state.yes.asks.length}, noLevels=${state.no.asks.length}`,
      );
    }

    const allowedYesAsks = state.yes.asks.filter(
      (level) => level.price <= bestYesAsk * (1 + this.config.slippageTolerance),
    );
    const allowedNoAsks = state.no.asks.filter(
      (level) => level.price <= bestNoAsk * (1 + this.config.slippageTolerance),
    );

    if (allowedYesAsks.length === 0 || allowedNoAsks.length === 0) {
      return this.buildFailure(state.market, now, direction, "No executable ask depth inside slippage tolerance.");
    }

    const candidateSizes = this.buildCandidateSizes(
      allowedYesAsks,
      allowedNoAsks,
      Math.min(
        this.config.maxTradeSize,
        this.cumulativeSize(allowedYesAsks),
        this.cumulativeSize(allowedNoAsks),
      ),
    );

    if (candidateSizes.length === 0) {
      return this.buildFailure(state.market, now, direction, "No candidate size found within configured trade size.");
    }

    const [yesFeeRateBps, noFeeRateBps] = await Promise.all([
      this.getFeeRateBps(state.market, state.yes.tokenId),
      this.getFeeRateBps(state.market, state.no.tokenId),
    ]);

    if (!this.config.allowFeeMarkets && (yesFeeRateBps > 0 || noFeeRateBps > 0)) {
      return this.buildFailure(state.market, now, direction, "Fee-enabled market skipped by configuration.");
    }

    let bestAssessment: RiskAssessment | undefined;

    for (const candidateSize of candidateSizes.toSorted((left, right) => right - left)) {
      const yesFill = this.estimateBuyFill(allowedYesAsks, candidateSize);
      const noFill = this.estimateBuyFill(allowedNoAsks, candidateSize);

      if (yesFill.executableSize < candidateSize || noFill.executableSize < candidateSize) {
        continue;
      }

      const yesFee = this.estimateFee(state.market, yesFill, yesFeeRateBps);
      const noFee = this.estimateFee(state.market, noFill, noFeeRateBps);
      const totalSpendUsd = yesFill.totalCost + noFill.totalCost;
      const profitModel = calculateNetProfitModel({
        tradeSize: candidateSize,
        totalSpendUsd,
        feeLeg1Usd: yesFee.feeUsd,
        feeLeg2Usd: noFee.feeUsd,
        gasCostUsd: this.config.gasCostUsd,
        slippageTolerance: this.config.slippageTolerance,
      });
      const guaranteedPayoutUsd = candidateSize;
      const expectedProfitUsd = profitModel.netProfitUsd;
      const expectedProfitPct = profitModel.netProfitPct;

      if (expectedProfitUsd <= 0 || expectedProfitPct < this.config.minProfitThreshold) {
        continue;
      }

      const assessment: RiskAssessment = {
        viable: true,
        market: state.market,
        timestamp: now,
        direction,
        tradeSize: round(candidateSize, 6),
        yes: {
          ...yesFill,
          bestAsk: bestYesAsk,
          fee: yesFee,
        },
        no: {
          ...noFill,
          bestAsk: bestNoAsk,
          fee: noFee,
        },
        arb: roughArb,
        guaranteedPayoutUsd: round(guaranteedPayoutUsd, 6),
        grossEdgeUsd: profitModel.grossEdgeUsd,
        totalFeesUsd: profitModel.totalFeesUsd,
        estimatedSlippageUsd: profitModel.estimatedSlippageUsd,
        totalSpendUsd: round(totalSpendUsd, 6),
        gasUsd: this.config.gasCostUsd,
        expectedProfitUsd: round(expectedProfitUsd, 6),
        expectedProfitPct: round(expectedProfitPct, 6),
        netEdgePerShare: round(expectedProfitUsd / candidateSize, 6),
      };

      if (!options?.skipBalanceChecks) {
        const collateral = await this.wallet.getCollateralStatus();
        const availableBuffer = this.config.maxOpenNotional - this.getOpenNotionalUsd();

        if (collateral.balance < totalSpendUsd) {
          return this.buildFailure(
            state.market,
            now,
            direction,
            `Insufficient balance. need=${totalSpendUsd.toFixed(4)} balance=${collateral.balance.toFixed(4)}`,
          );
        }

        if (collateral.allowance < totalSpendUsd) {
          return this.buildFailure(
            state.market,
            now,
            direction,
            `Insufficient allowance. need=${totalSpendUsd.toFixed(4)} allowance=${collateral.allowance.toFixed(4)}`,
          );
        }

        if (availableBuffer < totalSpendUsd) {
          return this.buildFailure(
            state.market,
            now,
            direction,
            `Open notional cap reached. available=${availableBuffer.toFixed(4)} need=${totalSpendUsd.toFixed(4)}`,
          );
        }
      }

      if (!bestAssessment || assessment.expectedProfitUsd > bestAssessment.expectedProfitUsd) {
        bestAssessment = assessment;
      }
    }

    return (
      bestAssessment ??
      this.buildFailure(
        state.market,
        now,
        direction,
        "No candidate size cleared min profit after slippage, fees, and gas.",
      )
    );
  }

  async evaluateLateResolution(
    state: MarketBookState,
    resolvedOutcome: ResolutionOutcome,
    source: string,
    options?: { skipBalanceChecks?: boolean },
  ): Promise<LateResolutionAssessment> {
    const now = Date.now();
    const targetBook = resolvedOutcome === "YES" ? state.yes : state.no;
    const bestAsk = targetBook.bestAsk ?? targetBook.asks[0]?.price;

    if (bestAsk === undefined) {
      return this.buildLateResolutionFailure(
        state.market,
        now,
        resolvedOutcome,
        source,
        "Missing best ask on resolved winning side.",
      );
    }

    const allowedAsks = targetBook.asks.filter(
      (level) => level.price <= bestAsk * (1 + this.config.slippageTolerance),
    );

    if (allowedAsks.length === 0) {
      return this.buildLateResolutionFailure(
        state.market,
        now,
        resolvedOutcome,
        source,
        "No executable ask depth inside slippage tolerance for late resolution.",
      );
    }

    const candidateSizes = this.buildCandidateSizes(
      allowedAsks,
      allowedAsks,
      Math.min(this.config.maxTradeSize, this.cumulativeSize(allowedAsks)),
    );

    const feeRateBps = await this.getFeeRateBps(state.market, targetBook.tokenId);
    let bestAssessment: LateResolutionAssessment | undefined;

    for (const candidateSize of candidateSizes.toSorted((left, right) => right - left)) {
      const fill = this.estimateBuyFill(allowedAsks, candidateSize);
      if (fill.executableSize < candidateSize) {
        continue;
      }

      const fee = this.estimateFee(state.market, fill, feeRateBps);
      const totalSpendUsd = fill.totalCost;
      const profitModel = calculateNetProfitModel({
        tradeSize: candidateSize,
        totalSpendUsd,
        feeLeg1Usd: fee.feeUsd,
        feeLeg2Usd: 0,
        gasCostUsd: this.config.gasCostUsd,
        slippageTolerance: this.config.slippageTolerance,
      });

      if (
        profitModel.netProfitUsd <= 0 ||
        profitModel.netProfitPct < this.config.minProfitThreshold
      ) {
        continue;
      }

      if (!options?.skipBalanceChecks) {
        const collateral = await this.wallet.getCollateralStatus();
        const availableBuffer = this.config.maxOpenNotional - this.getOpenNotionalUsd();

        if (collateral.balance < totalSpendUsd) {
          return this.buildLateResolutionFailure(
            state.market,
            now,
            resolvedOutcome,
            source,
            `Insufficient balance. need=${totalSpendUsd.toFixed(4)} balance=${collateral.balance.toFixed(4)}`,
          );
        }

        if (collateral.allowance < totalSpendUsd) {
          return this.buildLateResolutionFailure(
            state.market,
            now,
            resolvedOutcome,
            source,
            `Insufficient allowance. need=${totalSpendUsd.toFixed(4)} allowance=${collateral.allowance.toFixed(4)}`,
          );
        }

        if (availableBuffer < totalSpendUsd) {
          return this.buildLateResolutionFailure(
            state.market,
            now,
            resolvedOutcome,
            source,
            `Open notional cap reached. available=${availableBuffer.toFixed(4)} need=${totalSpendUsd.toFixed(4)}`,
          );
        }
      }

      const assessment: LateResolutionAssessment = {
        viable: true,
        strategyType: "late_resolution",
        market: state.market,
        timestamp: now,
        resolvedOutcome,
        tradeSize: round(candidateSize, 6),
        leg: {
          ...fill,
          tokenId: targetBook.tokenId,
          bestAsk,
          fee,
        },
        grossEdgeUsd: profitModel.grossEdgeUsd,
        totalFeesUsd: profitModel.totalFeesUsd,
        estimatedSlippageUsd: profitModel.estimatedSlippageUsd,
        totalSpendUsd: round(totalSpendUsd, 6),
        gasUsd: this.config.gasCostUsd,
        expectedProfitUsd: round(profitModel.netProfitUsd, 6),
        expectedProfitPct: round(profitModel.netProfitPct, 6),
        source,
      };

      if (!bestAssessment || assessment.expectedProfitUsd > bestAssessment.expectedProfitUsd) {
        bestAssessment = assessment;
      }
    }

    return (
      bestAssessment ??
      this.buildLateResolutionFailure(
        state.market,
        now,
        resolvedOutcome,
        source,
        "No candidate size cleared min profit for late-resolution edge.",
      )
    );
  }

  private buildCandidateSizes(
    yesAsks: Array<{ price: number; size: number }>,
    noAsks: Array<{ price: number; size: number }>,
    maxSize: number,
  ): number[] {
    const sizes = new Set<number>();
    let cumulative = 0;
    for (const level of yesAsks) {
      cumulative += level.size;
      sizes.add(round(Math.min(cumulative, maxSize), 6));
    }

    cumulative = 0;
    for (const level of noAsks) {
      cumulative += level.size;
      sizes.add(round(Math.min(cumulative, maxSize), 6));
    }

    sizes.add(round(maxSize, 6));
    return [...sizes].filter((size) => size > 0 && size <= maxSize);
  }

  private cumulativeSize(levels: Array<{ size: number }>): number {
    return levels.reduce((total, level) => total + level.size, 0);
  }

  private estimateBuyFill(levels: Array<{ price: number; size: number }>, requestedSize: number): FillEstimate {
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

  private estimateFee(market: MarketDefinition, fill: FillEstimate, feeRateBps: number): FeeEstimate {
    const feeRate = feeRateBps / 10_000;
    const feeExponent = this.getFeeExponent(market);
    const p = fill.averagePrice;
    const feeUsd = fill.totalCost * feeRate;
    const feeShares = p > 0 ? feeUsd / p : 0;

    return {
      feeRateBps,
      feeRate: round(feeRate, 6),
      feeExponent,
      feeUsd: round(feeUsd, 6),
      feeShares: round(feeShares, 6),
    };
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
      this.logger.debug({ error, tokenId }, "Failed to fetch fee rate bps, falling back to market fee hints");
      value = market.takerBaseFee ?? market.makerBaseFee ?? 0;
    }

    this.feeRateCache.set(tokenId, { value, updatedAt: Date.now() });
    return value;
  }

  private buildFailure(
    market: MarketDefinition,
    timestamp: number,
    direction: RiskAssessment["direction"],
    reason: string,
  ): RiskAssessment {
    return {
      viable: false,
      reason,
      market,
      timestamp,
      direction,
      tradeSize: 0,
      yes: {
        requestedSize: 0,
        executableSize: 0,
        totalCost: 0,
        averagePrice: 0,
        worstPrice: 0,
        slippagePct: 0,
        levelsConsumed: 0,
        bestAsk: 0,
        fee: {
          feeRateBps: 0,
          feeRate: 0,
          feeExponent: 1,
          feeUsd: 0,
          feeShares: 0,
        },
      },
      no: {
        requestedSize: 0,
        executableSize: 0,
        totalCost: 0,
        averagePrice: 0,
        worstPrice: 0,
        slippagePct: 0,
        levelsConsumed: 0,
        bestAsk: 0,
        fee: {
          feeRateBps: 0,
          feeRate: 0,
          feeExponent: 1,
          feeUsd: 0,
          feeShares: 0,
        },
      },
      arb: 0,
      guaranteedPayoutUsd: 0,
      grossEdgeUsd: 0,
      totalFeesUsd: 0,
      estimatedSlippageUsd: 0,
      totalSpendUsd: 0,
      gasUsd: this.config.gasCostUsd,
      expectedProfitUsd: 0,
      expectedProfitPct: 0,
      netEdgePerShare: 0,
    };
  }

  private buildLateResolutionFailure(
    market: MarketDefinition,
    timestamp: number,
    resolvedOutcome: ResolutionOutcome,
    source: string,
    reason: string,
  ): LateResolutionAssessment {
    return {
      viable: false,
      reason,
      strategyType: "late_resolution",
      market,
      timestamp,
      resolvedOutcome,
      tradeSize: 0,
      leg: {
        tokenId: resolvedOutcome === "YES" ? market.yesTokenId : market.noTokenId,
        requestedSize: 0,
        executableSize: 0,
        totalCost: 0,
        averagePrice: 0,
        worstPrice: 0,
        slippagePct: 0,
        levelsConsumed: 0,
        bestAsk: 0,
        fee: {
          feeRateBps: 0,
          feeRate: 0,
          feeExponent: 1,
          feeUsd: 0,
          feeShares: 0,
        },
      },
      grossEdgeUsd: 0,
      totalFeesUsd: 0,
      estimatedSlippageUsd: 0,
      totalSpendUsd: 0,
      gasUsd: this.config.gasCostUsd,
      expectedProfitUsd: 0,
      expectedProfitPct: 0,
      source,
    };
  }
}
