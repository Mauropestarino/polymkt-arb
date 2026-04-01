import { Contract, ZeroHash, parseUnits } from "ethers";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { round } from "./lib/utils.js";
import type { SettlementReceipt } from "./types.js";
import { WalletService } from "./wallet.js";

interface ConditionalTokensContractLike {
  mergePositions(
    collateralToken: string,
    parentCollectionId: string,
    conditionId: string,
    partition: number[],
    amount: bigint,
  ): Promise<{
    hash: string;
    wait(): Promise<{
      status?: number;
      blockNumber?: number;
      gasUsed?: bigint;
    }>;
  }>;
  splitPosition(
    collateralToken: string,
    parentCollectionId: string,
    conditionId: string,
    partition: number[],
    amount: bigint,
  ): Promise<{
    hash: string;
    wait(): Promise<{
      status?: number;
      blockNumber?: number;
      gasUsed?: bigint;
    }>;
  }>;
  redeemPositions(
    collateralToken: string,
    parentCollectionId: string,
    conditionId: string,
    indexSets: number[],
  ): Promise<{
    hash: string;
    wait(): Promise<{
      status?: number;
      blockNumber?: number;
      gasUsed?: bigint;
    }>;
  }>;
  isApprovedForAll(account: string, operator: string): Promise<boolean>;
}

interface NegRiskAdapterContractLike {
  convertPositions(
    marketId: string,
    indexSet: bigint,
    amount: bigint,
  ): Promise<{
    hash: string;
    wait(): Promise<{
      status?: number;
      blockNumber?: number;
      gasUsed?: bigint;
    }>;
  }>;
}

type ContractFactory = () => ConditionalTokensContractLike;
type AdapterFactory = () => NegRiskAdapterContractLike;

const CONDITIONAL_TOKENS_ABI = [
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
] as const;

const NEG_RISK_ADAPTER_ABI = [
  "function convertPositions(bytes32 _marketId, uint256 _indexSet, uint256 _amount)",
] as const;

const FULL_SET_PARTITION = [1, 2];
const COLLATERAL_DECIMALS = 6;

export class CtfSettlementService {
  private readonly contractFactory: ContractFactory;
  private readonly adapterFactory: AdapterFactory;

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly logger: Logger,
    contractFactory?: ContractFactory,
    adapterFactory?: AdapterFactory,
  ) {
    this.contractFactory =
      contractFactory ??
      (() =>
        new Contract(
          this.config.ctfContractAddress!,
          CONDITIONAL_TOKENS_ABI,
          this.wallet.requireOnchainSigner(),
        ) as unknown as ConditionalTokensContractLike);
    this.adapterFactory =
      adapterFactory ??
      (() =>
        new Contract(
          this.config.negRiskAdapterAddress!,
          NEG_RISK_ADAPTER_ABI,
          this.wallet.requireOnchainSigner(),
        ) as unknown as NegRiskAdapterContractLike);
  }

  isEnabled(): boolean {
    return this.wallet.hasOnchainSigner() && Boolean(this.config.ctfContractAddress);
  }

  canConvertNegRisk(): boolean {
    return this.isEnabled() && Boolean(this.config.negRiskAdapterAddress);
  }

  async mergeFullSet(conditionId: string, amount: number): Promise<SettlementReceipt> {
    const normalizedAmount = this.toAmount(amount);
    this.logger.info({ conditionId, amount: normalizedAmount }, "Submitting CTF mergePositions");

    const tx = await this.contractFactory().mergePositions(
      this.config.usdcCollateralAddress!,
      ZeroHash,
      conditionId,
      FULL_SET_PARTITION,
      this.toUnits(normalizedAmount),
    );

    return this.waitForReceipt("merge", conditionId, normalizedAmount, tx.hash, () => tx.wait());
  }

  async splitFullSet(conditionId: string, amount: number): Promise<SettlementReceipt> {
    const normalizedAmount = this.toAmount(amount);
    this.logger.info({ conditionId, amount: normalizedAmount }, "Submitting CTF splitPosition");

    const tx = await this.contractFactory().splitPosition(
      this.config.usdcCollateralAddress!,
      ZeroHash,
      conditionId,
      FULL_SET_PARTITION,
      this.toUnits(normalizedAmount),
    );

    return this.waitForReceipt("split", conditionId, normalizedAmount, tx.hash, () => tx.wait());
  }

  async redeemPosition(conditionId: string, indexSets: number[]): Promise<SettlementReceipt> {
    const normalizedIndexSets = indexSets.length > 0 ? indexSets : FULL_SET_PARTITION;
    this.logger.info(
      { conditionId, indexSets: normalizedIndexSets },
      "Submitting CTF redeemPositions",
    );

    const tx = await this.contractFactory().redeemPositions(
      this.config.usdcCollateralAddress!,
      ZeroHash,
      conditionId,
      normalizedIndexSets,
    );

    return this.waitForReceipt("redeem", conditionId, normalizedIndexSets.length, tx.hash, () => tx.wait());
  }

  async convertNegRiskPosition(
    conditionId: string,
    negRiskMarketId: string,
    outcomeIndex: number,
    amount: number,
  ): Promise<SettlementReceipt> {
    if (!this.canConvertNegRisk()) {
      throw new Error("Neg-risk adapter is not configured for on-chain conversion.");
    }

    const normalizedAmount = this.toAmount(amount);
    await this.assertNegRiskApproval();
    this.logger.info(
      { conditionId, negRiskMarketId, outcomeIndex, amount: normalizedAmount },
      "Submitting neg-risk convertPositions",
    );

    const tx = await this.adapterFactory().convertPositions(
      negRiskMarketId,
      1n << BigInt(outcomeIndex),
      this.toUnits(normalizedAmount),
    );

    return this.waitForReceipt("convert", conditionId, normalizedAmount, tx.hash, () => tx.wait());
  }

  private async waitForReceipt(
    action: SettlementReceipt["action"],
    conditionId: string,
    amount: number,
    txHash: string,
    waitForReceipt: () => Promise<{ status?: number; blockNumber?: number; gasUsed?: bigint }>,
  ): Promise<SettlementReceipt> {
    const receipt = await waitForReceipt();
    if (receipt.status !== undefined && receipt.status !== 1) {
      throw new Error(`CTF ${action} transaction reverted.`);
    }

    return {
      action,
      conditionId,
      amount,
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString(),
      confirmedAt: Date.now(),
    };
  }

  private toUnits(amount: number): bigint {
    return parseUnits(amount.toFixed(COLLATERAL_DECIMALS), COLLATERAL_DECIMALS);
  }

  private toAmount(amount: number): number {
    const normalized = round(amount, COLLATERAL_DECIMALS);
    if (normalized <= 0) {
      throw new Error("Settlement amount must be positive.");
    }

    return normalized;
  }

  private async assertNegRiskApproval(): Promise<void> {
    const operator = this.config.negRiskAdapterAddress;
    if (!operator) {
      throw new Error("NEG_RISK_ADAPTER_ADDRESS is required for neg-risk conversion.");
    }

    const owner = await this.wallet.requireOnchainSigner().getAddress();
    const approved = await this.contractFactory().isApprovedForAll(owner, operator);
    if (!approved) {
      throw new Error(
        "Conditional Tokens are not approved for the neg-risk adapter. Grant ERC-1155 approval before enabling live neg-risk conversion.",
      );
    }
  }
}
