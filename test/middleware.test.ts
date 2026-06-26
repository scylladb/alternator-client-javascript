import { ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { alternatorUserAgentToken } from "../src/user-agent.js";
import { commandRequests, jsonResponse, RecordingHandler } from "./helpers.js";

describe("Alternator middleware", () => {
  it("rewrites each command request to live nodes and strips auth in no-auth mode", async () => {
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b"];
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
    });

    await client.refreshLiveNodes();
    await client.send(new ListTablesCommand({}));
    await client.send(new ListTablesCommand({}));

    const [first, second] = commandRequests(handler);
    expect(["node-a", "node-b"]).toContain(first?.hostname);
    expect(["node-a", "node-b"]).toContain(second?.hostname);
    expect(first?.headers.authorization).toBeUndefined();
    expect(first?.headers["x-amz-date"]).toBeUndefined();
    expect(first?.headers.host).toBe(`${first?.hostname}:8080`);
    expect(first?.headers.connection).toBe("keep-alive");
  });

  it("uses the next query-plan node on retry", async () => {
    let commandAttempts = 0;
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b"];
      }
      commandAttempts += 1;
      if (commandAttempts === 1) {
        return jsonResponse({ __type: "InternalServerError", message: "retry" }, 500);
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      maxAttempts: 2,
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      await client.refreshLiveNodes();
      await client.send(new ListTablesCommand({}));
    } finally {
      vi.restoreAllMocks();
    }

    const [first, second] = commandRequests(handler);
    expect(first?.hostname).toBe("node-a");
    expect(second?.hostname).toBe("node-b");
  });

  it("continues retrying when maxAttempts exceeds the live node count", async () => {
    let commandAttempts = 0;
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a"];
      }
      commandAttempts += 1;
      if (commandAttempts < 3) {
        return jsonResponse({ __type: "InternalServerError", message: "retry" }, 500);
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      maxAttempts: 3,
    });

    await client.refreshLiveNodes();
    await client.send(new ListTablesCommand({}));

    expect(commandAttempts).toBe(3);
    expect(commandRequests(handler).map((request) => request.hostname)).toEqual([
      "node-a",
      "node-a",
      "node-a",
    ]);
  });

  it("keeps SigV4 signing when credentials are provided", async () => {
    const handler = new RecordingHandler(() => ({ TableNames: [] }));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      credentials: {
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      region: "us-west-2",
    });

    await client.send(new ListTablesCommand({}));
    const request = commandRequests(handler)[0];
    expect(request?.headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(request?.headers.authorization).toContain("Credential=key/");
  });

  it("uses the Go-compatible optimized header whitelist with credentials", async () => {
    const handler = new RecordingHandler(() => ({ TableNames: [] }));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      credentials: {
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      headerOptimization: true,
    });

    await client.send(new ListTablesCommand({}));

    const headers = commandRequests(handler)[0]?.headers ?? {};
    expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
    expect(headers["x-amz-date"]).toBeDefined();
    expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.ListTables");
    expect(headers["content-length"]).toBeDefined();
    expect(headers.host).toBe("seed:8080");
    expect(headers["user-agent"]).toBe(alternatorUserAgentToken());
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-amz-content-sha256"]).toBeUndefined();
    expect(headers["x-amz-user-agent"]).toBeUndefined();
    expect(headers["amz-sdk-invocation-id"]).toBeUndefined();
    expect(headers["amz-sdk-request"]).toBeUndefined();
    expect(signedHeaderNames(headers.authorization)).toEqual([
      "content-length",
      "host",
      "x-amz-date",
      "x-amz-target",
    ]);
  });

  it("compresses JSON request bodies when enabled", async () => {
    const handler = new RecordingHandler(() => ({}));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      compression: true,
    });

    await client.send(
      new PutItemCommand({
        TableName: "users",
        Item: {
          id: { S: "u1" },
        },
      }),
    );

    const request = commandRequests(handler)[0];
    expect(request?.headers["content-encoding"]).toBe("gzip");
    expect(request?.body).toBeInstanceOf(Uint8Array);
    const json = JSON.parse(gunzipSync(request?.body as Uint8Array).toString("utf8")) as {
      TableName: string;
    };
    expect(json.TableName).toBe("users");
  });

  it("uses header whitelisting when enabled", async () => {
    const handler = new RecordingHandler(() => ({ TableNames: [] }));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      headerOptimization: true,
    });

    await client.send(new ListTablesCommand({}));

    const headers = commandRequests(handler)[0]?.headers ?? {};
    expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.ListTables");
    expect(headers.host).toBe("seed:8080");
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-amz-date"]).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
    expect(headers.connection).toBeUndefined();
  });

  it("replaces the SDK User-Agent with the Alternator client identity by default", async () => {
    const handler = new RecordingHandler(() => ({ TableNames: [] }));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      customUserAgent: "app/1",
    });

    await client.send(new ListTablesCommand({}));

    const headers = commandRequests(handler)[0]?.headers ?? {};
    expect(headers["user-agent"]).toBe(alternatorUserAgentToken());
    expect(headers["user-agent"]).not.toContain("app/1");
    expect(headers["x-amz-user-agent"]).toBeUndefined();
  });

  it("supports replacing, transforming, and removing the Alternator User-Agent", async () => {
    const replacements = new RecordingHandler(() => ({ TableNames: [] }));
    const transformed = new RecordingHandler(() => ({ TableNames: [] }));
    const removed = new RecordingHandler(() => ({ TableNames: [] }));

    const replacementClient = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: replacements,
      discovery: { background: false },
      userAgent: "custom-client/1.2.3",
    });
    const transformedClient = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: transformed,
      discovery: { background: false },
      userAgent: (userAgent) => `${userAgent} app/4.5.6`,
    });
    const removedClient = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: removed,
      discovery: { background: false },
      userAgent: false,
    });

    await replacementClient.send(new ListTablesCommand({}));
    await transformedClient.send(new ListTablesCommand({}));
    await removedClient.send(new ListTablesCommand({}));

    expect(commandRequests(replacements)[0]?.headers["user-agent"]).toBe("custom-client/1.2.3");
    expect(commandRequests(transformed)[0]?.headers["user-agent"]).toBe(
      `${alternatorUserAgentToken()} app/4.5.6`,
    );
    expect(commandRequests(removed)[0]?.headers["user-agent"]).toBeUndefined();
    expect(commandRequests(removed)[0]?.headers["x-amz-user-agent"]).toBeUndefined();
  });

  it("keeps the generated User-Agent when header optimization is enabled", async () => {
    const handler = new RecordingHandler(() => ({ TableNames: [] }));
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      headerOptimization: true,
    });

    await client.send(new ListTablesCommand({}));

    const headers = commandRequests(handler)[0]?.headers ?? {};
    expect(headers["user-agent"]).toBe(alternatorUserAgentToken());
    expect(headers["content-type"]).toBeUndefined();
  });

  it("routes matching keys to the same node when key affinity is enabled", async () => {
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
        type: "any-write",
        partitionKeys: {
          users: "id",
        },
      },
    });

    await client.refreshLiveNodes();
    await client.send(
      new PutItemCommand({
        TableName: "users",
        Item: { id: { S: "same" } },
      }),
    );
    await client.send(
      new PutItemCommand({
        TableName: "users",
        Item: { id: { S: "same" } },
      }),
    );

    const [first, second] = commandRequests(handler);
    expect(first?.hostname).toBe(second?.hostname);
    expect(client.getPartitionKeyName("users")).toBe("id");
  });
});

function signedHeaderNames(authorization: string | undefined): string[] {
  const match = authorization?.match(/(?:^|,\s*)SignedHeaders=([^,\s]+)/);
  return match?.[1]?.split(";").filter(Boolean) ?? [];
}
