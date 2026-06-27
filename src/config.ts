import { routing } from "./routing.js";
import { normalizeLogger } from "./logger.js";
import { normalizeUserAgent } from "./user-agent.js";
import type { AlternatorRoutingScope } from "./routing.js";
import type {
  AlternatorCompressionOptions,
  AlternatorConnectionOptions,
  AlternatorDynamoDBClientConfig,
  AlternatorKeyRouteAffinityMode,
  AlternatorRequestCompressionConfig,
  AlternatorResponseCompressionAlgorithm,
  AlternatorResponseCompressionConfig,
  AlternatorRuntime,
  NormalizedAlternatorConfig,
  NormalizedCompressionOptions,
  NormalizedRequestCompressionOptions,
  NormalizedResponseCompressionOptions,
} from "./types.js";

const DEFAULT_ALLOWED_HEADERS = [
  "Host",
  "X-Amz-Target",
  "Content-Length",
  "Accept-Encoding",
  "Content-Encoding",
] as const;
const DEFAULT_RESPONSE_COMPRESSION_ALGORITHMS = [
  "gzip",
] as const;

export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_SCHEME = "http";
export const DEFAULT_PORT = 8080;
export const HTTPS_ALTERNATOR_PORT = 8043;

export const NO_AUTH_CREDENTIALS = {
  accessKeyId: "alternator",
  secretAccessKey: "alternator",
};

export function detectRuntime(): AlternatorRuntime {
  return typeof process !== "undefined" && process.versions?.node ? "node" : "edge";
}

export function normalizeConfig(input: AlternatorDynamoDBClientConfig): NormalizedAlternatorConfig {
  assertNoEndpoint(input);

  const scheme = input.scheme ?? DEFAULT_SCHEME;
  if (scheme !== "http" && scheme !== "https") {
    throw new TypeError('scheme must be either "http" or "https"');
  }

  const port = input.port ?? DEFAULT_PORT;
  assertPort(port);

  const seeds = normalizeSeeds(input.seeds);
  const runtime = normalizeRuntime(input.runtime);
  const noAuth = input.credentials === undefined;
  const routingRule = normalizeRouting(input.routing);
  const compression = normalizeCompression(input.compression);
  const headerOptimization = normalizeHeaderOptimization(input.headerOptimization, noAuth);
  const userAgent = normalizeUserAgent(input.userAgent);
  const keyRouteAffinity = normalizeKeyRouteAffinity(input.keyRouteAffinity);
  const discovery = normalizeDiscovery(input.discovery, runtime);
  const connection = input.connection ? normalizeConnection(input.connection) : undefined;

  return {
    seeds,
    scheme,
    port,
    routing: routingRule,
    runtime,
    compression,
    headerOptimization,
    userAgent,
    keyRouteAffinity,
    discovery,
    ...(input.tls ? { tls: input.tls } : {}),
    ...(connection ? { connection } : {}),
    noAuth,
    logger: normalizeLogger(input.logger),
  };
}

export function firstEndpointUrl(config: NormalizedAlternatorConfig): string {
  const firstSeed = config.seeds[0];
  if (!firstSeed) {
    throw new TypeError("seeds must contain at least one host");
  }
  return `${config.scheme}://${hostForUrl(firstSeed)}:${config.port}`;
}

export function nodeUrl(host: string, config: NormalizedAlternatorConfig): string {
  return `${config.scheme}://${hostForUrl(host)}:${config.port}`;
}

export function hostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  return host.includes(":") ? `[${host}]` : host;
}

function assertNoEndpoint(input: AlternatorDynamoDBClientConfig): void {
  const maybeEndpoint = input as AlternatorDynamoDBClientConfig & { endpoint?: unknown };
  if ("endpoint" in maybeEndpoint && maybeEndpoint.endpoint !== undefined) {
    throw new TypeError("AlternatorDynamoDBClient uses seeds, scheme, and port instead of endpoint");
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("port must be an integer between 1 and 65535");
  }
}

function normalizeSeeds(seeds: readonly string[]): string[] {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new TypeError("seeds must contain at least one host");
  }
  return seeds.map(normalizeSeed);
}

function normalizeSeed(seed: string): string {
  if (typeof seed !== "string") {
    throw new TypeError("each seed must be a hostname or IP address string");
  }

  const trimmed = seed.trim();
  if (trimmed === "") {
    throw new TypeError("seeds cannot contain an empty host");
  }
  if (trimmed.includes("://") || /[/?#]/.test(trimmed)) {
    throw new TypeError(`seed "${seed}" must be a host, not a URL`);
  }
  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]");
    if (bracketEnd < 0) {
      throw new TypeError(`seed "${seed}" must be a valid IPv6 host`);
    }
    if (bracketEnd !== trimmed.length - 1) {
      throw new TypeError(`seed "${seed}" must not include a port; use the port option`);
    }
    return trimmed.slice(1, -1);
  }
  if (trimmed.includes("]")) {
    throw new TypeError(`seed "${seed}" must be a valid IPv6 host`);
  }

  const colonCount = [...trimmed].filter((char) => char === ":").length;
  if (colonCount === 1) {
    throw new TypeError(`seed "${seed}" must not include a port; use the port option`);
  }

  return trimmed;
}

function normalizeRouting(input: AlternatorDynamoDBClientConfig["routing"]): AlternatorRoutingScope {
  if (input === undefined) {
    return routing.cluster();
  }
  return normalizeRoutingScope(input, "routing");
}

function normalizeRoutingScope(input: unknown, label: string): AlternatorRoutingScope {
  if (!isRecord(input)) {
    throw new TypeError(`${label} must be a routing scope object`);
  }

  switch (input.kind) {
    case "cluster":
      return routing.cluster();
    case "datacenter":
      assertNonEmptyString(input.datacenter, `${label}.datacenter`);
      return routing.datacenter({
        datacenter: input.datacenter,
        ...normalizeRoutingFallback(input.fallback, label),
      });
    case "rack":
      assertNonEmptyString(input.datacenter, `${label}.datacenter`);
      assertNonEmptyString(input.rack, `${label}.rack`);
      return routing.rack({
        datacenter: input.datacenter,
        rack: input.rack,
        ...normalizeRoutingFallback(input.fallback, label),
      });
    default:
      throw new TypeError(`${label}.kind must be "cluster", "datacenter", or "rack"`);
  }
}

function normalizeRoutingFallback(
  fallback: unknown,
  label: string,
): { fallback?: AlternatorRoutingScope } {
  if (fallback === undefined) {
    return {};
  }
  return { fallback: normalizeRoutingScope(fallback, `${label}.fallback`) };
}

function normalizeRuntime(runtime: AlternatorDynamoDBClientConfig["runtime"]): AlternatorRuntime {
  const normalized = runtime ?? detectRuntime();
  if (normalized !== "node" && normalized !== "edge") {
    throw new TypeError('runtime must be either "node" or "edge"');
  }
  return normalized;
}

function normalizeCompression(input: AlternatorDynamoDBClientConfig["compression"]): NormalizedCompressionOptions {
  if (input === undefined) {
    return {
      request: normalizeRequestCompression(undefined),
      response: normalizeResponseCompression(undefined),
    };
  }
  if (!isRecord(input)) {
    throw new TypeError("compression must be an object with request and/or response options");
  }
  assertAllowedKeys(input, ["request", "response"], "compression");
  const compression = input as AlternatorCompressionOptions;
  return {
    request: normalizeRequestCompression(compression.request),
    response: normalizeResponseCompression(compression.response),
  };
}

function normalizeRequestCompression(
  input: AlternatorRequestCompressionConfig | undefined,
): NormalizedRequestCompressionOptions {
  if (input === undefined || input === false) {
    return { enabled: false, thresholdBytes: 0 };
  }
  if (!isRecord(input)) {
    throw new TypeError("compression.request must be false or a request compression object");
  }
  assertAllowedKeys(input, ["thresholdBytes", "gzipLevel", "compressor"], "compression.request");
  const options = input as Exclude<AlternatorRequestCompressionConfig, false>;
  const gzipLevel = options.gzipLevel;
  if (gzipLevel !== undefined && (gzipLevel < -1 || gzipLevel > 9)) {
    throw new TypeError("compression.request.gzipLevel must be between -1 and 9");
  }
  return {
    enabled: true,
    thresholdBytes: options.thresholdBytes ?? 0,
    ...(gzipLevel !== undefined ? { gzipLevel } : {}),
    ...(options.compressor ? { compressor: options.compressor } : {}),
  };
}

function normalizeResponseCompression(
  input: AlternatorResponseCompressionConfig | undefined,
): NormalizedResponseCompressionOptions {
  if (input === undefined || input === false) {
    return { enabled: false, algorithms: [] };
  }

  const algorithms = configuredResponseAlgorithms(input)
    .map(normalizeResponseCompressionAlgorithm)
    .filter((algorithm, index, values) => values.indexOf(algorithm) === index);

  return {
    enabled: algorithms.length > 0,
    algorithms,
  };
}

function configuredResponseAlgorithms(
  input: NonNullable<AlternatorResponseCompressionConfig>,
): readonly unknown[] {
  if (!isRecord(input)) {
    throw new TypeError("compression.response must be false or an options object");
  }
  assertAllowedKeys(input, ["algorithms"], "compression.response");
  if (input.algorithms !== undefined) {
    if (!Array.isArray(input.algorithms)) {
      throw new TypeError("compression.response.algorithms must be an array");
    }
  }
  return input.algorithms ?? DEFAULT_RESPONSE_COMPRESSION_ALGORITHMS;
}

function normalizeResponseCompressionAlgorithm(algorithm: unknown): AlternatorResponseCompressionAlgorithm {
  switch (algorithm) {
    case "gzip":
    case "deflate":
      return algorithm;
    default:
      throw new TypeError('compression.response algorithms must be "gzip" or "deflate"');
  }
}

function normalizeHeaderOptimization(input: AlternatorDynamoDBClientConfig["headerOptimization"], noAuth: boolean) {
  if (typeof input === "boolean") {
    return {
      enabled: input,
      allowedHeaders: defaultAllowedHeaders(noAuth),
    };
  }
  if (input === undefined) {
    return {
      enabled: false,
      allowedHeaders: defaultAllowedHeaders(noAuth),
    };
  }
  assertAllowedKeys(input as Record<string, unknown>, ["allowedHeaders", "additionalAllowedHeaders"], "headerOptimization");
  const baseHeaders = input.allowedHeaders ?? defaultAllowedHeaders(noAuth);
  return {
    enabled: true,
    allowedHeaders: [
      ...baseHeaders,
      ...(input.additionalAllowedHeaders ?? []),
    ],
  };
}

function normalizeKeyRouteAffinity(input: AlternatorDynamoDBClientConfig["keyRouteAffinity"]) {
  if (input === undefined || input === false) {
    return {
      enabled: false,
      mode: "any-write",
      partitionKeys: new Map<string, string>(),
      autoDiscoverPartitionKeys: false,
    } as const;
  }
  if (!isRecord(input)) {
    throw new TypeError("keyRouteAffinity must be false or an options object");
  }
  assertAllowedKeys(input, ["mode", "partitionKeys", "autoDiscoverPartitionKeys"], "keyRouteAffinity");
  const options = input as {
    mode?: unknown;
    partitionKeys?: unknown;
    autoDiscoverPartitionKeys?: unknown;
  };
  if (
    options.autoDiscoverPartitionKeys !== undefined &&
    typeof options.autoDiscoverPartitionKeys !== "boolean"
  ) {
    throw new TypeError("keyRouteAffinity.autoDiscoverPartitionKeys must be a boolean");
  }
  const mode = normalizeKeyRouteAffinityMode(options.mode ?? "any-write");
  return {
    enabled: true,
    mode,
    partitionKeys: normalizePartitionKeys(options.partitionKeys),
    autoDiscoverPartitionKeys: options.autoDiscoverPartitionKeys ?? true,
  } as const;
}

function normalizePartitionKeys(partitionKeys: unknown): Map<string, string> {
  if (partitionKeys === undefined) {
    return new Map<string, string>();
  }
  if (partitionKeys instanceof Map) {
    return normalizePartitionKeyEntries(partitionKeys.entries());
  }
  if (typeof partitionKeys !== "object" || partitionKeys === null || Array.isArray(partitionKeys)) {
    throw new TypeError("keyRouteAffinity.partitionKeys must be an object or map from table names to partition keys");
  }

  return normalizePartitionKeyEntries(Object.entries(partitionKeys));
}

function normalizePartitionKeyEntries(entries: Iterable<readonly [unknown, unknown]>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [tableName, keyName] of entries) {
    if (typeof tableName !== "string" || tableName.trim() === "") {
      throw new TypeError("keyRouteAffinity.partitionKeys table names must be non-empty strings");
    }
    if (typeof keyName !== "string" || keyName.trim() === "") {
      throw new TypeError("keyRouteAffinity.partitionKeys values must be non-empty strings");
    }
    normalized.set(tableName, keyName);
  }
  return normalized;
}

function normalizeKeyRouteAffinityMode(mode: unknown): AlternatorKeyRouteAffinityMode {
  if (mode === "read-before-write" || mode === "any-write") {
    return mode;
  }
  throw new TypeError('keyRouteAffinity.mode must be "read-before-write" or "any-write"');
}

function normalizeDiscovery(
  input: AlternatorDynamoDBClientConfig["discovery"],
  runtime: AlternatorRuntime,
) {
  const refreshIntervalMs = input?.refreshIntervalMs ?? 60_000;
  const requestRefreshIntervalMs = input?.requestRefreshIntervalMs ?? 60_000;
  const timeoutMs = input?.timeoutMs ?? 2_000;

  assertNonNegative(refreshIntervalMs, "discovery.refreshIntervalMs");
  assertNonNegative(requestRefreshIntervalMs, "discovery.requestRefreshIntervalMs");
  assertNonNegative(timeoutMs, "discovery.timeoutMs");

  return {
    background: input?.background ?? runtime === "node",
    refreshIntervalMs,
    requestRefreshIntervalMs,
    timeoutMs,
  };
}

function normalizeConnection(input: AlternatorConnectionOptions): AlternatorConnectionOptions {
  if ("node" in input && input.node !== undefined && ("httpAgent" in input.node || "httpsAgent" in input.node)) {
    throw new TypeError("connection.node cannot include httpAgent or httpsAgent; use Alternator connection and tls options");
  }
  if ("maxSockets" in input && input.maxSockets !== undefined) {
    assertPositive(input.maxSockets, "connection.maxSockets");
  }
  if (input.timeouts && "connectMs" in input.timeouts && input.timeouts.connectMs !== undefined) {
    assertNonNegative(input.timeouts.connectMs, "connection.timeouts.connectMs");
  }
  if (input.timeouts?.requestMs !== undefined) {
    assertNonNegative(input.timeouts.requestMs, "connection.timeouts.requestMs");
  }
  if (input.timeouts && "socketMs" in input.timeouts && input.timeouts.socketMs !== undefined) {
    assertNonNegative(input.timeouts.socketMs, "connection.timeouts.socketMs");
  }
  return input;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertAllowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label}.${key} is not a supported option`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultAllowedHeaders(noAuth: boolean): readonly string[] {
  if (noAuth) {
    return DEFAULT_ALLOWED_HEADERS;
  }
  return [...DEFAULT_ALLOWED_HEADERS, "Authorization", "X-Amz-Date"];
}
