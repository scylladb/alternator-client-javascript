import { AlternatorDynamoDBClientBase } from "./client-base.js";
import { edgeRuntimePlatform } from "./runtime-edge.js";
import type { AlternatorDynamoDBClientConfig } from "./types.js";

export class AlternatorDynamoDBClient extends AlternatorDynamoDBClientBase {
  constructor(config: AlternatorDynamoDBClientConfig) {
    super(config, edgeRuntimePlatform);
  }
}

export type {
  AlternatorDynamoDBClientApi,
  AlternatorRequestHandler,
} from "./client-base.js";
