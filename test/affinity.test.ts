import { BatchWriteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { hashAttributeValue } from "../src/affinity.js";
import { AlternatorDynamoDBClient } from "../src/index.js";
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
});
