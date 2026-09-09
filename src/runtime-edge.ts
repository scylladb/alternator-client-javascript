/*
 * Copyright ScyllaDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { HttpHandlerUserInput } from "@smithy/protocol-http";
import type { FetchHttpHandlerOptions } from "@smithy/types";
import {
  compressBody,
  decompressOrNormalizeResponse,
  normalizeFetchResponse,
} from "./compression-edge.js";
import {
  isHttpHandlerInstance,
  mergeDefinedOptions,
  withResponseCompression,
} from "./runtime-common.js";
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
}

function createRequestHandler(
  input: AlternatorDynamoDBClientConfig,
  config: NormalizedAlternatorConfig,
): HttpHandlerUserInput {
  const configuredHandler = input.requestHandler;
  const configuredHandlerIsInstance = isHttpHandlerInstance(configuredHandler);
  const stockFetchHandler = configuredHandlerIsInstance && isStockFetchHttpHandler(configuredHandler);
  const requestHandler = isHttpHandlerInstance(configuredHandler) || typeof configuredHandler === "function"
    ? FetchHttpHandler.create(configuredHandler as Parameters<typeof FetchHttpHandler.create>[0])
    : createFetchHttpHandler(config, configuredHandler as FetchHttpHandlerOptions | undefined);
  const responseDecompressor = requestHandler === configuredHandler && !stockFetchHandler
    ? decompressOrNormalizeResponse
    : normalizeFetchResponse;
  return withResponseCompression(
    requestHandler,
    config.compression.response.enabled,
    responseDecompressor,
  );
}

function isStockFetchHttpHandler(requestHandler: HttpHandlerUserInput): boolean {
  return requestHandler instanceof FetchHttpHandler &&
    requestHandler.handle === FetchHttpHandler.prototype.handle;
}

function createFetchHttpHandler(
  config: NormalizedAlternatorConfig,
  requestHandlerOptions?: FetchHttpHandlerOptions,
): FetchHttpHandler {
  const fetchOptions: FetchHttpHandlerOptions = {
    ...(config.connection && "fetch" in config.connection ? config.connection.fetch : undefined),
  };
  if (config.connection?.timeouts?.requestMs !== undefined) {
    fetchOptions.requestTimeout = config.connection.timeouts.requestMs;
  }
  if (config.connection?.keepAlive !== undefined) {
    fetchOptions.keepAlive = config.connection.keepAlive;
  }
  return new FetchHttpHandler(mergeDefinedOptions(fetchOptions, requestHandlerOptions));
}
