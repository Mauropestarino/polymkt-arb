import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { startHealthServer } from "../healthServer.js";
import type { RuntimeState } from "../types.js";

const createRuntimeState = (): RuntimeState => ({
  startedAt: Date.now() - 1_000,
  dryRun: true,
  getMarketsTracked: () => 10,
  getWebsocketDisconnects: () => 2,
  getOpenNotionalUsd: () => 0,
  getOpenReservationsCount: () => 0,
  getOpportunitiesDetected: () => 0,
  getViableOpportunities: () => 0,
  getTradesExecuted: () => 0,
  getTradesAttempted: () => 0,
  getStaleBooksSkipped: () => 3,
  getLastBookAgeMs: () => 145,
  getShadowFillRate: () => 0,
  getFillRate: () => 0,
  getShareFillRate: () => 0,
  getOpportunityCaptureRate: () => 0,
  getAverageOpportunityDurationMs: () => 0,
  getEstimatedSlippageUsdTotal: () => 0,
  getRealizedSlippageUsdTotal: () => 0,
  getErrorsTotal: () => 0,
  getTradingEnabled: () => true,
  getTradingPauseReason: () => undefined,
  getTradingResumeAt: () => undefined,
  getLastRetainedReservationReason: () => undefined,
  getLastRetainedReservationAt: () => undefined,
  getCexFeedConnected: () => false,
  getCexFeedStaleTotal: () => 0,
  getTemporalArbSignalsTotal: () => 0,
  getTemporalArbExecutionsTotal: () => 0,
});

const getFreePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to acquire an ephemeral port."));
        return;
      }

      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });

const createTestConfig = (healthPort: number): BotConfig => ({
  ...baseConfig,
  healthPort,
});

const openServers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dirPath) => rm(dirPath, { force: true, recursive: true })),
  );
});

const request = async (
  port: number,
  targetPath: string,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> =>
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: targetPath,
        method: "GET",
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body,
            headers: response.headers,
          });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });

const createTempLogDir = async (): Promise<string> => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "polymarket-health-server-"));
  tempDirs.push(dirPath);
  return dirPath;
};

describe("health server", () => {
  it("keeps the bot running when the configured port is already in use", async () => {
    const port = await getFreePort();
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, () => resolve());
    });
    openServers.push(blocker);

    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
    };

    const server = await startHealthServer(
      createTestConfig(port),
      createRuntimeState(),
      logger as never,
    );

    expect(server).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("starts normally when the port is available", async () => {
    const port = await getFreePort();
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
    };

    const server = await startHealthServer(
      createTestConfig(port),
      createRuntimeState(),
      logger as never,
    );

    expect(server).toBeDefined();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();

    if (server) {
      openServers.push(server);
    }
  });

  it("serves the dashboard html and aggregated api payload", async () => {
    const port = await getFreePort();
    const logDir = await createTempLogDir();
    await writeFile(
      path.join(logDir, "trades.ndjson"),
      JSON.stringify({
        type: "trade",
        timestamp: 1_000,
        success: true,
        mode: "paper",
        marketId: "market-1",
        slug: "market-1",
        question: "Question",
        strategyType: "binary_arb",
        tradeSize: 12,
        expectedProfitUsd: 0.5,
        realizedProfitUsd: 0.5,
        estimatedSlippageUsd: 0,
        realizedSlippageUsd: 0,
        orderIds: ["order-1"],
        hedgeOrderIds: [],
        notes: ["paper execution"],
      }),
      "utf8",
    );

    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const server = await startHealthServer(
      {
        ...createTestConfig(port),
        logDir,
      },
      createRuntimeState(),
      logger as never,
    );

    expect(server).toBeDefined();

    if (!server) {
      return;
    }

    openServers.push(server);

    const [htmlResponse, apiResponse] = await Promise.all([
      request(port, "/"),
      request(port, "/api/dashboard"),
    ]);

    expect(htmlResponse.statusCode).toBe(200);
    expect(htmlResponse.headers["content-type"]).toContain("text/html");
    expect(htmlResponse.body).toContain("Bot operations dashboard");

    expect(apiResponse.statusCode).toBe(200);
    expect(apiResponse.headers["content-type"]).toContain("application/json");
    const payload = JSON.parse(apiResponse.body) as {
      dryRun: boolean;
      analytics: {
        tradeSummary: {
          totalTrades: number;
        };
      };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.analytics.tradeSummary.totalTrades).toBe(1);
  });

  it("exposes freshness and websocket metrics through health and metrics endpoints", async () => {
    const port = await getFreePort();
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const server = await startHealthServer(
      createTestConfig(port),
      createRuntimeState(),
      logger as never,
    );

    expect(server).toBeDefined();

    if (!server) {
      return;
    }

    openServers.push(server);

    const [healthResponse, metricsResponse] = await Promise.all([
      request(port, "/health"),
      request(port, "/metrics"),
    ]);

    expect(healthResponse.statusCode).toBe(200);
    const healthPayload = JSON.parse(healthResponse.body) as {
      ws_disconnect_total: number;
      stale_books_skipped_total: number;
      last_book_age_ms: number;
    };
    expect(healthPayload.ws_disconnect_total).toBe(2);
    expect(healthPayload.stale_books_skipped_total).toBe(3);
    expect(healthPayload.last_book_age_ms).toBe(145);

    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.body).toContain("ws_disconnect_total 2");
    expect(metricsResponse.body).toContain("stale_books_skipped_total 3");
    expect(metricsResponse.body).toContain("last_book_age_ms 145");
  });
});
