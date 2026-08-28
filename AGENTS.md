# AGENTS.md

## Project

`pi-ptc` is a TypeScript Pi extension. It exposes active Pi tools through one
model-written program while keeping nested results out of model context.

Runtime or tool-surface changes: read [`docs/ptc-plan.md`](docs/ptc-plan.md)
and use [`CONTEXT.md`](CONTEXT.md) terminology. User-facing changes must stay
aligned with [`README.md`](README.md), [`CHANGELOG.md`](CHANGELOG.md), and
[`SECURITY.md`](SECURITY.md).

## Repository map

- `index.ts`: published extension entrypoint.
- `src/index.ts`: extension lifecycle, presentation state, and integration wiring.
- `src/pi-runtime.ts` and `src/tool-catalog.ts`: exact-version Pi capture and logical tool state.
- `src/runtime.ts`, `src/worker*.ts`, and `src/tool-*.ts`: program execution and nested dispatches.
- `src/transport.ts`, `src/dispatch-*.ts`, and `src/renderer*.ts`: model result, persistence, and TUI rows.
- `test/*.test.ts`: Node behavior tests. `test/*.binding-smoke.ts`: shipped Bun/Pi binding checks.
- `config.json`: shipped execution and retention limits.

## Architecture boundaries

- Keep Pi support exact and fail closed. `src/pi-runtime.ts` depends on Pi private runtime shapes;
  unsupported versions or shape drift must preserve native tools and leave PTC inert.
- Keep the logical active set separate from the model-visible set. A running PTC call uses fixed
  catalog and renderer snapshots; catalog entries are sorted.
- Preserve Pi argument preparation, schema validation, before/after hooks, lifecycle events,
  execution modes, cancellation, and additive tool activation for nested dispatches.
- Keep intermediate dispatch results model-hidden. Only the bounded outer `{ logs, result? }`
  payload returns to model context.
- Treat the worker as killable containment, not a sandbox. Do not weaken bounds or describe
  `code` presentation as an authorization boundary.
- Keep arbitrary active tools schema-derived. Core tools may retain specialized canonical values and
  renderer fallbacks; new tool support must not become a fixed-name allowlist.

## TypeScript

Use ESM with explicit `.ts` imports. Keep code compatible with
`erasableSyntaxOnly`, strict type checking, and the Biome rules in `biome.json`.
Place imports at module top. Use exhaustive `never` checks for switches over enums or
discriminated unions.

## Commands

Setup:

```bash
npm ci --ignore-scripts
```

Focused test:

```bash
node --test test/<area>.test.ts
```

Required completion gates:

```bash
npm run verify
npm run test:bun
```

`npm run verify` runs Biome, TypeScript, and all Node tests. Run
`npm run verify:ci` when dependency or release work requires the audit gate. Run
`npm pack --dry-run` after changing package contents or metadata.

For extension integration changes, dogfood the one-off install flow from `README.md`
in a disposable, non-production working directory. Verify affected `/ptc` modes and
inert recovery. PTC programs execute with user-equivalent authority.

## Change discipline

Add or update the nearest `test/<area>.test.ts` for behavior changes. Use Bun smoke
tests for worker lifecycle or Pi renderer binding behavior that Node cannot reproduce.
When changing Pi compatibility, update the peer dependency, lockfile, runtime version
constant, compatibility tests, and docs together. Let npm generate `package-lock.json`.
When changing limits, update `config.json`, boundary tests, and documented defaults together.
