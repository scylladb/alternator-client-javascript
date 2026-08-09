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
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { compressBody, decompressResponse } from "./compression-node.js";
import { withResponseCompression } from "./runtime-common.js";
import type {
  AlternatorDynamoDBClientConfig,
  AlternatorTlsMaterial,
  NormalizedAlternatorConfig,
} from "./types.js";

const MAX_IN_FLIGHT_DNS_LOOKUPS = 64;
const MAX_NON_PRIORITY_DNS_LOOKUPS = 32;
const MAX_PENDING_DNS_LOOKUPS_PER_HOST = 2;
const MAX_ADDRESS_DELEGATES = 32;

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
    new LazyNodeHttpHandler(
      () => buildNodeHandlerOptions(config),
      config.discovery.timeoutMs,
    ),
    config.compression.response.enabled,
    decompressResponse,
  );
}

class LazyNodeHttpHandler implements Handler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  readonly discoveryAddressFallback: {
    resolve(hostname: string, options?: { timeoutMs?: number; priority?: boolean }): Promise<readonly string[]>;
    handle(
      request: HttpRequest,
      address: string,
      options?: HttpHandlerOptions,
    ): Promise<{ response: HttpResponse }>;
  };
  private delegate?: Handler;
  private delegateCreation: Promise<Handler> | undefined;
  private readonly addressDelegates = new Map<string, Handler>();
  private readonly addressDelegateCreations = new Map<string, Promise<Handler>>();
  private readonly inFlightDnsLookups = new Map<string, Promise<readonly string[]>>();
  private readonly pendingDnsLookups = new Set<Promise<readonly string[]>>();
  private readonly pendingDnsLookupsByHost = new Map<string, number>();
  private pendingUpdates = new Map<keyof NodeHttpHandlerOptions, NodeHttpHandlerOptions[keyof NodeHttpHandlerOptions]>();
  private destroyed = false;

  constructor(
    private readonly optionsProvider: () => Promise<NodeHttpHandlerOptions>,
    private readonly dnsLookupTimeoutMs: number,
  ) {
    this.discoveryAddressFallback = {
      resolve: (hostname, options) => this.resolveDiscoveryHost(
        hostname,
        options?.timeoutMs,
        options?.priority,
      ),
      handle: async (request, address, options) => {
        const delegate = await this.getAddressDelegate(address);
        return delegate.handle(request, options);
      },
    };
  }

  async handle(
    request: HttpRequest,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }> {
    const delegate = await this.getDelegate();
    return delegate.handle(request, options);
  }

  destroy(): void {
    this.destroyed = true;
    this.delegate?.destroy?.();
    for (const delegate of this.addressDelegates.values()) {
      delegate.destroy?.();
    }
    this.addressDelegates.clear();
    this.addressDelegateCreations.clear();
    this.inFlightDnsLookups.clear();
  }

  updateHttpClientConfig<K extends keyof NodeHttpHandlerOptions>(
    key: K,
    value: NodeHttpHandlerOptions[K],
  ): void {
    this.pendingUpdates.set(key, value);
    if (this.delegate && "updateHttpClientConfig" in this.delegate) {
      this.delegate.updateHttpClientConfig?.(key, value);
    }
    if (key === "httpAgent" || key === "httpsAgent") {
      for (const delegate of this.addressDelegates.values()) {
        delegate.destroy?.();
      }
      this.addressDelegates.clear();
      return;
    }
    for (const delegate of this.addressDelegates.values()) {
      delegate.updateHttpClientConfig?.(key, value);
    }
  }

  httpHandlerConfigs(): NodeHttpHandlerOptions {
    if (this.delegate && "httpHandlerConfigs" in this.delegate) {
      return this.delegate.httpHandlerConfigs?.() ?? {};
    }
    return Object.fromEntries(this.pendingUpdates);
  }

  private async getDelegate(): Promise<Handler> {
    if (this.destroyed) {
      throw new Error("HTTP handler has been destroyed");
    }
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.delegateCreation) {
      const creation = this.createDelegate();
      this.delegateCreation = creation;
      void creation.finally(() => {
        if (this.delegateCreation === creation) {
          this.delegateCreation = undefined;
        }
      }).catch(() => undefined);
    }
    return this.delegateCreation;
  }

  private async getAddressDelegate(address: string): Promise<Handler> {
    if (this.destroyed) {
      throw new Error("HTTP handler has been destroyed");
    }
    const existing = this.addressDelegates.get(address);
    if (existing) {
      return existing;
    }
    const pending = this.addressDelegateCreations.get(address);
    if (pending) {
      return pending;
    }
    // Bound handlers retained for keep-alive reuse when DNS answers change repeatedly.
    if (this.addressDelegates.size + this.addressDelegateCreations.size >= MAX_ADDRESS_DELEGATES) {
      const oldest = this.addressDelegates.entries().next().value;
      if (oldest) {
        oldest[1].destroy?.();
        this.addressDelegates.delete(oldest[0]);
      } else {
        throw new Error("too many address-specific HTTP handlers are being created");
      }
    }

    const creation = this.createAddressDelegate(address);
    this.addressDelegateCreations.set(address, creation);
    void creation.finally(() => {
      if (this.addressDelegateCreations.get(address) === creation) {
        this.addressDelegateCreations.delete(address);
      }
    }).catch(() => undefined);
    return creation;
  }

  private async createDelegate(): Promise<Handler> {
    const options = await this.optionsProvider();
    for (const [key, value] of this.pendingUpdates) {
      (options as Record<string, unknown>)[key] = value;
    }
    if (this.destroyed) {
      throw new Error("HTTP handler has been destroyed");
    }
    const delegate = new NodeHttpHandler(options);
    this.delegate = delegate;
    return delegate;
  }

  private async createAddressDelegate(address: string): Promise<Handler> {
    const options = await this.optionsProvider();
    for (const [key, value] of this.pendingUpdates) {
      (options as Record<string, unknown>)[key] = value;
    }
    if (this.destroyed) {
      throw new Error("HTTP handler has been destroyed");
    }
    const lookup = lookupAddress(address);
    const delegate = new NodeHttpHandler({
      ...options,
      httpAgent: agentOptionsWithLookup(options.httpAgent, lookup),
      httpsAgent: agentOptionsWithLookup(options.httpsAgent, lookup),
    });
    this.addressDelegates.set(address, delegate);
    return delegate;
  }

  private resolveDiscoveryHost(
    hostname: string,
    timeoutMs = this.dnsLookupTimeoutMs,
    priority = false,
  ): Promise<readonly string[]> {
    if (this.destroyed) {
      return Promise.reject(new Error("HTTP handler has been destroyed"));
    }
    const literalAddress = asLiteralAddress(hostname);
    if (literalAddress !== undefined) {
      // A literal is already resolved. In particular, do not let abandoned
      // DNS work consume the capacity needed to use a literal recovery seed.
      return Promise.resolve([literalAddress]);
    }
    const key = hostname.toLowerCase();
    const existing = this.inFlightDnsLookups.get(key);
    if (existing) {
      return existing;
    }
    if ((this.pendingDnsLookupsByHost.get(key) ?? 0) >= MAX_PENDING_DNS_LOOKUPS_PER_HOST) {
      return Promise.reject(new Error(`too many DNS lookups for ${hostname} are still pending`));
    }
    if (!priority && this.pendingDnsLookups.size >= MAX_NON_PRIORITY_DNS_LOOKUPS) {
      return Promise.reject(new Error("too many non-seed DNS lookups are still pending"));
    }
    if (this.pendingDnsLookups.size >= MAX_IN_FLIGHT_DNS_LOOKUPS) {
      return Promise.reject(new Error("too many DNS lookups are still pending"));
    }

    const lookup = resolveHostAddresses(hostname);
    this.pendingDnsLookups.add(lookup);
    this.pendingDnsLookupsByHost.set(key, (this.pendingDnsLookupsByHost.get(key) ?? 0) + 1);
    void lookup.finally(() => {
      this.pendingDnsLookups.delete(lookup);
      const pendingForHost = (this.pendingDnsLookupsByHost.get(key) ?? 1) - 1;
      if (pendingForHost === 0) {
        this.pendingDnsLookupsByHost.delete(key);
      } else {
        this.pendingDnsLookupsByHost.set(key, pendingForHost);
      }
    }).catch(() => undefined);

    const pending = withDnsLookupTimeout(lookup, timeoutMs, hostname);
    this.inFlightDnsLookups.set(key, pending);
    void pending.finally(() => {
      if (this.inFlightDnsLookups.get(key) === pending) {
        this.inFlightDnsLookups.delete(key);
      }
    }).catch(() => undefined);
    return pending;
  }
}

async function withDnsLookupTimeout<T>(promise: Promise<T>, timeoutMs: number, hostname: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`DNS lookup for ${hostname} timed out after ${Math.max(1, timeoutMs)}ms`));
    }, Math.max(1, timeoutMs));
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const literalAddress = asLiteralAddress(hostname);
  if (literalAddress !== undefined) {
    return [literalAddress];
  }
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return [...new Set(addresses.map(({ address }) => address))];
}

function asLiteralAddress(hostname: string): string | undefined {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(unbracketed) === 0 ? undefined : unbracketed;
}

function lookupAddress(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function agentOptionsWithLookup(
  options: NodeHttpHandlerOptions["httpAgent"] | NodeHttpHandlerOptions["httpsAgent"],
  lookup: LookupFunction,
): Record<string, unknown> {
  if (typeof options === "object" && options !== null) {
    if (!("addRequest" in options)) {
      return { ...options, lookup };
    }
    const configuredOptions = "options" in options && typeof options.options === "object" && options.options !== null
      ? options.options
      : {};
    return { ...configuredOptions, lookup };
  }
  return { keepAlive: false, lookup };
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
