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

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileRelease } from "./github-release-notes.mjs";

function releaseApi(existing, { missingTag = false, pages = [[]], failure, generated = { body: "## Changes\n* Runtime fix by @author in #42" } } = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/git/ref/tags/") && missingTag) throw new Error("Missing tag");
    if (path === failure) throw new Error("API unavailable");
    if (path === "/releases/generate-notes") return generated;
    if (path.startsWith("/releases/tags/")) return existing;
    if (path.startsWith("/releases?")) return pages[Number(new URL(path, "https://example.test").searchParams.get("page")) - 1] ?? [];
    return {};
  };
  return { api, calls };
}

test("creates release with curated text and configured filtered notes", async () => {
  const { api, calls } = releaseApi();
  await reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "## Highlights\nUseful guidance\n" });
  assert.deepEqual(calls.find((call) => call.path === "/releases/generate-notes").body,
    { tag_name: "v1.2.3", configuration_file_path: ".github/release.yml" });
  const last = calls.at(-1);
  assert.equal(last.method, "POST");
  assert.equal(last.path, "/releases");
  assert.equal(last.body.body, "## Highlights\nUseful guidance\n\n## Changes\n* Runtime fix by @author in #42\n");
  assert.equal(last.body.prerelease, false);
});

test("publishes a matching draft with replacement notes and prerelease metadata", async () => {
  const { api, calls } = releaseApi({ id: 123, tag_name: "v1.2.3-rc.1", draft: true, body: "Old draft" });
  await reconcileRelease(api, { tag: "v1.2.3-rc.1", version: "1.2.3-rc.1", curated: "Release candidate" });
  assert.equal(calls.at(-1).method, "PATCH");
  assert.equal(calls.at(-1).path, "/releases/123");
  assert.equal(calls.at(-1).body.prerelease, true);
  assert.equal(calls.at(-1).body.draft, false);
  assert.equal(calls.at(-1).body.body, "Release candidate\n\n## Changes\n* Runtime fix by @author in #42\n");
});

test("preserves published release notes without generating or writing", async () => {
  const existing = { id: 123, tag_name: "v1.2.3", draft: false, body: "Published guidance" };
  const { api, calls } = releaseApi(existing);
  assert.equal(await reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "New guidance" }), existing);
  assert.equal(existing.body, "Published guidance");
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("recovers matching drafts beyond the first release-list page", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `v0.0.${i}`, draft: false }));
  const { api, calls } = releaseApi(undefined, { pages: [first, [{ id: 123, tag_name: "v1.2.3", draft: true }]] });
  await reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" });
  assert.ok(calls.some(call => call.path === "/releases?per_page=100&page=2"));
  assert.equal(calls.at(-1).method, "PATCH");
  assert.equal(calls.at(-1).path, "/releases/123");
});

test("a published release found in pagination remains untouched", async () => {
  const { api, calls } = releaseApi(undefined, { pages: [[{ id: 123, tag_name: "v1.2.3", draft: false }]] });
  await reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" });
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("lookup, listing and generation failures never create or publish a release", async () => {
  for (const failure of ["/releases/tags/v1.2.3", "/releases?per_page=100&page=1", "/releases/generate-notes"]) {
    const { api, calls } = releaseApi(undefined, { failure });
    await assert.rejects(reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" }), /API unavailable/);
    assert.equal(calls.some(call => call.path === "/releases" || call.method === "PATCH"), false);
  }
  for (const existing of [{ id: 123, tag_name: "v9.9.9", draft: true }, { id: 123, tag_name: "v1.2.3" }]) {
    const { api } = releaseApi(existing);
    await assert.rejects(reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" }), /Invalid matching release/);
  }
  const { api, calls } = releaseApi(undefined, { generated: {} });
  await assert.rejects(reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" }), /Missing generated/);
  assert.equal(calls.some(call => call.path === "/releases" || call.method === "PATCH"), false);
});

test("later-page listing failure does not become a missing release", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, tag_name: `v0.0.${i}`, draft: false }));
  const { api, calls } = releaseApi(undefined, { pages: [first], failure: "/releases?per_page=100&page=2" });
  await assert.rejects(reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" }), /API unavailable/);
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("missing or invalid tags cannot create releases", async () => {
  const { api, calls } = releaseApi(undefined, { missingTag: true });
  await assert.rejects(reconcileRelease(api, { tag: "v1.2.3", version: "1.2.3", curated: "Notes" }));
  await assert.rejects(reconcileRelease(api, { tag: "v1.2.4", version: "1.2.3", curated: "Notes" }));
  assert.equal(calls.some((call) => call.path === "/releases"), false);
});

test("CLI reads curated notes and serializes HTTP requests, propagating API failure", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-notes-test-"));
  const notes = join(directory, "notes.md");
  const requests = [];
  let fail = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, headers: request.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    response.setHeader("Content-Type", "application/json");
    if (request.url.endsWith("/releases/tags/v1.2.3")) {
      response.writeHead(404).end("{}");
    } else if (request.url.includes("/releases?")) {
      response.end("[]");
    } else if (request.url.endsWith("/releases/generate-notes")) {
      response.writeHead(fail ? 503 : 200).end(JSON.stringify({ body: "Generated notes" }));
    } else {
      response.end("{}");
    }
  });
  try {
    await writeFile(notes, "Curated notes\n");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./github-release-notes.mjs", import.meta.url)), "release"], {
        env: { ...process.env, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "scylladb/alternator-client-javascript",
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, RELEASE_TAG: "v1.2.3", PACKAGE_VERSION: "1.2.3", RELEASE_NOTES: notes },
        stdio: ["ignore", "ignore", "pipe"], timeout: 5000,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, stderr }));
    });
    assert.equal((await run()).code, 0);
    const published = requests.find(request => request.path.endsWith("/releases") && request.method === "POST");
    assert.equal(published.body.body, "Curated notes\n\nGenerated notes\n");
    assert.equal(published.headers.authorization, "Bearer test-token");
    assert.equal(requests.find(request => request.path.endsWith("/releases/generate-notes")).body.configuration_file_path, ".github/release.yml");
    requests.length = 0;
    fail = true;
    const failed = await run();
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /failed: 503/);
    assert.equal(requests.some(request => request.path.endsWith("/releases") && request.method === "POST"), false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
