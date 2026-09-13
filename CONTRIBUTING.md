# Contributing

Bug fixes, tests, documentation improvements, and focused feature proposals are
welcome. Open an issue before starting a large or compatibility-sensitive change
so maintainers can confirm the intended direction.

Do not report security vulnerabilities in a public issue. Follow
[SECURITY.md](SECURITY.md) instead.

## Development setup

Use Node.js 22.13 or later in the 22.x line, or Node.js 24 or newer, with npm
11.19.1. The ScyllaDB integration suite also requires Linux, Python 3.9 or
newer, OpenSSL, Git, and [`uv`](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/scylladb/alternator-client-javascript.git
cd alternator-client-javascript
npm install --global npm@11.19.1
npm ci
```

`npm ci` installs exactly the dependency versions recorded in
`package-lock.json`. Do not replace it with `npm install` when validating an
existing change.

## Tests and checks

Run the fast development checks while working:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Before opening or updating a pull request, run the same package-level gates used
for a release:

```sh
npm ci
npm run verify
make test-all
```

`npm run verify` includes source checks, package metadata/type validation, a
full dependency audit, and `test:package`. The package test builds a tarball,
installs it in an isolated temporary project, and checks runtime exports and
TypeScript declarations.
`make test-all` installs the repository-pinned `scylla-ccm`, provisions a
native three-node Scylla cluster, runs the integration suite, and removes the
cluster. The default cluster uses Scylla `release:2025.2.5`, one datacenter and
rack, HTTP and HTTPS, two processing units and 1,024 MiB per node, and disabled
authentication and authorization.

The CCM harness accepts these environment overrides:

- `SCYLLA_VERSION` selects the relocatable Scylla package.
- `SCYLLA_CCM_PATH` selects an existing CCM executable.
- `SCYLLA_CCM_ROOT` selects the private state and address-reservation root.
  Its path must not contain whitespace.
- `SCYLLA_CCM_MAX_NODES` may lower the hard nine-node ceiling.
- `SCYLLA_CCM_DIAGNOSTICS_DIR` selects the external diagnostics directory;
  the repository default is `.ccm-diagnostics`.

Processes running concurrently on one host must use the same
`SCYLLA_CCM_ROOT` to coordinate loopback address reservations. After an
uncatchable process termination, the next harness startup attempts recovery
and preserves diagnostics or quarantined state when cleanup cannot finish
safely.

To run only existing client integration tests against an already running
cluster, set `ALTERNATOR_USE_EXISTING=true` together with `INTEGRATION_TESTS`,
`ALTERNATOR_HOST`, HTTP/HTTPS ports, topology labels, and optional CA path, then
run `npm run test:integration:suite`. An optional `ALTERNATOR_RESOURCE_PREFIX`
must contain at most 222 ASCII letters, digits, underscores, hyphens, or periods;
an empty CA path is treated as absent.

## Making changes

- Keep public APIs compatible unless the change has explicit maintainer
  agreement and release planning.
- Add or update unit tests for behavior changes. Add integration coverage when
  behavior depends on a real ScyllaDB node, network transport, TLS, or discovery.
- Update the README for public configuration or behavior changes and add a
  changelog entry for user-visible changes.
- Keep commits focused. Do not commit generated `dist` output, package tarballs,
  CCM state, diagnostics, local certificates, or relocatable packages.

Open a pull request against `main` and describe the motivation, observable
behavior, tests run, and compatibility impact. All required CI checks and review
conversations must be resolved before merge.

Package publication is maintainer-only and follows [RELEASING.md](RELEASING.md).
