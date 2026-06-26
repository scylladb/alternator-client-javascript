# Java Test Coverage Comparison

Comparison source:

- Java unit tests: `/extra/scylladb/alternator-client-java/src/test/java`
- Java integration tests: `/extra/scylladb/alternator-client-java/src/integration-test/java`
- Java integration config: `/extra/scylladb/alternator-client-java/src/test/java/com/scylladb/alternator/IntegrationTestConfig.java`

This list tracks Java-covered behavior that was missing from the JavaScript repo before the
integration-test suite was added. Java-only features are listed separately and intentionally not
ported.

## Missing JS Coverage Added

| Java coverage area | Java files | JavaScript coverage |
| --- | --- | --- |
| Real-cluster client discovery, live-node access, rack/datacenter routing, wrong-scope fallback, and routing commands through discovered nodes | `AlternatorDynamoDbClientIT`, `AlternatorDynamoDbAsyncClientIT` | `test/integration-test/alternator-client.test.ts` |
| Real DynamoDB CRUD through the load-balanced client | `DynamoDbOperationsIT`, client CRUD cases in client IT files | `test/integration-test/dynamodb-operations.test.ts` |
| DynamoDB operations across multiple nodes | `DynamoDbOperationsIT` | `test/integration-test/dynamodb-operations.test.ts` |
| Document/enhanced-client style access against real tables | `DynamoDbEnhancedClientTest` for Java enhanced client usage | `test/integration-test/dynamodb-operations.test.ts` uses `AlternatorDynamoDBDocumentClient` |
| Key-route affinity partition-key autodiscovery with `DescribeTable` and post-discovery same-key routing | `KeyRouteAffinityAutodiscoveryIT` | `test/integration-test/key-route-affinity-autodiscovery.test.ts` |
| Key-route affinity with preconfigured partition key metadata and no extra `DescribeTable` | `KeyRouteAffinityAutodiscoveryIT` | `test/integration-test/key-route-affinity-autodiscovery.test.ts` |
| Compression behavior against a real endpoint | Compression cases in client IT and HTTP-client implementation IT files | `test/integration-test/alternator-client.test.ts`, `test/integration-test/tls-config.test.ts` |
| Header optimization behavior against a real endpoint, including disabled defaults and custom allowlists | Header optimization cases in client IT and HTTP-client implementation IT files | `test/integration-test/alternator-client.test.ts`, `test/integration-test/tls-config.test.ts` |
| Header optimization combined with compression | Client IT and HTTP-client implementation IT files | `test/integration-test/alternator-client.test.ts`, `test/integration-test/tls-config.test.ts` |
| Java HTTP-client customization/configuration equivalents exposed by JS as `requestHandler` and Node connection options | `HttpClientImplementationSyncIT`, `HttpClientImplementationAsyncIT` | `test/integration-test/http-client-implementation.test.ts`, `test/integration-test/http-connection-reuse.test.ts`, `test/integration-test/internal/connection-pool.test.ts` |
| Serial, parallel, and idle-period HTTP request reuse | `HttpConnectionReuseIT` | `test/integration-test/http-connection-reuse.test.ts` |
| Repeated live-node refreshes and SDK operations with pooled connections | `internal/ConnectionPoolIT` | `test/integration-test/internal/connection-pool.test.ts` |
| HTTPS operation with trust-all behavior, optional custom CA, and custom-CA CRUD | `TlsConfigIT`, HTTPS cases in HTTP-client implementation IT files | `test/integration-test/tls-config.test.ts` |
| TLS session-cache enabled/disabled behavior with real HTTPS requests | `TlsSessionResumptionIT` | `test/integration-test/tls-session-resumption.test.ts` |

## Existing JS Unit Coverage

These Java unit-test areas already had JavaScript unit coverage and were not duplicated as new
integration tests:

- Config validation for seeds, scheme, port, runtime, connection options, headers, compression, and TLS.
- `/localnodes` discovery, rack/datacenter query fallback, request-triggered edge discovery, and live-node access.
- Alternator middleware request rewriting, retry node selection, no-auth header stripping, SigV4 preservation, header whitelisting, and gzip request compression.
- User-agent replacement, customization, transform, removal, and preservation with header optimization.
- Query-plan ordering, seeded random ordering, and retry distribution behavior.
- Murmur3 and AttributeValue hash vectors shared with the Java tests.
- Key-route affinity classification for write and read-before-write operations.
- BatchWriteItem key-affinity voting.
- Document-client construction, wrapping behavior, and TypeScript public API usage.

## Java-Only Or Absent JS Features Ignored

The following Java test areas are not ported because the JavaScript client does not expose the same
feature surface:

- Separate synchronous and asynchronous client classes. The AWS SDK v3 JavaScript client is async by
  design, so the JS integration suite does not duplicate every case as sync and async variants.
- Apache, Netty, and CRT HTTP client factories, detectors, zero-timeout behavior, and classpath
  tests. The JS client uses Smithy `NodeHttpHandler` or `FetchHttpHandler`; the JS-equivalent
  user-provided `requestHandler` path and Node connection options are covered by integration tests.
- Java wrapper APIs such as `buildWithAlternatorAPI`, `getAlternatorLiveNodes`, Java builder
  customizer methods, and legacy compatibility methods.
- Java `DynamoDbEnhancedClient`. The JS equivalent user-facing surface is
  `AlternatorDynamoDBDocumentClient`, which is covered by integration tests.
- Java TLS `SSLContext` factory internals, hostname-verifier classes, trust-manager plumbing, and
  TLS session cache size/timeout settings. The JS client exposes Node TLS agent options and a
  boolean `sessionCache` toggle.
- Exact TCP socket-count assertions using `ss` filtered by JVM PID. The JS suite covers the
  equivalent externally visible behavior: repeated discovery refreshes, serial requests, parallel
  requests, idle gaps, and bounded socket-pool configuration.
