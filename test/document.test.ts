import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { AlternatorDynamoDBClient } from "../src/client.js";
import { AlternatorDynamoDBDocumentClient } from "../src/document.js";
import { commandRequests, RecordingHandler, requestBodyJson } from "./helpers.js";

describe("AlternatorDynamoDBDocumentClient", () => {
  it("constructs an Alternator low-level client and marshals document commands", async () => {
    const handler = new RecordingHandler(() => ({}));
    const docClient = AlternatorDynamoDBDocumentClient.fromConfig(
      {
        seeds: ["seed"],
        requestHandler: handler,
        discovery: { background: false },
      },
      {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      },
    );

    await docClient.send(
      new PutCommand({
        TableName: "users",
        Item: {
          id: "u1",
          name: "Ada",
          skipped: undefined,
        },
      }),
    );

    const request = commandRequests(handler)[0];
    const body = (await requestBodyJson(request!)) as {
      Item: Record<string, unknown>;
    };
    expect(body.Item).toEqual({
      id: { S: "u1" },
      name: { S: "Ada" },
    });
  });

  it("wraps Alternator clients without losing load balancing", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b"];
      }
      return {};
    });
    const base = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
    });
    await base.alternator.refreshNodes();

    const docClient = AlternatorDynamoDBDocumentClient.from(base);
    await docClient.send(new PutCommand({ TableName: "users", Item: { id: "u1" } }));
    await docClient.send(new PutCommand({ TableName: "users", Item: { id: "u2" } }));

    const [first, second] = commandRequests(handler);
    expect(["node-a", "node-b"]).toContain(first?.hostname);
    expect(["node-a", "node-b"]).toContain(second?.hostname);
  });

  it("wraps normal DynamoDB clients without adding load balancing", async () => {
    const handler = new RecordingHandler(() => ({}));
    const base = new DynamoDBClient({
      endpoint: "http://aws-style.local:8000",
      region: "us-east-1",
      credentials: {
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      requestHandler: handler,
    });

    const docClient = AlternatorDynamoDBDocumentClient.from(base);
    await docClient.send(new PutCommand({ TableName: "users", Item: { id: "u1" } }));

    expect(commandRequests(handler)[0]?.hostname).toBe("aws-style.local");
    expect("alternator" in docClient).toBe(false);
  });

  it("destroys the owned low-level client and stops background discovery", async () => {
    vi.useFakeTimers();
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["seed"];
      }
      return {};
    });
    const docClient = AlternatorDynamoDBDocumentClient.fromConfig({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: {
        background: true,
        refreshIntervalMs: 10,
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(25);
      const callsBeforeDestroy = handler.requests.filter((request) => request.path === "/localnodes").length;
      expect(callsBeforeDestroy).toBeGreaterThan(0);

      docClient.destroy();
      expect(handler.destroyCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(25);
      const callsAfterDestroy = handler.requests.filter((request) => request.path === "/localnodes").length;
      expect(callsAfterDestroy).toBe(callsBeforeDestroy);
    } finally {
      docClient.destroy();
      vi.useRealTimers();
    }
  });
});
