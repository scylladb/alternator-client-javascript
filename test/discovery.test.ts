import { describe, expect, it } from "vitest";
import { AlternatorDynamoDBClient, routing } from "../src/index.js";
import { RecordingHandler } from "./helpers.js";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";

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

    await expect(client.refreshLiveNodes()).resolves.toEqual([
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
    expect(client.getLiveNodes().map((node) => node.host)).toEqual([
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

    await client.refreshLiveNodes();

    expect(client.getLiveNodes().map((node) => node.host)).toEqual([
      "dc1-a.internal",
      "dc1-b.internal",
      "dc2-a.internal",
      "dc2-b.internal",
    ]);
    await client.refreshLiveNodes();

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
      routing: routing.rack("dc1", "rack1", {
        fallback: routing.datacenter("dc1", {
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.refreshLiveNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      missingRackQuery,
      { dc: "dc1", rack: "rack1" },
      { dc: "dc1" },
    ]);
    expect(client.getLiveNodes().map((node) => node.host)).toEqual(["dc-node"]);
  });

  it("detects rack/datacenter query support", async () => {
    const supported = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler((request) => (request.query.dc || request.query.rack ? [] : ["seed"])),
      discovery: { background: false },
    });
    await expect(supported.checkRackDatacenterSupport()).resolves.toBe(true);

    const unsupported = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => ["seed"]),
      discovery: { background: false },
    });
    await expect(unsupported.checkRackDatacenterSupport()).resolves.toBe(false);
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
      routing: routing.rack("dc1", "rack1", {
        fallback: routing.datacenter("dc1", {
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.refreshLiveNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      {},
    ]);
    expect(client.getLiveNodes().map((node) => node.host)).toEqual(["cluster-node"]);
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
      routing: routing.rack("dc1", "rack1", {
        fallback: routing.datacenter("dc1", {
          fallback: routing.cluster(),
        }),
      }),
    });

    await client.refreshLiveNodes();

    expect(seenQueries).toEqual([
      missingDatacenterQuery,
      missingRackQuery,
      { dc: "dc1" },
    ]);
    expect(client.getLiveNodes().map((node) => node.host)).toEqual(["dc-node"]);
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
      routing: routing.datacenter("dc1"),
    });
    await expect(valid.checkIfRackAndDatacenterSetCorrectly()).resolves.toBeUndefined();

    const invalid = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => []),
      discovery: { background: false },
      routing: routing.rack("dc1", "rack1", {
        fallback: routing.datacenter("dc1"),
      }),
    });
    await expect(invalid.validateRackDatacenterConfig()).rejects.toThrow(/has no nodes/);
  });

  it("rejects rack/datacenter validation when scope filters are unsupported", async () => {
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: new RecordingHandler(() => ["seed"]),
      discovery: { background: false },
      routing: routing.datacenter("dc1", {
        fallback: routing.cluster(),
      }),
    });

    await expect(client.validateRackDatacenterConfig()).rejects.toThrow(/does not support datacenter/);
  });

  it("uses request-triggered discovery in edge runtime", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["edge-node"];
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
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
});
