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
