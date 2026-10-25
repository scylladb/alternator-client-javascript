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

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function validateRelease(release, tag) {
  if (!release || release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id <= 0 ||
      typeof release.draft !== "boolean") {
    throw new Error("Invalid matching release metadata");
  }
  return release;
}

async function findRelease(api, tag) {
  const existing = await api("GET", `/releases/tags/${encodeURIComponent(tag)}`, undefined, [404]);
  if (existing) return validateRelease(existing, tag);
  // Tag lookup can miss drafts. Inspect every page before creating a release.
  let draft;
  for (let page = 1; ; page++) {
    const releases = await api("GET", `/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("Invalid release listing");
    for (const release of releases) {
      if (!release || typeof release.tag_name !== "string") throw new Error("Invalid release listing metadata");
      if (release.tag_name !== tag) continue;
      validateRelease(release, tag);
      if (!release.draft) return release;
      if (draft && draft.id !== release.id) throw new Error("Multiple matching draft releases");
      draft = release;
    }
    if (releases.length < 100) return draft;
  }
}

export async function reconcileRelease(api, { tag, version, curated }) {
  if (tag !== `v${version}` || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error("Invalid release tag or version");
  }
  // The publish workflow already verifies the signed tag and npm artifact.
  await api("GET", `/git/ref/tags/${encodeURIComponent(tag)}`);
  const existing = await findRelease(api, tag);
  // Labels are asynchronous: reruns must not rewrite an already published body.
  if (existing && !existing.draft) return existing;
  const generated = await api("POST", "/releases/generate-notes", {
    tag_name: tag, configuration_file_path: ".github/release.yml",
  });
  if (typeof generated.body !== "string") throw new Error("Missing generated release notes");
  const payload = {
    tag_name: tag, name: tag, draft: false, prerelease: version.includes("-"),
    body: `${curated.trim()}\n\n${generated.body.trim()}\n`,
  };
  if (existing) return api("PATCH", `/releases/${existing.id}`, payload);
  return api("POST", "/releases", payload);
}

export function githubApi({ token, repository, server = "https://api.github.com" }) {
  if (!token || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("Missing GitHub credentials or repository");
  return async (method, endpoint, body, allowed = []) => {
    const response = await fetch(`${server}/repos/${repository}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (allowed.includes(response.status)) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${method} ${endpoint} failed: ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = githubApi({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY, server: process.env.GITHUB_API_URL });
  if (process.argv[2] === "release") {
    await reconcileRelease(api, {
      tag: process.env.RELEASE_TAG, version: process.env.PACKAGE_VERSION,
      curated: readFileSync(process.env.RELEASE_NOTES, "utf8"),
    });
  } else {
    throw new Error("Expected release command");
  }
}
