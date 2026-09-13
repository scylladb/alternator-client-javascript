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

import { describe, expect, it } from "vitest";
import { TestClusterPool } from "../../testinfra/ccm/clusters.js";
import { TestClusterNode, type TestResourceScope } from "../../testinfra/ccm/model.js";
import {
  CcmClusterProvisioningError,
  CcmNodeProvisioningError,
  CcmProcessCleanupError,
  type ClusterProvisioner,
  type ProvisionedClusterData,
} from "../../testinfra/ccm/provisioner.js";
import {
  AlternatorTransport,
  ClusterSpec,
  ClusterTopology,
} from "../../testinfra/ccm/spec.js";

describe("CCM-REQ-003 and CCM-REQ-005 reusable cluster lifecycle", () => {
  it("shares a matching physical cluster while keeping resource scopes independent", async () => {
    const harness = createHarness();
    const first = await harness.pool.acquireReusable(new ClusterSpec());
    const second = await harness.pool.acquireReusable(new ClusterSpec());

    expect(first.cluster.instanceId).toBe(second.cluster.instanceId);
    expect(first.resources.prefix).not.toBe(second.resources.prefix);
    expect(first.resources.newTableName("same hint")).not.toBe(
      second.resources.newTableName("same hint"),
    );
    expect(harness.provisioner.provisionCalls).toHaveLength(1);
    expect("start" in first.cluster).toBe(false);

    await first.close();
    await first.close();
    expect(harness.cleaner.attempts).toEqual([first.resources.prefix]);
    expect(harness.provisioner.removeAttempts).toEqual([]);

    await second.close();
    expect(harness.cleaner.attempts).toEqual([
      first.resources.prefix,
      second.resources.prefix,
    ]);
    expect(harness.provisioner.removeAttempts).toEqual([]);

    await harness.pool.close();
    expect(harness.provisioner.removeAttempts).toEqual([first.cluster.instanceId]);
  });

  it("rejects active incompatible and private requests immediately", async () => {
    const harness = createHarness();
    const lease = await harness.pool.acquireReusable(new ClusterSpec());
    const incompatible = new ClusterSpec().withScyllaVersion("release:2026.1");

    await expect(harness.pool.acquireReusable(incompatible)).rejects.toThrow(
      /active reusable CCM cluster is incompatible/u,
    );
    await expect(harness.pool.provisionPrivate(new ClusterSpec())).rejects.toThrow(
      /cluster lease is already active/u,
    );
    expect(harness.provisioner.provisionCalls).toHaveLength(1);
    expect(harness.provisioner.removeAttempts).toEqual([]);

    await lease.close();
    await harness.pool.close();
  });

  it("rejects incompatible demand without waiting for another lease cleanup", async () => {
    const provisioner = new FakeClusterProvisioner();
    let signalCleanupStarted = (): void => undefined;
    let releaseCleanup = (): void => undefined;
    const cleanupStarted = new Promise<void>((resolveStarted) => {
      signalCleanupStarted = resolveStarted;
    });
    const cleanupBlocked = new Promise<void>((resolveBlocked) => {
      releaseCleanup = resolveBlocked;
    });
    const pool = new TestClusterPool({
      provisioner,
      cleanupResources: async () => {
        signalCleanupStarted();
        await cleanupBlocked;
      },
    });
    const first = await pool.acquireReusable(new ClusterSpec());
    const second = await pool.acquireReusable(new ClusterSpec());
    const closing = first.close();
    await cleanupStarted;

    try {
      await expect(
        pool.acquireReusable(new ClusterSpec().withScyllaVersion("release:2026.1")),
      ).rejects.toThrow(/active reusable CCM cluster is incompatible/u);
      await expect(pool.provisionPrivate(new ClusterSpec())).rejects.toThrow(
        /cluster lease is already active/u,
      );
    } finally {
      releaseCleanup();
      await closing;
      await second.close();
      await pool.close();
    }
  });

  it("rejects cluster-owned fields hidden inside structural client overrides", async () => {
    const harness = createHarness();
    const lease = await harness.pool.acquireReusable(new ClusterSpec());
    const overrides = {
      region: "us-east-1",
      seeds: ["unrelated.example"],
      tls: { rejectUnauthorized: false },
    };

    expect(() => lease.cluster.clientConfig(AlternatorTransport.HTTPS, overrides)).toThrow(
      /cannot replace 'seeds'|cannot replace 'tls'/u,
    );

    await lease.close();
    await harness.pool.close();
  });

  it("health-checks an idle matching cluster and replaces it when unhealthy", async () => {
    const harness = createHarness();
    const first = await harness.pool.acquireReusable(new ClusterSpec());
    const firstInstance = first.cluster.instanceId;
    await first.close();
    harness.provisioner.healthResults.push(false);

    const replacement = await harness.pool.acquireReusable(new ClusterSpec());

    expect(replacement.cluster.instanceId).not.toBe(firstInstance);
    expect(harness.provisioner.healthChecks).toEqual([firstInstance]);
    expect(harness.provisioner.removeAttempts).toEqual([firstInstance]);
    expect(harness.provisioner.provisionCalls).toHaveLength(2);

    await replacement.close();
    await harness.pool.close();
  });

  it("replaces an idle incompatible cluster without probing its health", async () => {
    const harness = createHarness();
    const first = await harness.pool.acquireReusable(new ClusterSpec());
    const firstInstance = first.cluster.instanceId;
    await first.close();

    const replacement = await harness.pool.acquireReusable(
      new ClusterSpec().withTransports(AlternatorTransport.HTTP),
    );

    expect(replacement.cluster.instanceId).not.toBe(firstInstance);
    expect(harness.provisioner.healthChecks).toEqual([]);
    expect(harness.provisioner.removeAttempts).toEqual([firstInstance]);

    await replacement.close();
    await harness.pool.close();
  });

  it("poisons shared state after cleanup failure and retires it after final release", async () => {
    const harness = createHarness();
    const first = await harness.pool.acquireReusable(new ClusterSpec());
    const second = await harness.pool.acquireReusable(new ClusterSpec());
    const failedInstance = first.cluster.instanceId;
    harness.cleaner.failures.push(new Error("resource cleanup failed"));

    await expect(first.close()).rejects.toThrow("resource cleanup failed");
    await expect(first.close()).resolves.toBeUndefined();
    await expect(harness.pool.acquireReusable(new ClusterSpec())).rejects.toThrow(
      /retained failed cleanup state/u,
    );
    expect(harness.provisioner.removeAttempts).toEqual([]);

    await second.close();
    expect(harness.provisioner.removeAttempts).toEqual([failedInstance]);

    const replacement = await harness.pool.acquireReusable(new ClusterSpec());
    expect(replacement.cluster.instanceId).not.toBe(failedInstance);
    await replacement.close();
    await harness.pool.close();
  });
});

describe("CCM-REQ-004 private cluster lifecycle", () => {
  it("keeps private leases exclusive and closes a successful lease idempotently", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(new ClusterSpec());

    await expect(harness.pool.provisionPrivate(new ClusterSpec())).rejects.toThrow(
      /cluster lease is already active/u,
    );
    await expect(harness.pool.acquireReusable(new ClusterSpec())).rejects.toThrow(
      /private CCM cluster is already active/u,
    );

    await lease.close();
    await lease.close();
    expect(harness.provisioner.removeAttempts).toEqual([lease.cluster.instanceId]);

    await harness.pool.close();
  });

  it("allows a private close to retry failed physical removal", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(new ClusterSpec());
    harness.provisioner.removeFailures.push(new Error("first removal failed"));

    await expect(lease.close()).rejects.toThrow("first removal failed");
    expect(harness.provisioner.removeAttempts).toHaveLength(1);

    await expect(lease.close()).resolves.toBeUndefined();
    expect(harness.provisioner.removeAttempts).toEqual([
      lease.cluster.instanceId,
      lease.cluster.instanceId,
    ]);

    await harness.pool.close();
  });

  it("maps cluster and node controls to provisioner operations and keeps node views current", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(
      new ClusterSpec().withTopology(ClusterTopology.singleDatacenter(2)),
    );
    const first = lease.cluster.nodes[0]!;

    await lease.control.stop();
    await lease.control.stop();
    expect(harness.provisioner.stopCalls).toEqual([lease.cluster.instanceId]);

    await lease.control.start();
    await lease.control.start();
    expect(harness.provisioner.startCalls).toEqual([
      { instanceId: lease.cluster.instanceId, nodes: ["node1", "node2"] },
    ]);
    expect(harness.provisioner.readyCalls).toEqual([
      `${lease.cluster.instanceId}/node1`,
      `${lease.cluster.instanceId}/node2`,
    ]);

    await lease.control.stopNode(first);
    await lease.control.stopNode(first);
    expect(harness.provisioner.stopNodeCalls).toEqual([`${lease.cluster.instanceId}/node1`]);

    await lease.control.startNode(first);
    await lease.control.startNode(first);
    expect(harness.provisioner.startNodeCalls).toEqual([`${lease.cluster.instanceId}/node1`]);
    expect(harness.provisioner.readyCalls.at(-1)).toBe(`${lease.cluster.instanceId}/node1`);

    const added = await lease.control.addNode("dc2", "RAC3");
    expect(added).toMatchObject({
      name: "node3",
      address: "127.0.1.3",
      datacenter: "dc2",
      rack: "RAC3",
    });
    expect(lease.cluster.nodes.map((node) => node.name)).toEqual(["node1", "node2", "node3"]);

    await lease.control.removeNode(added);
    expect(harness.provisioner.decommissionNodeCalls).toEqual([
      `${lease.cluster.instanceId}/node3`,
    ]);
    expect(harness.provisioner.deleteNodeStateCalls).toEqual([
      `${lease.cluster.instanceId}/node3`,
    ]);
    expect(lease.cluster.nodes.map((node) => node.name)).toEqual(["node1", "node2"]);

    await lease.close();
    await harness.pool.close();
  });

  it("rejects foreign node identities, invalid additions, final-node removal, and node overflow", async () => {
    const harness = createHarness({ maximumNodes: 2 });
    const lease = await harness.pool.provisionPrivate(
      new ClusterSpec().withTopology(ClusterTopology.singleDatacenter(1)),
    );
    const onlyNode = lease.cluster.nodes[0]!;
    const foreignCopy = new TestClusterNode({
      name: onlyNode.name,
      address: onlyNode.address,
      datacenter: onlyNode.datacenter,
      rack: onlyNode.rack,
    });

    await expect(lease.control.stopNode(foreignCopy)).rejects.toThrow(/not part of cluster/u);
    await expect(lease.control.removeNode(onlyNode)).rejects.toThrow(/final node/u);
    await expect(lease.control.addNode(" ", "RAC1")).rejects.toThrow(
      /datacenter and rack are required/u,
    );

    await lease.control.addNode("dc1", "RAC1");
    await expect(lease.control.addNode("dc1", "RAC1")).rejects.toThrow(/2-node limit/u);
    expect(harness.provisioner.addNodeCalls).toHaveLength(1);

    await lease.close();
    await harness.pool.close();
  });

  it("dirties the cluster after an ambiguous lifecycle failure and permits whole-cluster cleanup", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(new ClusterSpec());
    const node = lease.cluster.nodes[0]!;
    harness.provisioner.stopNodeFailures.push(new Error("stop result is ambiguous"));

    await expect(lease.control.stopNode(node)).rejects.toThrow("stop result is ambiguous");
    await expect(lease.control.startNode(node)).rejects.toThrow(/ambiguous state/u);
    await expect(lease.control.addNode("dc1", "RAC1")).rejects.toThrow(/ambiguous state/u);

    await lease.close();
    expect(harness.provisioner.removeAttempts).toEqual([lease.cluster.instanceId]);
    await harness.pool.close();
  });

  it("keeps a cluster usable after node-add rollback proves state clean", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(
      new ClusterSpec().withTopology(ClusterTopology.singleDatacenter(1)),
    );
    harness.provisioner.addNodeFailure = (node) =>
      new CcmNodeProvisioningError(node, new Error("node start failed"), {
        clusterStateAmbiguous: false,
        nodeRemainsProvisioned: false,
        recoveryRequired: false,
      });

    await expect(lease.control.addNode("dc1", "RAC1")).rejects.toThrow("node2");
    const added = await lease.control.addNode("dc1", "RAC1");

    expect(added.name).toBe("node2");
    expect(lease.cluster.nodes).toHaveLength(2);
    await lease.close();
    await harness.pool.close();
  });

  it("dirties the cluster when node-add rollback leaves ambiguous state", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(
      new ClusterSpec().withTopology(ClusterTopology.singleDatacenter(1)),
    );
    harness.provisioner.addNodeFailure = (node) =>
      new CcmNodeProvisioningError(node, new Error("rollback not proven"), {
        clusterStateAmbiguous: true,
        nodeRemainsProvisioned: true,
        recoveryRequired: false,
      });

    await expect(lease.control.addNode("dc1", "RAC1")).rejects.toThrow("node2");
    expect(lease.cluster.nodes.map((node) => node.name)).toEqual(["node1", "node2"]);
    await expect(lease.control.stop()).rejects.toThrow(/ambiguous state/u);

    await lease.close();
    await harness.pool.close();
  });

  it("retains process-cleanup ambiguity for next-process recovery", async () => {
    const harness = createHarness();
    const lease = await harness.pool.provisionPrivate(new ClusterSpec());
    const node = lease.cluster.nodes[0]!;
    harness.provisioner.stopNodeFailures.push(
      new CcmProcessCleanupError("owned process survival is unknown"),
    );

    await expect(lease.control.stopNode(node)).rejects.toThrow(
      "owned process survival is unknown",
    );
    await expect(lease.close()).rejects.toThrow(/recovered by next test process/u);
    await expect(lease.close()).rejects.toThrow(/recovered by next test process/u);
    expect(harness.provisioner.removeAttempts).toEqual([]);
  });
});

describe("CCM provisioning failure retention", () => {
  it("retains failed cluster ownership until whole-cluster cleanup succeeds", async () => {
    const harness = createHarness();
    harness.provisioner.provisionFailure = (cluster) =>
      new CcmClusterProvisioningError(
        cluster,
        new Error("cluster start failed"),
        new Error("rollback failed"),
        false,
      );

    await expect(harness.pool.acquireReusable(new ClusterSpec())).rejects.toThrow(
      /rollback failed/u,
    );
    await expect(harness.pool.acquireReusable(new ClusterSpec())).rejects.toThrow(
      /retained failed cleanup state/u,
    );

    const retained = harness.provisioner.provisionCalls[0]!;
    await harness.pool.close();
    expect(harness.provisioner.removeAttempts).toEqual([retained.instanceId]);
  });
});

interface Harness {
  readonly provisioner: FakeClusterProvisioner;
  readonly cleaner: FakeResourceCleaner;
  readonly pool: TestClusterPool;
}

function createHarness(options: { readonly maximumNodes?: number } = {}): Harness {
  const provisioner = new FakeClusterProvisioner();
  const cleaner = new FakeResourceCleaner();
  const pool = new TestClusterPool({
    provisioner,
    cleanupResources: (resources) => cleaner.cleanup(resources),
    ...(options.maximumNodes === undefined ? {} : { maximumNodes: options.maximumNodes }),
  });
  return { provisioner, cleaner, pool };
}

class FakeResourceCleaner {
  readonly attempts: string[] = [];
  readonly failures: Error[] = [];

  cleanup(resources: TestResourceScope): Promise<void> {
    this.attempts.push(resources.prefix);
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }
}

class FakeClusterProvisioner implements ClusterProvisioner {
  readonly runDirectory = "/tmp/alternator-js-fake-ccm";
  readonly provisionCalls: ProvisionedClusterData[] = [];
  readonly healthChecks: string[] = [];
  readonly healthResults: boolean[] = [];
  readonly startCalls: Array<{ readonly instanceId: string; readonly nodes: readonly string[] }> = [];
  readonly stopCalls: string[] = [];
  readonly startNodeCalls: string[] = [];
  readonly stopNodeCalls: string[] = [];
  readonly addNodeCalls: Array<{
    readonly instanceId: string;
    readonly datacenter: string;
    readonly rack: string;
  }> = [];
  readonly decommissionNodeCalls: string[] = [];
  readonly deleteNodeStateCalls: string[] = [];
  readonly readyCalls: string[] = [];
  readonly removeAttempts: string[] = [];
  readonly removeFailures: Error[] = [];
  readonly stopNodeFailures: Error[] = [];
  provisionFailure:
    | ((cluster: ProvisionedClusterData) => Error)
    | undefined;
  addNodeFailure: ((node: TestClusterNode) => Error) | undefined;

  private readonly running = new Map<string, boolean>();

  provision(
    spec: ClusterSpec,
    instanceId: string,
    ccmId: number,
  ): Promise<ProvisionedClusterData> {
    const nodes: TestClusterNode[] = [];
    let nodeIndex = 0;
    for (const [datacenterIndex, datacenter] of spec.topology.datacenters.entries()) {
      for (const [rackIndex, rack] of datacenter.racks.entries()) {
        for (let count = 0; count < rack.nodeCount; count += 1) {
          nodeIndex += 1;
          nodes.push(
            new TestClusterNode({
              name: `node${nodeIndex}`,
              address: `127.0.${ccmId}.${nodeIndex}`,
              datacenter: `dc${datacenterIndex + 1}`,
              rack: `RAC${rackIndex + 1}`,
            }),
          );
        }
      }
    }
    const cluster: ProvisionedClusterData = {
      instanceId,
      ccmId,
      ccmDirectory: `${this.runDirectory}/clusters/${instanceId}`,
      spec,
      nodes: Object.freeze(nodes),
      ...(spec.hasTransport(AlternatorTransport.HTTPS)
        ? { caCertificatePath: `${this.runDirectory}/ca.pem` }
        : {}),
    };
    this.provisionCalls.push(cluster);
    for (const node of nodes) {
      this.running.set(nodeKey(cluster, node), true);
    }
    const failure = this.provisionFailure?.(cluster);
    this.provisionFailure = undefined;
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return Promise.resolve(cluster);
  }

  start(
    cluster: ProvisionedClusterData,
    nodes: readonly TestClusterNode[] = cluster.nodes,
  ): Promise<void> {
    this.startCalls.push({ instanceId: cluster.instanceId, nodes: nodes.map((node) => node.name) });
    for (const node of nodes) {
      this.running.set(nodeKey(cluster, node), true);
    }
    return Promise.resolve();
  }

  stop(cluster: ProvisionedClusterData): Promise<void> {
    this.stopCalls.push(cluster.instanceId);
    for (const node of cluster.nodes) {
      this.running.set(nodeKey(cluster, node), false);
    }
    return Promise.resolve();
  }

  startNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    this.startNodeCalls.push(nodeKey(cluster, node));
    this.running.set(nodeKey(cluster, node), true);
    return Promise.resolve();
  }

  stopNode(cluster: ProvisionedClusterData, node: TestClusterNode): Promise<void> {
    this.stopNodeCalls.push(nodeKey(cluster, node));
    const failure = this.stopNodeFailures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    this.running.set(nodeKey(cluster, node), false);
    return Promise.resolve();
  }

  addNode(
    cluster: ProvisionedClusterData,
    datacenter: string,
    rack: string,
  ): Promise<TestClusterNode> {
    this.addNodeCalls.push({ instanceId: cluster.instanceId, datacenter, rack });
    const existingNames = new Set(cluster.nodes.map((node) => node.name));
    let nodeIndex = 1;
    while (existingNames.has(`node${nodeIndex}`)) {
      nodeIndex += 1;
    }
    const node = new TestClusterNode({
      name: `node${nodeIndex}`,
      address: `127.0.${cluster.ccmId}.${nodeIndex}`,
      datacenter,
      rack,
    });
    const failure = this.addNodeFailure?.(node);
    this.addNodeFailure = undefined;
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    this.running.set(nodeKey(cluster, node), true);
    return Promise.resolve(node);
  }

  decommissionNode(
    cluster: ProvisionedClusterData,
    node: TestClusterNode,
  ): Promise<void> {
    this.decommissionNodeCalls.push(nodeKey(cluster, node));
    this.running.set(nodeKey(cluster, node), false);
    return Promise.resolve();
  }

  deleteNodeState(
    cluster: ProvisionedClusterData,
    node: TestClusterNode,
  ): Promise<void> {
    this.deleteNodeStateCalls.push(nodeKey(cluster, node));
    this.running.delete(nodeKey(cluster, node));
    return Promise.resolve();
  }

  isHealthy(cluster: ProvisionedClusterData): Promise<boolean> {
    this.healthChecks.push(cluster.instanceId);
    return Promise.resolve(this.healthResults.shift() ?? true);
  }

  isNodeRunning(
    cluster: ProvisionedClusterData,
    node: TestClusterNode,
  ): Promise<boolean> {
    return Promise.resolve(this.running.get(nodeKey(cluster, node)) ?? false);
  }

  waitForNodeReady(
    cluster: ProvisionedClusterData,
    node: TestClusterNode,
  ): Promise<void> {
    this.readyCalls.push(nodeKey(cluster, node));
    return Promise.resolve();
  }

  remove(cluster: ProvisionedClusterData): Promise<void> {
    this.removeAttempts.push(cluster.instanceId);
    const failure = this.removeFailures.shift();
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    for (const node of cluster.nodes) {
      this.running.delete(nodeKey(cluster, node));
    }
    return Promise.resolve();
  }
}

function nodeKey(cluster: ProvisionedClusterData, node: TestClusterNode): string {
  return `${cluster.instanceId}/${node.name}`;
}
