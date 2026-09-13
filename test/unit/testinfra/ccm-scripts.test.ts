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
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CCM_COMMIT = "d15a2fab9d22fffad8a30c806a7c8e1632e58aae";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();
const describeLinux = process.platform === "linux" ? describe : describe.skip;

afterEach(async () => {
  for (const pid of fixturePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!isNodeError(error, "ESRCH")) {
        throw error;
      }
    }
  }
  fixturePids.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describeLinux("CCM installer contract", () => {
  it("reuses a working pinned cache without invoking uv", async () => {
    const harness = await createInstallerHarness("cached");
    await seedWorkingInstallation(harness);

    const result = await runInstaller(harness);

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toContain(`Using CCM executable: ${harness.pinnedCcm}`);
    expect(await readJsonLines(harness.ccmCapture)).toEqual([["create", "--help"]]);
    await expect(readFile(harness.uvCapture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves and validates a custom CCM executable from PATH", async () => {
    const harness = await createInstallerHarness("custom-path");
    const customCcm = join(harness.toolsDirectory, "custom-ccm");
    const customCcmTarget = join(harness.toolsDirectory, "custom-ccm-target");
    await writeExecutable(customCcmTarget, recordingExecutableSource(harness.ccmCapture));
    await symlink(customCcmTarget, customCcm);

    const result = await runInstaller(harness, {
      SCYLLA_CCM_PATH: basename(customCcm),
    });

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout).toContain(`Using CCM executable: ${customCcm}`);
    expect(await readJsonLines(harness.ccmCapture)).toEqual([["create", "--help"]]);
  });

  it("repairs a broken pinned cache through exact fake-uv argv", async () => {
    const harness = await createInstallerHarness("repair");
    await mkdir(dirname(harness.pinnedCcm), { recursive: true, mode: 0o700 });
    await writeExecutable(harness.pinnedCcm, nodeSource("process.exitCode = 9;"));
    await writeFile(harness.marker, `${CCM_COMMIT}\n`, { encoding: "utf8", mode: 0o600 });
    await installFakeUv(harness);

    const result = await runInstaller(harness);

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(await readJsonLines(harness.uvCapture)).toEqual([
      ["venv", "--clear", harness.environmentDirectory],
      [
        "pip",
        "install",
        "--python",
        join(harness.environmentDirectory, "bin", "python"),
        `git+https://github.com/scylladb/scylla-ccm.git@${CCM_COMMIT}`,
      ],
    ]);
    expect((await readFile(harness.marker, "utf8")).trim()).toBe(CCM_COMMIT);
    expect(await readJsonLines(harness.ccmCapture)).toEqual([["create", "--help"]]);
  });

  it("serializes concurrent installation so uv runs only once", async () => {
    const harness = await createInstallerHarness("concurrent");
    await installFakeUv(harness, 150);

    const [first, second] = await Promise.all([
      runInstaller(harness),
      runInstaller(harness),
    ]);

    expect(first).toMatchObject({ code: 0, timedOut: false });
    expect(second).toMatchObject({ code: 0, timedOut: false });
    const uvCalls = await readJsonLines(harness.uvCapture);
    expect(uvCalls.filter((entry) => entry[0] === "venv")).toHaveLength(1);
    expect(uvCalls.filter((entry) => entry[0] === "pip")).toHaveLength(1);
    expect((await readFile(harness.marker, "utf8")).trim()).toBe(CCM_COMMIT);
  });

  it("passes custom executable paths and arguments directly without shell parsing", async () => {
    const harness = await createInstallerHarness("direct-argv");
    const sentinel = join(harness.repository, "shell-was-used");
    const customCcm = join(
      harness.toolsDirectory,
      `custom ccm;touch ${basename(sentinel)}`,
    );
    await writeExecutable(customCcm, recordingExecutableSource(harness.ccmCapture));

    const result = await runInstaller(harness, { SCYLLA_CCM_PATH: customCcm });

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(await readJsonLines(harness.ccmCapture)).toEqual([["create", "--help"]]);
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out and kills a Node fixture parent plus grandchild without hanging", async () => {
    const harness = await createInstallerHarness("timeout");
    const hangingCcm = join(harness.toolsDirectory, "hanging-ccm");
    const pidCapture = join(harness.toolsDirectory, "pids.json");
    const timeoutHook = join(harness.toolsDirectory, "short-timeout-hook.mjs");
    await writeExecutable(hangingCcm, hangingExecutableSource(pidCapture));
    await writeFile(timeoutHook, timeoutHookSource(), { encoding: "utf8", mode: 0o600 });

    const startedAt = Date.now();
    const result = await runInstaller(
      harness,
      { SCYLLA_CCM_PATH: hangingCcm },
      ["--import", timeoutHook],
      8_000,
    );
    const durationMs = Date.now() - startedAt;
    const pids = JSON.parse(await readFile(pidCapture, "utf8")) as unknown;
    if (!isPositivePidArray(pids)) {
      throw new Error("Hanging CCM fixture did not capture valid process IDs");
    }
    for (const pid of pids) {
      fixturePids.add(pid);
    }
    await waitForProcessesToStop(pids);

    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(durationMs).toBeLessThan(8_000);
    expect(result.stderr).toContain("SCYLLA_CCM_PATH is not a working CCM executable");
    for (const pid of pids) {
      await expect(isLiveProcess(pid)).resolves.toBe(false);
      fixturePids.delete(pid);
    }
  }, 12_000);

  it.each(["SIGINT", "SIGTERM"] as const)(
    "reaps a detached command before exiting on repeated %s",
    async (signal) => {
      const harness = await createInstallerHarness(`signal-${signal.toLowerCase()}`);
      const hangingCcm = join(harness.toolsDirectory, "hanging-ccm");
      const pidCapture = join(harness.toolsDirectory, "pids.json");
      await writeExecutable(hangingCcm, hangingExecutableSource(pidCapture));

      const result = await runInstaller(
        harness,
        { SCYLLA_CCM_PATH: hangingCcm },
        [],
        10_000,
        { readyPath: pidCapture, signal },
      );
      const pids = JSON.parse(await readFile(pidCapture, "utf8")) as unknown;
      if (!isPositivePidArray(pids)) {
        throw new Error("Signalled CCM fixture did not capture valid process IDs");
      }
      for (const pid of pids) {
        fixturePids.add(pid);
      }
      await waitForProcessesToStop(pids);

      expect(result).toMatchObject({ code: null, signal, timedOut: false });
      for (const pid of pids) {
        await expect(isLiveProcess(pid)).resolves.toBe(false);
        fixturePids.delete(pid);
      }
    },
    15_000,
  );

  it("does not downgrade unproven command cleanup to a broken executable", async () => {
    const harness = await createInstallerHarness("cleanup-failure");
    const pidCapture = join(harness.toolsDirectory, "pids.json");
    const cleanupHook = join(harness.toolsDirectory, "cleanup-failure-hook.mjs");
    await mkdir(dirname(harness.pinnedCcm), { recursive: true, mode: 0o700 });
    await writeExecutable(harness.pinnedCcm, orphaningExecutableSource(pidCapture));
    await writeFile(harness.marker, `${CCM_COMMIT}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(cleanupHook, cleanupFailureHookSource(), { encoding: "utf8", mode: 0o600 });

    const result = await runInstaller(
      harness,
      {},
      ["--import", cleanupHook],
      12_000,
    );
    const pids = JSON.parse(await readFile(pidCapture, "utf8")) as unknown;
    if (!isPositivePidArray(pids)) {
      throw new Error("Cleanup-failure fixture did not capture valid process IDs");
    }
    for (const pid of pids) {
      fixturePids.add(pid);
    }

    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("CommandCleanupError");
    expect(result.stderr).not.toContain("is not a working CCM executable");
    await expect(readFile(harness.marker, "utf8")).resolves.toBe(`${CCM_COMMIT}\n`);
    await expect(readFile(harness.uvCapture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

describeLinux("integration phase runner contract", () => {
  it("runs provisioning then suite with direct argv and a phase-scoped environment", async () => {
    const harness = await createRunnerHarness("success");

    const result = await runIntegrationRunner(harness, {
      CCM_PROVISIONING_CONTRACTS: "yes",
    });

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(await readRecords(harness.npmCapture)).toEqual([
      {
        argv: ["run", "test:integration:provisioning"],
        integrationTests: "true",
        provisioningContracts: "true",
        scyllaVersion: "release:2025.2.5",
        ccmPath: harness.ccmExecutable,
      },
      {
        argv: ["run", "test:integration:suite"],
        integrationTests: "true",
        provisioningContracts: null,
        scyllaVersion: "release:2025.2.5",
        ccmPath: harness.ccmExecutable,
      },
    ]);
  });

  it.each([
    { phase: "test:integration:provisioning", expectedCalls: 1 },
    { phase: "test:integration:suite", expectedCalls: 2 },
  ])("propagates failure from $phase", async ({ phase, expectedCalls }) => {
    const harness = await createRunnerHarness(`fail-${expectedCalls}`);

    const result = await runIntegrationRunner(harness, { FAIL_PHASE: phase });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${phase} failed (exit 23)`);
    expect(await readRecords(harness.npmCapture)).toHaveLength(expectedCalls);
  });
});

describe("repository orchestration files", () => {
  it("contains no shell-script files", async () => {
    const shellScripts: string[] = [];
    await walkRepository(repositoryRoot, async (path) => {
      if ([".sh", ".bash", ".zsh", ".ksh"].includes(extname(path))) {
        shellScripts.push(path);
        return;
      }
      const contents = await readFile(path, "utf8").catch(() => "");
      if (/^#![^\n]*(?:\/|\s)(?:ba|z|k|da)?sh(?:\s|$)/u.test(contents)) {
        shellScripts.push(path);
      }
    });

    expect(shellScripts).toEqual([]);
  });
});

interface InstallerHarness {
  readonly repository: string;
  readonly installer: string;
  readonly toolsDirectory: string;
  readonly environmentDirectory: string;
  readonly pinnedCcm: string;
  readonly marker: string;
  readonly ccmCapture: string;
  readonly uvCapture: string;
}

interface RunnerHarness {
  readonly repository: string;
  readonly runner: string;
  readonly toolsDirectory: string;
  readonly npmExecutable: string;
  readonly npmCapture: string;
  readonly ccmExecutable: string;
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function createInstallerHarness(label: string): Promise<InstallerHarness> {
  const repository = await createScriptRepository("install-ccm.mjs", `installer-${label}`);
  const toolsDirectory = join(repository, "fixture tools");
  await mkdir(toolsDirectory, { mode: 0o700 });
  const environmentDirectory = join(repository, "bin", `scylla-ccm-${CCM_COMMIT}`);
  return {
    repository,
    installer: join(repository, "scripts", "install-ccm.mjs"),
    toolsDirectory,
    environmentDirectory,
    pinnedCcm: join(environmentDirectory, "bin", "ccm"),
    marker: join(environmentDirectory, ".install-complete"),
    ccmCapture: join(toolsDirectory, "ccm.jsonl"),
    uvCapture: join(toolsDirectory, "uv.jsonl"),
  };
}

async function createRunnerHarness(label: string): Promise<RunnerHarness> {
  const repository = await createScriptRepository("run-integration.mjs", `runner-${label}`);
  const toolsDirectory = join(repository, "fixture tools; no shell");
  await mkdir(toolsDirectory, { mode: 0o700 });
  const npmCapture = join(toolsDirectory, "npm.jsonl");
  const npmExecutable = join(toolsDirectory, "fake npm.mjs");
  const ccmExecutable = join(toolsDirectory, "fake ccm.mjs");
  await writeExecutable(join(toolsDirectory, "openssl"), nodeSource("process.exitCode = 0;"));
  await writeExecutable(ccmExecutable, nodeSource("process.exitCode = 0;"));
  await writeExecutable(npmExecutable, npmFixtureSource(npmCapture));
  return {
    repository,
    runner: join(repository, "scripts", "run-integration.mjs"),
    toolsDirectory,
    npmExecutable,
    npmCapture,
    ccmExecutable,
  };
}

async function createScriptRepository(scriptName: string, label: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), `alternator-js-${label}-`));
  temporaryDirectories.push(repository);
  await chmod(repository, 0o700);
  await mkdir(join(repository, "scripts"), { mode: 0o700 });
  await copyFile(join(repositoryRoot, "scripts", scriptName), join(repository, "scripts", scriptName));
  return repository;
}

async function seedWorkingInstallation(harness: InstallerHarness): Promise<void> {
  await mkdir(dirname(harness.pinnedCcm), { recursive: true, mode: 0o700 });
  await writeExecutable(harness.pinnedCcm, recordingExecutableSource(harness.ccmCapture));
  await writeFile(harness.marker, `${CCM_COMMIT}\n`, { encoding: "utf8", mode: 0o600 });
}

async function installFakeUv(harness: InstallerHarness, operationDelayMs = 0): Promise<void> {
  await writeExecutable(
    join(harness.toolsDirectory, "uv"),
    fakeUvSource(harness, operationDelayMs),
  );
}

function runInstaller(
  harness: InstallerHarness,
  environment: NodeJS.ProcessEnv = {},
  nodeArguments: readonly string[] = [],
  timeoutMs = 10_000,
  signalAfterReady?: {
    readonly readyPath: string;
    readonly signal: NodeJS.Signals;
  },
): Promise<ChildResult> {
  return runNode(harness.installer, {
    cwd: harness.repository,
    nodeArguments,
    timeoutMs,
    environment: {
      ...process.env,
      PATH: pathWithTools(harness.toolsDirectory),
      ...environment,
    },
    ...(signalAfterReady === undefined ? {} : { signalAfterReady }),
  });
}

function runIntegrationRunner(
  harness: RunnerHarness,
  environment: NodeJS.ProcessEnv = {},
): Promise<ChildResult> {
  return runNode(harness.runner, {
    cwd: harness.repository,
    environment: {
      ...process.env,
      PATH: pathWithTools(harness.toolsDirectory),
      npm_execpath: harness.npmExecutable,
      SCYLLA_CCM_PATH: harness.ccmExecutable,
      SCYLLA_CCM_DIAGNOSTICS_DIR: join(harness.repository, "diagnostics"),
      ...environment,
    },
  });
}

function runNode(
  script: string,
  options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly nodeArguments?: readonly string[];
    readonly signalAfterReady?: {
      readonly readyPath: string;
      readonly signal: NodeJS.Signals;
    };
    readonly timeoutMs?: number;
  },
): Promise<ChildResult> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [...(options.nodeArguments ?? []), script], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (options.signalAfterReady !== undefined) {
      void waitForFile(options.signalAfterReady.readyPath, 5_000).then(
        () => {
          child.kill(options.signalAfterReady!.signal);
          setTimeout(() => child.kill(options.signalAfterReady!.signal), 20);
        },
        rejectChild,
      );
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectChild);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 10_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveChild({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isFile()) {
        return;
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, source, { encoding: "utf8", mode: 0o700 });
  await chmod(path, 0o700);
}

function nodeSource(body: string): string {
  return `#!${process.execPath}\n${body}\n`;
}

function recordingExecutableSource(capture: string): string {
  return nodeSource(`
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
}

function fakeUvSource(harness: InstallerHarness, operationDelayMs: number): string {
  const installedCcm = recordingExecutableSource(harness.ccmCapture);
  return nodeSource(`
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(harness.uvCapture)}, JSON.stringify(argv) + "\\n");
if (${operationDelayMs} > 0) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ${operationDelayMs}));
}
if (argv[0] === "venv") {
  const target = argv[2];
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "bin", "python"), "", { mode: 0o700 });
} else if (argv[0] === "pip") {
  const executable = ${JSON.stringify(harness.pinnedCcm)};
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  writeFileSync(executable, ${JSON.stringify(installedCcm)}, { mode: 0o700 });
  chmodSync(executable, 0o700);
} else {
  process.exitCode = 41;
}
`);
}

function hangingExecutableSource(pidCapture: string): string {
  return nodeSource(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidCapture)}, JSON.stringify([process.pid, grandchild.pid]));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
}

function orphaningExecutableSource(pidCapture: string): string {
  return nodeSource(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
], { stdio: "ignore" });
grandchild.unref();
writeFileSync(${JSON.stringify(pidCapture)}, JSON.stringify([process.pid, grandchild.pid]));
`);
}

function timeoutHookSource(): string {
  return `
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...argumentsList) =>
  originalSetTimeout(callback, milliseconds === 30_000 ? 100 : milliseconds, ...argumentsList);
`;
}

function cleanupFailureHookSource(): string {
  return `
const originalKill = process.kill;
process.kill = (pid, signal) => {
  if (pid < 0) {
    throw Object.assign(new Error("fixture cannot signal process group"), { code: "EPERM" });
  }
  return originalKill(pid, signal);
};
`;
}

function npmFixtureSource(capture: string): string {
  return nodeSource(`
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv,
  integrationTests: process.env.INTEGRATION_TESTS ?? null,
  provisioningContracts: process.env.CCM_PROVISIONING_CONTRACTS ?? null,
  scyllaVersion: process.env.SCYLLA_VERSION ?? null,
  ccmPath: process.env.SCYLLA_CCM_PATH ?? null,
}) + "\\n");
if (process.env.FAIL_PHASE === argv[1]) process.exitCode = 23;
`);
}

function pathWithTools(toolsDirectory: string): string {
  return `${toolsDirectory}:${process.env.PATH ?? ""}`;
}

async function readJsonLines(path: string): Promise<string[][]> {
  const records = await readRecords(path);
  if (!records.every((record) => Array.isArray(record) && record.every((item) => typeof item === "string"))) {
    throw new Error(`Expected string-array records in ${path}`);
  }
  return records;
}

async function readRecords(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function waitForProcessesToStop(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await Promise.all(pids.map(isLiveProcess))).every((live) => !live)) {
      return;
    }
    await delay(20);
  }
}

async function isLiveProcess(pid: number): Promise<boolean> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = contents.lastIndexOf(")");
    return closing < 0 || contents[closing + 2] !== "Z";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isPositivePidArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 2 && value.every(
    (pid) => typeof pid === "number" && Number.isSafeInteger(pid) && pid >= 2,
  );
}

async function walkRepository(
  directory: string,
  visit: (path: string) => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "bin", ".ccm-diagnostics"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkRepository(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
