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
import { AlternatorDynamoDBClient } from "../../../src/client.js";
import type { AlternatorNodeDynamoDBClientConfig } from "../../../src/types.js";
import {
  type AlternatorConnection,
  type ClientConfigOverrides,
  type PrivateClusterControl,
  type TestClusterNode,
  type TestClusterInfo,
  TestResourceScope,
} from "./model.js";
import {
  CcmClusterProvisioningError,
  CcmNodeProvisioningError,
  CcmProcessCleanupError,
  CcmProvisioner,
  HTTP_PORT,
  HTTPS_PORT,
  type ClusterProvisioner,
  type CcmProvisionerOptions,
  type ProvisionedClusterData,
} from "./provisioner.js";
import { CcmRunState, type ClusterOwnership } from "./run-state.js";
import {
  AlternatorTransport,
  type ClusterSpec,
  MAXIMUM_NODE_COUNT,
} from "./spec.js";

type NodeState = "running" | "stopped" | "decommissioned";
type ClusterState = "open" | "removing" | "removal-failed" | "closed";

const PROCESS_INSTANCE_TOKEN = randomBytes(8).toString("hex");
let instanceCounter = 0;

class PhysicalTestCluster implements TestClusterInfo {
  readonly instanceId: string;
  readonly spec: ClusterSpec;

  private readonly provisioner: ClusterProvisioner;
  private readonly ccmId: number;
  private readonly ccmDirectory: string;
  private readonly caCertificatePath: string | undefined;
  private readonly credentials:
    | Readonly<{ accessKeyId: string; secretAccessKey: string }>
    | undefined;
  private readonly mutableNodes: TestClusterNode[];
  private readonly nodeStates = new Map<TestClusterNode, NodeState>();
  private readonly mutation = new AsyncMutex();
  private state: ClusterState = "open";
  private dirty = false;
  private recoveryRequired = false;

  constructor(provisioner: ClusterProvisioner, data: ProvisionedClusterData) {
    this.provisioner = provisioner;
    this.instanceId = data.instanceId;
    this.ccmId = data.ccmId;
    this.ccmDirectory = data.ccmDirectory;
    this.spec = data.spec;
    this.caCertificatePath = data.caCertificatePath;
    this.credentials = data.credentials;
    this.mutableNodes = [...data.nodes];
    for (const node of this.mutableNodes) {
      this.nodeStates.set(node, "running");
    }
  }

  get nodes(): readonly TestClusterNode[] {
    return Object.freeze([...this.mutableNodes]);
  }

  connection(transport: AlternatorTransport): AlternatorConnection {
    if (!this.spec.hasTransport(transport)) {
      throw new Error(`Cluster '${this.instanceId}' does not provide ${transport}`);
    }
    const port = transport === AlternatorTransport.HTTP ? HTTP_PORT : HTTPS_PORT;
    const endpoints = Object.freeze(
      this.mutableNodes.map((node) => new URL(`${transport}://${node.address}:${port}`)),
    );
    if (endpoints.length === 0) {
      throw new Error(`Cluster '${this.instanceId}' has no nodes`);
    }
    return Object.freeze({
      seedEndpoint: endpoints[0]!,
      nodeEndpoints: endpoints,
      ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
      ...(transport === AlternatorTransport.HTTPS && this.caCertificatePath !== undefined
        ? { caCertificatePath: this.caCertificatePath }
        : {}),
    });
  }

  clientConfig(
    transport: AlternatorTransport,
    overrides: ClientConfigOverrides = {},
  ): AlternatorNodeDynamoDBClientConfig {
    validateClientConfigOverrides(overrides);
    const connection = this.connection(transport);
    const base: AlternatorNodeDynamoDBClientConfig = {
      runtime: "node",
      seeds: [connection.seedEndpoint.hostname],
      scheme: transport,
      port: Number(connection.seedEndpoint.port),
      region: "us-east-1",
      credentials: connection.credentials ?? {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
      ...(transport === AlternatorTransport.HTTPS && connection.caCertificatePath !== undefined
        ? {
            tls: {
              ca: { file: connection.caCertificatePath },
              rejectUnauthorized: true,
            },
          }
        : {}),
    };
    return { ...base, ...overrides };
  }

  createClient(
    transport: AlternatorTransport,
    overrides: ClientConfigOverrides = {},
  ): AlternatorDynamoDBClient {
    return new AlternatorDynamoDBClient(this.clientConfig(transport, overrides));
  }

  async start(): Promise<void> {
    await this.mutation.run(async () => {
      this.ensureMutable();
      const stopped: TestClusterNode[] = [];
      for (const node of this.mutableNodes) {
        if (this.nodeStates.get(node) === "decommissioned") {
          continue;
        }
        if (await this.probeNodeRunning(node)) {
          await this.provisioner.waitForNodeReady(this.data(), node);
          this.nodeStates.set(node, "running");
        } else {
          this.nodeStates.set(node, "stopped");
          stopped.push(node);
        }
      }
      if (stopped.length === 0) {
        return;
      }
      try {
        await this.provisioner.start(this.data(), stopped);
        for (const node of stopped) {
          this.nodeStates.set(node, "running");
        }
      } catch (error) {
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  async stop(): Promise<void> {
    await this.mutation.run(async () => {
      this.ensureMutable();
      let hasRunningNode = false;
      for (const node of this.mutableNodes) {
        const cached = this.nodeStates.get(node);
        if (cached === "decommissioned") {
          continue;
        }
        if (await this.probeNodeRunning(node)) {
          this.nodeStates.set(node, "running");
          hasRunningNode = true;
        } else {
          this.nodeStates.set(node, "stopped");
          hasRunningNode ||= cached === "running";
        }
      }
      if (!hasRunningNode) {
        return;
      }
      try {
        await this.provisioner.stop(this.data());
        for (const node of this.mutableNodes) {
          if (this.nodeStates.get(node) !== "decommissioned") {
            this.nodeStates.set(node, "stopped");
          }
        }
      } catch (error) {
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  async startNode(requested: TestClusterNode): Promise<void> {
    await this.mutation.run(async () => {
      this.ensureMutable();
      const node = this.getNode(requested);
      if (this.nodeStates.get(node) === "decommissioned") {
        throw new Error(`Cannot start decommissioned node ${node.name}`);
      }
      if (await this.probeNodeRunning(node)) {
        await this.provisioner.waitForNodeReady(this.data(), node);
        this.nodeStates.set(node, "running");
        return;
      }
      this.nodeStates.set(node, "stopped");
      try {
        await this.provisioner.startNode(this.data(), node);
        this.nodeStates.set(node, "running");
      } catch (error) {
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  async stopNode(requested: TestClusterNode): Promise<void> {
    await this.mutation.run(async () => {
      this.ensureMutable();
      const node = this.getNode(requested);
      const cached = this.nodeStates.get(node);
      if (cached === "decommissioned") {
        throw new Error(`Cannot stop decommissioned node ${node.name}`);
      }
      if (!(await this.probeNodeRunning(node)) && cached === "stopped") {
        return;
      }
      this.nodeStates.set(node, "running");
      try {
        await this.provisioner.stopNode(this.data(), node);
        this.nodeStates.set(node, "stopped");
      } catch (error) {
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  async addNode(
    pool: TestClusterPool,
    datacenter: string,
    rack: string,
  ): Promise<TestClusterNode> {
    return this.mutation.run(async () => {
      this.ensureMutable();
      if (datacenter.trim() === "" || rack.trim() === "") {
        throw new Error("A datacenter and rack are required when adding a CCM node");
      }
      pool.reserveAdditionalPrivateNode(this);
      try {
        const node = await this.provisioner.addNode(this.data(), datacenter, rack);
        this.mutableNodes.push(node);
        this.nodeStates.set(node, "running");
        return node;
      } catch (error) {
        if (error instanceof CcmNodeProvisioningError) {
          this.recoveryRequired ||= error.recoveryRequired;
          this.dirty ||= error.clusterStateAmbiguous || error.recoveryRequired;
          if (error.nodeRemainsProvisioned) {
            this.mutableNodes.push(error.node);
            this.nodeStates.set(error.node, "stopped");
            this.dirty = true;
          }
        } else {
          this.recordAmbiguousFailure(error);
        }
        throw asError(error);
      }
    });
  }

  async removeNode(pool: TestClusterPool, requested: TestClusterNode): Promise<void> {
    await this.mutation.run(async () => {
      this.ensureMutable();
      const node = this.getNode(requested);
      if (this.nodeStates.get(node) !== "decommissioned" && this.activeNodeCount() === 1) {
        throw new Error("Cannot remove the final node from a cluster");
      }
      try {
        if (this.nodeStates.get(node) === "stopped") {
          await this.provisioner.startNode(this.data(), node);
          this.nodeStates.set(node, "running");
        }
        if (this.nodeStates.get(node) !== "decommissioned") {
          await this.provisioner.decommissionNode(this.data(), node);
          this.nodeStates.set(node, "decommissioned");
        }
        await this.provisioner.deleteNodeState(this.data(), node);
        this.mutableNodes.splice(this.mutableNodes.indexOf(node), 1);
        this.nodeStates.delete(node);
        pool.releaseAdditionalPrivateNode(this);
      } catch (error) {
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  markDirty(recoveryRequired = false): void {
    this.dirty = true;
    this.recoveryRequired ||= recoveryRequired;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  clusterDataForPool(): ProvisionedClusterData {
    return this.data();
  }

  async removePhysical(): Promise<void> {
    await this.mutation.run(async () => {
      if (this.state === "closed") {
        return;
      }
      if (this.recoveryRequired) {
        throw new Error(`Cluster '${this.instanceId}' must be recovered by next test process`);
      }
      if (this.state === "removing") {
        throw new Error("Cluster removal is already in progress");
      }
      this.state = "removing";
      try {
        await this.provisioner.remove(this.data());
        this.state = "closed";
      } catch (error) {
        this.state = "removal-failed";
        this.recordAmbiguousFailure(error);
        throw asError(error);
      }
    });
  }

  private data(): ProvisionedClusterData {
    return {
      instanceId: this.instanceId,
      ccmId: this.ccmId,
      ccmDirectory: this.ccmDirectory,
      spec: this.spec,
      nodes: this.nodes,
      ...(this.caCertificatePath === undefined
        ? {}
        : { caCertificatePath: this.caCertificatePath }),
      ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
    };
  }

  private getNode(requested: TestClusterNode): TestClusterNode {
    const node = this.mutableNodes.find((candidate) => candidate === requested);
    if (node === undefined) {
      throw new Error(`Node is not part of cluster: ${requested.name}`);
    }
    return node;
  }

  private activeNodeCount(): number {
    return [...this.nodeStates.values()].filter((state) => state !== "decommissioned").length;
  }

  private async probeNodeRunning(node: TestClusterNode): Promise<boolean> {
    try {
      return await this.provisioner.isNodeRunning(this.data(), node);
    } catch (error) {
      this.recordAmbiguousFailure(error);
      throw asError(error);
    }
  }

  private recordAmbiguousFailure(error: unknown): void {
    this.dirty = true;
    this.recoveryRequired ||= containsProcessCleanupError(error);
  }

  private ensureMutable(): void {
    if (this.state !== "open") {
      throw new Error(`Cluster '${this.instanceId}' is closing or has already been removed`);
    }
    if (this.dirty) {
      throw new Error(`Cluster '${this.instanceId}' has ambiguous state and must be removed`);
    }
  }
}

class ReadOnlyTestCluster implements TestClusterInfo {
  readonly instanceId: string;
  readonly spec: ClusterSpec;
  readonly nodes: readonly TestClusterNode[];

  constructor(private readonly cluster: PhysicalTestCluster) {
    this.instanceId = cluster.instanceId;
    this.spec = cluster.spec;
    this.nodes = cluster.nodes;
  }

  connection(transport: AlternatorTransport): AlternatorConnection {
    return this.cluster.connection(transport);
  }

  clientConfig(
    transport: AlternatorTransport,
    overrides?: ClientConfigOverrides,
  ): AlternatorNodeDynamoDBClientConfig {
    return this.cluster.clientConfig(transport, overrides);
  }

  createClient(
    transport: AlternatorTransport,
    overrides?: ClientConfigOverrides,
  ): AlternatorDynamoDBClient {
    return this.cluster.createClient(transport, overrides);
  }
}

interface Slot {
  readonly generation: number;
  readonly reuseKey: string | undefined;
  readonly privateCluster: boolean;
  readonly cluster: PhysicalTestCluster;
  readonly ownership: ClusterOwnership;
  references: number;
  poisoned: boolean;
}

export type ResourceCleanup = (resources: TestResourceScope) => Promise<void>;

export class TestClusterPool {
  private readonly mutex = new AsyncMutex();
  private readonly provisioner: ClusterProvisioner;
  private readonly maximumNodes: number;
  private readonly cleanupResources: ResourceCleanup;
  private readonly runState: CcmRunState | undefined;
  private current: Slot | undefined;
  private terminalFailure: Error | undefined;
  private generation = 0;
  private leaseCounter = 0;
  private closed = false;

  constructor(values: {
    readonly provisioner: ClusterProvisioner;
    readonly maximumNodes?: number;
    readonly cleanupResources?: ResourceCleanup;
    readonly runState?: CcmRunState;
  }) {
    const maximumNodes = values.maximumNodes ?? MAXIMUM_NODE_COUNT;
    if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > MAXIMUM_NODE_COUNT) {
      throw new Error(`maximumNodes must be between 1 and ${MAXIMUM_NODE_COUNT}`);
    }
    this.provisioner = values.provisioner;
    this.maximumNodes = maximumNodes;
    this.cleanupResources = values.cleanupResources ?? ((resources) => resources.cleanup());
    this.runState = values.runState;
  }

  static async createDefault(
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<TestClusterPool> {
    const provisionerOptions: CcmProvisionerOptions = { environment };
    const runState = await CcmRunState.openDefault(
      async (runDirectory, manifest) => {
        const staleProvisioner = await CcmProvisioner.create(runDirectory, provisionerOptions);
        await staleProvisioner.cleanupStaleCluster(runDirectory, manifest);
      },
      { environment },
    );
    try {
      const provisioner = await CcmProvisioner.create(runState.runDirectory, provisionerOptions);
      const configuredMaximum = parsePositiveInteger(
        "SCYLLA_CCM_MAX_NODES",
        MAXIMUM_NODE_COUNT,
        environment,
      );
      return new TestClusterPool({
        provisioner,
        maximumNodes: Math.min(configuredMaximum, MAXIMUM_NODE_COUNT),
        runState,
      });
    } catch (error) {
      await runState.close().catch(() => undefined);
      throw asError(error);
    }
  }

  async acquireReusable(spec: ClusterSpec): Promise<ReusableClusterLease> {
    this.validateDemand(spec);
    this.throwIfUnavailable();
    this.throwIfActiveReusableConflict(spec);
    return this.mutex.run(async () => {
      this.throwIfUnavailable();
      const current = this.current;
      if (current !== undefined) {
        if (current.privateCluster) {
          throw new Error("A private CCM cluster is already active in this process");
        }
        if (current.references > 0) {
          if (current.reuseKey !== spec.reuseKey() || current.poisoned) {
            throw new Error(
              "The active reusable CCM cluster is incompatible with requested specification",
            );
          }
          current.references++;
          return this.reusableLease(current);
        }
        if (
          current.reuseKey === spec.reuseKey() &&
          !current.poisoned &&
          (await this.provisioner.isHealthy(current.cluster.clusterDataForPool()))
        ) {
          current.references = 1;
          return this.reusableLease(current);
        }
        await this.retireCurrent();
      }
      const created = await this.provision(spec, false);
      created.references = 1;
      this.current = created;
      return this.reusableLease(created);
    });
  }

  async provisionPrivate(spec: ClusterSpec): Promise<PrivateClusterLease> {
    this.validateDemand(spec);
    this.throwIfUnavailable();
    this.throwIfActivePrivateConflict();
    return this.mutex.run(async () => {
      this.throwIfUnavailable();
      if (this.current !== undefined) {
        if (this.current.privateCluster || this.current.references > 0) {
          throw new Error("A CCM cluster lease is already active in this process");
        }
        await this.retireCurrent();
      }
      const created = await this.provision(spec, true);
      this.current = created;
      return new PrivateClusterLease(this, created.cluster, this.createResourceScope(created.cluster));
    });
  }

  async releaseReusable(
    generation: number,
    resources: TestResourceScope,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const current = this.current;
      if (current === undefined || current.generation !== generation) {
        return;
      }
      if (current.references <= 0) {
        throw new Error("A reusable CCM cluster lease was released more than once");
      }
      let failure: Error | undefined;
      if (!this.closed) {
        try {
          await this.cleanupResources(resources);
        } catch (error) {
          failure = asError(error);
          current.poisoned = true;
          this.terminalFailure = failure;
        }
      }
      current.references--;
      if (current.references === 0 && (current.poisoned || this.closed)) {
        try {
          await this.retireCurrent();
          this.terminalFailure = undefined;
        } catch (error) {
          failure ??= asError(error);
        }
      }
      if (failure !== undefined) {
        throw failure;
      }
    });
  }

  async releasePrivate(cluster: PhysicalTestCluster): Promise<void> {
    await this.mutex.run(async () => {
      if (this.current === undefined || this.current.cluster !== cluster) {
        return;
      }
      if (!this.current.privateCluster) {
        throw new Error("The cluster is not privately owned by this pool");
      }
      await this.retireCurrent();
    });
  }

  reserveAdditionalPrivateNode(cluster: PhysicalTestCluster): void {
    this.throwIfClosed();
    if (
      this.current === undefined ||
      !this.current.privateCluster ||
      this.current.cluster !== cluster
    ) {
      throw new Error("The private cluster is no longer owned by this pool");
    }
    if (cluster.nodes.length >= this.maximumNodes) {
      throw new Error(`Adding a node would exceed this run's ${this.maximumNodes}-node limit`);
    }
  }

  releaseAdditionalPrivateNode(_cluster: PhysicalTestCluster): void {
    // Physical membership is authoritative in single-slot model.
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      this.closed = true;
      if (this.current !== undefined) {
        await this.retireCurrent();
      }
      if (this.runState !== undefined) {
        await this.runState.close();
      }
    });
  }

  private async provision(spec: ClusterSpec, privateCluster: boolean): Promise<Slot> {
    const instanceId =
      `alternator-js-${process.pid}-${PROCESS_INSTANCE_TOKEN}-${++instanceCounter}`;
    const ownership = await this.reserveOwnership(instanceId, spec);
    try {
      const data = await this.provisioner.provision(spec, instanceId, ownership.ccmId);
      return {
        generation: ++this.generation,
        reuseKey: privateCluster ? undefined : spec.reuseKey(),
        privateCluster,
        cluster: new PhysicalTestCluster(this.provisioner, data),
        ownership,
        references: 0,
        poisoned: false,
      };
    } catch (error) {
      if (error instanceof CcmClusterProvisioningError) {
        const cluster = new PhysicalTestCluster(this.provisioner, error.cluster);
        cluster.markDirty(error.recoveryRequired);
        const failed: Slot = {
          generation: ++this.generation,
          reuseKey: undefined,
          privateCluster: true,
          cluster,
          ownership,
          references: 0,
          poisoned: true,
        };
        this.current = failed;
        this.terminalFailure = error;
        throw error;
      }
      try {
        await this.completeOwnership(ownership);
      } catch (cleanupError) {
        this.terminalFailure = asError(cleanupError);
      }
      throw asError(error);
    }
  }

  private async reserveOwnership(
    instanceId: string,
    spec: ClusterSpec,
  ): Promise<ClusterOwnership> {
    if (this.runState === undefined) {
      return { instanceId, ccmId: 1, token: randomBytes(16).toString("hex") };
    }
    return this.runState.beginCluster(instanceId, spec, true);
  }

  private async completeOwnership(ownership: ClusterOwnership): Promise<void> {
    await this.runState?.completeCluster(ownership);
  }

  private async retireCurrent(): Promise<void> {
    const current = this.current;
    if (current === undefined) {
      return;
    }
    try {
      await current.cluster.removePhysical();
      await this.completeOwnership(current.ownership);
      this.current = undefined;
      this.terminalFailure = undefined;
    } catch (error) {
      this.terminalFailure = asError(error);
      throw asError(error);
    }
  }

  private reusableLease(slot: Slot): ReusableClusterLease {
    return new ReusableClusterLease(
      this,
      slot.generation,
      new ReadOnlyTestCluster(slot.cluster),
      this.createResourceScope(slot.cluster),
    );
  }

  private createResourceScope(cluster: PhysicalTestCluster): TestResourceScope {
    const runId = this.runState?.runDirectory.split("/").at(-1) ?? "local";
    return new TestResourceScope(cluster, runId, ++this.leaseCounter);
  }

  private validateDemand(spec: ClusterSpec): void {
    spec.validate();
    if (spec.topology.nodeCount > this.maximumNodes) {
      throw new Error(`Requested cluster exceeds this run's ${this.maximumNodes}-node limit`);
    }
  }

  private throwIfUnavailable(): void {
    this.throwIfClosed();
    if (this.terminalFailure !== undefined) {
      throw new Error("CCM pool retained failed cleanup state; close it before provisioning again", {
        cause: this.terminalFailure,
      });
    }
  }

  private throwIfActiveReusableConflict(spec: ClusterSpec): void {
    const current = this.current;
    if (current === undefined) {
      return;
    }
    if (current.privateCluster) {
      throw new Error("A private CCM cluster is already active in this process");
    }
    if (
      current.references > 0 &&
      (current.reuseKey !== spec.reuseKey() || current.poisoned)
    ) {
      throw new Error(
        "The active reusable CCM cluster is incompatible with requested specification",
      );
    }
  }

  private throwIfActivePrivateConflict(): void {
    if (
      this.current !== undefined &&
      (this.current.privateCluster || this.current.references > 0)
    ) {
      throw new Error("A CCM cluster lease is already active in this process");
    }
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new Error("The CCM cluster pool is closed");
    }
  }
}

export class ReusableClusterLease {
  private closed = false;

  constructor(
    private readonly pool: TestClusterPool,
    private readonly generation: number,
    readonly cluster: TestClusterInfo,
    readonly resources: TestResourceScope,
  ) {}

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.releaseReusable(this.generation, this.resources);
  }
}

export class PrivateClusterLease {
  readonly cluster: TestClusterInfo;
  readonly control: PrivateClusterControl;
  private closed = false;

  constructor(
    private readonly pool: TestClusterPool,
    private readonly physicalCluster: PhysicalTestCluster,
    readonly resources: TestResourceScope,
  ) {
    this.cluster = physicalCluster;
    this.control = Object.freeze({
      start: () => physicalCluster.start(),
      stop: () => physicalCluster.stop(),
      startNode: (node: TestClusterNode) => physicalCluster.startNode(node),
      stopNode: (node: TestClusterNode) => physicalCluster.stopNode(node),
      addNode: (datacenter: string, rack: string) =>
        physicalCluster.addNode(pool, datacenter, rack),
      removeNode: (node: TestClusterNode) => physicalCluster.removeNode(pool, node),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.pool.releasePrivate(this.physicalCluster);
    this.closed = true;
  }
}

let sharedPool: Promise<TestClusterPool> | undefined;
let shutdownHooksInstalled = false;
let signalCleanupStarted = false;
let beforeExitCleanupAttempted = false;

export class TestClusters {
  static async acquireReusable(spec: ClusterSpec): Promise<ReusableClusterLease> {
    return (await pool()).acquireReusable(spec);
  }

  static async provisionPrivate(spec: ClusterSpec): Promise<PrivateClusterLease> {
    return (await pool()).provisionPrivate(spec);
  }

  static async closeAll(): Promise<void> {
    const pending = sharedPool;
    if (pending === undefined) {
      return;
    }
    const current = await pending;
    await current.close();
    if (sharedPool === pending) {
      sharedPool = undefined;
    }
  }
}

function pool(): Promise<TestClusterPool> {
  installShutdownHooks();
  sharedPool ??= TestClusterPool.createDefault();
  return sharedPool;
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) {
    return;
  }
  shutdownHooksInstalled = true;
  process.on("beforeExit", () => {
    if (
      sharedPool !== undefined &&
      !signalCleanupStarted &&
      !beforeExitCleanupAttempted
    ) {
      beforeExitCleanupAttempted = true;
      signalCleanupStarted = true;
      void TestClusters.closeAll()
        .catch((error: unknown) => {
          console.error("Failed to remove CCM cluster during process shutdown", error);
          process.exitCode = 1;
        })
        .finally(() => {
          signalCleanupStarted = false;
        });
    }
  });
  installSignalCleanup("SIGINT");
  installSignalCleanup("SIGTERM");
}

function installSignalCleanup(signal: NodeJS.Signals): void {
  const handler = (): void => {
    if (signalCleanupStarted) {
      return;
    }
    signalCleanupStarted = true;
    void TestClusters.closeAll()
      .catch((error: unknown) => {
        console.error(`Failed to remove CCM cluster after ${signal}`, error);
      })
      .finally(() => {
        process.off(signal, handler);
        process.kill(process.pid, signal);
      });
  };
  process.on(signal, handler);
}

function parsePositiveInteger(
  variable: string,
  defaultValue: number,
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment[variable];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!/^[0-9]+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${variable} must be a positive integer`);
  }
  return value;
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

function validateClientConfigOverrides(overrides: ClientConfigOverrides): void {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new Error("CCM client configuration overrides must be an object");
  }
  for (const key of ["runtime", "scheme", "port", "seeds", "tls"] as const) {
    if (Object.hasOwn(overrides, key)) {
      throw new Error(`CCM client configuration overrides cannot replace '${key}'`);
    }
  }
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
