import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { PortfolioReconciler } from "../portfolioReconciler.js";
import type { DataApiClient } from "../dataApi.js";
import type { WalletService } from "../wallet.js";

const createConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  reconcilePollIntervalMs: 1,
  reconcileMaxAttempts: 3,
  ...overrides,
});

const createLoggerStub = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as const;

describe("portfolio reconciler", () => {
  it("polls until a merged market is flat", async () => {
    const getPositions = vi
      .fn()
      .mockResolvedValueOnce([
        {
          proxyWallet: "0xuser",
          asset: "yes-token",
          conditionId: "condition-1",
          size: 10,
        },
      ])
      .mockResolvedValueOnce([]);
    const getValue = vi.fn().mockResolvedValue({ user: "0xuser", value: 42 });
    const dataApi = {
      getPositions,
      getValue,
    } as unknown as DataApiClient;
    const wallet = {
      requireProfileAddress: vi.fn().mockReturnValue("0xuser"),
    } as unknown as WalletService;

    const reconciler = new PortfolioReconciler(
      createConfig(),
      dataApi,
      wallet,
      createLoggerStub() as never,
    );

    const result = await reconciler.reconcileMarket("condition-1", "flat");

    expect(result.satisfied).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.positions).toEqual([]);
    expect(result.totalValueUsd).toBe(42);
    expect(getPositions).toHaveBeenCalledTimes(2);
  });
});
