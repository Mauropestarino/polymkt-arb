import http, { type Server } from "node:http";
import type { Logger } from "pino";
import type { BotConfig } from "./config.js";
import type { RuntimeState } from "./types.js";

export const startHealthServer = async (
  config: BotConfig,
  runtimeState: RuntimeState,
  logger: Logger,
): Promise<Server | undefined> => {
  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400);
      response.end();
      return;
    }

    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          uptime_ms: Date.now() - runtimeState.startedAt,
          dry_run: runtimeState.dryRun,
          markets_tracked: runtimeState.getMarketsTracked(),
          open_notional: runtimeState.getOpenNotionalUsd(),
          fill_rate: runtimeState.getFillRate(),
          share_fill_rate: runtimeState.getShareFillRate(),
          opportunity_capture_rate: runtimeState.getOpportunityCaptureRate(),
          average_opportunity_duration_ms: runtimeState.getAverageOpportunityDurationMs(),
          estimated_slippage_usd_total: runtimeState.getEstimatedSlippageUsdTotal(),
          realized_slippage_usd_total: runtimeState.getRealizedSlippageUsdTotal(),
          trading_enabled: runtimeState.getTradingEnabled(),
          trading_pause_reason: runtimeState.getTradingPauseReason(),
          trading_resume_at: runtimeState.getTradingResumeAt(),
        }),
      );
      return;
    }

    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(
        [
          `opportunities_detected ${runtimeState.getOpportunitiesDetected()}`,
          `opportunities_viable ${runtimeState.getViableOpportunities()}`,
          `trades_attempted ${runtimeState.getTradesAttempted()}`,
          `trades_executed ${runtimeState.getTradesExecuted()}`,
          `fill_rate ${runtimeState.getFillRate()}`,
          `share_fill_rate ${runtimeState.getShareFillRate()}`,
          `opportunity_capture_rate ${runtimeState.getOpportunityCaptureRate()}`,
          `average_opportunity_duration_ms ${runtimeState.getAverageOpportunityDurationMs()}`,
          `estimated_slippage_usd_total ${runtimeState.getEstimatedSlippageUsdTotal()}`,
          `realized_slippage_usd_total ${runtimeState.getRealizedSlippageUsdTotal()}`,
          `trading_enabled ${runtimeState.getTradingEnabled() ? 1 : 0}`,
          `errors_total ${runtimeState.getErrorsTotal()}`,
        ].join("\n"),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not_found" }));
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
      logger.info({ port: config.healthPort }, "Health server started");
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.healthPort);
  });
};
