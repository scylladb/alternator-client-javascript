# Changelog

Notable changes to `@scylladb/alternator-client` are recorded here.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Replaced Docker Compose integration-test provisioning with a repository-pinned
  `scylla-ccm` harness using native Scylla relocatable packages, typed cluster
  specifications, isolated resource scopes, and recoverable lifecycle cleanup.

## [1.0.0] - 2026-09-09

Initial stable release.

### Added

- AWS SDK v3-compatible low-level and document DynamoDB clients for ScyllaDB
  Alternator.
- Seed-based `/localnodes` discovery with cluster, datacenter, and rack routing
  scopes and explicit fallback chains.
- Per-request query plans that move retry attempts to another discovered node.
- Optional partition-key affinity routing, including automatic partition-key
  discovery and `BatchWriteItem` voting.
- Node.js and Edge builds with ESM entrypoints, plus CommonJS Node entrypoints.
- Node.js TLS material, connection pooling, timeout, and TLS session-cache
  controls.
- Request and response compression, optimized request headers, and configurable
  client user-agent identity.
- DNS address fallback for configured discovery endpoints and IPv4/IPv6 seed and
  discovered-node support.

[Unreleased]: https://github.com/scylladb/alternator-client-javascript/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/scylladb/alternator-client-javascript/releases/tag/v1.0.0
