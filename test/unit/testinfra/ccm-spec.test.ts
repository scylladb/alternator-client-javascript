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

import { describe, expect, it } from "vitest";
import {
  AlternatorTransport,
  AuthenticationMode,
  AuthorizationMode,
  ClusterSecuritySpec,
  ClusterSpec,
  ClusterTopology,
  DatacenterSpec,
  DEFAULT_SCYLLA_VERSION,
  defaultClusterSpec,
  MAXIMUM_NODE_COUNT,
  NodeResources,
  parseYamlValue,
  RackSpec,
} from "../../testinfra/ccm/spec.js";

describe("CCM-REQ-001 typed cluster specification", () => {
  it("uses the normative default cluster shape", () => {
    const spec = new ClusterSpec();

    expect(spec.scyllaVersion).toBe("release:2025.2.5");
    expect(spec.scyllaVersion).toBe(DEFAULT_SCYLLA_VERSION);
    expect(spec.topology.nodeCount).toBe(3);
    expect(spec.topology.datacenters).toHaveLength(1);
    expect(spec.topology.datacenters[0]?.racks).toHaveLength(1);
    expect(spec.topology.datacenters[0]?.racks[0]?.nodeCount).toBe(3);
    expect(spec.transports).toEqual([
      AlternatorTransport.HTTP,
      AlternatorTransport.HTTPS,
    ]);
    expect(spec.security).toBe(ClusterSecuritySpec.DISABLED);
    expect(spec.resources).toBe(NodeResources.DEFAULT);
    expect(spec.resources).toMatchObject({ smp: 2, memoryMiB: 1024 });
    expect([...spec.yamlOverrides]).toEqual([]);
  });

  it("selects the default version from the environment without retaining padding", () => {
    expect(defaultClusterSpec({ SCYLLA_VERSION: "  release:2026.1.0  " }).scyllaVersion).toBe(
      "release:2026.1.0",
    );
    expect(defaultClusterSpec({ SCYLLA_VERSION: "\u2003\u00a0" }).scyllaVersion).toBe(
      DEFAULT_SCYLLA_VERSION,
    );
    expect(defaultClusterSpec({}).scyllaVersion).toBe(DEFAULT_SCYLLA_VERSION);
  });

  it("rejects non-string runtime versions", () => {
    expect(() => new ClusterSpec({ scyllaVersion: 2025 as unknown as string })).toThrow(
      /Scylla version is required/u,
    );
  });

  it("defensively copies constructor inputs and freezes structural values", () => {
    const racks = [new RackSpec(1)];
    const datacenter = new DatacenterSpec(racks);
    racks.push(new RackSpec(8));

    const datacenters = [datacenter];
    const topology = new ClusterTopology(datacenters);
    datacenters.push(DatacenterSpec.create(8));

    const transports = [AlternatorTransport.HTTPS];
    const yamlOverrides = new Map([["custom_option", "true"]]);
    const spec = new ClusterSpec({ topology, transports, yamlOverrides });
    transports.push(AlternatorTransport.HTTP);
    yamlOverrides.set("another_option", "false");

    expect(spec.topology.nodeCount).toBe(1);
    expect(spec.transports).toEqual([AlternatorTransport.HTTPS]);
    expect([...spec.yamlOverrides]).toEqual([["custom_option", "true"]]);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.topology)).toBe(true);
    expect(Object.isFrozen(spec.topology.datacenters)).toBe(true);
    expect(Object.isFrozen(spec.topology.datacenters[0]?.racks)).toBe(true);
    expect(Object.isFrozen(spec.transports)).toBe(true);
  });

  it("copy methods do not mutate the source specification", () => {
    const original = new ClusterSpec();
    const changed = original
      .withScyllaVersion("release:2026.1")
      .withTopology(ClusterTopology.singleDatacenter(1, 2))
      .withTransports(AlternatorTransport.HTTPS)
      .withSecurity(ClusterSecuritySpec.ENFORCED)
      .withResources(new NodeResources(1, 512))
      .withYamlOverride("custom_option", "true");

    expect(changed).not.toBe(original);
    expect(original).toEqual(new ClusterSpec());
    expect(changed).toMatchObject({
      scyllaVersion: "release:2026.1",
      transports: [AlternatorTransport.HTTPS],
      security: ClusterSecuritySpec.ENFORCED,
      resources: { smp: 1, memoryMiB: 512 },
    });
    expect(changed.topology.nodeCount).toBe(3);
    expect([...changed.yamlOverrides]).toEqual([["custom_option", "true"]]);
  });

  it("does not expose mutable YAML override state", () => {
    const spec = new ClusterSpec().withYamlOverride("custom_option", "true");
    const exposed = spec.yamlOverrides as Map<string, string>;

    exposed.set("injected_option", "false");

    expect([...spec.yamlOverrides]).toEqual([["custom_option", "true"]]);
  });

  it("validates every authentication and authorization combination", () => {
    const valid = new Set([
      "false|allow_all|allow_all",
      "false|password|allow_all",
      "false|password|cassandra",
      "false|password|transitional",
      "false|transitional|allow_all",
      "false|transitional|cassandra",
      "false|transitional|transitional",
      "true|password|cassandra",
    ]);

    for (const enforced of [false, true]) {
      for (const authentication of Object.values(AuthenticationMode)) {
        for (const authorization of Object.values(AuthorizationMode)) {
          const key = `${String(enforced)}|${authentication}|${authorization}`;
          const construct = () =>
            new ClusterSecuritySpec(authentication, authorization, enforced);

          if (valid.has(key)) {
            expect(construct).not.toThrow();
            expect(construct()).toMatchObject({
              authentication,
              authorization,
              enforceAlternatorAuthorization: enforced,
            });
          } else {
            expect(construct).toThrow();
          }
        }
      }
    }
  });

  it("rejects unsupported runtime security values", () => {
    expect(
      () =>
        new ClusterSecuritySpec(
          "ldap" as AuthenticationMode,
          AuthorizationMode.ALLOW_ALL,
          false,
        ),
    ).toThrow(/Unsupported authentication mode: ldap/u);
    expect(
      () =>
        new ClusterSecuritySpec(
          AuthenticationMode.PASSWORD,
          "ldap" as AuthorizationMode,
          false,
        ),
    ).toThrow(/Unsupported authorization mode: ldap/u);
    expect(
      () =>
        new ClusterSecuritySpec(
          AuthenticationMode.PASSWORD,
          AuthorizationMode.CASSANDRA,
          "false" as unknown as boolean,
        ),
    ).toThrow(/must be a boolean/u);
  });

  it("validates topology and node resource limits", () => {
    expect(() => new RackSpec(0)).toThrow(/at least one node/u);
    expect(() => new RackSpec(-1)).toThrow(/at least one node/u);
    expect(() => new RackSpec(1.5)).toThrow(/at least one node/u);
    expect(() => new RackSpec(Number.POSITIVE_INFINITY)).toThrow(/at least one node/u);
    expect(() => new DatacenterSpec([])).toThrow(/at least one rack/u);
    expect(() => new ClusterTopology([])).toThrow(/at least one datacenter/u);
    expect(() => new NodeResources(0, 1024)).toThrow(/positive integers/u);
    expect(() => new NodeResources(2, 0)).toThrow(/positive integers/u);
    expect(() => new NodeResources(1.5, 1024)).toThrow(/positive integers/u);

    const maximum = new ClusterSpec().withTopology(
      new ClusterTopology([DatacenterSpec.create(2, 3), DatacenterSpec.create(4)]),
    );
    expect(maximum.topology.nodeCount).toBe(MAXIMUM_NODE_COUNT);
    expect(() =>
      new ClusterSpec().withTopology(ClusterTopology.singleDatacenter(MAXIMUM_NODE_COUNT + 1)),
    ).toThrow(/cannot exceed 9 nodes/u);

    const overflowing = ClusterTopology.singleDatacenter(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => overflowing.nodeCount).toThrow(/too many nodes/u);
  });

  it("normalizes structurally typed topology and resource values", () => {
    const rack = { nodeCount: 1 };
    const racks = [rack];
    const datacenter: DatacenterSpec = { racks };
    const datacenters = [datacenter];
    const topology: ClusterTopology = { datacenters, nodeCount: 1 };
    const resources = { smp: 1, memoryMiB: 512 };
    const security: {
      authentication: AuthenticationMode;
      authorization: AuthorizationMode;
      enforceAlternatorAuthorization: boolean;
      validate(): void;
    } = {
      authentication: AuthenticationMode.PASSWORD,
      authorization: AuthorizationMode.CASSANDRA,
      enforceAlternatorAuthorization: true,
      validate: () => undefined,
    };

    const spec = new ClusterSpec({ topology, resources, security });
    rack.nodeCount = 8;
    racks.push({ nodeCount: 8 });
    datacenters.push({ racks: [{ nodeCount: 8 }] });
    resources.smp = 8;
    resources.memoryMiB = 8192;
    security.authentication = AuthenticationMode.ALLOW_ALL;
    security.authorization = AuthorizationMode.ALLOW_ALL;
    security.enforceAlternatorAuthorization = false;

    expect(spec.topology.nodeCount).toBe(1);
    expect(spec.resources).toEqual({ smp: 1, memoryMiB: 512 });
    expect(spec.security).toEqual(ClusterSecuritySpec.ENFORCED);
    expect(Object.isFrozen(spec.topology.datacenters[0])).toBe(true);
    expect(Object.isFrozen(spec.topology.datacenters[0]?.racks[0])).toBe(true);
    expect(Object.isFrozen(spec.resources)).toBe(true);
  });

  it("validates structurally typed topology children and resources", () => {
    expect(() => new DatacenterSpec([{ nodeCount: 0 }])).toThrow(/at least one node/u);
    expect(() => new ClusterTopology([{ racks: [] }])).toThrow(/at least one rack/u);
    expect(() =>
      new ClusterTopology([{ racks: [{ nodeCount: 10 }, { nodeCount: -1 }] }]),
    ).toThrow(/at least one node/u);

    const understatedTopology: ClusterTopology = {
      datacenters: [{ racks: [{ nodeCount: MAXIMUM_NODE_COUNT + 1 }] }],
      nodeCount: 1,
    };
    expect(() => new ClusterSpec({ topology: understatedTopology })).toThrow(
      /cannot exceed 9 nodes/u,
    );
    expect(() => new ClusterSpec({ resources: { smp: 0, memoryMiB: -1 } })).toThrow(
      /positive integers/u,
    );
  });

  it("validates and canonicalizes transports", () => {
    expect(() => new ClusterSpec().withTransports()).toThrow(/At least one/u);
    expect(
      new ClusterSpec().withTransports(
        AlternatorTransport.HTTPS,
        AlternatorTransport.HTTP,
        AlternatorTransport.HTTPS,
      ).transports,
    ).toEqual([AlternatorTransport.HTTP, AlternatorTransport.HTTPS]);
    expect(() =>
      new ClusterSpec({ transports: ["smtp" as AlternatorTransport] }),
    ).toThrow(/Unsupported Alternator transport/u);
  });

  it("derives deterministic reuse keys from canonical transport and map order", () => {
    const first = new ClusterSpec({
      transports: [AlternatorTransport.HTTPS, AlternatorTransport.HTTP],
      yamlOverrides: new Map([
        ["z_option", "false"],
        ["a_option", "true"],
      ]),
    });
    const second = new ClusterSpec({
      transports: [AlternatorTransport.HTTP, AlternatorTransport.HTTPS],
      yamlOverrides: new Map([
        ["a_option", "true"],
        ["z_option", "false"],
      ]),
    });

    expect(first.reuseKey()).toBe(second.reuseKey());
  });

  it("rejects YAML override keys that collide after canonicalization", () => {
    for (const keys of [
      [" custom_option ", "custom_option"],
      ["custom_option", " custom_option "],
    ] as const) {
      expect(
        () =>
          new ClusterSpec({
            yamlOverrides: new Map([
              [keys[0], "first"],
              [keys[1], "second"],
            ]),
          }),
      ).toThrow(/supplied more than once after canonicalization/u);
    }
  });

  it("includes every physical-cluster setting in the reuse key", () => {
    const baseline = new ClusterSpec();
    const variants = [
      baseline.withScyllaVersion("release:2026.1"),
      baseline.withTopology(ClusterTopology.singleDatacenter(2, 1)),
      baseline.withTransports(AlternatorTransport.HTTP),
      baseline.withSecurity(
        new ClusterSecuritySpec(
          AuthenticationMode.PASSWORD,
          AuthorizationMode.ALLOW_ALL,
          false,
        ),
      ),
      baseline.withResources(new NodeResources(1, 1024)),
      baseline.withYamlOverride("custom_option", "true"),
    ];

    for (const variant of variants) {
      expect(variant.reuseKey()).not.toBe(baseline.reuseKey());
    }
  });

  it("canonicalizes surrounding Unicode whitespace and replacement keys", () => {
    const spec = new ClusterSpec()
      .withYamlOverride("custom_option", "first")
      .withYamlOverride("\u2003\u00a0custom_option\u3000", "second");
    const canonical = new ClusterSpec().withYamlOverride("custom_option", "second");

    expect([...spec.yamlOverrides]).toEqual([["custom_option", "second"]]);
    expect(spec.reuseKey()).toBe(canonical.reuseKey());
  });

  it.each([
    ["cql_port", "native_transport_port"],
    ["datadir", "data_file_directories"],
    ["cql_port.child", "native_transport_port"],
    ["datadir.child", "data_file_directories"],
  ])("does not let alias %s bypass reserved root %s", (alias, canonical) => {
    expect(() => new ClusterSpec().withYamlOverride(alias, "false")).toThrow(
      new RegExp(`'${canonical}'`, "u"),
    );
  });

  it.each([
    "alternator_address",
    "\u00a0alternator_enforce_authorization\u2003",
    "alternator_encryption_options.enabled",
    "api_address",
    "api_port",
    "authenticator",
    "authorizer",
    "auto_bootstrap",
    "data_file_directories",
    "endpoint_snitch",
    "initial_token",
    "listen_address",
    "native_transport_port",
    "num_tokens",
    "seeds",
    "server_encryption_options",
    "smp",
    "memory",
    "storage_port",
    "workdir",
  ])("rejects YAML key owned by typed options: %s", (key) => {
    expect(() => new ClusterSpec().withYamlOverride(key, "false")).toThrow(
      /owned by a typed cluster option/u,
    );
  });

  it.each([
    "",
    " ",
    "\u200b",
    ".option",
    "option.",
    "parent..child",
    "parent.child.grandchild",
    "option:value",
    "option\ninjected",
    "\toption",
    "option-name",
    "option name",
    "na\u00efve",
    "1option",
    "option\u0000injected",
  ])("rejects unsafe or unsupported YAML key %j", (key) => {
    expect(() => new ClusterSpec().withYamlOverride(key, "true")).toThrow();
  });

  it.each(["__proto__", "constructor.child", "prototype"])(
    "rejects JavaScript prototype key %s",
    (key) => {
      expect(() => new ClusterSpec().withYamlOverride(key, "true")).toThrow(/unsafe/u);
    },
  );

  it.each(["__proto__", "constructor.child", "prototype"])(
    "rejects JavaScript prototype key %s",
    (key) => {
      expect(() => new ClusterSpec().withYamlOverride(key, "true")).toThrow(/unsafe/u);
    },
  );

  it("accepts safe top-level and nested YAML keys", () => {
    const spec = new ClusterSpec()
      .withYamlOverride("_custom2", "true")
      .withYamlOverride("custom_group.child_2", "42");

    expect([...spec.yamlOverrides]).toEqual([
      ["_custom2", "true"],
      ["custom_group.child_2", "42"],
    ]);
  });

  it.each([
    ["U+0000", "\u0000"],
    ["U+0008", "\u0008"],
    ["U+000B", "\u000b"],
    ["U+000C", "\u000c"],
    ["U+000E", "\u000e"],
    ["U+001F", "\u001f"],
    ["U+007F", "\u007f"],
    ["U+0084", "\u0084"],
    ["U+0086", "\u0086"],
    ["U+009F", "\u009f"],
    ["unpaired U+D800", "\ud800"],
    ["unpaired U+DFFF", "\udfff"],
    ["U+FFFE", "\ufffe"],
    ["U+FFFF", "\uffff"],
  ])("rejects YAML-non-printable character %s", (_name, character) => {
    expect(() =>
      new ClusterSpec().withYamlOverride("custom_option", `a${character}b`),
    ).toThrow(/invalid YAML value/u);
  });

  it.each([
    ["tab", "\u0009"],
    ["line feed", "\u000a"],
    ["carriage return", "\u000d"],
    ["next line", "\u0085"],
    ["supplementary Unicode character", "\ud83d\ude00"],
  ])("accepts YAML-printable %s characters", (_name, character) => {
    expect(() =>
      new ClusterSpec().withYamlOverride("custom_option", `a${character}b`),
    ).not.toThrow();
  });

  it.each(["[", "{key: value", "'unterminated", "a: 1\na: 2"])(
    "rejects invalid YAML value %j",
    (value) => {
      expect(() => new ClusterSpec().withYamlOverride("custom_option", value)).toThrow(
        /invalid YAML value/u,
      );
    },
  );

  it("parses supported YAML 1.2 core values", () => {
    expect(parseYamlValue("null")).toBeNull();
    expect(parseYamlValue("true")).toBe(true);
    expect(parseYamlValue("42")).toBe(42);
    expect(parseYamlValue("[one, two]")).toEqual(["one", "two"]);
    expect(parseYamlValue("{one: 1, two: false}")).toEqual({ one: 1, two: false });

    expect(() =>
      new ClusterSpec()
        .withYamlOverride("custom_null", "null")
        .withYamlOverride("custom_list", "[one, two]")
        .withYamlOverride("custom_mapping", "{one: 1, two: false}"),
    ).not.toThrow();
    expect(() =>
      new ClusterSpec().withYamlOverride("custom_option", "\u2003\u00a0"),
    ).toThrow(/cannot be empty/u);
  });

  it("rejects a nested override below a scalar root in either insertion order", () => {
    expect(() =>
      new ClusterSpec()
        .withYamlOverride("custom_group", "5")
        .withYamlOverride("custom_group.child", "42"),
    ).toThrow(/must be a mapping/u);
    expect(() =>
      new ClusterSpec()
        .withYamlOverride("custom_group.child", "42")
        .withYamlOverride("custom_group", "false"),
    ).toThrow(/must be a mapping/u);
    expect(() =>
      new ClusterSpec()
        .withYamlOverride("custom_group", "{existing: true}")
        .withYamlOverride("custom_group.child", "42"),
    ).not.toThrow();
  });

  it("keeps reuse identity delimiter-safe", () => {
    const first = new ClusterSpec().withScyllaVersion(
      "X|[http,https]|allow_all|allow_all|false|2|1024|dc:3|yaml:logger_log_level=info # ",
    );
    const second = new ClusterSpec()
      .withScyllaVersion("X")
      .withYamlOverride(
        "logger_log_level",
        "info # |[http,https]|allow_all|allow_all|false|2|1024|dc:3",
      );

    expect(first.reuseKey()).not.toBe(second.reuseKey());
    expect(JSON.parse(first.reuseKey())).toMatchObject({ scyllaVersion: first.scyllaVersion });
  });
});
