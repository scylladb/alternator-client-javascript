import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { FetchHttpHandlerOptions, NodeHttpHandlerOptions } from "@smithy/types";
import type { RoutingRule } from "./routing.js";

export type AlternatorScheme = "http" | "https";
export type AlternatorRuntime = "node" | "edge";
export type AlternatorKeyRouteAffinityType = "none" | "read-before-write" | "any-write";
export type AlternatorUserAgentTransformer = (userAgent: string) => string | null | undefined;

export interface AlternatorLogger {
  debug?: (...content: unknown[]) => void;
  info?: (...content: unknown[]) => void;
  warn?: (...content: unknown[]) => void;
  error?: (...content: unknown[]) => void;
}

export interface AlternatorNode {
  readonly host: string;
  readonly scheme: AlternatorScheme;
  readonly port: number;
  readonly url: string;
}

export interface AlternatorRequestCompressionOptions {
  enabled?: boolean;
  thresholdBytes?: number;
  gzipLevel?: number;
  compressor?: AlternatorRequestCompressor;
}

export type AlternatorRequestCompressionConfig = boolean | AlternatorRequestCompressionOptions;

export const ResponseCompressionGzip = "gzip" as const;
export const ResponseCompressionDeflate = "deflate" as const;

export type AlternatorResponseCompressionAlgorithm =
  | typeof ResponseCompressionGzip
  | typeof ResponseCompressionDeflate;

export type AlternatorResponseCompression = AlternatorResponseCompressionAlgorithm;
export type ResponseCompression = AlternatorResponseCompressionAlgorithm;

export interface AlternatorResponseCompressionOptions {
  enabled?: boolean;
  algorithms?: readonly AlternatorResponseCompressionAlgorithm[];
}

export type AlternatorResponseCompressionConfig = boolean | AlternatorResponseCompressionOptions;

export interface AlternatorCompressionOptions {
  request?: AlternatorRequestCompressionConfig;
  response?: AlternatorResponseCompressionConfig;
}

export interface AlternatorRequestCompressorResult {
  readonly body: Uint8Array;
  readonly contentEncoding: string;
  readonly contentLength?: number;
}

export type AlternatorRequestCompressor = (
  body: Uint8Array,
) => AlternatorRequestCompressorResult | Promise<AlternatorRequestCompressorResult>;

export interface AlternatorHeaderOptimizationOptions {
  enabled?: boolean;
  allowedHeaders?: readonly string[];
  /**
   * @deprecated Use allowedHeaders. Header optimization uses a whitelist, not a strip-list.
   */
  stripHeaders?: readonly string[];
}

export interface AlternatorUserAgentOptions {
  enabled?: boolean;
  value?: string;
  transform?: AlternatorUserAgentTransformer;
}

export type AlternatorUserAgentConfig =
  | boolean
  | string
  | AlternatorUserAgentTransformer
  | AlternatorUserAgentOptions;

export type AlternatorPartitionKeyByTable = Record<string, string>;

export interface AlternatorKeyRouteAffinityOptions {
  enabled?: boolean;
  type?: AlternatorKeyRouteAffinityType;
  partitionKeys?: AlternatorPartitionKeyByTable;
  autoDiscoverPartitionKeys?: boolean;
}

export interface AlternatorTlsOptions {
  ca?: string | Uint8Array;
  caFile?: string;
  cert?: string | Uint8Array;
  certFile?: string;
  key?: string | Uint8Array;
  keyFile?: string;
  rejectUnauthorized?: boolean;
  sessionCache?: boolean;
}

export interface AlternatorDiscoveryOptions {
  background?: boolean;
  refreshIntervalMs?: number;
  requestRefreshIntervalMs?: number;
  timeoutMs?: number;
}

export interface AlternatorConnectionOptions {
  keepAlive?: boolean;
  maxSockets?: number;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  throwOnRequestTimeout?: boolean;
  node?: Omit<NodeHttpHandlerOptions, "httpAgent" | "httpsAgent">;
  fetch?: FetchHttpHandlerOptions;
}

type BaseDynamoDBClientConfig = Omit<
  DynamoDBClientConfig,
  "credentials" | "endpoint" | "region" | "requestHandler" | "runtime" | "tls"
>;

export interface AlternatorDynamoDBClientConfig extends BaseDynamoDBClientConfig {
  seeds: readonly string[];
  scheme?: AlternatorScheme;
  port?: number;
  routing?: RoutingRule;
  region?: DynamoDBClientConfig["region"];
  credentials?: DynamoDBClientConfig["credentials"];
  runtime?: AlternatorRuntime;
  requestHandler?: DynamoDBClientConfig["requestHandler"];
  compression?: AlternatorCompressionOptions;
  headerOptimization?: boolean | AlternatorHeaderOptimizationOptions;
  userAgent?: AlternatorUserAgentConfig;
  keyRouteAffinity?: boolean | AlternatorKeyRouteAffinityOptions;
  tls?: AlternatorTlsOptions;
  discovery?: AlternatorDiscoveryOptions;
  connection?: AlternatorConnectionOptions;
  endpoint?: never;
}

export interface NormalizedRequestCompressionOptions {
  readonly enabled: boolean;
  readonly thresholdBytes: number;
  readonly gzipLevel?: number;
  readonly compressor?: AlternatorRequestCompressor;
}

export interface NormalizedResponseCompressionOptions {
  readonly enabled: boolean;
  readonly algorithms: readonly AlternatorResponseCompressionAlgorithm[];
}

export interface NormalizedCompressionOptions {
  readonly request: NormalizedRequestCompressionOptions;
  readonly response: NormalizedResponseCompressionOptions;
}

export interface NormalizedHeaderOptimizationOptions {
  readonly enabled: boolean;
  readonly allowedHeaders: readonly string[];
}

export interface NormalizedUserAgentOptions {
  readonly value?: string;
}

export interface NormalizedKeyRouteAffinityOptions {
  readonly enabled: boolean;
  readonly type: AlternatorKeyRouteAffinityType;
  readonly partitionKeys: ReadonlyMap<string, string>;
  readonly autoDiscoverPartitionKeys: boolean;
}

export interface NormalizedDiscoveryOptions {
  readonly background: boolean;
  readonly refreshIntervalMs: number;
  readonly requestRefreshIntervalMs: number;
  readonly timeoutMs: number;
}

export interface NormalizedAlternatorConfig {
  readonly seeds: readonly string[];
  readonly scheme: AlternatorScheme;
  readonly port: number;
  readonly routing: RoutingRule;
  readonly runtime: AlternatorRuntime;
  readonly compression: NormalizedCompressionOptions;
  readonly headerOptimization: NormalizedHeaderOptimizationOptions;
  readonly userAgent: NormalizedUserAgentOptions;
  readonly keyRouteAffinity: NormalizedKeyRouteAffinityOptions;
  readonly discovery: NormalizedDiscoveryOptions;
  readonly tls?: AlternatorTlsOptions;
  readonly connection?: AlternatorConnectionOptions;
  readonly noAuth: boolean;
  readonly logger: AlternatorLogger;
}
