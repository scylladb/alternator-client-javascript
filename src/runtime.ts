import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type {
  HttpHandlerOptions,
  NodeHttpHandlerOptions,
  RequestHandlerMetadata,
} from "@smithy/types";
import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import { decompressResponse } from "./compression.js";
import type {
  AlternatorDynamoDBClientConfig,
  AlternatorTlsMaterial,
  NormalizedAlternatorConfig,
} from "./types.js";

type Handler = HttpHandler<NodeHttpHandlerOptions>;
type GenericHttpHandler = HttpHandler<Record<string, unknown>>;

export function assertRuntimeSupport(config: NormalizedAlternatorConfig): void {
  if (config.runtime !== "edge") {
    return;
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

export function createRequestHandler(
  input: AlternatorDynamoDBClientConfig,
  config: NormalizedAlternatorConfig,
): HttpHandlerUserInput {
  if (input.requestHandler) {
    return withResponseCompression(input.requestHandler, config);
  }

  if (config.runtime === "edge") {
    const fetchOptions = {
      ...(config.connection && "fetch" in config.connection ? config.connection.fetch : undefined),
    };
    if (config.connection?.timeouts?.requestMs !== undefined) {
      fetchOptions.requestTimeout = config.connection.timeouts.requestMs;
    }
    if (config.connection?.keepAlive !== undefined) {
      fetchOptions.keepAlive = config.connection.keepAlive;
    }
    return withResponseCompression(new FetchHttpHandler(fetchOptions), config);
  }

  return withResponseCompression(new LazyNodeHttpHandler(() => buildNodeHandlerOptions(config)), config);
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
      const { NodeHttpHandler } = await import("@smithy/node-http-handler");
      const options = await this.optionsProvider();
      for (const [key, value] of this.pendingUpdates) {
        (options as Record<string, unknown>)[key] = value;
      }
      this.delegate = new NodeHttpHandler(options);
    }
    return this.delegate;
  }
}

class ResponseCompressionHttpHandler implements GenericHttpHandler {
  readonly metadata: RequestHandlerMetadata;

  constructor(
    private readonly delegate: GenericHttpHandler,
    private readonly runtime: NormalizedAlternatorConfig["runtime"],
  ) {
    this.metadata = delegate.metadata ?? { handlerProtocol: "http/1.1" };
  }

  async handle(
    request: HttpRequest,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }> {
    const result = await this.delegate.handle(request, options);
    return {
      response: await decompressResponse(result.response, this.runtime),
    };
  }

  destroy(): void {
    this.delegate.destroy?.();
  }

  updateHttpClientConfig(
    key: keyof Record<string, unknown>,
    value: Record<string, unknown>[typeof key],
  ): void {
    this.delegate.updateHttpClientConfig(key, value);
  }

  httpHandlerConfigs(): Record<string, unknown> {
    return this.delegate.httpHandlerConfigs();
  }
}

function withResponseCompression(
  requestHandler: HttpHandlerUserInput,
  config: NormalizedAlternatorConfig,
): HttpHandlerUserInput {
  if (!config.compression.response.enabled) {
    return requestHandler;
  }
  if (!isHttpHandler(requestHandler)) {
    throw new TypeError("compression.response requires requestHandler to be an HTTP handler instance");
  }
  return new ResponseCompressionHttpHandler(requestHandler, config.runtime);
}

function isHttpHandler(requestHandler: HttpHandlerUserInput): requestHandler is GenericHttpHandler {
  return (
    typeof requestHandler === "object" &&
    requestHandler !== null &&
    "handle" in requestHandler &&
    typeof (requestHandler as { handle?: unknown }).handle === "function" &&
    "updateHttpClientConfig" in requestHandler &&
    typeof (requestHandler as { updateHttpClientConfig?: unknown }).updateHttpClientConfig === "function" &&
    "httpHandlerConfigs" in requestHandler &&
    typeof (requestHandler as { httpHandlerConfigs?: unknown }).httpHandlerConfigs === "function"
  );
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
    const fs = await import("node:fs/promises");
    return fs.readFile(material.file);
  }
  if ("bytes" in material) {
    return material.bytes;
  }
  return material.text;
}
