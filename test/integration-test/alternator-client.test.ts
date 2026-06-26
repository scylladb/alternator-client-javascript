import { ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { routing } from "../../src/index.js";
import { describeIntegration, integrationConfig, integrationEndpoints } from "./config.js";
import {
  buildClient,
  captureCommandRequests,
  commandHeaders,
  largePayload,
} from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "AlternatorDynamoDBClient integration ($name)",
  (endpoint) => {
    it("discovers nodes for cluster, datacenter, and rack routing scopes", async () => {
      const cluster = buildClient(endpoint, {
        routing: routing.cluster(),
      });
      const datacenter = buildClient(endpoint, {
        routing: routing.datacenter(integrationConfig.datacenter, {
          fallback: routing.cluster(),
        }),
      });
      const rack = buildClient(endpoint, {
        routing: routing.rack(integrationConfig.datacenter, integrationConfig.rack, {
          fallback: routing.datacenter(integrationConfig.datacenter, {
            fallback: routing.cluster(),
          }),
        }),
      });

      try {
        await expect(cluster.refreshLiveNodes()).resolves.not.toHaveLength(0);
        await expect(datacenter.refreshLiveNodes()).resolves.not.toHaveLength(0);
        await expect(rack.refreshLiveNodes()).resolves.not.toHaveLength(0);
      } finally {
        cluster.destroy();
        datacenter.destroy();
        rack.destroy();
      }
    });

    it("falls back from a wrong datacenter or rack to a wider routing scope", async () => {
      const wrongDatacenter = buildClient(endpoint, {
        routing: routing.datacenter("__wrong_dc__", {
          fallback: routing.cluster(),
        }),
      });
      const wrongRack = buildClient(endpoint, {
        routing: routing.rack(integrationConfig.datacenter, "__wrong_rack__", {
          fallback: routing.datacenter(integrationConfig.datacenter, {
            fallback: routing.cluster(),
          }),
        }),
      });

      try {
        await expect(wrongDatacenter.refreshLiveNodes()).resolves.not.toHaveLength(0);
        await expect(wrongDatacenter.validateRackDatacenterConfig()).resolves.toBeUndefined();

        await expect(wrongRack.refreshLiveNodes()).resolves.not.toHaveLength(0);
        await expect(wrongRack.validateRackDatacenterConfig()).resolves.toBeUndefined();
      } finally {
        wrongDatacenter.destroy();
        wrongRack.destroy();
      }
    });

    it("checks rack/datacenter query support and exposes live-node APIs", async () => {
      const client = buildClient(endpoint, {
        routing: routing.datacenter(integrationConfig.datacenter, {
          fallback: routing.cluster(),
        }),
      });

      try {
        await expect(client.checkRackDatacenterSupport()).resolves.toBe(true);
        await expect(client.checkIfRackAndDatacenterSetCorrectly()).resolves.toBeUndefined();

        const nodes = await client.refreshLiveNodes();
        expect(nodes.length).toBeGreaterThan(0);
        expect(client.getLiveNodes()).toEqual(nodes);
      } finally {
        client.destroy();
      }
    });

    it("routes repeated commands through discovered nodes", async () => {
      const client = buildClient(endpoint, {
        routing: routing.datacenter(integrationConfig.datacenter, {
          fallback: routing.cluster(),
        }),
      });
      const captured = captureCommandRequests(client);

      try {
        const nodes = await client.refreshLiveNodes();
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
        routing: routing.datacenter(integrationConfig.datacenter, {
          fallback: routing.cluster(),
        }),
      });
      const captured = captureCommandRequests(client);

      try {
        const nodes = await client.refreshLiveNodes();
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
          enabled: true,
          thresholdBytes: 100,
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

    it("filters wire headers using the configured whitelist", async () => {
      const client = buildClient(endpoint, {
        headerOptimization: {
          enabled: true,
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
        expect(headers["x-amz-content-sha256"]).toBeUndefined();
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
          enabled: true,
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
      } finally {
        client.destroy();
      }
    });

    it("keeps compression headers when header optimization and compression are combined", async () => {
      const client = buildClient(endpoint, {
        compression: {
          enabled: true,
          thresholdBytes: 100,
        },
        headerOptimization: {
          enabled: true,
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
      } finally {
        client.destroy();
      }
    });
  },
);

describe("integration test opt-in", () => {
  it("is disabled unless INTEGRATION_TESTS is truthy", () => {
    expect(typeof integrationConfig.enabled).toBe("boolean");
  });
});
