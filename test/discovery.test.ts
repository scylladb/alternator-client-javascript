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
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createSecureContext, type TLSSocket } from "node:tls";

vi.mock("node:dns/promises", async (importOriginal) => {
  const original = await importOriginal<{ lookup: typeof dnsLookup }>();
  return { ...original, lookup: vi.fn(original.lookup) };
});

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

  it("tries every unique DNS address after invalid /localnodes responses", async () => {
    const handler = new AddressFallbackRecordingHandler(
      () => ["http-error", "http-error", "malformed", "empty", "unusable", "good"],
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
          case "good":
            return jsonResponse(["learned-node"]);
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
        "good",
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
      expect(handler.resolveCalls).toBe(3);
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
      ]);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(handler.resolveCalls).toBe(2);
      expect(handler.resolvedAddresses).toEqual(["healthy-address"]);
    } finally {
      client.destroy();
    }
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
