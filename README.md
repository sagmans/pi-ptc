# pi-ptc

Programmatic Tool Call for Pi. The model writes one TypeScript program against
the tools active in the current Pi session. Nested results stay inside the
program; only its captured logs and return value re-enter model context.

The default `code` presentation exposes only `ptc` to the model. `both`
exposes `ptc` and the active tools; `native` disables PTC.

> PTC runs model-written code with user-equivalent authority. Its worker is
> containment, not a sandbox. Tool-specific gate and permission extensions do
> not constrain direct Node.js operations inside a PTC program. Only nested
> `tools.*` calls pass through captured Pi tool hooks.

## When it helps

Use native batch calls for independent tool work. PTC adds value when later calls
depend on earlier results, or when intermediate results are too large to return to
the model. One program can branch, loop, parse, filter, sort, and aggregate across
nested calls without another model round trip. The model receives only the bounded
outer `{ logs, result? }` payload instead of every intermediate tool result.

Aggregation is deterministic because normal code performs the transformation. For
example, a program can read many files, select exact fields, sort them, and return
one small JSON value without asking the model to summarize each tool response.

The `code` presentation reduces the callable model-facing tool list to `ptc`; it
does not remove tool awareness or all schema prompt cost. Generated binding
signatures remain in the `ptc` description so the model can write valid calls.

## Requirements

- Node `>=24.20.0`
- Pi `0.84.3` or `0.84.4`

PTC uses an explicit verified-version allowlist and fail-closed adapter for Pi
runtime state. Package bootstrap checks the host before loading Pi-private, TUI,
or TypeBox-dependent implementation. An unsupported host stays native without
registering PTC; runtime shape drift after supported-host loading reports
`ptc: inert`. Future Pi versions require verification before joining the allowlist.

## Install

npm package after the first release:

```bash
pi install npm:@sagmans/pi-ptc
```

Local checkout:

```bash
pi install /absolute/path/to/pi-ptc
```

One-off test:

```bash
pi -e /absolute/path/to/pi-ptc
```

## Usage

The model calls `ptc` with two required arguments:

```ts
{
  code: string;
  description: string;
}
```

`code` is the body of an async function. PTC injects `tools`,
`ToolCallError`, `ToolResultDeliveryError`, and `console` into that
function. The program does not import them.

Before each model response, PTC adds a compact SDK section to the system prompt.
It lists the sorted active bindings and their argument schemas. Each PTC run
uses a fixed snapshot of that list.

The SDK displays schemas as reference notation, not as executable calls:

```text
tools.read arguments: { path: string; offset?: number; limit?: number }
```

Pass concrete values in program code:

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

Every active runtime tool receives a generated `tools.<name>(args)` binding.
This includes built-in, SDK, extension, and adapter-backed tools such as MCP.
Tool names that are not JavaScript identifiers use bracket notation.

Use these rules when you write a program:

- Use an async-function body without Markdown fences.
- Prefer plain JavaScript. Use erasable TypeScript only when necessary.
- Do not use imports, exports, JSX, enums, namespaces, or decorators.
- Pass one lossless-JSON argument to each binding.
- Await every dispatch. Use `Promise.all` only for independent calls.
- Return a small lossless-JSON projection.

Lossless JSON contains `null`, booleans, finite numbers except `-0`, strings,
dense arrays, and plain objects. Omit `undefined` fields or replace them with
`null`. Convert `BigInt`, `Date`, `Map`, `Set`, and class instances
before they cross a binding or result boundary.

Independent calls can run together:

```ts
const [pkg, config] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "config.json" }),
]);
return {
  name: JSON.parse(pkg.text).name,
  presentation: JSON.parse(config.text).presentation,
};
```

Core `read` values expose file content through `.text`. Truncated reads retain
truncation metadata but omit its duplicate `content` field. Project or summarize
binding values instead of returning raw batches that waste the bounded outer
result.

Failed tool dispatches reject with `ToolCallError(toolName, message)`. A result
that cannot be delivered after tool execution rejects with
`ToolResultDeliveryError`. Do not retry this failure without checking the
external state first.

```ts
try {
  return await tools.bash({ command: "exit 7" });
} catch (error) {
  if (error instanceof ToolResultDeliveryError) throw error;
  if (error instanceof ToolCallError) {
    return { ok: false, toolName: error.toolName, message: error.message };
  }
  throw error;
}
```

Uncaught PTC failures contain a stable code, cause, resolution, and retry
safety. The agent uses this information to submit a corrected call. PTC does
not rewrite programs or retry calls automatically.

Adapter authorization remains adapter-owned when a program uses an adapter
binding. Direct Node.js operations do not use adapter policy. PTC does not
perform OAuth on the program's behalf.

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
program uses an immutable execution lease with fixed catalog, dispatch, and
renderer capabilities. Tools announced during a run become available only to a
later run.

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

The worker has an empty environment, but the program retains ambient Node.js
authority. It can access files, processes, and networks without a `tools.*` call.
Nested tools retain their normal Pi behavior and operating-system authority.

## Display

PTC hides its outer shell and renders one row per nested dispatch. It reuses Pi's
built-in renderers and captures extension tool renderers for that execution.
Missing or failing renderers fall back to bounded text.

Display arguments, results, images, diagnostics, and persisted details are
sanitized and bounded. Raw custom-renderer attachments require the exact details
object identity within one transport instance and are revoked on lifecycle
clear; only renderer definitions permit bounded call-ID restoration.
Versioned details restore rows after session resume. When a retention budget is
exhausted, PTC keeps a deterministic preview instead of a partial native result.

## Limits

Shipped limits live in [`config.json`](config.json). Defaults include:

- 120-second program timeout;
- 100 dispatches per program;
- 100 progress updates per dispatch;
- 10 parallel dispatches;
- 128 MiB worker old-generation heap;
- 256,000-byte or 10,000-line outer output, checked in the worker before delivery;
- 2,000,000-byte render and 3,000,000-byte persistence budgets.

Output-limit failures report the measured byte or line count without echoing the
rejected output. Only presentation has project and user overrides.

## Compatibility

Active built-in, SDK, extension, and adapter-provided tools—including MCP
adapter tools—are eligible for PTC. Selection is schema-derived, not a fixed
name allowlist. Inactive registered tools remain unavailable. If a tool
activates additional registered tools, later PTC runs can use them.

`pi-fabric`, `pi-retype`, and other transports registered as
`fabric_exec`, `retype`, or `execute_tools` compete for the same tool
surface. PTC stays inert when one is present.

Third-party Pi extensions keep observing nested tool traffic. A
`pi.on("tool_call")` and `pi.on("tool_result")` pair observes every
`tools.read` executed inside a PTC program, exactly once per dispatch, while
direct Node filesystem calls in the same program emit no Pi tool hooks:

```ts
pi.on("tool_call", (event) => {
  if (event.toolName === "read") {
    auditTrail.push(event.input.path); // observed for tools.read inside PTC
  }
});
```

Mixed physical copies of the Pi patch and adapter can coexist during reload.
Downgrading the complete extension lifecycle requires restarting Pi; hot
rollback to an older lifecycle in the same process is not supported.

## Development

```bash
npm ci --ignore-scripts
npm run verify
npm run test:bun
```

`npm run verify` runs formatting, type checks, and Node tests.
`npm run test:bun` covers the shipped Pi/Bun worker and renderer bindings.

Maintainers must follow [`RELEASE.md`](RELEASE.md). The linked CLI-only setup automates npm bootstrap, GitHub approval controls, trusted publishing, hardening, and verification.
