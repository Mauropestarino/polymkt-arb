import type { Logger } from "pino";
import type { BotConfig } from "./config.js";

interface GeoblockPayload {
  blocked?: boolean;
  country?: string;
  region?: string;
  state?: string;
}

export const runGeoblockPreflight = async (
  config: BotConfig,
  logger: Logger,
): Promise<void> => {
  if (config.botMode !== "live" || !config.enforceGeoblock) {
    return;
  }

  try {
    const response = await fetch(config.geoblockUrl, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`Geoblock check failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as GeoblockPayload;
    if (!payload.blocked) {
      return;
    }

    const location = [payload.region ?? payload.state, payload.country].filter(Boolean).join(", ");
    const message = location
      ? `Polymarket geoblock endpoint reported the current IP as blocked (${location}).`
      : "Polymarket geoblock endpoint reported the current IP as blocked.";

    if (config.dryRun) {
      logger.warn({ geoblock: payload }, `${message} Continuing because DRY_RUN=true.`);
      return;
    }

    throw new Error(message);
  } catch (error) {
    if (!config.dryRun) {
      throw error;
    }

    logger.warn(
      { error },
      "Unable to complete geoblock preflight; continuing because DRY_RUN=true",
    );
  }
};
