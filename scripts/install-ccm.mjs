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

import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const CCM_COMMIT = "d15a2fab9d22fffad8a30c806a7c8e1632e58aae";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environmentDirectory = join(repository, "bin", `scylla-ccm-${CCM_COMMIT}`);
const pinnedExecutable = join(environmentDirectory, "bin", "ccm");
const marker = join(environmentDirectory, ".install-complete");
const lockName = `\0alternator-js-ccm-install-${createHash("sha256").update(repository).digest("hex").slice(0, 40)}`;

class CommandCleanupError extends Error {
  constructor(message, failures = []) {
    super(message, failures.length === 0
      ? undefined
      : {
          cause: failures.length === 1
            ? failures[0]
            : new AggregateError(failures, message),
        });
    this.name = "CommandCleanupError";
  }
}

if (process.platform !== "linux") {
  throw new Error("Native scylla-ccm integration currently supports Linux only");
}

const configured = process.env.SCYLLA_CCM_PATH?.trim();
if (configured !== undefined && configured !== "" && resolveCommand(configured) !== pinnedExecutable) {
  const executable = resolveCommand(configured);
  if (!(await ccmWorks(executable))) {
    throw new Error(`SCYLLA_CCM_PATH is not a working CCM executable: ${configured}`);
  }
  process.stdout.write(`Using CCM executable: ${executable}\n`);
} else {
  await mkdir(dirname(environmentDirectory), { recursive: true });
  await validateInstallParent();
  await withInstallLock(async () => {
    if (await installComplete()) {
      process.stdout.write(`Using CCM executable: ${pinnedExecutable}\n`);
      return;
    }
    const uv = resolveCommand("uv");
    if (!(await executableExists(uv))) {
      throw new Error("uv is required to install scylla-ccm: https://docs.astral.sh/uv/");
    }
    assertOwnedInstallPath(environmentDirectory);
    await rm(environmentDirectory, { recursive: true, force: true });
    await mkdir(dirname(environmentDirectory), { recursive: true });
    await run(uv, ["venv", "--clear", environmentDirectory]);
    await run(uv, [
      "pip",
      "install",
      "--python",
      join(environmentDirectory, "bin", "python"),
      `git+https://github.com/scylladb/scylla-ccm.git@${CCM_COMMIT}`,
    ]);
    if (!(await ccmWorks(pinnedExecutable))) {
      throw new Error("Installed CCM entry point failed its launch check");
    }
    const temporary = `${marker}.${process.pid}.tmp`;
    await writeFile(temporary, `${CCM_COMMIT}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, marker);
    process.stdout.write(`Using CCM executable: ${pinnedExecutable}\n`);
  });
}

async function installComplete() {
  try {
    const metadata = await lstat(marker);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (await readFile(marker, "utf8")).trim() === CCM_COMMIT &&
      (await ccmWorks(pinnedExecutable))
    );
  } catch (error) {
    if (error instanceof CommandCleanupError) {
      throw error;
    }
    return false;
  }
}

async function withInstallLock(operation) {
  // A repair can make two ten-minute uv calls plus bounded launch checks and process-group cleanup.
  const deadline = Date.now() + 30 * 60_000;
  let lock;
  while (lock === undefined) {
    try {
      lock = await listenLock();
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for CCM installation lock", {
          cause: error,
        });
      }
      await delay(100);
    }
  }
  try {
    await operation();
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      lock.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    });
  }
}

function listenLock() {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer();
    server.once("error", rejectServer);
    server.listen(lockName, () => {
      server.off("error", rejectServer);
      resolveServer(server);
    });
  });
}

async function ccmWorks(executable) {
  if (!(await executableExists(executable))) {
    return false;
  }
  try {
    await run(executable, ["create", "--help"], { quiet: true, timeoutMs: 30_000 });
    return true;
  } catch (error) {
    if (error instanceof CommandCleanupError) {
      throw error;
    }
    return false;
  }
}

async function executableExists(path) {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function resolveCommand(command) {
  if (isAbsolute(command) || command.includes("/")) {
    return resolve(command);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  return command;
}

function assertOwnedInstallPath(path) {
  const expectedParent = join(repository, "bin");
  if (dirname(path) !== expectedParent || !path.startsWith(`${expectedParent}/scylla-ccm-`)) {
    throw new Error(`Refusing unsafe CCM install path: ${path}`);
  }
}

async function validateInstallParent() {
  const parent = dirname(environmentDirectory);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe CCM install parent: ${parent}`);
  }
  if ((await realpath(parent)) !== parent || (await realpath(repository)) !== repository) {
    throw new Error(`CCM install path must not traverse symbolic links: ${parent}`);
  }
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new Error(`CCM install parent is not owned by current user: ${parent}`);
  }
}

async function run(executable, argumentsList, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  let resolveSignal;
  const interrupted = new Promise((resolveInterrupted) => {
    resolveSignal = resolveInterrupted;
  });
  let receivedSignal;
  const recordSignal = (signal) => {
    receivedSignal ??= signal;
    resolveSignal(signal);
  };
  const onSigint = () => recordSignal("SIGINT");
  const onSigterm = () => recordSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let timer;
  let failure;

  try {
    const child = spawn(executable, argumentsList, {
      detached: true,
      shell: false,
      stdio: options.quiet ? "ignore" : "inherit",
    });
    let closeObserved = false;
    const closed = new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code, signal) => {
        closeObserved = true;
        resolveClose({ code, signal });
      });
    });
    let resolveTimeout;
    const timedOut = new Promise((resolveTimedOut) => {
      resolveTimeout = resolveTimedOut;
    });
    timer = setTimeout(resolveTimeout, timeoutMs, "timeout");
    const outcome = await Promise.race([
      closed.then(
        (value) => ({ kind: "closed", value }),
        (error) => ({ kind: "error", error }),
      ),
      interrupted.then((signal) => ({ kind: "signal", signal })),
      timedOut.then(() => ({ kind: "timeout" })),
    ]);
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    if (outcome.kind === "closed") {
      await finishClosedCommand(
        child.pid,
        outcome.value.code,
        outcome.value.signal,
        executable,
        argumentsList,
      );
    } else {
      await terminateChildProcessGroup(child, closed, () => closeObserved, executable);
      if (outcome.kind === "timeout") {
        throw new Error(`Command timed out: ${executable}`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (receivedSignal !== undefined) {
    if (failure instanceof CommandCleanupError) {
      process.stderr.write(`${failure.stack ?? failure.message}\n`);
    }
    await reraiseSignal(receivedSignal);
  }
  if (failure !== undefined) {
    throw failure;
  }
}

async function reraiseSignal(signal) {
  process.kill(process.pid, signal);
  await new Promise(() => undefined);
}

async function terminateChildProcessGroup(child, closed, closeObserved, executable) {
  try {
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid < 2) {
      throw new CommandCleanupError(`Command has no valid process ID: ${executable}`);
    }
    const failures = [];
    signalGroup(pid, "SIGTERM", failures);
    await waitForGroupEmpty(pid, 2_000);
    if (await groupHasLiveMembers(pid)) {
      signalGroup(pid, "SIGKILL", failures);
      await waitForGroupEmpty(pid, 5_000);
    }
    if (!closeObserved()) {
      await Promise.race([closed, delay(5_000)]);
    }
    if (await groupHasLiveMembers(pid) || !closeObserved()) {
      throw new CommandCleanupError(
        `Command process group survived termination: ${executable}`,
        failures,
      );
    }
    if (failures.length !== 0) {
      throw new CommandCleanupError(
        `Command process group cleanup failed: ${executable}`,
        failures,
      );
    }
  } catch (error) {
    if (error instanceof CommandCleanupError) {
      throw error;
    }
    throw new CommandCleanupError(`Cannot prove command process cleanup: ${executable}`, [error]);
  }
}

async function finishClosedCommand(pid, code, signal, executable, argumentsList) {
  try {
    if (Number.isSafeInteger(pid) && pid >= 2 && (await groupHasLiveMembers(pid))) {
      const failures = [];
      signalGroup(pid, "SIGTERM", failures);
      await waitForGroupEmpty(pid, 2_000);
      if (await groupHasLiveMembers(pid)) {
        signalGroup(pid, "SIGKILL", failures);
        await waitForGroupEmpty(pid, 5_000);
      }
      if ((await groupHasLiveMembers(pid)) || failures.length !== 0) {
        throw new CommandCleanupError(`Command left child processes alive: ${executable}`, failures);
      }
    }
  } catch (error) {
    if (error instanceof CommandCleanupError) {
      throw error;
    }
    throw new CommandCleanupError(`Cannot prove command process cleanup: ${executable}`, [error]);
  }
  if (code !== 0) {
    throw new Error(
      `Command failed (${code === null ? signal : `exit ${code}`}): ${executable} ${argumentsList.join(" ")}`,
    );
  }
}

function signalGroup(pid, signal, failures) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") failures.push(error);
  }
}

async function groupHasLiveMembers(processGroup) {
  const entries = await readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    try {
      const contents = await readFile(`/proc/${entry.name}/stat`, "utf8");
      const closing = contents.lastIndexOf(")");
      const fields = contents.slice(closing + 2).trim().split(/\s+/u);
      if (fields[0] !== "Z" && Number(fields[2]) === processGroup) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function waitForGroupEmpty(processGroup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await groupHasLiveMembers(processGroup)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}
