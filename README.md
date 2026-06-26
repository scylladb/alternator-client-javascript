# Alternator DynamoDB JavaScript Client

AWS SDK v3-compatible DynamoDB client for ScyllaDB Alternator. It keeps the native
`client.send(new Command())` API, middleware stack, retries, waiters, and
`destroy()`, but configures a ScyllaDB Alternator cluster with seed nodes instead
of an AWS `endpoint`.

ScyllaDB Alternator exposes unauthenticated `GET /localnodes` discovery; the
response is a JSON array of live node IP addresses or hostnames without protocol
or port. See the ScyllaDB Alternator-specific API documentation:
https://docs.scylladb.com/manual/stable/alternator/new-apis.html

## Install

```sh
npm install @scylladb/alternator-client @aws-sdk/client-dynamodb
```

For document commands, also install `@aws-sdk/lib-dynamodb`.

## Low-Level Client

```ts
import { ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { AlternatorDynamoDBClient, routing } from "@scylladb/alternator-client";

const client = new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal", "scylla-1.internal"],
  scheme: "http",
  port: 8080,
  routing: routing.datacenter("dc1", {
    fallback: routing.cluster(),
  }),

  region: "us-east-1",
  credentials: {
    accessKeyId: "myuser",
    secretAccessKey: "mypassword",
  },
});

await client.send(new ListTablesCommand({}));

await client.send(
  new PutItemCommand({
    TableName: "users",
    Item: { id: { S: "u1" }, name: { S: "Ada" } },
  }),
);

client.destroy();
```

`endpoint` is rejected. Use `seeds`, optional `scheme`, and a shared `port`.
Defaults are `scheme: "http"` and `port: 8080`. HTTPS users usually set
`scheme: "https"` and `port: 8043`.

Credentials are optional. If omitted, the client uses no-auth mode and does not
resolve the AWS default credential provider chain. If provided, normal SigV4
signing is preserved. `region` defaults to `us-east-1` for signing.

## Document Client

```ts
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";

const docClient = new AlternatorDynamoDBDocumentClient(
  { seeds: ["localhost"] },
  { marshallOptions: { removeUndefinedValues: true } },
);

await docClient.send(
  new PutCommand({
    TableName: "users",
    Item: { id: "u1", name: "Ada" },
  }),
);
```

AWS-style wrapping is also supported:

```ts
const base = new AlternatorDynamoDBClient({ seeds: ["localhost"] });
const docClient = AlternatorDynamoDBDocumentClient.from(base);
```

`.from(normalClient)` is wrap-only. It does not add Alternator discovery or load
balancing unless the passed client is already an `AlternatorDynamoDBClient`.

## Alternator APIs

```ts
client.getLiveNodes();
await client.refreshLiveNodes();
await client.checkRackDatacenterSupport();
await client.checkIfRackAndDatacenterSetCorrectly();
await client.validateRackDatacenterConfig();
client.getPartitionKeyName("users");
```

Routing helpers:

```ts
routing.cluster();
routing.datacenter("dc1", { fallback: routing.cluster() });
routing.rack("dc1", "rack1", {
  fallback: routing.datacenter("dc1", { fallback: routing.cluster() }),
});
```

## Runtime Matrix

| Feature | Node | Edge |
| --- | --- | --- |
| AWS SDK v3 `send()` commands | Yes | Yes |
| `/localnodes` seed discovery | Background or manual | Request-triggered or manual |
| Rack/datacenter routing fallback | Yes | Yes |
| Document client | Yes | Yes |
| Header filtering | Yes | Yes |
| Key-route affinity | Yes | Yes |
| Custom CA/TLS files | Yes | No |
| Node keep-alive agents | Yes | No |
| Socket pool tuning | Yes | No |
| TLS session cache tuning | Yes | No |
| Gzip request compression | Yes | Only with `CompressionStream` |

Unsupported edge combinations throw at construction time with clear errors.

## Options

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  scheme: "http",
  port: 8080,
  routing: routing.cluster(),
  runtime: "node",
  logger: console,

  discovery: {
    background: true,
    refreshIntervalMs: 60_000,
    requestRefreshIntervalMs: 60_000,
    timeoutMs: 2_000,
  },

  compression: {
    enabled: true,
    gzipLevel: -1,
  },

  headerOptimization: {
    enabled: true,
    allowedHeaders: ["Host", "X-Amz-Target", "Content-Length", "Accept-Encoding", "Content-Encoding"],
  },

  keyRouteAffinity: {
    type: "any-write",
    partitionKeys: {
      users: "id",
    },
    autoDiscoverPartitionKeys: true,
  },

  tls: {
    caFile: "/etc/ssl/scylla-ca.pem",
    rejectUnauthorized: true,
    sessionCache: true,
  },

  connection: {
    keepAlive: true,
    maxSockets: 50,
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 0,
    socketTimeoutMs: 0,
  },
});
```

Seed values are hostnames or IP addresses only, not URLs and not `host:port`
strings. Use the `port` option for the shared Alternator port.

### Behavior Details

Header optimization is disabled by default. When enabled, headers are
whitelisted, not removed by a strip list. The default
whitelist is `Host`, `X-Amz-Target`, `Content-Length`, `Accept-Encoding`, and
`Content-Encoding`; when credentials are configured, `Authorization` and
`X-Amz-Date` are also kept.

Request compression is disabled by default. When enabled, it compresses every
request body with gzip. Use `gzipLevel` to select the zlib level, or provide
`compressor` for a custom compressor.

Key-route affinity supports these modes:

```ts
keyRouteAffinity: {
  type: "read-before-write", // or "any-write"
  partitionKeys: { users: "id" },
}
```

The client hashes DynamoDB `S`, `N`, and `B` partition-key AttributeValues with
the same Murmur3 format as Alternator affinity routing. The hash seeds a
deterministic query plan over lexicographically sorted node URLs, so the same
partition key selects the same first node. In `any-write` mode,
`BatchWriteItem` uses voting: each usable write candidate votes for its seeded
first node, a unique majority becomes the preferred node, and ties fall back to
the normal query plan. If partition-key metadata is missing and
`autoDiscoverPartitionKeys` is enabled, the client starts a background
`DescribeTable` lookup and falls back to the normal query plan for the current
request.

Per request, the client creates a lazy node query plan. Retries can consume the
next node from that plan, so active nodes are tried without repeating until the
plan is exhausted.

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run verify
make test-all
```

`npm test` runs the fast unit suite. Integration tests live under
`test/integration-test` and are skipped unless `INTEGRATION_TESTS` is truthy:

```sh
INTEGRATION_TESTS=true \
ALTERNATOR_HOST=172.39.0.2 \
ALTERNATOR_PORT=9998 \
ALTERNATOR_HTTPS_PORT=9999 \
ALTERNATOR_DATACENTER=datacenter1 \
ALTERNATOR_RACK=rack1 \
npm run test:integration
```

For custom CA HTTPS coverage, also set `ALTERNATOR_CA_CERT_PATH` to a PEM CA
certificate path.

`make test-all` starts the same three-node ScyllaDB Docker cluster shape used by
the Java client tests, waits for Alternator, runs `npm run test:integration`
with the required environment variables, and stops the cluster.
