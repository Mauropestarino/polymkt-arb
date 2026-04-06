import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { NegRiskCatalog } from "../negRiskCatalog.js";
import type { MarketDefinition } from "../types.js";

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

const trackedMarkets: MarketDefinition[] = [
  {
    id: "market-a",
    conditionId: "condition-a",
    slug: "candidate-a",
    question: "Candidate A wins?",
    category: "politics",
    active: true,
    closed: false,
    liquidity: 1_000,
    volume24hr: 1_000,
    yesTokenId: "yes-a",
    noTokenId: "no-a",
    yesLabel: "Yes",
    noLabel: "No",
    negRisk: true,
  },
  {
    id: "market-b",
    conditionId: "condition-b",
    slug: "candidate-b",
    question: "Candidate B wins?",
    category: "politics",
    active: true,
    closed: false,
    liquidity: 1_000,
    volume24hr: 1_000,
    yesTokenId: "yes-b",
    noTokenId: "no-b",
    yesLabel: "Yes",
    noLabel: "No",
    negRisk: true,
  },
  {
    id: "market-c",
    conditionId: "condition-c",
    slug: "candidate-c",
    question: "Candidate C wins?",
    category: "politics",
    active: true,
    closed: false,
    liquidity: 1_000,
    volume24hr: 1_000,
    yesTokenId: "yes-c",
    noTokenId: "no-c",
    yesLabel: "Yes",
    noLabel: "No",
    negRisk: true,
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("neg risk catalog", () => {
  it("normalizes active non-augmented neg-risk groups", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: "event-1",
            slug: "election",
            title: "Election winner",
            negRisk: true,
            negRiskMarketID:
              "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            negRiskFeeBips: 15,
            markets: [
              { conditionId: "condition-a", active: true, closed: false, enableOrderBook: true },
              { conditionId: "condition-b", active: true, closed: false, enableOrderBook: true },
              { conditionId: "condition-c", active: true, closed: false, enableOrderBook: true },
            ],
          },
        ],
      }),
    );

    const catalog = new NegRiskCatalog(createConfig(), createLoggerStub() as never);
    await catalog.refresh(trackedMarkets);

    const group = catalog.getGroupByConditionId("condition-b");
    expect(group).toBeDefined();
    expect(group?.id).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(group?.convertFeeBps).toBe(15);
    expect(group?.members.map((member) => member.outcomeIndex)).toEqual([0, 1, 2]);
  });

  it("skips augmented neg-risk events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: "event-1",
            slug: "augmented-election",
            title: "Election winner",
            negRisk: true,
            negRiskAugmented: true,
            negRiskMarketID:
              "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            markets: [
              { conditionId: "condition-a", active: true, closed: false, enableOrderBook: true },
              { conditionId: "condition-b", active: true, closed: false, enableOrderBook: true },
              { conditionId: "condition-c", active: true, closed: false, enableOrderBook: true },
            ],
          },
        ],
      }),
    );

    const catalog = new NegRiskCatalog(createConfig(), createLoggerStub() as never);
    await catalog.refresh(trackedMarkets);

    expect(catalog.getGroupByConditionId("condition-a")).toBeUndefined();
  });
});
