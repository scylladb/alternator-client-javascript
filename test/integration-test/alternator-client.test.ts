import { GetItemCommand, ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { AlternatorDynamoDBClient, routing } from "../../src/index.js";
import { describeIntegration, integrationConfig, integrationEndpoints } from "./config.js";
import {
  buildClient,
  captureCommandRequests,
  commandHeaders,
  createStringHashTable,
  largePayload,
  putStringItem,
  safeDeleteTable,
  uniqueTableName,
} from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "AlternatorDynamoDBClient integration ($name)",
  (endpoint) => {
    it("discovers nodes for cluster, datacenter, and rack routing scopes", async () => {
      const cluster = buildClient(endpoint, {
        routing: routing.cluster(),
      });
      const datacenter = buildClient(endpoint, {
        routing: routing.datacenter({
          datacenter: integrationConfig.datacenter,
          fallback: routing.cluster(),
        }),
      });
      const rack = buildClient(endpoint, {
        routing: routing.rack({
          datacenter: integrationConfig.datacenter,
          rack: integrationConfig.rack,
          fallback: routing.datacenter({
            datacenter: integrationConfig.datacenter,
            fallback: routing.cluster(),
          }),
        }),
      });

      try {
        await expect(cluster.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(datacenter.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(rack.alternator.refreshNodes()).resolves.not.toHaveLength(0);
      } finally {
        cluster.destroy();
        datacenter.destroy();
        rack.destroy();
      }
    });

    it("falls back from a wrong datacenter or rack to a wider routing scope", async () => {
      const wrongDatacenter = buildClient(endpoint, {
        routing: routing.datacenter({
          datacenter: "__wrong_dc__",
          fallback: routing.cluster(),
        }),
      });
      const wrongRack = buildClient(endpoint, {
        routing: routing.rack({
          datacenter: integrationConfig.datacenter,
          rack: "__wrong_rack__",
          fallback: routing.datacenter({
            datacenter: integrationConfig.datacenter,
            fallback: routing.cluster(),
          }),
        }),
      });

      try {
        await expect(wrongDatacenter.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(wrongDatacenter.alternator.validateRouting()).resolves.toBeUndefined();

        await expect(wrongRack.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(wrongRack.alternator.validateRouting()).resolves.toBeUndefined();
      } finally {
        wrongDatacenter.destroy();
        wrongRack.destroy();
      }
    });

    it("checks rack/datacenter query support and exposes live-node APIs", async () => {
      const client = buildClient(endpoint, {
        routing: routing.datacenter({
          datacenter: integrationConfig.datacenter,
          fallback: routing.cluster(),
        }),
      });

      try {
        await expect(client.alternator.supportsScopedDiscovery()).resolves.toBe(true);
        await expect(client.alternator.validateRouting()).resolves.toBeUndefined();

        const nodes = await client.alternator.refreshNodes();
        expect(nodes.length).toBeGreaterThan(0);
        expect(client.alternator.nodes()).toEqual(nodes);
      } finally {
        client.destroy();
      }
    });

    it("routes repeated commands through discovered nodes", async () => {
      const client = buildClient(endpoint, {
        routing: routing.datacenter({
          datacenter: integrationConfig.datacenter,
          fallback: routing.cluster(),
        }),
      });
      const captured = captureCommandRequests(client);

      try {
        const nodes = await client.alternator.refreshNodes();
        expect(nodes.length).toBeGreaterThan(0);

        for (let index = 0; index < nodes.length * 2; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
        }

        const liveHosts = new Set(nodes.map((node) => node.host));
        const requestHosts = captured.map((entry) => entry.request.hostname);
        expect(requestHosts.length).toBe(nodes.length * 2);
        expect(requestHosts.every((host) => liveHosts.has(host))).toBe(true);
      } finally {
        client.destroy();
      }
    });

    it("sends commands through discovered nodes", async () => {
      const client = buildClient(endpoint, {
        routing: routing.datacenter({
          datacenter: integrationConfig.datacenter,
          fallback: routing.cluster(),
        }),
      });
      const captured = captureCommandRequests(client);

      try {
        const nodes = await client.alternator.refreshNodes();
        await client.send(new ListTablesCommand({ Limit: 1 }));
        await client.send(new ListTablesCommand({ Limit: 1 }));

        const liveHosts = new Set(nodes.map((node) => node.host));
        const requestHosts = captured.map((entry) => entry.request.hostname);
        expect(requestHosts.length).toBe(2);
        expect(requestHosts.every((host) => liveHosts.has(host))).toBe(true);
      } finally {
        client.destroy();
      }
    });

    it("compresses large requests and leaves small requests uncompressed by threshold", async () => {
      const client = buildClient(endpoint, {
        compression: {
          request: {
            thresholdBytes: 100,
          },
        },
        maxAttempts: 1,
      });
      const captured = captureCommandRequests(client);

      try {
        await expect(
          client.send(
            new PutItemCommand({
              TableName: "nonexistent_table_for_compression_test",
              Item: {
                pk: { S: "compression-test" },
                data: { S: largePayload() },
              },
            }),
          ),
        ).rejects.toBeDefined();

        await client.send(new ListTablesCommand({ Limit: 1 }));

        expect(commandHeaders(captured, "PutItemCommand")["content-encoding"]).toBe("gzip");
        expect(commandHeaders(captured, "ListTablesCommand")["content-encoding"]).toBeUndefined();
      } finally {
        client.destroy();
      }
    });

    it.each([
      ["gzip"],
      ["deflate"],
    ] as const)("reads %s-compressed responses", async (encoding) => {
      const tableName = uniqueTableName(`js_response_compression_${encoding}`);
      const client = buildClient(endpoint, {
        compression: {
          response: {
            algorithms: [encoding],
          },
        },
        maxAttempts: 1,
      });
      const captured = captureCommandRequests(client);

      try {
        await safeDeleteTable(client, tableName);
        await createStringHashTable(client, tableName);
        await putStringItem(client, tableName, "123", {
          data: { S: largePayload().repeat(20) },
        });

        const response = await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: {
              pk: { S: "123" },
            },
            ConsistentRead: true,
          }),
        );

        expect(response.Item?.data?.S).toContain("This is a test value");
        expect(commandHeaders(captured, "GetItemCommand")["accept-encoding"]).toBe(encoding);
      } finally {
        await safeDeleteTable(client, tableName);
        client.destroy();
      }
    });

    it("filters wire headers using the configured whitelist", async () => {
      const client = buildClient(endpoint, {
        headerOptimization: {
          allowedHeaders: ["Host", "X-Amz-Target", "Authorization", "X-Amz-Date"],
        },
      });
      const captured = captureCommandRequests(client);

      try {
        await client.send(new ListTablesCommand({ Limit: 1 }));

        const headers = commandHeaders(captured, "ListTablesCommand");
        expect(headers.host).toBeDefined();
        expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.ListTables");
        expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
        expect(headers["x-amz-date"]).toBeDefined();
        expect(headers["content-type"]).toBeUndefined();
        expect(headers["content-length"]).toBeUndefined();
        expect(headers["x-amz-content-sha256"]).toBeUndefined();
        expect(headers["x-amz-user-agent"]).toBeUndefined();
        expect(headers["amz-sdk-invocation-id"]).toBeUndefined();
        expect(headers["amz-sdk-request"]).toBeUndefined();
        expectSignedHeadersPresent(headers);
      } finally {
        client.destroy();
      }
    });

    it("preserves normal SDK wire headers when header optimization is disabled", async () => {
      const client = buildClient(endpoint);
      const captured = captureCommandRequests(client);

      try {
        await client.send(new ListTablesCommand({ Limit: 1 }));

        const headers = commandHeaders(captured, "ListTablesCommand");
        expect(headers.host).toBeDefined();
        expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.ListTables");
        expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
        expect(headers["x-amz-date"]).toBeDefined();
        expect(headers["content-type"]).toBe("application/x-amz-json-1.0");
        expect(headers["x-amz-content-sha256"]).toBeDefined();
      } finally {
        client.destroy();
      }
    });

    it("keeps custom-whitelisted headers when header optimization is enabled", async () => {
      const client = buildClient(endpoint, {
        headerOptimization: {
          allowedHeaders: [
            "Host",
            "X-Amz-Target",
            "Authorization",
            "X-Amz-Date",
            "Content-Type",
            "Content-Length",
          ],
        },
      });
      const captured = captureCommandRequests(client);

      try {
        await client.send(new ListTablesCommand({ Limit: 1 }));

        const headers = commandHeaders(captured, "ListTablesCommand");
        expect(headers.host).toBeDefined();
        expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.ListTables");
        expect(headers.authorization).toContain("AWS4-HMAC-SHA256");
        expect(headers["x-amz-date"]).toBeDefined();
        expect(headers["content-type"]).toBe("application/x-amz-json-1.0");
        expect(headers["x-amz-content-sha256"]).toBeUndefined();
        expect(headers["x-amz-user-agent"]).toBeUndefined();
        expect(headers["amz-sdk-invocation-id"]).toBeUndefined();
        expect(headers["amz-sdk-request"]).toBeUndefined();
        expectSignedHeadersPresent(headers);
      } finally {
        client.destroy();
      }
    });

    it("keeps compression headers when header optimization and compression are combined", async () => {
      const client = buildClient(endpoint, {
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
        await expect(
          client.send(
            new PutItemCommand({
              TableName: "nonexistent_table_for_headers_compression_test",
              Item: {
                pk: { S: "combined-test" },
                data: { S: largePayload() },
              },
            }),
          ),
        ).rejects.toBeDefined();

        const headers = commandHeaders(captured, "PutItemCommand");
        expect(headers["content-encoding"]).toBe("gzip");
        expect(headers["content-length"]).toBeDefined();
        expect(headers["content-type"]).toBeUndefined();
        expect(headers["x-amz-content-sha256"]).toBeUndefined();
        expect(headers["x-amz-user-agent"]).toBeUndefined();
        expect(headers["amz-sdk-invocation-id"]).toBeUndefined();
        expect(headers["amz-sdk-request"]).toBeUndefined();
        expectSignedHeadersPresent(headers);
      } finally {
        client.destroy();
      }
    });
  },
);

describeIntegration.each(integrationEndpoints().filter((endpoint) => endpoint.scheme === "http"))(
  "Alternator DNS entrypoint integration ($name)",
  (endpoint) => {
    it("discovers live cluster nodes from a DNS entrypoint", async () => {
      const localnodes = await fetch(`http://${endpoint.host}:${endpoint.port}/localnodes`);
      expect(localnodes.ok).toBe(true);
      const body = await localnodes.text();

      const server = createServer((request, response) => {
        expect(request.url).toBe("/localnodes");
        response.setHeader("content-type", "application/json");
        response.end(body);
      });
      const address = await listen(server, "localhost");
      const client = new AlternatorDynamoDBClient({
        seeds: ["localhost"],
        scheme: "http",
        port: address.port,
        credentials: integrationConfig.credentials,
        discovery: { background: false },
      });

      try {
        const nodes = await client.alternator.refreshNodes();
        expect(nodes.length).toBeGreaterThan(0);
      } finally {
        client.destroy();
        await close(server);
      }
    });
  },
);

describe("integration test opt-in", () => {
  it("is disabled unless INTEGRATION_TESTS is truthy", () => {
    expect(typeof integrationConfig.enabled).toBe("boolean");
  });
});

function expectSignedHeadersPresent(headers: Record<string, string | undefined>): void {
  for (const name of signedHeaderNames(headers.authorization)) {
    expect(headers[name]).toBeDefined();
  }
}

function signedHeaderNames(authorization: string | undefined): string[] {
  const match = authorization?.match(/(?:^|,\s*)SignedHeaders=([^,\s]+)/);
  return match?.[1]?.split(";").filter(Boolean) ?? [];
}

function listen(server: Server, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
