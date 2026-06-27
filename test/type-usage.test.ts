import {
  ListTablesCommand,
  type ListTablesCommandOutput,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expectTypeOf, it } from "vitest";
import {
  AlternatorDynamoDBClient,
  ResponseCompressionDeflate,
  ResponseCompressionGzip,
  routing,
} from "../src/index.js";
import { AlternatorDynamoDBDocumentClient } from "../src/document.js";
import { RecordingHandler } from "./helpers.js";

describe("public type usage", () => {
  it("accepts native AWS SDK v3 commands", () => {
    const client = new AlternatorDynamoDBClient({
      seeds: ["localhost"],
      routing: routing.rack("dc1", "rack1", {
        fallback: routing.cluster(),
      }),
      requestHandler: new RecordingHandler(),
      discovery: { background: false },
      logger: console,
      headerOptimization: {
        enabled: true,
        allowedHeaders: ["Host", "X-Amz-Target"],
      },
      compression: {
        enabled: true,
        gzipLevel: -1,
      },
      responseCompression: {
        enabled: true,
        encodings: [ResponseCompressionGzip, ResponseCompressionDeflate],
      },
      userAgent: (userAgent) => `${userAgent} app/1.0.0`,
      keyRouteAffinity: {
        type: "read-before-write",
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

  it("accepts document commands without requiring DynamoDBDocumentClient.from", () => {
    const docClient = new AlternatorDynamoDBDocumentClient(
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
