import { AlternatorQueryPlan, firstNodeWithSeed } from "./query-plan.js";
import { murmur3H1 } from "./murmur.js";
import type {
  AlternatorKeyRouteAffinityMode,
  AlternatorLogger,
  AlternatorNode,
  NormalizedKeyRouteAffinityOptions,
} from "./types.js";

type AttributeValueRecord = Record<string, unknown>;
type DynamoDBInput = Record<string, unknown>;
type PartitionKeyDiscovery = (tableName: string) => void | Promise<void>;

const TYPE_PREFIX = {
  S: 0x01,
  N: 0x02,
  B: 0x03,
} as const;

export class KeyRouteAffinityPlanner {
  private readonly partitionKeys: Map<string, string>;
  private readonly inProgressDiscovery = new Set<string>();

  constructor(
    private readonly config: NormalizedKeyRouteAffinityOptions,
    private readonly discoverPartitionKey: PartitionKeyDiscovery,
    private readonly logger: AlternatorLogger,
  ) {
    this.partitionKeys = new Map(config.partitionKeys);
  }

  getPartitionKeyName(tableName: string): string | undefined {
    return this.partitionKeys.get(tableName);
  }

  setPartitionKeyName(tableName: string, keyName: string): void {
    if (tableName && keyName) {
      this.partitionKeys.set(tableName, keyName);
    }
  }

  queryPlanForInput(
    input: unknown,
    nodes: readonly AlternatorNode[],
    commandName?: string,
  ): AlternatorQueryPlan | undefined {
    if (!this.config.enabled || nodes.length === 0 || !isRecord(input)) {
      return undefined;
    }

    if (isBatchWriteCommand(commandName) && isBatchWriteInput(input) && this.config.mode === "any-write") {
      return this.batchWriteQueryPlan(input.RequestItems, nodes);
    }

    const hash = this.partitionKeyHashForInput(input, this.config.mode, commandName);
    if (hash === undefined) {
      return undefined;
    }
    return AlternatorQueryPlan.withSeed(nodes, hash);
  }

  private partitionKeyHashForInput(
    input: DynamoDBInput,
    affinityMode: AlternatorKeyRouteAffinityMode,
    commandName?: string,
  ): bigint | undefined {
    const request = writeRequestForInput(input, affinityMode, commandName);
    if (!request) {
      return undefined;
    }
    return this.hashPartitionKey(request.tableName, request.values);
  }

  private hashPartitionKey(tableName: string, values: AttributeValueRecord): bigint | undefined {
    const keyName = this.partitionKeys.get(tableName);
    if (!keyName) {
      this.triggerPartitionKeyDiscovery(tableName);
      this.logger.debug?.("alternator key affinity: partition key metadata missing", { tableName });
      return undefined;
    }

    const value = values[keyName];
    if (!isRecord(value)) {
      this.logger.debug?.("alternator key affinity: partition key value missing", { tableName, keyName });
      return undefined;
    }

    try {
      return hashAttributeValue(value);
    } catch (error) {
      this.logger.warn?.("alternator key affinity: unsupported partition key value", {
        tableName,
        keyName,
        error,
      });
      return undefined;
    }
  }

  private batchWriteQueryPlan(
    requestItems: Record<string, unknown>,
    nodes: readonly AlternatorNode[],
  ): AlternatorQueryPlan | undefined {
    const votes = new Map<string, { node: AlternatorNode; votes: number }>();

    for (const candidate of batchWriteRoutingCandidates(requestItems)) {
      const hash = this.hashPartitionKey(candidate.tableName, candidate.values);
      if (hash === undefined) {
        continue;
      }
      const node = firstNodeWithSeed(nodes, hash);
      if (!node) {
        continue;
      }
      const vote = votes.get(node.url);
      votes.set(node.url, {
        node,
        votes: (vote?.votes ?? 0) + 1,
      });
    }

    const preferred = selectPreferredNode(votes);
    if (!preferred) {
      return undefined;
    }

    return new AlternatorQueryPlan(nodes, [], preferred, true);
  }

  private triggerPartitionKeyDiscovery(tableName: string): void {
    if (!this.config.autoDiscoverPartitionKeys || this.inProgressDiscovery.has(tableName)) {
      return;
    }

    this.inProgressDiscovery.add(tableName);
    Promise.resolve(this.discoverPartitionKey(tableName))
      .catch((error: unknown) => {
        this.logger.warn?.("alternator key affinity: partition key discovery failed", {
          tableName,
          error,
        });
      })
      .finally(() => {
        this.inProgressDiscovery.delete(tableName);
      });
  }
}

export function hashAttributeValue(value: AttributeValueRecord): bigint {
  if (typeof value.S === "string") {
    return hashWithPrefix(TYPE_PREFIX.S, new TextEncoder().encode(value.S));
  }
  if (typeof value.N === "string") {
    return hashWithPrefix(TYPE_PREFIX.N, new TextEncoder().encode(value.N));
  }
  if (value.B instanceof Uint8Array) {
    return hashWithPrefix(TYPE_PREFIX.B, value.B);
  }
  if (typeof value.B === "string") {
    return hashWithPrefix(TYPE_PREFIX.B, new TextEncoder().encode(value.B));
  }
  throw new Error("only S, N, and B AttributeValue partition keys are supported");
}

function hashWithPrefix(prefix: number, bytes: Uint8Array): bigint {
  const prefixed = new Uint8Array(bytes.byteLength + 1);
  prefixed[0] = prefix;
  prefixed.set(bytes, 1);
  return murmur3H1(prefixed);
}

function writeRequestForInput(
  input: DynamoDBInput,
  affinityMode: AlternatorKeyRouteAffinityMode,
  commandName?: string,
): { tableName: string; values: AttributeValueRecord } | undefined {
  const tableName = typeof input.TableName === "string" ? input.TableName : undefined;
  if (!tableName) {
    return undefined;
  }

  if (isPutCommand(commandName) && isRecord(input.Item) && shouldRoutePut(input, affinityMode)) {
    return { tableName, values: input.Item };
  }
  if (isUpdateCommand(commandName) && isRecord(input.Key) && shouldRouteUpdate(input, affinityMode)) {
    return { tableName, values: input.Key };
  }
  if (isDeleteCommand(commandName) && isRecord(input.Key) && shouldRouteDelete(input, affinityMode)) {
    return { tableName, values: input.Key };
  }

  return undefined;
}

function shouldRoutePut(input: DynamoDBInput, affinityMode: AlternatorKeyRouteAffinityMode): boolean {
  if (!("Item" in input)) {
    return false;
  }
  if (affinityMode === "any-write") {
    return true;
  }
  return hasExpected(input) || nonEmptyString(input.ConditionExpression) || input.ReturnValues === "ALL_OLD";
}

function shouldRouteUpdate(input: DynamoDBInput, affinityMode: AlternatorKeyRouteAffinityMode): boolean {
  if (!("Key" in input) || !("UpdateExpression" in input || "AttributeUpdates" in input)) {
    return false;
  }
  if (affinityMode === "any-write") {
    return true;
  }

  if (nonEmptyString(input.UpdateExpression) || nonEmptyString(input.ConditionExpression) || hasExpected(input)) {
    return true;
  }

  if (input.ReturnValues !== undefined && input.ReturnValues !== "" && input.ReturnValues !== "NONE" && input.ReturnValues !== "UPDATED_NEW") {
    return true;
  }

  if (isRecord(input.AttributeUpdates)) {
    for (const update of Object.values(input.AttributeUpdates)) {
      if (!isRecord(update)) {
        continue;
      }
      if (update.Action === "ADD") {
        return true;
      }
      if (update.Action === "DELETE" && update.Value !== undefined) {
        return true;
      }
    }
  }

  return false;
}

function shouldRouteDelete(input: DynamoDBInput, affinityMode: AlternatorKeyRouteAffinityMode): boolean {
  if (!("Key" in input) || "UpdateExpression" in input || "AttributeUpdates" in input) {
    return false;
  }
  if (affinityMode === "any-write") {
    return true;
  }
  return hasExpected(input) || nonEmptyString(input.ConditionExpression) || input.ReturnValues === "ALL_OLD";
}

function hasExpected(input: DynamoDBInput): boolean {
  return isRecord(input.Expected) && Object.keys(input.Expected).length > 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isBatchWriteInput(input: DynamoDBInput): input is { RequestItems: Record<string, unknown> } {
  return isRecord(input.RequestItems);
}

function isPutCommand(commandName: string | undefined): boolean {
  return commandName === "PutItemCommand" || commandName === "PutCommand";
}

function isUpdateCommand(commandName: string | undefined): boolean {
  return commandName === "UpdateItemCommand" || commandName === "UpdateCommand";
}

function isDeleteCommand(commandName: string | undefined): boolean {
  return commandName === "DeleteItemCommand" || commandName === "DeleteCommand";
}

function isBatchWriteCommand(commandName: string | undefined): boolean {
  return commandName === "BatchWriteItemCommand" || commandName === "BatchWriteCommand";
}

function batchWriteRoutingCandidates(
  requestItems: Record<string, unknown>,
): Array<{ tableName: string; values: AttributeValueRecord }> {
  const candidates: Array<{ tableName: string; values: AttributeValueRecord }> = [];

  for (const [tableName, writes] of Object.entries(requestItems)) {
    if (!Array.isArray(writes)) {
      continue;
    }
    for (const write of writes) {
      if (!isRecord(write)) {
        continue;
      }
      if (isRecord(write.PutRequest) && isRecord(write.PutRequest.Item)) {
        candidates.push({ tableName, values: write.PutRequest.Item });
      }
      if (isRecord(write.DeleteRequest) && isRecord(write.DeleteRequest.Key)) {
        candidates.push({ tableName, values: write.DeleteRequest.Key });
      }
    }
  }

  return candidates;
}

function selectPreferredNode(votes: Map<string, { node: AlternatorNode; votes: number }>): AlternatorNode | undefined {
  let preferred: AlternatorNode | undefined;
  let preferredVotes = 0;
  let tied = false;

  for (const vote of votes.values()) {
    if (vote.votes > preferredVotes) {
      preferred = vote.node;
      preferredVotes = vote.votes;
      tied = false;
      continue;
    }
    if (vote.votes === preferredVotes) {
      tied = true;
    }
  }

  return preferredVotes > 0 && !tied ? preferred : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
