# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Programmatic Tool Call presentations for all active Pi runtime tools.
- Verified Pi `0.84.3`, `0.84.4`, and `0.85.0` runtime capture with logical and model-visible tool virtualization.
- Dynamic, schema-derived TypeScript bindings for built-in, SDK, extension, and adapter tools.
- Nested Pi policy hooks, execution events, scheduling, and additive tool activation.
- Pi-native nested rows with captured custom renderers and deterministic session restoration.
- Real MCP adapter coverage for discovery, direct and scripted calls, updates, approval denial, cancellation, and dynamic tool changes.
- Mixed-copy Pi patch/adapter coexistence and persisted-details reader compatibility through versioned fixtures.
- Pinned CI checks for Node, Bun, dependency audit, and package contents.
- CLI-only npm bootstrap, GitHub release controls, trusted-publisher hardening, exact-artifact smoke, and post-release verification.
- Explicit `artifact` capture of regular files into session-owned storage with bounded references.
- Automatic spill of oversized successful final results to `result.json` artifacts.
- Real-Pi regression proving third-party tool_call/tool_result observers see nested `tools.read` calls.
- Reproducible RPC evaluation harness measuring PTC against native tool calling with a 32-run matrix and best-effort cost cap.

### Fixed

- `maxOutputLines` now counts CRLF, CR, and LF sequences inside result string values before JSON escaping, so multiline results cannot bypass the limit.

### Changed

- Raised the default nested-dispatch limit from 100 to 1000.
- Trusted project and user `ptc.json` files can set `maxDispatches`.
- Omit duplicated `truncation.content` from canonical core `read` values; use `.text` for file content.
- Expanded the original seven-core-tool design to the complete logical active set.
- Fixed each running program to one immutable execution lease; refreshes apply to later runs.
- Split private Pi compatibility, lifecycle, rendering, retention, worker protocol, and process-capacity ownership into focused modules.
- Replaced copy-prone pseudo-calls with explicit argument-schema notation and executable SDK examples.
- Added concise program, injected-binding, lossless-JSON, and retry guidance to the model SDK.
- Bootstrap unsupported Pi hosts before loading private-runtime-dependent implementation.
- Prepared npm publication as `@sagmans/pi-ptc`.
- Documented PTC tradeoffs against native batch calls and deterministic aggregation.
- Clarified that direct Node.js operations bypass tool-specific gate and permission extensions.

### Security

- Fail closed to native tools on runtime drift, missing transport, competing ownership, or rollback failure.
- Bound worker time, memory, dispatches, per-dispatch updates, orphaned bindings, output, render data, and persisted details.
- Reject oversized binding arguments and outer values inside the worker before host delivery.
- Sanitize terminal controls, display arguments, results, images, and diagnostics without echoing rejected raw arguments.
- Keep worker environment variables empty while documenting user-equivalent host authority.
- Keep raw renderer attachments identity-only, instance-scoped, and lifecycle-revocable while allowing bounded call-ID recovery only for renderer definitions.
- Preserve adapter-owned approval and authentication policy for MCP and other active runtime tools.

### Fixed

- Ship a precompiled worker graph because Node does not strip TypeScript below `node_modules`.
- Report measured byte or line counts for output-limit failures without echoing rejected output.
- Drain or terminalize cancelled nested work without accepting late display updates.
- Preserve native renderer behavior across streaming, reload, resume, theme, image, and failure paths.
- Restore current and historical display details with explicit bounded fallbacks.
- Distinguish retry-unsafe result-delivery failures from ordinary tool-call failures.
- Expose both failure classes to programs and preserve stable failure codes, causes, resolutions, and retry safety.
- Keep formatted failures classified and bounded while safely escaping hostile tool names.
- Report the rejected lossless-JSON category without echoing the rejected value.
- Enforce one process-wide unresolved-binding ceiling across concurrent workers and physical module copies.
- Recover exact render-retention capacity when a dispatch projection is replaced or cleared.
- Reject stale failure-detail writes after lifecycle clear and centralize mutable Pi association transitions.

## [0.1.0] - Unreleased
