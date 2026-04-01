import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { TradingGuard } from "./tradingGuard.js";
import { WalletService } from "./wallet.js";

export class TradingHeartbeatService {
  private interval?: NodeJS.Timeout;
  private heartbeatId?: string;

  constructor(
    private readonly config: BotConfig,
    private readonly wallet: WalletService,
    private readonly tradingGuard: TradingGuard,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.shouldRun() || this.interval) {
      return;
    }

    await this.sendHeartbeat();
    this.interval = setInterval(() => {
      void this.sendHeartbeat();
    }, this.config.tradingHeartbeatIntervalMs);
    this.interval.unref();

    this.logger.info(
      { intervalMs: this.config.tradingHeartbeatIntervalMs },
      "Trading heartbeat started",
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    this.heartbeatId = undefined;
  }

  private shouldRun(): boolean {
    return !this.config.dryRun && this.wallet.hasTradingClient() && this.config.executionOrderType === "GTC";
  }

  private async sendHeartbeat(): Promise<void> {
    try {
      const response = await this.wallet.requireTradingClient().postHeartbeat(this.heartbeatId);
      this.heartbeatId = response.heartbeat_id ?? this.heartbeatId;
    } catch (error) {
      this.tradingGuard.handleError(error, "trading_heartbeat");
      this.logger.warn({ error }, "Trading heartbeat failed");
    }
  }
}
