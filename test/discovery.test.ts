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

import { describe, expect, it, vi } from "vitest";
import { AlternatorDynamoDBClient, routing } from "../src/index.js";
import { AlternatorDynamoDBClient as EdgeAlternatorDynamoDBClient } from "../src/edge.js";
import { bodyToString } from "../src/body.js";
import { bodyToReadableStream } from "../src/compression-shared.js";
import { RecordingHandler } from "./helpers.js";
import { jsonResponse } from "./helpers.js";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpResponse } from "@smithy/protocol-http";
import type { HttpRequest } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import dns, { type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Agent, createServer, type Server } from "node:http";
import { Agent as HttpsAgent, createServer as createHttpsServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createSecureContext, type TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";

vi.mock("node:dns/promises", async (importOriginal) => {
  const original = await importOriginal<{ lookup: typeof dnsLookup }>();
  return { ...original, lookup: vi.fn(original.lookup) };
});

const missingDatacenterQuery = { dc: "__alternator_client_missing_dc__" };
const missingRackQuery = { rack: "__alternator_client_missing_rack__" };

describe("Alternator discovery", () => {
  it("rejects opaque transform-only bodies before an unbounded allocation", async () => {
    let transformed = false;
    const body = {
      transformToString: () => {
        transformed = true;
        return Promise.resolve("[]");
      },
    };

    await expect(bodyToString(body, 1024)).rejects.toThrow(/finite byte limit/);
    expect(transformed).toBe(false);
  });

  it("streams bounded Smithy-style bodies instead of using their opaque transform", async () => {
    let transformed = false;
    const body = {
      transformToString: () => {
        transformed = true;
        return Promise.resolve("unexpected");
      },
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield "[";
        yield "]";
      },
    };

    await expect(bodyToString(body, 1024)).resolves.toBe("[]");
    expect(transformed).toBe(false);
  });

  it("does not await a stalled Web stream cancellation", async () => {
    let bodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const controller = new AbortController();
    const result = bodyToString(stalledBody, 1024, controller.signal);

    await Promise.resolve();
    controller.abort(new Error("cancelled"));

    await expect(result).rejects.toThrow("cancelled");
    expect(bodyCancelled).toBe(true);
  });

  it("closes a compressed async iterator when Web stream chunk conversion fails", async () => {
    let finalizations = 0;
    async function* compressedChunks(): AsyncGenerator<unknown> {
      try {
        await Promise.resolve();
        yield {};
      } finally {
        finalizations += 1;
      }
    }
    const body = await bodyToReadableStream(compressedChunks());
    const reader = body.getReader();

    await expect(reader.read()).rejects.toThrow("compressed response body chunk is not readable");
    await vi.waitFor(() => expect(finalizations).toBe(1));
    reader.releaseLock();
  });

  it("refreshes live nodes from /localnodes", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a.internal", "node-b.internal"];
      }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      discovery: { background: false },
    });

    await expect(client.alternator.refreshNodes()).resolves.toEqual([
      {
        host: "node-a.internal",
        scheme: "http",
        port: 8080,
        url: "http://node-a.internal:8080",
      },
      {
        host: "node-b.internal",
        scheme: "http",
        port: 8080,
        url: "http://node-b.internal:8080",
      },
    ]);
    expect(client.alternator.nodes().map((node) => node.host)).toEqual([
      "node-a.internal",
      "node-b.internal",
    ]);
  });

  it("keeps strict-scope seeds discovery-only and discovers before the first command", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") {
        return { TableNames: [] };
      }
      if (request.query.dc === missingDatacenterQuery.dc) {
        return [];
      }
      return request.query.dc === "dc1" ? ["dc-node.internal"] : [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      routing: routing.datacenter({ datacenter: "dc1" }),
      discovery: { background: false },
    });

    try {
      expect(client.alternator.nodes()).toEqual([]);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({ TableNames: [] });
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["dc-node.internal"]);
      expect(handler.requests.filter(({ path }) => path !== "/localnodes").at(-1)?.hostname)
        .toBe("dc-node.internal");
    } finally {
      client.destroy();
    }
  });

  it("authorizes initial seeds when an explicit cluster scope appears in the fallback chain", () => {
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: new RecordingHandler(),
      routing: routing.datacenter({
        datacenter: "dc1",
        fallback: routing.cluster(),
      }),
      discovery: { background: false },
    });

    try {
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["seed.internal"]);
    } finally {
      client.destroy();
    }
  });

  it("clears a stale strict-scope snapshot only after every scope is authoritatively empty", async () => {
    let empty = false;
    const handler = new RecordingHandler((request) => {
      if (request.query.dc === missingDatacenterQuery.dc) {
        return [];
      }
      if (request.query.dc === "dc1") {
        return empty ? [] : ["dc-node.internal"];
      }
      return [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      routing: routing.datacenter({ datacenter: "dc1" }),
      discovery: { background: false },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["dc-node.internal"]);
      empty = true;
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes()).toEqual([]);
    } finally {
      client.destroy();
    }
  });

  it("clears a primary-origin strict snapshot even when its fallback is unavailable", async () => {
    let recovering = false;
    const handler = new RecordingHandler((request) => {
      if (request.query.dc === missingDatacenterQuery.dc || request.query.rack === missingRackQuery.rack) {
        return [];
      }
      if (request.query.rack === "rack1") {
        return recovering ? [] : ["rack-node.internal"];
      }
      if (request.query.dc === "dc1") {
        if (recovering) {
          throw new Error("datacenter discovery unavailable");
        }
        return ["dc-node.internal"];
      }
      return [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({ datacenter: "dc1" }),
      }),
      discovery: { background: false },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["rack-node.internal"]);
      recovering = true;
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes()).toEqual([]);
    } finally {
      client.destroy();
    }
  });

  it("retains a fallback-origin strict snapshot when only the primary scope is empty", async () => {
    let recovering = false;
    const handler = new RecordingHandler((request) => {
      if (request.query.dc === missingDatacenterQuery.dc || request.query.rack === missingRackQuery.rack) {
        return [];
      }
      if (request.query.rack === "rack1") {
        return [];
      }
      if (request.query.dc === "dc1") {
        if (recovering) {
          throw new Error("datacenter discovery unavailable");
        }
        return ["dc-node.internal"];
      }
      return [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({ datacenter: "dc1" }),
      }),
      discovery: { background: false },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["dc-node.internal"]);
      recovering = true;
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["dc-node.internal"]);
    } finally {
      client.destroy();
    }
  });

  it("unions cluster discovery across configured seeds", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") {
        return {};
      }
      if (request.hostname === "seed-dc1.internal") {
        return ["dc1-a.internal", "dc1-b.internal"];
      }
      if (request.hostname === "seed-dc2.internal") {
        return ["dc2-a.internal", "dc2-b.internal"];
      }
      return [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-dc1.internal", "seed-dc2.internal"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.cluster(),
    });

    await client.alternator.refreshNodes();

    expect(client.alternator.nodes().map((node) => node.host)).toEqual([
      "dc1-a.internal",
      "dc1-b.internal",
      "dc2-a.internal",
      "dc2-b.internal",
    ]);
    await client.alternator.refreshNodes();

    expect(handler.requests.map((request) => request.hostname)).toEqual([
      "seed-dc1.internal",
      "seed-dc2.internal",
      "dc1-a.internal",
      "dc1-b.internal",
      "dc2-a.internal",
      "dc2-b.internal",
      "seed-dc1.internal",
      "seed-dc2.internal",
    ]);
    expect(handler.requests.map((request) => request.query)).toEqual([{}, {}, {}, {}, {}, {}, {}, {}]);
  });

  it("merges an incomplete multi-datacenter cluster pass with the last-known-good snapshot", async () => {
    let phase: "initial" | "partial" | "complete" = "initial";
    const handler = new RecordingHandler((request) => {
      if (phase === "initial") {
        if (request.hostname === "seed-dc1.internal") {
          return ["dc1-old.internal"];
        }
        if (request.hostname === "seed-dc2.internal") {
          return ["dc2-old.internal"];
        }
      }
      if (phase === "partial") {
        if (request.hostname === "dc1-old.internal" || request.hostname === "seed-dc1.internal") {
          return ["dc1-fresh.internal"];
        }
        throw new Error("dc2 discovery unavailable");
      }
      return ["authoritative.internal"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-dc1.internal", "seed-dc2.internal"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.cluster(),
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
        "dc1-old.internal",
        "dc2-old.internal",
      ]);

      phase = "partial";
      const partialStart = handler.requests.length;
      await client.alternator.refreshNodes();
      expect(handler.requests.slice(partialStart).map(({ hostname }) => hostname)).toEqual([
        "dc1-old.internal",
        "dc2-old.internal",
        "seed-dc1.internal",
        "seed-dc2.internal",
      ]);
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
        "dc1-fresh.internal",
        "dc1-old.internal",
        "dc2-old.internal",
      ]);

      phase = "complete";
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["authoritative.internal"]);
    } finally {
      client.destroy();
    }
  });

  it("treats a mixed fresh-and-empty cluster pass as incomplete", async () => {
    let initial = true;
    const handler = new RecordingHandler((request) => {
      if (initial) {
        return request.hostname === "seed-a.internal"
          ? ["dc-a-old.internal"]
          : ["dc-b-old.internal"];
      }
      return request.hostname === "dc-a-old.internal"
        ? ["dc-a-fresh.internal"]
        : [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-a.internal", "seed-b.internal"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.cluster(),
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
        "dc-a-old.internal",
        "dc-b-old.internal",
      ]);

      initial = false;
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
        "dc-a-fresh.internal",
        "dc-a-old.internal",
        "dc-b-old.internal",
      ]);
    } finally {
      client.destroy();
    }
  });

  it("refreshes cluster discovery through learned nodes before falling back to seeds", async () => {
    let recovering = false;
    const handler = new RecordingHandler((request) => {
      if (request.hostname === "seed.internal") {
        if (recovering) {
          throw new Error("seed unavailable");
        }
        return ["learned.internal"];
      }
      if (request.hostname === "learned.internal" && recovering) {
        return ["recovered.internal"];
      }
      return [];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      await client.alternator.refreshNodes();
      recovering = true;
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
        "recovered.internal",
        "learned.internal",
      ]);
      expect(handler.requests.map(({ hostname }) => hostname)).toEqual([
        "seed.internal",
        "learned.internal",
        "seed.internal",
      ]);
    } finally {
      client.destroy();
    }
  });

  it("retains the previous cluster snapshot when the seed union is oversized", async () => {
    const hosts = (prefix: string) => Array.from(
      { length: 6_000 },
      (_value, index) => `${prefix}-${index}-${"a".repeat(90)}.internal`,
    );
    const handler = new RecordingHandler((request) => request.hostname === "seed-a"
      ? hosts("node-a")
      : hosts("node-b"));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-a", "seed-b"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 10_000 },
    });

    try {
      await client.alternator.refreshNodes();
      const nodes = client.alternator.nodes();
      expect(nodes).toHaveLength(2);
      expect(nodes.map(({ host }) => host)).toEqual(["seed-a", "seed-b"]);
    } finally {
      client.destroy();
    }
  });

  it("retains the previous cluster snapshot when a response has too many nodes", async () => {
    const hosts = Array.from({ length: 16_385 }, (_value, index) => `node-${index}.internal`);
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: new RecordingHandler(() => hosts),
      discovery: { background: false, timeoutMs: 10_000 },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["seed.internal"]);
    } finally {
      client.destroy();
    }
  });

  it("keeps fresh partial-cluster nodes while truncating LKG at the node cap", async () => {
    const oldNodes = Array.from({ length: 16_384 }, (_value, index) => `old-${index}.internal`);
    let initial = true;
    const handler = new RecordingHandler((request, options) => {
      if (initial) {
        return oldNodes;
      }
      if (request.hostname === oldNodes[0]) {
        return ["fresh.internal"];
      }
      if (request.hostname === "seed.internal") {
        throw new Error("seed unavailable");
      }
      return new Promise<never>((_resolve, reject) => {
        if (options?.abortSignal) {
          options.abortSignal.onabort = () => reject(new Error("request aborted"));
        }
      });
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.internal"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 80 },
      routing: routing.cluster(),
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes()).toHaveLength(16_384);

      initial = false;
      await client.alternator.refreshNodes();
      const nodes = client.alternator.nodes().map(({ host }) => host);
      expect(nodes).toHaveLength(16_384);
      expect(nodes[0]).toBe("fresh.internal");
      expect(nodes.at(-1)).toBe("old-16382.internal");
      expect(nodes).not.toContain("old-16383.internal");
    } finally {
      client.destroy();
    }
  });

  it("tries rack/datacenter routing fallback in order", async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const handler = new RecordingHandler((request) => {
      seenQueries.push(request.query);
      if (request.query.dc === missingDatacenterQuery.dc || request.query.rack === missingRackQuery.rack) {
        return [];
      }
      if (request.query.rack) {
        return [];
      }
      if (request.query.dc) {
        return ["dc-node"];
      }
      return ["cluster-node"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({
          datacenter: "dc1",
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.alternator.refreshNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      missingRackQuery,
      { dc: "dc1", rack: "rack1" },
      { dc: "dc1" },
    ]);
    expect(client.alternator.nodes().map((node) => node.host)).toEqual(["dc-node"]);
  });

  it("detects rack/datacenter query support", async () => {
    const supported = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler((request) => (request.query.dc || request.query.rack ? [] : ["seed"])),
      discovery: { background: false },
    });
    await expect(supported.alternator.supportsScopedDiscovery()).resolves.toBe(true);

    const unsupported = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => ["seed"]),
      discovery: { background: false },
    });
    await expect(unsupported.alternator.supportsScopedDiscovery()).resolves.toBe(false);
  });

  it("falls back instead of accepting scoped nodes when rack/datacenter filters are unsupported", async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const handler = new RecordingHandler((request) => {
      seenQueries.push(request.query);
      if (request.query.dc || request.query.rack) {
        return ["wrong-scope-node"];
      }
      return ["cluster-node"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({
          datacenter: "dc1",
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.alternator.refreshNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      {},
    ]);
    expect(client.alternator.nodes().map((node) => node.host)).toEqual(["cluster-node"]);
  });

  it("falls back from rack scope to datacenter scope when only rack filters are unsupported", async () => {
    const seenQueries: Array<Record<string, unknown>> = [];
    const handler = new RecordingHandler((request) => {
      seenQueries.push(request.query);
      if (request.query.dc === missingDatacenterQuery.dc) {
        return [];
      }
      if (request.query.rack === missingRackQuery.rack) {
        return ["dc-node"];
      }
      if (request.query.rack) {
        return ["wrong-rack-node"];
      }
      if (request.query.dc === "dc1") {
        return ["dc-node"];
      }
      return ["cluster-node"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({
          datacenter: "dc1",
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.alternator.refreshNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      missingRackQuery,
      { dc: "dc1" },
    ]);
    expect(client.alternator.nodes().map((node) => node.host)).toEqual(["dc-node"]);
  });

  it("validates configured rack/datacenter scopes", async () => {
    const valid = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler((request) => {
        if (request.query.dc === "dc1") {
          return ["dc-node"];
        }
        return [];
      }),
      discovery: { background: false },
      routing: routing.datacenter({ datacenter: "dc1" }),
    });
    await expect(valid.alternator.validateRouting()).resolves.toBeUndefined();

    const invalid = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => []),
      discovery: { background: false },
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.datacenter({ datacenter: "dc1" }),
      }),
    });
    await expect(invalid.alternator.validateRouting()).rejects.toThrow(/has no nodes/);
  });

  it("rejects rack/datacenter validation when scope filters are unsupported", async () => {
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => ["seed"]),
      discovery: { background: false },
      routing: routing.datacenter({
        datacenter: "dc1",
        fallback: routing.cluster(),
      }),
    });

    await expect(client.alternator.validateRouting()).rejects.toThrow(/does not support datacenter/);
  });

  it("uses request-triggered discovery in edge runtime", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["edge-node"];
      }
      return { TableNames: [] };
    });
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["seed"],
      runtime: "edge",
      requestHandler: handler,
      discovery: {
        background: false,
        requestRefreshIntervalMs: 1,
      },
    });

    await client.send(new ListTablesCommand({}));

    expect(handler.requests[0]?.path).toBe("/localnodes");
    expect(handler.requests[1]?.hostname).toBe("edge-node");
    expect(handler.requests[1]?.headers.connection).toBeUndefined();
  });

  it("does not follow cross-authority redirects during edge discovery", async () => {
    let redirectedRequests = 0;
    const redirectTarget = createServer((_request, response) => {
      redirectedRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(["redirected-node"]));
    });
    const targetAddress = await listen(redirectTarget);
    const entrypoint = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `http://${targetAddress.address}:${targetAddress.port}/localnodes`);
      response.end();
    });
    const entrypointAddress = await listen(entrypoint);
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: [entrypointAddress.address],
      port: entrypointAddress.port,
      runtime: "edge",
      discovery: { background: false, timeoutMs: 500 },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual([entrypointAddress.address]);
      expect(redirectedRequests).toBe(0);
    } finally {
      client.destroy();
      entrypoint.closeAllConnections?.();
      redirectTarget.closeAllConnections?.();
      await Promise.all([close(entrypoint), close(redirectTarget)]);
    }
  });

  it("keeps the discovery abort signal when edge requestInit supplies another signal", async () => {
    const configuredController = new AbortController();
    let transportAborted = false;
    vi.stubGlobal("fetch", vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        transportAborted = true;
        reject(new Error("fetch aborted"));
      }, { once: true });
    })));
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      runtime: "edge",
      discovery: { background: false, timeoutMs: 20 },
      connection: {
        fetch: {
          requestInit: () => ({ signal: configuredController.signal }),
        },
      },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "entrypoint.test", scheme: "http", port: 8080, url: "http://entrypoint.test:8080" },
      ]);
      expect(transportAborted).toBe(true);
    } finally {
      configuredController.abort();
      client.destroy();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the discovery socket reusable after non-2xx responses", async () => {
    let requests = 0;
    let connections = 0;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      requests += 1;
      response.setHeader("content-type", "application/json");
      if (requests === 1) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "temporary failure" }));
        return;
      }
      response.end(JSON.stringify(["node-a.internal"]));
    });
    server.on("connection", () => {
      connections += 1;
    });
    const address = await listen(server);
    const client = new AlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      discovery: {
        background: false,
        timeoutMs: 500,
      },
      connection: {
        keepAlive: true,
        maxSockets: 1,
      },
    });

    try {
      await client.alternator.refreshNodes();
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "node-a.internal",
          scheme: "http",
          port: address.port,
          url: `http://node-a.internal:${address.port}`,
        },
      ]);
      expect(connections).toBe(1);
    } finally {
      client.destroy();
      await close(server);
    }
  });

  it("resolves DNS entrypoint and keeps DNS node records", async () => {
    let hostHeader = "";
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      hostHeader = request.headers.host ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(["localhost", "node-a.internal"]));
    });
    const address = await listen(server, "localhost");
    const client = new AlternatorDynamoDBClient({
      seeds: ["localhost"],
      port: address.port,
      discovery: {
        background: false,
        timeoutMs: 500,
      },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "localhost",
          scheme: "http",
          port: address.port,
          url: `http://localhost:${address.port}`,
        },
        {
          host: "node-a.internal",
          scheme: "http",
          port: address.port,
          url: `http://node-a.internal:${address.port}`,
        },
      ]);
      expect(hostHeader).toBe(`localhost:${address.port}`);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("discovers and routes through an IPv6 literal entrypoint", async () => {
    const hostHeaders: string[] = [];
    const server = createServer((request, response) => {
      hostHeaders.push(request.headers.host ?? "");
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.end(JSON.stringify(request.url === "/localnodes" ? ["::1"] : { TableNames: [] }));
    });
    const address = await listen(server, "::1");
    const client = new AlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      discovery: { background: false, timeoutMs: 500 },
      maxAttempts: 1,
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "::1",
          scheme: "http",
          port: address.port,
          url: `http://[::1]:${address.port}`,
        },
      ]);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
      expect(hostHeaders).toEqual([
        `[::1]:${address.port}`,
        `[::1]:${address.port}`,
      ]);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it.each([
    {
      name: "an A-only",
      listenHost: "127.0.0.1",
      addresses: [
        { address: "127.0.0.1", family: 4 },
      ],
    },
    {
      name: "an AAAA-only",
      listenHost: "::1",
      addresses: [
        { address: "::1", family: 6 },
      ],
    },
    {
      name: "AAAA to A",
      listenHost: "127.0.0.1",
      addresses: [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ],
    },
    {
      name: "A to AAAA",
      listenHost: "::1",
      addresses: [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ],
    },
  ])("falls back from $name DNS records for discovery and routing", async ({ listenHost, addresses }) => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.end(JSON.stringify(request.url === "/localnodes" ? ["dual.test"] : { TableNames: [] }));
    });
    const address = await listen(server, listenHost);
    const requestHandler = dualStackHandler(addresses);
    const client = new AlternatorDynamoDBClient({
      seeds: ["dual.test"],
      port: address.port,
      requestHandler,
      discovery: { background: false, timeoutMs: 500 },
      maxAttempts: 1,
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "dual.test",
          scheme: "http",
          port: address.port,
          url: `http://dual.test:${address.port}`,
        },
      ]);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
      expect(requests).toBe(2);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("returns promptly and keeps its seed when all DNS records are unavailable", async () => {
    const server = createServer();
    const address = await listen(server);
    await close(server);
    const client = new AlternatorDynamoDBClient({
      seeds: ["dual.test"],
      port: address.port,
      requestHandler: dualStackHandler([
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 },
      ]),
      discovery: { background: false, timeoutMs: 100 },
      maxAttempts: 1,
    });

    try {
      const startedAt = Date.now();
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "dual.test",
          scheme: "http",
          port: address.port,
          url: `http://dual.test:${address.port}`,
        },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      client.destroy();
    }
  });

  it("preserves logical TLS identity while falling back across real DNS addresses", async () => {
    const logicalHost = "entrypoint.test";
    const wrongLogicalHost = "wrong-entrypoint.test";
    const [ca, certificate, key] = await Promise.all([
      readFile(new URL("./fixtures/driver-815-ca.crt", import.meta.url), "utf8"),
      readFile(new URL("./fixtures/driver-815-entrypoint.crt", import.meta.url), "utf8"),
      readFile(new URL("./fixtures/driver-815-entrypoint.key", import.meta.url), "utf8"),
    ]);
    const requests: Array<{
      host: string;
      localAddress: string | undefined;
      path: string | undefined;
      serverName: string | false | null | undefined;
    }> = [];
    const serverNames: Array<{ address: "bad" | "good"; serverName: string }> = [];
    const secureContext = createSecureContext({ cert: certificate, key });
    const createTlsServer = (badAddress: boolean): Server => createHttpsServer(
      {
        cert: certificate,
        key,
        SNICallback: (serverName, callback) => {
          serverNames.push({ address: badAddress ? "bad" : "good", serverName });
          callback(null, secureContext);
        },
      },
      (request, response) => {
        requests.push({
          host: request.headers.host ?? "",
          localAddress: request.socket.localAddress,
          path: request.url,
          serverName: (request.socket as TLSSocket).servername,
        });
        response.setHeader("content-type", "application/x-amz-json-1.0");
        if (request.url === "/localnodes") {
          if (badAddress) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: "temporary" }));
            return;
          }
          response.end(JSON.stringify([logicalHost]));
          return;
        }
        response.end(JSON.stringify({ TableNames: [] }));
      },
    );

    const badServer = createTlsServer(true);
    const goodServer = createTlsServer(false);
    const badAddress = await listen(badServer, "127.0.0.2");
    let goodServerStarted = false;
    const originalLookup = dns.lookup;
    try {
      await listen(goodServer, "127.0.0.1", badAddress.port);
      goodServerStarted = true;
      dns.lookup = logicalHostLookup(originalLookup, logicalHost, "127.0.0.1");
      const resolvedAddresses: LookupAddress[] = [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
      const lookupWithFallback = ((
        hostname: string,
        options?: { all?: boolean; verbatim?: boolean },
      ) => {
        expect([logicalHost, wrongLogicalHost]).toContain(hostname);
        expect(options).toMatchObject({ all: true, verbatim: true });
        return Promise.resolve(resolvedAddresses);
      }) as unknown as typeof dnsLookup;

      await vi.mocked(dnsLookup).withImplementation(lookupWithFallback, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: [logicalHost],
          scheme: "https",
          port: badAddress.port,
          tls: { ca: { text: ca } },
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
          discovery: { background: false, timeoutMs: 500 },
          maxAttempts: 1,
        });
        try {
          await expect(client.alternator.refreshNodes()).resolves.toEqual([
            {
              host: logicalHost,
              scheme: "https",
              port: badAddress.port,
              url: `https://${logicalHost}:${badAddress.port}`,
            },
          ]);
          expect(requests).toEqual([
            {
              host: `${logicalHost}:${badAddress.port}`,
              localAddress: "127.0.0.2",
              path: "/localnodes",
              serverName: logicalHost,
            },
            {
              host: `${logicalHost}:${badAddress.port}`,
              localAddress: "127.0.0.1",
              path: "/localnodes",
              serverName: logicalHost,
            },
          ]);

          await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
            TableNames: [],
          });
          expect(requests.at(-1)).toEqual({
            host: `${logicalHost}:${badAddress.port}`,
            localAddress: "127.0.0.1",
            path: "/",
            serverName: logicalHost,
          });
          expect(serverNames).toEqual([
            { address: "bad", serverName: logicalHost },
            { address: "good", serverName: logicalHost },
            { address: "good", serverName: logicalHost },
          ]);
        } finally {
          client.destroy();
        }

        const requestsBeforeUpdatedAgent = requests.length;
        const updatedAgentClient = new AlternatorDynamoDBClient({
          seeds: [logicalHost],
          scheme: "https",
          port: badAddress.port,
          discovery: { background: false, timeoutMs: 500 },
          maxAttempts: 1,
        });
        const updatedRequestHandler = updatedAgentClient.config.requestHandler as unknown as {
          updateHttpClientConfig(key: string, value: unknown): void;
        };
        updatedRequestHandler.updateHttpClientConfig("httpsAgent", new HttpsAgent({ ca }));
        try {
          await updatedAgentClient.alternator.refreshNodes();
          expect(requests.slice(requestsBeforeUpdatedAgent)).toEqual([
            {
              host: `${logicalHost}:${badAddress.port}`,
              localAddress: "127.0.0.2",
              path: "/localnodes",
              serverName: logicalHost,
            },
            {
              host: `${logicalHost}:${badAddress.port}`,
              localAddress: "127.0.0.1",
              path: "/localnodes",
              serverName: logicalHost,
            },
          ]);
        } finally {
          updatedAgentClient.destroy();
        }

        const requestsBeforeWrongIdentity = requests.length;
        const wrongIdentityClient = new AlternatorDynamoDBClient({
          seeds: [wrongLogicalHost],
          scheme: "https",
          port: badAddress.port,
          tls: { ca: { text: ca } },
          discovery: { background: false, timeoutMs: 500 },
          maxAttempts: 1,
        });
        try {
          await expect(wrongIdentityClient.alternator.refreshNodes()).resolves.toEqual([
            {
              host: wrongLogicalHost,
              scheme: "https",
              port: badAddress.port,
              url: `https://${wrongLogicalHost}:${badAddress.port}`,
            },
          ]);
          expect(requests).toHaveLength(requestsBeforeWrongIdentity);
          expect(serverNames.slice(-2)).toEqual([
            { address: "bad", serverName: wrongLogicalHost },
            { address: "good", serverName: wrongLogicalHost },
          ]);
        } finally {
          wrongIdentityClient.destroy();
        }
      });
    } finally {
      dns.lookup = originalLookup;
      badServer.closeAllConnections?.();
      goodServer.closeAllConnections?.();
      await Promise.all([
        close(badServer),
        goodServerStarted ? close(goodServer) : Promise.resolve(),
      ]);
    }
  });

  it("preserves pinned discovery addresses after HTTP handler config updates", async () => {
    let badRequests = 0;
    let goodRequests = 0;
    const badServer = createServer((_request, response) => {
      badRequests += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "temporary" }));
    });
    const goodServer = createServer((_request, response) => {
      goodRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(["learned-node"]));
    });
    const badAddress = await listen(badServer, "127.0.0.2");
    let goodServerStarted = false;
    const lookupWithFallback = (() => Promise.resolve([
      { address: "127.0.0.2", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])) as unknown as typeof dnsLookup;

    try {
      await listen(goodServer, "127.0.0.1", badAddress.port);
      goodServerStarted = true;
      await vi.mocked(dnsLookup).withImplementation(lookupWithFallback, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: ["entrypoint.test"],
          port: badAddress.port,
          discovery: { background: false, timeoutMs: 500 },
        });
        try {
          await client.alternator.refreshNodes();
          expect([badRequests, goodRequests]).toEqual([1, 1]);

          const redirectingAgent = new Agent({
            keepAlive: false,
            lookup: (_hostname, options, callback) => {
              if (options.all) {
                callback(null, [{ address: "127.0.0.1", family: 4 }]);
                return;
              }
              callback(null, "127.0.0.1", 4);
            },
          });
          const requestHandler = client.config.requestHandler as unknown as {
            updateHttpClientConfig(key: string, value: unknown): void;
          };
          requestHandler.updateHttpClientConfig("httpAgent", redirectingAgent);

          await client.alternator.refreshNodes();
          expect([badRequests, goodRequests]).toEqual([3, 3]);
        } finally {
          client.destroy();
        }
      });
    } finally {
      badServer.closeAllConnections?.();
      goodServer.closeAllConnections?.();
      await Promise.all([
        close(badServer),
        goodServerStarted ? close(goodServer) : Promise.resolve(),
      ]);
    }
  });

  it("tries every unique DNS address after invalid /localnodes responses", async () => {
    const handler = new AddressFallbackRecordingHandler(
      () => ["http-error", "http-error", "malformed", "empty", "unusable", "mixed"],
      (address, request) => {
        expect(request.hostname).toBe("entrypoint.test");
        expect(request.headers.host).toBe("entrypoint.test:8080");
        switch (address) {
          case "http-error":
            return jsonResponse({ error: "temporary" }, 503);
          case "malformed":
            return textResponse("malformed");
          case "empty":
            return jsonResponse([]);
          case "unusable":
            return jsonResponse(["bad host"]);
          case "mixed":
            return jsonResponse([
              "user@ignored.test",
              "ignored.test\\path",
              "not:an:ipv6",
              "%6cearned-node",
              `${"a".repeat(64)}.ignored.test`,
              "ignored..test",
              "learned-node",
            ]);
          default:
            throw new Error(`unexpected address ${address}`);
        }
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "learned-node",
          scheme: "http",
          port: 8080,
          url: "http://learned-node:8080",
        },
      ]);
      expect(handler.resolvedAddresses).toEqual([
        "http-error",
        "malformed",
        "empty",
        "unusable",
        "mixed",
      ]);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
      expect(handler.requests.at(-1)?.hostname).toBe("learned-node");
    } finally {
      client.destroy();
    }
  });

  it("re-resolves original seed after learned nodes fail and preserves last valid nodes", async () => {
    let answers = ["old-address"];
    const unavailable = new Set<string>();
    const handler = new AddressFallbackRecordingHandler(
      () => answers,
      (address) => {
        if (unavailable.has(address)) {
          return jsonResponse({ error: "unavailable" }, 503);
        }
        if (address === "old-address") {
          return jsonResponse(["old-node"]);
        }
        if (address === "new-address") {
          return jsonResponse(["new-node"]);
        }
        return jsonResponse({ error: "unavailable" }, 503);
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["old-node"]);

      unavailable.add("old-address");
      answers = ["broken-address", "new-address"];
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["new-node"]);

      unavailable.add("new-address");
      answers = ["broken-address"];
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["new-node"]);
      expect(handler.resolveCalls).toBe(5);
    } finally {
      client.destroy();
    }
  });

  it("reserves scoped-refresh time for the original seed after many learned nodes stall", async () => {
    const learnedNodes = Array.from({ length: 300 }, (_value, index) => `learned-${index}.test`);
    let recovering = false;
    let seedRecoveryRequests = 0;
    const handler = new AddressFallbackRecordingHandler(
      (hostname) => [hostname],
      (address, request, options) => {
        if (address === "seed.test") {
          if (recovering) {
            seedRecoveryRequests += 1;
          }
          if (request.query.dc === missingDatacenterQuery.dc) {
            return jsonResponse([]);
          }
          return jsonResponse(recovering ? ["recovered-node"] : learnedNodes);
        }
        return new Promise<HttpResponse>((_resolve, reject) => {
          if (options?.abortSignal) {
            options.abortSignal.onabort = () => reject(new Error("request aborted"));
          }
        });
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed.test"],
      requestHandler: handler,
      routing: routing.datacenter({ datacenter: "dc1" }),
      discovery: { background: false, timeoutMs: 120 },
    });

    try {
      await client.alternator.refreshNodes();
      expect(client.alternator.nodes()).toHaveLength(learnedNodes.length);

      recovering = true;
      await client.alternator.refreshNodes();
      const recoveredNodes = client.alternator.nodes();
      expect(recoveredNodes).toHaveLength(1);
      expect(recoveredNodes[0]?.host).toBe("recovered-node");
      expect(seedRecoveryRequests).toBeGreaterThanOrEqual(2);
    } finally {
      client.destroy();
    }
  });

  it("bounds a stalled DNS lookup and continues through another configured seed", async () => {
    const handler = new AddressFallbackRecordingHandler(
      (hostname) => hostname === "stalled.test"
        ? new Promise<readonly string[]>(() => undefined)
        : ["healthy-address"],
      (address) => address === "healthy-address"
        ? jsonResponse(["learned-node"])
        : jsonResponse({ error: "unavailable" }, 503),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["stalled.test", "healthy.test"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 20 },
    });

    try {
      const startedAt = Date.now();
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
        { host: "stalled.test", scheme: "http", port: 8080, url: "http://stalled.test:8080" },
        { host: "healthy.test", scheme: "http", port: 8080, url: "http://healthy.test:8080" },
      ]);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(handler.resolveCalls).toBe(2);
      expect(handler.resolvedAddresses).toEqual(["healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("starts a fresh production DNS lookup after the previous lookup times out", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(["learned-node"]));
    });
    const address = await listen(server);
    let lookupCalls = 0;
    const lookupWithInitialStall = (() => {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        return new Promise<never>(() => undefined);
      }
      return Promise.resolve([{ address: address.address, family: 4 }]);
    }) as unknown as typeof dnsLookup;

    try {
      await vi.mocked(dnsLookup).withImplementation(lookupWithInitialStall, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: ["entrypoint.test"],
          port: address.port,
          discovery: { background: false, timeoutMs: 20 },
        });
        try {
          await expect(client.alternator.refreshNodes()).resolves.toEqual([
            {
              host: "entrypoint.test",
              scheme: "http",
              port: address.port,
              url: `http://entrypoint.test:${address.port}`,
            },
          ]);
          await expect(client.alternator.refreshNodes()).resolves.toEqual([
            {
              host: "learned-node",
              scheme: "http",
              port: address.port,
              url: `http://learned-node:${address.port}`,
            },
          ]);
          expect(lookupCalls).toBe(2);
        } finally {
          client.destroy();
        }
      });
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("does not let abandoned DNS lookups for one host exhaust resolution for another seed", async () => {
    let learnedNode = "old-node";
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([learnedNode]));
    });
    const address = await listen(server);
    const lookupWithPermanentStall = ((hostname: string) => {
      if (hostname === "stalled.test") {
        return new Promise<never>(() => undefined);
      }
      if (hostname === "healthy.test") {
        return Promise.resolve([{ address: address.address, family: 4 }]);
      }
      return Promise.reject(new Error(`unexpected DNS hostname ${hostname}`));
    }) as unknown as typeof dnsLookup;

    try {
      await vi.mocked(dnsLookup).withImplementation(lookupWithPermanentStall, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: ["stalled.test", "healthy.test"],
          port: address.port,
          discovery: { background: false, timeoutMs: 20 },
        });
        try {
          for (let index = 0; index < 63; index += 1) {
            await client.alternator.refreshNodes();
          }
          expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
            "old-node",
            "stalled.test",
            "healthy.test",
          ]);

          learnedNode = "new-node";
          await client.alternator.refreshNodes();
          expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
            "new-node",
            "old-node",
            "stalled.test",
            "healthy.test",
          ]);
        } finally {
          client.destroy();
        }
      });
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("reserves production DNS capacity for a seed after distinct learned lookups stall", async () => {
    const learnedNodes = Array.from({ length: 64 }, (_value, index) => `stalled-${index}.test`);
    let recovering = false;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(recovering ? ["recovered-node"] : learnedNodes));
    });
    const address = await listen(server);
    const lookupWithStalledLearnedNodes = ((hostname: string) => {
      if (hostname === "seed.test") {
        return Promise.resolve([{ address: address.address, family: 4 }]);
      }
      if (learnedNodes.includes(hostname)) {
        return new Promise<never>(() => undefined);
      }
      return Promise.reject(new Error(`unexpected DNS hostname ${hostname}`));
    }) as unknown as typeof dnsLookup;

    try {
      await vi.mocked(dnsLookup).withImplementation(lookupWithStalledLearnedNodes, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: ["seed.test"],
          port: address.port,
          discovery: { background: false, timeoutMs: 160 },
        });
        try {
          await client.alternator.refreshNodes();
          expect(client.alternator.nodes()).toHaveLength(learnedNodes.length);

          recovering = true;
          await client.alternator.refreshNodes();
          expect(client.alternator.nodes().map(({ host }) => host)).toEqual([
            "recovered-node",
            ...learnedNodes,
          ]);
        } finally {
          client.destroy();
        }
      });
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("uses a literal seed after the production DNS capacity is exhausted", async () => {
    const stalledSeeds: [string, ...string[]] = [
      "stalled-seed-0.test",
      ...Array.from({ length: 63 }, (_value, index) => `stalled-seed-${index + 1}.test`),
    ];
    const recoverySeeds: [string, ...string[]] = [...stalledSeeds, "127.0.0.1"];
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(["recovered-node"]));
    });
    const address = await listen(server);
    let lookupCalls = 0;
    const lookupWithPermanentStalls = (() => {
      lookupCalls += 1;
      return new Promise<never>(() => undefined);
    }) as unknown as typeof dnsLookup;

    try {
      await vi.mocked(dnsLookup).withImplementation(lookupWithPermanentStalls, async () => {
        const client = new AlternatorDynamoDBClient({
          seeds: recoverySeeds,
          port: address.port,
          discovery: { background: false, timeoutMs: 1_300 },
        });
        try {
          const nodes = await client.alternator.refreshNodes();
          expect(nodes[0]).toEqual({
            host: "recovered-node",
            scheme: "http",
            port: address.port,
            url: `http://recovered-node:${address.port}`,
          });
          expect(lookupCalls).toBe(stalledSeeds.length);
        } finally {
          client.destroy();
        }
      });
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("bounds stalled address requests and response bodies before trying later addresses", async () => {
    let requestAborted = false;
    let stalledBody: Readable | undefined;
    const handler = new AddressFallbackRecordingHandler(
      () => ["stalled-request", "stalled-body", "healthy-address"],
      (address, _request, options) => {
        if (address === "stalled-request") {
          return new Promise<HttpResponse>((_resolve, reject) => {
            if (!options?.abortSignal) {
              return;
            }
            options.abortSignal.onabort = () => {
              requestAborted = true;
              reject(new Error("request aborted"));
            };
          });
        }
        if (address === "stalled-body") {
          stalledBody = new Readable({ read() {} });
          stalledBody.push("[");
          return new HttpResponse({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: stalledBody,
          });
        }
        return jsonResponse(["learned-node"]);
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 20 },
    });
    let guard: ReturnType<typeof setTimeout> | undefined;

    try {
      const guardedRefresh = Promise.race([
        client.alternator.refreshNodes(),
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("refresh did not respect address deadlines")), 500);
        }),
      ]);
      await expect(guardedRefresh).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(requestAborted).toBe(true);
      expect(stalledBody?.destroyed).toBe(true);
      expect(handler.resolvedAddresses).toEqual([
        "stalled-request",
        "stalled-body",
        "healthy-address",
      ]);
    } finally {
      if (guard) {
        clearTimeout(guard);
      }
      client.destroy();
    }
  });

  it("cancels a locked Web response stream before trying the next address", async () => {
    let bodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const handler = new AddressFallbackRecordingHandler(
      () => ["stalled-body", "healthy-address"],
      (address) => address === "stalled-body"
        ? new HttpResponse({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: stalledBody,
          })
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 50 },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(bodyCancelled).toBe(true);
      expect(handler.resolvedAddresses).toEqual(["stalled-body", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("destroys the compressed source when a discovery body times out", async () => {
    const compressedBody = new Readable({ read() {} });
    const handler = new AddressFallbackRecordingHandler(
      () => ["stalled-body", "healthy-address"],
      (address) => address === "stalled-body"
        ? new HttpResponse({
            statusCode: 200,
            headers: {
              "content-encoding": "gzip",
              "content-type": "application/json",
            },
            body: compressedBody,
          })
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      compression: { response: { algorithms: ["gzip"] } },
      discovery: { background: false, timeoutMs: 50 },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(compressedBody.destroyed).toBe(true);
      expect(handler.resolvedAddresses).toEqual(["stalled-body", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("cancels and unlocks a stalled compressed Web body before trying the next address", async () => {
    let bodyCancelled = false;
    const compressedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gzipSync(JSON.stringify(["stalled-node"])));
      },
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const handler = new AddressFallbackRecordingHandler(
      () => ["stalled-body", "healthy-address"],
      (address) => address === "stalled-body"
        ? new HttpResponse({
            statusCode: 200,
            headers: {
              "content-encoding": "gzip",
              "content-type": "application/json",
            },
            body: compressedBody,
          })
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      compression: { response: { algorithms: ["gzip"] } },
      discovery: { background: false, timeoutMs: 50 },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      await vi.waitFor(() => {
        expect(bodyCancelled).toBe(true);
        expect(compressedBody.locked).toBe(false);
      });
      expect(handler.resolvedAddresses).toEqual(["stalled-body", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("cancels and unlocks a stalled compressed Web body in edge runtime", async () => {
    let bodyCancelled = false;
    const compressedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gzipSync(JSON.stringify(["stalled-node"])));
      },
      cancel() {
        bodyCancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const handler = new AddressFallbackRecordingHandler(
      () => ["stalled-body", "healthy-address"],
      (address) => address === "stalled-body"
        ? new HttpResponse({
            statusCode: 200,
            headers: {
              "content-encoding": "gzip",
              "content-type": "application/json",
            },
            body: compressedBody,
          })
        : jsonResponse(["learned-node"]),
    );
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      runtime: "edge",
      requestHandler: handler,
      compression: { response: { algorithms: ["gzip"] } },
      discovery: { background: false, timeoutMs: 50 },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      await vi.waitFor(() => {
        expect(bodyCancelled).toBe(true);
        expect(compressedBody.locked).toBe(false);
      });
      expect(handler.resolvedAddresses).toEqual(["stalled-body", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("rejects transform-only compressed discovery bodies before invoking their transform", async () => {
    let transformed = false;
    const handler = new AddressFallbackRecordingHandler(
      () => ["opaque-body", "healthy-address"],
      (address) => address === "opaque-body"
        ? new HttpResponse({
            statusCode: 200,
            headers: {
              "content-encoding": "gzip",
              "content-type": "application/json",
            },
            body: {
              transformToByteArray: () => {
                transformed = true;
                return Promise.resolve(gzipSync("[]"));
              },
            },
          })
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      compression: { response: { algorithms: ["gzip"] } },
      discovery: { background: false },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(transformed).toBe(false);
      expect(handler.resolvedAddresses).toEqual(["opaque-body", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("reserves discovery time for a healthy seed after a DNS answer full of stalled addresses", async () => {
    const stalledAddresses = Array.from({ length: 100 }, (_value, index) => `stalled-${index}`);
    const handler = new AddressFallbackRecordingHandler(
      (hostname) => hostname === "noisy.test" ? stalledAddresses : ["healthy-address"],
      (address, _request, options) => {
        if (address === "healthy-address") {
          return jsonResponse(["learned-node"]);
        }
        return new Promise<HttpResponse>((_resolve, reject) => {
          if (options?.abortSignal) {
            options.abortSignal.onabort = () => reject(new Error("request aborted"));
          }
        });
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["noisy.test", "healthy.test"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 100 },
    });
    let guard: ReturnType<typeof setTimeout> | undefined;

    try {
      const guardedRefresh = Promise.race([
        client.alternator.refreshNodes(),
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("stalled DNS answers starved the healthy seed")), 500);
        }),
      ]);
      await expect(guardedRefresh).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
        { host: "noisy.test", scheme: "http", port: 8080, url: "http://noisy.test:8080" },
        { host: "healthy.test", scheme: "http", port: 8080, url: "http://healthy.test:8080" },
      ]);
      expect(handler.resolvedAddresses).toContain("healthy-address");
      expect(handler.resolvedAddresses.length).toBeLessThan(stalledAddresses.length + 1);
    } finally {
      if (guard) {
        clearTimeout(guard);
      }
      client.destroy();
    }
  });

  it("rejects oversized discovery bodies and continues with the next address", async () => {
    const handler = new AddressFallbackRecordingHandler(
      () => ["oversized", "healthy-address"],
      (address) => address === "oversized"
        ? textResponse(JSON.stringify(["x".repeat((1 << 20) + 1)]))
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(handler.resolvedAddresses).toEqual(["oversized", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("rejects discovery responses with too many duplicate node entries", async () => {
    const handler = new AddressFallbackRecordingHandler(
      () => ["too-many-entries", "healthy-address"],
      (address) => address === "too-many-entries"
        ? jsonResponse(Array.from({ length: 16_385 }, () => "duplicate-node"))
        : jsonResponse(["learned-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        { host: "learned-node", scheme: "http", port: 8080, url: "http://learned-node:8080" },
      ]);
      expect(handler.resolvedAddresses).toEqual(["too-many-entries", "healthy-address"]);
    } finally {
      client.destroy();
    }
  });

  it("cancels an in-flight discovery refresh when the client is destroyed", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const handler = new AddressFallbackRecordingHandler(
      () => {
        resolveStarted?.();
        return new Promise<readonly string[]>(() => undefined);
      },
      () => jsonResponse(["unexpected-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 10_000 },
    });
    let guard: ReturnType<typeof setTimeout> | undefined;

    const refresh = client.alternator.refreshNodes();
    await started;
    client.destroy();
    try {
      const guardedRefresh = Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("destroy did not cancel discovery")), 250);
        }),
      ]);
      await expect(guardedRefresh).resolves.toEqual([
        { host: "entrypoint.test", scheme: "http", port: 8080, url: "http://entrypoint.test:8080" },
      ]);
    } finally {
      if (guard) {
        clearTimeout(guard);
      }
    }
  });

  it("does not start more seed attempts after an in-flight refresh is destroyed", async () => {
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const seeds = [
      "stalled.test",
      ...Array.from({ length: 50 }, (_value, index) => `unused-${index}.test`),
    ] as [string, ...string[]];
    const handler = new AddressFallbackRecordingHandler(
      (hostname) => {
        if (hostname === "stalled.test") {
          resolveStarted?.();
          return new Promise<readonly string[]>(() => undefined);
        }
        return [hostname];
      },
      () => jsonResponse(["unexpected-node"]),
    );
    const client = new AlternatorDynamoDBClient({
      seeds,
      requestHandler: handler,
      discovery: { background: false, timeoutMs: 10_000 },
    });

    const refresh = client.alternator.refreshNodes();
    await started;
    client.destroy();
    await refresh;

    expect(handler.resolveCalls).toBe(1);
    expect(handler.resolvedAddresses).toEqual([]);
  });

  it("coalesces overlapping DNS refreshes and publishes only the complete result", async () => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const handler = new AddressFallbackRecordingHandler(
      () => ["address-a"],
      async () => {
        await responseGate;
        return jsonResponse(["node-a", "node-b"]);
      },
    );
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
    });

    try {
      const first = client.alternator.refreshNodes();
      const second = client.alternator.refreshNodes();
      await Promise.resolve();
      expect(handler.resolveCalls).toBe(1);
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["entrypoint.test"]);

      releaseResponse?.();
      await expect(Promise.all([first, second])).resolves.toEqual([
        [
          { host: "node-a", scheme: "http", port: 8080, url: "http://node-a:8080" },
          { host: "node-b", scheme: "http", port: 8080, url: "http://node-b:8080" },
        ],
        [
          { host: "node-a", scheme: "http", port: 8080, url: "http://node-a:8080" },
          { host: "node-b", scheme: "http", port: 8080, url: "http://node-b:8080" },
        ],
      ]);
      expect(client.alternator.nodes().map(({ host }) => host)).toEqual(["node-a", "node-b"]);
    } finally {
      client.destroy();
    }
  });

  it("bounds draining non-terminating non-2xx discovery bodies", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/localnodes");
      requests += 1;
      response.setHeader("content-type", "application/json");
      if (requests === 1) {
        response.statusCode = 500;
        response.write(JSON.stringify({ error: "temporary failure" }));
        return;
      }
      response.end(JSON.stringify(["node-a.internal"]));
    });
    const address = await listen(server);
    const client = new AlternatorDynamoDBClient({
      // Two distinct logical seeds deliberately resolve to the same socket so
      // the second attempt verifies that aborting the first body released the
      // single cached address delegate.
      seeds: ["127.0.0.1", "localhost"],
      port: address.port,
      discovery: {
        background: false,
        timeoutMs: 20,
      },
      connection: {
        keepAlive: true,
        maxSockets: 1,
      },
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "node-a.internal",
          scheme: "http",
          port: address.port,
          url: `http://node-a.internal:${address.port}`,
        },
        {
          host: "127.0.0.1",
          scheme: "http",
          port: address.port,
          url: `http://127.0.0.1:${address.port}`,
        },
        {
          host: "localhost",
          scheme: "http",
          port: address.port,
          url: `http://localhost:${address.port}`,
        },
      ]);
      expect(requests).toBe(2);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it("keeps the DynamoDB socket reusable after repeated non-2xx responses", async () => {
    let requests = 0;
    let connections = 0;
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/");
      request.resume();
      request.on("end", () => {
        requests += 1;
        response.setHeader("content-type", "application/x-amz-json-1.0");
        if (requests < 3) {
          response.statusCode = 400;
          response.end(JSON.stringify({ __type: "ValidationException", message: "bad" }));
          return;
        }
        response.end(JSON.stringify({ TableNames: [] }));
      });
    });
    server.on("connection", () => {
      connections += 1;
    });
    const address = await listen(server);
    const client = new AlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      discovery: {
        background: false,
      },
      connection: {
        keepAlive: true,
        maxSockets: 1,
      },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).rejects.toThrow(/bad/);
      await expect(client.send(new ListTablesCommand({}))).rejects.toThrow(/bad/);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
      expect(requests).toBe(3);
      expect(connections).toBe(1);
    } finally {
      client.destroy();
      await close(server);
    }
  });

  it("does not issue requests after the client is destroyed", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.end(JSON.stringify({ TableNames: [] }));
    });
    const address = await listen(server);
    const client = new AlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      discovery: { background: false },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
      client.destroy();
      await expect(client.send(new ListTablesCommand({}))).rejects.toThrow(/destroyed/);
      expect(requests).toBe(1);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });
});

function listen(server: Server, host = "127.0.0.1", port = 0): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function dualStackHandler(addresses: LookupAddress[]): NodeHttpHandler {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const first = addresses[0];
    if (!first) {
      callback(new Error("no DNS records"), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  };
  return new NodeHttpHandler({
    httpAgent: new Agent({
      keepAlive: false,
      lookup,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 10,
    }),
  });
}

function logicalHostLookup(
  delegate: typeof dns.lookup,
  logicalHost: string,
  address: string,
): typeof dns.lookup {
  return ((hostname: string, optionsOrCallback: unknown, callbackValue?: unknown) => {
    if (hostname !== logicalHost) {
      Reflect.apply(delegate, dns, [hostname, optionsOrCallback, callbackValue]);
      return;
    }

    const callback = typeof optionsOrCallback === "function"
      ? optionsOrCallback
      : callbackValue;
    if (typeof callback !== "function") {
      throw new TypeError("DNS lookup callback is required");
    }
    const respond = callback as (...values: unknown[]) => void;
    const all = typeof optionsOrCallback === "object"
      && optionsOrCallback !== null
      && "all" in optionsOrCallback
      && optionsOrCallback.all === true;
    if (all) {
      respond(null, [{ address, family: 4 }]);
      return;
    }
    respond(null, address, 4);
  }) as unknown as typeof dns.lookup;
}

class AddressFallbackRecordingHandler extends RecordingHandler {
  readonly resolvedAddresses: string[] = [];
  resolveCalls = 0;
  readonly discoveryAddressFallback: {
    resolve(hostname: string): Promise<readonly string[]>;
    handle(
      request: HttpRequest,
      address: string,
      options?: HttpHandlerOptions,
    ): Promise<{ response: HttpResponse }>;
  };

  constructor(
    resolve: (hostname: string) => readonly string[] | Promise<readonly string[]>,
    responder: (
      address: string,
      request: HttpRequest,
      options?: HttpHandlerOptions,
    ) => HttpResponse | Promise<HttpResponse>,
  ) {
    super((request) => request.path === "/localnodes" ? [] : { TableNames: [] });
    this.discoveryAddressFallback = {
      resolve: (hostname) => {
        this.resolveCalls += 1;
        return Promise.resolve(resolve(hostname));
      },
      handle: (request, address, options) => {
        this.resolvedAddresses.push(address);
        return Promise.resolve(responder(address, request, options)).then((response) => ({ response }));
      },
    };
  }
}

function textResponse(body: string, statusCode = 200): HttpResponse {
  return new HttpResponse({
    statusCode,
    headers: { "content-type": "application/json" },
    body: Readable.from([body]),
  });
}
