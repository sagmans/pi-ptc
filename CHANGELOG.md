# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Programmatic Tool Call presentations for all active Pi runtime tools.
- Exact Pi `0.84.3` runtime capture with logical and model-visible tool virtualization.
- Dynamic, schema-derived TypeScript bindings for built-in, SDK, extension, and adapter tools.
- Nested Pi policy hooks, execution events, scheduling, and additive tool activation.
- Pi-native nested rows with captured custom renderers and deterministic session restoration.

### Changed

- Expanded the original seven-core-tool design to the complete logical active set.
- Fixed each running program to one catalog and renderer snapshot; refreshes apply to later runs.

### Security

- Fail closed to native tools on runtime drift, missing transport, competing ownership, or rollback failure.
- Bound worker time, memory, dispatches, orphaned bindings, output, render data, and persisted details.
- Sanitize terminal controls, display arguments, results, images, and diagnostics.
- Keep worker environment variables empty while documenting user-equivalent host authority.

### Fixed

- Drain or terminalize cancelled nested work without accepting late display updates.
- Preserve native renderer behavior across streaming, reload, resume, theme, image, and failure paths.
- Restore current and historical display details with explicit bounded fallbacks.

## [0.1.0] - Unreleased
