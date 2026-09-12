# CCM integration

This specification defines the contract for provisioning native Scylla clusters with CCM for
Alternator integration tests.

The keywords **must**, **must not**, **should**, and **may** are normative.

## Purpose and scope

The harness supplies a real Scylla cluster without requiring a container runtime. It supports a
shared default cluster for ordinary tests and an exclusive cluster for tests that change topology
or process state. One test process owns at most one physical cluster at a time.

The contract covers immutable typed cluster descriptions, asynchronous provisioning, connections,
resource namespaces, single-slot reuse, diagnostics, and cleanup. The TypeScript API is test-only
and must not be exported from the published `@scylladb/alternator-client` package. The harness does
not promise a general-purpose multi-cluster scheduler or immediate recovery after an uncatchable
process termination.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Cluster specification | Immutable requested version, topology, transports, security, resources, and configuration overrides. |
| Physical cluster | One named CCM cluster and its node processes. |
| Reusable lease | Shared read-only access to a matching physical cluster. |
| Private lease | Exclusive access to a physical cluster with lifecycle and topology controls. |
| Resource scope | Unique namespace owned by one lease for server-side test resources. |
| Reuse key | Deterministic identity of every setting that affects a physical cluster. |
| Dirty cluster | Cluster whose command or cleanup result is ambiguous and which must not be reused or mutated. |

## Configuration and defaults

The default specification must use a three-node, one-datacenter, one-rack topology; expose HTTP
and HTTPS; use two processing units and 1,024 MiB per node; disable authentication and
authorization; and use `release:2025.2.5` unless the run selects another version.

A cluster must contain at least one node and no more than nine nodes. `SCYLLA_CCM_MAX_NODES` may
lower, but must not raise, that ceiling. Node processing units and memory must be positive integers
because they configure Scylla; they are not host-capacity reservations. The harness must not base
admission on detected host or cgroup memory. Alternator authorization enforcement must require
password authentication and Cassandra authorization.

`SCYLLA_VERSION` may select a Scylla package. `SCYLLA_CCM_PATH` may select a working CCM executable.
`SCYLLA_CCM_ROOT` may select the harness-owned state root, whose default must be private, per-user,
and shared by that user's test processes. Runs and address reservations must be derived under that
root. Roots containing whitespace must be rejected before provisioning because the pinned Scylla
package cannot consume the resulting absolute configuration path. Concurrent processes must use
the same root to coordinate address selection; distinct override roots intentionally do not share
reservations. `SCYLLA_CCM_DIAGNOSTICS_DIR` may select an external artifact directory. Diagnostics
intended for artifact collection must be copied outside live state.

## Test-only asynchronous API

The test infrastructure must expose asynchronous operations equivalent to:

- `testClusters.acquireReusable(spec)`, returning a reusable lease;
- `testClusters.provisionPrivate(spec)`, returning a private lease; and
- `testClusters.closeAll()`, releasing process-owned state during normal shutdown.

Every lease must expose read-only cluster information and a resource scope. A private lease must
also expose private lifecycle controls. Lease `close()` operations must be asynchronous and
idempotent. Callers must be able to close leases in `finally` blocks. Reusable cluster information
must not expose mutation controls.

Cluster specifications must provide immutable copy operations for Scylla version, topology,
transports, security, per-node resources, and Scylla YAML overrides. Connections must expose a seed
endpoint, all node endpoints, credentials when authorization is enforced, and a CA certificate path
when HTTPS is selected. Cluster nodes must expose name, address, datacenter, and rack metadata.

## Required behavior

### Typed provisioning

The harness must validate a complete immutable specification before provisioning. The reuse key
must include every behavior-affecting option, preserve structural boundaries, and be independent
of map insertion order. Typed options must own their configuration keys; a free-form override must
not replace a key owned by topology, transport, security, addressing, resources, or startup
behavior. YAML override keys must be canonicalized, and YAML values must be validated before any
CCM command runs.

Each physical cluster must receive a unique name, non-conflicting loopback address range, and
configuration directory. Provisioning must create the requested datacenters and racks, configure
the requested transports and security backends, generate per-run TLS material when HTTPS is
enabled, start all nodes, and wait for every requested Alternator endpoint to become ready.

Child commands must be launched with explicit argument arrays and without a command shell.

### Connections and resource scopes

A lease must expose connection material for each configured transport. Requesting a transport not
enabled by the specification must fail.

Every lease must receive a unique resource prefix. Generated table names must use only ASCII
letters, digits, underscore, hyphen, and period, and remain within the service length limit.
Releasing a reusable lease must remove every table in its resource scope before the cluster can be
reused. An external-cluster resource prefix must be validated against the same character and
length constraints before integration tests run.

### Single-slot reusable leases

Matching reusable leases may share the current physical cluster and must receive independent
resource scopes. Reusable leases expose a read-only cluster view and no lifecycle or topology
mutation.

An idle matching cluster must pass endpoint health validation before reuse. An idle incompatible
cluster must be removed before its replacement is provisioned. If any lease is active, an
incompatible reusable request or any private request must reject immediately. Failed resource
cleanup or health validation must make the cluster dirty and prevent reuse.

Provisioning and release operations may be serialized with asynchronous coordination. The harness
does not guarantee that concurrent callers join an in-flight provisioning result.

### Private leases

A private lease must be exclusive and may expose cluster start, cluster stop, node start, node
stop, node addition, and node removal. Mutations must be serialized. A failed provisioning or node
addition must make one bounded rollback attempt. If the original command or rollback result is
ambiguous, the cluster must become dirty, retain its ownership and address reservation, reject
further mutation, and require whole-cluster cleanup.

### Failure handling and diagnostics

Command output must be written to durable per-command files opened before a child is launched so
output from an in-flight command survives process termination. Before destructive cluster removal,
the harness must snapshot command output, configuration, and node logs without copying private
keys. If the snapshot cannot be transferred to the external diagnostics directory, live run state
must be retained for a later attempt.

Normal shutdown must attempt immediate asynchronous cleanup. At startup, the harness must inspect
previous runs under the configured root and clean runs whose recorded process ID, process start
identity, and boot identity are no longer active. It must terminate same-user processes bearing the
exact run marker before invoking bounded CCM removal. The run and its address reservation may be
deleted only after cleanup succeeds.

Malformed or unremovable ownership state must be preserved with its address ID quarantined. A new
run may continue with another free ID. Recovery after an uncatchable process termination is delayed
until the next harness startup. Cleanup must be idempotent and must reject paths outside validated
harness-owned roots.

## Interactions with other features

### TLS configuration

Generated CA and node certificates must support custom trust without disabling certificate
validation. Added nodes must receive certificates before they start.

### Authentication and header optimization

Secured clusters must expose working signing credentials and reject incorrect credentials. This
allows authentication and header-filtering behavior to be exercised over real connections.

### Discovery, routing, and node health

Connection metadata must reflect requested datacenter and rack layout. Private lifecycle
operations may intentionally change discovery and health results.

### Test parallelism

Matching reusable leases and independent resource scopes may serve concurrent tests in one process.
Address reservations must prevent separate test processes using the same `SCYLLA_CCM_ROOT` from
selecting the same loopback range. Default per-user root provides this coordination across the
user's test processes on one host.

## Edge cases

- Empty transport set, empty topology, zero-sized rack, or non-positive node resource must fail.
- Semantically identical override maps in different insertion orders must have the same reuse key.
- Reuse keys must not be ambiguous when version or override values contain delimiters.
- Different security, topology, transport, resource, version, or override settings must not reuse a
  physical cluster.
- Releasing one of several matching reusable leases must not destroy the shared physical cluster.
- Incompatible request while a reusable lease is active must fail without waiting.
- Unhealthy idle cluster must be replaced rather than leased again.
- Repeated lease or pool close must not release ownership twice.
- HTTPS-only cluster must use HTTPS for resource cleanup.
- Resource hints containing Unicode or unsupported punctuation must be sanitized.
- Stale run that cannot be cleaned must not block a new run from selecting another address ID.

## Conformance requirements

### CCM-REQ-001: Typed specification

The harness must validate immutable typed specifications and derive deterministic, complete, and
delimiter-safe reuse identity from them.

### CCM-REQ-002: Native provisioning

The harness must asynchronously provision requested native topology, transports, TLS, security,
endpoints, and credentials through CCM without a container runtime.

### CCM-REQ-003: Reusable isolation

Matching reusable leases must share a healthy physical cluster while retaining independent
resource scopes, read-only controls, and cleanup boundaries.

### CCM-REQ-004: Private lifecycle

A private lease must exclusively expose serialized asynchronous cluster and node lifecycle changes,
and an ambiguous mutation must dirty the cluster and force whole-cluster cleanup.

### CCM-REQ-005: Single-slot admission

The harness must enforce the nine-node ceiling and its lower override, retain at most one physical
cluster per test process, replace idle incompatible state, and reject incompatible requests
immediately while leases are active. It must not depend on host-memory detection, wait queues, or
LRU eviction.

### CCM-REQ-006: Recoverable harness-owned cleanup

The harness must own normal cleanup and next-start recovery, preserve diagnostics and ownership
after partial failure, quarantine malformed state, reap marked processes, reject unsafe paths, and
release an address ID only after its run is removed safely.
