import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { describeIntegration, integrationEndpoints } from "./config.js";
import {
  buildClient,
  captureCommandRequests,
  createStringHashTable,
  safeDeleteTable,
  uniqueTableName,
  waitFor,
} from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "key route affinity autodiscovery integration ($name)",
  (endpoint) => {
    it("discovers the table partition key with DescribeTable", async () => {
      const tableName = uniqueTableName("js_affinity_discover_it");
      const client = buildClient(endpoint, {
        keyRouteAffinity: {
          mode: "any-write",
        },
      });
      const captured = captureCommandRequests(client);

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName, "user_id");
        const nodes = await client.alternator.refreshNodes();

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              user_id: { S: "user-001" },
              name: { S: "Alice" },
            },
          }),
        );

        await waitFor(
          () => client.alternator.partitionKey(tableName) === "user_id" ? "user_id" : undefined,
          "partition-key autodiscovery",
        );

        expect(captured.some((entry) => entry.commandName === "DescribeTableCommand")).toBe(true);
        expect(client.alternator.partitionKey(tableName)).toBe("user_id");

        captured.length = 0;
        for (let index = 0; index < 10; index += 1) {
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: {
                user_id: { S: "user-002" },
                name: { S: `Bob-${index}` },
              },
            }),
          );
        }

        const repeatedPutHosts = captured
          .filter((entry) => entry.commandName === "PutItemCommand")
          .map((entry) => entry.request.hostname);
        expect(repeatedPutHosts).toHaveLength(10);
        if (nodes.length > 1) {
          expect(new Set(repeatedPutHosts).size).toBe(1);
        }

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              user_id: { S: "user-003" },
              name: { S: "Carol" },
            },
          }),
        );

        const response = await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { user_id: { S: "user-003" } },
            ConsistentRead: true,
          }),
        );
        expect(response.Item?.name?.S).toBe("Carol");
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });

    it("routes repeated writes for the same preconfigured key to the same first node", async () => {
      const tableName = uniqueTableName("js_affinity_preconf_it");
      const client = buildClient(endpoint, {
        keyRouteAffinity: {
          mode: "any-write",
          partitionKeys: {
            [tableName]: "user_id",
          },
        },
        maxAttempts: 1,
      });
      const captured = captureCommandRequests(client);

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName, "user_id");
        const nodes = await client.alternator.refreshNodes();

        for (let index = 0; index < 10; index += 1) {
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: {
                user_id: { S: "preconf-user" },
                seq: { N: String(index) },
              },
            }),
          );
        }

        const putHosts = captured
          .filter((entry) => entry.commandName === "PutItemCommand")
          .map((entry) => entry.request.hostname);

        expect(putHosts).toHaveLength(10);
        if (nodes.length > 1) {
          expect(new Set(putHosts).size).toBe(1);
        }

        const response = await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { user_id: { S: "preconf-user" } },
            ConsistentRead: true,
          }),
        );
        expect(response.Item?.seq?.N).toBe("9");
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });

    it("does not issue DescribeTable when partition-key metadata is preconfigured", async () => {
      const tableName = uniqueTableName("js_affinity_no_describe_it");
      const client = buildClient(endpoint, {
        keyRouteAffinity: {
          mode: "any-write",
          partitionKeys: {
            [tableName]: "user_id",
          },
        },
      });
      const captured = captureCommandRequests(client);

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName, "user_id");
        await client.alternator.refreshNodes();

        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              user_id: { S: "user-001" },
              name: { S: "Alice" },
            },
          }),
        );

        expect(captured.some((entry) => entry.commandName === "DescribeTableCommand")).toBe(false);
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });
  },
);
