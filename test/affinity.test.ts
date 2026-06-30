import { BatchWriteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { hashAttributeValue, KeyRouteAffinityPlanner } from "../src/affinity.js";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { firstNodeWithSeed } from "../src/query-plan.js";
import type { AlternatorLogger, AlternatorNode } from "../src/types.js";
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
    const nodes = testNodes(["node-c", "node-b", "node-a"]);
    const left = nodeByHost(nodes, "node-a");
    const right = nodeByHost(nodes, "node-b");
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
    expect(takeHosts(plan!, nodes.length)).toEqual(["node-a", "node-b", "node-c"]);
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

function keyRouteAffinityPlanner(partitionKeys: Record<string, string>): KeyRouteAffinityPlanner {
  const logger: AlternatorLogger = {};
  return new KeyRouteAffinityPlanner(
    {
      enabled: true,
      mode: "any-write",
      partitionKeys: new Map(Object.entries(partitionKeys)),
      autoDiscoverPartitionKeys: false,
    },
    () => undefined,
    logger,
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
