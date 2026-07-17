import {
  DescribeTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from "@aws-sdk/client-dynamodb";
import type { HttpHandler, HttpHandlerUserInput } from "@smithy/protocol-http";
import type { AwsCredentialIdentity, HttpHandlerOptions } from "@smithy/types";
import { DEFAULT_REGION, firstEndpointUrl, NO_AUTH_CREDENTIALS, normalizeConfig } from "./config.js";
import { AlternatorDiscovery } from "./discovery.js";
import { KeyRouteAffinityPlanner } from "./affinity.js";
import { createAlternatorPostSigningMiddleware, createAlternatorRequestMiddleware } from "./middleware.js";
import type { AlternatorBodyCompressor } from "./compression-types.js";
import type { AlternatorDynamoDBClientConfig, AlternatorNode, NormalizedAlternatorConfig } from "./types.js";

export interface AlternatorDynamoDBClientApi {
  nodes(): AlternatorNode[];
  refreshNodes(): Promise<AlternatorNode[]>;
  supportsScopedDiscovery(): Promise<boolean>;
  validateRouting(): Promise<void>;
  partitionKey(tableName: string): string | undefined;
}

export interface AlternatorRuntimePlatform {
  assertRuntimeSupport(config: NormalizedAlternatorConfig): void;
  createRequestHandler(
    input: AlternatorDynamoDBClientConfig,
    config: NormalizedAlternatorConfig,
  ): HttpHandlerUserInput;
  compressBody: AlternatorBodyCompressor;
}

export abstract class AlternatorDynamoDBClientBase extends DynamoDBClient {
  readonly alternator: AlternatorDynamoDBClientApi;
  private readonly alternatorConfig: NormalizedAlternatorConfig;
  private readonly discovery: AlternatorDiscovery;
  private readonly keyAffinity: KeyRouteAffinityPlanner;

  protected constructor(config: AlternatorDynamoDBClientConfig, platform: AlternatorRuntimePlatform) {
    const alternatorConfig = normalizeConfig(config);
    platform.assertRuntimeSupport(alternatorConfig);

    const requestHandler = platform.createRequestHandler(config, alternatorConfig);
    const dynamoConfig = buildDynamoConfig(config, alternatorConfig, requestHandler);

    super(dynamoConfig);

    this.alternatorConfig = alternatorConfig;
    this.discovery = new AlternatorDiscovery(
      alternatorConfig,
      this.config.requestHandler as HttpHandler,
    );
    this.keyAffinity = new KeyRouteAffinityPlanner(
      alternatorConfig.keyRouteAffinity,
      (tableName) => this.discoverPartitionKey(tableName),
      alternatorConfig.logger,
    );
    this.alternator = {
      nodes: () => this.discovery.getLiveNodes(),
      refreshNodes: () => this.discovery.refreshLiveNodes(),
      supportsScopedDiscovery: () => this.discovery.checkRackDatacenterSupport(),
      validateRouting: () => this.discovery.checkIfRackAndDatacenterSetCorrectly(),
      partitionKey: (tableName) => this.keyAffinity.getPartitionKeyName(tableName),
    };

    this.middlewareStack.addRelativeTo(
      createAlternatorRequestMiddleware<ServiceInputTypes, ServiceOutputTypes>({
        discovery: this.discovery,
        config: alternatorConfig,
        keyAffinity: this.keyAffinity,
        compressBody: platform.compressBody,
      }),
      {
        relation: "before",
        toMiddleware: "httpSigningMiddleware",
        name: "alternatorRequestMiddleware",
        override: true,
      },
    );

    this.middlewareStack.addRelativeTo(
      createAlternatorPostSigningMiddleware<ServiceInputTypes, ServiceOutputTypes>(alternatorConfig),
      {
        relation: "after",
        toMiddleware: "httpSigningMiddleware",
        name: "alternatorPostSigningMiddleware",
        override: true,
      },
    );
  }

  override destroy(): void {
    this.discovery.destroy();
    super.destroy();
  }

  private async discoverPartitionKey(tableName: string): Promise<void> {
    const response = await this.send(new DescribeTableCommand({ TableName: tableName }));
    const keyName = response.Table?.KeySchema?.find((key) => key.KeyType === "HASH")?.AttributeName;
    if (!keyName) {
      this.alternatorConfig.logger.warn?.("alternator key affinity: DescribeTable returned no partition key", {
        tableName,
      });
      return;
    }
    this.keyAffinity.setPartitionKeyName(tableName, keyName);
  }
}

function buildDynamoConfig(
  input: AlternatorDynamoDBClientConfig,
  alternatorConfig: NormalizedAlternatorConfig,
  requestHandler: HttpHandlerUserInput,
): DynamoDBClientConfig {
  const {
    seeds: _seeds,
    scheme: _scheme,
    port: _port,
    routing: _routing,
    runtime: _runtime,
    compression: _compression,
    headerOptimization: _headerOptimization,
    userAgent: _userAgent,
    keyRouteAffinity: _keyRouteAffinity,
    tls: _tls,
    discovery: _discovery,
    connection: _connection,
    logger: _logger,
    credentials,
    region,
    ...awsConfigWithEndpoint
  } = input as AlternatorDynamoDBClientConfig & { endpoint?: unknown };
  const { endpoint: _endpoint, ...awsConfig } = awsConfigWithEndpoint;

  const dynamoConfig: DynamoDBClientConfig & { applyChecksum?: boolean } = {
    ...awsConfig,
    endpoint: firstEndpointUrl(alternatorConfig),
    region: region ?? DEFAULT_REGION,
    credentials: dropSessionToken(credentials) ?? NO_AUTH_CREDENTIALS,
    requestHandler,
  };
  if (alternatorConfig.headerOptimization.enabled) {
    dynamoConfig.applyChecksum = false;
  }
  return dynamoConfig;
}

function dropSessionToken(
  credentials: DynamoDBClientConfig["credentials"] | undefined,
): DynamoDBClientConfig["credentials"] | undefined {
  if (credentials === undefined) {
    return undefined;
  }
  if (typeof credentials === "function") {
    return async (identityProperties?: Record<string, unknown>) =>
      removeSessionToken(await credentials(identityProperties));
  }
  return removeSessionToken(credentials);
}

function removeSessionToken(credentials: AwsCredentialIdentity): AwsCredentialIdentity {
  const { sessionToken: _sessionToken, ...withoutSessionToken } = credentials;
  return withoutSessionToken;
}

export type AlternatorRequestHandler = HttpHandler<HttpHandlerOptions>;
