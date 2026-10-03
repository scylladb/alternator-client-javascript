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

import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { routing } from "../../src/index.js";
import { describeIntegration, integrationConfig, integrationEndpoints } from "./config.js";
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

    it.skipIf(
      integrationConfig.secondRackHost === undefined || integrationConfig.secondRack === undefined,
    )("lets affinity override rack routing while ordinary writes stay local", async () => {
      const secondRackHost = integrationConfig.secondRackHost;
      const secondRack = integrationConfig.secondRack;
      if (secondRackHost === undefined || secondRack === undefined) {
        throw new Error("multi-rack integration metadata is unavailable");
      }

      const tableName = uniqueTableName("js_affinity_rack_it");
      const tableClient = buildClient(endpoint);
      const firstRackClient = buildClient(
        { ...endpoint, host: integrationConfig.host },
        {
          routing: routing.rack({
            datacenter: integrationConfig.datacenter,
            rack: integrationConfig.rack,
          }),
          keyRouteAffinity: {
            mode: "read-before-write",
            partitionKeys: { [tableName]: "user_id" },
          },
          maxAttempts: 1,
        },
      );
      const secondRackClient = buildClient(
        { ...endpoint, host: secondRackHost },
        {
          routing: routing.rack({
            datacenter: integrationConfig.datacenter,
            rack: secondRack,
          }),
          keyRouteAffinity: {
            mode: "read-before-write",
            partitionKeys: { [tableName]: "user_id" },
          },
          maxAttempts: 1,
        },
      );
      const firstCaptured = captureCommandRequests(firstRackClient);
      const secondCaptured = captureCommandRequests(secondRackClient);

      try {
        await safeDeleteTable(tableClient, tableName);
        await createStringHashTable(tableClient, tableName, "user_id");
        await tableClient.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { user_id: { S: "shared" }, writer: { S: "setup" } },
          }),
        );

        for (const [client, writer] of [
          [firstRackClient, "first"],
          [secondRackClient, "second"],
        ] as const) {
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: { user_id: { S: "shared" }, writer: { S: writer } },
              ConditionExpression: "attribute_exists(user_id)",
            }),
          );
        }

        const firstAffinityHost = firstCaptured.find(
          (entry) => entry.commandName === "PutItemCommand",
        )?.request.hostname;
        const secondAffinityHost = secondCaptured.find(
          (entry) => entry.commandName === "PutItemCommand",
        )?.request.hostname;
        expect(firstAffinityHost).toBeDefined();
        expect(secondAffinityHost).toBe(firstAffinityHost);

        await expect(firstRackClient.alternator.refreshNodes()).resolves.toEqual([
          expect.objectContaining({ host: integrationConfig.host }),
        ]);
        await expect(secondRackClient.alternator.refreshNodes()).resolves.toEqual([
          expect.objectContaining({ host: secondRackHost }),
        ]);
        firstCaptured.length = 0;
        secondCaptured.length = 0;

        await firstRackClient.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { user_id: { S: "first-local" } },
          }),
        );
        await secondRackClient.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { user_id: { S: "second-local" } },
          }),
        );

        expect(firstCaptured[0]?.request.hostname).toBe(integrationConfig.host);
        expect(secondCaptured[0]?.request.hostname).toBe(secondRackHost);
      } finally {
        await safeDeleteTable(tableClient, tableName);
        firstRackClient.destroy();
        secondRackClient.destroy();
        tableClient.destroy();
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
