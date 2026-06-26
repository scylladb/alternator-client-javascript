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
  constructor(config: AlternatorDynamoDBClientConfig, translateConfig?: TranslateConfig);
  constructor(configOrClient: AlternatorDynamoDBClientConfig | DynamoDBClient, translateConfig?: TranslateConfig) {
    const client =
      configOrClient instanceof DynamoDBClient
        ? configOrClient
        : new AlternatorDynamoDBClient(configOrClient);
    super(client, translateConfig);
  }

  static override from(
    client: DynamoDBClient,
    translateConfig?: TranslateConfig,
  ): AlternatorDynamoDBDocumentClient {
    const InternalDocumentClient =
      AlternatorDynamoDBDocumentClient as unknown as InternalDocumentClientConstructor;
    return new InternalDocumentClient(client, translateConfig);
  }
}

export type { TranslateConfig } from "@aws-sdk/lib-dynamodb";
export * from "@aws-sdk/lib-dynamodb";
