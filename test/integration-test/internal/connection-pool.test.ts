import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { expect, it } from "vitest";
import { describeIntegration, integrationEndpoints } from "../config.js";
import { buildClient, sleep } from "../helpers.js";

describeIntegration.each(integrationEndpoints())(
  "internal connection pool integration ($name)",
  (endpoint) => {
    it("can refresh live nodes repeatedly without exhausting the request handler", async () => {
      const client = buildClient(endpoint, {
        connection: {
          keepAlive: true,
          maxSockets: 4,
        },
      });

      try {
        for (let index = 0; index < 30; index += 1) {
          await client.refreshLiveNodes();
        }

        expect(client.getLiveNodes().length).toBeGreaterThan(0);
      } finally {
        client.destroy();
      }
    });

    it("continues to serve SDK operations after idle gaps with header optimization enabled", async () => {
      const client = buildClient(endpoint, {
        headerOptimization: true,
        connection: {
          keepAlive: true,
          maxSockets: 8,
        },
      });

      try {
        await client.refreshLiveNodes();
        for (let index = 0; index < 10; index += 1) {
          await client.send(new ListTablesCommand({ Limit: 1 }));
          await sleep(250);
        }

        await sleep(2_000);

        const responses = await Promise.all(
          Array.from({ length: 10 }, () => client.send(new ListTablesCommand({ Limit: 1 }))),
        );
        expect(responses).toHaveLength(10);
      } finally {
        client.destroy();
      }
    });
  },
);
