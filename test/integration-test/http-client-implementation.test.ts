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
