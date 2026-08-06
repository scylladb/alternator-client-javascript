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

import { describe, expect, it } from "vitest";
import { AlternatorDynamoDBClient, routing } from "../src/index.js";
import { AlternatorDynamoDBClient as EdgeAlternatorDynamoDBClient } from "../src/edge.js";
import { RecordingHandler } from "./helpers.js";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent, createServer, type Server } from "node:http";
import type { LookupAddress } from "node:dns";
import type { AddressInfo, LookupFunction } from "node:net";

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
