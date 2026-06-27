import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteItemCommand, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { describeIntegration, integrationEndpoints } from "./config.js";
import {
  buildClient,
  buildDocumentClient,
  createStringHashTable,
  getStringItem,
  putStringItem,
  safeDeleteTable,
  uniqueTableName,
} from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "DynamoDB operations integration ($name)",
  (endpoint) => {
    it("performs low-level CRUD operations through the load-balanced client", async () => {
      const tableName = uniqueTableName("js_crud_it");
      const client = buildClient(endpoint);

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName);

        await putStringItem(client, tableName, "item-1", {
          data: { S: "hello-world" },
          count: { N: "42" },
        });

        const item = await getStringItem(client, tableName, "item-1");
        expect(item?.pk?.S).toBe("item-1");
        expect(item?.data?.S).toBe("hello-world");
        expect(item?.count?.N).toBe("42");

        await client.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: { pk: { S: "item-1" } },
          }),
        );

        const deleted = await getStringItem(client, tableName, "item-1");
        expect(deleted).toBeUndefined();
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });

    it("performs document-client CRUD operations through the Alternator client", async () => {
      const tableName = uniqueTableName("js_doc_crud_it");
      const setupClient = buildClient(endpoint);
      const documentClient = buildDocumentClient(endpoint, {}, {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      });

      try {
        await safeDeleteTable(setupClient, tableName);
        await createStringHashTable(setupClient, tableName);

        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: "doc-1",
              data: "document-value",
              skipped: undefined,
            },
          }),
        );

        const response = await documentClient.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: "doc-1" },
            ConsistentRead: true,
          }),
        );
        expect(response.Item).toEqual({
          pk: "doc-1",
          data: "document-value",
        });

        await documentClient.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { pk: "doc-1" },
          }),
        );
      } finally {
        documentClient.destroy();
        await safeDeleteTable(setupClient, tableName);
        setupClient.destroy();
      }
    });

    it("keeps data readable when writes and reads are spread across nodes", async () => {
      const tableName = uniqueTableName("js_multinode_it");
      const client = buildClient(endpoint);
      const itemCount = 30;

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName);
        await client.alternator.refreshNodes();

        for (let index = 0; index < itemCount; index += 1) {
          await client.send(
            new PutItemCommand({
              TableName: tableName,
              Item: {
                pk: { S: `key-${index}` },
                value: { S: `value-${index}` },
                itemIndex: { N: String(index) },
              },
            }),
          );
        }

        for (let index = 0; index < itemCount; index += 1) {
          const response = await client.send(
            new GetItemCommand({
              TableName: tableName,
              Key: { pk: { S: `key-${index}` } },
              ConsistentRead: true,
            }),
          );

          expect(response.Item?.pk?.S).toBe(`key-${index}`);
          expect(response.Item?.value?.S).toBe(`value-${index}`);
          expect(response.Item?.itemIndex?.N).toBe(String(index));
        }
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });
  },
);
