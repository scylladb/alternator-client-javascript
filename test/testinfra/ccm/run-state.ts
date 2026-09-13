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

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AlternatorTransport, ClusterSpec } from "./spec.js";

const FORMAT_VERSION = 1;
const RUN_NAME_PATTERN = /^ccm-runtime\.[0-9a-f]{32}$/u;
const INSTANCE_NAME_PATTERN = /^alternator-js-[a-zA-Z0-9_-]+$/u;
const LOCK_WAIT_MS = 12 * 60_000;
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 5_000;
const MAXIMUM_METADATA_BYTES = 16_384;
const ADDRESS_PORTS = [7000, 9042, 9180, 10_000, 19_042] as const;
const OWNER_STAGING_PATTERN = /^\.owner\.json\.[0-9a-f]{16}\.tmp$/u;
const MANIFEST_STAGING_PATTERN =
  /^\.alternator-js-[a-zA-Z0-9_-]+\.json\.[0-9a-f]{16}\.tmp$/u;

interface ProcessOwner {
  readonly formatVersion: number;
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
  readonly uid: number;
  readonly token: string;
  readonly runDirectory: string;
}

export interface ClusterManifest {
  readonly formatVersion: number;
  readonly instanceId: string;
  readonly ccmId: number;
  readonly token: string;
  readonly createdAt: string;
}

interface ReservationOwner {
  readonly formatVersion: number;
  readonly runName: string;
  readonly instanceId: string;
  readonly token: string;
}

interface MarkedProcess {
  readonly pid: number;
  readonly startTicks: string;
}

export interface ClusterOwnership {
  readonly instanceId: string;
  readonly ccmId: number;
  readonly token: string;
}

export type StaleClusterCleanup = (
  runDirectory: string,
  manifest: ClusterManifest,
) => Promise<void>;

export interface CcmRunStateOptions {
  readonly root?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export class CcmRunState {
  readonly rootDirectory: string;
  readonly runDirectory: string;
  readonly runMarker: string;

  private readonly runsDirectory: string;
  private readonly reservationsDirectory: string;
  private readonly cleanupStaleCluster: StaleClusterCleanup;
  private readonly owner: ProcessOwner;
  private readonly mutex = new AsyncMutex();
  private readonly ownerships = new Map<string, ClusterOwnership>();
  private incompleteOwnership = false;
  private closed = false;

  private constructor(
    rootDirectory: string,
    runDirectory: string,
    cleanupStaleCluster: StaleClusterCleanup,
    owner: ProcessOwner,
  ) {
    this.rootDirectory = rootDirectory;
    this.runsDirectory = join(rootDirectory, "runs");
    this.reservationsDirectory = join(rootDirectory, "reservations");
    this.runDirectory = runDirectory;
    this.runMarker = runDirectory;
    this.cleanupStaleCluster = cleanupStaleCluster;
    this.owner = owner;
  }

  static async openDefault(
    cleanupStaleCluster: StaleClusterCleanup,
    options: CcmRunStateOptions = {},
  ): Promise<CcmRunState> {
    requireLinux();
    const environment = options.environment ?? process.env;
    const uid = currentUid();
    const configuredRoot = options.root ?? environment.SCYLLA_CCM_ROOT;
    const requestedRoot =
      configuredRoot === undefined || configuredRoot.trim() === ""
        ? join(tmpdir(), `alternator-client-javascript-ccm-${uid}`)
        : configuredRoot;
    const root = await prepareRoot(requestedRoot, uid);
    const runs = join(root, "runs");
    const reservations = join(root, "reservations");
    await prepareOwnedDirectory(runs, uid);
    await prepareOwnedDirectory(reservations, uid);

    let createdRun: { path: string; owner: ProcessOwner } | undefined;
    await withRootLock(root, async () => {
      const quarantinedIds = new Set<number>();
      await recoverRuns(root, runs, reservations, cleanupStaleCluster, uid, quarantinedIds);
      await removeOrphanReservations(runs, reservations, quarantinedIds);
      createdRun = await createRun(runs, uid);
    });
    if (createdRun === undefined) {
      throw new Error("Failed to create CCM run state");
    }
    return new CcmRunState(root, createdRun.path, cleanupStaleCluster, createdRun.owner);
  }

  async beginCluster(
    instanceId: string,
    spec: ClusterSpec,
    includeJmxPort: boolean,
  ): Promise<ClusterOwnership> {
    return this.mutex.run(async () => {
      this.throwIfClosed();
      if (!INSTANCE_NAME_PATTERN.test(instanceId)) {
        throw new Error(`Unsafe CCM cluster instance name: ${instanceId}`);
      }
      spec.validate();
      return withRootLock(this.rootDirectory, async () => {
        await this.validateCurrentRun();
        const manifests = await this.readCurrentManifests();
        if (manifests.length !== 0) {
          throw new Error("This CCM run already owns a physical cluster");
        }

        for (let id = 1; id < 100; id++) {
          const reservation = join(this.reservationsDirectory, String(id));
          try {
            await mkdir(reservation, { mode: 0o700 });
          } catch (error) {
            if (isNodeError(error, "EEXIST")) {
              continue;
            }
            throw error;
          }

          const token = randomBytes(16).toString("hex");
          try {
            if (!(await isAddressRangeAvailable(spec, id, includeJmxPort))) {
              await rm(reservation, { recursive: true, force: false });
              continue;
            }
            const reservationOwner: ReservationOwner = {
              formatVersion: FORMAT_VERSION,
              runName: basename(this.runDirectory),
              instanceId,
              token,
            };
            await writeJsonAtomic(join(reservation, "owner.json"), reservationOwner);
            const manifest: ClusterManifest = {
              formatVersion: FORMAT_VERSION,
              instanceId,
              ccmId: id,
              token,
              createdAt: new Date().toISOString(),
            };
            await writeJsonAtomic(this.manifestPath(instanceId), manifest);
            const ownership = { instanceId, ccmId: id, token };
            this.ownerships.set(token, ownership);
            return ownership;
          } catch (error) {
            try {
              await rm(reservation, { recursive: true, force: true });
            } catch (cleanupError) {
              this.incompleteOwnership = true;
              throw new AggregateError(
                [asError(error), asError(cleanupError)],
                "Failed to publish and roll back CCM cluster ownership",
              );
            }
            throw asError(error);
          }
        }
        throw new Error("No CCM cluster IDs are available");
      });
    });
  }

  async completeCluster(ownership: ClusterOwnership): Promise<void> {
    await this.mutex.run(async () => {
      await withRootLock(this.rootDirectory, async () => {
        await this.validateCurrentRun();
        const active = this.ownerships.get(ownership.token);
        if (
          active === undefined ||
          active.instanceId !== ownership.instanceId ||
          active.ccmId !== ownership.ccmId
        ) {
          throw new Error("CCM cluster handle is not owned by this run");
        }
        const manifestPath = this.manifestPath(ownership.instanceId);
        const manifestExists = await pathExists(manifestPath);
        if (manifestExists) {
          const manifest = await readManifest(manifestPath);
          if (
            manifest.ccmId !== ownership.ccmId ||
            manifest.token !== ownership.token ||
            manifest.instanceId !== ownership.instanceId
          ) {
            throw new Error("CCM cluster ownership token does not match durable state");
          }
        }
        await assertClusterConfigRetired(this.runDirectory, ownership.instanceId);
        const reservation = join(this.reservationsDirectory, String(ownership.ccmId));
        if (!(await pathExists(reservation))) {
          if (manifestExists) {
            throw new Error("CCM address reservation disappeared before manifest retirement");
          }
          this.ownerships.delete(ownership.token);
          return;
        }
        const reservationOwner = await readReservation(join(reservation, "owner.json"));
        if (
          reservationOwner.runName !== basename(this.runDirectory) ||
          reservationOwner.instanceId !== ownership.instanceId ||
          reservationOwner.token !== ownership.token
        ) {
          throw new Error("CCM address reservation does not match durable cluster ownership");
        }
        await rm(manifestPath, { force: true });
        await rm(reservation, { recursive: true, force: false });
        this.ownerships.delete(ownership.token);
      });
    });
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.closed) {
        return;
      }
      if (this.ownerships.size !== 0) {
        throw new Error("Cannot close CCM run state while a cluster remains owned");
      }
      if (this.incompleteOwnership) {
        throw new Error("Cannot close CCM run state with incomplete ownership publication");
      }
      await withRootLock(this.rootDirectory, async () => {
        await this.validateCurrentRun();
        if ((await this.readCurrentManifests()).length !== 0) {
          throw new Error("Cannot close CCM run state while a cluster remains owned");
        }
        await rm(this.runDirectory, { recursive: true, force: false });
      });
      this.closed = true;
    });
  }

  private manifestPath(instanceId: string): string {
    return join(this.runDirectory, "owned", `${instanceId}.json`);
  }

  private async readCurrentManifests(): Promise<ClusterManifest[]> {
    return readManifests(join(this.runDirectory, "owned"));
  }

  private async validateCurrentRun(): Promise<void> {
    await validateOwnedDirectory(this.runDirectory, currentUid());
    const owner = await readOwner(join(this.runDirectory, "owner.json"));
    if (
      owner.token !== this.owner.token ||
      owner.pid !== this.owner.pid ||
      owner.startTicks !== this.owner.startTicks ||
      owner.bootId !== this.owner.bootId
    ) {
      throw new Error("CCM run ownership changed unexpectedly");
    }
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new Error("The CCM run state is closed");
    }
  }
}

export async function isAddressRangeAvailable(
  spec: ClusterSpec,
  id: number,
  includeJmxPort: boolean,
): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1 || id > 99) {
    throw new Error(`Invalid CCM ID ${id}`);
  }
  const ports: number[] = [...ADDRESS_PORTS];
  if (spec.hasTransport(AlternatorTransport.HTTP)) {
    ports.push(8080);
  }
  if (spec.hasTransport(AlternatorTransport.HTTPS)) {
    ports.push(8043);
  }
  if (includeJmxPort) {
    ports.push(7199);
  }

  for (let node = 1; node <= 9; node++) {
    const host = `127.0.${id}.${node}`;
    for (const port of ports) {
      if (!(await canBind(host, port))) {
        return false;
      }
    }
  }
  return true;
}

async function createRun(
  runsDirectory: string,
  uid: number,
): Promise<{ path: string; owner: ProcessOwner }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const runName = `ccm-runtime.${randomUUID().replaceAll("-", "")}`;
    const runDirectory = join(runsDirectory, runName);
    try {
      await mkdir(runDirectory, { mode: 0o700 });
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
    try {
      await mkdir(join(runDirectory, "owned"), { mode: 0o700 });
      const owner = await currentOwner(runDirectory, uid);
      await writeJsonAtomic(join(runDirectory, "owner.json"), owner);
      return { path: runDirectory, owner };
    } catch (error) {
      await rm(runDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("Unable to allocate a unique CCM run directory");
}

async function recoverRuns(
  root: string,
  runsDirectory: string,
  reservationsDirectory: string,
  cleanup: StaleClusterCleanup,
  uid: number,
  quarantinedIds: Set<number>,
): Promise<void> {
  const entries = await readdir(runsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const runDirectory = join(runsDirectory, entry.name);
    let owner: ProcessOwner | undefined;
    try {
      await validateOwnedDirectory(runDirectory, uid);
      await removeAtomicStagingFiles(runDirectory, OWNER_STAGING_PATTERN, uid);
      try {
        owner = await readOwner(join(runDirectory, "owner.json"));
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
      if (owner !== undefined) {
        if (owner.runDirectory !== runDirectory) {
          throw new Error(`CCM owner path does not match run directory: ${runDirectory}`);
        }
        if (owner.uid !== uid) {
          throw new Error(`CCM owner UID does not match run directory owner: ${runDirectory}`);
        }
      }
    } catch (error) {
      await quarantineReadableManifests(
        join(runDirectory, "owned"),
        reservationsDirectory,
        entry.name,
        uid,
        quarantinedIds,
      );
      console.warn(`Preserving malformed CCM run ${runDirectory}: ${errorMessage(error)}`);
      continue;
    }
    if (owner === undefined) {
      let publishedState: boolean;
      try {
        publishedState = await ownerlessRunHasPublishedState(
          runDirectory,
          reservationsDirectory,
          entry.name,
          uid,
        );
      } catch (error) {
        console.warn(
          `Preserving ownerless CCM run with uninspectable state ${runDirectory}: ${errorMessage(error)}`,
        );
        continue;
      }
      if (publishedState) {
        await quarantineReadableManifests(
          join(runDirectory, "owned"),
          reservationsDirectory,
          entry.name,
          uid,
          quarantinedIds,
        );
        console.warn(`Preserving ownerless CCM run with published state ${runDirectory}`);
      } else {
        try {
          validateDescendant(root, runDirectory);
          await rm(runDirectory, { recursive: true, force: false });
        } catch (error) {
          console.warn(
            `Preserving unremovable unpublished CCM run ${runDirectory}: ${errorMessage(error)}`,
          );
        }
      }
      continue;
    }
    try {
      if (await ownerIsActive(owner)) {
        continue;
      }
    } catch (error) {
      await quarantineReadableManifests(
        join(runDirectory, "owned"),
        reservationsDirectory,
        entry.name,
        uid,
        quarantinedIds,
      );
      console.warn(
        `Preserving CCM run with an uninspectable owner ${runDirectory}: ${errorMessage(error)}`,
      );
      continue;
    }

    try {
      await terminateMarkedProcesses(runDirectory, uid);
      const ownedDirectory = join(runDirectory, "owned");
      await removeAtomicStagingFiles(ownedDirectory, MANIFEST_STAGING_PATTERN, uid);
      const manifests = await readManifests(ownedDirectory);
      if (manifests.length > 1) {
        throw new Error("A CCM run contains more than one physical cluster manifest");
      }
      for (const manifest of manifests) {
        await ensureRecoveredReservation(reservationsDirectory, entry.name, manifest);
        await cleanup(runDirectory, manifest);
        await assertClusterConfigRetired(runDirectory, manifest.instanceId);
      }
      await assertNoUnownedClusterState(runDirectory);
      const ownedReservations = await reservationsOwnedBy(reservationsDirectory, entry.name);
      validateDescendant(root, runDirectory);
      await rm(runDirectory, { recursive: true, force: false });
      for (const reservation of ownedReservations) {
        await releaseRecoveredReservation(reservationsDirectory, entry.name, reservation);
      }
    } catch (error) {
      await quarantineReadableManifests(
        join(runDirectory, "owned"),
        reservationsDirectory,
        entry.name,
        uid,
        quarantinedIds,
      );
      console.warn(`Preserving unclean CCM run ${runDirectory}: ${errorMessage(error)}`);
      continue;
    }
  }
}

async function removeOrphanReservations(
  runsDirectory: string,
  reservationsDirectory: string,
  quarantinedIds: ReadonlySet<number>,
): Promise<void> {
  const reservations = await readdir(reservationsDirectory, { withFileTypes: true });
  for (const entry of reservations) {
    if (!entry.isDirectory() || !/^(?:[1-9]|[1-9][0-9])$/u.test(entry.name)) {
      continue;
    }
    if (quarantinedIds.has(Number(entry.name))) {
      continue;
    }
    const reservation = join(reservationsDirectory, entry.name);
    try {
      const hasOwner = await prepareReservationDirectory(reservation);
      if (!hasOwner) {
        await rm(reservation, { recursive: true, force: false });
        continue;
      }
      const owner = await readReservation(join(reservation, "owner.json"));
      if (!RUN_NAME_PATTERN.test(owner.runName)) {
        continue;
      }
      if (!(await pathExists(join(runsDirectory, owner.runName)))) {
        const id = Number(entry.name);
        if (await isAddressRangeAvailable(new ClusterSpec(), id, true)) {
          await rm(reservation, { recursive: true, force: false });
        }
      }
    } catch {
      // Malformed reservations remain quarantined.
    }
  }
}

async function ensureRecoveredReservation(
  reservationsDirectory: string,
  runName: string,
  manifest: ClusterManifest,
): Promise<void> {
  const reservation = join(reservationsDirectory, String(manifest.ccmId));
  if (!(await pathExists(reservation))) {
    await mkdir(reservation, { mode: 0o700 });
    await writeJsonAtomic(join(reservation, "owner.json"), {
      formatVersion: FORMAT_VERSION,
      runName,
      instanceId: manifest.instanceId,
      token: manifest.token,
    } satisfies ReservationOwner);
    return;
  }
  const hasOwner = await prepareReservationDirectory(reservation);
  if (!hasOwner) {
    await writeJsonAtomic(join(reservation, "owner.json"), {
      formatVersion: FORMAT_VERSION,
      runName,
      instanceId: manifest.instanceId,
      token: manifest.token,
    } satisfies ReservationOwner);
    return;
  }
  const owner = await readReservation(join(reservation, "owner.json"));
  if (
    owner.runName !== runName ||
    owner.instanceId !== manifest.instanceId ||
    owner.token !== manifest.token
  ) {
    throw new Error(`CCM ID ${manifest.ccmId} is reserved by a different run`);
  }
}

async function reservationsOwnedBy(
  reservationsDirectory: string,
  runName: string,
): Promise<Array<ReservationOwner & { readonly ccmId: number }>> {
  const result: Array<ReservationOwner & { readonly ccmId: number }> = [];
  const entries = await readdir(reservationsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:[1-9]|[1-9][0-9])$/u.test(entry.name)) {
      continue;
    }
    try {
      const owner = await readReservation(join(reservationsDirectory, entry.name, "owner.json"));
      if (owner.runName === runName) {
        result.push({ ...owner, ccmId: Number(entry.name) });
      }
    } catch (error) {
      console.warn(
        `Preserving malformed CCM reservation ${join(reservationsDirectory, entry.name)}: ${errorMessage(error)}`,
      );
    }
  }
  return result;
}

async function assertClusterConfigRetired(
  runDirectory: string,
  instanceId: string,
): Promise<void> {
  const clusters = join(runDirectory, "clusters");
  if (!(await pathExists(clusters))) {
    return;
  }
  await validateOwnedDirectory(clusters, currentUid());
  const config = join(clusters, instanceId);
  if (await pathExists(config)) {
    throw new Error(`CCM cluster state remains after cleanup: ${config}`);
  }
}

async function assertNoUnownedClusterState(runDirectory: string): Promise<void> {
  const clusters = join(runDirectory, "clusters");
  if (!(await pathExists(clusters))) {
    return;
  }
  await validateOwnedDirectory(clusters, currentUid());
  const entries = await readdir(clusters);
  if (entries.length !== 0) {
    throw new Error(`CCM run contains unowned cluster state: ${clusters}`);
  }
}

async function releaseRecoveredReservation(
  reservationsDirectory: string,
  runName: string,
  reservationOwner: ReservationOwner & { readonly ccmId: number },
): Promise<void> {
  const reservation = join(reservationsDirectory, String(reservationOwner.ccmId));
  try {
    if (!(await prepareReservationDirectory(reservation))) {
      return;
    }
    const owner = await readReservation(join(reservation, "owner.json"));
    if (
      owner.runName === runName &&
      owner.instanceId === reservationOwner.instanceId &&
      owner.token === reservationOwner.token
    ) {
      await rm(reservation, { recursive: true, force: false });
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

async function terminateMarkedProcesses(runDirectory: string, uid: number): Promise<void> {
  if (process.env.SCYLLA_CCM_RUN_DIR === runDirectory) {
    throw new Error("Current process carries stale CCM run marker; refusing self-termination");
  }
  let survivors = await signalMarkedProcessesUntil(
    runDirectory,
    uid,
    "SIGTERM",
    TERM_GRACE_MS,
  );
  if (survivors.length !== 0) {
    survivors = await signalMarkedProcessesUntil(
      runDirectory,
      uid,
      "SIGKILL",
      KILL_GRACE_MS,
    );
  }
  if (survivors.length !== 0) {
    throw new Error(
      `Processes carrying exact CCM run marker survived termination: ${survivors
        .map(({ pid }) => pid)
        .join(", ")}`,
    );
  }
}

async function signalMarkedProcessesUntil(
  runDirectory: string,
  uid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<MarkedProcess[]> {
  const deadline = Date.now() + timeoutMs;
  let processes: MarkedProcess[];
  do {
    processes = await findMarkedProcesses(runDirectory, uid);
    for (const marked of processes) {
      signalSameProcess(marked, signal);
    }
    if (processes.length === 0) {
      return [];
    }
    await delay(20);
  } while (Date.now() < deadline);
  return findMarkedProcesses(runDirectory, uid);
}

async function findMarkedProcesses(runDirectory: string, uid: number): Promise<MarkedProcess[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const expected = `SCYLLA_CCM_RUN_DIR=${runDirectory}`;
  const result: MarkedProcess[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (pid === process.pid) {
      continue;
    }
    let exactMarkerObserved = false;
    try {
      const startTicks = await processStartTicks(pid);
      if ((await stat(`/proc/${pid}`)).uid !== uid) {
        continue;
      }
      const environment = await readFile(`/proc/${pid}/environ`);
      const variables = environment.toString("utf8").split("\0");
      if (variables.includes(expected)) {
        exactMarkerObserved = true;
        if ((await processStartTicks(pid)) !== startTicks) {
          continue;
        }
        const marked = { pid, startTicks };
        if (isSameLiveProcessSync(marked)) {
          result.push(marked);
        }
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) {
        continue;
      }
      if (exactMarkerObserved) {
        throw new Error(`Cannot verify marked CCM process ${pid}`, { cause: error });
      }
      try {
        const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8");
        if (commandLine.includes(runDirectory)) {
          throw new Error(`Cannot inspect possible CCM process ${pid}`, { cause: error });
        }
      } catch (commandError) {
        if (commandError instanceof Error && commandError.message.startsWith("Cannot inspect")) {
          throw commandError;
        }
      }
    }
  }
  return result;
}

function signalSameProcess(marked: MarkedProcess, signal: NodeJS.Signals): void {
  if (!isSameLiveProcessSync(marked)) {
    return;
  }
  try {
    process.kill(marked.pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) {
      throw error;
    }
  }
}

function isSameLiveProcessSync(marked: MarkedProcess): boolean {
  try {
    const contents = requireReadFile(`/proc/${marked.pid}/stat`);
    const closing = contents.lastIndexOf(")");
    if (closing < 0) {
      return false;
    }
    const fields = contents.slice(closing + 2).trim().split(/\s+/u);
    return fields[0] !== "Z" && fields[19] === marked.startTicks;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) {
      return false;
    }
    throw new Error(`Cannot inspect marked CCM process ${marked.pid}`, { cause: error });
  }
}

function requireReadFile(path: string): string {
  // Synchronous reads are restricted to short /proc identity records used immediately before kill.
  return readFileSync(path, "utf8");
}

async function ownerIsActive(owner: ProcessOwner): Promise<boolean> {
  if (owner.bootId !== (await bootId())) {
    return false;
  }
  try {
    const identity = await processIdentity(owner.pid);
    return identity.state !== "Z" && identity.startTicks === owner.startTicks;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) {
      return false;
    }
    throw new Error(`Cannot inspect CCM owner process ${owner.pid}`, { cause: error });
  }
}

async function currentOwner(runDirectory: string, uid: number): Promise<ProcessOwner> {
  return {
    formatVersion: FORMAT_VERSION,
    pid: process.pid,
    startTicks: await processStartTicks(process.pid),
    bootId: await bootId(),
    uid,
    token: randomBytes(16).toString("hex"),
    runDirectory,
  };
}

async function processStartTicks(pid: number): Promise<string> {
  return (await processIdentity(pid)).startTicks;
}

async function processIdentity(
  pid: number,
): Promise<{ readonly state: string; readonly startTicks: string }> {
  const contents = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = contents.lastIndexOf(")");
  if (closing < 0) {
    throw new Error(`Malformed process stat for PID ${pid}`);
  }
  const fields = contents.slice(closing + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) {
    throw new Error(`Malformed process start time for PID ${pid}`);
  }
  const state = fields[0];
  if (state === undefined || !/^[A-Z]$/u.test(state)) {
    throw new Error(`Malformed process state for PID ${pid}`);
  }
  return { state, startTicks };
}

async function bootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

async function readOwner(path: string): Promise<ProcessOwner> {
  const value = await readJson(path);
  if (
    !isRecord(value) ||
    value.formatVersion !== FORMAT_VERSION ||
    !isPositiveInteger(value.pid) ||
    typeof value.startTicks !== "string" ||
    !/^[0-9]+$/u.test(value.startTicks) ||
    typeof value.bootId !== "string" ||
    !isNonnegativeInteger(value.uid) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.token) ||
    typeof value.runDirectory !== "string" ||
    !isAbsolute(value.runDirectory)
  ) {
    throw new Error(`Malformed CCM owner metadata: ${path}`);
  }
  return value as unknown as ProcessOwner;
}

async function readManifest(path: string): Promise<ClusterManifest> {
  const value = await readJson(path);
  if (
    !isRecord(value) ||
    value.formatVersion !== FORMAT_VERSION ||
    typeof value.instanceId !== "string" ||
    !INSTANCE_NAME_PATTERN.test(value.instanceId) ||
    !isPositiveInteger(value.ccmId) ||
    value.ccmId > 99 ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.token) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error(`Malformed CCM cluster manifest: ${path}`);
  }
  return value as unknown as ClusterManifest;
}

async function readReservation(path: string): Promise<ReservationOwner> {
  const value = await readJson(path);
  if (
    !isRecord(value) ||
    value.formatVersion !== FORMAT_VERSION ||
    typeof value.runName !== "string" ||
    !RUN_NAME_PATTERN.test(value.runName) ||
    typeof value.instanceId !== "string" ||
    !INSTANCE_NAME_PATTERN.test(value.instanceId) ||
    typeof value.token !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.token)
  ) {
    throw new Error(`Malformed CCM reservation metadata: ${path}`);
  }
  return value as unknown as ReservationOwner;
}

async function readManifests(ownedDirectory: string): Promise<ClusterManifest[]> {
  await validateOwnedDirectory(ownedDirectory, currentUid());
  const entries = await readdir(ownedDirectory, { withFileTypes: true });
  const manifests: ClusterManifest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`Unexpected CCM ownership entry: ${join(ownedDirectory, entry.name)}`);
    }
    const manifest = await readManifest(join(ownedDirectory, entry.name));
    if (entry.name !== `${manifest.instanceId}.json`) {
      throw new Error(`CCM manifest name does not match instance: ${entry.name}`);
    }
    manifests.push(manifest);
  }
  return manifests;
}

async function quarantineReadableManifests(
  ownedDirectory: string,
  reservationsDirectory: string,
  runName: string,
  uid: number,
  quarantinedIds: Set<number>,
): Promise<void> {
  try {
    await validateOwnedDirectory(ownedDirectory, uid);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw new Error(`Cannot inspect CCM manifests while preserving ${ownedDirectory}`, {
      cause: error,
    });
  }
  await removeAtomicStagingFiles(ownedDirectory, MANIFEST_STAGING_PATTERN, uid);
  const entries = await readdir(ownedDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    let manifest: ClusterManifest;
    try {
      manifest = await readManifest(join(ownedDirectory, entry.name));
      if (entry.name !== `${manifest.instanceId}.json`) {
        continue;
      }
    } catch (error) {
      console.warn(
        `Cannot quarantine malformed CCM manifest ${join(ownedDirectory, entry.name)}: ${errorMessage(error)}`,
      );
      continue;
    }
    quarantinedIds.add(manifest.ccmId);
    try {
      await ensureRecoveredReservation(reservationsDirectory, runName, manifest);
    } catch (error) {
      const reservation = join(reservationsDirectory, String(manifest.ccmId));
      if (!(await pathExists(reservation))) {
        throw error;
      }
      console.warn(
        `CCM ID ${manifest.ccmId} remains quarantined by existing reservation: ${errorMessage(error)}`,
      );
    }
  }
}

async function ownerlessRunHasPublishedState(
  runDirectory: string,
  reservationsDirectory: string,
  runName: string,
  uid: number,
): Promise<boolean> {
  const ownedDirectory = join(runDirectory, "owned");
  try {
    await validateOwnedDirectory(ownedDirectory, uid);
    if ((await readdir(ownedDirectory)).length !== 0) {
      return true;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  if (await pathExists(join(runDirectory, "clusters"))) {
    return true;
  }
  return (await reservationsOwnedBy(reservationsDirectory, runName)).length !== 0;
}

async function prepareReservationDirectory(reservation: string): Promise<boolean> {
  const uid = currentUid();
  await validateOwnedDirectory(reservation, uid);
  await removeAtomicStagingFiles(reservation, OWNER_STAGING_PATTERN, uid);
  const entries = await readdir(reservation, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== "owner.json") {
      throw new Error(`Unexpected CCM reservation entry: ${join(reservation, entry.name)}`);
    }
  }
  return entries.some((entry) => entry.name === "owner.json");
}

async function removeAtomicStagingFiles(
  directory: string,
  pattern: RegExp,
  uid: number,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!pattern.test(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== uid ||
      metadata.size > MAXIMUM_METADATA_BYTES
    ) {
      throw new Error(`Unsafe CCM metadata staging file: ${path}`);
    }
    await rm(path, { force: false });
  }
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAXIMUM_METADATA_BYTES) {
    throw new Error(`Unsafe CCM metadata file: ${path}`);
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function prepareRoot(requested: string, uid: number): Promise<string> {
  const normalized = resolve(requested);
  rejectUnsafeRoot(normalized);
  await rejectSymbolicLinkComponents(normalized);
  await mkdir(normalized, { recursive: true, mode: 0o700 });
  await validateOwnedDirectoryStructure(normalized, uid);
  await chmod(normalized, 0o700);
  await validateOwnedDirectory(normalized, uid);
  const actual = await realpath(normalized);
  if (actual !== normalized) {
    throw new Error(`CCM root must not traverse symbolic links: ${normalized}`);
  }
  return actual;
}

async function prepareOwnedDirectory(path: string, uid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
  }
  await validateOwnedDirectoryStructure(path, uid);
  await chmod(path, 0o700);
  await validateOwnedDirectory(path, uid);
}

async function validateOwnedDirectory(path: string, uid: number): Promise<void> {
  await validateOwnedDirectoryStructure(path, uid);
  const metadata = await lstat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`CCM state directory must be private: ${path}`);
  }
}

async function validateOwnedDirectoryStructure(path: string, uid: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid) {
    throw new Error(`Refusing unsafe or foreign CCM directory: ${path}`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`CCM directory must not traverse symbolic links: ${path}`);
  }
}

function rejectUnsafeRoot(root: string): void {
  const filesystemRoot = resolve("/");
  const project = resolve(process.cwd());
  const projectBuild = join(project, "target");
  const forbidden = new Set([
    filesystemRoot,
    resolve(tmpdir()),
    resolve("/var/tmp"),
    resolve("/dev/shm"),
    resolve(homedir()),
  ]);
  if (/\s/u.test(root)) {
    throw new Error(`CCM root must not contain whitespace: ${root}`);
  }
  if (
    forbidden.has(root) ||
    dirname(root) === filesystemRoot ||
    containsPath(root, project) ||
    containsPath(projectBuild, root)
  ) {
    throw new Error(`Refusing broad or repository-owned CCM root: ${root}`);
  }
}

async function rejectSymbolicLinkComponents(path: string): Promise<void> {
  let current = path;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`CCM root must not traverse symbolic links: ${path}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function withRootLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockName = `\0alternator-js-ccm-${createHash("sha256").update(root).digest("hex").slice(0, 40)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock: ReturnType<typeof createServer> | undefined;
  while (lock === undefined) {
    try {
      lock = await listenOnAbstractSocket(lockName);
    } catch (error) {
      if (!isNodeError(error, "EADDRINUSE")) {
        throw asError(error);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring CCM state lock for ${root}`, { cause: error });
      }
      await delay(50);
    }
  }

  let outcome: { readonly value: T } | undefined;
  let operationFailure: Error | undefined;
  try {
    outcome = { value: await operation() };
  } catch (error) {
    operationFailure = asError(error);
  }
  try {
    await closeServer(lock);
  } catch (releaseError) {
    if (operationFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, asError(releaseError)],
        "CCM operation and state-lock release both failed",
      );
    }
    throw asError(releaseError);
  }
  if (operationFailure !== undefined) {
    throw operationFailure;
  }
  return outcome!.value;
}

function listenOnAbstractSocket(name: string): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer();
    server.once("error", rejectServer);
    server.listen(name, () => {
      server.off("error", rejectServer);
      resolveServer(server);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveResult(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => resolveResult(error === undefined));
    });
  });
}

function validateDescendant(parent: string, child: string): void {
  if (!containsPath(parent, child) || parent === child) {
    throw new Error(`Refusing path outside CCM-owned root: ${child}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
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

function requireLinux(): void {
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("The native scylla-ccm harness currently supports Linux only");
  }
}

function currentUid(): number {
  requireLinux();
  return process.getuid!();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
