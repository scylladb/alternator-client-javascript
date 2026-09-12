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
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestClusterNode } from "../../testinfra/ccm/model.js";
import {
  CcmCommandError,
  CcmProcessCleanupError,
  CcmProvisioner,
  type ProvisionedClusterData,
} from "../../testinfra/ccm/provisioner.js";
import { AlternatorTransport, ClusterSpec } from "../../testinfra/ccm/spec.js";

const temporaryDirectories: string[] = [];
const fixturePids = new Set<number>();
const describeLinux = process.platform === "linux" && process.getuid !== undefined
  ? describe
  : describe.skip;
const itWithForeignProcess = process.platform === "linux" &&
    process.getuid !== undefined &&
    process.getuid() !== 0
  ? it
  : it.skip;

afterEach(async () => {
  for (const pid of fixturePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }
  fixturePids.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describeLinux("CCM-REQ-002 native command provisioning", () => {
  it("rejects diagnostics paths that overlap the harness state root", async () => {
    const root = await createTemporaryDirectory("diagnostics-state");
    const runDirectory = join(root, "runs", "ccm-runtime.test");
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });

    await expect(
      CcmProvisioner.create(runDirectory, { diagnosticsDirectory: root }),
    ).rejects.toThrow(/must not overlap harness state root/u);
    await expect(
      CcmProvisioner.create(runDirectory, { diagnosticsDirectory: join(root, "diagnostics") }),
    ).rejects.toThrow(/must not overlap harness state root/u);
    await expect(
      CcmProvisioner.create(runDirectory, { diagnosticsDirectory: dirname(root) }),
    ).rejects.toThrow(/must not overlap harness state root/u);

    const separateDiagnostics = await createTemporaryDirectory("diagnostics-external");
    const actualSeparateDiagnostics = await realpath(separateDiagnostics);
    await expect(
      CcmProvisioner.create(runDirectory, { diagnosticsDirectory: separateDiagnostics }),
    ).resolves.toMatchObject({
      runDirectory,
      diagnosticsDirectory: actualSeparateDiagnostics,
    });

    const aliasDirectory = await createTemporaryDirectory("diagnostics-alias");
    const stateAlias = join(aliasDirectory, "state");
    await symlink(root, stateAlias, "dir");
    await expect(
      CcmProvisioner.create(runDirectory, {
        diagnosticsDirectory: join(stateAlias, "diagnostics"),
      }),
    ).rejects.toThrow(/must not overlap harness state root/u);

    const externalAlias = join(aliasDirectory, "external");
    await symlink(separateDiagnostics, externalAlias, "dir");
    const aliasedDiagnostics = await CcmProvisioner.create(runDirectory, {
      diagnosticsDirectory: join(externalAlias, "artifacts"),
    });
    expect(aliasedDiagnostics.diagnosticsDirectory).toBe(
      join(actualSeparateDiagnostics, "artifacts"),
    );
  });

  it.each([
    { label: "NaN command", options: { commandTimeoutMs: Number.NaN } },
    { label: "infinite command", options: { commandTimeoutMs: Number.POSITIVE_INFINITY } },
    { label: "NaN readiness", options: { readinessTimeoutMs: Number.NaN } },
    { label: "infinite readiness", options: { readinessTimeoutMs: Number.POSITIVE_INFINITY } },
  ])("rejects a $label timeout", async ({ options }) => {
    const stateRoot = await createTemporaryDirectory("invalid-timeout-state");
    const runDirectory = join(stateRoot, "runs", "ccm-runtime.invalid-timeout");
    const diagnosticsDirectory = await createTemporaryDirectory("invalid-timeout-diagnostics");
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });

    await expect(CcmProvisioner.create(runDirectory, {
      ...options,
      diagnosticsDirectory,
    })).rejects.toThrow(
      /must be positive and finite/u,
    );
  });

  it("applies and verifies overlapping mapping and child YAML overrides", async () => {
    const harness = await createProcessHarness("overlapping-yaml", ["node1"]);
    const spec = new ClusterSpec()
      .withYamlOverride(
        "client_encryption_options",
        "{enabled: true, require_client_auth: false}",
      )
      .withYamlOverride("client_encryption_options.enabled", "false");
    const provisioner = await createProcessProvisioner(harness);
    const internals = provisioner as unknown as ProvisionerTestAccess;
    await writeFile(
      join(harness.clusterDirectory, "cluster.conf"),
      JSON.stringify({
        name: harness.cluster.instanceId,
        nodes: ["node1"],
        config_options: {},
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const scyllaConfiguration = join(
      harness.clusterDirectory,
      "node1",
      "conf",
      "scylla.yaml",
    );
    await writeFile(scyllaConfiguration, "{}\n", { encoding: "utf8", mode: 0o600 });

    await internals.applyYamlOverrides(
      spec,
      harness.ccmDirectory,
      harness.cluster.instanceId,
      harness.cluster.nodes,
      true,
    );
    await expect(
      internals.verifyYamlOverrides(
        spec,
        harness.ccmDirectory,
        harness.cluster.instanceId,
        harness.cluster.nodes,
      ),
    ).resolves.toBeUndefined();

    const yaml = parse(await readFile(scyllaConfiguration, "utf8"), {
      schema: "core",
    }) as Record<string, unknown>;
    expect(yaml.client_encryption_options).toEqual({
      enabled: false,
      require_client_auth: false,
    });
  });

  it("encodes generated TLS paths as YAML scalars in CCM settings", async () => {
    const harness = await createProcessHarness("tls # root: value", ["node1"]);
    const executableDirectory = await createTemporaryDirectory("fake-openssl");
    const openssl = join(executableDirectory, "openssl");
    await writeFile(openssl, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o700 });
    await chmod(openssl, 0o700);
    const provisioner = await createProcessProvisioner(harness, {
      PATH: `${executableDirectory}${delimiter}${process.env.PATH ?? ""}`,
    });
    const node = harness.cluster.nodes[0]!;
    const caCertificatePath = join(harness.ccmDirectory, "tls", "ca.crt");

    await (provisioner as unknown as ProvisionerTestAccess).configureNodeCertificate(
      node,
      harness.ccmDirectory,
      caCertificatePath,
    );

    const certificatePath = join(harness.ccmDirectory, "tls", node.name, "server.crt");
    const keyPath = join(harness.ccmDirectory, "tls", node.name, "server.key");
    await expect(readFixtureRecords(harness.capture)).resolves.toContainEqual({
      argv: [
        node.name,
        "updateconf",
        "--config-dir",
        harness.ccmDirectory,
        `alternator_encryption_options.certificate:${JSON.stringify(certificatePath)}`,
        `alternator_encryption_options.keyfile:${JSON.stringify(keyPath)}`,
      ],
      durableLogAtStart: true,
    });
  });

  it("uses direct argv and creates a durable command log before launching", async () => {
    const harness = await createCommandHarness("argv");
    const nodeName = "node one; exit 91";
    const node = testNode(nodeName);
    const cluster = testCluster(harness.ccmDirectory, node);
    const provisioner = await CcmProvisioner.create(harness.runDirectory, {
      ccmExecutable: harness.fixture,
      diagnosticsDirectory: harness.diagnosticsDirectory,
      environment: {
        ...process.env,
        CCM_FIXTURE_CAPTURE: harness.capture,
        CCM_FIXTURE_MODE: "success",
      },
    });

    await provisioner.decommissionNode(cluster, node);

    const records = await readFixtureRecords(harness.capture);
    expect(records).toContainEqual({
      argv: [nodeName, "decommission", "--config-dir", harness.ccmDirectory],
      durableLogAtStart: true,
    });
    const commandLog = await readFile(join(harness.ccmDirectory, "ccm-commands.log"), "utf8");
    expect(commandLog).toContain(`'${nodeName}'`);
    expect(commandLog).toContain("fixture completed");
    expect(commandLog).toContain("[exit 0]");
    const individualLogs = (await readdir(harness.ccmDirectory)).filter(
      (name) => name.startsWith("ccm-command-") && name.endsWith(".log"),
    );
    expect(individualLogs).toHaveLength(1);
  });

  it("reports an executable startup error without waiting for the command timeout", async () => {
    const harness = await createCommandHarness("missing-executable");
    const node = testNode("node-missing-executable");
    const provisioner = await CcmProvisioner.create(harness.runDirectory, {
      ccmExecutable: join(harness.ccmDirectory, "missing-ccm"),
      commandTimeoutMs: 30_000,
      diagnosticsDirectory: harness.diagnosticsDirectory,
      environment: process.env,
    });
    const started = Date.now();

    const failure = await provisioner
      .decommissionNode(testCluster(harness.ccmDirectory, node), node)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    const commandLog = await readFile(join(harness.ccmDirectory, "ccm-commands.log"), "utf8");
    expect(commandLog).toContain("[exit start-failed]");
  });

  it("preserves process cleanup failure when command-log finalization also fails", async () => {
    const harness = await createCommandHarness("cleanup-and-log-failure");
    const node = testNode("node-cleanup-and-log-failure");
    const provisioner = await CcmProvisioner.create(harness.runDirectory, {
      ccmExecutable: harness.fixture,
      diagnosticsDirectory: harness.diagnosticsDirectory,
      environment: {
        ...process.env,
        CCM_FIXTURE_CAPTURE: harness.capture,
        CCM_FIXTURE_MODE: "remove-command-directory-and-fail",
      },
    });
    const cleanupFailure = Object.assign(new Error("fixture process-group cleanup failure"), {
      code: "EPERM",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw cleanupFailure;
    });

    try {
      const failure = await provisioner
        .decommissionNode(testCluster(harness.ccmDirectory, node), node)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CcmProcessCleanupError);
      expect((failure as Error).cause).toBeInstanceOf(AggregateError);
      expect(((failure as Error).cause as AggregateError).errors).toContain(cleanupFailure);
    } finally {
      kill.mockRestore();
    }
  });

  it("sets CCM's Scylla architecture from Node unless the environment overrides it", async () => {
    const originalArchitecture = process.arch;
    try {
      for (const [architecture, expected] of [
        ["arm64", "aarch64"],
        ["x64", "x86_64"],
      ] as const) {
        Object.defineProperty(process, "arch", { configurable: true, value: architecture });
        const harness = await createCommandHarness(`architecture-${architecture}`);
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          CCM_FIXTURE_CAPTURE: harness.capture,
          CCM_FIXTURE_CAPTURE_ARCH: "true",
        };
        delete environment.SCYLLA_ARCH;
        const provisioner = await CcmProvisioner.create(harness.runDirectory, {
          ccmExecutable: harness.fixture,
          diagnosticsDirectory: harness.diagnosticsDirectory,
          environment,
        });
        const node = testNode("node-architecture");

        await provisioner.decommissionNode(testCluster(harness.ccmDirectory, node), node);

        await expect(readFixtureRecords(harness.capture)).resolves.toContainEqual({
          argv: ["node-architecture", "decommission", "--config-dir", harness.ccmDirectory],
          durableLogAtStart: true,
          scyllaArch: expected,
        });
      }

      Object.defineProperty(process, "arch", { configurable: true, value: "arm64" });
      const harness = await createCommandHarness("architecture-override");
      const provisioner = await CcmProvisioner.create(harness.runDirectory, {
        ccmExecutable: harness.fixture,
        diagnosticsDirectory: harness.diagnosticsDirectory,
        environment: {
          ...process.env,
          CCM_FIXTURE_CAPTURE: harness.capture,
          CCM_FIXTURE_CAPTURE_ARCH: "true",
          SCYLLA_ARCH: "custom-architecture",
        },
      });
      const node = testNode("node-architecture");

      await provisioner.decommissionNode(testCluster(harness.ccmDirectory, node), node);

      await expect(readFixtureRecords(harness.capture)).resolves.toContainEqual({
        argv: ["node-architecture", "decommission", "--config-dir", harness.ccmDirectory],
        durableLogAtStart: true,
        scyllaArch: "custom-architecture",
      });
    } finally {
      Object.defineProperty(process, "arch", {
        configurable: true,
        value: originalArchitecture,
      });
    }
  });

  it("times out a command, terminates its whole process group, and records the outcome", async () => {
    const harness = await createCommandHarness("timeout");
    const node = testNode("node-timeout");
    const cluster = testCluster(harness.ccmDirectory, node);
    const provisioner = await CcmProvisioner.create(harness.runDirectory, {
      ccmExecutable: harness.fixture,
      commandTimeoutMs: 100,
      diagnosticsDirectory: harness.diagnosticsDirectory,
      environment: {
        ...process.env,
        CCM_FIXTURE_CAPTURE: harness.capture,
        CCM_FIXTURE_MODE: "hang",
      },
    });

    const failure = await provisioner.decommissionNode(cluster, node).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CcmCommandError);
    expect(failure).toMatchObject({ exitCode: -1 });
    const records = await readFixtureRecords(harness.capture);
    const pids = fixtureProcessIds(records);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      fixturePids.add(pid);
    }
    await waitForProcessesToStop(pids);
    for (const pid of pids) {
      await expect(isLiveProcess(pid)).resolves.toBe(false);
      fixturePids.delete(pid);
    }
    const commandLog = await readFile(join(harness.ccmDirectory, "ccm-commands.log"), "utf8");
    expect(commandLog).toContain("fixture hanging");
    expect(commandLog).toContain("[exit timeout]");
  }, 10_000);
});

describeLinux("CCM-REQ-006 process-reference safety", () => {
  it("rejects an exported cluster handle outside its provisioner-owned directory", async () => {
    const harness = await createProcessHarness("outside-removal", ["node1"]);
    const outside = await createTemporaryDirectory("outside-removal-target");
    const sentinel = join(outside, "keep.txt");
    await writeFile(sentinel, "keep\n", { encoding: "utf8", mode: 0o600 });
    const provisioner = await createProcessProvisioner(harness);

    await expect(
      provisioner.remove({ ...harness.cluster, ccmDirectory: outside }),
    ).rejects.toThrow(/does not match provisioner-owned path/u);

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes an equivalent cluster directory and operates on the expected path", async () => {
    const harness = await createProcessHarness("normalized-removal", ["node1"]);
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "remove-cluster-state-only",
    });

    await expect(
      provisioner.remove({
        ...harness.cluster,
        ccmDirectory: `${harness.ccmDirectory}/.`,
      }),
    ).resolves.toBeUndefined();

    await expect(stat(harness.ccmDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink substituted for the expected cluster directory", async () => {
    const harness = await createProcessHarness("symlink-removal", ["node1"]);
    const outside = await createTemporaryDirectory("symlink-removal-target");
    const sentinel = join(outside, "keep.txt");
    await writeFile(sentinel, "keep\n", { encoding: "utf8", mode: 0o600 });
    await rm(harness.ccmDirectory, { recursive: true, force: false });
    await symlink(outside, harness.ccmDirectory, "dir");
    const provisioner = await createProcessProvisioner(harness);

    await expect(provisioner.remove(harness.cluster)).rejects.toThrow(/unsafe CCM directory/u);

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "duplicate nodes", configuration: { nodes: ["node1", "node1"], seeds: ["node1"] } },
    { label: "foreign seed", configuration: { nodes: ["node1"], seeds: ["node2"] } },
  ])("rejects $label in CCM metadata before invoking CCM", async ({ configuration }) => {
    const harness = await createProcessHarness("unsafe-cluster-metadata", ["node1"]);
    await writeFile(
      join(harness.clusterDirectory, "cluster.conf"),
      JSON.stringify({ name: harness.cluster.instanceId, ...configuration }),
      { encoding: "utf8", mode: 0o600 },
    );
    const provisioner = await createProcessProvisioner(harness);

    await expect(
      provisioner.decommissionNode(harness.cluster, harness.cluster.nodes[0]!),
    ).rejects.toThrow(/Duplicate CCM node|Unsafe CCM seed/u);
    await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a later node with the wrong run marker before invoking CCM", async () => {
    const harness = await createProcessHarness("wrong-marker-later", ["node1", "node2"]);
    const firstPid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    const secondPid = await spawnReferencedProcess(harness, "node2", "scylla", false);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: firstPid,
      scyllaPid: firstPid,
    });
    await writeNodeProcessReferences(harness, "node2", {
      nodeConfigPid: secondPid,
      scyllaPid: secondPid,
    });
    const provisioner = await createProcessProvisioner(harness);

    await expect(provisioner.stop(harness.cluster)).rejects.toThrow(/unrelated live PID/u);
    await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(isLiveProcess(firstPid)).resolves.toBe(true);
  });

  itWithForeignProcess(
    "rejects a later node with a foreign PID before invoking CCM",
    async () => {
      const harness = await createProcessHarness("foreign-pid-later", ["node1", "node2"]);
      const firstPid = await spawnReferencedProcess(harness, "node1", "scylla", true);
      const foreignPid = await findForeignLivePid();
      if (foreignPid === undefined) {
        throw new Error("Expected at least one foreign live PID on an unprivileged Linux host");
      }
      await writeNodeProcessReferences(harness, "node1", {
        nodeConfigPid: firstPid,
        scyllaPid: firstPid,
      });
      await writeNodeProcessReferences(harness, "node2", {
        nodeConfigPid: foreignPid,
        scyllaPid: foreignPid,
      });
      const provisioner = await createProcessProvisioner(harness);

      await expect(provisioner.stop(harness.cluster)).rejects.toThrow(/foreign live PID/u);
      await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(isLiveProcess(firstPid)).resolves.toBe(true);
    },
  );

  it.each(["jmx", "agent"] as const)(
    "rejects restart while only an owned %s process remains alive",
    async (kind) => {
      const harness = await createProcessHarness(`ancillary-${kind}`, ["node1"]);
      const pid = await spawnReferencedProcess(harness, "node1", kind, true);
      await writeNodeProcessReferences(
        harness,
        "node1",
        kind === "jmx" ? { jmxPid: pid } : { agentPid: pid },
      );
      const provisioner = await createProcessProvisioner(harness);

      await expect(provisioner.startNode(harness.cluster, harness.cluster.nodes[0]!)).rejects.toThrow(
        /ancillary process remains alive/u,
      );
      await expect(readFile(harness.capture, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(isLiveProcess(pid)).resolves.toBe(true);
    },
  );

  it("sanitizes dead node.conf, Cassandra, JMX, and agent PID references", async () => {
    const harness = await createProcessHarness("dead-references", ["node1"]);
    const deadPid = Number.MAX_SAFE_INTEGER;
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: deadPid,
      scyllaPid: deadPid,
      jmxPid: deadPid,
      agentPid: deadPid,
    });
    const provisioner = await createProcessProvisioner(harness);

    await expect(
      provisioner.isNodeRunning(harness.cluster, harness.cluster.nodes[0]!),
    ).resolves.toBe(false);

    const nodeConfig = await readFile(nodeConfigPath(harness, "node1"), "utf8");
    expect(nodeConfig).toContain("name: node1");
    expect(nodeConfig).not.toMatch(/^pid:/mu);
    for (const filename of ["cassandra.pid", "scylla-jmx.pid", "scylla-agent.pid"]) {
      await expect(
        readFile(join(nodeDirectory(harness, "node1"), filename), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    { label: "wrong-executable", kind: "wrong" as const, marker: true, expected: /wrong scylla process/u },
    { label: "wrong-environment", kind: "scylla" as const, marker: false, expected: /unrelated live PID/u },
  ])("rejects a live PID with $label", async ({ label, kind, marker, expected }) => {
    const harness = await createProcessHarness(label, ["node1"]);
    const pid = await spawnReferencedProcess(harness, "node1", kind, marker);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: pid,
      scyllaPid: pid,
    });
    const provisioner = await createProcessProvisioner(harness);

    await expect(
      provisioner.isNodeRunning(harness.cluster, harness.cluster.nodes[0]!),
    ).rejects.toThrow(expected);
  });

  it("retains every process identity when CCM removes cluster state first", async () => {
    const harness = await createProcessHarness("cluster-state-first", ["node1"]);
    const scyllaPid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    const jmxPid = await spawnReferencedProcess(harness, "node1", "jmx", true);
    const agentPid = await spawnReferencedProcess(harness, "node1", "agent", true);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: scyllaPid,
      scyllaPid,
      jmxPid,
      agentPid,
    });
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "remove-cluster-state-only",
    });

    const failure = await provisioner.remove(harness.cluster).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CcmProcessCleanupError);
    for (const pid of [scyllaPid, jmxPid, agentPid]) {
      expect((failure as Error).message).toContain(String(pid));
    }

    for (const pid of [scyllaPid, jmxPid, agentPid]) {
      await expect(isLiveProcess(pid)).resolves.toBe(true);
    }
    await expect(stat(harness.clusterDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(harness.ccmDirectory)).isDirectory()).toBe(true);
  }, 10_000);

  it("retains a node process identity when CCM removes node state first", async () => {
    const harness = await createProcessHarness("node-state-first", ["node1"]);
    const pid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: pid,
      scyllaPid: pid,
    });
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "remove-node-state-only",
    });

    await expect(
      provisioner.deleteNodeState(harness.cluster, harness.cluster.nodes[0]!),
    ).rejects.toThrow(/referenced processes remain alive/u);

    await expect(isLiveProcess(pid)).resolves.toBe(true);
    await expect(stat(nodeDirectory(harness, "node1"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(harness.clusterDirectory)).isDirectory()).toBe(true);
  }, 10_000);

  it("quarantines a node orphaned from cluster membership during removal", async () => {
    const harness = await createProcessHarness("orphaned-node", ["node1"]);
    const pid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: pid,
      scyllaPid: pid,
    });
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "remove-node-membership-only",
    });

    const removalFailure = await provisioner
      .deleteNodeState(harness.cluster, harness.cluster.nodes[0]!)
      .catch((error: unknown) => error);

    expect(removalFailure).toBeInstanceOf(CcmProcessCleanupError);
    expect(removalFailure).toHaveProperty("message", expect.stringMatching(/orphaned/u));
    await expect(isLiveProcess(pid)).resolves.toBe(true);
    expect((await stat(nodeDirectory(harness, "node1"))).isDirectory()).toBe(true);

    const recordsBeforeClusterRemoval = await readFixtureRecords(harness.capture);
    await expect(provisioner.remove(harness.cluster)).rejects.toThrow(/orphaned/u);
    expect(await readFixtureRecords(harness.capture)).toHaveLength(
      recordsBeforeClusterRemoval.length,
    );
    await expect(isLiveProcess(pid)).resolves.toBe(true);
    expect((await stat(harness.clusterDirectory)).isDirectory()).toBe(true);

    const recoveryProvisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "remove-cluster-state-only",
    });
    const manifest = {
      formatVersion: 1,
      instanceId: harness.cluster.instanceId,
      ccmId: harness.cluster.ccmId,
      token: "a".repeat(32),
      createdAt: new Date(0).toISOString(),
    };
    await expect(
      recoveryProvisioner.cleanupStaleCluster(harness.runDirectory, manifest),
    ).rejects.toThrow(/processes remain alive/u);
    expect(await readFixtureRecords(harness.capture)).toHaveLength(
      recordsBeforeClusterRemoval.length,
    );

    process.kill(pid, "SIGKILL");
    await waitForProcessesToStop([pid]);
    fixturePids.delete(pid);
    await expect(
      recoveryProvisioner.cleanupStaleCluster(harness.runDirectory, manifest),
    ).resolves.toBeUndefined();
    await expect(stat(harness.ccmDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a nonzero CCM stop only after every referenced process is gone", async () => {
    const harness = await createProcessHarness("nonzero-stop-clean", ["node1", "node2"]);
    const firstPid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    const secondPid = await spawnReferencedProcess(harness, "node2", "scylla", true);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: firstPid,
      scyllaPid: firstPid,
    });
    await writeNodeProcessReferences(harness, "node2", {
      nodeConfigPid: secondPid,
      scyllaPid: secondPid,
    });
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "stop-nonzero-kill",
      CCM_FIXTURE_TARGET_PIDS: `${firstPid},${secondPid}`,
    });

    await expect(provisioner.stop(harness.cluster)).resolves.toBeUndefined();
    await expect(isLiveProcess(firstPid)).resolves.toBe(false);
    await expect(isLiveProcess(secondPid)).resolves.toBe(false);
    const records = await readFixtureRecords(harness.capture);
    expect(records).toContainEqual({
      argv: ["stop", "--config-dir", harness.ccmDirectory],
      durableLogAtStart: true,
    });
    const commandLog = await readFile(join(harness.ccmDirectory, "ccm-commands.log"), "utf8");
    expect(commandLog).toContain("[exit 17]");
  });

  it("rejects a nonzero CCM stop while an owned reference remains alive", async () => {
    const harness = await createProcessHarness("nonzero-stop-live", ["node1"]);
    const pid = await spawnReferencedProcess(harness, "node1", "scylla", true);
    await writeNodeProcessReferences(harness, "node1", {
      nodeConfigPid: pid,
      scyllaPid: pid,
    });
    const provisioner = await createProcessProvisioner(harness, {
      CCM_FIXTURE_MODE: "nonzero",
    });

    await expect(provisioner.stop(harness.cluster)).rejects.toThrow(/processes did not stop/u);
    await expect(isLiveProcess(pid)).resolves.toBe(true);
  }, 15_000);
});

interface CommandHarness {
  readonly runDirectory: string;
  readonly ccmDirectory: string;
  readonly diagnosticsDirectory: string;
  readonly fixture: string;
  readonly capture: string;
}

interface ProcessHarness extends CommandHarness {
  readonly clusterDirectory: string;
  readonly cluster: ProvisionedClusterData;
}

interface ProvisionerTestAccess {
  applyYamlOverrides(
    spec: ClusterSpec,
    ccmDirectory: string,
    instanceId: string,
    nodes: readonly TestClusterNode[],
    updateClusterState: boolean,
  ): Promise<void>;
  verifyYamlOverrides(
    spec: ClusterSpec,
    ccmDirectory: string,
    instanceId: string,
    nodes: readonly TestClusterNode[],
  ): Promise<void>;
  configureNodeCertificate(
    node: TestClusterNode,
    ccmDirectory: string,
    caCertificatePath: string,
  ): Promise<void>;
}

type ReferencedProcessKind = "scylla" | "jmx" | "agent" | "wrong";

interface NodeProcessReferences {
  readonly nodeConfigPid?: number;
  readonly scyllaPid?: number;
  readonly jmxPid?: number;
  readonly agentPid?: number;
}

async function createCommandHarness(label: string): Promise<CommandHarness> {
  const root = await createTemporaryDirectory(`${label}-state`);
  const runDirectory = join(root, "runs", `ccm-runtime.${label}`);
  const ccmDirectory = join(runDirectory, "clusters", "alternator-js-process-test");
  await mkdir(ccmDirectory, { recursive: true, mode: 0o700 });
  const instanceId = "alternator-js-process-test";
  await mkdir(join(ccmDirectory, instanceId), { mode: 0o700 });
  await writeFile(join(ccmDirectory, "CURRENT"), `${instanceId}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(ccmDirectory, instanceId, "cluster.conf"),
    JSON.stringify({ name: instanceId, nodes: [] }),
    { encoding: "utf8", mode: 0o600 },
  );
  const diagnosticsDirectory = await createTemporaryDirectory(`${label}-diagnostics`);
  const fixtureDirectory = join(await createTemporaryDirectory(`${label}-fixture`), "fixture space");
  await mkdir(fixtureDirectory, { mode: 0o700 });
  const fixture = join(fixtureDirectory, "fake ccm.mjs");
  const capture = join(fixtureDirectory, "capture.jsonl");
  await writeFile(fixture, fixtureSource(), { encoding: "utf8", mode: 0o700 });
  await chmod(fixture, 0o700);
  return { runDirectory, ccmDirectory, diagnosticsDirectory, fixture, capture };
}

function fixtureSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const capture = process.env.CCM_FIXTURE_CAPTURE;
if (!capture) throw new Error("CCM_FIXTURE_CAPTURE is required");
const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--config-dir");
const configDirectory = configIndex < 0 ? dirname(capture) : argv[configIndex + 1];
const durableLogAtStart = readdirSync(configDirectory)
  .filter((name) => name.startsWith("ccm-command-") && name.endsWith(".log"))
  .some((name) => readFileSync(join(configDirectory, name), "utf8").startsWith("> "));
const capturedEnvironment = process.env.CCM_FIXTURE_CAPTURE_ARCH === "true"
  ? { scyllaArch: process.env.SCYLLA_ARCH }
  : {};
appendFileSync(capture, JSON.stringify({ argv, durableLogAtStart, ...capturedEnvironment }) + "\\n");

if (process.env.CCM_FIXTURE_MODE === "hang") {
  const grandchild = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ], { stdio: "ignore" });
  appendFileSync(capture, JSON.stringify({ pids: [process.pid, grandchild.pid] }) + "\\n");
  process.stdout.write("fixture hanging\\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (process.env.CCM_FIXTURE_MODE === "stop-nonzero-kill") {
  for (const value of (process.env.CCM_FIXTURE_TARGET_PIDS ?? "").split(",")) {
    if (value !== "") process.kill(Number(value), "SIGTERM");
  }
  process.stdout.write("fixture stopped target processes then failed\\n");
  process.exitCode = 17;
} else if (process.env.CCM_FIXTURE_MODE === "nonzero") {
  process.stdout.write("fixture failed without stopping target processes\\n");
  process.exitCode = 17;
} else if (process.env.CCM_FIXTURE_MODE === "remove-command-directory-and-fail") {
  rmSync(configDirectory, { recursive: true, force: true });
  process.stdout.write("fixture removed its command directory then failed\\n");
  process.exitCode = 17;
} else if (process.env.CCM_FIXTURE_MODE === "remove-cluster-state-only") {
  rmSync(join(configDirectory, argv.at(-1)), { recursive: true, force: true });
  process.stdout.write("fixture removed cluster state only\\n");
} else if (process.env.CCM_FIXTURE_MODE === "remove-node-state-only") {
  const clusterName = readFileSync(join(configDirectory, "CURRENT"), "utf8").trim();
  const clusterDirectory = join(configDirectory, clusterName);
  rmSync(join(clusterDirectory, argv[0]), { recursive: true, force: true });
  const configurationPath = join(clusterDirectory, "cluster.conf");
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  configuration.nodes = configuration.nodes.filter((name) => name !== argv[0]);
  writeFileSync(configurationPath, JSON.stringify(configuration));
  process.stdout.write("fixture removed node state only\\n");
} else if (process.env.CCM_FIXTURE_MODE === "remove-node-membership-only") {
  const clusterName = readFileSync(join(configDirectory, "CURRENT"), "utf8").trim();
  const configurationPath = join(configDirectory, clusterName, "cluster.conf");
  const configuration = JSON.parse(readFileSync(configurationPath, "utf8"));
  configuration.nodes = configuration.nodes.filter((name) => name !== argv[0]);
  writeFileSync(configurationPath, JSON.stringify(configuration));
  process.stdout.write("fixture removed node membership before stopping it\\n");
  process.exitCode = 17;
} else {
  process.stdout.write("fixture completed\\n");
}
`;
}

async function createProcessHarness(
  label: string,
  nodeNames: readonly string[],
): Promise<ProcessHarness> {
  const commandHarness = await createCommandHarness(label);
  const instanceId = "alternator-js-process-test";
  const clusterDirectory = join(commandHarness.ccmDirectory, instanceId);
  await mkdir(clusterDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(clusterDirectory, "cluster.conf"),
    JSON.stringify({ name: instanceId, nodes: nodeNames }),
    { encoding: "utf8", mode: 0o600 },
  );
  const nodes = nodeNames.map((name, index) =>
    new TestClusterNode({
      name,
      address: `127.0.88.${index + 1}`,
      datacenter: "datacenter1",
      rack: "rack1",
    })
  );
  for (const node of nodes) {
    const directory = join(clusterDirectory, node.name);
    await mkdir(join(directory, "bin"), { recursive: true, mode: 0o700 });
    await mkdir(join(directory, "conf"), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "node.conf"), JSON.stringify({ name: node.name }), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return {
    ...commandHarness,
    clusterDirectory,
    cluster: {
      instanceId,
      ccmId: 88,
      ccmDirectory: commandHarness.ccmDirectory,
      spec: new ClusterSpec().withTransports(AlternatorTransport.HTTP),
      nodes: Object.freeze(nodes),
    },
  };
}

async function createProcessProvisioner(
  harness: ProcessHarness,
  environment: NodeJS.ProcessEnv = {},
): Promise<CcmProvisioner> {
  return CcmProvisioner.create(harness.runDirectory, {
    ccmExecutable: harness.fixture,
    diagnosticsDirectory: harness.diagnosticsDirectory,
    environment: {
      ...process.env,
      CCM_FIXTURE_CAPTURE: harness.capture,
      CCM_FIXTURE_MODE: "success",
      ...environment,
    },
  });
}

async function spawnReferencedProcess(
  harness: ProcessHarness,
  nodeName: string,
  kind: ReferencedProcessKind,
  correctMarker: boolean,
): Promise<number> {
  const directory = nodeDirectory(harness, nodeName);
  const executable = await processExecutable(directory, kind);
  const keepAlive = "setInterval(() => {}, 1000)";
  const argumentsList = kind === "jmx"
    ? ["-e", keepAlive, "--", "-jar", join(directory, "bin", "scylla-jmx-1.0.jar")]
    : kind === "agent"
      ? [
          "-e",
          keepAlive,
          "--",
          "--config-file",
          join(directory, "conf", "scylla-manager-agent.yaml"),
        ]
      : ["-e", keepAlive];
  const child = spawn(executable, argumentsList, {
    env: {
      ...process.env,
      SCYLLA_CCM_RUN_DIR: correctMarker
        ? harness.runDirectory
        : `${harness.runDirectory}.unrelated`,
    },
    shell: false,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to start ${kind} process fixture`);
  }
  fixturePids.add(pid);
  child.unref();
  await waitForProcessToStart(pid);
  return pid;
}

async function processExecutable(
  nodePath: string,
  kind: ReferencedProcessKind,
): Promise<string> {
  if (kind === "wrong") {
    return process.execPath;
  }
  const executable = kind === "scylla"
    ? join(nodePath, "bin", "scylla")
    : kind === "jmx"
      ? join(nodePath, "bin", "symlinks", "scylla-jmx")
      : join(nodePath, "bin", "scylla-manager-agent");
  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  await symlink(process.execPath, executable);
  return executable;
}

async function writeNodeProcessReferences(
  harness: ProcessHarness,
  nodeName: string,
  references: NodeProcessReferences,
): Promise<void> {
  const directory = nodeDirectory(harness, nodeName);
  await writeFile(
    nodeConfigPath(harness, nodeName),
    JSON.stringify({
      name: nodeName,
      ...(references.nodeConfigPid === undefined ? {} : { pid: references.nodeConfigPid }),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  for (const [filename, pid] of [
    ["cassandra.pid", references.scyllaPid],
    ["scylla-jmx.pid", references.jmxPid],
    ["scylla-agent.pid", references.agentPid],
  ] as const) {
    if (pid !== undefined) {
      await writeFile(join(directory, filename), `${pid}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }
}

function nodeDirectory(harness: ProcessHarness, nodeName: string): string {
  return join(harness.clusterDirectory, nodeName);
}

function nodeConfigPath(harness: ProcessHarness, nodeName: string): string {
  return join(nodeDirectory(harness, nodeName), "node.conf");
}

async function waitForProcessToStart(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await isLiveProcess(pid)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Process fixture ${pid} did not start`);
}

async function findForeignLivePid(): Promise<number | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return undefined;
  }
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (pid < 2 || !(await isLiveProcess(pid))) {
      continue;
    }
    try {
      if ((await stat(`/proc/${pid}`)).uid !== uid) {
        return pid;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return undefined;
}

function testNode(name: string): TestClusterNode {
  return new TestClusterNode({
    name,
    address: "127.0.88.1",
    datacenter: "datacenter1",
    rack: "rack1",
  });
}

function testCluster(ccmDirectory: string, node: TestClusterNode): ProvisionedClusterData {
  return {
    instanceId: "alternator-js-process-test",
    ccmId: 88,
    ccmDirectory,
    spec: new ClusterSpec().withTransports(AlternatorTransport.HTTP),
    nodes: Object.freeze([node]),
  };
}

async function createTemporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `alternator-js-ccm-${label}-`));
  temporaryDirectories.push(path);
  await chmod(path, 0o700);
  return path;
}

async function readFixtureRecords(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function fixtureProcessIds(records: readonly unknown[]): number[] {
  for (const record of records) {
    if (!isRecord(record) || !Array.isArray(record.pids)) {
      continue;
    }
    const pids = record.pids.filter((value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 1
    );
    if (pids.length === record.pids.length) {
      return pids;
    }
  }
  throw new Error("Fixture did not record valid process IDs");
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
