import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  type TranslateConfig,
} from "@aws-sdk/lib-dynamodb";
import { AlternatorDynamoDBClient } from "./client.js";
import type { AlternatorDynamoDBClientConfig } from "./types.js";

export class AlternatorDynamoDBDocumentClient extends DynamoDBDocumentClient {
  private constructor(
    client: DynamoDBClient,
    translateConfig?: TranslateConfig,
    private readonly ownedClient?: AlternatorDynamoDBClient,
  ) {
    super(client, translateConfig);
  }

  static override from(
    client: DynamoDBClient,
    translateConfig?: TranslateConfig,
  ): AlternatorDynamoDBDocumentClient {
    return new AlternatorDynamoDBDocumentClient(client, translateConfig);
  }

  static fromConfig(
    config: AlternatorDynamoDBClientConfig,
    translateConfig?: TranslateConfig,
  ): AlternatorDynamoDBDocumentClient {
    const client = new AlternatorDynamoDBClient(config);
    return new AlternatorDynamoDBDocumentClient(client, translateConfig, client);
  }

  override destroy(): void {
    this.ownedClient?.destroy();
    super.destroy();
  }
}

export type { TranslateConfig } from "@aws-sdk/lib-dynamodb";
export * from "@aws-sdk/lib-dynamodb";
