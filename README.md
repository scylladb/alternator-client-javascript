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

Node.js 22 or newer is required for the Node runtime. Continuous integration
tests the package on Node.js 22 and 24.

The package uses conditional exports. Node resolves the Node build; browser,
worker, and default ESM conditions resolve the Edge build, which contains no
Node built-in imports. To force the Edge entrypoint in a non-edge test harness:

```ts
import { AlternatorDynamoDBClient } from "@scylladb/alternator-client/edge";
```

For document commands in an Edge bundle, use:

```ts
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document/edge";
```

The integration suite uses ScyllaDB 2025.2.5 as its compatibility baseline. This
records the version tested for this release; it is not a blanket compatibility
guarantee for every ScyllaDB release.

## Low-Level Client

```ts
import { ListTablesCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { AlternatorDynamoDBClient, routing } from "@scylladb/alternator-client";

const client = new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal", "scylla-1.internal"],
  scheme: "http",
  port: 8080,
  routing: routing.datacenter({
    datacenter: "dc1",
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

The public config does not include `endpoint`. Use `seeds`, optional `scheme`, and a shared `port`.
Defaults are `scheme: "http"` and `port: 8080`. HTTPS users usually set
`scheme: "https"` and `port: 8043`.

Credentials are optional. If omitted, the client uses no-auth mode and does not
resolve the AWS default credential provider chain. If provided, normal SigV4
signing is preserved. `region` defaults to `us-east-1` for signing.

## Document Client

```ts
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { AlternatorDynamoDBDocumentClient } from "@scylladb/alternator-client/document";

const docClient = AlternatorDynamoDBDocumentClient.fromConfig(
  { seeds: ["localhost"] },
  { marshallOptions: { removeUndefinedValues: true } },
);

await docClient.send(
  new PutCommand({
    TableName: "users",
    Item: { id: "u1", name: "Ada" },
  }),
);

docClient.destroy();
```

AWS-style wrapping is the primary API when you already have a low-level client:

```ts
const base = new AlternatorDynamoDBClient({ seeds: ["localhost"] });
const docClient = AlternatorDynamoDBDocumentClient.from(base);

// The wrapper does not own base, so destroy it separately when finished.
docClient.destroy();
base.destroy();
```

`.from(normalClient)` is wrap-only. It does not add Alternator discovery or load
balancing unless the passed client is already an `AlternatorDynamoDBClient`.
The caller retains ownership of the supplied client, and destroying the document
wrapper does not destroy it. In contrast, `.fromConfig()` creates and owns an
`AlternatorDynamoDBClient`; destroying that document client also stops its
background discovery and destroys its HTTP resources.

## Alternator APIs

```ts
client.alternator.nodes();
await client.alternator.refreshNodes();
await client.alternator.supportsScopedDiscovery();
await client.alternator.validateRouting();
client.alternator.partitionKey("users");
```

Routing helpers:

```ts
routing.cluster();
routing.datacenter({ datacenter: "dc1", fallback: routing.cluster() });
routing.rack({
  datacenter: "dc1",
  rack: "rack1",
  fallback: routing.datacenter({
    datacenter: "dc1",
    fallback: routing.cluster(),
  }),
});
```

`routing.cluster()` queries `/localnodes` on every configured seed and unions
the returned local-node lists. In multi-datacenter deployments, configure at
least one seed per datacenter.

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
| Gzip/deflate response compression | Yes | Yes; custom raw HTTP handlers require `DecompressionStream` |

Unsupported edge options that can be detected statically throw at construction
time. A custom raw handler reports a missing `DecompressionStream` when it
receives an encoded response.

## Options

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  scheme: "https",
  port: 8043,
  routing: routing.cluster(),
  logger: console,

  discovery: {
    background: true,
    refreshIntervalMs: 60_000,
    requestRefreshIntervalMs: 60_000,
    timeoutMs: 2_000,
  },

  compression: {
    request: {
      thresholdBytes: 1_024,
      gzipLevel: -1,
    },
    response: {
      algorithms: ["gzip"],
    },
  },

  headerOptimization: {
    allowedHeaders: ["Host", "X-Amz-Target", "Content-Length", "Accept-Encoding", "Content-Encoding"],
    additionalAllowedHeaders: ["X-Request-Id"],
  },

  userAgent: { append: "my-app/1.2.3" },

  keyRouteAffinity: {
    mode: "any-write",
    partitionKeys: {
      users: "id",
    },
    autoDiscoverPartitionKeys: true,
  },

  tls: {
    ca: { file: "/etc/ssl/scylla-ca.pem" },
    cert: { file: "/etc/ssl/client-cert.pem" },
    key: { file: "/etc/ssl/client-key.pem" },
    rejectUnauthorized: true,
    sessionCache: true,
  },

  connection: {
    keepAlive: true,
    maxSockets: 50,
    throwOnRequestTimeout: true,
    timeouts: {
      connectMs: 1_000,
      requestMs: 0,
      socketMs: 0,
    },
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
`X-Amz-Date` are also kept. Alternator does not use AWS session tokens, so
`sessionToken` is not sent even when provided in credentials. The Alternator
`User-Agent` is applied after this filter, so it is kept unless
`userAgent: false` is configured.

Use `allowedHeaders` to replace the default whitelist. Use
`additionalAllowedHeaders` to extend the default (or explicitly supplied)
whitelist without repeating it:

```ts
headerOptimization: {
  additionalAllowedHeaders: ["X-Request-Id"],
}
```

By default, the client replaces the AWS SDK `User-Agent` with the ScyllaDB
Alternator client identity:

```text
scylladb-alternator-client-javascript/<version>
```

You can replace it completely:

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  userAgent: { value: "my-client/1.2.3" },
});
```

You can append to the generated value:

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  userAgent: { append: "my-app/4.5.6" },
});
```

Or transform the generated value. Returning `null`, `undefined`, or a blank
string removes the header:

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  userAgent: {
    transform: (generated) => `${generated} my-app/4.5.6`,
  },
});
```

`value`, `append`, and `transform` are mutually exclusive.

Use `userAgent: false` to remove the header entirely.

Request and response compression are disabled by default and configured
separately:

```ts
compression: {
  request: {
    thresholdBytes: 1_024,
    gzipLevel: -1,
  },
  response: {
    algorithms: ["gzip"],
  },
}
```

`compression.request: {}` compresses every measurable request body with gzip.
Use `thresholdBytes` to skip smaller request bodies, `gzipLevel` to select the
zlib level, or `compressor` for a custom request compressor. Use
`compression.request: false` to disable request compression explicitly.

`compression.response: {}` enables the default response algorithm, `gzip`.
Pass an options object with an explicit algorithm list to control the
`Accept-Encoding` value:

```ts
new AlternatorDynamoDBClient({
  seeds: ["scylla-0.internal"],
  compression: {
    response: {
      algorithms: ["gzip", "deflate"],
    },
  },
});
```

When enabled, the client sends `Accept-Encoding` and transparently decodes
`gzip` and `deflate` response bodies before the AWS SDK deserializes them. If
header optimization uses a custom whitelist, keep `Accept-Encoding` and
`Content-Encoding` in that list.

### TLS and HTTP transport

Node TLS configuration accepts CA certificates, client certificates, and client
keys. Each `ca`, `cert`, or `key` value uses exactly one material form:

```ts
tls: {
  ca: { file: "/etc/ssl/scylla-ca.pem" },
  cert: { text: process.env.SCYLLA_CLIENT_CERT_PEM! },
  key: { bytes: clientKeyBytes },
  rejectUnauthorized: true,
  sessionCache: true,
}
```

`file` is a filesystem path, `text` is PEM text, and `bytes` is a
`Uint8Array`. TLS material and session-cache tuning are Node-only. Prefer
`rejectUnauthorized: true`; disabling certificate verification is unsafe.

The built-in Node handler supports `connection.keepAlive`,
`connection.maxSockets`, `connection.timeouts.connectMs`,
`connection.timeouts.requestMs`, `connection.timeouts.socketMs`, and
`connection.throwOnRequestTimeout`. Additional Smithy `NodeHttpHandlerOptions`
can be passed through `connection.node`, except `httpAgent` and `httpsAgent`;
configure pooling and TLS through `connection` and `tls` instead.

The Edge handler supports `connection.keepAlive`,
`connection.timeouts.requestMs`, and additional `FetchHttpHandlerOptions`
through `connection.fetch`. The top-level AWS SDK-compatible `requestHandler`
option accepts a handler instance, a Smithy options-provider function, or a
handler options object for the selected runtime. An options object is merged
with the Alternator `connection` and `tls` settings. A supplied handler instance
or options-provider function bypasses those generated settings and therefore
owns its transport configuration.

Key-route affinity supports these modes:

```ts
keyRouteAffinity: {
  mode: "read-before-write", // or "any-write"
  partitionKeys: { users: "id" },
}
```

The client hashes DynamoDB `S`, `N`, and `B` partition-key AttributeValues with
the same Murmur3 format as Alternator affinity routing. The hash seeds a
deterministic query plan over lexicographically sorted node URLs, so the same
partition key selects the same first node. In `any-write` mode,
`BatchWriteItem` uses voting: each usable write candidate votes for its seeded
first node. Voted coordinators are tried by vote count descending, ties use
canonical node-address order, and zero-vote live coordinators follow in
canonical order. The client falls back to the normal query plan only when no
candidate can vote. If one table lacks partition-key metadata and
`autoDiscoverPartitionKeys` is enabled, the client starts a background
`DescribeTable` lookup for that table while other usable tables can still vote.

Per request, the client creates a lazy node query plan. When the AWS retry
strategy retries a transport failure or retryable service response, the next
attempt consumes the next node from that plan. Active nodes are tried without
repeating until the plan is exhausted; additional attempts start another plan.

The client does not maintain a persistent dead-node quarantine, subscribe to
topology events, or health-rank nodes across requests. A failed node can be
selected by a later request until a discovery refresh returns a node list that
does not include it. Topology changes are therefore learned through scheduled,
request-triggered, or manual `/localnodes` refreshes.

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

`npm test` runs the fast unit suite. Integration tests use
[scylla-ccm](https://github.com/scylladb/scylla-ccm) and native Scylla
relocatable packages. They require Linux, Python 3.9 or newer, OpenSSL, and
Git, plus [`uv`](https://docs.astral.sh/uv/). Install the repository-pinned CCM
revision and run the suite with:

```sh
make ccm-install
make test-integration
```

`make test-all` is an alias for the CCM-backed integration suite. The harness
owns provisioning, endpoint readiness, generated TLS material, per-lease table
namespaces, diagnostics, and cleanup. The default specification uses three
nodes in one datacenter and rack, HTTP and HTTPS, two processing units and
1,024 MiB per node, disabled authentication and authorization, and Scylla
`release:2025.2.5`.

Set `SCYLLA_VERSION` to select another Scylla package or `SCYLLA_CCM_PATH` to
use another CCM executable. `SCYLLA_CCM_MAX_NODES` may lower the nine-node
ceiling. `SCYLLA_CCM_ROOT` selects the private harness state root; concurrent
processes must use the same root to coordinate loopback address reservations.
The root path must not contain whitespace because the pinned Scylla package
cannot consume such an absolute configuration path.
`SCYLLA_CCM_DIAGNOSTICS_DIR` selects the external diagnostics directory and
defaults to `.ccm-diagnostics`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and
[RELEASING.md](RELEASING.md) for the maintainer release procedure.
