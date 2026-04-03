import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ArbitrageDirection,
  CeilingAssessment,
  FeeEstimate,
  FillEstimate,
  LateResolutionAssessment,
  MarketBookState,
  MarketDefinition,
  NegRiskAssessment,
  NegRiskGroup,
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
      const estimatedSlippageUsd =
        this.estimateSweepSlippageUsd(yesFill, bestYesAsk) +
        this.estimateSweepSlippageUsd(noFill, bestNoAsk);
      const profitModel = calculateNetProfitModel({
        tradeSize: candidateSize,
        totalSpendUsd,
        feeLeg1Usd: yesFee.feeUsd,
        feeLeg2Usd: noFee.feeUsd,
        gasCostUsd: this.config.gasCostUsd,
        slippageTolerance: this.config.slippageTolerance,
        estimatedSlippageUsd,
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
      const estimatedSlippageUsd = this.estimateSweepSlippageUsd(fill, bestAsk);
      const profitModel = calculateNetProfitModel({
        tradeSize: candidateSize,
        totalSpendUsd,
        feeLeg1Usd: fee.feeUsd,
        feeLeg2Usd: 0,
        gasCostUsd: this.config.gasCostUsd,
        slippageTolerance: this.config.slippageTolerance,
        estimatedSlippageUsd,
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

  async evaluateCeiling(
    state: MarketBookState,
    options?: { skipBalanceChecks?: boolean },
  ): Promise<CeilingAssessment> {
    const now = Date.now();
    const bestYesBid = state.yes.bestBid ?? state.yes.bids[0]?.price;
    const bestNoBid = state.no.bestBid ?? state.no.bids[0]?.price;
    const direction =
      bestYesBid !== undefined && bestNoBid !== undefined
        ? deriveOpportunityDirection(bestYesBid, bestNoBid)
        : "YES_high";

    if (bestYesBid === undefined || bestNoBid === undefined) {
      return this.buildCeilingFailure(state.market, now, direction, "Missing best bid on one or both legs.");
    }

    const roughArb = bestYesBid + bestNoBid;
    if (roughArb <= 1 + this.config.arbitrageBuffer) {
      return this.buildCeilingFailure(
        state.market,
        now,
        direction,
        `Raw ceiling ${roughArb.toFixed(5)} does not clear buffer ${this.config.arbitrageBuffer.toFixed(5)}.`,
      );
    }

    if (state.yes.bids.length < this.config.minOrderbookLevels || state.no.bids.length < this.config.minOrderbookLevels) {
      return this.buildCeilingFailure(
        state.market,
        now,
        direction,
        `Insufficient bid depth. yesLevels=${state.yes.bids.length}, noLevels=${state.no.bids.length}`,
      );
    }

    const allowedYesBids = state.yes.bids.filter(
      (level) => level.price >= bestYesBid * (1 - this.config.slippageTolerance),
    );
    const allowedNoBids = state.no.bids.filter(
      (level) => level.price >= bestNoBid * (1 - this.config.slippageTolerance),
    );

    if (allowedYesBids.length === 0 || allowedNoBids.length === 0) {
      return this.buildCeilingFailure(state.market, now, direction, "No executable bid depth inside slippage tolerance.");
    }

    const candidateSizes = this.buildCandidateSizes(
      allowedYesBids,
      allowedNoBids,
      Math.min(
        this.config.maxTradeSize,
        this.cumulativeSize(allowedYesBids),
        this.cumulativeSize(allowedNoBids),
      ),
    );

    if (candidateSizes.length === 0) {
      return this.buildCeilingFailure(state.market, now, direction, "No candidate size found within configured trade size.");
    }

    const [yesFeeRateBps, noFeeRateBps] = await Promise.all([
      this.getFeeRateBps(state.market, state.yes.tokenId),
      this.getFeeRateBps(state.market, state.no.tokenId),
    ]);

    if (!this.config.allowFeeMarkets && (yesFeeRateBps > 0 || noFeeRateBps > 0)) {
      return this.buildCeilingFailure(state.market, now, direction, "Fee-enabled market skipped by configuration.");
    }

    let bestAssessment: CeilingAssessment | undefined;

    for (const candidateSize of candidateSizes.toSorted((left, right) => right - left)) {
      const yesFill = this.estimateSellFill(allowedYesBids, candidateSize);
      const noFill = this.estimateSellFill(allowedNoBids, candidateSize);

      if (yesFill.executableSize < candidateSize || noFill.executableSize < candidateSize) {
        continue;
      }

      const yesFee = this.estimateFee(state.market, yesFill, yesFeeRateBps);
      const noFee = this.estimateFee(state.market, noFill, noFeeRateBps);
      const collateralRequiredUsd = round(candidateSize, 6);
      const totalProceedsUsd = yesFill.totalCost + noFill.totalCost;
      const estimatedSlippageUsd =
        this.estimateSellSweepSlippageUsd(yesFill, bestYesBid) +
        this.estimateSellSweepSlippageUsd(noFill, bestNoBid);
      const grossEdgeUsd = totalProceedsUsd - collateralRequiredUsd;
      const totalFeesUsd = yesFee.feeUsd + noFee.feeUsd;
      const expectedProfitUsd = grossEdgeUsd - totalFeesUsd - this.config.gasCostUsd - estimatedSlippageUsd;
      const expectedProfitPct =
        collateralRequiredUsd > 0 ? expectedProfitUsd / collateralRequiredUsd : 0;

      if (expectedProfitUsd <= 0 || expectedProfitPct < this.config.minProfitThreshold) {
        continue;
      }

      const assessment: CeilingAssessment = {
        viable: true,
        strategyType: "binary_ceiling",
        market: state.market,
        timestamp: now,
        direction,
        tradeSize: round(candidateSize, 6),
        yes: {
          ...yesFill,
          bestBid: bestYesBid,
          fee: yesFee,
        },
        no: {
          ...noFill,
          bestBid: bestNoBid,
          fee: noFee,
        },
        arb: roughArb,
        collateralRequiredUsd,
        grossEdgeUsd: round(grossEdgeUsd, 6),
        totalFeesUsd: round(totalFeesUsd, 6),
        estimatedSlippageUsd: round(estimatedSlippageUsd, 6),
        totalProceedsUsd: round(totalProceedsUsd, 6),
        gasUsd: this.config.gasCostUsd,
        expectedProfitUsd: round(expectedProfitUsd, 6),
        expectedProfitPct: round(expectedProfitPct, 6),
        netEdgePerShare: round(expectedProfitUsd / candidateSize, 6),
      };

      if (!options?.skipBalanceChecks) {
        const collateral = await this.wallet.getCollateralStatus();
        const availableBuffer = this.config.maxOpenNotional - this.getOpenNotionalUsd();

        if (collateral.balance < collateralRequiredUsd) {
          return this.buildCeilingFailure(
            state.market,
            now,
            direction,
            `Insufficient balance. need=${collateralRequiredUsd.toFixed(4)} balance=${collateral.balance.toFixed(4)}`,
          );
        }

        if (collateral.allowance < collateralRequiredUsd) {
          return this.buildCeilingFailure(
            state.market,
            now,
            direction,
            `Insufficient allowance. need=${collateralRequiredUsd.toFixed(4)} allowance=${collateral.allowance.toFixed(4)}`,
          );
        }

        if (availableBuffer < collateralRequiredUsd) {
          return this.buildCeilingFailure(
            state.market,
            now,
            direction,
            `Open notional cap reached. available=${availableBuffer.toFixed(4)} need=${collateralRequiredUsd.toFixed(4)}`,
          );
        }
      }

      if (!bestAssessment || assessment.expectedProfitUsd > bestAssessment.expectedProfitUsd) {
        bestAssessment = assessment;
      }
    }

    return (
      bestAssessment ??
      this.buildCeilingFailure(
        state.market,
        now,
        direction,
        "No candidate size cleared min profit for ceiling arb after fees, gas, and slippage.",
      )
    );
  }

  async evaluateNegRisk(
    group: NegRiskGroup,
    sourceState: MarketBookState,
    targetStates: MarketBookState[],
    options?: { skipBalanceChecks?: boolean },
  ): Promise<NegRiskAssessment> {
    const now = Date.now();
    const sourceMember = group.members.find(
      (member) => member.conditionId === sourceState.market.conditionId,
    );

    if (!sourceMember) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Source market is not part of the neg-risk group.",
        0,
      );
    }

    if (targetStates.length !== group.members.length - 1) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Missing one or more target outcomes for neg-risk conversion.",
        sourceMember.outcomeIndex,
      );
    }

    const bestNoAsk = sourceState.no.bestAsk ?? sourceState.no.asks[0]?.price;
    if (bestNoAsk === undefined) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Missing best ask on source NO leg.",
        sourceMember.outcomeIndex,
      );
    }

    const convertMultiplier = 1 - (group.convertFeeBps / 10_000);
    if (convertMultiplier <= 0) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        `Neg-risk convert fee ${group.convertFeeBps} bps eliminates the output basket.`,
        sourceMember.outcomeIndex,
      );
    }

    const allowedNoAsks = sourceState.no.asks.filter(
      (level) => level.price <= bestNoAsk * (1 + this.config.slippageTolerance),
    );
    if (allowedNoAsks.length < this.config.minOrderbookLevels) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Insufficient ask depth on source NO book.",
        sourceMember.outcomeIndex,
      );
    }

    const targetContexts = targetStates
      .map((state) => {
        const targetMember = group.members.find((member) => member.conditionId === state.market.conditionId);
        const bestBid = state.yes.bestBid ?? state.yes.bids[0]?.price;
        const allowedBids =
          bestBid === undefined
            ? []
            : state.yes.bids.filter(
                (level) => level.price >= bestBid * (1 - this.config.slippageTolerance),
              );
        return {
          state,
          member: targetMember,
          bestBid,
          allowedBids,
        };
      })
      .filter(
        (context): context is {
          state: MarketBookState;
          member: NegRiskGroup["members"][number];
          bestBid: number;
          allowedBids: Array<{ price: number; size: number }>;
        } => Boolean(context.member && context.bestBid !== undefined),
      );

    if (targetContexts.length !== targetStates.length) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Missing best bid on one or more converted YES legs.",
        sourceMember.outcomeIndex,
      );
    }

    if (targetContexts.some((context) => context.allowedBids.length < this.config.minOrderbookLevels)) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Insufficient bid depth on one or more converted YES legs.",
        sourceMember.outcomeIndex,
      );
    }

    const bestSyntheticProceedsPerShare = sum(
      targetContexts.map((context) => context.bestBid * convertMultiplier),
    );
    const roughArb = bestSyntheticProceedsPerShare - bestNoAsk;
    if (roughArb <= this.config.arbitrageBuffer) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        `Raw neg-risk spread ${roughArb.toFixed(5)} does not clear buffer ${this.config.arbitrageBuffer.toFixed(5)}.`,
        sourceMember.outcomeIndex,
        {
          rawSpreadUsd: round(roughArb, 6),
          convertFeeBps: group.convertFeeBps,
        },
      );
    }

    const candidateMaxSize = Math.min(
      this.config.maxTradeSize,
      this.cumulativeSize(allowedNoAsks),
      ...targetContexts.map((context) => this.cumulativeSize(context.allowedBids) / convertMultiplier),
    );

    if (!Number.isFinite(candidateMaxSize) || candidateMaxSize <= 0) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "No executable neg-risk size found inside configured slippage limits.",
        sourceMember.outcomeIndex,
      );
    }

    const candidateSizes = this.buildCandidateSizesFromGroups(
      [
        allowedNoAsks,
        ...targetContexts.map((context) =>
          context.allowedBids.map((level) => ({
            price: level.price,
            size: level.size / convertMultiplier,
          })),
        ),
      ],
      candidateMaxSize,
    );

    if (candidateSizes.length === 0) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "No candidate size available for neg-risk evaluation.",
        sourceMember.outcomeIndex,
      );
    }

    const feeRatePromises = [
      this.getFeeRateBps(sourceState.market, sourceState.market.noTokenId),
      ...targetContexts.map((context) => this.getFeeRateBps(context.state.market, context.state.market.yesTokenId)),
    ];
    const feeRates = await Promise.all(feeRatePromises);
    const sourceFeeRateBps = feeRates[0] ?? 0;
    const targetFeeRateBps = feeRates.slice(1);

    if (!this.config.allowFeeMarkets && feeRates.some((rate) => rate > 0)) {
      return this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "Fee-enabled neg-risk group skipped by configuration.",
        sourceMember.outcomeIndex,
      );
    }

    let bestAssessment: NegRiskAssessment | undefined;
    let bestRejectedAssessment: NegRiskAssessment | undefined;

    for (const candidateSize of candidateSizes.toSorted((left, right) => right - left)) {
      const sourceNoFill = this.estimateBuyFill(allowedNoAsks, candidateSize);
      if (sourceNoFill.executableSize < candidateSize) {
        continue;
      }

      const convertOutputSize = round(candidateSize * convertMultiplier, 6);
      if (convertOutputSize <= 0) {
        continue;
      }

      const targetFills = targetContexts.map((context) =>
        this.estimateSellFill(context.allowedBids, convertOutputSize),
      );
      if (targetFills.some((fill) => fill.executableSize < convertOutputSize)) {
        continue;
      }

      const sourceFee = this.estimateFee(sourceState.market, sourceNoFill, sourceFeeRateBps);
      const targetLegs = targetContexts.map((context, index) => {
        const fill = targetFills[index]!;
        const fee = this.estimateFee(context.state.market, fill, targetFeeRateBps[index] ?? 0);
        return {
          ...fill,
          market: context.state.market,
          tokenId: context.state.market.yesTokenId,
          bestBid: context.bestBid,
          fee,
          outcomeIndex: context.member.outcomeIndex,
          outputSize: convertOutputSize,
        };
      });

      const totalSpendUsd = sourceNoFill.totalCost;
      const totalProceedsUsd = sum(targetLegs.map((leg) => leg.totalCost));
      const totalFeesUsd = sourceFee.feeUsd + sum(targetLegs.map((leg) => leg.fee.feeUsd));
      const estimatedSlippageUsd =
        this.estimateSweepSlippageUsd(sourceNoFill, bestNoAsk) +
        sum(targetLegs.map((leg) => this.estimateSellSweepSlippageUsd(leg, leg.bestBid)));
      const grossEdgeUsd = totalProceedsUsd - totalSpendUsd;
      const expectedProfitUsd =
        grossEdgeUsd - totalFeesUsd - this.config.gasCostUsd - estimatedSlippageUsd;
      const expectedProfitPct = totalSpendUsd > 0 ? expectedProfitUsd / totalSpendUsd : 0;
      const requiredProfitUsd = totalSpendUsd * this.config.minProfitThreshold;
      const thresholdDeltaUsd = expectedProfitUsd - requiredProfitUsd;

      const candidateAssessment: NegRiskAssessment = {
        viable: false,
        reason: "No candidate size cleared min profit for neg-risk arb after fees, gas, and slippage.",
        strategyType: "neg_risk_arb",
        market: sourceState.market,
        timestamp: now,
        tradeSize: round(candidateSize, 6),
        groupId: group.id,
        groupSlug: group.slug,
        groupQuestion: group.title,
        sourceOutcomeIndex: sourceMember.outcomeIndex,
        negRiskMarketId: group.negRiskMarketId,
        convertFeeBps: group.convertFeeBps,
        convertOutputSize,
        sourceNo: {
          ...sourceNoFill,
          tokenId: sourceState.market.noTokenId,
          bestAsk: bestNoAsk,
          fee: sourceFee,
        },
        targetYesLegs: targetLegs,
        arb: round(roughArb, 6),
        grossEdgeUsd: round(grossEdgeUsd, 6),
        totalFeesUsd: round(totalFeesUsd, 6),
        estimatedSlippageUsd: round(estimatedSlippageUsd, 6),
        totalSpendUsd: round(totalSpendUsd, 6),
        totalProceedsUsd: round(totalProceedsUsd, 6),
        gasUsd: this.config.gasCostUsd,
        expectedProfitUsd: round(expectedProfitUsd, 6),
        expectedProfitPct: round(expectedProfitPct, 6),
        netEdgePerShare: round(expectedProfitUsd / candidateSize, 6),
        rawSpreadUsd: round(roughArb, 6),
        sourceNoCostUsd: round(totalSpendUsd, 6),
        targetYesProceedsUsd: round(totalProceedsUsd, 6),
        requiredProfitUsd: round(requiredProfitUsd, 6),
        thresholdDeltaUsd: round(thresholdDeltaUsd, 6),
      };

      if (expectedProfitUsd <= 0 || expectedProfitPct < this.config.minProfitThreshold) {
        if (
          !bestRejectedAssessment ||
          (candidateAssessment.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY) >
            (bestRejectedAssessment.thresholdDeltaUsd ?? Number.NEGATIVE_INFINITY)
        ) {
          bestRejectedAssessment = candidateAssessment;
        }
        continue;
      }

      if (!options?.skipBalanceChecks) {
        const collateral = await this.wallet.getCollateralStatus();
        const availableBuffer = this.config.maxOpenNotional - this.getOpenNotionalUsd();

        if (collateral.balance < totalSpendUsd) {
          return this.buildNegRiskFailure(
            group,
            sourceState.market,
            now,
            `Insufficient balance. need=${totalSpendUsd.toFixed(4)} balance=${collateral.balance.toFixed(4)}`,
            sourceMember.outcomeIndex,
            candidateAssessment,
          );
        }

        if (collateral.allowance < totalSpendUsd) {
          return this.buildNegRiskFailure(
            group,
            sourceState.market,
            now,
            `Insufficient allowance. need=${totalSpendUsd.toFixed(4)} allowance=${collateral.allowance.toFixed(4)}`,
            sourceMember.outcomeIndex,
            candidateAssessment,
          );
        }

        if (availableBuffer < totalSpendUsd) {
          return this.buildNegRiskFailure(
            group,
            sourceState.market,
            now,
            `Open notional cap reached. available=${availableBuffer.toFixed(4)} need=${totalSpendUsd.toFixed(4)}`,
            sourceMember.outcomeIndex,
            candidateAssessment,
          );
        }
      }
      const assessment: NegRiskAssessment = {
        ...candidateAssessment,
        viable: true,
        reason: undefined,
      };

      if (!bestAssessment || assessment.expectedProfitUsd > bestAssessment.expectedProfitUsd) {
        bestAssessment = assessment;
      }
    }

    return (
      bestAssessment ??
      bestRejectedAssessment ??
      this.buildNegRiskFailure(
        group,
        sourceState.market,
        now,
        "No candidate size cleared min profit for neg-risk arb after fees, gas, and slippage.",
        sourceMember.outcomeIndex,
        {
          rawSpreadUsd: round(roughArb, 6),
          convertFeeBps: group.convertFeeBps,
        },
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

  private buildCandidateSizesFromGroups(
    groups: Array<Array<{ price: number; size: number }>>,
    maxSize: number,
  ): number[] {
    const sizes = new Set<number>();

    for (const levels of groups) {
      let cumulative = 0;
      for (const level of levels) {
        cumulative += level.size;
        sizes.add(round(Math.min(cumulative, maxSize), 6));
      }
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

  private estimateSellFill(levels: Array<{ price: number; size: number }>, requestedSize: number): FillEstimate {
    let remaining = requestedSize;
    let totalProceeds = 0;
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

      totalProceeds += take * level.price;
      remaining -= take;
      levelsConsumed += 1;
      worstPrice = level.price;
    }

    const executableSize = requestedSize - remaining;
    const averagePrice = executableSize > 0 ? totalProceeds / executableSize : 0;
    const bestBid = levels[0]?.price ?? averagePrice;
    const slippagePct = bestBid > 0 ? (bestBid - worstPrice) / bestBid : 0;

    return {
      requestedSize: round(requestedSize, 6),
      executableSize: round(executableSize, 6),
      totalCost: round(totalProceeds, 6),
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
    const feeUsd = fill.executableSize * feeRate * p * (1 - p);
    const feeShares = p > 0 ? feeUsd / p : 0;

    return {
      feeRateBps,
      feeRate: round(feeRate, 6),
      feeExponent,
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

  private estimateSellSweepSlippageUsd(fill: FillEstimate, bestBid: number): number {
    if (fill.executableSize <= 0 || bestBid <= 0) {
      return 0;
    }

    const baselineProceeds = fill.executableSize * bestBid;
    return round(Math.max(0, baselineProceeds - fill.totalCost), 6);
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

  private buildCeilingFailure(
    market: MarketDefinition,
    timestamp: number,
    direction: ArbitrageDirection,
    reason: string,
  ): CeilingAssessment {
    return {
      viable: false,
      reason,
      strategyType: "binary_ceiling",
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
        bestBid: 0,
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
        bestBid: 0,
        fee: {
          feeRateBps: 0,
          feeRate: 0,
          feeExponent: 1,
          feeUsd: 0,
          feeShares: 0,
        },
      },
      arb: 0,
      collateralRequiredUsd: 0,
      grossEdgeUsd: 0,
      totalFeesUsd: 0,
      estimatedSlippageUsd: 0,
      totalProceedsUsd: 0,
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

  private buildNegRiskFailure(
    group: NegRiskGroup,
    market: MarketDefinition,
    timestamp: number,
    reason: string,
    sourceOutcomeIndex: number,
    diagnostics?: Partial<NegRiskAssessment>,
  ): NegRiskAssessment {
    return {
      viable: false,
      reason,
      strategyType: "neg_risk_arb",
      market,
      timestamp,
      tradeSize: 0,
      groupId: group.id,
      groupSlug: group.slug,
      groupQuestion: group.title,
      sourceOutcomeIndex,
      negRiskMarketId: group.negRiskMarketId,
      convertFeeBps: diagnostics?.convertFeeBps ?? group.convertFeeBps,
      convertOutputSize: diagnostics?.convertOutputSize ?? 0,
      sourceNo: {
        tokenId: diagnostics?.sourceNo?.tokenId ?? market.noTokenId,
        requestedSize: diagnostics?.sourceNo?.requestedSize ?? 0,
        executableSize: diagnostics?.sourceNo?.executableSize ?? 0,
        totalCost: diagnostics?.sourceNo?.totalCost ?? 0,
        averagePrice: diagnostics?.sourceNo?.averagePrice ?? 0,
        worstPrice: diagnostics?.sourceNo?.worstPrice ?? 0,
        slippagePct: diagnostics?.sourceNo?.slippagePct ?? 0,
        levelsConsumed: diagnostics?.sourceNo?.levelsConsumed ?? 0,
        bestAsk: diagnostics?.sourceNo?.bestAsk ?? 0,
        fee: diagnostics?.sourceNo?.fee ?? {
          feeRateBps: 0,
          feeRate: 0,
          feeExponent: 1,
          feeUsd: 0,
          feeShares: 0,
        },
      },
      targetYesLegs: diagnostics?.targetYesLegs ?? [],
      arb: diagnostics?.arb ?? diagnostics?.rawSpreadUsd ?? 0,
      grossEdgeUsd: diagnostics?.grossEdgeUsd ?? 0,
      totalFeesUsd: diagnostics?.totalFeesUsd ?? 0,
      estimatedSlippageUsd: diagnostics?.estimatedSlippageUsd ?? 0,
      totalSpendUsd: diagnostics?.totalSpendUsd ?? diagnostics?.sourceNoCostUsd ?? 0,
      totalProceedsUsd: diagnostics?.totalProceedsUsd ?? diagnostics?.targetYesProceedsUsd ?? 0,
      gasUsd: this.config.gasCostUsd,
      expectedProfitUsd: diagnostics?.expectedProfitUsd ?? 0,
      expectedProfitPct: diagnostics?.expectedProfitPct ?? 0,
      netEdgePerShare: diagnostics?.netEdgePerShare ?? 0,
      rawSpreadUsd: diagnostics?.rawSpreadUsd,
      sourceNoCostUsd: diagnostics?.sourceNoCostUsd,
      targetYesProceedsUsd: diagnostics?.targetYesProceedsUsd,
      requiredProfitUsd: diagnostics?.requiredProfitUsd,
      thresholdDeltaUsd: diagnostics?.thresholdDeltaUsd,
    };
  }
}
