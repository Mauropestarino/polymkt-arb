import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { MarketDefinition, NegRiskGroup, NegRiskGroupMember } from "./types.js";

type RawEvent = Record<string, unknown>;

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

export class NegRiskCatalog {
  private readonly groupsById = new Map<string, NegRiskGroup>();
  private readonly groupIdByConditionId = new Map<string, string>();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  async refresh(availableMarkets: MarketDefinition[]): Promise<void> {
    const trackedByConditionId = new Map(
      availableMarkets.map((market) => [market.conditionId, market] as const),
    );
    const groups: NegRiskGroup[] = [];
    let offset = 0;
    const pageSize = Math.min(this.config.marketPageSize, 100);

    while (true) {
      const url = new URL("/events", this.config.gammaApiUrl);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));

      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Unable to fetch Gamma events: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as RawEvent[];
      for (const event of payload) {
        const group = this.normalizeGroup(event, trackedByConditionId);
        if (group) {
          groups.push(group);
        }
      }

      if (payload.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    this.groupsById.clear();
    this.groupIdByConditionId.clear();

    for (const group of groups) {
      this.groupsById.set(group.id, group);
      for (const member of group.members) {
        this.groupIdByConditionId.set(member.conditionId, group.id);
      }
    }

    this.logger.info(
      { groups: groups.length, trackedMembers: this.groupIdByConditionId.size },
      "Neg-risk catalog refreshed",
    );
  }

  getGroupById(groupId: string): NegRiskGroup | undefined {
    return this.groupsById.get(groupId);
  }

  getGroupByConditionId(conditionId: string): NegRiskGroup | undefined {
    const groupId = this.groupIdByConditionId.get(conditionId);
    return groupId ? this.groupsById.get(groupId) : undefined;
  }

  private normalizeGroup(
    raw: RawEvent,
    trackedByConditionId: Map<string, MarketDefinition>,
  ): NegRiskGroup | undefined {
    const negRisk =
      asBoolean(raw.negRisk) ??
      asBoolean(raw.neg_risk) ??
      false;
    const augmented =
      asBoolean(raw.negRiskAugmented) ??
      asBoolean(raw.neg_risk_augmented) ??
      asBoolean(raw.enableNegRiskAugmented) ??
      false;

    if (!negRisk || augmented) {
      return undefined;
    }

    const negRiskMarketId =
      asString(raw.negRiskMarketID) ??
      asString(raw.negRiskMarketId) ??
      asString(raw.neg_risk_market_id);
    if (!negRiskMarketId) {
      return undefined;
    }

    const rawMarkets = Array.isArray(raw.markets)
      ? (raw.markets as Array<Record<string, unknown>>)
      : [];
    if (rawMarkets.length < 3) {
      return undefined;
    }

    const members: NegRiskGroupMember[] = [];

    for (const [index, marketPayload] of rawMarkets.entries()) {
      const active =
        asBoolean(marketPayload.active) ??
        true;
      const closed =
        asBoolean(marketPayload.closed) ??
        false;
      const archived =
        asBoolean(marketPayload.archived) ??
        false;
      const enableOrderBook =
        asBoolean(marketPayload.enableOrderBook) ??
        asBoolean(marketPayload.enable_order_book) ??
        true;
      const conditionId =
        asString(marketPayload.conditionId) ??
        asString(marketPayload.condition_id);

      if (!active || closed || archived || !enableOrderBook || !conditionId) {
        return undefined;
      }

      const trackedMarket = trackedByConditionId.get(conditionId);
      if (!trackedMarket || !trackedMarket.negRisk) {
        return undefined;
      }

      members.push({
        conditionId,
        marketId: trackedMarket.id,
        slug: trackedMarket.slug,
        question: trackedMarket.question,
        outcomeIndex: index,
      });
    }

    const eventId = asString(raw.id) ?? negRiskMarketId;
    const slug = asString(raw.slug) ?? eventId;
    const title = asString(raw.title) ?? asString(raw.question) ?? slug;
    const convertFeeBps =
      asNumber(raw.negRiskFeeBips) ??
      asNumber(raw.negRiskFeeBps) ??
      asNumber(raw.neg_risk_fee_bips) ??
      0;

    return {
      id: negRiskMarketId,
      eventId,
      slug,
      title,
      negRiskMarketId,
      convertFeeBps,
      augmented: false,
      members,
    };
  }
}
