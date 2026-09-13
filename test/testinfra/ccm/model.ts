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
import { setTimeout as delay } from "node:timers/promises";
import {
  DeleteTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import type { AlternatorDynamoDBClient } from "../../../src/client.js";
import type { AlternatorNodeDynamoDBClientConfig } from "../../../src/types.js";
import { AlternatorTransport } from "./spec.js";
import type { ClusterSpec } from "./spec.js";

export interface TestClusterNodeValues {
  readonly name: string;
  readonly address: string;
  readonly datacenter: string;
  readonly rack: string;
}

export class TestClusterNode implements TestClusterNodeValues {
  readonly name: string;
  readonly address: string;
  readonly datacenter: string;
  readonly rack: string;

  constructor(values: TestClusterNodeValues) {
    this.name = values.name;
    this.address = values.address;
    this.datacenter = values.datacenter;
    this.rack = values.rack;
    Object.freeze(this);
  }
}

export interface AlternatorConnection {
  readonly seedEndpoint: URL;
  readonly nodeEndpoints: readonly URL[];
  readonly credentials?: Readonly<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
  readonly caCertificatePath?: string;
}

export type ClientConfigOverrides = Omit<
  Partial<AlternatorNodeDynamoDBClientConfig>,
  "runtime" | "scheme" | "port" | "seeds" | "tls"
>;

export interface TestClusterInfo {
  readonly instanceId: string;
  readonly spec: ClusterSpec;
  readonly nodes: readonly TestClusterNode[];
  connection(transport: AlternatorTransport): AlternatorConnection;
  clientConfig(
    transport: AlternatorTransport,
    overrides?: ClientConfigOverrides,
  ): AlternatorNodeDynamoDBClientConfig;
  createClient(
    transport: AlternatorTransport,
    overrides?: ClientConfigOverrides,
  ): AlternatorDynamoDBClient;
}

export interface PrivateClusterControl {
  start(): Promise<void>;
  stop(): Promise<void>;
  startNode(node: TestClusterNode): Promise<void>;
  stopNode(node: TestClusterNode): Promise<void>;
  addNode(datacenter: string, rack: string): Promise<TestClusterNode>;
  removeNode(node: TestClusterNode): Promise<void>;
}

export class TestResourceScope {
  static readonly MAXIMUM_TABLE_NAME_LENGTH = 255;
  static readonly DEFAULT_CLEANUP_TIMEOUT_MS = 120_000;

  readonly prefix: string;
  private readonly cluster: TestClusterInfo;
  private readonly cleanupTimeoutMs: number;

  constructor(
    cluster: TestClusterInfo,
    runId: string,
    leaseId: number,
    cleanupTimeoutMs = TestResourceScope.DEFAULT_CLEANUP_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(leaseId) || leaseId < 1) {
      throw new Error("leaseId must be a positive integer");
    }
    if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
      throw new Error("cleanupTimeoutMs must be positive");
    }
    this.cluster = cluster;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    const leaseComponent = `_${leaseId}_`;
    const maximumRunIdLength =
      TestResourceScope.MAXIMUM_TABLE_NAME_LENGTH - 33 - "js_it_".length - leaseComponent.length;
    this.prefix = `js_it_${truncate(sanitize(runId), maximumRunIdLength)}${leaseComponent}`;
  }

  newTableName(hint: string): string {
    const suffix = `_${randomUUID().replaceAll("-", "")}`;
    const maximumHintLength =
      TestResourceScope.MAXIMUM_TABLE_NAME_LENGTH - this.prefix.length - suffix.length;
    return `${this.prefix}${truncate(sanitize(hint), maximumHintLength)}${suffix}`;
  }

  async cleanup(): Promise<void> {
    const transport = this.cluster.spec.hasTransport(AlternatorTransport.HTTP)
      ? AlternatorTransport.HTTP
      : AlternatorTransport.HTTPS;
    const client = this.cluster.createClient(transport, {
      discovery: { background: false },
      connection: {
        timeouts: {
          connectMs: Math.min(this.cleanupTimeoutMs, 10_000),
          requestMs: Math.min(this.cleanupTimeoutMs, 10_000),
          socketMs: Math.min(this.cleanupTimeoutMs, 10_000),
        },
      },
    });
    try {
      await cleanupTables(client, this.prefix, this.cleanupTimeoutMs);
    } finally {
      client.destroy();
    }
  }
}

export async function cleanupTables(
  client: AlternatorDynamoDBClient,
  prefix: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const ownedTables: string[] = [];
  let startName: string | undefined;
  do {
    const response = await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: startName }),
      deadlineOptions(deadline),
    );
    ownedTables.push(...(response.TableNames ?? []).filter((name) => name.startsWith(prefix)));
    startName = response.LastEvaluatedTableName;
  } while (startName !== undefined && startName !== "");

  for (const tableName of ownedTables) {
    try {
      await client.send(new DeleteTableCommand({ TableName: tableName }), deadlineOptions(deadline));
      await waitForTableDeletion(client, tableName, deadline);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) {
        throw error;
      }
    }
  }
}

async function waitForTableDeletion(
  client: AlternatorDynamoDBClient,
  tableName: string,
  deadline: number,
): Promise<void> {
  while (true) {
    try {
      await client.send(
        new DescribeTableCommand({ TableName: tableName }),
        deadlineOptions(deadline),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return;
      }
      throw error;
    }
    await delay(Math.min(100, remainingTime(deadline)));
  }
}

function deadlineOptions(deadline: number): { abortSignal: AbortSignal } {
  const remaining = remainingTime(deadline);
  return { abortSignal: AbortSignal.timeout(Math.min(remaining, 10_000)) };
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Timed out cleaning DynamoDB tables for a CCM cluster lease");
  }
  return remaining;
}

function sanitize(value: string): string {
  let result = "";
  for (const character of value.toLowerCase()) {
    result += /[a-z0-9_.-]/u.test(character) ? character : "_";
  }
  return result;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : value.slice(0, maximumLength);
}
