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

import { BatchWriteItemCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { hashAttributeValue, KeyRouteAffinityPlanner } from "../src/affinity.js";
import { AlternatorDynamoDBClient, routing } from "../src/index.js";
import { firstNodeWithSeed } from "../src/query-plan.js";
import type { AlternatorKeyRouteAffinityMode, AlternatorLogger, AlternatorNode } from "../src/types.js";
import { commandRequests, jsonResponse, RecordingHandler } from "./helpers.js";

const missingDatacenter = "__alternator_client_missing_dc__";
const missingRack = "__alternator_client_missing_rack__";

describe("key route affinity", () => {
  it("matches AttributeValue hash vectors", () => {
    expect(hashAttributeValue({ S: "hello" })).toBe(8815023923555918238n);
    expect(hashAttributeValue({ S: "" })).toBe(8849112093580131862n);
    expect(hashAttributeValue({ S: "user_123" })).toBe(-4025731529809423594n);
    expect(hashAttributeValue({ N: "42" })).toBe(-5061732451827723051n);
    expect(hashAttributeValue({ B: new Uint8Array([0x01, 0x02, 0x03]) })).toBe(5026299041734804437n);
  });

  it("routes read-before-write operations only in RMW mode", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b", "node-c"];
      }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      keyRouteAffinity: {
        mode: "read-before-write",
        partitionKeys: { users: "id" },
      },
    });

    await client.alternator.refreshNodes();
    await client.send(
      new PutItemCommand({
        TableName: "users",
        Item: { id: { S: "same" } },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    await client.send(
      new PutItemCommand({
        TableName: "users",
        Item: { id: { S: "same" } },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );

    const [first, second] = commandRequests(handler);
    expect(first?.hostname).toBe(second?.hostname);
  });

  it("keeps cluster affinity immediate across incomplete discovery", async () => {
    const seedNodes = testNodes(["seed-a", "seed-b"], 8080);
    const initialTarget = nodeByHost(seedNodes, "seed-b");
    const initialKey = partitionKeyValuesForNode(seedNodes, initialTarget, "initial", 1)[0]!;
    const partialHosts = ["node-a", "node-b"];
    const partialNodes = testNodes(partialHosts, 8080);
    const partialTarget = nodeByHost(partialNodes, "node-b");
    const partialKey = partitionKeyValuesForNode(partialNodes, partialTarget, "partial", 1)[0]!;
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") {
        return {};
      }
      if (request.hostname === "seed-a") {
        return partialHosts;
      }
      throw new Error("seed-b unavailable");
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed-a", "seed-b"],
      requestHandler: handler,
      discovery: { background: false },
      routing: routing.cluster(),
      keyRouteAffinity: {
        mode: "read-before-write",
        partitionKeys: { users: "id" },
      },
      maxAttempts: 1,
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      await client.send(
        new PutItemCommand({
          TableName: "users",
          Item: { id: { S: initialKey } },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
      expect(handler.requests.filter((request) => request.path === "/localnodes")).toHaveLength(0);

      await expect(client.alternator.refreshNodes()).resolves.toEqual(
        partialNodes,
      );
      await client.send(
        new PutItemCommand({
          TableName: "users",
          Item: { id: { S: partialKey } },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );

      expect(commandRequests(handler).map((request) => request.hostname)).toEqual([
        "seed-b",
        "node-b",
      ]);
      expect(
        handler.requests
          .filter((request) => request.path === "/localnodes")
          .map((request) => request.hostname),
      ).toEqual(["seed-a", "seed-b"]);
    } finally {
      client.destroy();
      vi.restoreAllMocks();
    }
  });

  it("routes immediately through seeds while discovery is hanging with a zero timeout", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    let signal: { readonly aborted: boolean } | undefined;
    const handler = new RecordingHandler((request, options) => {
      if (request.path === "/localnodes") {
        signal = options?.abortSignal;
        requestStarted();
        return new Promise(() => undefined);
      }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["rack-seed"], requestHandler: handler,
      discovery: { background: false, timeoutMs: 0 },
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }),
      keyRouteAffinity: { mode: "read-before-write", partitionKeys: { users: "id" } },
    });
    const refresh = client.alternator.refreshNodes();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error("Seed routing waited for discovery")), 1_000);
    });
    try {
      await Promise.race([started, deadline]);
      await Promise.race([client.send(new PutItemCommand({
        TableName: "users", Item: { id: { S: "same" } },
        ConditionExpression: "attribute_not_exists(id)",
      })), deadline]);
      expect(commandRequests(handler).map((request) => request.hostname)).toEqual(["rack-seed"]);
      expect(signal?.aborted).toBe(false);
    } finally {
      clearTimeout(deadlineTimer);
      client.destroy();
      await refresh;
    }
  });

  it("uses the same named-DC affinity ring across racks after discovery", async () => {
    const dcHosts = ["rack-a-node", "rack-b-node", "rack-c-node"];
    const dcNodes = testNodes(dcHosts, 8080);
    const key = partitionKeyValuesForNode(dcNodes, nodeByHost(dcNodes, "rack-c-node"), "shared", 1)[0]!;
    const clients = ["a", "b"].map((rack) => {
      const handler = new RecordingHandler((request) => {
        if (request.path !== "/localnodes") { return {}; }
        if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
        if (request.query.dc === "dc1") {
          return request.query.rack ? [`rack-${rack}-node`] : dcHosts;
        }
        return ["other-dc-node"];
      });
      const client = new AlternatorDynamoDBClient({
        seeds: [`rack-${rack}-seed`], requestHandler: handler,
        discovery: { background: false },
        routing: routing.rack({ datacenter: "dc1", rack: `rack-${rack}` }),
        keyRouteAffinity: { mode: "read-before-write", partitionKeys: { users: "id" } },
      });
      return { client, handler, rack };
    });
    try {
      for (const { client, handler, rack } of clients) {
        await client.alternator.refreshNodes();
        await client.send(new PutItemCommand({
          TableName: "users", Item: { id: { S: key } },
          ConditionExpression: "attribute_not_exists(id)",
        }));
        await client.send(new PutItemCommand({ TableName: "users", Item: { id: { S: key } } }));
        await client.send(new GetItemCommand({ TableName: "users", Key: { id: { S: key } } }));
        await client.send(new PutItemCommand({
          TableName: "users", Item: { other: { S: key } }, ConditionExpression: "attribute_not_exists(id)",
        }));
        expect(commandRequests(handler).map((request) => request.hostname)).toEqual([
          "rack-c-node", `rack-${rack}-node`, `rack-${rack}-node`, `rack-${rack}-node`,
        ]);
        expect(handler.requests.filter((request) => request.path === "/localnodes")
          .every((request) => Object.keys(request.query).length > 0)).toBe(true);
      }
    } finally { clients.forEach(({ client }) => client.destroy()); }
  });

  it("preserves every explicit DC fallback, preference, and recovery", async () => {
    let phase: "preferred" | "secondary" | "cluster" = "preferred";
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
      // Ordinary routing falls through both empty racks to cluster; affinity tries DC A, then B.
      if (request.query.rack) { return []; }
      if (request.query.dc === "A") { return phase === "preferred" ? ["preferred-node"] : []; }
      if (request.query.dc === "B") { return phase !== "cluster" ? ["secondary-node"] : []; }
      return ["cluster-node"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "A", rack: "missing", fallback: routing.rack({
        datacenter: "B", rack: "missing", fallback: routing.cluster(),
      }) }),
      keyRouteAffinity: { mode: "read-before-write", partitionKeys: { users: "id" } },
    });
    const send = () => client.send(new PutItemCommand({
      TableName: "users", Item: { id: { S: "same" } }, ConditionExpression: "attribute_not_exists(id)",
    }));
    try {
      for (const value of ["preferred", "secondary", "cluster", "preferred"] as const) {
        phase = value;
        handler.requests.length = 0;
        await client.alternator.refreshNodes();
        const affinityQueries = handler.requests.filter((request) => request.path === "/localnodes" &&
          request.query.rack === undefined && request.query.dc !== missingDatacenter).map((request) => request.query.dc);
        // A usable earlier DC must win even after ordinary routing selected cluster.
        if (phase === "preferred") { expect(affinityQueries).toEqual([undefined, "A"]); }
        if (phase === "secondary") {
          expect(affinityQueries).toContain("A");
          expect(affinityQueries.indexOf("A")).toBeLessThan(affinityQueries.indexOf("B"));
        }
        await send();
        expect(commandRequests(handler).at(-1)?.hostname).toBe(`${value === "preferred" ? "preferred" : value === "secondary" ? "secondary" : "cluster"}-node`);
      }
    } finally { client.destroy(); }
  });

  it("checks the preferred widened DC before reusing an ordinary later DC fallback", async () => {
    let preferredAvailable = true;
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack || request.query.rack) { return []; }
      return request.query.dc === "A" ? (preferredAvailable ? ["preferred"] : []) : ["fallback"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "A", rack: "missing", fallback: routing.datacenter({ datacenter: "B" }) }),
      keyRouteAffinity: { mode: "read-before-write", partitionKeys: { users: "id" } },
    });
    try {
      for (const available of [true, false]) {
        preferredAvailable = available;
        handler.requests.length = 0;
        await client.alternator.refreshNodes();
        expect(client.alternator.nodes().map((node) => node.host)).toEqual(["fallback"]);
        await client.send(new PutItemCommand({
          TableName: "users", Item: { id: { S: "same" } }, ConditionExpression: "attribute_not_exists(id)",
        }));
        expect(commandRequests(handler).at(-1)?.hostname).toBe(available ? "preferred" : "fallback");
        expect(handler.requests.filter((request) => request.path === "/localnodes" && request.query.dc === "B")).toHaveLength(1);
      }
    } finally { client.destroy(); }
  });

  it("keeps a successful affinity snapshot through empty and failed refreshes, then recovers", async () => {
    let phase: "empty" | "failed" | "ready" | "recovered" = "empty";
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
      if (request.query.rack) { return ["rack-local"]; }
      if (request.query.dc === "dc1") {
        if (phase === "failed") { throw new Error("DC discovery unavailable"); }
        return phase === "empty" ? [] : [phase === "ready" ? "dc-ready" : "dc-recovered"];
      }
      throw new Error("implicit cluster discovery is forbidden");
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }),
      keyRouteAffinity: { mode: "read-before-write", partitionKeys: { users: "id" } },
    });
    try {
      for (const [value, expected] of [["empty", "rack-local"], ["failed", "rack-local"],
        ["ready", "dc-ready"], ["empty", "dc-ready"], ["failed", "dc-ready"],
        ["recovered", "dc-recovered"]] as const) {
        phase = value;
        await client.alternator.refreshNodes();
        await client.send(new PutItemCommand({
          TableName: "users", Item: { id: { S: "same" } }, ConditionExpression: "attribute_not_exists(id)",
        }));
        expect(commandRequests(handler).at(-1)?.hostname).toBe(expected);
      }
      expect(handler.requests.filter((request) => request.path === "/localnodes")
        .every((request) => Object.keys(request.query).length > 0)).toBe(true);
    } finally { client.destroy(); }
  });

  it.each([
    { name: "disabled affinity", enabled: false, scope: routing.rack({ datacenter: "dc1", rack: "rack-a" }), query: { dc: "dc1", rack: "rack-a" } },
    { name: "DC without rack restrictions", enabled: true, scope: routing.datacenter({ datacenter: "dc1" }), query: { dc: "dc1" } },
    { name: "selected DC before a rack fallback", enabled: true, scope: routing.datacenter({ datacenter: "dc1", fallback: routing.rack({ datacenter: "dc2", rack: "rack-b" }) }), query: { dc: "dc1" } },
  ])("avoids auxiliary discovery for $name", async ({ enabled, scope, query }) => {
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
      return ["local-node"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false }, routing: scope,
      keyRouteAffinity: enabled ? { mode: "read-before-write", partitionKeys: { users: "id" } } : false,
    });
    try {
      await client.alternator.refreshNodes();
      expect(handler.requests.filter((request) => request.path === "/localnodes" &&
        request.query.dc !== missingDatacenter && request.query.rack !== missingRack)
        .map((request) => request.query)).toEqual([query]);
    } finally { client.destroy(); }
  });

  it("uses discovered DC membership for batch voting and single-item retries", async () => {
    const hosts = ["rack-local", "rack-other"];
    const nodes = testNodes(hosts, 8080);
    const key = partitionKeyValuesForNode(nodes, nodeByHost(nodes, "rack-other"), "votes", 1)[0]!;
    let failNext = false;
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
        return request.query.rack ? ["rack-local"] : hosts;
      }
      if (failNext) { failNext = false; return jsonResponse({ __type: "InternalServerError", message: "retry" }, 500); }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }), maxAttempts: 2,
      keyRouteAffinity: { mode: "any-write", partitionKeys: { users: "id" } },
    });
    try {
      await client.alternator.refreshNodes();
      await client.send(new BatchWriteItemCommand({ RequestItems: { users: [
        { PutRequest: { Item: { id: { S: key } } } },
        { DeleteRequest: { Key: { id: { S: key } } } },
      ] } }));
      failNext = true;
      await client.send(new PutItemCommand({ TableName: "users", Item: { id: { S: key } } }));
      expect(commandRequests(handler).map((request) => request.hostname)).toEqual(["rack-other", "rack-other", "rack-local"]);
    } finally { client.destroy(); }
  });

  it("deduplicates widened operations and reuses empty ordinary results within each refresh", async () => {
    let rackAvailable = true;
    let preferredAvailable = false;
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
      if (request.query.rack) { return rackAvailable ? ["seed"] : []; }
      if (request.query.dc === "A") { return preferredAvailable ? ["preferred"] : []; }
      return ["seed"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "A", rack: "r1", fallback: routing.rack({
        datacenter: "A", rack: "r1", fallback: routing.datacenter({
          datacenter: "A", fallback: routing.datacenter({ datacenter: "B" }),
        }),
      }) }),
      keyRouteAffinity: { mode: "any-write", partitionKeys: { users: "id" } },
    });
    try {
      for (const [rack, preferred] of [[true, false], [false, false], [false, true]] as const) {
        rackAvailable = rack;
        preferredAvailable = preferred;
        handler.requests.length = 0;
        await client.alternator.refreshNodes();
        const dcQueries = handler.requests.filter((request) => request.path === "/localnodes" &&
          request.query.rack === undefined && request.query.dc !== missingDatacenter)
          .map((request) => request.query.dc);
        expect(dcQueries).toEqual(preferred ? ["A"] : ["A", "B"]);
        await client.send(new PutItemCommand({ TableName: "users", Item: { id: { S: "same" } } }));
        expect(commandRequests(handler).at(-1)?.hostname).toBe(preferred ? "preferred" : "seed");
      }
    } finally { client.destroy(); }
  });

  it("retains both snapshots without an auxiliary pass when ordinary discovery exhausts", async () => {
    let phase: "ready" | "empty" | "failed" = "ready";
    const handler = new RecordingHandler((request) => {
      if (request.path !== "/localnodes") { return {}; }
      if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
      if (request.query.rack) {
        if (phase === "failed") { throw new Error("ordinary discovery unavailable"); }
        return phase === "empty" ? [] : ["rack-local"];
      }
      return phase === "ready" ? ["dc-ready"] : ["unexpected-new"];
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false },
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }),
      keyRouteAffinity: { mode: "any-write", partitionKeys: { users: "id" } },
    });
    try {
      await client.alternator.refreshNodes();
      for (const value of ["empty", "failed"] as const) {
        phase = value;
        handler.requests.length = 0;
        await client.alternator.refreshNodes();
        expect(client.alternator.nodes().map((node) => node.host)).toEqual(["rack-local"]);
        expect(handler.requests.filter((request) => request.query.dc === "dc1" &&
          request.query.rack === undefined)).toHaveLength(0);
        await client.send(new PutItemCommand({ TableName: "users", Item: { id: { S: "same" } } }));
        expect(commandRequests(handler).at(-1)?.hostname).toBe("dc-ready");
      }
    } finally { client.destroy(); }
  });

  it.each(["single", "batch"] as const)("keeps captured %s affinity order after topology changes and plan exhaustion", async (kind) => {
    const oldHosts = ["old-a", "old-b"];
    const oldNodes = testNodes(oldHosts, 8080);
    const key = partitionKeyValuesForNode(oldNodes, nodeByHost(oldNodes, "old-b"), "capture", 1)[0]!;
    let changed = false;
    let attempts = 0;
    const handler = new RecordingHandler(async (request) => {
      if (request.path === "/localnodes") {
        if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
        return request.query.rack ? [changed ? "new-a" : "old-a"] : changed ? ["new-a", "new-b"] : oldHosts;
      }
      attempts += 1;
      if (attempts === 1) {
        changed = true;
        await client.alternator.refreshNodes();
      }
      return attempts <= 2 ? jsonResponse({ __type: "InternalServerError", message: "retry" }, 500) : {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false }, maxAttempts: 3,
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }),
      keyRouteAffinity: { mode: "any-write", partitionKeys: { users: "id" } },
    });
    const send = () => kind === "single"
      ? client.send(new PutItemCommand({ TableName: "users", Item: { id: { S: key } } }))
      : client.send(new BatchWriteItemCommand({ RequestItems: { users: [
        { PutRequest: { Item: { id: { S: key } } } },
      ] } }));
    try {
      await client.alternator.refreshNodes();
      await send();
      expect(commandRequests(handler).map((request) => request.hostname)).toEqual(["old-b", "old-a", "old-b"]);
      await send();
      expect(["new-a", "new-b"]).toContain(commandRequests(handler).at(-1)?.hostname);
    } finally { client.destroy(); }
  });

  it("keeps ordinary retry exhaustion on the updated ordinary membership", async () => {
    let changed = false;
    let attempts = 0;
    const handler = new RecordingHandler(async (request) => {
      if (request.path === "/localnodes") {
        if (request.query.dc === missingDatacenter || request.query.rack === missingRack) { return []; }
        return [changed ? "new-local" : "old-local"];
      }
      attempts += 1;
      if (attempts === 1) {
        changed = true;
        await client.alternator.refreshNodes();
        return jsonResponse({ __type: "InternalServerError", message: "retry" }, 500);
      }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"], requestHandler: handler, discovery: { background: false }, maxAttempts: 2,
      routing: routing.rack({ datacenter: "dc1", rack: "rack-a" }),
      keyRouteAffinity: { mode: "any-write", partitionKeys: { users: "id" } },
    });
    try {
      await client.alternator.refreshNodes();
      await client.send(new GetItemCommand({ TableName: "users", Key: { id: { S: "same" } } }));
      expect(commandRequests(handler).map((request) => request.hostname)).toEqual(["old-local", "new-local"]);
    } finally { client.destroy(); }
  });

  it("uses BatchWrite voting to pick a preferred node", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b", "node-c"];
      }
      return {};
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      keyRouteAffinity: {
        mode: "any-write",
        partitionKeys: { users: "id" },
      },
    });

    await client.alternator.refreshNodes();
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          users: [
            { PutRequest: { Item: { id: { S: "a" } } } },
            { PutRequest: { Item: { id: { S: "a" } } } },
            { DeleteRequest: { Key: { id: { S: "a" } } } },
          ],
        },
      }),
    );

    expect(["node-a", "node-b", "node-c"]).toContain(commandRequests(handler)[0]?.hostname);
  });

  it("orders BatchWrite voted nodes before zero-vote nodes", () => {
    const nodes = testNodes(["node-c", "node-a", "node-b"]);
    const target = nodeByHost(nodes, "node-b");
    const other = nodeByHost(nodes, "node-c");
    const targetKeys = partitionKeyValuesForNode(nodes, target, "target", 2);
    const otherKey = partitionKeyValuesForNode(nodes, other, "other", 1)[0];
    const planner = keyRouteAffinityPlanner({ users: "id" });

    const plan = planner.queryPlanForInput(
      {
        RequestItems: {
          users: [
            { PutRequest: { Item: { id: { S: targetKeys[0] } } } },
            { DeleteRequest: { Key: { id: { S: otherKey } } } },
            { PutRequest: { Item: { id: { S: targetKeys[1] } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(plan).toBeDefined();
    expect(takeHosts(plan!, nodes.length)).toEqual(["node-b", "node-c", "node-a"]);
  });

  it("uses node URL order for tied BatchWrite votes", () => {
    const nodes = testNodes(["node-a", "[::1]", "10.0.0.1"]);
    const left = nodeByHost(nodes, "10.0.0.1");
    const right = nodeByHost(nodes, "[::1]");
    const leftKey = partitionKeyValuesForNode(nodes, left, "left", 1)[0];
    const rightKey = partitionKeyValuesForNode(nodes, right, "right", 1)[0];
    const planner = keyRouteAffinityPlanner({ users: "id" });

    const plan = planner.queryPlanForInput(
      {
        RequestItems: {
          users: [
            { PutRequest: { Item: { id: { S: rightKey } } } },
            { DeleteRequest: { Key: { id: { S: leftKey } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(plan).toBeDefined();
    expect(takeHosts(plan!, nodes.length)).toEqual(["10.0.0.1", "[::1]", "node-a"]);
  });

  it("matches fixed cross-language BatchWrite partition-key vectors", () => {
    const nodes = crossLanguageNodes();
    const planner = keyRouteAffinityPlanner({ records: "id" });
    const vectors: Array<{ write: Record<string, unknown>; expectedHost: string }> = [
      {
        write: { PutRequest: { Item: { id: { S: "order123" } } } },
        expectedHost: "node8.example.com",
      },
      {
        write: { DeleteRequest: { Key: { id: { S: "same" } } } },
        expectedHost: "node1.example.com",
      },
      {
        write: { PutRequest: { Item: { id: { N: "42" } } } },
        expectedHost: "node2.example.com",
      },
      {
        write: { DeleteRequest: { Key: { id: { B: new Uint8Array([0x00, 0xff]) } } } },
        expectedHost: "node6.example.com",
      },
    ];

    for (const vector of vectors) {
      const plan = planner.queryPlanForInput(
        { RequestItems: { records: [vector.write] } },
        nodes,
        "BatchWriteItemCommand",
      );

      expect(plan?.next()?.host).toBe(vector.expectedHost);
    }
  });

  it("matches fixed cross-language strict-majority and tied retry orders", () => {
    const nodes = crossLanguageNodes();
    const planner = keyRouteAffinityPlanner({ audit: "id", orders: "id" });
    const majorityPlan = planner.queryPlanForInput(
      {
        RequestItems: {
          orders: [
            { PutRequest: { Item: { id: { S: "order123" } } } },
            { DeleteRequest: { Key: { id: { S: "same" } } } },
          ],
          audit: [{ PutRequest: { Item: { id: { S: "order123" } } } }],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );
    const tiedPlan = planner.queryPlanForInput(
      {
        RequestItems: {
          orders: [
            { PutRequest: { Item: { id: { S: "order123" } } } },
            { DeleteRequest: { Key: { id: { S: "same" } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(takeHosts(majorityPlan!, nodes.length)).toEqual([
      "node8.example.com",
      "node1.example.com",
      "node10.example.com",
      "node2.example.com",
      "node3.example.com",
      "node4.example.com",
      "node5.example.com",
      "node6.example.com",
      "node7.example.com",
      "node9.example.com",
    ]);
    expect(takeHosts(tiedPlan!, nodes.length)).toEqual([
      "node1.example.com",
      "node8.example.com",
      "node10.example.com",
      "node2.example.com",
      "node3.example.com",
      "node4.example.com",
      "node5.example.com",
      "node6.example.com",
      "node7.example.com",
      "node9.example.com",
    ]);
  });

  it("keeps BatchWrite routing stable across table order, write order, and payload changes", () => {
    const nodes = crossLanguageNodes();
    const planner = keyRouteAffinityPlanner({ audit: "id", orders: "id" });
    const firstPlan = planner.queryPlanForInput(
      {
        RequestItems: {
          orders: [
            { PutRequest: { Item: { id: { S: "order123" }, payload: { S: "old" } } } },
            { DeleteRequest: { Key: { id: { S: "same" } } } },
          ],
          audit: [
            { PutRequest: { Item: { id: { S: "hello" }, payload: { S: "first" } } } },
            { DeleteRequest: { Key: { id: { S: "user_123" } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );
    const reorderedPlan = planner.queryPlanForInput(
      {
        RequestItems: {
          audit: [
            { DeleteRequest: { Key: { id: { S: "user_123" } } } },
            { PutRequest: { Item: { payload: { S: "changed" }, id: { S: "hello" } } } },
          ],
          orders: [
            { DeleteRequest: { Key: { id: { S: "same" } } } },
            { PutRequest: { Item: { payload: { S: "new" }, id: { S: "order123" } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(takeHosts(firstPlan!, nodes.length)).toEqual(takeHosts(reorderedPlan!, nodes.length));
  });

  it("skips unusable writes without blocking valid candidates", () => {
    const nodes = crossLanguageNodes();
    const discoveredTables: string[] = [];
    const planner = keyRouteAffinityPlanner(
      { orders: "id" },
      {
        autoDiscoverPartitionKeys: true,
        discoverPartitionKey: (tableName) => {
          discoveredTables.push(tableName);
        },
      },
    );

    const plan = planner.queryPlanForInput(
      {
        RequestItems: {
          unknown: [{ PutRequest: { Item: { id: { S: "missing-metadata" } } } }],
          empty: [{ PutRequest: { Item: {} } }, { DeleteRequest: { Key: {} } }],
          orders: [
            {},
            {
              PutRequest: { Item: { id: { S: "malformed-put" } } },
              DeleteRequest: { Key: { id: { S: "malformed-delete" } } },
            },
            { PutRequest: { Item: { id: { BOOL: true } } } },
            { PutRequest: undefined, DeleteRequest: { Key: { id: { S: "same" } } } },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(plan?.next()?.host).toBe("node1.example.com");
    expect(discoveredTables).toEqual(["unknown"]);
  });

  it("falls back when BatchWrite has no usable votes or affinity mode is RMW", () => {
    const nodes = crossLanguageNodes();
    const planner = keyRouteAffinityPlanner({ orders: "id" });
    const unusableInputs = [
      { RequestItems: {} },
      { RequestItems: { orders: [{}] } },
      { RequestItems: { orders: [{ PutRequest: { Item: {} } }] } },
      { RequestItems: { orders: [{ PutRequest: { Item: { id: { BOOL: true } } } }] } },
    ];

    for (const input of unusableInputs) {
      expect(planner.queryPlanForInput(input, nodes, "BatchWriteItemCommand")).toBeUndefined();
    }

    const rmwPlanner = keyRouteAffinityPlanner(
      { orders: "id" },
      { mode: "read-before-write" },
    );
    expect(
      rmwPlanner.queryPlanForInput(
        { RequestItems: { orders: [{ PutRequest: { Item: { id: { S: "order123" } } } }] } },
        nodes,
        "BatchWriteItemCommand",
      ),
    ).toBeUndefined();
  });

  it("ignores malformed BatchWrite union writes", () => {
    const nodes = testNodes(["node-a", "node-b", "node-c"]);
    const valid = nodeByHost(nodes, "node-a");
    const invalid = nodeByHost(nodes, "node-b");
    const validKey = partitionKeyValuesForNode(nodes, valid, "valid", 1)[0];
    const invalidKeys = partitionKeyValuesForNode(nodes, invalid, "invalid", 2);
    const planner = keyRouteAffinityPlanner({ users: "id" });

    const plan = planner.queryPlanForInput(
      {
        RequestItems: {
          users: [
            { PutRequest: { Item: { id: { S: validKey } } } },
            {
              PutRequest: { Item: { id: { S: invalidKeys[0] } } },
              DeleteRequest: { Key: { id: { S: invalidKeys[1] } } },
            },
          ],
        },
      },
      nodes,
      "BatchWriteItemCommand",
    );

    expect(plan).toBeDefined();
    expect(plan!.next()?.host).toBe("node-a");
  });
});

function keyRouteAffinityPlanner(
  partitionKeys: Record<string, string>,
  options: {
    autoDiscoverPartitionKeys?: boolean;
    discoverPartitionKey?: (tableName: string) => void | Promise<void>;
    mode?: AlternatorKeyRouteAffinityMode;
  } = {},
): KeyRouteAffinityPlanner {
  const logger: AlternatorLogger = {};
  return new KeyRouteAffinityPlanner(
    {
      enabled: true,
      mode: options.mode ?? "any-write",
      partitionKeys: new Map(Object.entries(partitionKeys)),
      autoDiscoverPartitionKeys: options.autoDiscoverPartitionKeys ?? false,
    },
    options.discoverPartitionKey ?? (() => undefined),
    logger,
  );
}

function crossLanguageNodes(): AlternatorNode[] {
  return testNodes(
    Array.from({ length: 10 }, (_, index) => `node${index + 1}.example.com`),
    8043,
  );
}

function testNodes(hosts: readonly string[], port = 8000): AlternatorNode[] {
  return hosts.map((host) => ({
    host,
    scheme: "http",
    port,
    url: `http://${host}:${port}`,
  }));
}

function nodeByHost(nodes: readonly AlternatorNode[], host: string): AlternatorNode {
  const node = nodes.find((candidate) => candidate.host === host);
  if (!node) {
    throw new Error(`missing test node ${host}`);
  }
  return node;
}

function partitionKeyValuesForNode(
  nodes: readonly AlternatorNode[],
  target: AlternatorNode,
  prefix: string,
  count: number,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < 10_000 && values.length < count; index += 1) {
    const value = `${prefix}-${target.host}-${index}`;
    const node = firstNodeWithSeed(nodes, hashAttributeValue({ S: value }));
    if (node?.url === target.url) {
      values.push(value);
    }
  }

  expect(values).toHaveLength(count);
  return values;
}

function takeHosts(plan: { next(): AlternatorNode | undefined }, count: number): string[] {
  const hosts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const node = plan.next();
    if (!node) {
      break;
    }
    hosts.push(node.host);
  }
  return hosts;
}
