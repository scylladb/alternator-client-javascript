import type { AlternatorLogger } from "./types.js";

export const noopLogger: Required<AlternatorLogger> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function normalizeLogger(logger: AlternatorLogger | undefined): Required<AlternatorLogger> {
  return {
    debug: logger?.debug?.bind(logger) ?? noopLogger.debug,
    info: logger?.info?.bind(logger) ?? noopLogger.info,
    warn: logger?.warn?.bind(logger) ?? noopLogger.warn,
    error: logger?.error?.bind(logger) ?? noopLogger.error,
  };
}
