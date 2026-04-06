import http, { type Server } from "node:http";
import type { Logger } from "pino";
import { DashboardAnalyticsService } from "./dashboardAnalytics.js";
import type { BotConfig } from "./config.js";
import { renderDashboardHtml } from "./dashboardPage.js";
import type {
  DashboardApiResponse,
  DashboardSnapshot,
  RuntimeState,
  TradingPauseReason,
} from "./types.js";

const buildHealthPayload = (runtimeState: RuntimeState) => ({
  status: "ok",
  uptime_ms: Date.now() - runtimeState.startedAt,
  dry_run: runtimeState.dryRun,
  markets_tracked: runtimeState.getMarketsTracked(),
  ws_disconnect_total: runtimeState.getWebsocketDisconnects(),
  open_notional: runtimeState.getOpenNotionalUsd(),
  reserved_notional_total: runtimeState.getOpenNotionalUsd(),
  open_reservations_count: runtimeState.getOpenReservationsCount(),
  stale_books_skipped_total: runtimeState.getStaleBooksSkipped(),
  last_book_age_ms: runtimeState.getLastBookAgeMs(),
  shadow_fill_rate: runtimeState.getShadowFillRate(),
  fill_rate: runtimeState.getFillRate(),
  share_fill_rate: runtimeState.getShareFillRate(),
  opportunity_capture_rate: runtimeState.getOpportunityCaptureRate(),
  average_opportunity_duration_ms: runtimeState.getAverageOpportunityDurationMs(),
  estimated_slippage_usd_total: runtimeState.getEstimatedSlippageUsdTotal(),
  realized_slippage_usd_total: runtimeState.getRealizedSlippageUsdTotal(),
  trading_enabled: runtimeState.getTradingEnabled(),
  trading_pause_reason: runtimeState.getTradingPauseReason(),
  trading_resume_at: runtimeState.getTradingResumeAt(),
  last_retained_reservation_reason: runtimeState.getLastRetainedReservationReason(),
  last_retained_reservation_at: runtimeState.getLastRetainedReservationAt(),
  cex_feed_connected: runtimeState.getCexFeedConnected(),
  cex_feed_stale_total: runtimeState.getCexFeedStaleTotal(),
  temporal_arb_signals_total: runtimeState.getTemporalArbSignalsTotal(),
  temporal_arb_executions_total: runtimeState.getTemporalArbExecutionsTotal(),
});

const buildMetricsPayload = (runtimeState: RuntimeState): string =>
  [
    `opportunities_detected ${runtimeState.getOpportunitiesDetected()}`,
    `opportunities_viable ${runtimeState.getViableOpportunities()}`,
    `trades_attempted ${runtimeState.getTradesAttempted()}`,
    `trades_executed ${runtimeState.getTradesExecuted()}`,
    `ws_disconnect_total ${runtimeState.getWebsocketDisconnects()}`,
    `reserved_notional_total ${runtimeState.getOpenNotionalUsd()}`,
    `open_reservations_count ${runtimeState.getOpenReservationsCount()}`,
    `stale_books_skipped_total ${runtimeState.getStaleBooksSkipped()}`,
    `last_book_age_ms ${runtimeState.getLastBookAgeMs() ?? 0}`,
    `shadow_fill_rate ${runtimeState.getShadowFillRate()}`,
    `fill_rate ${runtimeState.getFillRate()}`,
    `share_fill_rate ${runtimeState.getShareFillRate()}`,
    `opportunity_capture_rate ${runtimeState.getOpportunityCaptureRate()}`,
    `average_opportunity_duration_ms ${runtimeState.getAverageOpportunityDurationMs()}`,
    `estimated_slippage_usd_total ${runtimeState.getEstimatedSlippageUsdTotal()}`,
    `realized_slippage_usd_total ${runtimeState.getRealizedSlippageUsdTotal()}`,
    `trading_enabled ${runtimeState.getTradingEnabled() ? 1 : 0}`,
    `errors_total ${runtimeState.getErrorsTotal()}`,
    `last_retained_reservation_at ${runtimeState.getLastRetainedReservationAt() ?? 0}`,
    `cex_feed_connected ${runtimeState.getCexFeedConnected() ? 1 : 0}`,
    `cex_feed_stale_total ${runtimeState.getCexFeedStaleTotal()}`,
    `temporal_arb_signals_total ${runtimeState.getTemporalArbSignalsTotal()}`,
    `temporal_arb_executions_total ${runtimeState.getTemporalArbExecutionsTotal()}`,
  ].join("\n");

const toTradingPauseReason = (
  value: string | undefined,
): TradingPauseReason | undefined => {
  if (
    value === "rate_limit" ||
    value === "matching_engine_restart" ||
    value === "cancel_only" ||
    value === "trading_disabled"
  ) {
    return value;
  }

  return undefined;
};

const sendJson = (response: http.ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
};

const sendText = (response: http.ServerResponse, body: string): void => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
  });
  response.end(body);
};

const sendHtml = (response: http.ServerResponse, body: string): void => {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
};

const buildFallbackSnapshot = (runtimeState: RuntimeState): DashboardSnapshot => {
  const opportunitiesSeen = runtimeState.getOpportunitiesDetected();
  const opportunitiesCaptured = Math.round(
    runtimeState.getOpportunityCaptureRate() * opportunitiesSeen,
  );
  const executionsAttempted = runtimeState.getTradesAttempted();
  const executionsSucceeded = runtimeState.getTradesExecuted();

  return {
    startedAt: runtimeState.startedAt,
      scanner: {
        marketsTracked: runtimeState.getMarketsTracked(),
        tokensTracked: 0,
        websocketConnected: false,
        websocketReconnects: 0,
        websocketDisconnects: runtimeState.getWebsocketDisconnects(),
        lastMessageAt: undefined,
      },
    arbitrage: {
      opportunitiesSeen,
      opportunitiesViable: runtimeState.getViableOpportunities(),
      opportunitiesExecuted: executionsSucceeded,
      opportunitiesCaptured,
      averageOpportunityDurationMs: runtimeState.getAverageOpportunityDurationMs(),
      completedOpportunityCount: 0,
      totalOpportunityDurationMs: 0,
      lastOpportunityAt: undefined,
      staleBooksSkipped: runtimeState.getStaleBooksSkipped(),
      lastBookAgeMs: runtimeState.getLastBookAgeMs(),
    },
    temporalArb: {
      opportunitiesSeen: runtimeState.getTemporalArbSignalsTotal(),
      opportunitiesViable: runtimeState.getTemporalArbSignalsTotal(),
      opportunitiesExecuted: runtimeState.getTemporalArbExecutionsTotal(),
      opportunitiesCaptured: runtimeState.getTemporalArbExecutionsTotal(),
      averageOpportunityDurationMs: undefined,
      completedOpportunityCount: 0,
      totalOpportunityDurationMs: 0,
      lastOpportunityAt: undefined,
      staleBooksSkipped: 0,
      lastBookAgeMs: undefined,
      signalsGenerated: runtimeState.getTemporalArbSignalsTotal(),
      signalsRejectedByConfidence: 0,
      signalsRejectedByFeed: 0,
      staleFeedSkips: 0,
      avgConfidenceOnExecution: 0,
      avgEdgeOnExecution: 0,
      bySymbol: {
        BTC: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
        ETH: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
        SOL: { opportunitiesSeen: 0, opportunitiesExecuted: 0 },
      },
    },
    execution: {
      executionsAttempted,
      executionsSucceeded,
      executionsFailed: Math.max(0, executionsAttempted - executionsSucceeded),
      hedgesTriggered: 0,
      openNotionalUsd: runtimeState.getOpenNotionalUsd(),
      openReservationsCount: runtimeState.getOpenReservationsCount(),
      shadowExecutionsAttempted: 0,
      shadowExecutionsFilled: 0,
      shadowFillRate: runtimeState.getShadowFillRate(),
      filledShares: 0,
      intendedShares: 0,
      fillRate: runtimeState.getFillRate(),
      shareFillRate: runtimeState.getShareFillRate(),
      estimatedSlippageUsdTotal: runtimeState.getEstimatedSlippageUsdTotal(),
      estimatedSlippageUsdAverage:
        executionsAttempted > 0
          ? runtimeState.getEstimatedSlippageUsdTotal() / executionsAttempted
          : 0,
      realizedSlippageUsdTotal: runtimeState.getRealizedSlippageUsdTotal(),
      realizedSlippageUsdAverage:
        executionsAttempted > 0
          ? runtimeState.getRealizedSlippageUsdTotal() / executionsAttempted
          : 0,
      lastRetainedReservationReason: runtimeState.getLastRetainedReservationReason(),
      lastRetainedReservationAt: runtimeState.getLastRetainedReservationAt(),
    },
    cexFeedStatus: {
      connected: runtimeState.getCexFeedConnected(),
      live: runtimeState.getCexFeedConnected(),
      primaryExchange: "binance",
      activeExchangeBySymbol: {},
      feedAgeMsBySymbol: {},
      maxActiveFeedAgeMs: undefined,
      staleSymbols: [],
      disconnectCount: runtimeState.getWebsocketDisconnects(),
      staleCount: runtimeState.getCexFeedStaleTotal(),
    },
    tradingGuard: {
      tradingEnabled: runtimeState.getTradingEnabled(),
      pauseReason: toTradingPauseReason(runtimeState.getTradingPauseReason()),
      resumeAt: runtimeState.getTradingResumeAt(),
    },
    recentOpportunities: [],
  };
};

const logServerError = (logger: Logger, error: unknown): void => {
  const partialLogger = logger as Partial<Logger>;
  if (typeof partialLogger.error === "function") {
    partialLogger.error({ error }, "Dashboard request failed");
    return;
  }

  if (typeof partialLogger.warn === "function") {
    partialLogger.warn({ error }, "Dashboard request failed");
  }
};

export const startHealthServer = async (
  config: BotConfig,
  runtimeState: RuntimeState,
  logger: Logger,
  getDashboardSnapshot?: () => DashboardSnapshot,
): Promise<Server | undefined> => {
  const analyticsService = new DashboardAnalyticsService(config.logDir);

  const resolveSnapshot = (): DashboardSnapshot =>
    getDashboardSnapshot?.() ?? buildFallbackSnapshot(runtimeState);

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!request.url) {
        sendJson(response, 400, { status: "bad_request" });
        return;
      }

      const pathname = new URL(request.url, "http://127.0.0.1").pathname;

      if (pathname === "/health") {
        sendJson(response, 200, buildHealthPayload(runtimeState));
        return;
      }

      if (pathname === "/metrics") {
        sendText(response, buildMetricsPayload(runtimeState));
        return;
      }

      if (pathname === "/" || pathname === "/dashboard") {
        sendHtml(response, renderDashboardHtml());
        return;
      }

      if (pathname === "/api/dashboard") {
        const payload: DashboardApiResponse = {
          generatedAt: Date.now(),
          snapshot: resolveSnapshot(),
          analytics: await analyticsService.getAnalytics(),
          dryRun: runtimeState.dryRun,
        };
        sendJson(response, 200, payload);
        return;
      }

      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      sendJson(response, 404, { status: "not_found" });
    })().catch((error) => {
      logServerError(logger, error);
      if (!response.headersSent) {
        sendJson(response, 500, { status: "error" });
        return;
      }
      response.end();
    });
  });

  return new Promise<Server | undefined>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);

      if (error.code === "EADDRINUSE") {
        logger.warn(
          { port: config.healthPort },
          "Health server port already in use; continuing without HTTP health endpoints",
        );
        resolve(undefined);
        return;
      }

      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      logger.info({ port: config.healthPort }, "Health/dashboard server started");
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.healthPort);
  });
};
