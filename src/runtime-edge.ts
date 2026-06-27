import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { HttpHandlerUserInput } from "@smithy/protocol-http";
import { compressBody, decompressResponse } from "./compression-edge.js";
import { withResponseCompression } from "./runtime-common.js";
import type {
  AlternatorDynamoDBClientConfig,
  NormalizedAlternatorConfig,
} from "./types.js";

export const edgeRuntimePlatform = {
  assertRuntimeSupport,
  createRequestHandler,
  compressBody,
};

function assertRuntimeSupport(config: NormalizedAlternatorConfig): void {
  if (config.runtime !== "edge") {
    throw new Error("Alternator edge entrypoint requires runtime edge");
  }

  if (config.tls && Object.keys(config.tls).length > 0) {
    throw new Error("Alternator edge runtime does not support custom TLS or CA options");
  }

  const connection = config.connection;
  if (connection && "maxSockets" in connection && connection.maxSockets !== undefined) {
    throw new Error("Alternator edge runtime does not support socket pool tuning");
  }
  if (
    (connection?.timeouts && "socketMs" in connection.timeouts && connection.timeouts.socketMs !== undefined) ||
    (connection?.timeouts && "connectMs" in connection.timeouts && connection.timeouts.connectMs !== undefined)
  ) {
    throw new Error("Alternator edge runtime does not support Node socket timeout options");
  }
  if (connection && "node" in connection && connection.node !== undefined) {
    throw new Error("Alternator edge runtime does not support Node HTTP handler options");
  }

  const requestCompression = config.compression.request;
  if (requestCompression.enabled && !requestCompression.compressor && typeof CompressionStream === "undefined") {
    throw new Error("Alternator edge runtime gzip compression requires CompressionStream support");
  }
  if (config.compression.response.enabled && typeof DecompressionStream === "undefined") {
    throw new Error("Alternator edge runtime response compression requires DecompressionStream support");
  }
}

function createRequestHandler(
  input: AlternatorDynamoDBClientConfig,
  config: NormalizedAlternatorConfig,
): HttpHandlerUserInput {
  if (input.requestHandler) {
    return withResponseCompression(
      input.requestHandler,
      config.compression.response.enabled,
      decompressResponse,
    );
  }

  const fetchOptions = {
    ...(config.connection && "fetch" in config.connection ? config.connection.fetch : undefined),
  };
  if (config.connection?.timeouts?.requestMs !== undefined) {
    fetchOptions.requestTimeout = config.connection.timeouts.requestMs;
  }
  if (config.connection?.keepAlive !== undefined) {
    fetchOptions.keepAlive = config.connection.keepAlive;
  }
  return withResponseCompression(
    new FetchHttpHandler(fetchOptions),
    config.compression.response.enabled,
    decompressResponse,
  );
}
