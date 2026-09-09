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
import { RecordingHandler } from "./helpers.js";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import {
  FetchHttpHandler as SmithyFetchHttpHandler,
  streamCollector as fetchStreamCollector,
} from "@smithy/fetch-http-handler";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import { Agent, createServer, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

const missingDatacenterQuery = { dc: "__alternator_client_missing_dc__" };
const missingRackQuery = { rack: "__alternator_client_missing_rack__" };

describe("Alternator discovery", () => {
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

  it("refreshes through the original contact after a learned node becomes unavailable", async () => {
    let recovering = false;
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        expect(request.hostname).toBe("entrypoint.test");
        expect(request.headers.host).toBe("entrypoint.test:8080");
        return recovering ? ["new-node.internal"] : ["old-node.internal"];
      }
      if (request.hostname === "old-node.internal" && recovering) {
        throw new Error("learned node unavailable");
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["entrypoint.test"],
      requestHandler: handler,
      discovery: { background: false },
      maxAttempts: 1,
    });

    try {
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "old-node.internal",
          scheme: "http",
          port: 8080,
          url: "http://old-node.internal:8080",
        },
      ]);

      recovering = true;
      await expect(client.send(new ListTablesCommand({}))).rejects.toThrow(
        "learned node unavailable",
      );
      await expect(client.alternator.refreshNodes()).resolves.toEqual([
        {
          host: "new-node.internal",
          scheme: "http",
          port: 8080,
          url: "http://new-node.internal:8080",
        },
      ]);
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });

      expect(
        handler.requests
          .filter(({ path }) => path === "/localnodes")
          .map(({ hostname }) => hostname),
      ).toEqual(["entrypoint.test", "entrypoint.test"]);
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
      "seed-dc1.internal",
      "seed-dc2.internal",
    ]);
    expect(handler.requests.map((request) => request.query)).toEqual([{}, {}, {}, {}]);
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
      seeds: [address.address, address.address],
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
      ]);
      expect(requests).toBe(2);
    } finally {
      client.destroy();
      server.closeAllConnections?.();
      await close(server);
    }
  });

  it.each(["headers", "body"] as const)(
    "enforces discovery timeout while waiting for response %s",
    async (stallAt) => {
      const server = createServer((request, response) => {
        expect(request.url).toBe("/localnodes");
        request.resume();
        if (stallAt === "body") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.write('["node-a.internal"');
          response.flushHeaders();
        }
      });
      const address = await listen(server);
      const client = new AlternatorDynamoDBClient({
        seeds: [address.address],
        port: address.port,
        discovery: {
          background: false,
          timeoutMs: 20,
        },
        ...(stallAt === "body"
          ? { connection: { throwOnRequestTimeout: true } }
          : {}),
      });

      try {
        const completed = await Promise.race([
          client.alternator.refreshNodes().then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);
        expect(completed).toBe(true);
        expect(client.alternator.nodes()).toEqual([
          {
            host: address.address,
            scheme: "http",
            port: address.port,
            url: `http://${address.address}:${address.port}`,
          },
        ]);
      } finally {
        client.destroy();
        server.closeAllConnections?.();
        await close(server);
      }
    },
  );

  it("keeps foreground discovery deadline timers referenced", async () => {
    const timer = setTimeout(() => undefined, 60_000);
    const timerPrototype = Object.getPrototypeOf(timer) as { unref(): void };
    clearTimeout(timer);
    const unref = vi.spyOn(timerPrototype, "unref");
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => new Promise(() => undefined)),
      discovery: { background: false, timeoutMs: 1 },
    });

    try {
      await client.alternator.refreshNodes();
      expect(unref).not.toHaveBeenCalled();
    } finally {
      client.destroy();
      unref.mockRestore();
    }
  });

  it("promotes an unreferenced background discovery deadline when a foreground refresh joins", async () => {
    const timeoutMs = 31_337;
    let firstRequestStarted!: () => void;
    let rejectFirstRequest!: (error: Error) => void;
    let secondRequestStarted!: () => void;
    let resolveSecondRequest!: (nodes: string[]) => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstRequestStarted = resolve;
    });
    const firstResponse = new Promise<never>((_resolve, reject) => {
      rejectFirstRequest = reject;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondRequestStarted = resolve;
    });
    const secondResponse = new Promise<string[]>((resolve) => {
      resolveSecondRequest = resolve;
    });
    let requestCount = 0;
    const handler = new RecordingHandler(() => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestStarted();
        return firstResponse;
      }
      secondRequestStarted();
      return secondResponse;
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-a", "seed-b"],
      requestHandler: handler,
      discovery: {
        background: true,
        refreshIntervalMs: 1,
        timeoutMs,
      },
    });

    try {
      await firstStarted;
      const firstDeadline = setTimeoutSpy.mock.results.find(
        (_result, index) => setTimeoutSpy.mock.calls[index]?.[1] === timeoutMs,
      )?.value as ReturnType<typeof setTimeout> | undefined;
      expect(firstDeadline?.hasRef?.()).toBe(false);

      const foregroundRefresh = client.alternator.refreshNodes();
      expect(requestCount).toBe(1);
      expect(firstDeadline?.hasRef?.()).toBe(true);

      rejectFirstRequest(new Error("first seed unavailable"));
      await secondStarted;
      const deadlines = setTimeoutSpy.mock.results
        .filter((_result, index) => setTimeoutSpy.mock.calls[index]?.[1] === timeoutMs)
        .map((result) => result.value as ReturnType<typeof setTimeout>);
      expect(deadlines).toHaveLength(2);
      expect(deadlines[1]?.hasRef?.()).toBe(true);

      resolveSecondRequest(["node-a"]);
      await expect(foregroundRefresh).resolves.toEqual([
        {
          host: "node-a",
          scheme: "http",
          port: 8080,
          url: "http://node-a:8080",
        },
      ]);
    } finally {
      client.destroy();
      rejectFirstRequest(new Error("test cleanup"));
      resolveSecondRequest(["node-a"]);
      setTimeoutSpy.mockRestore();
    }
  });

  it("merges HTTP handler options without dropping bounded connection settings", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const server = createServer((request, response) => {
      request.resume();
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      setTimeout(() => {
        response.setHeader("content-type", "application/x-amz-json-1.0");
        response.end(JSON.stringify({ TableNames: [] }));
        activeRequests -= 1;
      }, 20);
    });
    const address = await listen(server);
    const client = new AlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      tls: {
        ca: { file: fileURLToPath(import.meta.url) },
      },
      requestHandler: {
        requestTimeout: 1_000,
        httpAgent: undefined,
      } as never,
      discovery: { background: false },
      connection: { maxSockets: 1 },
      maxAttempts: 1,
    });

    try {
      await Promise.all(
        Array.from({ length: 8 }, () => client.send(new ListTablesCommand({}))),
      );
      expect(peakRequests).toBe(1);
    } finally {
      client.destroy();
      await close(server);
    }
  });

  it("uses Fetch decoding once for compressed edge responses", async () => {
    const compressed = gzipSync(JSON.stringify({ TableNames: ["decoded"] }));
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.setHeader("content-encoding", "gzip");
      response.setHeader("content-length", String(compressed.byteLength));
      response.end(compressed);
    });
    const address = await listen(server);
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      runtime: "edge",
      discovery: {
        background: false,
        requestRefreshIntervalMs: 0,
      },
      compression: {
        response: { algorithms: ["gzip"] },
      },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client.destroy();
      await close(server);
    }
  });

  it("preserves opaque decoded bodies from an explicitly configured Fetch handler", async () => {
    const decoded = new TextEncoder().encode(JSON.stringify({ TableNames: ["decoded"] }));
    const LegacyBlob = class Blob {
      constructor(readonly bytes: Uint8Array) {}
    };
    class LegacyFileReader {
      readyState = 0;
      result: string | null = null;
      onloadend: (() => void) | null = null;

      readAsDataURL(blob: InstanceType<typeof LegacyBlob>): void {
        this.readyState = 2;
        this.result = `data:application/octet-stream;base64,${Buffer.from(blob.bytes).toString("base64")}`;
        this.onloadend?.();
      }
    }
    const handle = vi.spyOn(SmithyFetchHttpHandler.prototype, "handle");
    let client: EdgeAlternatorDynamoDBClient | undefined;

    try {
      vi.stubGlobal("Blob", LegacyBlob);
      vi.stubGlobal("FileReader", LegacyFileReader);
      vi.stubGlobal("fetch", (request: Request): Promise<Response> => {
        if (new URL(request.url).pathname === "/localnodes") {
          return Promise.resolve({
            headers: new Headers({ "content-type": "application/json" }),
            body: '["seed"]',
            status: 200,
            statusText: "OK",
          } as unknown as Response);
        }
        return Promise.resolve({
          headers: new Headers({
            "content-type": "application/x-amz-json-1.0",
            "content-encoding": "gzip",
          }),
          body: undefined,
          blob: () => Promise.resolve(new LegacyBlob(decoded)),
          status: 200,
          statusText: "OK",
        } as unknown as Response);
      });
      const opaqueBody = new LegacyBlob(decoded);
      await expect(fetchStreamCollector(opaqueBody as never)).resolves.toEqual(decoded);
      client = new EdgeAlternatorDynamoDBClient({
        seeds: ["seed"],
        runtime: "edge",
        requestHandler: new SmithyFetchHttpHandler(),
        streamCollector: fetchStreamCollector,
        discovery: { background: false, requestRefreshIntervalMs: 0 },
        compression: { response: { algorithms: ["gzip"] } },
        maxAttempts: 1,
      });

      await client.alternator.refreshNodes();
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client?.destroy();
      handle.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("merges Fetch handler options with edge connection settings", async () => {
    let requestInitCalls = 0;
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.end(JSON.stringify({ TableNames: [] }));
    });
    const address = await listen(server);
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: [address.address],
      port: address.port,
      runtime: "edge",
      requestHandler: {
        requestTimeout: undefined,
        requestInit: undefined,
        cache: "no-store",
      } as never,
      connection: {
        timeouts: { requestMs: 1_000 },
        fetch: {
          requestInit: () => {
            requestInitCalls += 1;
            return {};
          },
        },
      },
      discovery: { background: false, requestRefreshIntervalMs: 0 },
      maxAttempts: 1,
    });

    try {
      await client.send(new ListTablesCommand({}));
      expect(requestInitCalls).toBe(1);
      expect(
        (client.config.requestHandler as SmithyFetchHttpHandler).httpHandlerConfigs(),
      ).toMatchObject({
        requestTimeout: 1_000,
        cache: "no-store",
      });
    } finally {
      client.destroy();
      await close(server);
    }
  });

  it("normalizes Fetch-decoded responses from a handler with another constructor", async () => {
    const compressed = gzipSync(JSON.stringify({ TableNames: ["decoded"] }));
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/x-amz-json-1.0");
      response.setHeader("content-encoding", "gzip");
      response.end(compressed);
    });
    const address = await listen(server);
    const delegate = new SmithyFetchHttpHandler();
    const DuplicateFetchHttpHandler = class FetchHttpHandler {
      handle(request: HttpRequest, options?: HttpHandlerOptions) {
        return delegate.handle(request, options);
      }

      destroy(): void {
        delegate.destroy();
      }

      updateHttpClientConfig(...args: Parameters<typeof delegate.updateHttpClientConfig>): void {
        delegate.updateHttpClientConfig(...args);
      }

      httpHandlerConfigs(): ReturnType<typeof delegate.httpHandlerConfigs> {
        return delegate.httpHandlerConfigs();
      }
    };
    const originalDecompressionStream = globalThis.DecompressionStream;
    vi.stubGlobal("DecompressionStream", undefined);
    let client: EdgeAlternatorDynamoDBClient | undefined;

    try {
      client = new EdgeAlternatorDynamoDBClient({
        seeds: [address.address],
        port: address.port,
        runtime: "edge",
        requestHandler: new DuplicateFetchHttpHandler(),
        discovery: { background: false, requestRefreshIntervalMs: 0 },
        compression: { response: { algorithms: ["gzip"] } },
        maxAttempts: 1,
      });
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client?.destroy();
      vi.stubGlobal("DecompressionStream", originalDecompressionStream);
      await close(server);
    }
  });

  it.each([
    ["a cross-realm Blob", foreignBlobBody],
    ["a reader-only stream", readerOnlyBody],
  ] as const)("normalizes Fetch-decoded responses backed by %s", async (_label, bodyFactory) => {
    const decoded = new TextEncoder().encode(JSON.stringify({ TableNames: ["decoded"] }));
    await expect(fetchStreamCollector(bodyFactory(decoded) as never)).resolves.toEqual(decoded);

    class DecodedFetchHttpHandler extends SmithyFetchHttpHandler {
      override handle(_request: HttpRequest, _options?: HttpHandlerOptions) {
        return Promise.resolve({
          response: new HttpResponse({
            statusCode: 200,
            headers: {
              "content-type": "application/x-amz-json-1.0",
              "content-encoding": "gzip",
            },
            body: bodyFactory(decoded),
          }),
        });
      }
    }

    const originalDecompressionStream = globalThis.DecompressionStream;
    vi.stubGlobal("DecompressionStream", undefined);
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["seed"],
      runtime: "edge",
      requestHandler: new DecodedFetchHttpHandler(),
      streamCollector: fetchStreamCollector,
      discovery: { background: false, requestRefreshIntervalMs: 0 },
      compression: { response: { algorithms: ["gzip"] } },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client.destroy();
      vi.stubGlobal("DecompressionStream", originalDecompressionStream);
    }
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
  ] as const)("decodes raw %s from a custom handler named FetchHttpHandler", async (encoding, compress) => {
    const compressed = compress(JSON.stringify({ TableNames: ["decoded"] }));
    const RawFetchHttpHandler = class FetchHttpHandler extends RecordingHandler {};
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["seed"],
      runtime: "edge",
      requestHandler: new RawFetchHttpHandler(() => new HttpResponse({
        statusCode: 200,
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "content-encoding": encoding,
          "content-length": String(compressed.byteLength),
        },
        body: bytewiseReadableStream(compressed),
      })),
      discovery: { background: false, requestRefreshIntervalMs: 0 },
      compression: { response: { algorithms: [encoding] } },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client.destroy();
    }
  });

  it("decodes raw compression from a custom FetchHttpHandler subclass", async () => {
    const compressed = gzipSync(JSON.stringify({ TableNames: ["decoded"] }));
    class RawFetchHttpHandler extends SmithyFetchHttpHandler {
      override handle(_request: HttpRequest, _options?: HttpHandlerOptions) {
        return Promise.resolve({
          response: new HttpResponse({
            statusCode: 200,
            headers: {
              "content-type": "application/x-amz-json-1.0",
              "content-encoding": "gzip",
            },
            body: bytewiseReadableStream(compressed),
          }),
        });
      }
    }
    const client = new EdgeAlternatorDynamoDBClient({
      seeds: ["seed"],
      runtime: "edge",
      requestHandler: new RawFetchHttpHandler(),
      discovery: { background: false, requestRefreshIntervalMs: 0 },
      compression: { response: { algorithms: ["gzip"] } },
      maxAttempts: 1,
    });

    try {
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: ["decoded"],
      });
    } finally {
      client.destroy();
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
});

function listen(server: Server, host = "127.0.0.1"): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
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

function bytewiseReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + 1));
      offset += 1;
    },
  });
}

function foreignBlobBody(bytes: Uint8Array): unknown {
  const ForeignBlob = class Blob {
    constructor(private readonly body: Uint8Array) {}

    arrayBuffer(): Promise<ArrayBuffer> {
      return Promise.resolve(new Uint8Array(this.body).buffer);
    }
  };
  return new ForeignBlob(bytes);
}

function readerOnlyBody(bytes: Uint8Array): unknown {
  let emitted = false;
  return {
    getReader() {
      return {
        read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (emitted) {
            return Promise.resolve({ done: true });
          }
          emitted = true;
          return Promise.resolve({ done: false, value: bytes });
        },
      };
    },
  };
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
