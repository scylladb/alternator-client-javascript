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

import { randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { TestClusterNode } from "./model.js";
import {
  AlternatorTransport,
  AuthenticationMode,
  AuthorizationMode,
  type ClusterSpec,
  type ClusterTopology,
} from "./spec.js";
import type { ClusterManifest } from "./run-state.js";

export const PINNED_CCM_COMMIT = "d15a2fab9d22fffad8a30c806a7c8e1632e58aae";
export const HTTP_PORT = 8080;
export const HTTPS_PORT = 8043;
export const STORAGE_PORT = 7000;
export const API_PORT = 10_000;
export const JMX_PORT = 7199;

const GOSSIPING_PROPERTY_FILE_SNITCH =
  "org.apache.cassandra.locator.GossipingPropertyFileSnitch";
const TEST_USER = "alternator_tests";
const TEST_SALTED_PASSWORD =
  "$6$IcPWfCigHWVhHTf.$h3.30m5R2CnYqIeniCumbXCBxBxvtYPP3MbZVsjKcu268ESOcrUtSJwf1iO1s83KUT3waITRtTiexBdSWEI0Q/";
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const READINESS_TIMEOUT_MS = 5 * 60_000;
const PROCESS_TERM_GRACE_MS = 2_000;
const PROCESS_KILL_GRACE_MS = 5_000;
const INSTANCE_NAME_PATTERN = /^alternator-js-[a-zA-Z0-9_-]+$/u;
const CCM_IMPLICIT_NODE_KEYS = new Set([
  "hinted_handoff_enabled",
  "commitlog_sync",
  "commitlog_sync_period_in_ms",
  "commitlog_sync_batch_window_in_ms",
]);
const UNSUPPORTED_CCM_ENVIRONMENT = [
  "SCYLLA_EXT_ENV",
  "SCYLLA_EXT_OPTS",
  "SCYLLA_MANAGER_PACKAGE",
] as const;
const SKIPPED_DIAGNOSTIC_DIRECTORIES = new Set([
  "bin",
  "data",
  "commitlogs",
  "hints",
  "view_hints",
  "saved_caches",
]);

export interface ProvisionedClusterData {
  readonly instanceId: string;
  readonly ccmId: number;
  readonly ccmDirectory: string;
  readonly spec: ClusterSpec;
  readonly nodes: readonly TestClusterNode[];
  readonly caCertificatePath?: string;
  readonly credentials?: Readonly<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
}

export interface ClusterProvisioner {
  readonly runDirectory: string;
  provision(spec: ClusterSpec, instanceId: string, ccmId: number): Promise<ProvisionedClusterData>;
  start(cluster: ProvisionedClusterData, nodes?: readonly TestClusterNode[]): Promise<void>;
  stop(cluster: ProvisionedClusterData): Promise<void>;
  startNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void>;
  stopNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void>;
  addNode(
    cluster: ProvisionedClusterData,
    datacenter: string,
    rack: string,
  ): Promise<TestClusterNode>;
  decommissionNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void>;
  deleteNodeState(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void>;
  isHealthy(cluster: ProvisionedClusterData): Promise<boolean>;
  isNodeRunning(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<boolean>;
  waitForNodeReady(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void>;
  remove(cluster: ProvisionedClusterData): Promise<void>;
}

export interface CcmProvisionerOptions {
  readonly diagnosticsDirectory?: string;
  readonly ccmExecutable?: string;
  readonly commandTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

export class CcmCommandError extends Error {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly output: string;

  constructor(command: readonly string[], exitCode: number, output: string) {
    super(
      `CCM command failed with ${exitCode === -1 ? "a timeout" : `exit code ${exitCode}`}: ${command.join(" ")}`,
    );
    this.name = "CcmCommandError";
    this.command = Object.freeze([...command]);
    this.exitCode = exitCode;
    this.output = output;
  }
}

export class CcmProcessCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CcmProcessCleanupError";
  }
}

export class CcmClusterProvisioningError extends Error {
  readonly cluster: ProvisionedClusterData;
  readonly recoveryRequired: boolean;
  readonly suppressed: readonly Error[];

  constructor(
    cluster: ProvisionedClusterData,
    cause: unknown,
    rollbackFailure: unknown,
    recoveryRequired: boolean,
  ) {
    super(`Failed to provision '${cluster.instanceId}' and CCM rollback failed`, { cause });
    this.name = "CcmClusterProvisioningError";
    this.cluster = cluster;
    this.recoveryRequired = recoveryRequired;
    this.suppressed = rollbackFailure instanceof Error ? Object.freeze([rollbackFailure]) : [];
  }
}

export class CcmNodeProvisioningError extends Error {
  readonly node: TestClusterNode;
  readonly clusterStateAmbiguous: boolean;
  readonly nodeRemainsProvisioned: boolean;
  readonly recoveryRequired: boolean;

  constructor(
    node: TestClusterNode,
    cause: unknown,
    values: {
      readonly clusterStateAmbiguous: boolean;
      readonly nodeRemainsProvisioned: boolean;
      readonly recoveryRequired: boolean;
    },
  ) {
    super(`Failed to provision '${node.name}'`, { cause });
    this.name = "CcmNodeProvisioningError";
    this.node = node;
    this.clusterStateAmbiguous = values.clusterStateAmbiguous;
    this.nodeRemainsProvisioned = values.nodeRemainsProvisioned;
    this.recoveryRequired = values.recoveryRequired;
  }
}

export class CcmProvisioner implements ClusterProvisioner {
  readonly runDirectory: string;
  readonly diagnosticsDirectory: string;

  private readonly clustersDirectory: string;
  private readonly ccmExecutable: string;
  private readonly commandTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;

  private constructor(
    runDirectory: string,
    diagnosticsDirectory: string,
    options: CcmProvisionerOptions,
  ) {
    this.runDirectory = runDirectory;
    this.clustersDirectory = join(runDirectory, "clusters");
    this.diagnosticsDirectory = diagnosticsDirectory;
    this.ccmExecutable = options.ccmExecutable ?? options.environment?.SCYLLA_CCM_PATH ?? "ccm";
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
    this.environment = options.environment ?? process.env;
  }

  static async create(
    runDirectory: string,
    options: CcmProvisionerOptions = {},
  ): Promise<CcmProvisioner> {
    requireLinux();
    const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error("commandTimeoutMs must be positive and finite");
    }
    const readinessTimeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS;
    if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
      throw new Error("readinessTimeoutMs must be positive and finite");
    }
    const normalizedRun = resolve(runDirectory);
    await validateDirectory(normalizedRun);
    const clusters = join(normalizedRun, "clusters");
    await mkdir(clusters, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    });
    await validateDirectory(clusters);

    const configuredDiagnostics =
      options.diagnosticsDirectory ??
      options.environment?.SCYLLA_CCM_DIAGNOSTICS_DIR ??
      join(process.cwd(), ".ccm-diagnostics");
    const diagnostics = resolve(configuredDiagnostics);
    const runsDirectory = dirname(normalizedRun);
    const stateRoot = dirname(runsDirectory);
    if (pathsOverlap(stateRoot, diagnostics)) {
      throw new Error(`CCM diagnostics directory must not overlap harness state root ${stateRoot}`);
    }
    await mkdir(diagnostics, { recursive: true, mode: 0o700 });
    await validateDirectory(diagnostics);
    const [actualStateRoot, actualDiagnostics] = await Promise.all([
      realpath(stateRoot),
      realpath(diagnostics),
    ]);
    if (pathsOverlap(actualStateRoot, actualDiagnostics)) {
      throw new Error(
        `CCM diagnostics directory must not overlap harness state root ${actualStateRoot}`,
      );
    }
    return new CcmProvisioner(normalizedRun, actualDiagnostics, options);
  }

  async provision(
    spec: ClusterSpec,
    instanceId: string,
    ccmId: number,
  ): Promise<ProvisionedClusterData> {
    spec.validate();
    const ccmDirectory = ownedChild(this.clustersDirectory, instanceId);
    await mkdir(ccmDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    });
    await validateDirectory(ccmDirectory);
    const nodes = buildNodes(spec.topology, ccmId);
    let caCertificatePath: string | undefined;
    const credentials = spec.security.enforceAlternatorAuthorization
      ? Object.freeze({ accessKeyId: TEST_USER, secretAccessKey: TEST_SALTED_PASSWORD })
      : undefined;

    try {
      if (spec.hasTransport(AlternatorTransport.HTTPS)) {
        caCertificatePath = await this.createCertificateAuthority(instanceId, ccmDirectory);
      }
      const createArguments = [
        "create",
        "--config-dir",
        ccmDirectory,
        instanceId,
        "--scylla",
        "--version",
        spec.scyllaVersion,
        "--nodes",
        firstRackCounts(spec.topology),
        "--id",
        String(ccmId),
      ];
      if (spec.topology.datacenters.length > 1) {
        createArguments.push("--snitch", GOSSIPING_PROPERTY_FILE_SNITCH);
      }
      await this.runCcm(ccmDirectory, createArguments);
      await this.addAdditionalRackNodes(spec, nodes, ccmDirectory);
      await this.configure(spec, nodes, ccmDirectory, instanceId);
      if (caCertificatePath !== undefined) {
        for (const node of nodes) {
          await this.configureNodeCertificate(node, ccmDirectory, caCertificatePath);
        }
      }
      await this.applyYamlOverrides(spec, ccmDirectory, instanceId, nodes, false);
      await this.verifyYamlOverrides(spec, ccmDirectory, instanceId, nodes);

      const cluster = withOptionalFields(
        {
          instanceId,
          ccmId,
          ccmDirectory,
          spec,
          nodes: Object.freeze([...nodes]),
        },
        caCertificatePath,
        credentials,
      );
      await this.start(cluster);
      return cluster;
    } catch (provisioningFailure) {
      const cluster = withOptionalFields(
        {
          instanceId,
          ccmId,
          ccmDirectory,
          spec,
          nodes: Object.freeze([...nodes]),
        },
        caCertificatePath,
        credentials,
      );
      let diagnosticFailure: unknown;
      try {
        await this.collectDiagnostics(instanceId, ccmDirectory);
      } catch (error) {
        diagnosticFailure = error;
      }
      const recoveryRequired = containsProcessCleanupError(provisioningFailure);
      if (recoveryRequired || diagnosticFailure !== undefined) {
        throw new CcmClusterProvisioningError(
          cluster,
          provisioningFailure,
          diagnosticFailure ?? new Error("CCM command process cleanup is unproven"),
          recoveryRequired,
        );
      }
      try {
        await this.removeByName(instanceId, ccmDirectory);
      } catch (rollbackFailure) {
        throw new CcmClusterProvisioningError(
          cluster,
          provisioningFailure,
          rollbackFailure,
          containsProcessCleanupError(rollbackFailure),
        );
      }
      throw asError(provisioningFailure);
    }
  }

  async start(
    cluster: ProvisionedClusterData,
    nodes: readonly TestClusterNode[] = cluster.nodes,
  ): Promise<void> {
    for (const node of nodes) {
      const processes = await this.prepareNodeProcessReferences(cluster, node.name);
      if (!processes.scyllaRunning) {
        if (processes.ancillaryRunning) {
          throw new CcmProcessCleanupError(
            `Cannot restart CCM node '${node.name}' while ancillary process remains alive`,
          );
        }
        await this.runCcm(cluster.ccmDirectory, startArguments(cluster, node.name));
      }
    }
    await this.waitForAlternator(cluster, nodes, this.readinessTimeoutMs);
  }

  async stop(cluster: ProvisionedClusterData): Promise<void> {
    const processes = await this.prepareClusterProcessReferences(cluster);
    if (!processes.scyllaRunning && !processes.ancillaryRunning) {
      return;
    }
    let commandFailure: unknown;
    try {
      await this.runCcm(cluster.ccmDirectory, ["stop", "--config-dir", cluster.ccmDirectory]);
    } catch (error) {
      commandFailure = error;
    }
    await this.waitForNodesStopped(cluster, cluster.nodes);
    if (commandFailure !== undefined && !(commandFailure instanceof CcmCommandError)) {
      throw asError(commandFailure);
    }
  }

  async startNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    const processes = await this.prepareNodeProcessReferences(cluster, node.name);
    if (!processes.scyllaRunning) {
      if (processes.ancillaryRunning) {
        throw new CcmProcessCleanupError(
          `Cannot restart CCM node '${node.name}' while ancillary process remains alive`,
        );
      }
      await this.runCcm(cluster.ccmDirectory, startArguments(cluster, node.name));
    }
    await this.waitForNodeReady(cluster, node);
  }

  async stopNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    const processes = await this.prepareNodeProcessReferences(cluster, node.name);
    if (!processes.scyllaRunning && !processes.ancillaryRunning) {
      return;
    }
    let commandFailure: unknown;
    try {
      await this.runCcm(cluster.ccmDirectory, [
        node.name,
        "stop",
        "--config-dir",
        cluster.ccmDirectory,
      ]);
    } catch (error) {
      commandFailure = error;
    }
    await this.waitForNodesStopped(cluster, [node]);
    if (commandFailure !== undefined && !(commandFailure instanceof CcmCommandError)) {
      throw asError(commandFailure);
    }
  }

  async addNode(
    cluster: ProvisionedClusterData,
    datacenter: string,
    rack: string,
  ): Promise<TestClusterNode> {
    const index = lowestFreeNodeIndex(cluster.nodes);
    const node = new TestClusterNode({
      name: `node${index}`,
      address: `127.0.${cluster.ccmId}.${index}`,
      datacenter,
      rack,
    });
    let startAttempted = false;
    try {
      await this.runCcm(cluster.ccmDirectory, [
        "add",
        "--config-dir",
        cluster.ccmDirectory,
        node.name,
        "--scylla",
        "--seeds",
        "--auto-bootstrap",
        "--itf",
        node.address,
        "--data-center",
        datacenter,
        "--rack",
        rack,
      ]);
      if (cluster.caCertificatePath !== undefined) {
        await this.configureNodeCertificate(node, cluster.ccmDirectory, cluster.caCertificatePath);
      }
      await this.applyYamlOverrides(
        cluster.spec,
        cluster.ccmDirectory,
        cluster.instanceId,
        [node],
        false,
      );
      await this.verifyYamlOverrides(cluster.spec, cluster.ccmDirectory, cluster.instanceId, [node]);
      startAttempted = true;
      await this.startNode(cluster, node);
      return node;
    } catch (provisioningFailure) {
      let diagnosticFailure: unknown;
      try {
        await this.collectDiagnostics(cluster.instanceId, cluster.ccmDirectory);
      } catch (error) {
        diagnosticFailure = error;
      }
      const recoveryRequired = containsProcessCleanupError(provisioningFailure);
      if (recoveryRequired || diagnosticFailure !== undefined) {
        throw new CcmNodeProvisioningError(node, provisioningFailure, {
          clusterStateAmbiguous: true,
          nodeRemainsProvisioned: true,
          recoveryRequired,
        });
      }
      try {
        await this.removeNodeByName(cluster, node.name);
      } catch (rollbackFailure) {
        throw new CcmNodeProvisioningError(node, provisioningFailure, {
          clusterStateAmbiguous: true,
          nodeRemainsProvisioned: (await this.nodeState(cluster, node.name)) !== "absent",
          recoveryRequired: containsProcessCleanupError(rollbackFailure),
        });
      }
      throw new CcmNodeProvisioningError(node, provisioningFailure, {
        clusterStateAmbiguous: startAttempted,
        nodeRemainsProvisioned: false,
        recoveryRequired: false,
      });
    }
  }

  async decommissionNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    await this.runCcm(cluster.ccmDirectory, [
      node.name,
      "decommission",
      "--config-dir",
      cluster.ccmDirectory,
    ]);
  }

  async deleteNodeState(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    await this.collectDiagnostics(cluster.instanceId, cluster.ccmDirectory);
    await this.removeNodeByName(cluster, node.name);
  }

  async isHealthy(cluster: ProvisionedClusterData): Promise<boolean> {
    try {
      await this.waitForAlternator(cluster, cluster.nodes, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  async isNodeRunning(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<boolean> {
    return (await this.prepareNodeProcessReferences(cluster, node.name)).scyllaRunning;
  }

  async waitForNodeReady(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    await this.waitForAlternator(cluster, [node], this.readinessTimeoutMs);
  }

  async remove(cluster: ProvisionedClusterData): Promise<void> {
    await this.collectDiagnostics(cluster.instanceId, cluster.ccmDirectory);
    await this.removeByName(cluster.instanceId, cluster.ccmDirectory);
  }

  async cleanupStaleCluster(
    runDirectory: string,
    manifest: ClusterManifest,
  ): Promise<void> {
    if (resolve(runDirectory) !== this.runDirectory) {
      throw new Error(`Stale cleanup run mismatch: ${runDirectory}`);
    }
    const ccmDirectory = ownedChild(this.clustersDirectory, manifest.instanceId);
    await this.collectDiagnostics(manifest.instanceId, ccmDirectory);
    await this.removeByName(manifest.instanceId, ccmDirectory, true);
  }

  private async configure(
    spec: ClusterSpec,
    nodes: readonly TestClusterNode[],
    ccmDirectory: string,
    instanceId: string,
  ): Promise<void> {
    const options = new Map<string, string>();
    options.set("alternator_write_isolation", "only_rmw_uses_lwt");
    options.set("endpoint_snitch", GOSSIPING_PROPERTY_FILE_SNITCH);
    options.set("start_native_transport", "true");
    if (spec.hasTransport(AlternatorTransport.HTTP)) {
      options.set("alternator_port", String(HTTP_PORT));
    }
    if (spec.hasTransport(AlternatorTransport.HTTPS)) {
      options.set("alternator_https_port", String(HTTPS_PORT));
      options.set("alternator_encryption_options.enable_session_tickets", "true");
    }
    if (spec.security.authentication !== AuthenticationMode.ALLOW_ALL) {
      options.set("authenticator", authenticator(spec.security.authentication));
      options.set("auth_superuser_name", TEST_USER);
      options.set("auth_superuser_salted_password", TEST_SALTED_PASSWORD);
    }
    if (spec.security.authorization !== AuthorizationMode.ALLOW_ALL) {
      options.set("authorizer", authorizer(spec.security.authorization));
    }
    if (spec.security.enforceAlternatorAuthorization) {
      options.set("alternator_enforce_authorization", "true");
    }
    for (const [key, value] of spec.yamlOverrides) {
      options.set(key, value);
    }
    const argumentsList = ["updateconf", "--config-dir", ccmDirectory];
    for (const [key, value] of [...options].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      argumentsList.push(`${key}:${value}`);
    }
    await this.runCcm(ccmDirectory, argumentsList);
    await this.applyYamlOverrides(spec, ccmDirectory, instanceId, nodes, true);
  }

  private async addAdditionalRackNodes(
    spec: ClusterSpec,
    nodes: readonly TestClusterNode[],
    ccmDirectory: string,
  ): Promise<void> {
    const firstRackNodeCount = spec.topology.datacenters.reduce(
      (count, datacenter) => count + datacenter.racks[0]!.nodeCount,
      0,
    );
    for (const node of nodes.slice(firstRackNodeCount)) {
      await this.runCcm(ccmDirectory, [
        "add",
        "--config-dir",
        ccmDirectory,
        node.name,
        "--scylla",
        "--seeds",
        "--itf",
        node.address,
        "--data-center",
        node.datacenter,
        "--rack",
        node.rack,
      ]);
    }
  }

  private async createCertificateAuthority(
    instanceId: string,
    ccmDirectory: string,
  ): Promise<string> {
    const tlsDirectory = join(ccmDirectory, "tls");
    await mkdir(tlsDirectory, { mode: 0o700 });
    const certificatePath = join(tlsDirectory, "ca.crt");
    await this.runCommand(ccmDirectory, [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-nodes",
      "-days",
      "730",
      "-subj",
      `/CN=${instanceId} test CA`,
      "-keyout",
      join(tlsDirectory, "ca.key"),
      "-out",
      certificatePath,
    ]);
    return certificatePath;
  }

  private async configureNodeCertificate(
    node: TestClusterNode,
    ccmDirectory: string,
    caCertificatePath: string,
  ): Promise<void> {
    const tlsDirectory = join(ccmDirectory, "tls");
    const nodeDirectory = join(tlsDirectory, node.name);
    await mkdir(nodeDirectory, { recursive: true, mode: 0o700 });
    const certificatePath = join(nodeDirectory, "server.crt");
    const keyPath = join(nodeDirectory, "server.key");
    const requestPath = join(nodeDirectory, "server.csr");
    const extensionPath = join(nodeDirectory, "server.ext");
    await writeFile(
      extensionPath,
      "basicConstraints=critical,CA:FALSE\n" +
        "keyUsage=critical,digitalSignature,keyEncipherment\n" +
        "extendedKeyUsage=serverAuth\n" +
        `subjectAltName=IP:${node.address}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await this.runCommand(ccmDirectory, [
      "openssl",
      "req",
      "-newkey",
      "rsa:3072",
      "-sha256",
      "-nodes",
      "-subj",
      `/CN=${node.name}`,
      "-keyout",
      keyPath,
      "-out",
      requestPath,
    ]);
    await this.runCommand(ccmDirectory, [
      "openssl",
      "x509",
      "-req",
      "-in",
      requestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      join(tlsDirectory, "ca.key"),
      "-CAcreateserial",
      "-days",
      "365",
      "-sha256",
      "-extfile",
      extensionPath,
      "-out",
      certificatePath,
    ]);
    await this.runCcm(ccmDirectory, [
      node.name,
      "updateconf",
      "--config-dir",
      ccmDirectory,
      `alternator_encryption_options.certificate:${JSON.stringify(certificatePath)}`,
      `alternator_encryption_options.keyfile:${JSON.stringify(keyPath)}`,
    ]);
  }

  private async applyYamlOverrides(
    spec: ClusterSpec,
    ccmDirectory: string,
    instanceId: string,
    nodes: readonly TestClusterNode[],
    updateClusterState: boolean,
  ): Promise<void> {
    if (spec.yamlOverrides.size === 0) {
      return;
    }
    const clusterDirectory = join(ccmDirectory, instanceId);
    const parsedOverrides = parseOverrides(spec.yamlOverrides);
    if (updateClusterState) {
      const clusterConfig = join(clusterDirectory, "cluster.conf");
      const clusterYaml = await readYamlMap(clusterConfig);
      const configOptions = childMap(clusterYaml, "config_options", true);
      applyDottedValues(configOptions, parsedOverrides);
      await writeYamlMap(clusterConfig, clusterYaml);
    }
    const overriddenImplicitKeys = [...parsedOverrides.keys()].filter((key) =>
      CCM_IMPLICIT_NODE_KEYS.has(key),
    );
    for (const node of nodes) {
      const nodeDirectory = join(clusterDirectory, node.name);
      const nodeConfig = join(nodeDirectory, "node.conf");
      if (overriddenImplicitKeys.length !== 0 && (await pathExists(nodeConfig))) {
        const nodeYaml = await readYamlMap(nodeConfig);
        const configOptions = childMap(nodeYaml, "config_options", false);
        if (configOptions !== undefined) {
          for (const key of overriddenImplicitKeys) {
            delete configOptions[key];
          }
          await writeYamlMap(nodeConfig, nodeYaml);
        }
      }
      const scyllaConfig = join(nodeDirectory, "conf", "scylla.yaml");
      const scyllaYaml = await readYamlMap(scyllaConfig);
      applyDottedValues(scyllaYaml, parsedOverrides);
      await writeYamlMap(scyllaConfig, scyllaYaml);
    }
  }

  private async verifyYamlOverrides(
    spec: ClusterSpec,
    ccmDirectory: string,
    instanceId: string,
    nodes: readonly TestClusterNode[],
  ): Promise<void> {
    if (spec.yamlOverrides.size === 0) {
      return;
    }
    const expected = parseOverrides(spec.yamlOverrides);
    const clusterDirectory = join(ccmDirectory, instanceId);
    const clusterYaml = await readYamlMap(join(clusterDirectory, "cluster.conf"));
    verifyDottedValues(childMap(clusterYaml, "config_options", false), expected, "CCM cluster");
    for (const node of nodes) {
      const path = join(clusterDirectory, node.name, "conf", "scylla.yaml");
      verifyDottedValues(await readYamlMap(path), expected, path);
    }
  }

  private async waitForAlternator(
    cluster: ProvisionedClusterData,
    nodes: readonly TestClusterNode[],
    timeoutMs: number,
  ): Promise<void> {
    const endpoints: URL[] = [];
    for (const node of nodes) {
      if (cluster.spec.hasTransport(AlternatorTransport.HTTP)) {
        endpoints.push(new URL(`http://${node.address}:${HTTP_PORT}/`));
      }
      if (cluster.spec.hasTransport(AlternatorTransport.HTTPS)) {
        endpoints.push(new URL(`https://${node.address}:${HTTPS_PORT}/`));
      }
    }
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      let ready = true;
      for (const endpoint of endpoints) {
        try {
          const status = await requestStatus(endpoint, Math.min(5_000, deadline - Date.now()));
          if (status < 200 || status >= 300) {
            ready = false;
            break;
          }
        } catch (error) {
          lastError = error;
          ready = false;
          break;
        }
      }
      if (ready) {
        return;
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Alternator endpoints for cluster '${cluster.instanceId}' did not become ready`, {
      cause: lastError,
    });
  }

  private async prepareClusterProcessReferences(
    cluster: ProvisionedClusterData | string,
    recoverOrphanedNodes = false,
  ): Promise<PreparedNodeProcesses> {
    const clusterDirectory =
      typeof cluster === "string" ? cluster : this.clusterDirectory(cluster);
    const configuration = await readYamlMap(join(clusterDirectory, "cluster.conf"));
    if (!Array.isArray(configuration.nodes)) {
      throw new CcmProcessCleanupError(
        `Invalid nodes list in ${join(clusterDirectory, "cluster.conf")}`,
      );
    }
    const nodeNames: string[] = [];
    const listedNodeNames = new Set<string>();
    const orphanedNodeNames = new Set<string>();
    for (const nodeName of configuration.nodes) {
      if (typeof nodeName !== "string" || !/^node[1-9][0-9]*$/u.test(nodeName)) {
        throw new CcmProcessCleanupError(
          `Unsafe node name in ${join(clusterDirectory, "cluster.conf")}`,
        );
      }
      nodeNames.push(nodeName);
      listedNodeNames.add(nodeName);
    }
    for (const entry of await readdir(clusterDirectory, { withFileTypes: true })) {
      if (
        /^node[1-9][0-9]*$/u.test(entry.name) &&
        !listedNodeNames.has(entry.name) &&
        (entry.isDirectory() || entry.isSymbolicLink())
      ) {
        if (!recoverOrphanedNodes) {
          throw new CcmProcessCleanupError(
            `CCM node '${entry.name}' is orphaned from ${join(clusterDirectory, "cluster.conf")}`,
          );
        }
        nodeNames.push(entry.name);
        orphanedNodeNames.add(entry.name);
      }
    }
    const preparedNodes: PreparedNodeProcesses[] = [];
    for (const nodeName of nodeNames) {
      const processes = await this.prepareNodeProcessReferencesAt(clusterDirectory, nodeName);
      if (
        orphanedNodeNames.has(nodeName) &&
        (processes.scyllaRunning || processes.ancillaryRunning)
      ) {
        throw new CcmProcessCleanupError(
          `Cannot recover orphaned CCM node '${nodeName}' while its processes remain alive`,
        );
      }
      preparedNodes.push(processes);
    }
    return mergePreparedProcesses(preparedNodes);
  }

  private prepareNodeProcessReferences(
    cluster: ProvisionedClusterData,
    nodeName: string,
  ): Promise<PreparedNodeProcesses> {
    return this.prepareNodeProcessReferencesAt(this.clusterDirectory(cluster), nodeName);
  }

  private async prepareNodeProcessReferencesAt(
    clusterDirectory: string,
    nodeName: string,
  ): Promise<PreparedNodeProcesses> {
    if (!/^node[1-9][0-9]*$/u.test(nodeName)) {
      throw new CcmProcessCleanupError(`Unsafe CCM node name: ${nodeName}`);
    }
    const nodeDirectory = join(clusterDirectory, nodeName);
    if (!(await pathExists(nodeDirectory))) {
      return { scyllaRunning: false, ancillaryRunning: false, identities: [] };
    }
    await validateDirectory(nodeDirectory);
    const nodeConfigPath = join(nodeDirectory, "node.conf");
    let nodeConfig: Record<string, unknown> | undefined;
    let configuredPid: number | undefined;
    let configuredInspection: ProcessReferenceInspection = { state: "absent" };
    if (await pathExists(nodeConfigPath)) {
      nodeConfig = await readYamlMap(nodeConfigPath);
      if (nodeConfig.name !== nodeName || "docker_id" in nodeConfig) {
        throw new CcmProcessCleanupError(`Unsafe CCM node configuration: ${nodeConfigPath}`);
      }
      if (nodeConfig.pid !== undefined && nodeConfig.pid !== null) {
        configuredPid = parsePidValue(nodeConfig.pid, nodeConfigPath);
        configuredInspection = await this.inspectProcessReference(
          configuredPid,
          nodeConfigPath,
          nodeDirectory,
          "scylla",
        );
      }
    }

    const scyllaPidPath = join(nodeDirectory, "cassandra.pid");
    const scyllaPid = await readOptionalPid(scyllaPidPath);
    const scyllaInspection = await this.inspectProcessReference(
      scyllaPid,
      scyllaPidPath,
      nodeDirectory,
      "scylla",
    );
    if (
      scyllaInspection.state === "owned" &&
      (configuredInspection.state !== "owned" || configuredPid !== scyllaPid)
    ) {
      throw new CcmProcessCleanupError(
        `CCM cannot safely stop Scylla PID ${scyllaPid} because node.conf does not reference same process`,
      );
    }

    const jmxPidPath = join(nodeDirectory, "scylla-jmx.pid");
    const jmxPid = await readOptionalPid(jmxPidPath);
    const jmxInspection = await this.inspectProcessReference(
      jmxPid,
      jmxPidPath,
      nodeDirectory,
      "jmx",
    );
    const agentPidPath = join(nodeDirectory, "scylla-agent.pid");
    const agentPid = await readOptionalPid(agentPidPath);
    const agentInspection = await this.inspectProcessReference(
      agentPid,
      agentPidPath,
      nodeDirectory,
      "agent",
    );

    if (configuredInspection.state === "dead" && nodeConfig !== undefined) {
      delete nodeConfig.pid;
      await writeYamlMap(nodeConfigPath, nodeConfig);
    }
    await deleteDeadPidFile(scyllaPidPath, scyllaInspection.state);
    await deleteDeadPidFile(jmxPidPath, jmxInspection.state);
    await deleteDeadPidFile(agentPidPath, agentInspection.state);
    return {
      scyllaRunning:
        configuredInspection.state === "owned" || scyllaInspection.state === "owned",
      ancillaryRunning: jmxInspection.state === "owned" || agentInspection.state === "owned",
      identities: uniqueProcessIdentities([
        configuredInspection,
        scyllaInspection,
        jmxInspection,
        agentInspection,
      ]),
    };
  }

  private async inspectProcessReference(
    pid: number | undefined,
    source: string,
    nodeDirectory: string,
    kind: ProcessReferenceKind,
  ): Promise<ProcessReferenceInspection> {
    if (pid === undefined) {
      return { state: "absent" };
    }
    if (!(await isLiveProcess(pid))) {
      return { state: "dead" };
    }
    let startTicks: string | undefined;
    try {
      startTicks = await processStartTicks(pid);
      const processDirectory = `/proc/${pid}`;
      if ((await stat(processDirectory)).uid !== process.getuid?.()) {
        throw new CcmProcessCleanupError(
          `CCM process reference ${source} points to foreign live PID ${pid}`,
        );
      }
      const environment = (await readFile(join(processDirectory, "environ")))
        .toString("utf8")
        .split("\0");
      if (!environment.includes(`SCYLLA_CCM_RUN_DIR=${this.runDirectory}`)) {
        throw new CcmProcessCleanupError(
          `CCM process reference ${source} points to unrelated live PID ${pid}`,
        );
      }
      const argumentsList = (await readFile(join(processDirectory, "cmdline")))
        .toString("utf8")
        .split("\0")
        .filter((value) => value !== "");
      if (!(await matchesExpectedProcess(processDirectory, argumentsList, nodeDirectory, kind))) {
        throw new CcmProcessCleanupError(
          `CCM process reference ${source} points to wrong ${kind} process ${pid}`,
        );
      }
      if ((await processStartTicks(pid)) !== startTicks) {
        return { state: "dead" };
      }
      return { state: "owned", identity: { pid, startTicks } };
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") ||
        (startTicks !== undefined && !(await isSameLiveProcess(pid, startTicks)))
      ) {
        return { state: "dead" };
      }
      if (error instanceof CcmProcessCleanupError) {
        throw error;
      }
      throw new CcmProcessCleanupError(
        `Cannot prove ownership of live PID ${pid} referenced by ${source}`,
        { cause: error },
      );
    }
  }

  private async waitForNodesStopped(
    cluster: ProvisionedClusterData,
    nodes: readonly TestClusterNode[],
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const processes = await Promise.all(
        nodes.map((node) => this.prepareNodeProcessReferences(cluster, node.name)),
      );
      if (processes.every((value) => !value.scyllaRunning && !value.ancillaryRunning)) {
        return;
      }
      await delay(50);
    }
    throw new CcmProcessCleanupError(`CCM cluster '${cluster.instanceId}' processes did not stop`);
  }

  private async verifyPreparedProcessesStopped(
    processes: PreparedNodeProcesses,
    description: string,
  ): Promise<void> {
    if (processes.identities.length === 0) {
      return;
    }
    const deadline = Date.now() + PROCESS_TERM_GRACE_MS;
    let survivors = [...processes.identities];
    while (survivors.length !== 0) {
      try {
        const live = await Promise.all(
          survivors.map(async (identity) => ({
            identity,
            live: await isSameLiveProcess(identity.pid, identity.startTicks),
          })),
        );
        survivors = live
          .filter(({ live: remainsLive }) => remainsLive)
          .map(({ identity }) => identity);
      } catch (error) {
        throw new CcmProcessCleanupError(
          `Cannot verify referenced processes after removing ${description}`,
          { cause: error },
        );
      }
      if (survivors.length === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(50, deadline - Date.now()));
    }
    throw new CcmProcessCleanupError(
      `Cannot finish removing ${description}; referenced processes remain alive: ${survivors
        .map(({ pid }) => pid)
        .join(", ")}`,
    );
  }

  private async collectDiagnostics(instanceId: string, ccmDirectory: string): Promise<void> {
    const validatedCcmDirectory = this.validatedCcmDirectory(instanceId, ccmDirectory);
    await validateDirectory(this.clustersDirectory);
    if (!(await pathExists(validatedCcmDirectory))) {
      return;
    }
    await validateDirectory(validatedCcmDirectory);
    const destination = ownedChild(this.diagnosticsDirectory, instanceId);
    try {
      await mkdir(destination, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }
    await validateDirectory(destination);
    await copyDiagnosticTree(validatedCcmDirectory, destination);
  }

  private async removeByName(
    instanceId: string,
    ccmDirectory: string,
    recoverOrphanedNodes = false,
  ): Promise<void> {
    const validatedCcmDirectory = this.validatedCcmDirectory(instanceId, ccmDirectory);
    await validateDirectory(this.clustersDirectory);
    if (!(await pathExists(validatedCcmDirectory))) {
      return;
    }
    await validateDirectory(validatedCcmDirectory);
    const clusterDirectory = join(validatedCcmDirectory, instanceId);
    if (!(await pathExists(join(clusterDirectory, "cluster.conf")))) {
      await rm(validatedCcmDirectory, { recursive: true, force: false });
      return;
    }
    await validateClusterMetadata(clusterDirectory, instanceId);
    const processes = await this.prepareClusterProcessReferences(
      clusterDirectory,
      recoverOrphanedNodes,
    );
    let commandFailure: unknown;
    try {
      await this.runCcm(validatedCcmDirectory, [
        "remove",
        "--config-dir",
        validatedCcmDirectory,
        instanceId,
      ]);
    } catch (error) {
      commandFailure = error;
    }
    if (!(await pathExists(join(clusterDirectory, "cluster.conf")))) {
      await this.verifyPreparedProcessesStopped(processes, `CCM cluster '${instanceId}'`);
      await rm(validatedCcmDirectory, { recursive: true, force: true });
      if (commandFailure instanceof CcmProcessCleanupError) {
        throw commandFailure;
      }
      return;
    }
    if (commandFailure !== undefined) {
      throw asError(commandFailure);
    }
    throw new Error(`CCM reported success but cluster '${instanceId}' still exists`);
  }

  private async removeNodeByName(cluster: ProvisionedClusterData, nodeName: string): Promise<void> {
    const ccmDirectory = this.validatedCcmDirectory(cluster.instanceId, cluster.ccmDirectory);
    const validatedCluster = { ...cluster, ccmDirectory };
    await validateDirectory(this.clustersDirectory);
    const initialState = await this.nodeState(validatedCluster, nodeName);
    if (initialState === "orphaned") {
      throw new CcmProcessCleanupError(
        `CCM node '${nodeName}' is orphaned from cluster '${cluster.instanceId}'`,
      );
    }
    if (initialState === "absent") {
      await this.removeNodeTlsState(ccmDirectory, nodeName);
      return;
    }
    const processes = await this.prepareNodeProcessReferences(validatedCluster, nodeName);
    let commandFailure: unknown;
    try {
      await this.runCcm(ccmDirectory, [
        nodeName,
        "remove",
        "--config-dir",
        ccmDirectory,
      ]);
    } catch (error) {
      commandFailure = error;
    }
    const finalState = await this.nodeState(validatedCluster, nodeName);
    if (finalState === "orphaned") {
      throw new CcmProcessCleanupError(
        `CCM node '${nodeName}' became orphaned from cluster '${cluster.instanceId}' during removal`,
        commandFailure === undefined ? undefined : { cause: commandFailure },
      );
    }
    if (finalState === "absent") {
      await this.verifyPreparedProcessesStopped(processes, `CCM node '${nodeName}'`);
      if (commandFailure instanceof CcmProcessCleanupError) {
        throw commandFailure;
      }
      await this.removeNodeTlsState(ccmDirectory, nodeName);
      return;
    }
    if (commandFailure !== undefined) {
      throw asError(commandFailure);
    }
    throw new Error(`CCM reported success but node '${nodeName}' still exists`);
  }

  private validatedCcmDirectory(instanceId: string, ccmDirectory: string): string {
    if (!INSTANCE_NAME_PATTERN.test(instanceId)) {
      throw new Error(`Unsafe CCM cluster instance name: ${instanceId}`);
    }
    const expected = join(this.clustersDirectory, instanceId);
    if (resolve(ccmDirectory) !== expected) {
      throw new Error(
        `CCM cluster directory does not match provisioner-owned path for '${instanceId}': ${ccmDirectory}`,
      );
    }
    return expected;
  }

  private async removeNodeTlsState(ccmDirectory: string, nodeName: string): Promise<void> {
    if (!/^node[1-9][0-9]*$/u.test(nodeName)) {
      throw new Error(`Unsafe CCM node name: ${nodeName}`);
    }
    await rm(join(ccmDirectory, "tls", nodeName), { recursive: true, force: true });
  }

  private async nodeState(
    cluster: ProvisionedClusterData,
    nodeName: string,
  ): Promise<CcmNodeState> {
    const clusterDirectory = this.clusterDirectory(cluster);
    const nodeDirectory = join(clusterDirectory, nodeName);
    const directoryExists = await pathExists(nodeDirectory);
    const configurationPath = join(clusterDirectory, "cluster.conf");
    if (!(await pathExists(configurationPath))) {
      return directoryExists ? "orphaned" : "absent";
    }
    const configuration = await readYamlMap(configurationPath);
    if (!Array.isArray(configuration.nodes)) {
      throw new CcmProcessCleanupError(`Invalid nodes list in ${configurationPath}`);
    }
    if (configuration.nodes.includes(nodeName)) {
      return "listed";
    }
    return directoryExists ? "orphaned" : "absent";
  }

  private clusterDirectory(cluster: ProvisionedClusterData): string {
    return join(cluster.ccmDirectory, cluster.instanceId);
  }

  private async runCcm(ccmDirectory: string, argumentsList: readonly string[]): Promise<void> {
    if (argumentsList[0] !== "create") {
      const currentCluster = await currentClusterDirectory(ccmDirectory);
      if (currentCluster !== undefined) {
        await validateClusterMetadata(currentCluster, basename(currentCluster));
      }
    }
    await this.runCommand(ccmDirectory, [this.ccmExecutable, ...argumentsList]);
  }

  private async runCommand(ccmDirectory: string, command: readonly string[]): Promise<void> {
    requireLinux();
    await validateDirectory(ccmDirectory);
    const outputPath = join(
      ccmDirectory,
      `ccm-command-${Date.now()}-${randomBytes(6).toString("hex")}.log`,
    );
    const output = await open(outputPath, "wx", 0o600);
    await output.writeFile(`> ${command.map(shellQuoteForLog).join(" ")}\n`, "utf8");
    await output.sync();
    const environment: NodeJS.ProcessEnv = {
      ...this.environment,
      SCYLLA_CCM_RUN_DIR: this.runDirectory,
    };
    if (environment.SCYLLA_ARCH === undefined) {
      const architecture = defaultScyllaArchitecture(process.arch);
      if (architecture !== undefined) {
        environment.SCYLLA_ARCH = architecture;
      }
    }
    for (const variable of UNSUPPORTED_CCM_ENVIRONMENT) {
      delete environment[variable];
    }

    let child: ReturnType<typeof spawn>;
    let outcomePromise: Promise<ChildOutcome>;
    try {
      child = spawn(command[0]!, command.slice(1), {
        detached: true,
        env: environment,
        shell: false,
        stdio: ["ignore", output.fd, output.fd],
      });
      outcomePromise = waitForChild(child, this.commandTimeoutMs);
    } catch (error) {
      await output.writeFile("[exit start-failed]\n", "utf8");
      await output.close();
      throw error;
    }
    let closeFailure: unknown;
    try {
      await output.close();
    } catch (error) {
      closeFailure = error;
    }

    const outcome = await outcomePromise;
    let terminationFailure: unknown;
    if (outcome.timedOut || outcome.error !== undefined || outcome.exitCode !== 0) {
      try {
        await terminateProcessGroup(child.pid);
      } catch (error) {
        terminationFailure = error;
      }
    }
    const outcomeText = outcome.timedOut
      ? "timeout"
      : outcome.error !== undefined
        ? "start-failed"
        : String(outcome.exitCode);
    let contents = "";
    let logFinalizationFailure = closeFailure === undefined ? undefined : asError(closeFailure);
    try {
      await appendFile(outputPath, `[exit ${outcomeText}]\n`, "utf8");
      contents = await readFile(outputPath, "utf8");
      await appendFile(join(ccmDirectory, "ccm-commands.log"), contents, "utf8");
      process.stdout.write(contents);
    } catch (error) {
      logFinalizationFailure = combineFailures(
        logFinalizationFailure,
        error,
        "Closing and finalizing the CCM command log both failed",
      );
    }

    if (terminationFailure !== undefined) {
      throw new CcmProcessCleanupError(
        `Unable to prove cleanup of CCM command process group ${child.pid}`,
        {
          cause: logFinalizationFailure === undefined
            ? terminationFailure
            : new AggregateError(
                [terminationFailure, logFinalizationFailure],
                "CCM process-group cleanup and command-log finalization both failed",
              ),
        },
      );
    }
    if (logFinalizationFailure !== undefined) {
      throw asError(logFinalizationFailure);
    }
    if (outcome.error !== undefined) {
      throw outcome.error;
    }
    if (outcome.timedOut || outcome.exitCode !== 0) {
      throw new CcmCommandError(command, outcome.timedOut ? -1 : outcome.exitCode, contents);
    }
  }
}

interface ChildOutcome {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly error?: Error;
}

function waitForChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolveOutcome) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolveOutcome({ exitCode: -1, timedOut: true });
      }
    }, timeoutMs);
    child.once("error", (error) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolveOutcome({ exitCode: -1, timedOut: false, error });
      }
    });
    child.once("exit", (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolveOutcome({ exitCode: code ?? -1, timedOut: false });
      }
    });
  });
}

async function terminateProcessGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) {
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
  await waitForProcessGroup(pid, PROCESS_TERM_GRACE_MS);
  if ((await processGroupMembers(pid)).length !== 0) {
    signalProcessGroup(pid, "SIGKILL");
    await waitForProcessGroup(pid, PROCESS_KILL_GRACE_MS);
  }
  if ((await processGroupMembers(pid)).length !== 0) {
    throw new Error(`CCM command process group ${pid} survived termination`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) {
      throw error;
    }
  }
}

async function waitForProcessGroup(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await processGroupMembers(pid)).length !== 0 && Date.now() < deadline) {
    await delay(20);
  }
}

async function processGroupMembers(processGroup: number): Promise<number[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const result: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) {
      continue;
    }
    try {
      const contents = await readFile(`/proc/${entry.name}/stat`, "utf8");
      const closing = contents.lastIndexOf(")");
      const fields = contents.slice(closing + 2).trim().split(/\s+/u);
      if (fields[0] !== "Z" && Number(fields[2]) === processGroup) {
        result.push(Number(entry.name));
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return result;
}

function buildNodes(topology: ClusterTopology, ccmId: number): TestClusterNode[] {
  const nodes: TestClusterNode[] = [];
  let index = 0;
  for (let dcIndex = 0; dcIndex < topology.datacenters.length; dcIndex++) {
    const datacenter = topology.datacenters[dcIndex]!;
    for (let nodeIndex = 0; nodeIndex < datacenter.racks[0]!.nodeCount; nodeIndex++) {
      nodes.push(createNode(++index, ccmId, dcIndex, 0));
    }
  }
  for (let dcIndex = 0; dcIndex < topology.datacenters.length; dcIndex++) {
    const datacenter = topology.datacenters[dcIndex]!;
    for (let rackIndex = 1; rackIndex < datacenter.racks.length; rackIndex++) {
      for (let nodeIndex = 0; nodeIndex < datacenter.racks[rackIndex]!.nodeCount; nodeIndex++) {
        nodes.push(createNode(++index, ccmId, dcIndex, rackIndex));
      }
    }
  }
  return nodes;
}

function createNode(
  index: number,
  ccmId: number,
  datacenterIndex: number,
  rackIndex: number,
): TestClusterNode {
  return new TestClusterNode({
    name: `node${index}`,
    address: `127.0.${ccmId}.${index}`,
    datacenter: `dc${datacenterIndex + 1}`,
    rack: `RAC${rackIndex + 1}`,
  });
}

function firstRackCounts(topology: ClusterTopology): string {
  return topology.datacenters.map((datacenter) => datacenter.racks[0]!.nodeCount).join(":");
}

function startArguments(cluster: ProvisionedClusterData, nodeName: string): string[] {
  return [
    nodeName,
    "start",
    "--config-dir",
    cluster.ccmDirectory,
    "--wait-for-binary-proto",
    "--wait-other-notice",
    "--jvm_arg=--smp",
    `--jvm_arg=${cluster.spec.resources.smp}`,
    "--jvm_arg=--memory",
    `--jvm_arg=${cluster.spec.resources.memoryMiB}M`,
  ];
}

function lowestFreeNodeIndex(nodes: readonly TestClusterNode[]): number {
  const names = new Set(nodes.map((node) => node.name));
  let index = 1;
  while (names.has(`node${index}`)) {
    index++;
  }
  return index;
}

function authenticator(mode: AuthenticationMode): string {
  if (mode === AuthenticationMode.PASSWORD) {
    return "org.apache.cassandra.auth.PasswordAuthenticator";
  }
  if (mode === AuthenticationMode.TRANSITIONAL) {
    return "com.scylladb.auth.TransitionalAuthenticator";
  }
  throw new Error(`No authenticator for ${mode}`);
}

function authorizer(mode: AuthorizationMode): string {
  if (mode === AuthorizationMode.CASSANDRA) {
    return "org.apache.cassandra.auth.CassandraAuthorizer";
  }
  if (mode === AuthorizationMode.TRANSITIONAL) {
    return "com.scylladb.auth.TransitionalAuthorizer";
  }
  throw new Error(`No authorizer for ${mode}`);
}

function parseOverrides(overrides: ReadonlyMap<string, string>): Map<string, unknown> {
  const parsed = new Map(
    [...overrides].map(([key, value]) => [
      key,
      parse(value, { intAsBigInt: true, schema: "core", uniqueKeys: true }) as unknown,
    ]),
  );
  for (const [key, value] of parsed) {
    const path = key.split(".");
    if (path.length === 1 || !parsed.has(path[0]!)) {
      continue;
    }
    const root = parsed.get(path[0]!);
    if (!isRecord(root)) {
      throw new Error(`Scylla YAML key '${path[0]}' is not a mapping`);
    }
    setOwnProperty(root, path[1]!, value);
  }
  return parsed;
}

function applyDottedValues(
  destination: Record<string, unknown>,
  values: ReadonlyMap<string, unknown>,
): void {
  for (const [key, value] of values) {
    const path = key.split(".");
    if (path.length === 1) {
      setOwnProperty(destination, path[0]!, value);
    } else {
      setOwnProperty(childMap(destination, path[0]!, true), path[1]!, value);
    }
  }
}

function verifyDottedValues(
  actual: Record<string, unknown> | undefined,
  expected: ReadonlyMap<string, unknown>,
  description: string,
): void {
  if (actual === undefined) {
    throw new Error(`${description} has no configuration options`);
  }
  for (const [key, value] of expected) {
    const path = key.split(".");
    const parent = path.length === 1 ? actual : childMap(actual, path[0]!, false);
    const leaf = path.at(-1)!;
    if (
      parent === undefined ||
      !Object.hasOwn(parent, leaf) ||
      !isDeepStrictEqual(parent[leaf], value)
    ) {
      throw new Error(`${description} does not preserve override '${key}'`);
    }
  }
}

function childMap(
  parent: Record<string, unknown>,
  key: string,
  create: boolean,
): Record<string, unknown> | undefined;
function childMap(
  parent: Record<string, unknown>,
  key: string,
  create: true,
): Record<string, unknown>;
function childMap(
  parent: Record<string, unknown>,
  key: string,
  create: boolean,
): Record<string, unknown> | undefined {
  const existing = Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (existing === undefined || existing === null) {
    if (!create) {
      return undefined;
    }
    const child: Record<string, unknown> = {};
    setOwnProperty(parent, key, child);
    return child;
  }
  if (!isRecord(existing)) {
    if (!create) {
      return undefined;
    }
    throw new Error(`Scylla YAML key '${key}' is not a mapping`);
  }
  return existing;
}

function setOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

async function readYamlMap(path: string): Promise<Record<string, unknown>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe YAML path: ${path}`);
  }
  const parsed = parse(await readFile(path, "utf8"), {
    intAsBigInt: true,
    schema: "core",
    uniqueKeys: true,
  }) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected a YAML mapping in ${path}`);
  }
  return parsed;
}

async function writeYamlMap(path: string, value: Record<string, unknown>): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe YAML path: ${path}`);
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, stringify(value, { lineWidth: 0 }), { mode: metadata.mode & 0o777 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function validateClusterMetadata(clusterDirectory: string, expectedName: string): Promise<void> {
  await validateDirectory(clusterDirectory);
  const configuration = await readYamlMap(join(clusterDirectory, "cluster.conf"));
  if (configuration.name !== expectedName || !Array.isArray(configuration.nodes)) {
    throw new Error(`Unsafe CCM cluster configuration: ${clusterDirectory}`);
  }
  const nodeNames = new Set<string>();
  for (const nodeName of configuration.nodes) {
    if (typeof nodeName !== "string" || !/^node[1-9][0-9]*$/u.test(nodeName)) {
      throw new Error(`Unsafe CCM node name in ${clusterDirectory}: ${String(nodeName)}`);
    }
    if (nodeNames.has(nodeName)) {
      throw new Error(`Duplicate CCM node name in ${clusterDirectory}: ${nodeName}`);
    }
    nodeNames.add(nodeName);
    const nodeDirectory = join(clusterDirectory, nodeName);
    if (await pathExists(nodeDirectory)) {
      await validateDirectory(nodeDirectory);
      const nodeConfigPath = join(nodeDirectory, "node.conf");
      if (await pathExists(nodeConfigPath)) {
        const nodeConfig = await readYamlMap(nodeConfigPath);
        if (nodeConfig.name !== nodeName || "docker_id" in nodeConfig) {
          throw new Error(`Unsafe CCM node configuration: ${nodeConfigPath}`);
        }
      }
    }
  }
  if (configuration.seeds !== undefined) {
    if (!Array.isArray(configuration.seeds)) {
      throw new Error(`Unsafe CCM seeds in ${clusterDirectory}`);
    }
    for (const seed of configuration.seeds) {
      if (typeof seed !== "string" || !nodeNames.has(seed)) {
        throw new Error(`Unsafe CCM seed in ${clusterDirectory}: ${String(seed)}`);
      }
    }
  }
}

async function currentClusterDirectory(ccmDirectory: string): Promise<string | undefined> {
  const currentPath = join(ccmDirectory, "CURRENT");
  if (!(await pathExists(currentPath))) {
    return undefined;
  }
  const metadata = await lstat(currentPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512) {
    throw new Error(`Unsafe CCM current-cluster metadata: ${currentPath}`);
  }
  const contents = await readFile(currentPath, "utf8");
  if (!contents.endsWith("\n") || contents.slice(0, -1).includes("\n")) {
    throw new Error(`Malformed CCM current-cluster metadata: ${currentPath}`);
  }
  const instanceId = contents.trim();
  if (!/^alternator-js-[a-zA-Z0-9_-]+$/u.test(instanceId)) {
    throw new Error(`Unsafe CCM current cluster name: ${instanceId}`);
  }
  const clusterDirectory = ownedChild(ccmDirectory, instanceId);
  if (!(await pathExists(clusterDirectory))) {
    return undefined;
  }
  await validateDirectory(clusterDirectory);
  return clusterDirectory;
}

type ProcessReferenceState = "absent" | "dead" | "owned";
type ProcessReferenceKind = "scylla" | "jmx" | "agent";
type CcmNodeState = "listed" | "absent" | "orphaned";

interface ProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
}

interface ProcessReferenceInspection {
  readonly state: ProcessReferenceState;
  readonly identity?: ProcessIdentity;
}

interface PreparedNodeProcesses {
  readonly scyllaRunning: boolean;
  readonly ancillaryRunning: boolean;
  readonly identities: readonly ProcessIdentity[];
}

function mergePreparedProcesses(processes: readonly PreparedNodeProcesses[]): PreparedNodeProcesses {
  return {
    scyllaRunning: processes.some(({ scyllaRunning }) => scyllaRunning),
    ancillaryRunning: processes.some(({ ancillaryRunning }) => ancillaryRunning),
    identities: uniqueProcessIdentities(processes.flatMap(({ identities }) => identities)),
  };
}

function uniqueProcessIdentities(
  values: readonly (ProcessReferenceInspection | ProcessIdentity)[],
): ProcessIdentity[] {
  const result = new Map<string, ProcessIdentity>();
  for (const value of values) {
    const identity = "state" in value ? value.identity : value;
    if (identity !== undefined) {
      result.set(`${identity.pid}:${identity.startTicks}`, identity);
    }
  }
  return [...result.values()];
}

async function readOptionalPid(path: string): Promise<number | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CcmProcessCleanupError(`Refusing unsafe CCM process reference: ${path}`);
  }
  return parsePidValue((await readFile(path, "utf8")).trim(), path);
}

function parsePidValue(value: unknown, source: string): number {
  if (typeof value === "bigint") {
    if (value < 2n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CcmProcessCleanupError(`Invalid process ID in ${source}`);
    }
    return Number(value);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new CcmProcessCleanupError(`Invalid process ID in ${source}`);
  }
  const text = String(value);
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid < 2 || !/^[0-9]+$/u.test(text)) {
    throw new CcmProcessCleanupError(`Invalid process ID in ${source}`);
  }
  return pid;
}

async function deleteDeadPidFile(
  path: string,
  state: ProcessReferenceState,
): Promise<void> {
  if (state !== "dead") {
    return;
  }
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (metadata === undefined) {
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CcmProcessCleanupError(`Refusing unsafe CCM process reference: ${path}`);
  }
  await rm(path);
}

async function matchesExpectedProcess(
  processDirectory: string,
  argumentsList: readonly string[],
  nodeDirectory: string,
  kind: ProcessReferenceKind,
): Promise<boolean> {
  const executable = argumentsList[0];
  if (executable === undefined) {
    return false;
  }
  if (kind === "scylla") {
    return executable === join(nodeDirectory, "bin", "scylla");
  }
  if (kind === "agent") {
    return (
      isAbsolute(executable) &&
      executable.split("/").at(-1) === "scylla-manager-agent" &&
      containsArgumentPair(
        argumentsList,
        "--config-file",
        join(nodeDirectory, "conf", "scylla-manager-agent.yaml"),
      )
    );
  }
  const expectedLauncher = executable === join(nodeDirectory, "bin", "symlinks", "scylla-jmx");
  const expectedJava = executable.split("/").at(-1) === "java";
  if (
    !(expectedLauncher || expectedJava) ||
    !containsArgumentPair(
      argumentsList,
      "-jar",
      join(nodeDirectory, "bin", "scylla-jmx-1.0.jar"),
    )
  ) {
    return false;
  }
  if (!expectedJava) {
    return true;
  }
  const actualExecutable = (await readlink(join(processDirectory, "exe"))).split("/").at(-1);
  return actualExecutable === "java" || actualExecutable === "java (deleted)";
}

function containsArgumentPair(
  argumentsList: readonly string[],
  option: string,
  expectedValue: string,
): boolean {
  return argumentsList.some(
    (value, index) => value === option && argumentsList[index + 1] === expectedValue,
  );
}

async function processStartTicks(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = contents.lastIndexOf(")");
  const value = contents.slice(closing + 2).trim().split(/\s+/u)[19];
  if (closing < 0 || value === undefined || !/^[0-9]+$/u.test(value)) {
    throw new Error(`Malformed process stat for PID ${pid}`);
  }
  return value;
}

async function isSameLiveProcess(pid: number, startTicks: string): Promise<boolean> {
  try {
    return (await isLiveProcess(pid)) && (await processStartTicks(pid)) === startTicks;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
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

function requestStatus(url: URL, timeoutMs: number): Promise<number> {
  return new Promise((resolveStatus, rejectStatus) => {
    const request =
      url.protocol === "https:"
        ? httpsGet(url, { rejectUnauthorized: false }, handleResponse)
        : httpGet(url, handleResponse);
    request.setTimeout(Math.max(1, timeoutMs), () => {
      request.destroy(new Error(`Timed out contacting ${url.toString()}`));
    });
    request.once("error", rejectStatus);

    function handleResponse(response: IncomingMessage): void {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
      response.once("error", rejectStatus);
    }
  });
}

async function copyDiagnosticTree(source: string, destination: string): Promise<void> {
  await validateDirectory(source);
  await validateDirectory(destination);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (isPrivateKey(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link while collecting CCM diagnostics: ${join(source, entry.name)}`);
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIAGNOSTIC_DIRECTORIES.has(entry.name)) {
        continue;
      }
      try {
        await mkdir(destinationPath, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
      }
      await validateDirectory(destinationPath);
      await copyDiagnosticTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      const sourceMetadata = await lstat(sourcePath);
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
        throw new Error(`Refusing unsafe CCM diagnostic source: ${sourcePath}`);
      }
      if (await pathExists(destinationPath)) {
        const destinationMetadata = await lstat(destinationPath);
        if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
          throw new Error(`Refusing unsafe CCM diagnostic destination: ${destinationPath}`);
        }
      }
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
    } else {
      throw new Error(`Refusing special file while collecting CCM diagnostics: ${sourcePath}`);
    }
  }
}

function isPrivateKey(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.endsWith(".key") || normalized.endsWith(".pem");
}

async function validateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe CCM directory: ${path}`);
  }
}

function ownedChild(parent: string, child: string): string {
  const path = resolve(parent, child);
  if (!containsPath(resolve(parent), path) || path === resolve(parent)) {
    throw new Error(`Refusing path outside CCM-owned directory: ${path}`);
  }
  return path;
}

function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function defaultScyllaArchitecture(architecture: string): string | undefined {
  if (architecture === "arm64") {
    return "aarch64";
  }
  if (architecture === "x64") {
    return "x86_64";
  }
  return undefined;
}

function requireLinux(): void {
  if (process.platform !== "linux") {
    throw new Error("The native scylla-ccm harness currently supports Linux only");
  }
}

function shellQuoteForLog(value: string): string {
  return /^[A-Za-z0-9_./:=+@%-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function containsProcessCleanupError(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof CcmProcessCleanupError) {
    return true;
  }
  return error instanceof Error && containsProcessCleanupError(error.cause, seen);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function combineFailures(
  first: Error | undefined,
  second: unknown,
  message: string,
): Error {
  return first === undefined
    ? asError(second)
    : new AggregateError([first, asError(second)], message);
}

function withOptionalFields(
  base: Omit<ProvisionedClusterData, "caCertificatePath" | "credentials">,
  caCertificatePath: string | undefined,
  credentials: ProvisionedClusterData["credentials"],
): ProvisionedClusterData {
  return {
    ...base,
    ...(caCertificatePath === undefined ? {} : { caCertificatePath }),
    ...(credentials === undefined ? {} : { credentials }),
  };
}
