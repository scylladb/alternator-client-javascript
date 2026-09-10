# Contributing

Bug fixes, tests, documentation improvements, and focused feature proposals are
welcome. Open an issue before starting a large or compatibility-sensitive change
so maintainers can confirm the intended direction.

Do not report security vulnerabilities in a public issue. Follow
[SECURITY.md](SECURITY.md) instead.

## Development setup

Use Node.js 22.13 or later in the 22.x line, or Node.js 24 or newer, with npm
11.19.1. Docker with the Compose plugin is required for the ScyllaDB integration
suite.

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
`make test-all` starts the repository's three-node ScyllaDB 2025.1 Docker
cluster, runs the integration suite, and stops the cluster.

When debugging against an existing cluster, run the integration tests directly:

```sh
INTEGRATION_TESTS=true \
ALTERNATOR_HOST=172.39.0.2 \
ALTERNATOR_PORT=9998 \
ALTERNATOR_HTTPS_PORT=9999 \
ALTERNATOR_DATACENTER=datacenter1 \
ALTERNATOR_RACK=rack1 \
ALTERNATOR_CA_CERT_PATH="$PWD/test/scylla/db.crt" \
npm run test:integration
```

## Making changes

- Keep public APIs compatible unless the change has explicit maintainer
  agreement and release planning.
- Add or update unit tests for behavior changes. Add integration coverage when
  behavior depends on a real ScyllaDB node, network transport, TLS, or discovery.
- Update the README for public configuration or behavior changes and add a
  changelog entry for user-visible changes.
- Keep commits focused. Do not commit generated `dist` output, package tarballs,
  local certificates, or Docker caches.

Open a pull request against `main` and describe the motivation, observable
behavior, tests run, and compatibility impact. All required CI checks and review
conversations must be resolved before merge.

Package publication is maintainer-only and follows [RELEASING.md](RELEASING.md).
