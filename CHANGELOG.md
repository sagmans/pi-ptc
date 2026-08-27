# Changelog

All notable changes to this project are documented here. This format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Programmatic Tool Call presentation for Pi core tools.
- Pi-native TUI rows for nested dispatches while the PTC transport stays hidden.
- Versioned, bounded nested display state for deterministic session restoration.

### Fixed

- Keep nested renderer, invalidation, terminal-control, image, and timer failures inside PTC-owned rows.
- Bound cancellation drains, quarantine late display reports, and terminalize stalled nested rows.
- Bound complete persisted display payloads and strip C0, C1, and ECMA-48 control families.
- Restore current and historical nested rows with explicit preview-only fallback for omitted render data.
- Bound worker memory and log output while removing inherited worker environment variables.
- Preserve live foreign-tool activation without reviving intentionally disabled tools.
- Reserve unique factory call IDs before concurrent dispatches start.
- Bound peer dependency ranges to tested compatible versions.

## [0.1.0] - unreleased
