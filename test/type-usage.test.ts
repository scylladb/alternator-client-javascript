import {
  ListTablesCommand,
  type ListTablesCommandOutput,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expectTypeOf, it } from "vitest";
import {
  AlternatorDynamoDBClient,
  routing,
} from "../src/index.js";
import { AlternatorDynamoDBDocumentClient } from "../src/document.js";
import { RecordingHandler } from "./helpers.js";

describe("public type usage", () => {
  it("accepts native AWS SDK v3 commands", () => {
    const client = new AlternatorDynamoDBClient({
      seeds: ["localhost"],
      routing: routing.rack({
        datacenter: "dc1",
        rack: "rack1",
        fallback: routing.cluster(),
      }),
      requestHandler: new RecordingHandler(),
      discovery: { background: false },
      logger: console,
      headerOptimization: {
        allowedHeaders: ["Host", "X-Amz-Target"],
      },
      compression: {
        request: {
          gzipLevel: -1,
        },
        response: {
          algorithms: ["gzip", "deflate"],
        },
      },
      userAgent: { append: "app/1.0.0" },
      keyRouteAffinity: {
        mode: "read-before-write",
        partitionKeys: {
          users: "id",
        },
      },
    });

    expectTypeOf(client.send(new ListTablesCommand({}))).resolves.toMatchTypeOf<ListTablesCommandOutput>();
    expectTypeOf(
      client.send(
        new PutItemCommand({
          TableName: "users",
          Item: { id: { S: "u1" } },
        }),
      ),
    ).resolves.toMatchTypeOf<object>();
  });

  it("accepts document commands from an Alternator config factory", () => {
    const docClient = AlternatorDynamoDBDocumentClient.fromConfig(
      {
        seeds: ["localhost"],
        requestHandler: new RecordingHandler(),
        discovery: { background: false },
      },
      { marshallOptions: { removeUndefinedValues: true } },
    );

    expectTypeOf(
      docClient.send(
        new PutCommand({
          TableName: "users",
          Item: { id: "u1", name: "Ada" },
        }),
      ),
    ).resolves.toMatchTypeOf<object>();
  });
});
