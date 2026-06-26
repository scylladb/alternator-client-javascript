import { HttpRequest } from "@smithy/protocol-http";
import type { FinalizeRequestMiddleware, HandlerExecutionContext } from "@smithy/types";
import { compressBody } from "./compression.js";
import { hostForUrl } from "./config.js";
import type { AlternatorDiscovery } from "./discovery.js";
import type { KeyRouteAffinityPlanner } from "./affinity.js";
import type { AlternatorQueryPlan } from "./query-plan.js";
import type { AlternatorNode, NormalizedAlternatorConfig } from "./types.js";
import { applyUserAgent } from "./user-agent.js";

const queryPlanKey = "__alternatorQueryPlan";

export interface AlternatorMiddlewareOptions {
  discovery: AlternatorDiscovery;
  config: NormalizedAlternatorConfig;
  keyAffinity: KeyRouteAffinityPlanner;
}

export function createAlternatorRequestMiddleware<Input extends object, Output extends object>({
  discovery,
  config,
  keyAffinity,
}: AlternatorMiddlewareOptions): FinalizeRequestMiddleware<Input, Output> {
  return (next, context) => async (args) => {
    if (!HttpRequest.isInstance(args.request)) {
      return next(args);
    }

    await discovery.refreshIfDue();

    const node = nextNodeForAttempt(context, args.input, discovery, keyAffinity);
    if (!node) {
      throw new Error("Alternator query plan exhausted");
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

    if (config.compression.enabled) {
      request = await maybeCompressRequest(request, config);
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

    request.headers = applyUserAgent(request.headers, config.userAgent);

    return next({
      ...args,
      request,
    });
  };
}

function nextNodeForAttempt<Input extends object>(
  context: HandlerExecutionContext,
  input: Input,
  discovery: AlternatorDiscovery,
  keyAffinity: KeyRouteAffinityPlanner,
): AlternatorNode | undefined {
  const contextRecord = context as HandlerExecutionContext & {
    [queryPlanKey]?: AlternatorQueryPlan;
  };

  if (!contextRecord[queryPlanKey]) {
    contextRecord[queryPlanKey] = createQueryPlan(context, input, discovery, keyAffinity);
  }

  const node = contextRecord[queryPlanKey].next();
  if (node) {
    return node;
  }

  contextRecord[queryPlanKey] = createQueryPlan(context, input, discovery, keyAffinity);
  return contextRecord[queryPlanKey].next();
}

function createQueryPlan<Input extends object>(
  context: HandlerExecutionContext,
  input: Input,
  discovery: AlternatorDiscovery,
  keyAffinity: KeyRouteAffinityPlanner,
): AlternatorQueryPlan {
  const nodes = discovery.getLiveNodes();
  return keyAffinity.queryPlanForInput(input, nodes, context.commandName) ?? discovery.createQueryPlan();
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
): Promise<HttpRequest> {
  if (request.headers["content-encoding"] || request.headers["Content-Encoding"]) {
    return request;
  }

  const size = bodySize(request.body);
  if (size === undefined || size < config.compression.thresholdBytes) {
    return request;
  }

  const compressedBody = await compressBody(request.body, config.runtime, config.compression);
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
