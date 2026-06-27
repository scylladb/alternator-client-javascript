import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import type { FetchHttpHandlerOptions, NodeHttpHandlerOptions } from "@smithy/types";
import type { AlternatorRoutingScope } from "./routing.js";

export type AlternatorScheme = "http" | "https";
export type AlternatorRuntime = "node" | "edge";
export type AlternatorKeyRouteAffinityMode = "read-before-write" | "any-write";
export type AlternatorUserAgentTransformer = (userAgent: string) => string | null | undefined;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

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
  thresholdBytes?: number;
  gzipLevel?: number;
  compressor?: AlternatorRequestCompressor;
}

export type AlternatorRequestCompressionConfig = false | AlternatorRequestCompressionOptions;
export type AlternatorResponseCompressionAlgorithm = "gzip" | "deflate";

export interface AlternatorResponseCompressionOptions {
  algorithms?: readonly AlternatorResponseCompressionAlgorithm[];
}

export type AlternatorResponseCompressionConfig = false | AlternatorResponseCompressionOptions;

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
  allowedHeaders?: readonly string[];
  additionalAllowedHeaders?: readonly string[];
}

export interface AlternatorUserAgentOptions {
  value?: string;
  append?: string;
  transform?: AlternatorUserAgentTransformer;
}

export type AlternatorUserAgentConfig = false | AlternatorUserAgentOptions;

export type AlternatorPartitionKeyByTable = Record<string, string> | ReadonlyMap<string, string>;

export interface AlternatorKeyRouteAffinityOptions {
  mode?: AlternatorKeyRouteAffinityMode;
  partitionKeys?: AlternatorPartitionKeyByTable;
  autoDiscoverPartitionKeys?: boolean;
}

export type AlternatorKeyRouteAffinityConfig = false | AlternatorKeyRouteAffinityOptions;

export type AlternatorTlsMaterial =
  | { readonly text: string }
  | { readonly bytes: Uint8Array }
  | { readonly file: string };

export interface AlternatorTlsOptions {
  ca?: AlternatorTlsMaterial;
  cert?: AlternatorTlsMaterial;
  key?: AlternatorTlsMaterial;
  rejectUnauthorized?: boolean;
  sessionCache?: boolean;
}

export interface AlternatorDiscoveryOptions {
  background?: boolean;
  refreshIntervalMs?: number;
  requestRefreshIntervalMs?: number;
  timeoutMs?: number;
}

export interface AlternatorConnectionTimeoutOptions {
  connectMs?: number;
  requestMs?: number;
  socketMs?: number;
}

export interface AlternatorNodeConnectionOptions {
  keepAlive?: boolean;
  maxSockets?: number;
  timeouts?: AlternatorConnectionTimeoutOptions;
  throwOnRequestTimeout?: boolean;
  node?: Omit<NodeHttpHandlerOptions, "httpAgent" | "httpsAgent">;
}

export interface AlternatorEdgeConnectionOptions {
  keepAlive?: boolean;
  timeouts?: Pick<AlternatorConnectionTimeoutOptions, "requestMs">;
  fetch?: FetchHttpHandlerOptions;
}

export type AlternatorConnectionOptions =
  | AlternatorNodeConnectionOptions
  | AlternatorEdgeConnectionOptions;

type BaseDynamoDBClientConfig = Omit<
  DynamoDBClientConfig,
  "credentials" | "endpoint" | "logger" | "region" | "requestHandler" | "runtime" | "tls"
>;

interface BaseAlternatorDynamoDBClientConfig extends BaseDynamoDBClientConfig {
  seeds: NonEmptyReadonlyArray<string>;
  scheme?: AlternatorScheme;
  port?: number;
  routing?: AlternatorRoutingScope;
  region?: DynamoDBClientConfig["region"];
  credentials?: DynamoDBClientConfig["credentials"];
  requestHandler?: DynamoDBClientConfig["requestHandler"];
  compression?: AlternatorCompressionOptions;
  headerOptimization?: boolean | AlternatorHeaderOptimizationOptions;
  userAgent?: AlternatorUserAgentConfig;
  keyRouteAffinity?: AlternatorKeyRouteAffinityConfig;
  discovery?: AlternatorDiscoveryOptions;
  logger?: AlternatorLogger;
}

export interface AlternatorNodeDynamoDBClientConfig extends BaseAlternatorDynamoDBClientConfig {
  runtime?: "node";
  tls?: AlternatorTlsOptions;
  connection?: AlternatorNodeConnectionOptions;
}

export interface AlternatorEdgeDynamoDBClientConfig extends BaseAlternatorDynamoDBClientConfig {
  runtime: "edge";
  tls?: never;
  connection?: AlternatorEdgeConnectionOptions;
}

export type AlternatorDynamoDBClientConfig =
  | AlternatorNodeDynamoDBClientConfig
  | AlternatorEdgeDynamoDBClientConfig;

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
  readonly mode: AlternatorKeyRouteAffinityMode;
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
  readonly routing: AlternatorRoutingScope;
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
