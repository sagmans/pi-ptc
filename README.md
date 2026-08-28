# pi-ptc

Programmatic Tool Call for Pi. The model writes one TypeScript program against
the tools active in the current Pi session. Nested results stay inside the
program; only its captured logs and return value re-enter model context.

The default `code` presentation exposes only `ptc` to the model. `both`
exposes `ptc` and the active tools; `native` disables PTC.

> PTC runs model-written code with user-equivalent authority. Its worker is
> containment, not a sandbox.

## Requirements

- Node `>=22.19.0`
- Pi `0.84.3`

PTC uses an exact-version, fail-closed adapter for Pi runtime state. An
unsupported host stays native and reports `ptc: inert`.

## Install

Local checkout:

```bash
pi install /absolute/path/to/pi-ptc
```

One-off test:

```bash
pi -e /absolute/path/to/pi-ptc
```

## Usage

The model calls `ptc` with an async function body:

```ts
const [pkg, ts] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "tsconfig.json" }),
]);
return {
  packageName: JSON.parse(pkg.text).name,
  compilerOptions: JSON.parse(ts.text).compilerOptions,
};
```

Every active tool receives a generated `tools.<name>(args)` binding. Tool
names that are not JavaScript identifiers use bracket notation.

Failed dispatches reject with `ToolCallError(toolName, message)`:

```ts
try {
  return await tools.bash({ command: "exit 7" });
} catch (error) {
  return {
    caught: error instanceof ToolCallError,
    toolName: error.toolName,
  };
}
```

## Presentation

| Setting | Model-visible tools |
|---|---|
| `code` | `ptc` only |
| `both` | `ptc` plus the logical active set |
| `native` | Logical active set only |

Set it with:

```text
/ptc on
/ptc both
/ptc off
```

With no argument, `/ptc` cycles through the three settings. A trusted project
`.pi/ptc.json` overrides `~/.pi/agent/ptc.json`; the shipped default is
`code`.

PTC preserves Pi's logical active-tool state while changing what the model sees.
Tool refreshes and additive dynamic loading update later PTC runs. Each running
program keeps a fixed tool and renderer snapshot.

## Execution

Each `ptc` call:

1. Type-strips erasable TypeScript and starts a fresh worker.
2. Exposes bindings from the active-tool snapshot.
3. Validates arguments and runs captured Pi before/after tool hooks.
4. Emits Pi tool execution start, update, and end events.
5. Returns lossless JSON to the program.
6. Sends only `{ logs, result? }` to model context.

Tools honor their Pi `executionMode`. Without one, `bash`, `edit`, and
`write` run exclusively; other tools may run in parallel.

The worker has an empty environment, but nested tools retain their normal Pi
behavior and operating-system authority.

## Display

PTC hides its outer shell and renders one row per nested dispatch. It reuses Pi's
built-in renderers and captures extension tool renderers for that execution.
Missing or failing renderers fall back to bounded text.

Display arguments, results, images, diagnostics, and persisted details are
sanitized and bounded. Versioned details restore rows after session resume.
When a retention budget is exhausted, PTC keeps a deterministic preview instead
of a partial native result.

## Limits

Shipped limits live in [`config.json`](config.json). Defaults include:

- 120-second program timeout;
- 100 dispatches per program;
- 10 parallel dispatches;
- 128 MiB worker old-generation heap;
- 256,000-byte or 10,000-line outer output;
- 2,000,000-byte render and 3,000,000-byte persistence budgets.

Only presentation has project and user overrides.

## Compatibility

Active built-in, SDK, extension, and adapter-provided tools are eligible for PTC.
Inactive registered tools remain unavailable. If a tool activates additional
registered tools, later PTC runs can use them.

`pi-fabric`, `pi-retype`, and other transports registered as
`fabric_exec`, `retype`, or `execute_tools` compete for the same tool
surface. PTC stays inert when one is present.

## Development

```bash
npm ci --ignore-scripts
npm run verify
npm run test:bun
```

`npm run verify` runs formatting, type checks, and Node tests.
`npm run test:bun` covers the shipped Pi/Bun worker and renderer bindings.
