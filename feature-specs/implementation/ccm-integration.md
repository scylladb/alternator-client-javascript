# CCM integration implementation

This document maps [CCM integration requirements](../ccm-integration.md) to JavaScript test
infrastructure and executable evidence.

## API and architecture

[`TestClusters`](../../test/testinfra/ccm/clusters.ts) exposes asynchronous
`acquireReusable(spec)`, `provisionPrivate(spec)`, and `closeAll()` entry points. Its process-wide
[`TestClusterPool`](../../test/testinfra/ccm/clusters.ts) owns one physical-cluster slot, reusable
reference counts, resource cleanup, exclusive private controls, and configured node ceiling.

[`ClusterSpec`](../../test/testinfra/ccm/spec.ts) supplies immutable copy methods for version,
topology, transports, security, resources, and YAML overrides. `ClusterSpecs.defaultSpec()` and
`defaultClusterSpec()` apply `SCYLLA_VERSION`, defaulting to `release:2025.2.5`.

[`CcmProvisioner`](../../test/testinfra/ccm/provisioner.ts) translates specifications into direct
CCM argument arrays, generates TLS material, reapplies and verifies YAML, waits for endpoints,
controls nodes, writes durable command logs, validates referenced processes, and copies diagnostics
before removal. [`CcmRunState`](../../test/testinfra/ccm/run-state.ts) owns private per-user run
state, cross-process address reservations, owner identity, stale-process recovery, and conservative
quarantine. Linux abstract Unix sockets serialize state changes and release automatically after
process death.

[`global-setup.ts`](../../test/integration-test/global-setup.ts) acquires one default reusable
lease before existing integration tests import configuration. Existing suite reads CCM-derived
endpoints, topology labels, credentials, CA path, and resource prefix from environment metadata.
External-cluster configuration validates optional CA and resource-prefix values before use.
Provisioning contracts and ordinary integration tests run as two foreground Vitest phases through
[`run-integration.mjs`](../../scripts/run-integration.mjs).

## Requirement mapping

| Requirement | Code | Test evidence |
| --- | --- | --- |
| `CCM-REQ-001` | [`spec.ts`](../../test/testinfra/ccm/spec.ts) | [`ccm-spec.test.ts`](../../test/unit/testinfra/ccm-spec.test.ts) |
| `CCM-REQ-002` | [`provisioner.ts`](../../test/testinfra/ccm/provisioner.ts) | [`ccm-provisioner.test.ts`](../../test/unit/testinfra/ccm-provisioner.test.ts), [`cluster-provisioning.test.ts`](../../test/integration-test/cluster-provisioning.test.ts) |
| `CCM-REQ-003` | [`clusters.ts`](../../test/testinfra/ccm/clusters.ts), [`model.ts`](../../test/testinfra/ccm/model.ts) | [`ccm-clusters.test.ts`](../../test/unit/testinfra/ccm-clusters.test.ts), reusable provisioning contract |
| `CCM-REQ-004` | [`clusters.ts`](../../test/testinfra/ccm/clusters.ts) | pool lifecycle tests, private HTTPS provisioning contract |
| `CCM-REQ-005` | [`clusters.ts`](../../test/testinfra/ccm/clusters.ts) | pool admission and node-limit tests |
| `CCM-REQ-006` | [`run-state.ts`](../../test/testinfra/ccm/run-state.ts), [`provisioner.ts`](../../test/testinfra/ccm/provisioner.ts) | [`ccm-run-state.test.ts`](../../test/unit/testinfra/ccm-run-state.test.ts), command timeout tests, next-start hard-kill acceptance |

## Operational entry points

[`install-ccm.mjs`](../../scripts/install-ccm.mjs) installs and validates pinned CCM commit
`d15a2fab9d22fffad8a30c806a7c8e1632e58aae` with `uv`. Provisioning and installation helpers
spawn executables with direct argument arrays and `shell: false`; repository contains no shell
script. Docker Compose, image caches, and static TLS assets are absent.

Diagnostics default to `.ccm-diagnostics`; CI uploads them unconditionally. Relocatable Scylla
packages remain in CCM's standard `~/.ccm/scylla-repository` cache.

## Known gaps

None currently known. Malformed or unremovable state remains quarantined by design.
