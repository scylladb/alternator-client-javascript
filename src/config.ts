import { routing } from "./routing.js";
import { normalizeLogger } from "./logger.js";
import { normalizeUserAgent } from "./user-agent.js";
import type { RoutingRule } from "./routing.js";
import { ResponseCompressionDeflate, ResponseCompressionGzip } from "./types.js";
import type {
  AlternatorConnectionOptions,
  AlternatorDynamoDBClientConfig,
  AlternatorKeyRouteAffinityType,
  AlternatorResponseCompression,
  AlternatorRuntime,
  NormalizedAlternatorConfig,
  NormalizedResponseCompressionOptions,
} from "./types.js";

const DEFAULT_ALLOWED_HEADERS = [
  "Host",
  "X-Amz-Target",
  "Content-Length",
  "Accept-Encoding",
  "Content-Encoding",
] as const;
const DEFAULT_RESPONSE_COMPRESSION_ENCODINGS = [
  ResponseCompressionGzip,
  ResponseCompressionDeflate,
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
  const responseCompression = normalizeResponseCompression(input.responseCompression);
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
    responseCompression,
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
  if ("endpoint" in input && input.endpoint !== undefined) {
    throw new TypeError("AlternatorDynamoDBClient requires seeds; do not pass endpoint");
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
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }

  const colonCount = [...trimmed].filter((char) => char === ":").length;
  if (colonCount === 1) {
    throw new TypeError(`seed "${seed}" must not include a port; use the port option`);
  }

  return trimmed;
}

function normalizeRouting(input: AlternatorDynamoDBClientConfig["routing"]): RoutingRule {
  if (input === undefined) {
    return routing.cluster();
  }
  return normalizeRoutingRule(input, "routing");
}

function normalizeRoutingRule(input: unknown, label: string): RoutingRule {
  if (!isRecord(input)) {
    throw new TypeError(`${label} must be a routing rule object`);
  }

  switch (input.kind) {
    case "cluster":
      return routing.cluster();
    case "datacenter":
      assertNonEmptyString(input.datacenter, `${label}.datacenter`);
      return {
        kind: "datacenter",
        datacenter: input.datacenter,
        ...normalizeRoutingFallback(input.fallback, label),
      };
    case "rack":
      assertNonEmptyString(input.datacenter, `${label}.datacenter`);
      assertNonEmptyString(input.rack, `${label}.rack`);
      return {
        kind: "rack",
        datacenter: input.datacenter,
        rack: input.rack,
        ...normalizeRoutingFallback(input.fallback, label),
      };
    default:
      throw new TypeError(`${label}.kind must be "cluster", "datacenter", or "rack"`);
  }
}

function normalizeRoutingFallback(
  fallback: unknown,
  label: string,
): { fallback?: RoutingRule } {
  if (fallback === undefined) {
    return {};
  }
  return { fallback: normalizeRoutingRule(fallback, `${label}.fallback`) };
}

function normalizeRuntime(runtime: AlternatorDynamoDBClientConfig["runtime"]): AlternatorRuntime {
  const normalized = runtime ?? detectRuntime();
  if (normalized !== "node" && normalized !== "edge") {
    throw new TypeError('runtime must be either "node" or "edge"');
  }
  return normalized;
}

function normalizeCompression(input: AlternatorDynamoDBClientConfig["compression"]) {
  if (typeof input === "boolean") {
    return { enabled: input, thresholdBytes: 0 };
  }
  const normalized = {
    enabled: input?.enabled ?? false,
    thresholdBytes: input?.thresholdBytes ?? 0,
    ...(input?.gzipLevel !== undefined ? { gzipLevel: input.gzipLevel } : {}),
    ...(input?.compressor ? { compressor: input.compressor } : {}),
  };
  if (normalized.gzipLevel !== undefined && (normalized.gzipLevel < -1 || normalized.gzipLevel > 9)) {
    throw new TypeError("compression.gzipLevel must be between -1 and 9");
  }
  return normalized;
}

function normalizeResponseCompression(
  input: AlternatorDynamoDBClientConfig["responseCompression"],
): NormalizedResponseCompressionOptions {
  if (input === undefined || input === false) {
    return { enabled: false, encodings: [] };
  }

  const encodings = responseCompressionEncodings(input)
    .map(normalizeResponseCompressionEncoding)
    .filter((encoding, index, values) => values.indexOf(encoding) === index);

  return {
    enabled: encodings.length > 0,
    encodings,
  };
}

function responseCompressionEncodings(
  input: NonNullable<AlternatorDynamoDBClientConfig["responseCompression"]>,
): readonly unknown[] {
  if (input === true) {
    return DEFAULT_RESPONSE_COMPRESSION_ENCODINGS;
  }
  if (!isRecord(input)) {
    throw new TypeError("responseCompression must be a boolean or options object");
  }
  if (input.enabled === false) {
    return [];
  }
  if (input.encodings !== undefined) {
    if (!Array.isArray(input.encodings)) {
      throw new TypeError("responseCompression.encodings must be an array");
    }
  }
  if (input.enabled !== true) {
    return [];
  }
  return input.encodings ?? DEFAULT_RESPONSE_COMPRESSION_ENCODINGS;
}

function normalizeResponseCompressionEncoding(encoding: unknown): AlternatorResponseCompression {
  switch (encoding) {
    case ResponseCompressionGzip:
    case ResponseCompressionDeflate:
      return encoding;
    default:
      throw new TypeError('responseCompression encodings must be "gzip" or "deflate"');
  }
}

function normalizeHeaderOptimization(input: AlternatorDynamoDBClientConfig["headerOptimization"], noAuth: boolean) {
  if (typeof input === "boolean") {
    return {
      enabled: input,
      allowedHeaders: defaultAllowedHeaders(noAuth),
    };
  }
  return {
    enabled: input?.enabled ?? false,
    allowedHeaders: input?.allowedHeaders ?? input?.stripHeaders ?? defaultAllowedHeaders(noAuth),
  };
}

function normalizeKeyRouteAffinity(input: AlternatorDynamoDBClientConfig["keyRouteAffinity"]) {
  if (typeof input === "boolean") {
    return {
      enabled: input,
      type: input ? "any-write" : "none",
      partitionKeys: new Map<string, string>(),
      autoDiscoverPartitionKeys: input,
    } as const;
  }
  const type = normalizeKeyRouteAffinityType(input?.type ?? (input?.enabled ? "any-write" : "none"));
  return {
    enabled: type !== "none" && input?.enabled !== false,
    type,
    partitionKeys: normalizePartitionKeys(input?.partitionKeys),
    autoDiscoverPartitionKeys: input?.autoDiscoverPartitionKeys ?? type !== "none",
  } as const;
}

function normalizePartitionKeys(partitionKeys: unknown): Map<string, string> {
  if (partitionKeys === undefined) {
    return new Map<string, string>();
  }
  if (typeof partitionKeys !== "object" || partitionKeys === null || Array.isArray(partitionKeys)) {
    throw new TypeError("keyRouteAffinity.partitionKeys must be an object mapping table names to partition keys");
  }

  const normalized = new Map<string, string>();
  for (const [tableName, keyName] of Object.entries(partitionKeys)) {
    if (tableName.trim() === "") {
      throw new TypeError("keyRouteAffinity.partitionKeys table names must be non-empty strings");
    }
    if (typeof keyName !== "string" || keyName.trim() === "") {
      throw new TypeError("keyRouteAffinity.partitionKeys values must be non-empty strings");
    }
    normalized.set(tableName, keyName);
  }
  return normalized;
}

function normalizeKeyRouteAffinityType(type: unknown): AlternatorKeyRouteAffinityType {
  if (type === "none" || type === "read-before-write" || type === "any-write") {
    return type;
  }
  throw new TypeError('keyRouteAffinity.type must be "none", "read-before-write", or "any-write"');
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
  if (input.maxSockets !== undefined) {
    assertPositive(input.maxSockets, "connection.maxSockets");
  }
  if (input.connectionTimeoutMs !== undefined) {
    assertNonNegative(input.connectionTimeoutMs, "connection.connectionTimeoutMs");
  }
  if (input.requestTimeoutMs !== undefined) {
    assertNonNegative(input.requestTimeoutMs, "connection.requestTimeoutMs");
  }
  if (input.socketTimeoutMs !== undefined) {
    assertNonNegative(input.socketTimeoutMs, "connection.socketTimeoutMs");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultAllowedHeaders(noAuth: boolean): readonly string[] {
  if (noAuth) {
    return DEFAULT_ALLOWED_HEADERS;
  }
  return [...DEFAULT_ALLOWED_HEADERS, "Authorization", "X-Amz-Date"];
}
