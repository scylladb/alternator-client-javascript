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

export { AlternatorDynamoDBClient } from "./client.js";
export { routing } from "./routing.js";
export type { AlternatorDynamoDBClientApi } from "./client.js";
export type {
  AlternatorCompressionOptions,
  AlternatorConnectionOptions,
  AlternatorConnectionTimeoutOptions,
  AlternatorDiscoveryOptions,
  AlternatorDynamoDBClientConfig,
  AlternatorEdgeConnectionOptions,
  AlternatorEdgeDynamoDBClientConfig,
  AlternatorHeaderOptimizationOptions,
  AlternatorKeyRouteAffinityConfig,
  AlternatorKeyRouteAffinityMode,
  AlternatorKeyRouteAffinityOptions,
  AlternatorLogger,
  AlternatorNodeConnectionOptions,
  AlternatorNodeDynamoDBClientConfig,
  AlternatorNode,
  AlternatorPartitionKeyByTable,
  AlternatorRequestCompressionConfig,
  AlternatorRequestCompressionOptions,
  AlternatorResponseCompressionAlgorithm,
  AlternatorResponseCompressionConfig,
  AlternatorResponseCompressionOptions,
  AlternatorRuntime,
  AlternatorScheme,
  AlternatorRequestCompressor,
  AlternatorRequestCompressorResult,
  AlternatorTlsOptions,
  AlternatorTlsMaterial,
  AlternatorUserAgentConfig,
  AlternatorUserAgentOptions,
  AlternatorUserAgentTransformer,
  NonEmptyReadonlyArray,
} from "./types.js";
export type {
  AlternatorClusterRoutingScope,
  AlternatorDatacenterRoutingScope,
  AlternatorDatacenterRoutingScopeOptions,
  AlternatorRackRoutingScope,
  AlternatorRackRoutingScopeOptions,
  AlternatorRoutingFallbackOptions,
  AlternatorRoutingScope,
  AlternatorRoutingScopeKind,
} from "./routing.js";
