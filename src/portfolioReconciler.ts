import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import { DataApiClient } from "./dataApi.js";
import { sleep } from "./lib/utils.js";
import type { PortfolioPosition, PortfolioReconciliationResult } from "./types.js";
import { WalletService } from "./wallet.js";

const POSITION_EPSILON = 0.000001;

export class PortfolioReconciler {
  constructor(
    private readonly config: BotConfig,
    private readonly dataApi: DataApiClient,
    private readonly wallet: WalletService,
    private readonly logger: Logger,
  ) {}

  async reconcileMarket(
    conditionId: string,
    expectation: "flat" | "snapshot",
  ): Promise<PortfolioReconciliationResult> {
    const user = this.wallet.requireProfileAddress();
    const maxAttempts = expectation === "flat" ? this.config.reconcileMaxAttempts : 1;
    const notes: string[] = [];
    let lastPositions: PortfolioPosition[] = [];
    let totalValueUsd: number | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const [positions, value] = await Promise.all([
          this.dataApi.getPositions({
            user,
            market: conditionId,
            sizeThreshold: 0,
          }),
          this.dataApi.getValue({ user }).catch((error) => {
            notes.push(
              error instanceof Error
                ? `Data API value lookup failed: ${error.message}`
                : "Data API value lookup failed.",
            );
            return undefined;
          }),
        ]);

        lastPositions = positions.filter((position) => position.conditionId === conditionId);
        totalValueUsd = value?.value;

        const openPositions = lastPositions.filter(
          (position) => Math.abs(position.size) > POSITION_EPSILON,
        );
        const satisfied = expectation === "snapshot" || openPositions.length === 0;

        if (satisfied || attempt === maxAttempts) {
          if (expectation === "flat" && openPositions.length > 0) {
            notes.push(
              `Market still shows ${openPositions.length} open position(s) after ${attempt} reconciliation attempt(s).`,
            );
          } else {
            notes.push(
              expectation === "flat"
                ? `Market reconciled flat after ${attempt} attempt(s).`
                : `Portfolio snapshot fetched on attempt ${attempt}.`,
            );
          }

          return {
            user,
            conditionId,
            expectation,
            satisfied,
            attempts: attempt,
            reconciledAt: Date.now(),
            positions: lastPositions,
            totalValueUsd,
            notes,
          };
        }
      } catch (error) {
        this.logger.warn({ error, conditionId, attempt }, "Portfolio reconciliation attempt failed");
        notes.push(
          error instanceof Error
            ? `Reconciliation attempt ${attempt} failed: ${error.message}`
            : `Reconciliation attempt ${attempt} failed.`,
        );
      }

      if (attempt < maxAttempts) {
        await sleep(this.config.reconcilePollIntervalMs);
      }
    }

    return {
      user,
      conditionId,
      expectation,
      satisfied: false,
      attempts: maxAttempts,
      reconciledAt: Date.now(),
      positions: lastPositions,
      totalValueUsd,
      notes,
    };
  }
}
