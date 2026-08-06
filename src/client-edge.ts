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
