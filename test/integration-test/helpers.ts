import {
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-dynamodb";
import { HttpRequest } from "@smithy/protocol-http";
import type { FinalizeRequestMiddleware } from "@smithy/types";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AlternatorNodeDynamoDBClientConfig } from "../../src/index.js";
import { AlternatorDynamoDBClient } from "../../src/index.js";
import { AlternatorDynamoDBDocumentClient, type TranslateConfig } from "../../src/document.js";
import { integrationConfig, type IntegrationEndpoint } from "./config.js";

type ClientOverrides = Omit<Partial<AlternatorNodeDynamoDBClientConfig>, "seeds" | "scheme" | "port">;

export interface CapturedCommandRequest {
  readonly commandName: string | undefined;
  readonly request: HttpRequest;
}

let captureMiddlewareId = 0;

export function buildClient(
  endpoint: IntegrationEndpoint,
  overrides: ClientOverrides = {},
): AlternatorDynamoDBClient {
  const tls = endpoint.scheme === "https"
    ? {
        rejectUnauthorized: false,
        ...overrides.tls,
      }
    : overrides.tls;

  return new AlternatorDynamoDBClient({
    ...overrides,
    seeds: [endpoint.host],
    scheme: endpoint.scheme,
    port: endpoint.port,
    credentials: overrides.credentials ?? integrationConfig.credentials,
    discovery: {
      background: false,
      ...overrides.discovery,
    },
    ...(tls ? { tls } : {}),
  });
}

export function buildDocumentClient(
  endpoint: IntegrationEndpoint,
  overrides: ClientOverrides = {},
  translateConfig?: TranslateConfig,
): AlternatorDynamoDBDocumentClient {
  return AlternatorDynamoDBDocumentClient.fromConfig(
    {
      ...overrides,
      seeds: [endpoint.host],
      scheme: endpoint.scheme,
      port: endpoint.port,
      credentials: overrides.credentials ?? integrationConfig.credentials,
      discovery: {
        background: false,
        ...overrides.discovery,
      },
      ...(endpoint.scheme === "https"
        ? {
            tls: {
              rejectUnauthorized: false,
              ...overrides.tls,
            },
          }
        : overrides.tls
          ? { tls: overrides.tls }
          : {}),
    },
    translateConfig,
  );
}

export function captureCommandRequests(client: AlternatorDynamoDBClient): CapturedCommandRequest[] {
  const captured: CapturedCommandRequest[] = [];
  const name = `integrationCaptureCommandRequests${captureMiddlewareId++}`;
  const captureMiddleware: FinalizeRequestMiddleware<ServiceInputTypes, ServiceOutputTypes> = (next, context) => (args) => {
    if (HttpRequest.isInstance(args.request)) {
      captured.push({
        commandName: context.commandName,
        request: HttpRequest.clone(args.request),
      });
    }
    return next(args);
  };

  client.middlewareStack.addRelativeTo(
    captureMiddleware,
    {
      relation: "after",
      toMiddleware: "alternatorPostSigningMiddleware",
      name,
      override: true,
    },
  );

  return captured;
}

export function commandHeaders(
  captured: readonly CapturedCommandRequest[],
  commandName: string,
): Record<string, string | undefined> {
  return captured.find((entry) => entry.commandName === commandName)?.request.headers ?? {};
}

export async function createStringHashTable(
  client: DynamoDBClient,
  tableName: string,
  partitionKey = "pk",
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      KeySchema: [{ AttributeName: partitionKey, KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: partitionKey, AttributeType: "S" }],
      ProvisionedThroughput: {
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1,
      },
    }),
  );
}

export async function safeDeleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!isResourceNotFound(error)) {
      throw error;
    }
  }
}

export async function safeDeleteItem(
  client: DynamoDBClient,
  tableName: string,
  key: Record<string, AttributeValue>,
): Promise<void> {
  try {
    await client.send(new DeleteItemCommand({ TableName: tableName, Key: key }));
  } catch (error) {
    if (!isResourceNotFound(error)) {
      throw error;
    }
  }
}

export async function putStringItem(
  client: DynamoDBClient,
  tableName: string,
  pk: string,
  attributes: Record<string, AttributeValue> = {},
): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: { S: pk },
        ...attributes,
      },
    }),
  );
}

export async function getStringItem(
  client: DynamoDBClient,
  tableName: string,
  pk: string,
): Promise<Record<string, AttributeValue> | undefined> {
  const response = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk } },
      ConsistentRead: true,
    }),
  );
  return response.Item;
}

export async function assertTableIsUsable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DescribeTableCommand({ TableName: tableName }));
}

export async function assertListTablesSucceeds(client: DynamoDBClient): Promise<void> {
  await client.send(new ListTablesCommand({ Limit: 1 }));
}

export function uniqueTableName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function largePayload(): string {
  return "This is a test value that should be compressed. ".repeat(100);
}

export function customCaAvailable(): boolean {
  return integrationConfig.caCertPath !== undefined && existsSync(integrationConfig.caCertPath);
}

export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  description: string,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined | false;

  while (Date.now() <= deadline) {
    lastValue = await probe();
    if (lastValue) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}; last value: ${String(lastValue)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isResourceNotFound(error: unknown): boolean {
  return isRecord(error) && (
    error.name === "ResourceNotFoundException" ||
    error.__type === "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException" ||
    error.__type === "ResourceNotFoundException"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
