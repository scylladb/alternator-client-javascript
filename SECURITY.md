# Security Policy

## Supported versions

Security fixes are applied to the latest stable `1.x` release. Development
branches, prereleases, and versions older than `1.0.0` are not supported release
lines.

| Version | Supported |
| --- | --- |
| Latest `1.x` | Yes |
| `< 1.0.0` | No |

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/scylladb/alternator-client-javascript/security/advisories/new).
Do not open a public issue or include vulnerability details in a public pull
request.

Include enough information to reproduce and assess the issue:

- affected package version and runtime;
- impact and realistic attack scenario;
- minimal reproduction or proof of concept;
- affected configuration and ScyllaDB version, when relevant;
- any known mitigations or workarounds.

Maintainers will coordinate investigation and disclosure through the private
advisory. Please keep details private until a fix and disclosure timeline have
been agreed.

For ordinary bugs without security impact, use the repository's
[public issue tracker](https://github.com/scylladb/alternator-client-javascript/issues).
