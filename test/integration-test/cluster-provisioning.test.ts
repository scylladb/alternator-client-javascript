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

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import type { AlternatorDynamoDBClient } from "../../src/client.js";
import {
  AlternatorTransport,
  ClusterSecuritySpec,
  ClusterTopology,
  defaultClusterSpec,
  TestClusters,
} from "../testinfra/ccm/index.js";

const describeContracts = truthy(process.env.CCM_PROVISIONING_CONTRACTS)
  ? describe
  : describe.skip;

describeContracts("CCM cluster provisioning contracts", () => {
  afterAll(async () => {
    await TestClusters.closeAll();
  });

  it("shares matching reusable clusters while isolating resource scopes", async () => {
    const first = await TestClusters.acquireReusable(defaultClusterSpec());
    const second = await TestClusters.acquireReusable(defaultClusterSpec());
    const client = second.cluster.createClient(AlternatorTransport.HTTP);
    const firstTable = first.resources.newTableName("first");
    const secondTable = second.resources.newTableName("second");

    try {
      expect(first.cluster.instanceId).toBe(second.cluster.instanceId);
      await createTable(client, firstTable);
      await createTable(client, secondTable);
      await expect(describeTable(client, firstTable)).resolves.toBe(firstTable);
      await expect(describeTable(client, secondTable)).resolves.toBe(secondTable);

      await first.close();

      await expect(client.send(new DescribeTableCommand({ TableName: firstTable }))).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      await expect(describeTable(client, secondTable)).resolves.toBe(secondTable);
    } finally {
      client.destroy();
      await first.close();
      await second.close();
    }
  });

  it("provides working credentials for an authorized cluster", async () => {
    const lease = await TestClusters.acquireReusable(
      defaultClusterSpec()
        .withTopology(ClusterTopology.singleDatacenter(1))
        .withTransports(AlternatorTransport.HTTP)
        .withSecurity(ClusterSecuritySpec.ENFORCED),
    );
    const unauthorized = lease.cluster.createClient(AlternatorTransport.HTTP, {
      credentials: { accessKeyId: "wrong-user", secretAccessKey: "wrong-password" },
    });
    const authorized = lease.cluster.createClient(AlternatorTransport.HTTP);
    try {
      await expect(unauthorized.send(new ListTablesCommand({ Limit: 1 }))).rejects.toBeDefined();
      await expect(authorized.send(new ListTablesCommand({ Limit: 1 }))).resolves.toBeDefined();
    } finally {
      unauthorized.destroy();
      authorized.destroy();
      await lease.close();
    }
  });

  it("changes node lifecycle and topology on a private HTTPS cluster", async () => {
    const lease = await TestClusters.provisionPrivate(
      defaultClusterSpec()
        .withTopology(ClusterTopology.singleDatacenter(1))
        .withTransports(AlternatorTransport.HTTPS),
    );
    try {
      const original = lease.cluster.nodes[0]!;
      const added = await lease.control.addNode("dc1", "RAC1");
      const connection = lease.cluster.connection(AlternatorTransport.HTTPS);
      expect(lease.cluster.nodes).toHaveLength(2);
      await expectHttps(`https://${added.address}:8043`, connection.caCertificatePath!);

      await lease.control.stop();
      await expectClosed(connection.seedEndpoint.hostname, Number(connection.seedEndpoint.port));
      await expectClosed(added.address, 8043);
      await lease.control.start();
      await expectHttps(connection.seedEndpoint.toString(), connection.caCertificatePath!);
      await expectHttps(`https://${added.address}:8043`, connection.caCertificatePath!);

      await lease.control.stopNode(added);
      await expectClosed(added.address, 8043);
      await lease.control.startNode(added);
      await expectHttps(`https://${added.address}:8043`, connection.caCertificatePath!);

      await lease.control.removeNode(original);
      expect(lease.cluster.nodes).toHaveLength(1);
      const replacement = await lease.control.addNode("dc1", "RAC1");
      expect(replacement.address).toBe(original.address);
      await expectHttps(`https://${replacement.address}:8043`, connection.caCertificatePath!);
      await lease.control.removeNode(replacement);
    } finally {
      await lease.close();
    }
  });

  it("preserves YAML overrides through cluster and node configuration updates", async () => {
    const lease = await TestClusters.provisionPrivate(
      defaultClusterSpec()
        .withTopology(ClusterTopology.singleDatacenter(1))
        .withTransports(AlternatorTransport.HTTPS)
        .withYamlOverride("hinted_handoff_enabled", "false")
        .withYamlOverride("commitlog_sync", "batch")
        .withYamlOverride("commitlog_sync_batch_window_in_ms", "17")
        .withYamlOverride("commitlog_sync_period_in_ms", "null")
        .withYamlOverride("experimental_features", "null")
        .withYamlOverride(
          "client_encryption_options",
          "{enabled: true, require_client_auth: false}",
        )
        .withYamlOverride("client_encryption_options.enabled", "false"),
    );
    const instanceId = lease.cluster.instanceId;
    try {
      await lease.control.addNode("dc1", "RAC1");
      expect(lease.cluster.nodes).toHaveLength(2);
    } finally {
      await lease.close();
    }

    const diagnostics = resolve(
      process.env.SCYLLA_CCM_DIAGNOSTICS_DIR ?? ".ccm-diagnostics",
    );
    for (const node of ["node1", "node2"]) {
      const path = join(diagnostics, instanceId, instanceId, node, "conf", "scylla.yaml");
      const yaml = parse(await readFile(path, "utf8"), { schema: "core" }) as Record<
        string,
        unknown
      >;
      expect(yaml.hinted_handoff_enabled).toBe(false);
      expect(yaml.commitlog_sync).toBe("batch");
      expect(yaml.commitlog_sync_batch_window_in_ms).toBe(17);
      expect(yaml).toHaveProperty("commitlog_sync_period_in_ms", null);
      expect(yaml).toHaveProperty("experimental_features", null);
      expect(yaml.client_encryption_options).toMatchObject({
        enabled: false,
        require_client_auth: false,
      });
    }
  });
});

async function createTable(
  client: AlternatorDynamoDBClient,
  tableName: string,
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    }),
  );
}

async function describeTable(
  client: AlternatorDynamoDBClient,
  tableName: string,
): Promise<string | undefined> {
  return (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table?.TableName;
}

function expectHttps(endpoint: string, caCertificatePath: string): Promise<void> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsGet(
      endpoint,
      { ca: readFileSync(caCertificatePath) },
      (response) => {
        response.resume();
        response.once("end", () => {
          if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) {
            resolveRequest();
          } else {
            rejectRequest(new Error(`HTTPS endpoint returned ${response.statusCode}`));
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("HTTPS endpoint timed out")));
    request.once("error", rejectRequest);
  });
}

async function expectClosed(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await canConnect(host, port))) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Endpoint remained reachable after stop: ${host}:${port}`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = connect({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnection(false);
    });
    socket.once("error", () => resolveConnection(false));
  });
}

function truthy(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes";
}
