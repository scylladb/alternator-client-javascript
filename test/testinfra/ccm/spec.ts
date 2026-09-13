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

import { parse } from "yaml";

export enum AlternatorTransport {
  HTTP = "http",
  HTTPS = "https",
}

export enum AuthenticationMode {
  ALLOW_ALL = "allow_all",
  PASSWORD = "password",
  TRANSITIONAL = "transitional",
}

export enum AuthorizationMode {
  ALLOW_ALL = "allow_all",
  CASSANDRA = "cassandra",
  TRANSITIONAL = "transitional",
}

export class RackSpec {
  readonly nodeCount: number;

  constructor(nodeCount: number) {
    requirePositiveInteger(nodeCount, "A rack must contain at least one node");
    this.nodeCount = nodeCount;
    Object.freeze(this);
  }
}

export class DatacenterSpec {
  readonly racks: readonly RackSpec[];

  constructor(racks: readonly RackSpec[]) {
    requireNonEmptyArray(racks, "A datacenter must contain at least one rack");
    this.racks = Object.freeze(racks.map((rack) => new RackSpec(rack.nodeCount)));
    Object.freeze(this);
  }

  static create(...nodesPerRack: number[]): DatacenterSpec {
    return new DatacenterSpec(nodesPerRack.map((count) => new RackSpec(count)));
  }
}

export class ClusterTopology {
  readonly datacenters: readonly DatacenterSpec[];

  constructor(datacenters: readonly DatacenterSpec[]) {
    requireNonEmptyArray(datacenters, "A cluster must contain at least one datacenter");
    this.datacenters = Object.freeze(
      datacenters.map((datacenter) => new DatacenterSpec(datacenter.racks)),
    );
    Object.freeze(this);
  }

  static singleDatacenter(...nodesPerRack: number[]): ClusterTopology {
    return new ClusterTopology([DatacenterSpec.create(...nodesPerRack)]);
  }

  get nodeCount(): number {
    let count = 0;
    for (const datacenter of this.datacenters) {
      for (const rack of datacenter.racks) {
        count += rack.nodeCount;
        if (!Number.isSafeInteger(count)) {
          throw new Error("A cluster topology contains too many nodes");
        }
      }
    }
    return count;
  }
}

export class NodeResources {
  static readonly DEFAULT = new NodeResources(2, 1024);

  readonly smp: number;
  readonly memoryMiB: number;

  constructor(smp: number, memoryMiB: number) {
    requirePositiveInteger(smp, "Node SMP and memory must be positive integers");
    requirePositiveInteger(memoryMiB, "Node SMP and memory must be positive integers");
    this.smp = smp;
    this.memoryMiB = memoryMiB;
    Object.freeze(this);
  }
}

export class ClusterSecuritySpec {
  static readonly DISABLED = new ClusterSecuritySpec(
    AuthenticationMode.ALLOW_ALL,
    AuthorizationMode.ALLOW_ALL,
    false,
  );

  static readonly ENFORCED = new ClusterSecuritySpec(
    AuthenticationMode.PASSWORD,
    AuthorizationMode.CASSANDRA,
    true,
  );

  readonly authentication: AuthenticationMode;
  readonly authorization: AuthorizationMode;
  readonly enforceAlternatorAuthorization: boolean;

  constructor(
    authentication: AuthenticationMode,
    authorization: AuthorizationMode,
    enforceAlternatorAuthorization: boolean,
  ) {
    this.authentication = authentication;
    this.authorization = authorization;
    this.enforceAlternatorAuthorization = enforceAlternatorAuthorization;
    this.validate();
    Object.freeze(this);
  }

  validate(): void {
    if (!Object.values(AuthenticationMode).includes(this.authentication)) {
      throw new Error(`Unsupported authentication mode: ${String(this.authentication)}`);
    }
    if (!Object.values(AuthorizationMode).includes(this.authorization)) {
      throw new Error(`Unsupported authorization mode: ${String(this.authorization)}`);
    }
    if (typeof this.enforceAlternatorAuthorization !== "boolean") {
      throw new Error("Alternator authorization enforcement must be a boolean");
    }
    if (
      this.authentication === AuthenticationMode.ALLOW_ALL &&
      this.authorization !== AuthorizationMode.ALLOW_ALL
    ) {
      throw new Error("Allow-all authentication can only be used with allow-all authorization");
    }
    if (
      this.enforceAlternatorAuthorization &&
      (this.authentication !== AuthenticationMode.PASSWORD ||
        this.authorization !== AuthorizationMode.CASSANDRA)
    ) {
      throw new Error(
        "Alternator authorization enforcement requires password authentication and Cassandra authorization",
      );
    }
  }
}

export const MAXIMUM_NODE_COUNT = 9;
export const DEFAULT_SCYLLA_VERSION = "release:2025.2.5";

const YAML_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u;
// Complement of YAML 1.2's c-printable production. In Unicode mode, the surrogate ranges match
// unpaired UTF-16 code units without rejecting valid supplementary Unicode characters.
const YAML_NON_PRINTABLE_PATTERN =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const YAML_KEY_ALIASES = new Map([
  ["cql_port", "native_transport_port"],
  ["datadir", "data_file_directories"],
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_YAML_KEYS = new Set([
  "alternator_address",
  "alternator_encryption_options",
  "alternator_enforce_authorization",
  "alternator_https_port",
  "alternator_port",
  "alternator_write_isolation",
  "api_address",
  "api_port",
  "auth_superuser_name",
  "auth_superuser_salted_password",
  "authenticator",
  "auto_bootstrap",
  "authorizer",
  "broadcast_address",
  "broadcast_rpc_address",
  "cluster_name",
  "commitlog_directory",
  "commitlog_use_o_dsync",
  "data_file_directories",
  "default_log_level",
  "developer_mode",
  "endpoint_snitch",
  "hints_directory",
  "ignore_dead_nodes_for_replace",
  "initial_token",
  "join_ring",
  "listen_address",
  "listen_interface",
  "listen_interface_prefer_ipv6",
  "listen_on_broadcast_address",
  "load_ring_state",
  "log_to_stdout",
  "maintenance_mode",
  "maintenance_socket",
  "maintenance_socket_group",
  "memory",
  "native_shard_aware_transport_port",
  "native_shard_aware_transport_port_proxy_protocol",
  "native_shard_aware_transport_port_ssl",
  "native_shard_aware_transport_port_ssl_proxy_protocol",
  "native_transport_port",
  "native_transport_port_ssl",
  "num_tokens",
  "partitioner",
  "prometheus_address",
  "prometheus_port",
  "redis_port",
  "redis_ssl_port",
  "replace_address",
  "replace_address_first_boot",
  "replace_node_first_boot",
  "role_manager",
  "rpc_address",
  "rpc_interface",
  "rpc_interface_prefer_ipv6",
  "rpc_port",
  "saved_caches_directory",
  "schema_commitlog_directory",
  "seeds",
  "seed_provider",
  "server_encryption_options",
  "smp",
  "ssl_storage_port",
  "start_native_transport",
  "storage_port",
  "view_hints_directory",
  "workdir",
]);

interface ClusterSpecValues {
  readonly scyllaVersion: string;
  readonly topology: ClusterTopology;
  readonly transports: readonly AlternatorTransport[];
  readonly security: ClusterSecuritySpec;
  readonly resources: NodeResources;
  readonly yamlOverrides: ReadonlyMap<string, string>;
}

export class ClusterSpec {
  readonly scyllaVersion: string;
  readonly topology: ClusterTopology;
  readonly transports: readonly AlternatorTransport[];
  readonly security: ClusterSecuritySpec;
  readonly resources: NodeResources;
  private readonly yamlOverridesValue: ReadonlyMap<string, string>;

  constructor(values: Partial<ClusterSpecValues> = {}) {
    this.scyllaVersion = values.scyllaVersion ?? DEFAULT_SCYLLA_VERSION;
    this.topology =
      values.topology === undefined
        ? ClusterTopology.singleDatacenter(3)
        : new ClusterTopology(values.topology.datacenters);
    this.transports = Object.freeze(
      canonicalTransports(values.transports ?? [AlternatorTransport.HTTP, AlternatorTransport.HTTPS]),
    );
    this.security =
      values.security === undefined
        ? ClusterSecuritySpec.DISABLED
        : new ClusterSecuritySpec(
            values.security.authentication,
            values.security.authorization,
            values.security.enforceAlternatorAuthorization,
          );
    this.resources =
      values.resources === undefined
        ? NodeResources.DEFAULT
        : new NodeResources(values.resources.smp, values.resources.memoryMiB);
    this.yamlOverridesValue = canonicalYamlOverrides(values.yamlOverrides ?? new Map());
    this.validate();
    Object.freeze(this);
  }

  withScyllaVersion(value: string): ClusterSpec {
    return this.copy({ scyllaVersion: value });
  }

  withTopology(value: ClusterTopology): ClusterSpec {
    return this.copy({ topology: value });
  }

  withTransports(...values: AlternatorTransport[]): ClusterSpec {
    if (values.length === 0) {
      throw new Error("At least one Alternator transport is required");
    }
    return this.copy({ transports: values });
  }

  withSecurity(value: ClusterSecuritySpec): ClusterSpec {
    return this.copy({ security: value });
  }

  withResources(value: NodeResources): ClusterSpec {
    return this.copy({ resources: value });
  }

  withYamlOverride(key: string, yamlValue: string): ClusterSpec {
    const overrides = new Map(this.yamlOverrides);
    overrides.set(canonicalYamlKey(key), yamlValue);
    return this.copy({ yamlOverrides: overrides });
  }

  get yamlOverrides(): ReadonlyMap<string, string> {
    return new Map(this.yamlOverridesValue);
  }

  hasTransport(transport: AlternatorTransport): boolean {
    return this.transports.includes(transport);
  }

  reuseKey(): string {
    return JSON.stringify({
      scyllaVersion: this.scyllaVersion,
      transports: this.transports,
      security: {
        authentication: this.security.authentication,
        authorization: this.security.authorization,
        enforceAlternatorAuthorization: this.security.enforceAlternatorAuthorization,
      },
      resources: { smp: this.resources.smp, memoryMiB: this.resources.memoryMiB },
      topology: this.topology.datacenters.map((datacenter) =>
        datacenter.racks.map((rack) => rack.nodeCount),
      ),
      yamlOverrides: [...this.yamlOverrides],
    });
  }

  validate(): void {
    if (typeof this.scyllaVersion !== "string" || this.scyllaVersion.trim() === "") {
      throw new Error("A Scylla version is required");
    }
    if (this.transports.length === 0) {
      throw new Error("At least one Alternator transport is required");
    }
    if (this.topology.nodeCount > MAXIMUM_NODE_COUNT) {
      throw new Error(`A cluster cannot exceed ${MAXIMUM_NODE_COUNT} nodes`);
    }
    this.security.validate();

    const parsed = new Map<string, unknown>();
    for (const [key, value] of this.yamlOverrides) {
      if (value.trim() === "") {
        throw new Error("Scylla YAML override keys and values cannot be empty");
      }
      try {
        parsed.set(key, parseYamlValue(value));
      } catch (error) {
        throw new Error(`Scylla YAML override '${key}' has an invalid YAML value`, {
          cause: error,
        });
      }
    }
    for (const key of parsed.keys()) {
      const separator = key.indexOf(".");
      if (separator < 0) {
        continue;
      }
      const root = key.slice(0, separator);
      const rootValue = parsed.get(root);
      if (parsed.has(root) && !isPlainMapping(rootValue)) {
        throw new Error(
          `Scylla YAML override '${root}' must be a mapping when overriding '${key}'`,
        );
      }
    }
  }

  private copy(overrides: Partial<ClusterSpecValues>): ClusterSpec {
    return new ClusterSpec({
      scyllaVersion: overrides.scyllaVersion ?? this.scyllaVersion,
      topology: overrides.topology ?? this.topology,
      transports: overrides.transports ?? this.transports,
      security: overrides.security ?? this.security,
      resources: overrides.resources ?? this.resources,
      yamlOverrides: overrides.yamlOverrides ?? this.yamlOverrides,
    });
  }
}

export function defaultClusterSpec(environment: NodeJS.ProcessEnv = process.env): ClusterSpec {
  return new ClusterSpec().withScyllaVersion(
    environment.SCYLLA_VERSION?.trim() || DEFAULT_SCYLLA_VERSION,
  );
}

export class ClusterSpecs {
  private constructor() {}

  static defaultSpec(environment: NodeJS.ProcessEnv = process.env): ClusterSpec {
    return defaultClusterSpec(environment);
  }
}

export function parseYamlValue(value: string): unknown {
  if (YAML_NON_PRINTABLE_PATTERN.test(value)) {
    throw new Error("A YAML value cannot contain non-printable characters");
  }
  return parse(value, { schema: "core", uniqueKeys: true });
}

function canonicalTransports(values: readonly AlternatorTransport[]): AlternatorTransport[] {
  const selected = new Set(values);
  if (selected.size === 0) {
    throw new Error("At least one Alternator transport is required");
  }
  for (const value of selected) {
    if (!Object.values(AlternatorTransport).includes(value)) {
      throw new Error(`Unsupported Alternator transport: ${String(value)}`);
    }
  }
  return [...selected].sort();
}

function canonicalYamlOverrides(overrides: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const entries = [...overrides].map(([key, value]) => [canonicalYamlKey(key), value] as const);
  entries.sort(([left], [right]) => compareAscii(left, right));
  const canonical = new Map<string, string>();
  for (const [key, value] of entries) {
    if (canonical.has(key)) {
      throw new Error(
        `Scylla YAML override key '${key}' is supplied more than once after canonicalization`,
      );
    }
    canonical.set(key, value);
  }
  return canonical;
}

function canonicalYamlKey(key: string): string {
  if (/[\x00-\x1F\x7F-\x9F]/u.test(key)) {
    throw new Error("Scylla YAML override keys cannot contain controls");
  }
  const canonical = key.trim();
  if (!YAML_KEY_PATTERN.test(canonical)) {
    throw new Error("A Scylla YAML override key must contain one or two ASCII identifier segments");
  }
  const separator = canonical.indexOf(".");
  const suppliedRoot = separator < 0 ? canonical : canonical.slice(0, separator);
  const root = YAML_KEY_ALIASES.get(suppliedRoot) ?? suppliedRoot;
  if (UNSAFE_OBJECT_KEYS.has(root)) {
    throw new Error(`Scylla YAML key '${root}' is unsafe in JavaScript mappings`);
  }
  if (RESERVED_YAML_KEYS.has(root)) {
    throw new Error(`Scylla YAML key '${root}' is owned by a typed cluster option`);
  }
  return separator < 0 ? root : root + canonical.slice(separator);
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(message);
  }
}

function requireNonEmptyArray(value: readonly unknown[], message: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
