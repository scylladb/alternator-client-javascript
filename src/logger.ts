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

import type { AlternatorLogger } from "./types.js";

export const noopLogger: Required<AlternatorLogger> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function normalizeLogger(logger: AlternatorLogger | undefined): Required<AlternatorLogger> {
  return {
    debug: logger?.debug?.bind(logger) ?? noopLogger.debug,
    info: logger?.info?.bind(logger) ?? noopLogger.info,
    warn: logger?.warn?.bind(logger) ?? noopLogger.warn,
    error: logger?.error?.bind(logger) ?? noopLogger.error,
  };
}
