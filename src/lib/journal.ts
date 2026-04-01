import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isoDateStamp } from "./utils.js";
import type {
  OpportunityLogRecord,
  PersistedMarketSnapshot,
  TradeLogRecord,
} from "../types.js";

class RotatingJsonlWriter {
  private readonly filePath: string;
  private readonly baseName: string;
  private sizeBytes = 0;
  private readonly maxBytes: number;
  private pending: Promise<void>;

  constructor(
    private readonly logDir: string,
    fileName: string,
    maxFileSizeMb: number,
    private readonly maxRotatedFiles: number,
  ) {
    this.filePath = path.resolve(logDir, fileName);
    this.baseName = fileName.replace(/\.ndjson$/i, "");
    this.maxBytes = maxFileSizeMb * 1024 * 1024;
    this.pending = this.initialize();
  }

  write(record: unknown): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(() => this.append(line));
    return this.pending;
  }

  close(): Promise<void> {
    return this.pending;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });

    try {
      const metadata = await stat(this.filePath);
      this.sizeBytes = metadata.size;
    } catch {
      this.sizeBytes = 0;
    }
  }

  private async append(line: string): Promise<void> {
    const lineBytes = Buffer.byteLength(line);

    if (this.sizeBytes + lineBytes > this.maxBytes) {
      await this.rotate();
    }

    await appendFile(this.filePath, line, "utf8");
    this.sizeBytes += lineBytes;
  }

  private async rotate(): Promise<void> {
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size === 0) {
        this.sizeBytes = 0;
        return;
      }
    } catch {
      this.sizeBytes = 0;
      return;
    }

    const dateSuffix = isoDateStamp(new Date());
    let rotatedFileName = `${this.baseName}.${dateSuffix}.ndjson`;
    let rotatedPath = path.resolve(this.logDir, rotatedFileName);
    let suffix = 1;

    while (true) {
      try {
        await stat(rotatedPath);
        rotatedFileName = `${this.baseName}.${dateSuffix}.${suffix}.ndjson`;
        rotatedPath = path.resolve(this.logDir, rotatedFileName);
        suffix += 1;
      } catch {
        break;
      }
    }

    await rename(this.filePath, rotatedPath);
    this.sizeBytes = 0;
    await this.prune();
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.logDir, { withFileTypes: true });
    const rotatedEntries = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(`${this.baseName}.`) &&
          entry.name.endsWith(".ndjson"),
      )
      .map((entry) => entry.name)
      .sort();

    const excess = rotatedEntries.length - this.maxRotatedFiles;
    if (excess <= 0) {
      return;
    }

    for (const fileName of rotatedEntries.slice(0, excess)) {
      await rm(path.resolve(this.logDir, fileName), { force: true });
    }
  }
}

export class EventJournal {
  private readonly opportunitiesWriter: RotatingJsonlWriter;
  private readonly tradesWriter: RotatingJsonlWriter;
  private readonly snapshotsWriter?: RotatingJsonlWriter;
  private readonly errorsWriter: RotatingJsonlWriter;
  private errorCount = 0;

  private constructor(
    opportunitiesWriter: RotatingJsonlWriter,
    tradesWriter: RotatingJsonlWriter,
    errorsWriter: RotatingJsonlWriter,
    snapshotsWriter?: RotatingJsonlWriter,
  ) {
    this.opportunitiesWriter = opportunitiesWriter;
    this.tradesWriter = tradesWriter;
    this.errorsWriter = errorsWriter;
    this.snapshotsWriter = snapshotsWriter;
  }

  static async create(
    logDir: string,
    persistSnapshots: boolean,
    maxFileSizeMb: number,
    maxRotatedFiles: number,
  ): Promise<EventJournal> {
    await mkdir(logDir, { recursive: true });

    return new EventJournal(
      new RotatingJsonlWriter(logDir, "opportunities.ndjson", maxFileSizeMb, maxRotatedFiles),
      new RotatingJsonlWriter(logDir, "trades.ndjson", maxFileSizeMb, maxRotatedFiles),
      new RotatingJsonlWriter(logDir, "errors.ndjson", maxFileSizeMb, maxRotatedFiles),
      persistSnapshots
        ? new RotatingJsonlWriter(logDir, "orderbooks.ndjson", maxFileSizeMb, maxRotatedFiles)
        : undefined,
    );
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  logOpportunity(record: OpportunityLogRecord): void {
    void this.opportunitiesWriter.write(record);
  }

  logTrade(record: TradeLogRecord): void {
    void this.tradesWriter.write(record);
  }

  logSnapshot(record: PersistedMarketSnapshot): void {
    if (this.snapshotsWriter) {
      void this.snapshotsWriter.write(record);
    }
  }

  logError(error: unknown, context: Record<string, unknown> = {}): void {
    this.errorCount += 1;

    const serialized = {
      type: "error",
      timestamp: Date.now(),
      context,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    };

    void this.errorsWriter.write(serialized);
  }

  async close(): Promise<void> {
    await Promise.all(
      [
        this.opportunitiesWriter.close(),
        this.tradesWriter.close(),
        this.errorsWriter.close(),
        this.snapshotsWriter?.close(),
      ],
    );
  }
}
