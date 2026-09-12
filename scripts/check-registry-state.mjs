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

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertDistTagAdvance } from "./check-dist-tag.mjs";

const REQUIRED_ENVIRONMENT = [
  "DIST_TAG",
  "GITHUB_OUTPUT",
  "LOCAL_INTEGRITY",
  "NPM_REGISTRY",
  "PACKAGE_NAME",
  "PACKAGE_VERSION",
  "RUNNER_TEMP",
];

function requiredEnvironment() {
  const values = {};
  for (const name of REQUIRED_ENVIRONMENT) {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is required`);
    }
    values[name] = value;
  }
  return values;
}

function npmView(arguments_) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(executable, ["view", ...arguments_], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function isNotFound(result) {
  return /E404|404 Not Found/.test(`${result.stderr}\n${result.stdout}`);
}

function failView(result) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exitCode = result.status;
}

function writePublishNeeded(outputPath, needed) {
  appendFileSync(outputPath, `publish_needed=${String(needed)}\n`);
}

function main() {
  const environment = requiredEnvironment();
  const packageSpec = `${environment.PACKAGE_NAME}@${environment.PACKAGE_VERSION}`;

  assertDistTagAdvance(environment.PACKAGE_VERSION);

  const integrityView = npmView([
    packageSpec,
    "dist.integrity",
    "--json",
    "--registry",
    environment.NPM_REGISTRY,
  ]);

  if (integrityView.status === 0) {
    const remoteIntegrity = JSON.parse(integrityView.stdout);
    if (typeof remoteIntegrity !== "string" || !remoteIntegrity.startsWith("sha512-")) {
      throw new Error("registry returned invalid package integrity");
    }
    if (remoteIntegrity !== environment.LOCAL_INTEGRITY) {
      throw new Error(
        `${packageSpec} already exists with different integrity.\n` +
        `Local:  ${environment.LOCAL_INTEGRITY}\n` +
        `Remote: ${remoteIntegrity}`,
      );
    }

    console.log(`${packageSpec} already exists with matching integrity; publish will be skipped.`);
    writePublishNeeded(environment.GITHUB_OUTPUT, false);
    return;
  }

  if (!isNotFound(integrityView)) {
    failView(integrityView);
    return;
  }

  const tagView = npmView([
    environment.PACKAGE_NAME,
    `dist-tags.${environment.DIST_TAG}`,
    "--registry",
    environment.NPM_REGISTRY,
  ]);
  let currentVersion = tagView.stdout.trim();
  if (tagView.status !== 0) {
    if (!isNotFound(tagView)) {
      failView(tagView);
      return;
    }
    currentVersion = "";
  }

  assertDistTagAdvance(environment.PACKAGE_VERSION, currentVersion);
  writePublishNeeded(environment.GITHUB_OUTPUT, true);
}

main();
