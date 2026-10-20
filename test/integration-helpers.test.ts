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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { AlternatorDynamoDBClient } from "../src/index.js";
import { createStringHashTable } from "./integration-test/helpers.js";

it("aborts integration table creation when an endpoint accepts but never responds", async () => {
  let accepted!: () => void;
  const received = new Promise<void>((resolve) => { accepted = resolve; });
  const server = createServer((request) => {
    request.resume();
    accepted();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const client = new AlternatorDynamoDBClient({
    seeds: ["127.0.0.1"], port: (server.address() as AddressInfo).port,
    discovery: { background: false }, maxAttempts: 1,
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Pending table request did not honor cancellation")), 1_000);
  });
  const pending = createStringHashTable(client, "bounded_table", "id", { abortSignal: controller.signal });
  try {
    await Promise.race([received, deadline]);
    controller.abort();
    await expect(Promise.race([pending, deadline])).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    clearTimeout(timer);
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    await Promise.allSettled([pending]);
  }
});
