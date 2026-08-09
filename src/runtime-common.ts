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

import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type {
  HttpHandlerOptions,
  RequestHandlerMetadata,
} from "@smithy/types";

type GenericHttpHandler = HttpHandler<Record<string, unknown>>;
export type ResponseDecompressor = (response: HttpResponse) => Promise<HttpResponse>;
interface DiscoveryAddressFallback {
  resolve(hostname: string): Promise<readonly string[]>;
  handle(
    request: HttpRequest,
    address: string,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }>;
}

class ResponseCompressionHttpHandler implements GenericHttpHandler {
  readonly metadata: RequestHandlerMetadata;
  readonly discoveryAddressFallback: DiscoveryAddressFallback | undefined;

  constructor(
    private readonly delegate: GenericHttpHandler,
    private readonly decompressResponse: ResponseDecompressor,
  ) {
    this.metadata = delegate.metadata ?? { handlerProtocol: "http/1.1" };
    const addressFallback = (delegate as GenericHttpHandler & {
      discoveryAddressFallback?: DiscoveryAddressFallback;
    }).discoveryAddressFallback;
    this.discoveryAddressFallback = addressFallback
      ? {
          resolve: (hostname) => addressFallback.resolve(hostname),
          handle: async (request, address, options) => {
            const result = await addressFallback.handle(request, address, options);
            return { response: await this.decompressResponse(result.response) };
          },
        }
      : undefined;
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
