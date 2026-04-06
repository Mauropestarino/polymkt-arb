import { describe, expect, it } from "vitest";
import { OrderBookStore } from "../orderBookStore.js";

describe("order book store", () => {
  it("updates the tracked tick size when the market WebSocket emits tick_size_change", () => {
    const store = new OrderBookStore();
    store.registerMarket({
      id: "market-1",
      conditionId: "condition-1",
      slug: "synthetic-market",
      question: "Synthetic market",
      category: "sports",
      active: true,
      closed: false,
      liquidity: 10_000,
      volume24hr: 10_000,
      yesTokenId: "yes-token",
      noTokenId: "no-token",
      yesLabel: "Yes",
      noLabel: "No",
      tickSizeHint: 0.01,
      minOrderSize: 1,
      negRisk: false,
    });

    store.applySnapshot("yes-token", [], [{ price: 0.48, size: 10 }], 1_000, { tickSize: 0.01 });
    const state = store.applyTickSizeChange("yes-token", 0.001, 2_000);

    expect(state?.yes.tickSize).toBe(0.001);
    expect(state?.market.tickSizeHint).toBe(0.001);
  });
});
