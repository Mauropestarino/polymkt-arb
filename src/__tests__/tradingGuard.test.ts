import { ApiError } from "@polymarket/clob-client";
import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { TradingGuard } from "../tradingGuard.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  killSwitch425PauseMs: 5_000,
  killSwitch429PauseMs: 15_000,
  killSwitch503PauseMs: 60_000,
  ...overrides,
});

describe("trading guard", () => {
  it("pauses trading on 429 rate-limit errors", () => {
    const guard = new TradingGuard(createTestConfig(), console as never);
    const status = guard.handleError(
      new ApiError("Too Many Requests", 429),
      "post_orders",
    );

    expect(status?.tradingEnabled).toBe(false);
    expect(status?.pauseReason).toBe("rate_limit");
    expect(guard.isTradingEnabled(status?.resumeAt ? status.resumeAt - 1 : Date.now())).toBe(false);
  });

  it("re-enables trading after the configured pause elapses", () => {
    const guard = new TradingGuard(createTestConfig({ killSwitch425PauseMs: 1_000 }), console as never);
    const status = guard.handleError(
      new ApiError("matching engine restarting", 425),
      "post_orders",
    );
    const resumeAt = status?.resumeAt ?? Date.now();

    expect(guard.isTradingEnabled(resumeAt + 1)).toBe(true);
  });

  it("recognizes cancel-only 503 responses as a hard pause reason", () => {
    const guard = new TradingGuard(createTestConfig(), console as never);
    const status = guard.handleError(
      new ApiError("exchange in cancel-only mode", 503),
      "post_orders",
    );

    expect(status?.pauseReason).toBe("cancel_only");
    expect(status?.tradingEnabled).toBe(false);
  });
});
