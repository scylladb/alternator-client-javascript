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

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CcmRunState,
  isAddressRangeAvailable,
  type ClusterManifest,
} from "../../testinfra/ccm/run-state.js";
import {
  AlternatorTransport,
  ClusterSpec,
  ClusterTopology,
} from "../../testinfra/ccm/spec.js";

const temporaryDirectories: string[] = [];
const describeLinux = process.platform === "linux" && process.getuid !== undefined
  ? describe
  : describe.skip;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describeLinux("CCM-REQ-006 durable run state", () => {
  it("rejects broad, build, and symbolic-link roots before creating state", async () => {
    const cleanup = () => Promise.resolve();
    await expect(CcmRunState.openDefault(cleanup, { root: "/" })).rejects.toThrow(/broad/u);
    await expect(CcmRunState.openDefault(cleanup, { root: tmpdir() })).rejects.toThrow(/broad/u);

    const buildRoot = join(process.cwd(), "target", `ccm-forbidden-${randomUUID()}`);
    temporaryDirectories.push(buildRoot);
    await expect(pathExists(buildRoot)).resolves.toBe(false);
    await expect(CcmRunState.openDefault(cleanup, { root: buildRoot })).rejects.toThrow(
      /broad|repository-owned/u,
    );
    await expect(pathExists(buildRoot)).resolves.toBe(false);

    const parent = await createTemporaryDirectory("symlink-parent");
    const target = join(parent, "target");
    const link = join(parent, "linked-root");
    const requested = join(link, "new-state");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link, "dir");

    await expect(CcmRunState.openDefault(cleanup, { root: requested })).rejects.toThrow(
      /symbolic links/u,
    );
    await expect(pathExists(join(target, "new-state"))).resolves.toBe(false);
  });

  it("rejects configured CCM roots containing whitespace before creating state", async () => {
    const parent = await createTemporaryDirectory("whitespace-root");
    const root = join(parent, "ccm state");

    await expect(
      CcmRunState.openDefault(() => Promise.resolve(), {
        environment: { SCYLLA_CCM_ROOT: root },
      }),
    ).rejects.toThrow(/must not contain whitespace/u);
    await expect(pathExists(root)).resolves.toBe(false);
  });

  it("creates private state and gives concurrent runs unique reusable reservations", async () => {
    const root = await createTemporaryDirectory("state");
    const first = await CcmRunState.openDefault(() => Promise.resolve(), { root });
    const second = await CcmRunState.openDefault(() => Promise.resolve(), { root });
    const spec = oneNodeHttpSpec();

    expect((await stat(first.rootDirectory)).mode & 0o077).toBe(0);
    expect((await stat(first.runDirectory)).mode & 0o077).toBe(0);
    expect(first.runDirectory).not.toBe(second.runDirectory);

    const firstOwnership = await first.beginCluster("alternator-js-first", spec, false);
    const secondOwnership = await second.beginCluster("alternator-js-second", spec, false);
    expect(secondOwnership.ccmId).not.toBe(firstOwnership.ccmId);

    await first.completeCluster(firstOwnership);
    const reusedOwnership = await first.beginCluster("alternator-js-reused", spec, false);
    expect(reusedOwnership.ccmId).toBe(firstOwnership.ccmId);

    await first.completeCluster(reusedOwnership);
    await second.completeCluster(secondOwnership);
    await first.close();
    await second.close();
  });

  it("preserves malformed runs and their address reservations as quarantined state", async () => {
    const root = await createTemporaryDirectory("malformed");
    const runName = `ccm-runtime.${"a".repeat(32)}`;
    const runDirectory = join(root, "runs", runName);
    const reservation = join(root, "reservations", "1");
    await mkdir(join(runDirectory, "owned"), { recursive: true, mode: 0o700 });
    await mkdir(reservation, { recursive: true, mode: 0o700 });
    await writeJson(join(runDirectory, "owner.json"), { malformed: true });
    await writeJson(join(reservation, "owner.json"), {
      formatVersion: 1,
      runName,
      instanceId: "alternator-js-quarantined",
      token: "b".repeat(32),
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });
    const ownership = await state.beginCluster("alternator-js-current", oneNodeHttpSpec(), false);

    expect(ownership.ccmId).not.toBe(1);
    await expect(pathExists(runDirectory)).resolves.toBe(true);
    await expect(pathExists(reservation)).resolves.toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Preserving malformed CCM run"));

    await state.completeCluster(ownership);
    await state.close();
  });

  it("reconstructs missing reservations from valid manifests in malformed-owner runs", async () => {
    const root = await createTemporaryDirectory("malformed-owner-missing-reservation");
    const spec = oneNodeHttpSpec();
    const [ccmId] = await findTwoAvailableCcmIds(spec);
    const manifest = clusterManifest("alternator-js-malformed-owner", ccmId, "a");
    const seeded = await seedStaleRun(root, "b", [manifest]);
    await writeJson(join(seeded.runDirectory, "owner.json"), { malformed: true });
    for (let id = 1; id < ccmId; id++) {
      const reservation = join(root, "reservations", String(id));
      await mkdir(reservation, { mode: 0o700 });
      await writeJson(join(reservation, "owner.json"), { malformed: true });
    }
    const cleanup = vi.fn(() => Promise.resolve());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = await CcmRunState.openDefault(cleanup, { root });
    const ownership = await state.beginCluster("alternator-js-after-quarantine", spec, false);

    expect(ownership.ccmId).not.toBe(ccmId);
    await expect(
      readJson(join(root, "reservations", String(ccmId), "owner.json")),
    ).resolves.toMatchObject({
      runName: seeded.runName,
      instanceId: manifest.instanceId,
      token: manifest.token,
    });
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Preserving malformed CCM run"));

    await state.completeCluster(ownership);
    await state.close();
  });

  it("preserves an ownerless run after cluster ownership was published", async () => {
    const root = await createTemporaryDirectory("ownerless-published-run");
    const spec = oneNodeHttpSpec();
    const [ccmId] = await findTwoAvailableCcmIds(spec);
    const manifest = clusterManifest("alternator-js-ownerless", ccmId, "2");
    const seeded = await seedStaleRun(root, "3", [manifest]);
    await rm(join(seeded.runDirectory, "owner.json"));
    const cleanup = vi.fn(() => Promise.resolve());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = await CcmRunState.openDefault(cleanup, { root });
    const ownership = await state.beginCluster("alternator-js-after-ownerless", spec, false);

    expect(ownership.ccmId).not.toBe(ccmId);
    expect(cleanup).not.toHaveBeenCalled();
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    await expect(
      pathExists(join(root, "reservations", String(manifest.ccmId))),
    ).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Preserving ownerless CCM run with published state"),
    );

    await state.completeCluster(ownership);
    await state.close();
  });

  it("continues when another reservation already quarantines a malformed run's ID", async () => {
    const root = await createTemporaryDirectory("malformed-owner-reservation-conflict");
    const manifest = clusterManifest("alternator-js-conflicted", 1, "4");
    const seeded = await seedStaleRun(root, "5", [manifest]);
    await writeJson(join(seeded.runDirectory, "owner.json"), { malformed: true });
    await writeReservation(root, `ccm-runtime.${"6".repeat(32)}`, {
      ...manifest,
      instanceId: "alternator-js-different-owner",
      token: "7".repeat(32),
    });
    const cleanup = vi.fn(() => Promise.resolve());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = await CcmRunState.openDefault(cleanup, { root });
    const ownership = await state.beginCluster(
      "alternator-js-after-reservation-conflict",
      oneNodeHttpSpec(),
      false,
    );

    expect(cleanup).not.toHaveBeenCalled();
    expect(ownership.ccmId).not.toBe(manifest.ccmId);
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    await expect(pathExists(join(root, "reservations", "1"))).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("remains quarantined by existing reservation"),
    );
    await state.completeCluster(ownership);
    await state.close();
  });


  it("recovers exact atomic owner, manifest, and reservation staging files", async () => {
    const root = await createTemporaryDirectory("atomic-staging");
    const manifest = clusterManifest("alternator-js-atomic-staging", 35, "c");
    const seeded = await seedStaleRun(root, "d", [manifest]);
    const reservation = join(root, "reservations", String(manifest.ccmId));
    await mkdir(reservation, { mode: 0o700 });
    await writeFile(
      join(seeded.runDirectory, ".owner.json.0123456789abcdef.tmp"),
      "incomplete owner",
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(
        seeded.runDirectory,
        "owned",
        `.${manifest.instanceId}.json.0123456789abcdef.tmp`,
      ),
      "incomplete manifest",
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      join(reservation, ".owner.json.0123456789abcdef.tmp"),
      "incomplete reservation",
      { encoding: "utf8", mode: 0o600 },
    );
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).toHaveBeenCalledWith(seeded.runDirectory, manifest);
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(false);
    await expect(pathExists(reservation)).resolves.toBe(false);
    await state.close();
  });

  it("retires an incomplete run containing only an exact atomic owner staging file", async () => {
    const root = await createTemporaryDirectory("atomic-owner-staging");
    const seeded = await seedStaleRun(root, "e", []);
    await rm(join(seeded.runDirectory, "owner.json"));
    await writeFile(
      join(seeded.runDirectory, ".owner.json.fedcba9876543210.tmp"),
      "incomplete owner",
      { encoding: "utf8", mode: 0o600 },
    );

    const state = await CcmRunState.openDefault(() => Promise.resolve(), { root });

    await expect(pathExists(seeded.runDirectory)).resolves.toBe(false);
    await state.close();
  });

  it("retires a run killed before its owned directory was created", async () => {
    const root = await createTemporaryDirectory("run-before-owned");
    const runDirectory = join(root, "runs", `ccm-runtime.${"0".repeat(32)}`);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });

    const state = await CcmRunState.openDefault(() => Promise.resolve(), { root });

    await expect(pathExists(runDirectory)).resolves.toBe(false);
    await state.close();
  });

  it("preserves near-match atomic staging names as unknown ownership state", async () => {
    const root = await createTemporaryDirectory("unknown-staging");
    const manifest = clusterManifest("alternator-js-unknown-staging", 36, "f");
    const seeded = await seedStaleRun(root, "1", [manifest]);
    await writeReservation(root, seeded.runName, manifest);
    const unknown = join(
      seeded.runDirectory,
      "owned",
      `.${manifest.instanceId}.json.not-a-harness-token.tmp`,
    );
    await writeFile(unknown, "unknown", { encoding: "utf8", mode: 0o600 });
    const cleanup = vi.fn(() => Promise.resolve());
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).not.toHaveBeenCalled();
    await expect(pathExists(unknown)).resolves.toBe(true);
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Unexpected CCM ownership entry"));
    await state.close();
  });

  it("calls stale-cluster recovery and releases matching durable ownership", async () => {
    const root = await createTemporaryDirectory("stale");
    const runName = `ccm-runtime.${"c".repeat(32)}`;
    const runDirectory = join(root, "runs", runName);
    const reservation = join(root, "reservations", "17");
    const instanceId = "alternator-js-stale";
    const token = "d".repeat(32);
    const manifest: ClusterManifest = {
      formatVersion: 1,
      instanceId,
      ccmId: 17,
      token,
      createdAt: new Date(0).toISOString(),
    };
    await mkdir(join(runDirectory, "owned"), { recursive: true, mode: 0o700 });
    await mkdir(reservation, { recursive: true, mode: 0o700 });
    await writeJson(join(runDirectory, "owner.json"), {
      formatVersion: 1,
      pid: 2,
      startTicks: "1",
      bootId: "definitely-not-this-boot",
      uid: process.getuid!(),
      token: "e".repeat(32),
      runDirectory,
    });
    await writeJson(join(runDirectory, "owned", `${instanceId}.json`), manifest);
    await writeJson(join(reservation, "owner.json"), {
      formatVersion: 1,
      runName,
      instanceId,
      token,
    });
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(runDirectory, manifest);
    await expect(pathExists(runDirectory)).resolves.toBe(false);
    await expect(pathExists(reservation)).resolves.toBe(false);
    await state.close();
  });

  it("quarantines a stale run containing more than one physical-cluster manifest", async () => {
    const root = await createTemporaryDirectory("multiple-manifests");
    const first = clusterManifest("alternator-js-stale-first", 31, "1");
    const second = clusterManifest("alternator-js-stale-second", 32, "2");
    const seeded = await seedStaleRun(root, "3", [first, second]);
    await writeReservation(root, seeded.runName, first);
    await writeReservation(root, seeded.runName, second);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).not.toHaveBeenCalled();
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    await expect(pathExists(join(root, "reservations", "31"))).resolves.toBe(true);
    await expect(pathExists(join(root, "reservations", "32"))).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("more than one physical cluster"));
    await state.close();
  });

  it("recreates a missing reservation before invoking stale-cluster cleanup", async () => {
    const root = await createTemporaryDirectory("missing-reservation");
    const manifest = clusterManifest("alternator-js-missing-reservation", 33, "4");
    const seeded = await seedStaleRun(root, "5", [manifest]);
    let reservationDuringCleanup: unknown;
    const cleanup = vi.fn(async () => {
      reservationDuringCleanup = await readJson(
        join(root, "reservations", String(manifest.ccmId), "owner.json"),
      );
    });

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).toHaveBeenCalledWith(seeded.runDirectory, manifest);
    expect(reservationDuringCleanup).toEqual({
      formatVersion: 1,
      runName: seeded.runName,
      instanceId: manifest.instanceId,
      token: manifest.token,
    });
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(false);
    await expect(pathExists(join(root, "reservations", String(manifest.ccmId)))).resolves.toBe(false);
    await state.close();
  });

  it("quarantines stale state when the address reservation belongs to different ownership", async () => {
    const root = await createTemporaryDirectory("mismatched-reservation");
    const manifest = clusterManifest("alternator-js-stale-mismatch", 34, "6");
    const seeded = await seedStaleRun(root, "7", [manifest]);
    await writeReservation(root, seeded.runName, {
      ...manifest,
      instanceId: "alternator-js-other-owner",
      token: "8".repeat(32),
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).not.toHaveBeenCalled();
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    await expect(pathExists(join(root, "reservations", String(manifest.ccmId)))).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("reserved by a different run"));
    await state.close();
  });

  it("keeps a stale run when unowned cluster configuration remains", async () => {
    const root = await createTemporaryDirectory("unowned-cluster");
    const seeded = await seedStaleRun(root, "9", []);
    const residual = join(seeded.runDirectory, "clusters", "unowned-cluster");
    await mkdir(residual, { recursive: true, mode: 0o700 });
    await writeFile(join(residual, "cluster.conf"), "name: unowned\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cleanup = vi.fn(() => Promise.resolve());

    const state = await CcmRunState.openDefault(cleanup, { root });

    expect(cleanup).not.toHaveBeenCalled();
    await expect(pathExists(seeded.runDirectory)).resolves.toBe(true);
    await expect(pathExists(join(residual, "cluster.conf"))).resolves.toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("unowned cluster state"));
    await state.close();
  });

  it("releases an orphan reservation only after its full address range becomes bind-free", async () => {
    const root = await createTemporaryDirectory("orphan-reservation");
    const spec = new ClusterSpec();
    const ccmId = await findAvailableCcmId(spec, true);
    const orphanRun = `ccm-runtime.${"a".repeat(31)}b`;
    const manifest = clusterManifest("alternator-js-orphan", ccmId, "c");
    await writeReservation(root, orphanRun, manifest);
    const reservation = join(root, "reservations", String(ccmId));
    const server = createServer();
    await listen(server, `127.0.${ccmId}.1`, 8080);

    try {
      const occupied = await CcmRunState.openDefault(() => Promise.resolve(), { root });
      await expect(pathExists(reservation)).resolves.toBe(true);
      await occupied.close();
    } finally {
      await closeServer(server);
    }

    const released = await CcmRunState.openDefault(() => Promise.resolve(), { root });
    await expect(pathExists(reservation)).resolves.toBe(false);
    await released.close();
  });

  it("finishes a completion retry after the manifest was already retired", async () => {
    const root = await createTemporaryDirectory("completion-retry");
    const state = await CcmRunState.openDefault(() => Promise.resolve(), { root });
    const ownership = await state.beginCluster(
      "alternator-js-completion-retry",
      oneNodeHttpSpec(),
      false,
    );
    const manifest = join(state.runDirectory, "owned", `${ownership.instanceId}.json`);
    const reservation = join(root, "reservations", String(ownership.ccmId));
    await rm(manifest);

    await expect(state.completeCluster(ownership)).resolves.toBeUndefined();
    await expect(pathExists(reservation)).resolves.toBe(false);
    await expect(state.close()).resolves.toBeUndefined();
  });

  it("rejects an address range while a required node endpoint is already bound", async () => {
    const spec = oneNodeHttpSpec();
    const ccmId = await findAvailableCcmId(spec);
    const host = `127.0.${ccmId}.1`;
    const server = createServer();
    await listen(server, host, 8080);

    try {
      await expect(isAddressRangeAvailable(spec, ccmId, false)).resolves.toBe(false);
    } finally {
      await closeServer(server);
    }

    await expect(isAddressRangeAvailable(spec, ccmId, false)).resolves.toBe(true);
  });
});

function oneNodeHttpSpec(): ClusterSpec {
  return new ClusterSpec()
    .withTopology(ClusterTopology.singleDatacenter(1))
    .withTransports(AlternatorTransport.HTTP);
}

async function createTemporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `alternator-js-ccm-${label}-`));
  temporaryDirectories.push(path);
  await chmod(path, 0o700);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findAvailableCcmId(spec: ClusterSpec, includeJmxPort = false): Promise<number> {
  for (let candidate = 90; candidate <= 99; candidate++) {
    if (await isAddressRangeAvailable(spec, candidate, includeJmxPort)) {
      return candidate;
    }
  }
  throw new Error("No free CCM address range available for bind test");
}

async function findTwoAvailableCcmIds(spec: ClusterSpec): Promise<readonly [number, number]> {
  const available: number[] = [];
  for (let candidate = 90; candidate <= 99; candidate++) {
    if (await isAddressRangeAvailable(spec, candidate, false)) {
      available.push(candidate);
      if (available.length === 2) {
        return [available[0]!, available[1]!];
      }
    }
  }
  throw new Error("Two free CCM address ranges are required for quarantine testing");
}

function clusterManifest(instanceId: string, ccmId: number, tokenCharacter: string): ClusterManifest {
  return {
    formatVersion: 1,
    instanceId,
    ccmId,
    token: tokenCharacter.repeat(32),
    createdAt: new Date(0).toISOString(),
  };
}

async function seedStaleRun(
  root: string,
  runCharacter: string,
  manifests: readonly ClusterManifest[],
): Promise<{ readonly runName: string; readonly runDirectory: string }> {
  const runName = `ccm-runtime.${runCharacter.repeat(32)}`;
  const runDirectory = join(root, "runs", runName);
  await mkdir(join(runDirectory, "owned"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "reservations"), { recursive: true, mode: 0o700 });
  await writeJson(join(runDirectory, "owner.json"), {
    formatVersion: 1,
    pid: 2,
    startTicks: "1",
    bootId: "definitely-not-this-boot",
    uid: currentUid(),
    token: "f".repeat(32),
    runDirectory,
  });
  for (const manifest of manifests) {
    await writeJson(join(runDirectory, "owned", `${manifest.instanceId}.json`), manifest);
  }
  return { runName, runDirectory };
}

async function writeReservation(
  root: string,
  runName: string,
  manifest: Pick<ClusterManifest, "ccmId" | "instanceId" | "token">,
): Promise<void> {
  const reservation = join(root, "reservations", String(manifest.ccmId));
  await mkdir(reservation, { recursive: true, mode: 0o700 });
  await writeJson(join(reservation, "owner.json"), {
    formatVersion: 1,
    runName,
    instanceId: manifest.instanceId,
    token: manifest.token,
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function currentUid(): number {
  if (process.getuid === undefined) {
    throw new Error("Current platform does not expose a user ID");
  }
  return process.getuid();
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
