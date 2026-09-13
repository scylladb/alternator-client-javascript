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

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CCM_COMMIT = "d15a2fab9d22fffad8a30c806a7c8e1632e58aae";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  INTEGRATION_TESTS: "true",
  SCYLLA_VERSION: process.env.SCYLLA_VERSION?.trim() || "release:2025.2.5",
  SCYLLA_CCM_PATH:
    process.env.SCYLLA_CCM_PATH?.trim() ||
    join(repository, "bin", `scylla-ccm-${CCM_COMMIT}`, "bin", "ccm"),
  SCYLLA_CCM_DIAGNOSTICS_DIR:
    process.env.SCYLLA_CCM_DIAGNOSTICS_DIR?.trim() || join(repository, ".ccm-diagnostics"),
};

await requireExecutable("openssl");
await requireExecutable(environment.SCYLLA_CCM_PATH);
await mkdir(environment.SCYLLA_CCM_DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });

const suiteEnvironment = { ...environment };
delete suiteEnvironment.CCM_PROVISIONING_CONTRACTS;

await runNpm("test:integration:provisioning", {
  ...environment,
  CCM_PROVISIONING_CONTRACTS: "true",
});
await runNpm("test:integration:suite", suiteEnvironment);

async function requireExecutable(executable) {
  const candidates =
    isAbsolute(executable) || executable.includes("/")
      ? [resolve(executable)]
      : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return;
    } catch {
      // Try next PATH entry.
    }
  }
  throw new Error(`Required executable is unavailable: ${executable}`);
}

function runNpm(script, childEnvironment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.env.npm_execpath ?? "npm", ["run", script], {
      cwd: repository,
      env: childEnvironment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${script} failed (${code === null ? signal : `exit ${code}`})`));
      }
    });
  });
}
