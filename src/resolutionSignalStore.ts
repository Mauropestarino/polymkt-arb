import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { LateResolutionSignal, MarketDefinition } from "./types.js";
import { safeJsonParse } from "./lib/utils.js";

type SignalMap = Map<string, LateResolutionSignal>;

export class ResolutionSignalStore extends EventEmitter {
  private watcher?: FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  private signalsByConditionId: SignalMap = new Map();
  private signalsByMarketId: SignalMap = new Map();
  private signalsBySlug: SignalMap = new Map();
  private loadedSignals = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    await mkdir(path.dirname(this.config.lateResolutionSignalFile), { recursive: true });
    await this.reloadSignals();
    this.startWatcher();
  }

  stop(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }

    this.watcher?.close();
    this.watcher = undefined;
  }

  getSignal(market: MarketDefinition, now = Date.now()): LateResolutionSignal | undefined {
    const candidates = [
      this.signalsByConditionId.get(market.conditionId),
      this.signalsByMarketId.get(market.id),
      this.signalsBySlug.get(market.slug),
    ].filter((signal): signal is LateResolutionSignal => Boolean(signal));

    if (candidates.length === 0) {
      return undefined;
    }

    return candidates
      .filter((signal) => now - signal.resolvedAt <= this.config.lateResolutionMaxSignalAgeMs)
      .sort((left, right) => right.resolvedAt - left.resolvedAt)[0];
  }

  getStats(): { loadedSignals: number } {
    return {
      loadedSignals: this.loadedSignals,
    };
  }

  private startWatcher(): void {
    const directory = path.dirname(this.config.lateResolutionSignalFile);
    const targetFile = path.basename(this.config.lateResolutionSignalFile);

    try {
      this.watcher = watch(directory, (_eventType, fileName) => {
        if (!fileName || String(fileName) === targetFile) {
          this.scheduleReload();
        }
      });

      this.watcher.on("error", (error) => {
        this.logger.warn({ error, file: this.config.lateResolutionSignalFile }, "Resolution signal watcher errored");
      });
    } catch (error) {
      this.logger.warn({ error, file: this.config.lateResolutionSignalFile }, "Unable to watch resolution signals");
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reloadSignals();
    }, 150);
    this.reloadTimer.unref();
  }

  private async reloadSignals(): Promise<void> {
    try {
      const raw = await readFile(this.config.lateResolutionSignalFile, "utf8");
      const nextConditionSignals: SignalMap = new Map();
      const nextMarketSignals: SignalMap = new Map();
      const nextSlugSignals: SignalMap = new Map();
      let parsedSignals = 0;

      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        const parsed = safeJsonParse<Record<string, unknown>>(line);
        const signal = this.normalizeSignal(parsed);
        if (!signal) {
          continue;
        }

        parsedSignals += 1;
        this.setLatest(nextConditionSignals, signal.conditionId, signal);
        this.setLatest(nextMarketSignals, signal.marketId, signal);
        this.setLatest(nextSlugSignals, signal.slug, signal);
      }

      this.signalsByConditionId = nextConditionSignals;
      this.signalsByMarketId = nextMarketSignals;
      this.signalsBySlug = nextSlugSignals;
      this.loadedSignals = parsedSignals;

      this.emit("updated", this.loadedSignals);
      this.logger.debug(
        {
          file: this.config.lateResolutionSignalFile,
          loadedSignals: this.loadedSignals,
        },
        "Resolution signals reloaded",
      );
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
      if (code === "ENOENT") {
        if (this.loadedSignals > 0) {
          this.signalsByConditionId.clear();
          this.signalsByMarketId.clear();
          this.signalsBySlug.clear();
          this.loadedSignals = 0;
          this.emit("updated", this.loadedSignals);
        }
        return;
      }

      this.logger.warn({ error, file: this.config.lateResolutionSignalFile }, "Failed to reload resolution signals");
    }
  }

  private normalizeSignal(raw: Record<string, unknown> | undefined): LateResolutionSignal | undefined {
    if (!raw) {
      return undefined;
    }

    const resolvedOutcome = String(raw.resolvedOutcome ?? "").toUpperCase();
    if (resolvedOutcome !== "YES" && resolvedOutcome !== "NO") {
      return undefined;
    }

    const resolvedAt = Number(raw.resolvedAt ?? 0);
    if (!Number.isFinite(resolvedAt) || resolvedAt <= 0) {
      return undefined;
    }

    const conditionId = this.normalizeOptionalString(raw.conditionId);
    const marketId = this.normalizeOptionalString(raw.marketId);
    const slug = this.normalizeOptionalString(raw.slug);

    if (!conditionId && !marketId && !slug) {
      return undefined;
    }

    return {
      conditionId,
      marketId,
      slug,
      resolvedOutcome,
      source: this.normalizeOptionalString(raw.source) ?? "manual_signal",
      resolvedAt,
      note: this.normalizeOptionalString(raw.note),
    };
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private setLatest(map: SignalMap, key: string | undefined, signal: LateResolutionSignal): void {
    if (!key) {
      return;
    }

    const existing = map.get(key);
    if (!existing || signal.resolvedAt >= existing.resolvedAt) {
      map.set(key, signal);
    }
  }
}
