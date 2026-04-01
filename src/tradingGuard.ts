import { ApiError } from "@polymarket/clob-client";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { TradingGuardStatus, TradingPauseReason } from "./types.js";

interface ClassifiedTradingError {
  pauseReason: TradingPauseReason;
  pauseMessage: string;
  pauseMs: number;
  status?: number;
}

export class TradingGuard {
  private status: TradingGuardStatus = {
    tradingEnabled: true,
  };

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  isTradingEnabled(now = Date.now()): boolean {
    this.refresh(now);
    return this.status.tradingEnabled;
  }

  getStatus(now = Date.now()): TradingGuardStatus {
    this.refresh(now);
    return { ...this.status };
  }

  handleError(error: unknown, source: string): TradingGuardStatus | undefined {
    const classified = this.classifyError(error);
    if (!classified) {
      return undefined;
    }

    const now = Date.now();
    const currentResumeAt = this.status.resumeAt ?? 0;
    const nextResumeAt = Math.max(currentResumeAt, now + classified.pauseMs);

    this.status = {
      tradingEnabled: false,
      pauseReason: classified.pauseReason,
      pauseMessage: classified.pauseMessage,
      pausedAt: this.status.tradingEnabled ? now : this.status.pausedAt ?? now,
      resumeAt: nextResumeAt,
    };

    this.logger.warn(
      {
        source,
        reason: classified.pauseReason,
        status: classified.status,
        pauseMs: classified.pauseMs,
        resumeAt: nextResumeAt,
        message: classified.pauseMessage,
      },
      "Trading paused by kill switch",
    );

    return this.getStatus(now);
  }

  private refresh(now: number): void {
    if (this.status.tradingEnabled) {
      return;
    }

    const resumeAt = this.status.resumeAt;
    if (!resumeAt || now < resumeAt) {
      return;
    }

    this.logger.info(
      {
        previousReason: this.status.pauseReason,
        pausedAt: this.status.pausedAt,
        resumeAt,
      },
      "Trading kill switch pause expired; re-enabling trading",
    );
    this.status = {
      tradingEnabled: true,
    };
  }

  private classifyError(error: unknown): ClassifiedTradingError | undefined {
    const status = this.getStatusCode(error);
    const message = this.getErrorMessage(error).toLowerCase();

    if (status === 429 || message.includes("too many requests")) {
      return {
        pauseReason: "rate_limit",
        pauseMessage: this.getErrorMessage(error),
        pauseMs: this.config.killSwitch429PauseMs,
        status,
      };
    }

    if (
      status === 425 ||
      message.includes("too early") ||
      message.includes("matching engine restart") ||
      message.includes("matching engine restarting")
    ) {
      return {
        pauseReason: "matching_engine_restart",
        pauseMessage: this.getErrorMessage(error),
        pauseMs: this.config.killSwitch425PauseMs,
        status,
      };
    }

    if (status === 503 && (message.includes("cancel-only") || message.includes("cancel only"))) {
      return {
        pauseReason: "cancel_only",
        pauseMessage: this.getErrorMessage(error),
        pauseMs: this.config.killSwitch503PauseMs,
        status,
      };
    }

    if (
      status === 503 &&
      (message.includes("trading disabled") || message.includes("closed only"))
    ) {
      return {
        pauseReason: "trading_disabled",
        pauseMessage: this.getErrorMessage(error),
        pauseMs: this.config.killSwitch503PauseMs,
        status,
      };
    }

    return undefined;
  }

  private getStatusCode(error: unknown): number | undefined {
    if (error instanceof ApiError) {
      return error.status;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof (error as { status?: unknown }).status === "number"
    ) {
      return (error as { status: number }).status;
    }

    return undefined;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === "string") {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
