import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TickSize } from "@polymarket/clob-client";
import type { OrderBookLevel } from "../types.js";

export const round = (value: number, precision = 6): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

export const chunk = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const jitter = (value: number, ratio = 0.2): number => {
  const spread = value * ratio;
  const offset = (Math.random() * spread * 2) - spread;
  return Math.max(0, value + offset);
};

export const computeBackoffDelay = (
  baseMs: number,
  maxMs: number,
  attempt: number,
  ratio = 0.2,
): number => {
  const raw = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(jitter(raw, ratio));
};

export const parseArrayField = (value: string | string[]): string[] => {
  if (Array.isArray(value)) {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
};

export const normalizeOutcomeLabel = (value: string): string => {
  return value.trim().toLowerCase();
};

export const sortBidsDesc = (levels: OrderBookLevel[]): OrderBookLevel[] => {
  return [...levels].sort((left, right) => right.price - left.price);
};

export const sortAsksAsc = (levels: OrderBookLevel[]): OrderBookLevel[] => {
  return [...levels].sort((left, right) => left.price - right.price);
};

export const upsertLevel = (
  levels: OrderBookLevel[],
  incoming: OrderBookLevel,
  side: "bids" | "asks",
): OrderBookLevel[] => {
  const next = levels.filter((level) => level.price !== incoming.price);
  if (incoming.size > 0) {
    next.push(incoming);
  }

  return side === "bids" ? sortBidsDesc(next) : sortAsksAsc(next);
};

export const sum = (values: number[]): number => {
  return values.reduce((total, value) => total + value, 0);
};

export const formatUsd = (value: number): string => {
  return `$${value.toFixed(4)}`;
};

export const formatPct = (value: number): string => {
  return `${(value * 100).toFixed(3)}%`;
};

export const formatMs = (value?: number): string => {
  if (value === undefined || Number.isNaN(value)) {
    return "n/a";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  return `${value.toFixed(0)}ms`;
};

export const ensureDir = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
};

export const resolveDataPath = (baseDir: string, fileName: string): string => {
  return path.resolve(baseDir, fileName);
};

export const stableId = (...parts: string[]): string => {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
};

export const safeJsonParse = <T>(value: string): T | undefined => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

export const toTickSize = (value?: number): TickSize => {
  if (value === 0.1) {
    return "0.1";
  }

  if (value === 0.001) {
    return "0.001";
  }

  if (value === 0.0001) {
    return "0.0001";
  }

  return "0.01";
};

export const isoDateStamp = (value = new Date()): string => {
  return value.toISOString().slice(0, 10);
};
