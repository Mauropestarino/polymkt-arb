import { createReadStream } from "node:fs";
import * as readline from "node:readline";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { PersistedMarketSnapshot } from "./types.js";
import { RiskManager } from "./riskManager.js";
import { safeJsonParse } from "./lib/utils.js";

export class BacktestRunner {
  constructor(
    private readonly config: BotConfig,
    private readonly riskManager: RiskManager,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<void> {
    this.logger.info({ file: this.config.backtestFile }, "Starting backtest replay");

    const input = createReadStream(this.config.backtestFile, { encoding: "utf8" });
    const rl = readline.createInterface({
      input,
      crlfDelay: Infinity,
    });

    let processed = 0;
    let viable = 0;
    let cumulativeExpectedProfit = 0;
    let bestOpportunity: { slug: string; profit: number; arb: number } | undefined;

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      const snapshot = safeJsonParse<PersistedMarketSnapshot>(line);
      if (!snapshot || snapshot.type !== "market_snapshot") {
        continue;
      }

      processed += 1;
      const assessment = await this.riskManager.evaluate(
        {
          market: snapshot.market,
          yes: snapshot.yes,
          no: snapshot.no,
          lastUpdatedAt: snapshot.timestamp,
        },
        { skipBalanceChecks: true },
      );

      if (assessment.viable) {
        viable += 1;
        cumulativeExpectedProfit += assessment.expectedProfitUsd;
        if (!bestOpportunity || assessment.expectedProfitUsd > bestOpportunity.profit) {
          bestOpportunity = {
            slug: assessment.market.slug,
            profit: assessment.expectedProfitUsd,
            arb: assessment.arb,
          };
        }
      }

      if (this.config.backtestMaxLines > 0 && processed >= this.config.backtestMaxLines) {
        break;
      }
    }

    this.logger.info(
      {
        processed,
        viable,
        cumulativeExpectedProfit: Number(cumulativeExpectedProfit.toFixed(6)),
        bestOpportunity,
      },
      "Backtest finished",
    );
  }
}
