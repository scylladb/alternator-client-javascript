import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { expect, it } from "vitest";
import { describeIntegration, integrationEndpoints } from "./config.js";
import { buildClient } from "./helpers.js";

describeIntegration.each(integrationEndpoints())(
  "HTTP request handler integration ($name)",
  (endpoint) => {
    it("uses a delegated custom request handler for discovery and SDK commands", async () => {
      const delegate = new NodeHttpHandler({
        httpAgent: new HttpAgent({
          keepAlive: true,
          maxSockets: 4,
        }),
        httpsAgent: new HttpsAgent({
          keepAlive: true,
          maxSockets: 4,
          rejectUnauthorized: false,
        }),
      });
      const handledPaths: string[] = [];
      const delegateHandle = delegate.handle.bind(delegate);
      delegate.handle = (request, options) => {
        handledPaths.push(request.path);
        return delegateHandle(request, options);
      };

      const client = buildClient(endpoint, { requestHandler: delegate });

      try {
        await expect(client.alternator.refreshNodes()).resolves.not.toHaveLength(0);
        await expect(client.send(new ListTablesCommand({ Limit: 1 }))).resolves.toBeDefined();

        expect(handledPaths).toContain("/localnodes");
        expect(handledPaths).toContain("/");
      } finally {
        client.destroy();
      }
    });
  },
);
