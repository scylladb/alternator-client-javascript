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

import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { HttpHandler, HttpHandlerUserInput, HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type {
  HttpHandlerOptions,
  NodeHttpHandlerOptions,
} from "@smithy/types";
import { readFile } from "node:fs/promises";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from "node:https";
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
      NodeHttpHandler.create(input.requestHandler as Handler | NodeHttpHandlerOptions),
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
  private delegatePromise: Promise<Handler> | undefined;
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
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.delegatePromise) {
      const initialization = this.createDelegate();
      this.delegatePromise = initialization;
      void initialization.catch(() => {
        if (this.delegatePromise === initialization) {
          this.delegatePromise = undefined;
        }
      });
    }
    return this.delegatePromise;
  }

  private async createDelegate(): Promise<Handler> {
    const options = await this.optionsProvider();
    for (const [key, value] of this.pendingUpdates) {
      (options as Record<string, unknown>)[key] = value;
    }
    const delegate = new NodeHttpHandler(options);
    this.delegate = delegate;
    return delegate;
  }
}

async function buildNodeHandlerOptions(
  config: NormalizedAlternatorConfig,
): Promise<NodeHttpHandlerOptions> {
  const connection = config.connection;
  const tls = config.tls;
  const keepAlive = connection?.keepAlive ?? true;
  const maxSockets = connection && "maxSockets" in connection ? connection.maxSockets ?? 50 : 50;

  const httpAgent = new HttpAgent({ keepAlive, maxSockets });
  const httpsAgentOptions: HttpsAgentOptions = { keepAlive, maxSockets };

  if (tls) {
    if (tls.ca !== undefined) {
      httpsAgentOptions.ca = await tlsMaterialValue(tls.ca);
    }
    if (tls.cert !== undefined) {
      httpsAgentOptions.cert = await tlsMaterialValue(tls.cert);
    }
    if (tls.key !== undefined) {
      httpsAgentOptions.key = await tlsMaterialValue(tls.key);
    }
    if (tls.rejectUnauthorized !== undefined) {
      httpsAgentOptions.rejectUnauthorized = tls.rejectUnauthorized;
    }
    if (tls.sessionCache === false) {
      httpsAgentOptions.maxCachedSessions = 0;
    }
  }
  const httpsAgent = new HttpsAgent(httpsAgentOptions);

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

async function tlsMaterialValue(material: AlternatorTlsMaterial): Promise<string | Buffer> {
  if ("file" in material) {
    return readFile(material.file);
  }
  if ("bytes" in material) {
    return Buffer.from(material.bytes);
  }
  return material.text;
}
