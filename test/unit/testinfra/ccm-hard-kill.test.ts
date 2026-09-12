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

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { CcmRunState, type ClusterManifest } from "../../testinfra/ccm/run-state.js";
import {
  AlternatorTransport,
  ClusterSpec,
  ClusterTopology,
} from "../../testinfra/ccm/spec.js";

const describeLinux = process.platform === "linux" && process.getuid !== undefined
  ? describe
  : describe.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const helperPath = join(repositoryRoot, "test", "fixtures", "ccm-hard-kill-child.mjs");

interface ReadyState {
  readonly ccmId: number;
  readonly commandLog: string;
  readonly instanceId: string;
  readonly manifestPath: string;
  readonly reservationPath: string;
  readonly runDirectory: string;
  readonly serverPid: number;
  readonly serverStartTicks: string;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
}

describeLinux("CCM-REQ-006 hard-kill recovery", () => {
  it("reaps a marked descendant, preserves diagnostics, and reuses its address ID", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "alternator-js-ccm-hard-kill-"));
    await chmod(temporary, 0o700);
    const root = join(temporary, "state");
    const diagnostics = join(temporary, "diagnostics");
    const coreBundle = join(temporary, "ccm-core.cjs");
    const readyPath = join(temporary, "owner-ready.json");
    const serverReadyPath = join(temporary, "server-ready.json");
    await bundleCore(coreBundle);

    const childEnvironment = { ...process.env };
    delete childEnvironment.SCYLLA_CCM_RUN_DIR;
    const owner = spawn(
      process.execPath,
      [helperPath, "owner", coreBundle, root, readyPath, serverReadyPath],
      {
        cwd: repositoryRoot,
        env: childEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ownerOutput = captureOutput(owner);
    const ownerOutcome = childOutcome(owner);
    let ready: ReadyState | undefined;
    let replacement: CcmRunState | undefined;
    let replacementOwnership:
      | Awaited<ReturnType<CcmRunState["beginCluster"]>>
      | undefined;

    try {
      await waitForFileOrExit(readyPath, owner, ownerOutput, 20_000);
      ready = await readReadyState(readyPath);
      expect(await isRegularFile(ready.manifestPath)).toBe(true);
      expect(await isRegularFile(join(ready.reservationPath, "owner.json"))).toBe(true);
      expect(await readFile(ready.commandLog, "utf8")).toContain("FAKE-CCM-COMMAND create");
      await expect(hasExactRunMarker(ready.serverPid, ready.runDirectory)).resolves.toBe(true);
      await expect(
        isSameLiveProcess(ready.serverPid, ready.serverStartTicks),
      ).resolves.toBe(true);

      expect(owner.kill("SIGKILL")).toBe(true);
      await expect(withTimeout(ownerOutcome, 10_000, "owner process exit")).resolves.toEqual({
        code: null,
        signal: "SIGKILL",
      });
      await expect(
        isSameLiveProcess(ready.serverPid, ready.serverStartTicks),
      ).resolves.toBe(true);

      const copiedDiagnostic = join(diagnostics, ready.instanceId, "ccm-command-hard-kill.log");
      const cleanupCalls: Array<{ readonly runDirectory: string; readonly manifest: ClusterManifest }> = [];
      replacement = await CcmRunState.openDefault(
        async (runDirectory, manifest) => {
          cleanupCalls.push({ runDirectory, manifest });
          expect(
            await isSameLiveProcess(ready!.serverPid, ready!.serverStartTicks),
          ).toBe(false);
          const source = join(
            runDirectory,
            "clusters",
            manifest.instanceId,
            "ccm-command-hard-kill.log",
          );
          await mkdir(dirname(copiedDiagnostic), { recursive: true, mode: 0o700 });
          await copyFile(source, copiedDiagnostic);
          expect(await readFile(copiedDiagnostic, "utf8")).toContain("FAKE-CCM-COMMAND create");
          await rm(join(runDirectory, "clusters", manifest.instanceId), {
            recursive: true,
            force: false,
          });
        },
        { root },
      );

      expect(cleanupCalls).toHaveLength(1);
      expect(cleanupCalls[0]!.runDirectory).toBe(ready.runDirectory);
      expect(cleanupCalls[0]!.manifest).toMatchObject({
        ccmId: ready.ccmId,
        instanceId: ready.instanceId,
      });
      await expect(pathExists(ready.runDirectory)).resolves.toBe(false);
      await expect(pathExists(ready.reservationPath)).resolves.toBe(false);
      await waitForProcessExit(ready.serverPid, ready.serverStartTicks, 10_000);
      await expect(readFile(copiedDiagnostic, "utf8")).resolves.toContain(
        "FAKE-CCM-COMMAND create",
      );

      replacementOwnership = await replacement.beginCluster(
        "alternator-js-hard-kill-replacement",
        oneNodeHttpSpec(),
        false,
      );
      expect(replacementOwnership.ccmId).toBe(ready.ccmId);
      await replacement.completeCluster(replacementOwnership);
      replacementOwnership = undefined;
      await replacement.close();
      replacement = undefined;
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
        await withTimeout(ownerOutcome, 10_000, "fixture owner cleanup").catch(() => undefined);
      }
      const serverIdentity = ready === undefined
        ? await readProcessIdentity(serverReadyPath).catch(() => undefined)
        : { pid: ready.serverPid, startTicks: ready.serverStartTicks };
      if (
        serverIdentity !== undefined &&
        (await isSameLiveProcess(serverIdentity.pid, serverIdentity.startTicks))
      ) {
        process.kill(serverIdentity.pid, "SIGKILL");
        await waitForProcessExit(serverIdentity.pid, serverIdentity.startTicks, 10_000).catch(
          () => undefined,
        );
      }
      if (replacement !== undefined) {
        if (replacementOwnership !== undefined) {
          await replacement.completeCluster(replacementOwnership).catch(() => undefined);
        }
        await replacement.close().catch(() => undefined);
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }, 40_000);
});

async function bundleCore(outputPath: string): Promise<void> {
  await build({
    bundle: true,
    format: "cjs",
    outfile: outputPath,
    platform: "node",
    stdin: {
      contents:
        'export { CcmRunState } from "./test/testinfra/ccm/run-state.ts";\n' +
        'export { AlternatorTransport, ClusterSpec, ClusterTopology } from "./test/testinfra/ccm/spec.ts";\n',
      loader: "ts",
      resolveDir: repositoryRoot,
      sourcefile: "ccm-hard-kill-core.ts",
    },
    target: "node22",
  });
}

function oneNodeHttpSpec(): ClusterSpec {
  return new ClusterSpec()
    .withTopology(ClusterTopology.singleDatacenter(1))
    .withTransports(AlternatorTransport.HTTP);
}

function captureOutput(child: ChildProcess): () => string {
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  return () => output;
}

function childOutcome(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    child.once("error", rejectOutcome);
    child.once("close", (code, signal) => resolveOutcome({ code, signal }));
  });
}

async function waitForFileOrExit(
  path: string,
  child: ChildProcess,
  output: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(path)) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`CCM owner fixture exited before readiness:\n${output()}`);
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for CCM owner fixture:\n${output()}`);
}

async function readReadyState(path: string): Promise<ReadyState> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    !isPositiveInteger(parsed.ccmId) ||
    typeof parsed.commandLog !== "string" ||
    typeof parsed.instanceId !== "string" ||
    typeof parsed.manifestPath !== "string" ||
    typeof parsed.reservationPath !== "string" ||
    typeof parsed.runDirectory !== "string" ||
    !isPositiveInteger(parsed.serverPid) ||
    typeof parsed.serverStartTicks !== "string"
  ) {
    throw new Error(`Malformed CCM owner fixture state: ${path}`);
  }
  return parsed as unknown as ReadyState;
}

async function readProcessIdentity(path: string): Promise<ProcessIdentity> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    !isPositiveInteger(parsed.pid) ||
    typeof parsed.startTicks !== "string" ||
    !/^[0-9]+$/u.test(parsed.startTicks)
  ) {
    throw new Error(`Malformed CCM server fixture state: ${path}`);
  }
  return parsed as unknown as ProcessIdentity;
}

async function hasExactRunMarker(pid: number, runDirectory: string): Promise<boolean> {
  const environment = (await readFile(`/proc/${pid}/environ`)).toString("utf8").split("\0");
  return environment.includes(`SCYLLA_CCM_RUN_DIR=${runDirectory}`);
}

async function waitForProcessExit(
  pid: number,
  startTicks: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSameLiveProcess(pid, startTicks))) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Process ${pid} did not terminate`);
}

async function isSameLiveProcess(pid: number, startTicks: string): Promise<boolean> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = contents.lastIndexOf(")");
    if (closing < 0) {
      return false;
    }
    const fields = contents.slice(closing + 2).trim().split(/\s+/u);
    return fields[0] !== "Z" && fields[19] === startTicks;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => Promise.reject(new Error(`Timed out waiting for ${description}`))),
  ]);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
