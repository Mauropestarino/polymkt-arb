import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { runGeoblockPreflight } from "../preflight.js";

const createTestConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  botMode: "live",
  dryRun: false,
  enforceGeoblock: true,
  geoblockUrl: "https://polymarket.com/api/geoblock",
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("geoblock preflight", () => {
  it("aborts live startup when the geoblock endpoint reports a blocked IP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ blocked: true, country: "US" }),
      }),
    );

    await expect(
      runGeoblockPreflight(createTestConfig(), console as never),
    ).rejects.toThrow(/blocked/i);
  });

  it("warns but continues in dry-run mode when blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ blocked: true, country: "US" }),
      }),
    );
    const logger = {
      warn: vi.fn(),
    };

    await expect(
      runGeoblockPreflight(createTestConfig({ dryRun: true }), logger as never),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
