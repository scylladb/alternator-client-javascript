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

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

export function assertDistTagAdvance(candidateVersion, currentVersion) {
  if (semver.valid(candidateVersion) === null) {
    throw new Error(`Invalid candidate version: ${candidateVersion}`);
  }
  if (currentVersion === undefined || currentVersion === "") {
    return;
  }
  if (semver.valid(currentVersion) === null) {
    throw new Error(`Registry dist-tag has an invalid version: ${currentVersion}`);
  }
  if (!semver.gt(candidateVersion, currentVersion)) {
    throw new Error(
      `Refusing to move an npm dist-tag from ${currentVersion} to ${candidateVersion}`,
    );
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  const [candidateVersion, currentVersion] = process.argv.slice(2);
  if (candidateVersion === undefined) {
    throw new Error("Usage: node scripts/check-dist-tag.mjs <candidate> [current]");
  }
  assertDistTagAdvance(candidateVersion, currentVersion);
}
