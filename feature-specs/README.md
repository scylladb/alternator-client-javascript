# Feature specifications

This directory contains normative contracts for repository features whose behavior spans public
test APIs, provisioning, integration tests, and continuous integration.

The keywords **must**, **must not**, **should**, and **may** are normative. Stable requirement IDs
connect each contract to implementation and test evidence.

- [CCM integration](ccm-integration.md) (`CCM-REQ-001` through `CCM-REQ-006`)
  ([implementation mapping](implementation/ccm-integration.md))

CCM integration is test-only infrastructure. It is not part of the published
`@scylladb/alternator-client` package API.
