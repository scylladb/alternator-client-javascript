import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { describeIntegration, integrationEndpoints } from "./config.js";
import { buildClient } from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "HTTP connection reuse integration ($name)",
  (endpoint) => {
    it("handles rapid serial requests through the default Node HTTP handler", async () => {
      const client = buildClient(endpoint, {
        connection: {
          keepAlive: true,
          maxSockets: 16,
        },
      });

      try {
        let successes = 0;
        for (let index = 0; index < 20; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
          successes += 1;
        }

        expect(successes).toBe(20);
      } finally {
        client.destroy();
      }
    });

    it("handles parallel requests with a bounded socket pool", async () => {
      const client = buildClient(endpoint, {
        connection: {
          keepAlive: true,
          maxSockets: 4,
        },
      });

      try {
        const responses = await Promise.all(
          Array.from({ length: 50 }, () => client.send(new ListTablesCommand({ Limit: 1 }))),
        );

        expect(responses).toHaveLength(50);
      } finally {
        client.destroy();
      }
    });

    it("continues to use the client successfully after a short idle period", async () => {
      const client = buildClient(endpoint, {
        connection: {
          keepAlive: true,
          maxSockets: 8,
        },
      });

      try {
        for (let index = 0; index < 10; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
        }

        await new Promise((resolve) => {
          setTimeout(resolve, 2_000);
        });

        for (let index = 0; index < 10; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
        }
      } finally {
        client.destroy();
      }
    });
  },
);
