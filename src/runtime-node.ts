import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type {
  HttpHandlerOptions,
  NodeHttpHandlerOptions,
} from "@smithy/types";
import { readFile } from "node:fs/promises";
import { compressBody, decompressResponse } from "./compression-node.js";
import { withResponseCompression } from "./runtime-common.js";
import type {
  AlternatorDynamoDBClientConfig,
  AlternatorTlsMaterial,
  NormalizedAlternatorConfig,
} from "./types.js";

type Handler = HttpHandler<NodeHttpHandlerOptions>;

export const nodeRuntimePlatform = {
  assertRuntimeSupport,
  createRequestHandler,
  compressBody,
};

function assertRuntimeSupport(config: NormalizedAlternatorConfig): void {
  if (config.runtime !== "node") {
    throw new Error("Alternator Node entrypoint requires runtime node; use @scylladb/alternator-client/edge for edge runtime");
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

  return withResponseCompression(
    new LazyNodeHttpHandler(() => buildNodeHandlerOptions(config)),
    config.compression.response.enabled,
    decompressResponse,
  );
}

class LazyNodeHttpHandler implements Handler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  private delegate?: Handler;
  private pendingUpdates = new Map<keyof NodeHttpHandlerOptions, NodeHttpHandlerOptions[keyof NodeHttpHandlerOptions]>();

  constructor(private readonly optionsProvider: () => Promise<NodeHttpHandlerOptions>) {}

  async handle(
    request: HttpRequest,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }> {
    const delegate = await this.getDelegate();
    return delegate.handle(request, options);
  }

  destroy(): void {
    this.delegate?.destroy?.();
  }

  updateHttpClientConfig<K extends keyof NodeHttpHandlerOptions>(
    key: K,
    value: NodeHttpHandlerOptions[K],
  ): void {
    if (this.delegate && "updateHttpClientConfig" in this.delegate) {
      this.delegate.updateHttpClientConfig?.(key, value);
      return;
    }
    this.pendingUpdates.set(key, value);
  }

  httpHandlerConfigs(): NodeHttpHandlerOptions {
    if (this.delegate && "httpHandlerConfigs" in this.delegate) {
      return this.delegate.httpHandlerConfigs?.() ?? {};
    }
    return Object.fromEntries(this.pendingUpdates);
  }

  private async getDelegate(): Promise<Handler> {
    if (!this.delegate) {
      const options = await this.optionsProvider();
      for (const [key, value] of this.pendingUpdates) {
        (options as Record<string, unknown>)[key] = value;
      }
      this.delegate = new NodeHttpHandler(options);
    }
    return this.delegate;
  }
}

async function buildNodeHandlerOptions(
  config: NormalizedAlternatorConfig,
): Promise<NodeHttpHandlerOptions> {
  const connection = config.connection;
  const tls = config.tls;
  const keepAlive = connection?.keepAlive ?? true;
  const maxSockets = connection && "maxSockets" in connection ? connection.maxSockets ?? 50 : 50;

  const httpAgent: Record<string, unknown> = { keepAlive, maxSockets };
  const httpsAgent: Record<string, unknown> = { keepAlive, maxSockets };

  if (tls) {
    if (tls.ca !== undefined) {
      httpsAgent.ca = await tlsMaterialValue(tls.ca);
    }
    if (tls.cert !== undefined) {
      httpsAgent.cert = await tlsMaterialValue(tls.cert);
    }
    if (tls.key !== undefined) {
      httpsAgent.key = await tlsMaterialValue(tls.key);
    }
    if (tls.rejectUnauthorized !== undefined) {
      httpsAgent.rejectUnauthorized = tls.rejectUnauthorized;
    }
    if (tls.sessionCache === false) {
      httpsAgent.maxCachedSessions = 0;
    }
  }

  const options: NodeHttpHandlerOptions = {
    httpAgent,
    httpsAgent,
    ...(connection && "node" in connection ? connection.node : undefined),
  };

  if (connection?.timeouts?.requestMs !== undefined) {
    options.requestTimeout = connection.timeouts.requestMs;
  }
  if (connection?.timeouts && "connectMs" in connection.timeouts && connection.timeouts.connectMs !== undefined) {
    options.connectionTimeout = connection.timeouts.connectMs;
  }
  if (connection?.timeouts && "socketMs" in connection.timeouts && connection.timeouts.socketMs !== undefined) {
    options.socketTimeout = connection.timeouts.socketMs;
  }
  if (connection && "throwOnRequestTimeout" in connection && connection.throwOnRequestTimeout !== undefined) {
    options.throwOnRequestTimeout = connection.throwOnRequestTimeout;
  }

  return options;
}

async function tlsMaterialValue(material: AlternatorTlsMaterial): Promise<string | Uint8Array> {
  if ("file" in material) {
    return readFile(material.file);
  }
  if ("bytes" in material) {
    return material.bytes;
  }
  return material.text;
}
