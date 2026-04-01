import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { PortfolioPosition, PortfolioValueSnapshot } from "./types.js";

interface GetPositionsOptions {
  user: string;
  market?: string | string[];
  sizeThreshold?: number;
  limit?: number;
  redeemable?: boolean;
  mergeable?: boolean;
}

interface GetValueOptions {
  user: string;
  market?: string | string[];
}

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const joinArrayParam = (value?: string | string[]): string | undefined => {
  if (!value) {
    return undefined;
  }

  return Array.isArray(value) ? value.join(",") : value;
};

export class DataApiClient {
  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  async getPositions(options: GetPositionsOptions): Promise<PortfolioPosition[]> {
    const response = await this.request<unknown[] | Record<string, unknown>>("/positions", {
      user: options.user,
      market: joinArrayParam(options.market),
      sizeThreshold:
        options.sizeThreshold !== undefined ? String(options.sizeThreshold) : undefined,
      limit: options.limit !== undefined ? String(options.limit) : undefined,
      redeemable:
        options.redeemable !== undefined ? String(options.redeemable) : undefined,
      mergeable:
        options.mergeable !== undefined ? String(options.mergeable) : undefined,
    });

    if (!Array.isArray(response)) {
      return [];
    }

    return response.map((row) => this.normalizePosition(row)).filter((row): row is PortfolioPosition => Boolean(row));
  }

  async getValue(options: GetValueOptions): Promise<PortfolioValueSnapshot | undefined> {
    const response = await this.request<unknown[] | Record<string, unknown>>("/value", {
      user: options.user,
      market: joinArrayParam(options.market),
    });

    if (Array.isArray(response)) {
      const [first] = response;
      return first ? this.normalizeValue(first, options.user) : undefined;
    }

    return this.normalizeValue(response, options.user);
  }

  private async request<T>(pathname: string, params: Record<string, string | undefined>): Promise<T> {
    const url = new URL(pathname, this.config.dataApiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      this.logger.warn({ pathname, status: response.status }, "Data API request failed");
      throw new Error(`Data API request failed with status ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private normalizePosition(payload: unknown): PortfolioPosition | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    const row = payload as Record<string, unknown>;
    const proxyWallet = String(row.proxyWallet ?? row.user ?? "");
    const asset = String(row.asset ?? row.asset_id ?? "");
    const conditionId = String(row.conditionId ?? row.condition_id ?? "");
    const size = toNumber(row.size) ?? 0;

    if (!asset || !conditionId || !proxyWallet) {
      return undefined;
    }

    return {
      proxyWallet,
      asset,
      conditionId,
      size,
      avgPrice: toNumber(row.avgPrice ?? row.avg_price),
      initialValue: toNumber(row.initialValue ?? row.initial_value),
      currentValue: toNumber(row.currentValue ?? row.current_value),
      cashPnl: toNumber(row.cashPnl ?? row.cash_pnl),
      percentPnl: toNumber(row.percentPnl ?? row.percent_pnl),
      totalBought: toNumber(row.totalBought ?? row.total_bought),
      realizedPnl: toNumber(row.realizedPnl ?? row.realized_pnl),
      percentRealizedPnl: toNumber(row.percentRealizedPnl ?? row.percent_realized_pnl),
      curPrice: toNumber(row.curPrice ?? row.cur_price),
      redeemable:
        typeof row.redeemable === "boolean"
          ? row.redeemable
          : String(row.redeemable ?? "").toLowerCase() === "true",
      mergeable:
        typeof row.mergeable === "boolean"
          ? row.mergeable
          : String(row.mergeable ?? "").toLowerCase() === "true",
      title: typeof row.title === "string" ? row.title : undefined,
      slug: typeof row.slug === "string" ? row.slug : undefined,
      icon: typeof row.icon === "string" ? row.icon : undefined,
      eventSlug: typeof row.eventSlug === "string" ? row.eventSlug : typeof row.event_slug === "string" ? row.event_slug : undefined,
      outcome: typeof row.outcome === "string" ? row.outcome : undefined,
      outcomeIndex: toNumber(row.outcomeIndex ?? row.outcome_index),
      oppositeOutcome:
        typeof row.oppositeOutcome === "string"
          ? row.oppositeOutcome
          : typeof row.opposite_outcome === "string"
            ? row.opposite_outcome
            : undefined,
      oppositeAsset:
        typeof row.oppositeAsset === "string"
          ? row.oppositeAsset
          : typeof row.opposite_asset === "string"
            ? row.opposite_asset
            : undefined,
      endDate: typeof row.endDate === "string" ? row.endDate : typeof row.end_date === "string" ? row.end_date : undefined,
      negativeRisk:
        typeof row.negativeRisk === "boolean"
          ? row.negativeRisk
          : String(row.negativeRisk ?? row.negative_risk ?? "").toLowerCase() === "true",
    };
  }

  private normalizeValue(payload: unknown, fallbackUser: string): PortfolioValueSnapshot | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }

    const row = payload as Record<string, unknown>;
    const value = toNumber(row.value ?? row.totalValue ?? row.total_value);
    if (value === undefined) {
      return undefined;
    }

    return {
      user: String(row.user ?? row.proxyWallet ?? fallbackUser),
      value,
    };
  }
}
