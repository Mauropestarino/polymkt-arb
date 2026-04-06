import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { CryptoStrikeMarket, CryptoSymbol, MarketDefinition } from "./types.js";

const SYMBOL_PATTERNS: Array<{ symbol: CryptoSymbol; pattern: RegExp }> = [
  { symbol: "BTC", pattern: /\b(?:BTC|BITCOIN)\b/i },
  { symbol: "ETH", pattern: /\b(?:ETH|ETHEREUM)\b/i },
  { symbol: "SOL", pattern: /\b(?:SOL|SOLANA)\b/i },
];

const STRIKE_PATTERNS = [
  /\b(?:above|below|over|under|close above|close below|closes above|closes below|hit|hits|at least|at most)\s+\$?\s*(\d[\d,]*(?:\.\d+)?(?:\s*[kKmM])?)/i,
  /\b(?:>\s*|<\s*|>=\s*|<=\s*)\$?\s*(\d[\d,]*(?:\.\d+)?(?:\s*[kKmM])?)/i,
];

const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z\b/i;
const DATE_TIME_PATTERN =
  /\b(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+at\s+(\d{1,2}:\d{2})(?:\s*(AM|PM))?\s*(?:UTC)?\b/i;
const TIME_ONLY_PATTERN = /\bat\s+(\d{1,2}:\d{2})(?:\s*(AM|PM))?\s*(?:UTC)?\b/i;
const WINDOW_DURATION_PATTERN =
  /\b(5|15|60|240)\s*[- ]?(?:minute|minutes|hour|hours)\b/i;

const DEFAULT_WINDOW_DURATION_MINUTES: CryptoStrikeMarket["windowDurationMinutes"] = 15;

const normalizeUtcDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;

const parsePriceNumber = (rawValue: string): number | undefined => {
  const normalized = rawValue.replace(/\s+/g, "").replace(/\$/g, "").replace(/,/g, "");
  const suffix = normalized.slice(-1).toLowerCase();
  const magnitude = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const numericPortion = magnitude === 1 ? normalized : normalized.slice(0, -1);
  const parsed = Number(numericPortion);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed * magnitude;
};

const resolveUtcTime = (clock: string, meridiem?: string): { hour: number; minute: number } | undefined => {
  const [rawHour, rawMinute] = clock.split(":");
  const minute = Number(rawMinute);
  let hour = Number(rawHour);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return undefined;
  }

  if (meridiem) {
    const normalizedMeridiem = meridiem.toUpperCase();
    if (normalizedMeridiem === "AM" && hour === 12) {
      hour = 0;
    } else if (normalizedMeridiem === "PM" && hour < 12) {
      hour += 12;
    }
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return { hour, minute };
};

const parseWindowDurationMinutes = (
  question: string,
): CryptoStrikeMarket["windowDurationMinutes"] => {
  const match = question.match(WINDOW_DURATION_PATTERN);
  const value = Number(match?.[1] ?? DEFAULT_WINDOW_DURATION_MINUTES);
  if (value === 5 || value === 15 || value === 60 || value === 240) {
    return value;
  }

  return DEFAULT_WINDOW_DURATION_MINUTES;
};

const resolveTimeCandidate = (
  market: MarketDefinition,
  now: number,
): number | undefined => {
  const isoMatch = market.question.match(ISO_TIMESTAMP_PATTERN);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const dateTimeMatch = market.question.match(DATE_TIME_PATTERN);
  if (dateTimeMatch) {
    const [, dateText = "", clock = "", meridiem] = dateTimeMatch;
    const parsedTime = resolveUtcTime(clock, meridiem);
    if (parsedTime) {
      const parsed = Date.parse(`${dateText} ${clock}${meridiem ? ` ${meridiem}` : ""} UTC`);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  const timeOnlyMatch = market.question.match(TIME_ONLY_PATTERN);
  if (timeOnlyMatch) {
    const [, clock = "", meridiem] = timeOnlyMatch;
    const parsedTime = resolveUtcTime(clock, meridiem);
    if (parsedTime) {
      const fallbackDateText = market.endDate
        ? normalizeUtcDate(new Date(market.endDate))
        : normalizeUtcDate(new Date(now));
      const candidate = Date.parse(
        `${fallbackDateText}T${String(parsedTime.hour).padStart(2, "0")}:${String(
          parsedTime.minute,
        ).padStart(2, "0")}:00.000Z`,
      );
      if (Number.isFinite(candidate)) {
        if (candidate < now - 12 * 60 * 60 * 1000) {
          return candidate + 24 * 60 * 60 * 1000;
        }
        return candidate;
      }
    }
  }

  if (market.endDate) {
    const parsed = Date.parse(market.endDate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

export const detectCryptoSymbol = (text: string): CryptoSymbol | undefined => {
  for (const { symbol, pattern } of SYMBOL_PATTERNS) {
    if (pattern.test(text)) {
      return symbol;
    }
  }

  return undefined;
};

const extractStrikePrice = (text: string): number | undefined => {
  for (const pattern of STRIKE_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = parsePriceNumber(match[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
};

type ParsedCryptoMarket = {
  symbol: CryptoSymbol;
  strikePrice: number;
  windowEndMs: number;
  windowDurationMinutes: CryptoStrikeMarket["windowDurationMinutes"];
};

const parseCryptoMarket = (
  market: MarketDefinition,
  now: number,
): ParsedCryptoMarket | undefined => {
  const symbol = detectCryptoSymbol(market.question);
  if (!symbol) {
    return undefined;
  }

  const strikePrice = extractStrikePrice(market.question);
  const windowEndMs = resolveTimeCandidate(market, now);
  if (strikePrice === undefined || windowEndMs === undefined) {
    return undefined;
  }

  return {
    symbol,
    strikePrice,
    windowEndMs,
    windowDurationMinutes: parseWindowDurationMinutes(market.question),
  };
};

export class CryptoMarketRegistry {
  private readonly marketsByConditionId = new Map<string, CryptoStrikeMarket>();

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Rebuilds the in-memory crypto market index from the latest tracked markets.
   */
  refresh(markets: MarketDefinition[]): void {
    const now = Date.now();
    this.marketsByConditionId.clear();

    for (const market of markets) {
      const parsed = parseCryptoMarket(market, now);
      const symbol = detectCryptoSymbol(market.question);
      if (!parsed) {
        if (symbol) {
          this.logger.debug(
            {
              conditionId: market.conditionId,
              slug: market.slug,
              question: market.question,
              endDate: market.endDate,
            },
            "Skipping unparseable crypto strike market",
          );
        }
        continue;
      }

      const timeRemainingMs = parsed.windowEndMs - now;
      if (parsed.windowEndMs < now - 60_000) {
        continue;
      }

      if (timeRemainingMs < this.config.temporalArbMinTimeRemainingMs) {
        continue;
      }

      if (timeRemainingMs > this.config.temporalArbMaxLookaheadMs) {
        continue;
      }

      this.marketsByConditionId.set(market.conditionId, {
        conditionId: market.conditionId,
        slug: market.slug,
        question: market.question,
        symbol: parsed.symbol,
        strikePrice: parsed.strikePrice,
        windowEndMs: parsed.windowEndMs,
        windowDurationMinutes: parsed.windowDurationMinutes,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        negRisk: market.negRisk,
        tickSizeHint: market.tickSizeHint,
      });
    }
  }

  /**
   * Returns the parsed crypto strike market for a Polymarket condition id.
   */
  getMarket(conditionId: string): CryptoStrikeMarket | undefined {
    return this.marketsByConditionId.get(conditionId);
  }

  /**
   * Returns all active, non-expired crypto markets for a symbol inside the lookahead window.
   */
  getActiveMarketsForSymbol(symbol: string, now = Date.now()): CryptoStrikeMarket[] {
    const normalizedSymbol = symbol.toUpperCase();
    if (normalizedSymbol !== "BTC" && normalizedSymbol !== "ETH" && normalizedSymbol !== "SOL") {
      return [];
    }

    return [...this.marketsByConditionId.values()].filter((market) => {
      const timeRemainingMs = market.windowEndMs - now;
      return (
        market.symbol === normalizedSymbol &&
        timeRemainingMs >= this.config.temporalArbMinTimeRemainingMs &&
        timeRemainingMs <= this.config.temporalArbMaxLookaheadMs
      );
    });
  }

  /**
   * Returns current registry counts split by detected symbol.
   */
  getStats(): { total: number; bySymbol: Record<string, number> } {
    const bySymbol: Record<string, number> = {
      BTC: 0,
      ETH: 0,
      SOL: 0,
    };

    for (const market of this.marketsByConditionId.values()) {
      bySymbol[market.symbol] = (bySymbol[market.symbol] ?? 0) + 1;
    }

    return {
      total: this.marketsByConditionId.size,
      bySymbol,
    };
  }
}

export { parseCryptoMarket };
