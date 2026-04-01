import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type {
  ExecutionResult,
  LateResolutionAssessment,
  RiskAssessment,
} from "./types.js";

export class AlertService {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  async notifyOpportunity(assessment: RiskAssessment | LateResolutionAssessment): Promise<void> {
    if (!assessment.viable) {
      return;
    }

    const message = this.isLateResolutionAssessment(assessment)
      ? [
          "Polymarket late-resolution opportunity",
          assessment.market.question,
          `Resolved side: ${assessment.resolvedOutcome}`,
          `Ask: ${assessment.leg.bestAsk.toFixed(4)}`,
          `Size: ${assessment.tradeSize.toFixed(4)}`,
          `Expected profit: $${assessment.expectedProfitUsd.toFixed(4)} (${(assessment.expectedProfitPct * 100).toFixed(2)}%)`,
        ].join("\n")
      : [
          "Polymarket arb opportunity",
          assessment.market.question,
          `Arb: ${assessment.arb.toFixed(4)}`,
          `Size: ${assessment.tradeSize.toFixed(4)}`,
          `Expected profit: $${assessment.expectedProfitUsd.toFixed(4)} (${(assessment.expectedProfitPct * 100).toFixed(2)}%)`,
        ].join("\n");

    await Promise.allSettled([this.sendWebhook({ type: "opportunity", assessment }), this.sendTelegram(message)]);
  }

  async notifyTrade(result: ExecutionResult): Promise<void> {
    const message = [
      `Polymarket trade ${result.success ? "executed" : "failed"}`,
      result.market.question,
      `Strategy: ${result.strategyType}`,
      result.resolvedOutcome ? `Resolved side: ${result.resolvedOutcome}` : undefined,
      `Mode: ${result.mode}`,
      `Size: ${result.tradeSize.toFixed(4)}`,
      `Expected profit: $${result.expectedProfitUsd.toFixed(4)}`,
      `Orders: ${result.orderIds.join(", ") || "n/a"}`,
      `Notes: ${result.notes.join(" | ") || "none"}`,
    ]
      .filter(Boolean)
      .join("\n");

    await Promise.allSettled([this.sendWebhook({ type: "trade", result }), this.sendTelegram(message)]);
  }

  private async sendWebhook(payload: Record<string, unknown>): Promise<void> {
    if (!this.config.webhookUrl) {
      return;
    }

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, "Webhook delivery failed");
      }
    } catch (error) {
      this.logger.warn({ error }, "Webhook delivery errored");
    }
  }

  private async sendTelegram(text: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return;
    }

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text,
        }),
      });

      if (!response.ok) {
        this.logger.warn({ status: response.status }, "Telegram delivery failed");
      }
    } catch (error) {
      this.logger.warn({ error }, "Telegram delivery errored");
    }
  }

  private isLateResolutionAssessment(
    assessment: RiskAssessment | LateResolutionAssessment,
  ): assessment is LateResolutionAssessment {
    return "strategyType" in assessment && assessment.strategyType === "late_resolution";
  }
}
