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

import { HttpRequest } from "@smithy/protocol-http";
import type { FinalizeRequestMiddleware, HandlerExecutionContext } from "@smithy/types";
import { applyResponseEncodingHeaders } from "./compression-shared.js";
import { hostForUrl } from "./config.js";
import type { AlternatorDiscovery } from "./discovery.js";
import type { KeyRouteAffinityPlanner } from "./affinity.js";
import { AlternatorQueryPlan } from "./query-plan.js";
import type { AlternatorNode, NormalizedAlternatorConfig } from "./types.js";
import { applyUserAgent } from "./user-agent.js";
import type { AlternatorBodyCompressor } from "./compression-types.js";

const queryPlanKey = "__alternatorQueryPlan";
const recoveryRefreshKey = "__alternatorRecoveryRefresh";
const attemptedNodeUrlsKey = "__alternatorAttemptedNodeUrls";

export interface AlternatorMiddlewareOptions {
  discovery: AlternatorDiscovery;
  config: NormalizedAlternatorConfig;
  keyAffinity: KeyRouteAffinityPlanner;
  compressBody: AlternatorBodyCompressor;
}

export function createAlternatorRequestMiddleware<Input extends object, Output extends object>({
  discovery,
  config,
  keyAffinity,
  compressBody,
}: AlternatorMiddlewareOptions): FinalizeRequestMiddleware<Input, Output> {
  return (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
      return next(args);
    }

    if (discovery.getLiveNodes().length === 0) {
      await discovery.refreshLiveNodes();
    } else {
      await discovery.refreshIfDue();
    }

    const node = await nextNodeForAttempt(context, args.input, discovery, keyAffinity);
    if (!node) {
      throw new Error("Alternator discovery produced no routable nodes for the configured scope");
    }

    let request = HttpRequest.clone(args.request);
    request.protocol = `${node.scheme}:`;
    request.hostname = hostForUrl(node.host);
    request.port = node.port;
    request.headers = {
      ...request.headers,
      host: hostHeader(node.host, node.port),
    };

    if (config.runtime === "node" && config.connection?.keepAlive !== false) {
      request.headers.connection = "keep-alive";
    }

    if (config.compression.request.enabled) {
      request = await maybeCompressRequest(request, config, compressBody);
    }

    if (config.headerOptimization.enabled) {
      request.headers = whitelistHeaders(request.headers, config.headerOptimization.allowedHeaders);
    }

    return next({
      ...args,
      request,
    });
  };
}

export function createAlternatorPostSigningMiddleware<Input extends object, Output extends object>(
  config: NormalizedAlternatorConfig,
): FinalizeRequestMiddleware<Input, Output> {
  return (next) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
      return next(args);
    }

    const request = HttpRequest.clone(args.request);

    if (config.compression.response.enabled) {
      request.headers = applyResponseEncodingHeaders(
        request.headers,
        config.compression.response.algorithms,
      );
    }

    if (config.headerOptimization.enabled) {
      request.headers = whitelistHeaders(request.headers, config.headerOptimization.allowedHeaders);
    } else if (config.noAuth) {
      request.headers = removeHeaders(request.headers, [
        "authorization",
        "x-amz-content-sha256",
        "x-amz-date",
        "x-amz-security-token",
      ]);
    }

    request.headers = applyUserAgent(request.headers, config.userAgent, {
      removeAwsSdkUserAgent: config.noAuth,
    });

    return next({
      ...args,
      request,
    });
  };
}

async function nextNodeForAttempt<Input extends object>(
  context: HandlerExecutionContext,
  input: Input,
  discovery: AlternatorDiscovery,
  keyAffinity: KeyRouteAffinityPlanner,
): Promise<AlternatorNode | undefined> {
  const contextRecord = context as HandlerExecutionContext & {
    [queryPlanKey]?: AlternatorQueryPlan;
    [recoveryRefreshKey]?: boolean;
    [attemptedNodeUrlsKey]?: Set<string>;
  };
  const attemptedNodeUrls = contextRecord[attemptedNodeUrlsKey] ??= new Set<string>();

  if (!contextRecord[queryPlanKey]) {
    contextRecord[queryPlanKey] = createQueryPlan(
      context,
      input,
      discovery,
      keyAffinity,
      attemptedNodeUrls,
    );
    return nextUnrecordedNode(contextRecord[queryPlanKey], attemptedNodeUrls);
  }

  const node = contextRecord[queryPlanKey].next();
  if (node) {
    attemptedNodeUrls.add(node.url);
    return node;
  }

  if (!contextRecord[recoveryRefreshKey]) {
    contextRecord[recoveryRefreshKey] = true;
    await discovery.refreshLiveNodes();
  }
  contextRecord[queryPlanKey] = createQueryPlan(
    context,
    input,
    discovery,
    keyAffinity,
    attemptedNodeUrls,
  );
  return nextUnrecordedNode(contextRecord[queryPlanKey], attemptedNodeUrls);
}

function createQueryPlan<Input extends object>(
  context: HandlerExecutionContext,
  input: Input,
  discovery: AlternatorDiscovery,
  keyAffinity: KeyRouteAffinityPlanner,
  attemptedNodeUrls: ReadonlySet<string>,
): AlternatorQueryPlan {
  const allNodes = discovery.getLiveNodes();
  const untriedNodes = allNodes.filter((node) => !attemptedNodeUrls.has(node.url));
  // Once every currently published node has been attempted, preserve the SDK's
  // configured retry count by starting another pass. A refresh that introduced
  // a genuinely new node must try it before revisiting a failed LKG endpoint.
  const nodes = untriedNodes.length > 0 ? untriedNodes : allNodes;
  return keyAffinity.queryPlanForInput(input, nodes, context.commandName) ?? new AlternatorQueryPlan(nodes);
}

function nextUnrecordedNode(
  queryPlan: AlternatorQueryPlan,
  attemptedNodeUrls: Set<string>,
): AlternatorNode | undefined {
  const node = queryPlan.next();
  if (node) {
    attemptedNodeUrls.add(node.url);
  }
  return node;
}

function whitelistHeaders(
  headers: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> {
  const allowed = new Set(names.map((name) => name.toLowerCase()));
  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || !allowed.has(name.toLowerCase())) {
      continue;
    }
    nextHeaders[name] = value;
  }

  return nextHeaders;
}

function removeHeaders(
  headers: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> {
  const removed = new Set(names.map((name) => name.toLowerCase()));
  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || removed.has(name.toLowerCase())) {
      continue;
    }
    nextHeaders[name] = value;
  }

  return nextHeaders;
}

async function maybeCompressRequest(
  request: HttpRequest,
  config: NormalizedAlternatorConfig,
  compressBody: AlternatorBodyCompressor,
): Promise<HttpRequest> {
  if (request.headers["content-encoding"] || request.headers["Content-Encoding"]) {
    return request;
  }

  const size = bodySize(request.body);
  if (size === undefined || size < config.compression.request.thresholdBytes) {
    return request;
  }

  const compressedBody = await compressBody(request.body, config.compression.request);
  if (!compressedBody) {
    return request;
  }

  const compressed = HttpRequest.clone(request);
  compressed.body = compressedBody.body;
  compressed.headers = {
    ...request.headers,
    "content-length": String(compressedBody.contentLength),
  };
  if (compressedBody.contentEncoding) {
    compressed.headers["content-encoding"] = compressedBody.contentEncoding;
  } else {
    delete compressed.headers["content-encoding"];
    delete compressed.headers["Content-Encoding"];
  }
  return compressed;
}

function bodySize(body: unknown): number | undefined {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  return undefined;
}

function hostHeader(host: string, port: number): string {
  return `${hostForUrl(host)}:${port}`;
}
