import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { routing } from "../../src/index.js";
import { describeIntegration, httpsIntegrationEndpoints } from "./config.js";
import { buildClient } from "./helpers.js";

describeIntegration.each(httpsIntegrationEndpoints())(
  "TLS session cache integration ($name)",
  (endpoint) => {
    it("keeps HTTPS requests working with the default Node TLS session cache", async () => {
      const client = buildClient(endpoint, {
        tls: {
          rejectUnauthorized: false,
        },
      });

      try {
        for (let index = 0; index < 10; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
        }
      } finally {
        client.destroy();
      }
    });

    it("keeps HTTPS requests working when TLS session caching is disabled", async () => {
      const client = buildClient(endpoint, {
        tls: {
          rejectUnauthorized: false,
          sessionCache: false,
        },
      });

      try {
        for (let index = 0; index < 5; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
        }
      } finally {
        client.destroy();
      }
    });

    it("combines TLS session cache settings with routing and header optimization", async () => {
      const client = buildClient(endpoint, {
        routing: routing.cluster(),
        tls: {
          rejectUnauthorized: false,
          sessionCache: true,
        },
        headerOptimization: true,
      });

      try {
        await expect(client.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(client.send(new ListTablesCommand({ Limit: 1 }))).resolves.toBeDefined();
      } finally {
        client.destroy();
      }
    });
  },
);
