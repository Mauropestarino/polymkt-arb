import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { DataApiClient } from "../dataApi.js";

const createConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  ...overrides,
});

const createLoggerStub = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as const;

describe("data api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes positions and value payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            proxyWallet: "0xuser",
            asset: "yes-token",
            conditionId: "condition-1",
            size: "10",
            currentValue: "4.8",
            mergeable: true,
            redeemable: false,
            outcome: "Yes",
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ user: "0xuser", value: "123.45" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DataApiClient(createConfig(), createLoggerStub() as never);
    const positions = await client.getPositions({
      user: "0xuser",
      market: "condition-1",
      sizeThreshold: 0,
    });
    const value = await client.getValue({
      user: "0xuser",
      market: "condition-1",
    });

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      proxyWallet: "0xuser",
      asset: "yes-token",
      conditionId: "condition-1",
      size: 10,
      currentValue: 4.8,
      mergeable: true,
      redeemable: false,
      outcome: "Yes",
    });
    expect(value).toEqual({ user: "0xuser", value: 123.45 });

    const positionsUrl = fetchMock.mock.calls[0]?.[0] as URL;
    const valueUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(positionsUrl.toString()).toContain("/positions");
    expect(positionsUrl.searchParams.get("market")).toBe("condition-1");
    expect(valueUrl.toString()).toContain("/value");
  });
});
