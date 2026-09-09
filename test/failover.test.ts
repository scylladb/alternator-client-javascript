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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { commandRequests, RecordingHandler } from "./helpers.js";

describe("Alternator transport failover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the next query-plan node after a retryable transport failure", async () => {
    let commandAttempts = 0;
    const handler = new RecordingHandler((request) => {
      if (request.path === "/localnodes") {
        return ["node-a", "node-b"];
      }

      commandAttempts += 1;
      if (commandAttempts === 1) {
        const error = new Error("socket reset");
        error.name = "TimeoutError";
        throw error;
      }
      return { TableNames: [] };
    });
    const client = new AlternatorDynamoDBClient({
      seeds: ["seed"],
      requestHandler: handler,
      discovery: { background: false },
      maxAttempts: 2,
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      await client.alternator.refreshNodes();
      await expect(client.send(new ListTablesCommand({}))).resolves.toMatchObject({
        TableNames: [],
      });
    } finally {
      client.destroy();
    }

    expect(commandRequests(handler).map((request) => request.hostname)).toEqual([
      "node-a",
      "node-b",
    ]);
  });
});
