import type { Server } from "node:http";
import { config } from "./config.js";
import { CtfSettlementService } from "./ctfSettlement.js";
import { DataApiClient } from "./dataApi.js";
import { AlertService } from "./alerts.js";
import { ArbitrageEngine } from "./arbitrageEngine.js";
import { BacktestRunner } from "./backtest.js";
import { CeilingArbitrageEngine } from "./ceilingArbitrageEngine.js";
import { CliDashboard } from "./dashboard.js";
import { ExecutionEngine } from "./executionEngine.js";
import { startHealthServer } from "./healthServer.js";
import { LateResolutionEngine } from "./lateResolutionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { createLogger } from "./lib/logger.js";
import { MarketScanner } from "./marketScanner.js";
import { NegRiskCatalog } from "./negRiskCatalog.js";
import { NegRiskEngine } from "./negRiskEngine.js";
import { OrderBookStore } from "./orderBookStore.js";
import { runGeoblockPreflight } from "./preflight.js";
import { PortfolioReconciler } from "./portfolioReconciler.js";
import { ResolutionSignalStore } from "./resolutionSignalStore.js";
import { RiskManager } from "./riskManager.js";
import { TradingGuard } from "./tradingGuard.js";
import { TradingHeartbeatService } from "./tradingHeartbeat.js";
import { WalletService } from "./wallet.js";

const startedAt = Date.now();

const main = async (): Promise<void> => {
  const logger = await createLogger(config);
  await runGeoblockPreflight(config, logger);
  const journal = await EventJournal.create(
    config.logDir,
    config.enableOrderbookPersistence,
    config.logMaxFileSizeMb,
    config.logMaxRotatedFiles,
  );
  const wallet = await WalletService.create(config, logger);
  const store = new OrderBookStore();
  const riskManager = new RiskManager(config, wallet, logger);
  const tradingGuard = new TradingGuard(config, logger);
  const alerts = new AlertService(config, logger);
  const dataApi = new DataApiClient(config, logger);
  const portfolioReconciler = new PortfolioReconciler(config, dataApi, wallet, logger);
  const ctfSettlement = new CtfSettlementService(config, wallet, logger);
  const negRiskCatalog = new NegRiskCatalog(config, logger);
  const executionEngine = new ExecutionEngine(
    config,
    wallet,
    store,
    riskManager,
    tradingGuard,
    logger,
    {
      ctfSettlement,
      portfolioReconciler,
    },
  );
  const tradingHeartbeat = new TradingHeartbeatService(config, wallet, tradingGuard, logger);
  const signalStore = new ResolutionSignalStore(config, logger);
  const arbitrageEngine = new ArbitrageEngine(
    config,
    riskManager,
    executionEngine,
    alerts,
    journal,
    logger,
  );
  const ceilingArbitrageEngine = config.enableBinaryCeilingStrategy
    ? new CeilingArbitrageEngine(
        config,
        riskManager,
        executionEngine,
        alerts,
        journal,
        logger,
      )
    : undefined;
  const negRiskEngine = config.enableNegRiskStrategy
    ? new NegRiskEngine(
        config,
        negRiskCatalog,
        store,
        riskManager,
        executionEngine,
        alerts,
        journal,
        logger,
      )
    : undefined;
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
    tradingHeartbeat.stop();
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
    () => ceilingArbitrageEngine?.getStats(),
    () => negRiskEngine?.getStats(),
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
    () => tradingGuard.getStatus(),
  );
  let healthServer: Server | undefined;

  scanner.on("marketUpdate", (state) => {
    arbitrageEngine.handleMarketUpdate(state);
    ceilingArbitrageEngine?.handleMarketUpdate(state);
    negRiskEngine?.handleMarketUpdate(state);
    lateResolutionEngine?.handleMarketUpdate(state);
  });

  arbitrageEngine.on("opportunity", (record) => {
    dashboard.pushOpportunity(record);
  });

  ceilingArbitrageEngine?.on("opportunity", (record) => {
    dashboard.pushOpportunity(record);
  });

  negRiskEngine?.on("opportunity", (record) => {
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
    const trackedMarkets = await scanner.start();
    if (config.enableNegRiskStrategy) {
      await negRiskCatalog.refresh(trackedMarkets);
    }
    await tradingHeartbeat.start();
    const getCombinedOpportunitiesDetected = () =>
      arbitrageEngine.getStats().opportunitiesSeen +
      (ceilingArbitrageEngine?.getStats().opportunitiesSeen ?? 0) +
      (negRiskEngine?.getStats().opportunitiesSeen ?? 0) +
      (lateResolutionEngine?.getStats().opportunitiesSeen ?? 0);
    const getCombinedCapturedOpportunities = () =>
      arbitrageEngine.getStats().opportunitiesCaptured +
      (ceilingArbitrageEngine?.getStats().opportunitiesCaptured ?? 0) +
      (negRiskEngine?.getStats().opportunitiesCaptured ?? 0) +
      (lateResolutionEngine?.getStats().opportunitiesCaptured ?? 0);
    const getCombinedViableOpportunities = () =>
      arbitrageEngine.getStats().opportunitiesViable +
      (ceilingArbitrageEngine?.getStats().opportunitiesViable ?? 0) +
      (negRiskEngine?.getStats().opportunitiesViable ?? 0) +
      (lateResolutionEngine?.getStats().opportunitiesViable ?? 0);
    const getCombinedOpportunityDurationMs = () => {
      const binary = arbitrageEngine.getStats();
      const ceiling = ceilingArbitrageEngine?.getStats();
      const negRisk = negRiskEngine?.getStats();
      const late = lateResolutionEngine?.getStats();
      const totalDurationMs =
        binary.totalOpportunityDurationMs +
        (ceiling?.totalOpportunityDurationMs ?? 0) +
        (negRisk?.totalOpportunityDurationMs ?? 0) +
        (late?.totalOpportunityDurationMs ?? 0);
      const completedCount =
        binary.completedOpportunityCount +
        (ceiling?.completedOpportunityCount ?? 0) +
        (negRisk?.completedOpportunityCount ?? 0) +
        (late?.completedOpportunityCount ?? 0);
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
        getTradingEnabled: () => tradingGuard.getStatus().tradingEnabled,
        getTradingPauseReason: () => tradingGuard.getStatus().pauseReason,
        getTradingResumeAt: () => tradingGuard.getStatus().resumeAt,
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
