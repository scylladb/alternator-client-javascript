import { ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { routing } from "../../src/index.js";
import { describeIntegration, integrationConfig, httpsIntegrationEndpoints } from "./config.js";
import {
  buildClient,
  captureCommandRequests,
  commandHeaders,
  createStringHashTable,
  customCaAvailable,
  getStringItem,
  largePayload,
  putStringItem,
  safeDeleteTable,
  uniqueTableName,
} from "./helpers.js";

const itWithCustomCa = customCaAvailable() ? it : it.skip;

describeIntegration.each(httpsIntegrationEndpoints())(
  "TLS config integration ($name)",
  (endpoint) => {
    it("connects over HTTPS with certificate validation disabled", async () => {
      const client = buildClient(endpoint, {
        tls: {
          rejectUnauthorized: false,
        },
      });

      try {
        await expect(client.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(client.send(new ListTablesCommand({ Limit: 1 }))).resolves.toBeDefined();
      } finally {
        client.destroy();
      }
    });

    itWithCustomCa("connects over HTTPS with a custom CA certificate when configured", async () => {
      const caCertPath = integrationConfig.caCertPath;
      if (!caCertPath) {
        throw new Error("ALTERNATOR_CA_CERT_PATH is required for the custom CA test");
      }

      const client = buildClient(endpoint, {
        tls: {
          ca: { file: caCertPath },
          rejectUnauthorized: true,
        },
      });

      try {
        await expect(client.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(client.send(new ListTablesCommand({ Limit: 1 }))).resolves.toBeDefined();
      } finally {
        client.destroy();
      }
    });

    itWithCustomCa("performs CRUD over HTTPS with a custom CA certificate", async () => {
      const caCertPath = integrationConfig.caCertPath;
      if (!caCertPath) {
        throw new Error("ALTERNATOR_CA_CERT_PATH is required for the custom CA CRUD test");
      }

      const tableName = uniqueTableName("js_tls_ca_crud_it");
      const client = buildClient(endpoint, {
        tls: {
          ca: { file: caCertPath },
          rejectUnauthorized: true,
        },
      });

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName);
        await putStringItem(client, tableName, "ca-item-1", {
          data: { S: "custom-ca-crud" },
        });

        const item = await getStringItem(client, tableName, "ca-item-1");
        expect(item?.pk?.S).toBe("ca-item-1");
        expect(item?.data?.S).toBe("custom-ca-crud");
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });

    it("combines HTTPS, routing scope, compression, and header optimization", async () => {
      const client = buildClient(endpoint, {
        routing: routing.cluster(),
        tls: {
          rejectUnauthorized: false,
        },
        compression: {
          request: {
            thresholdBytes: 100,
          },
        },
        headerOptimization: {
          allowedHeaders: [
            "Host",
            "X-Amz-Target",
            "Authorization",
            "X-Amz-Date",
            "Content-Length",
            "Content-Encoding",
          ],
        },
        maxAttempts: 1,
      });
      const captured = captureCommandRequests(client);

      try {
        await client.alternator.refreshNodes();
        await expect(
          client.send(
            new PutItemCommand({
              TableName: "nonexistent_tls_combined_test",
              Item: {
                pk: { S: "tls-combined" },
                data: { S: largePayload() },
              },
            }),
          ),
        ).rejects.toBeDefined();

        const headers = commandHeaders(captured, "PutItemCommand");
        expect(headers["content-encoding"]).toBe("gzip");
        expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
      } finally {
        client.destroy();
      }
    });
  },
);
