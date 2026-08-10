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

export type AlternatorRoutingScopeKind = "cluster" | "datacenter" | "rack";

export interface AlternatorRoutingFallbackOptions {
  fallback?: AlternatorRoutingScope;
}

export interface AlternatorClusterRoutingScope {
  readonly kind: "cluster";
}

export interface AlternatorDatacenterRoutingScope {
  readonly kind: "datacenter";
  readonly datacenter: string;
  readonly fallback?: AlternatorRoutingScope;
}

export interface AlternatorRackRoutingScope {
  readonly kind: "rack";
  readonly datacenter: string;
  readonly rack: string;
  readonly fallback?: AlternatorRoutingScope;
}

export type AlternatorRoutingScope =
  | AlternatorClusterRoutingScope
  | AlternatorDatacenterRoutingScope
  | AlternatorRackRoutingScope;

export interface AlternatorDatacenterRoutingScopeOptions extends AlternatorRoutingFallbackOptions {
  readonly datacenter: string;
}

export interface AlternatorRackRoutingScopeOptions extends AlternatorRoutingFallbackOptions {
  readonly datacenter: string;
  readonly rack: string;
}

export interface LocalNodesQuery {
  readonly dc?: string;
  readonly rack?: string;
}

function assertName(name: string, label: string): void {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function cluster(): AlternatorClusterRoutingScope {
  return { kind: "cluster" };
}

function datacenter(options: AlternatorDatacenterRoutingScopeOptions): AlternatorDatacenterRoutingScope {
  assertName(options.datacenter, "datacenter");
  return {
    kind: "datacenter",
    datacenter: options.datacenter,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

function rack(options: AlternatorRackRoutingScopeOptions): AlternatorRackRoutingScope {
  assertName(options.datacenter, "datacenter");
  assertName(options.rack, "rack");
  return {
    kind: "rack",
    datacenter: options.datacenter,
    rack: options.rack,
    ...(options.fallback ? { fallback: options.fallback } : {}),
  };
}

export const routing = {
  cluster,
  datacenter,
  rack,
};

export function routingChain(scope: AlternatorRoutingScope): AlternatorRoutingScope[] {
  const fallback = "fallback" in scope ? scope.fallback : undefined;
  return fallback ? [scope, ...routingChain(fallback)] : [scope];
}
