import { AssetType, ClobClient, type ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";

export interface CollateralStatus {
  balance: number;
  allowance: number;
  updatedAt: number;
}

export class WalletService {
  readonly publicClient: ClobClient;
  readonly signer?: Wallet;
  readonly apiCreds?: ApiKeyCreds;
  readonly tradingClient?: ClobClient;
  readonly funderAddress?: string;

  private collateralStatus?: CollateralStatus;

  private constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    publicClient: ClobClient,
    signer?: Wallet,
    apiCreds?: ApiKeyCreds,
    tradingClient?: ClobClient,
    funderAddress?: string,
  ) {
    this.publicClient = publicClient;
    this.signer = signer;
    this.apiCreds = apiCreds;
    this.tradingClient = tradingClient;
    this.funderAddress = funderAddress;
  }

  static async create(config: BotConfig, logger: Logger): Promise<WalletService> {
    const publicClient = new ClobClient(config.clobApiUrl, config.chainId);

    if (!config.privateKey) {
      return new WalletService(config, logger, publicClient);
    }

    const signer = new Wallet(config.privateKey);
    const funderAddress = config.funderAddress ?? signer.address;
    const baseClient = new ClobClient(config.clobApiUrl, config.chainId, signer);

    const apiCreds =
      config.polyApiKey && config.polyApiSecret && config.polyApiPassphrase
        ? {
            key: config.polyApiKey,
            secret: config.polyApiSecret,
            passphrase: config.polyApiPassphrase,
          }
        : await baseClient.createOrDeriveApiKey();

    const tradingClient = new ClobClient(
      config.clobApiUrl,
      config.chainId,
      signer,
      apiCreds,
      config.polySignatureType,
      funderAddress,
    );

    logger.info(
      {
        signer: signer.address,
        funderAddress,
        signatureType: config.polySignatureType,
        dryRun: config.dryRun,
      },
      "Wallet initialized",
    );

    return new WalletService(
      config,
      logger,
      publicClient,
      signer,
      apiCreds,
      tradingClient,
      funderAddress,
    );
  }

  hasTradingClient(): boolean {
    return Boolean(this.tradingClient);
  }

  requireTradingClient(): ClobClient {
    if (!this.tradingClient) {
      throw new Error(
        "Trading client is not initialized. Provide PRIVATE_KEY and Polymarket credentials to enable live execution.",
      );
    }

    return this.tradingClient;
  }

  async getCollateralStatus(force = false): Promise<CollateralStatus> {
    if (!this.tradingClient) {
      return {
        balance: Number.POSITIVE_INFINITY,
        allowance: Number.POSITIVE_INFINITY,
        updatedAt: Date.now(),
      };
    }

    if (
      !force &&
      this.collateralStatus &&
      Date.now() - this.collateralStatus.updatedAt < this.config.balanceCacheTtlMs
    ) {
      return this.collateralStatus;
    }

    try {
      await this.tradingClient.updateBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });

      const payload = (await this.tradingClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      })) as unknown as Record<string, unknown>;

      const balance = Number(payload.balance ?? payload.available_balance ?? payload.availableBalance ?? 0);
      const allowance = Number(payload.allowance ?? payload.totalAllowance ?? payload.allowances ?? 0);

      this.collateralStatus = {
        balance,
        allowance,
        updatedAt: Date.now(),
      };

      return this.collateralStatus;
    } catch (error) {
      this.logger.warn({ error }, "Unable to refresh collateral balance/allowance");

      if (this.collateralStatus) {
        return this.collateralStatus;
      }

      throw error;
    }
  }
}
