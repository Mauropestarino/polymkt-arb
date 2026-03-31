import pino, { multistream, type Logger } from "pino";
import { ensureDir, resolveDataPath } from "./utils.js";
import type { BotConfig } from "../config.js";

export const createLogger = async (config: BotConfig): Promise<Logger> => {
  await ensureDir(config.logDir);

  const fileStream = pino.destination({
    dest: resolveDataPath(config.logDir, "bot.log"),
    sync: false,
  });

  return pino(
    {
      level: config.logLevel,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    multistream([{ stream: process.stdout }, { stream: fileStream }]),
  );
};
