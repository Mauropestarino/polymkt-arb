import { config } from "./config.js";
import { AlertService } from "./alerts.js";
import { ArbitrageEngine } from "./arbitrageEngine.js";
import { BacktestRunner } from "./backtest.js";
import { CliDashboard } from "./dashboard.js";
import { ExecutionEngine } from "./executionEngine.js";
import { EventJournal } from "./lib/journal.js";
import { createLogger } from "./lib/logger.js";
import { MarketScanner } from "./marketScanner.js";
import { OrderBookStore } from "./orderBookStore.js";
import { RiskManager } from "./riskManager.js";
import { WalletService } from "./wallet.js";

const startedAt = Date.now();

const main = async (): Promise<void> => {
  const logger = await createLogger(config);
  const journal = await EventJournal.create(config.logDir, config.enableOrderbookPersistence);
  const wallet = await WalletService.create(config, logger);
  const store = new OrderBookStore();
  const riskManager = new RiskManager(config, wallet, logger);
  const alerts = new AlertService(config, logger);
  const executionEngine = new ExecutionEngine(config, wallet, store, riskManager, logger);
  const arbitrageEngine = new ArbitrageEngine(
    config,
    riskManager,
    executionEngine,
    alerts,
    journal,
    logger,
  );

  const shutdown = async (scanner?: MarketScanner, dashboard?: CliDashboard) => {
    dashboard?.stop();
    await scanner?.stop();
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
  );

  scanner.on("marketUpdate", (state) => {
    arbitrageEngine.handleMarketUpdate(state);
  });

  arbitrageEngine.on("opportunity", (record) => {
    dashboard.pushOpportunity(record);
  });

  process.on("SIGINT", async () => {
    logger.info("Received SIGINT, shutting down");
    await shutdown(scanner, dashboard);
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("Received SIGTERM, shutting down");
    await shutdown(scanner, dashboard);
    process.exit(0);
  });

  try {
    await scanner.start();
    dashboard.start(Math.max(config.pollingIntervalMs * 4, 1000));
  } catch (error) {
    logger.error({ error }, "Fatal startup error");
    await shutdown(scanner, dashboard);
    process.exit(1);
  }
};

await main();
