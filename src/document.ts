import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  type TranslateConfig,
} from "@aws-sdk/lib-dynamodb";
import { AlternatorDynamoDBClient } from "./client.js";
import type { AlternatorDynamoDBClientConfig } from "./types.js";

type InternalDocumentClientConstructor = new (
  client: DynamoDBClient,
  translateConfig?: TranslateConfig,
) => AlternatorDynamoDBDocumentClient;

export class AlternatorDynamoDBDocumentClient extends DynamoDBDocumentClient {
  private readonly ownedClient: AlternatorDynamoDBClient | undefined;

  constructor(config: AlternatorDynamoDBClientConfig, translateConfig?: TranslateConfig);
  constructor(configOrClient: AlternatorDynamoDBClientConfig | DynamoDBClient, translateConfig?: TranslateConfig) {
    let ownedClient: AlternatorDynamoDBClient | undefined;
    const client =
      configOrClient instanceof DynamoDBClient
        ? configOrClient
        : (ownedClient = new AlternatorDynamoDBClient(configOrClient));
    super(client, translateConfig);
    this.ownedClient = ownedClient;
  }

  static override from(
    client: DynamoDBClient,
    translateConfig?: TranslateConfig,
  ): AlternatorDynamoDBDocumentClient {
    const InternalDocumentClient =
      AlternatorDynamoDBDocumentClient as unknown as InternalDocumentClientConstructor;
    return new InternalDocumentClient(client, translateConfig);
  }

  override destroy(): void {
    this.ownedClient?.destroy();
    super.destroy();
  }
}

export type { TranslateConfig } from "@aws-sdk/lib-dynamodb";
export * from "@aws-sdk/lib-dynamodb";
