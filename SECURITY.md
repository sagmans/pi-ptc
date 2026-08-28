# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub private vulnerability reporting:

<https://github.com/sagmans/pi-ptc/security/advisories/new>

If unavailable, email the maintainer listed in [`LICENSE`](LICENSE).

Include:

- affected version or commit;
- reproduction steps;
- impact and attacker capability.

Expect acknowledgement within 7 days. Fixes ship as patch releases. Reporters
receive release-note credit unless they request anonymity.

## Exposed secrets

Report exposed credentials privately, then revoke or rotate them immediately.
GitHub secret scanning and push protection cover supported secret formats, but
cannot replace review.

## Supported versions

Only the latest release tag receives security fixes. No long-term support line
exists while the project is at 0.x.

## Trust boundary

PTC executes model-written TypeScript with the operating-system identity and
ambient Node authority of Pi. The worker has an empty environment and bounded
resources, but it is containment, not a sandbox or multi-tenant boundary.

Treat every PTC program as user-equivalent peer code. It may access files,
processes, and network resources available to Pi. Nested tool bindings also
retain the authority and side effects of their underlying Pi tools.

The `code` presentation hides direct tool schemas; it is not an authorization
boundary. Nested dispatches re-enter captured Pi before/after tool hooks, but a
host-version mismatch or invalid private runtime shape makes PTC inert instead
of weakening native behavior.

Security reports are in scope when they demonstrate:

- hidden-tool execution outside an authorized PTC dispatch;
- bypass of captured tool policy or result hooks;
- nested results leaking into model context outside the outer result;
- escape from documented time, memory, output, dispatch, or persistence bounds;
- terminal-control, renderer, or restored-session injection;
- unsafe recovery that leaves the native tool surface unavailable.

Expected user-equivalent code execution by an accepted PTC call is not, by
itself, a vulnerability.
