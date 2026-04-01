import type { Server } from "node:http";
import { config } from "./config.js";
import { AlertService } from "./alerts.js";
import { ArbitrageEngine } from "./arbitrageEngine.js";
import { BacktestRunner } from "./backtest.js";
import { CliDashboard } from "./dashboard.js";
import { ExecutionEngine } from "./executionEngine.js";
import { startHealthServer } from "./healthServer.js";
import { LateResolutionEngine } from "./lateResolutionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { createLogger } from "./lib/logger.js";
import { MarketScanner } from "./marketScanner.js";
import { OrderBookStore } from "./orderBookStore.js";
import { ResolutionSignalStore } from "./resolutionSignalStore.js";
import { RiskManager } from "./riskManager.js";
import { WalletService } from "./wallet.js";

const startedAt = Date.now();

const main = async (): Promise<void> => {
  const logger = await createLogger(config);
  const journal = await EventJournal.create(
    config.logDir,
    config.enableOrderbookPersistence,
    config.logMaxFileSizeMb,
    config.logMaxRotatedFiles,
  );
  const wallet = await WalletService.create(config, logger);
  const store = new OrderBookStore();
  const riskManager = new RiskManager(config, wallet, logger);
  const alerts = new AlertService(config, logger);
  const executionEngine = new ExecutionEngine(config, wallet, store, riskManager, logger);
  const signalStore = new ResolutionSignalStore(config, logger);
  const arbitrageEngine = new ArbitrageEngine(
    config,
    riskManager,
    executionEngine,
    alerts,
    journal,
    logger,
  );
  const lateResolutionEngine = config.enableLateResolutionStrategy
    ? new LateResolutionEngine(
        config,
        signalStore,
        riskManager,
        executionEngine,
        alerts,
        journal,
        logger,
      )
    : undefined;

  const shutdown = async (
    scanner?: MarketScanner,
    dashboard?: CliDashboard,
    healthServer?: Server,
  ) => {
    dashboard?.stop();
    await scanner?.stop();
    signalStore.stop();
    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer.close(() => resolve());
      });
    }
    await journal.close();
  };

  if (config.botMode === "backtest") {
    try {
      const runner = new BacktestRunner(config, riskManager, logger);
      await runner.run();
    } finally {
      await shutdown();
    }
    return;
  }

  const scanner = new MarketScanner(config, wallet, store, journal, logger);
  const dashboard = new CliDashboard(
    startedAt,
    () => scanner.getStats(),
    () => arbitrageEngine.getStats(),
    () => executionEngine.getStats(),
    () => lateResolutionEngine?.getStats() ?? {
      opportunitiesSeen: 0,
      opportunitiesViable: 0,
      opportunitiesExecuted: 0,
      opportunitiesCaptured: 0,
      averageOpportunityDurationMs: undefined,
      completedOpportunityCount: 0,
      totalOpportunityDurationMs: 0,
      lastOpportunityAt: undefined,
    },
  );
  let healthServer: Server | undefined;

  scanner.on("marketUpdate", (state) => {
    arbitrageEngine.handleMarketUpdate(state);
    lateResolutionEngine?.handleMarketUpdate(state);
  });

  arbitrageEngine.on("opportunity", (record) => {
    dashboard.pushOpportunity(record);
  });

  lateResolutionEngine?.on("opportunity", (record) => {
    dashboard.pushOpportunity(record);
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down");
    await shutdown(scanner, dashboard, healthServer);
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down");
    await shutdown(scanner, dashboard, healthServer);
    process.exit(0);
  });

  try {
    if (config.enableLateResolutionStrategy) {
      await signalStore.start();
    }
    await scanner.start();
    const getCombinedOpportunitiesDetected = () =>
      arbitrageEngine.getStats().opportunitiesSeen + (lateResolutionEngine?.getStats().opportunitiesSeen ?? 0);
    const getCombinedCapturedOpportunities = () =>
      arbitrageEngine.getStats().opportunitiesCaptured + (lateResolutionEngine?.getStats().opportunitiesCaptured ?? 0);
    const getCombinedViableOpportunities = () =>
      arbitrageEngine.getStats().opportunitiesViable + (lateResolutionEngine?.getStats().opportunitiesViable ?? 0);
    const getCombinedOpportunityDurationMs = () => {
      const binary = arbitrageEngine.getStats();
      const late = lateResolutionEngine?.getStats();
      const totalDurationMs =
        binary.totalOpportunityDurationMs + (late?.totalOpportunityDurationMs ?? 0);
      const completedCount =
        binary.completedOpportunityCount + (late?.completedOpportunityCount ?? 0);
      return completedCount > 0 ? totalDurationMs / completedCount : 0;
    };

    healthServer = await startHealthServer(
      config,
      {
        startedAt,
        dryRun: config.dryRun,
        getMarketsTracked: () => scanner.getStats().marketsTracked,
        getOpenNotionalUsd: () => executionEngine.getStats().openNotionalUsd,
        getOpportunitiesDetected: getCombinedOpportunitiesDetected,
        getViableOpportunities: getCombinedViableOpportunities,
        getTradesAttempted: () => executionEngine.getStats().executionsAttempted,
        getTradesExecuted: () => executionEngine.getStats().executionsSucceeded,
        getFillRate: () => executionEngine.getStats().fillRate,
        getShareFillRate: () => executionEngine.getStats().shareFillRate,
        getOpportunityCaptureRate: () => {
          const opportunities = getCombinedOpportunitiesDetected();
          return opportunities > 0 ? getCombinedCapturedOpportunities() / opportunities : 0;
        },
        getAverageOpportunityDurationMs: getCombinedOpportunityDurationMs,
        getEstimatedSlippageUsdTotal: () => executionEngine.getStats().estimatedSlippageUsdTotal,
        getRealizedSlippageUsdTotal: () => executionEngine.getStats().realizedSlippageUsdTotal,
        getErrorsTotal: () => journal.getErrorCount(),
      },
      logger,
    );
    dashboard.start(Math.max(config.pollingIntervalMs * 4, 1000));
  } catch (error) {
    logger.error({ error }, "Fatal startup error");
    journal.logError(error);
    await shutdown(scanner, dashboard, healthServer);
    process.exit(1);
  }
};

await main();
