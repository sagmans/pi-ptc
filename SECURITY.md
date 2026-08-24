# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Report privately via GitHub's private vulnerability reporting:

<https://github.com/sagmans/pi-ptc/security/advisories/new>

If that route is unavailable, email the maintainer listed in
[`LICENSE`](LICENSE).

Please include:

- affected version or commit SHA,
- steps to reproduce,
- impact (what an attacker gains).

You can expect an acknowledgement within 7 days. Fixes are released as patch
versions; reporters are credited in release notes unless they prefer
anonymity.

## Exposed secrets

GitHub secret scanning covers the repository's full Git history and pull
requests. Push protection blocks supported secrets before they enter the
repository.

Report a discovered secret through the private vulnerability reporting link
above, not a public issue. Revoke or rotate the credential immediately.

## Supported versions

Only the latest release tag receives security fixes. There is no long-term
support line while the project is at 0.x.

## Scope notes

`pi-ptc` runs model-written TypeScript with the same operating-system authority
as Pi's `bash` tool. The worker isolate is containment, not a multi-tenant
security boundary. Reports about unexpected privilege, secret leakage through
outer results, or presentation-bypass that executes hidden core tools are in
scope.

Treat a PTC program as untrusted peer code with user-equivalent permissions.
Do not claim sandboxing.
