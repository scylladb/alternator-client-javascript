import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type {
  HttpHandlerOptions,
  RequestHandlerMetadata,
} from "@smithy/types";

type GenericHttpHandler = HttpHandler<Record<string, unknown>>;
export type ResponseDecompressor = (response: HttpResponse) => Promise<HttpResponse>;

class ResponseCompressionHttpHandler implements GenericHttpHandler {
  readonly metadata: RequestHandlerMetadata;

  constructor(
    private readonly delegate: GenericHttpHandler,
    private readonly decompressResponse: ResponseDecompressor,
  ) {
    this.metadata = delegate.metadata ?? { handlerProtocol: "http/1.1" };
  }

  async handle(
    request: HttpRequest,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }> {
    const result = await this.delegate.handle(request, options);
    return {
      response: await this.decompressResponse(result.response),
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

export function withResponseCompression(
  requestHandler: HttpHandlerUserInput,
  enabled: boolean,
  decompressResponse: ResponseDecompressor,
): HttpHandlerUserInput {
  if (!enabled) {
    return requestHandler;
  }
  if (!isHttpHandler(requestHandler)) {
    throw new TypeError("compression.response requires requestHandler to be an HTTP handler instance");
  }
  return new ResponseCompressionHttpHandler(requestHandler, decompressResponse);
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
