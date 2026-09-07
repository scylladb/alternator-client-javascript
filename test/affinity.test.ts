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

import { BatchWriteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { hashAttributeValue, KeyRouteAffinityPlanner } from "../src/affinity.js";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { firstNodeWithSeed } from "../src/query-plan.js";
import type { AlternatorKeyRouteAffinityMode, AlternatorLogger, AlternatorNode } from "../src/types.js";
import { commandRequests, RecordingHandler } from "./helpers.js";

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
