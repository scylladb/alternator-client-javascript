import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type {
  HttpHandlerOptions,
  NodeHttpHandlerOptions,
  RequestHandlerMetadata,
} from "@smithy/types";
import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import { decompressResponse } from "./compression.js";
import type { AlternatorDynamoDBClientConfig, NormalizedAlternatorConfig } from "./types.js";

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
  if (connection?.maxSockets !== undefined) {
    throw new Error("Alternator edge runtime does not support socket pool tuning");
  }
  if (connection?.socketTimeoutMs !== undefined || connection?.connectionTimeoutMs !== undefined) {
    throw new Error("Alternator edge runtime does not support Node socket timeout options");
  }
  if (connection?.node !== undefined) {
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
      ...config.connection?.fetch,
    };
    if (config.connection?.requestTimeoutMs !== undefined) {
      fetchOptions.requestTimeout = config.connection.requestTimeoutMs;
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
  const maxSockets = connection?.maxSockets ?? 50;

  const httpAgent: Record<string, unknown> = { keepAlive, maxSockets };
  const httpsAgent: Record<string, unknown> = { keepAlive, maxSockets };

  if (tls) {
    if (tls.ca !== undefined) {
      httpsAgent.ca = tls.ca;
    }
    if (tls.cert !== undefined) {
      httpsAgent.cert = tls.cert;
    }
    if (tls.key !== undefined) {
      httpsAgent.key = tls.key;
    }
    if (tls.rejectUnauthorized !== undefined) {
      httpsAgent.rejectUnauthorized = tls.rejectUnauthorized;
    }
    if (tls.sessionCache === false) {
      httpsAgent.maxCachedSessions = 0;
    }

    if (tls.caFile || tls.certFile || tls.keyFile) {
      const fs = await import("node:fs/promises");
      if (tls.caFile) {
        httpsAgent.ca = await fs.readFile(tls.caFile);
      }
      if (tls.certFile) {
        httpsAgent.cert = await fs.readFile(tls.certFile);
      }
      if (tls.keyFile) {
        httpsAgent.key = await fs.readFile(tls.keyFile);
      }
    }
  }

  const options: NodeHttpHandlerOptions = {
    httpAgent,
    httpsAgent,
    ...connection?.node,
  };

  if (connection?.requestTimeoutMs !== undefined) {
    options.requestTimeout = connection.requestTimeoutMs;
  }
  if (connection?.connectionTimeoutMs !== undefined) {
    options.connectionTimeout = connection.connectionTimeoutMs;
  }
  if (connection?.socketTimeoutMs !== undefined) {
    options.socketTimeout = connection.socketTimeoutMs;
  }
  if (connection?.throwOnRequestTimeout !== undefined) {
    options.throwOnRequestTimeout = connection.throwOnRequestTimeout;
  }

  return options;
}
