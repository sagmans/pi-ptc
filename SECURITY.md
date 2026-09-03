# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub private vulnerability reporting:

<https://github.com/sagmans/pi-ptc/security/advisories/new>

The route requires GitHub authentication. No public fallback channel is
currently declared; do not disclose a vulnerability in an issue.

Include:

- affected version or commit;
- reproduction steps;
- impact and attacker capability.

Expect acknowledgement within 7 days. Fixes ship as patch releases. Reporters
receive release-note credit unless they request anonymity.

## Exposed secrets

Report exposed credentials privately, then revoke or rotate them immediately.
GitHub secret scanning and push protection can detect supported secret formats,
but cannot replace review.

## Supported versions

Before the first release, only the current `main` branch receives security
fixes. After the first release, only the latest release tag receives fixes.

## Trust boundary

PTC executes model-written TypeScript with the operating-system identity and
ambient Node authority of Pi. The worker has an empty environment and bounded
resources, but it is containment, not a sandbox or multi-tenant boundary.

Treat every PTC program as user-equivalent peer code. It may access files,
processes, and network resources available to Pi. Nested tool bindings also
retain the authority and side effects of their underlying Pi tools.

The `code` presentation hides direct tool schemas; it is not an authorization
boundary. Tool-specific gate and permission extensions constrain nested
`tools.*` calls only. Direct Node.js operations inside a PTC program do not emit
nested Pi tool hooks and do not use adapter policy.

MCP and other adapter tools keep their own approval, authentication, and OAuth
policy when a program uses their bindings. PTC does not perform OAuth on the
program's behalf. Nested dispatches re-enter captured Pi before/after tool hooks.

Package bootstrap checks the host version before it imports implementation that
depends on private runtime APIs. A host-version mismatch or an invalid private
runtime shape makes PTC inert instead of weakening native behavior.

Artifacts persist model- and tool-produced output on the filesystem: explicit
captures copy arbitrary readable regular files, and automatic spill writes the
oversized final result verbatim. Artifact writes inherit the same
user-equivalent filesystem authority as the PTC program itself. Sessions that
persist conversations also persist their artifact sidecar directory.

Raw custom-renderer arguments and results are available only through exact
in-memory details-object identity in one transport instance. Shutdown, reload,
and inert recovery revoke that instance's raw store, including late settlements.
Call-ID fallback is restricted to bounded renderer definitions. Cloned,
foreign-instance, or restored details receive only sanitized persisted
projections. Rejected tool arguments are omitted from validation messages.
Retention ledgers and the process governor bound stored data and unresolved
worker bindings across concurrent runs and physical module copies.
Worker-side checks reject oversized binding arguments and outer values before
cross-thread delivery.

`ToolResultDeliveryError` means a tool may already have produced side effects.
It is deliberately distinct from `ToolCallError`; automatic retry is unsafe
unless the underlying tool operation is independently idempotent.

Security reports are in scope when they demonstrate:

- hidden-tool execution outside an authorized PTC dispatch;
- bypass of captured tool policy or result hooks;
- nested results leaking into model context outside the outer result;
- escape from documented time, memory, output, dispatch, or persistence bounds;
- terminal-control, renderer, or restored-session injection;
- unsafe recovery that leaves the native tool surface unavailable.

Expected user-equivalent code execution by an accepted PTC call is not, by
itself, a vulnerability.
