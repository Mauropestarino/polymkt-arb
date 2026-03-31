import { createWriteStream, type WriteStream } from "node:fs";
import { ensureDir, resolveDataPath } from "./utils.js";
import type {
  OpportunityLogRecord,
  PersistedMarketSnapshot,
  TradeLogRecord,
} from "../types.js";

export class EventJournal {
  private readonly opportunitiesStream: WriteStream;
  private readonly tradesStream: WriteStream;
  private readonly snapshotsStream: WriteStream | undefined;
  private readonly errorsStream: WriteStream;

  private constructor(
    opportunitiesStream: WriteStream,
    tradesStream: WriteStream,
    errorsStream: WriteStream,
    snapshotsStream?: WriteStream,
  ) {
    this.opportunitiesStream = opportunitiesStream;
    this.tradesStream = tradesStream;
    this.errorsStream = errorsStream;
    this.snapshotsStream = snapshotsStream;
  }

  static async create(logDir: string, persistSnapshots: boolean): Promise<EventJournal> {
    await ensureDir(logDir);

    return new EventJournal(
      createWriteStream(resolveDataPath(logDir, "opportunities.ndjson"), { flags: "a" }),
      createWriteStream(resolveDataPath(logDir, "trades.ndjson"), { flags: "a" }),
      createWriteStream(resolveDataPath(logDir, "errors.ndjson"), { flags: "a" }),
      persistSnapshots
        ? createWriteStream(resolveDataPath(logDir, "orderbooks.ndjson"), { flags: "a" })
        : undefined,
    );
  }

  logOpportunity(record: OpportunityLogRecord): void {
    this.opportunitiesStream.write(`${JSON.stringify(record)}\n`);
  }

  logTrade(record: TradeLogRecord): void {
    this.tradesStream.write(`${JSON.stringify(record)}\n`);
  }

  logSnapshot(record: PersistedMarketSnapshot): void {
    this.snapshotsStream?.write(`${JSON.stringify(record)}\n`);
  }

  logError(error: unknown, context: Record<string, unknown> = {}): void {
    const serialized = {
      type: "error",
      timestamp: Date.now(),
      context,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    };

    this.errorsStream.write(`${JSON.stringify(serialized)}\n`);
  }

  async close(): Promise<void> {
    const streams = [
      this.opportunitiesStream,
      this.tradesStream,
      this.errorsStream,
      this.snapshotsStream,
    ].filter(Boolean) as WriteStream[];

    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(resolve);
          }),
      ),
    );
  }
}
