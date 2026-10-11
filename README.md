# pi-ptc

> [!WARNING]
> **Deprecated and archived.** pi-ptc is superseded by Pi's built-in
> [`codemode`](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md) tool. Codemode shipped in Pi
> [0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0)
> (2026-09-29) and is part of Pi 1.x
> ([1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0)). pi-ptc only
> supports Pi 0.84.3, 0.84.4, and 0.85.0 and stays inert on newer Pi. It gets no
> further fixes or releases. Use codemode instead.

pi-ptc was a Programmatic Tool Call extension for Pi. The model wrote one program
against the active Pi tools, nested results stayed inside the program, and only
the program's logs and return value reached the model. Pi's `codemode` does the
same thing natively.

## Migrate to Pi codemode

1. Remove pi-ptc using the source you installed it from (`pi list` shows it):

   ```bash
   pi remove /absolute/path/to/pi-ptc
   ```

   Then delete `~/.pi/agent/ptc.json` and any project `.pi/ptc.json`. Pi does not read them.

2. Update Pi to 1.x and turn on codemode next to the default tools in
   `~/.pi/agent/settings.json` or a project's `.pi/settings.json`
   ([Enable codemode](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md#enable-codemode)):

   ```json
   {
     "defaultTools": ["+codemode"]
   }
   ```

   For one run on Pi 1.1.0 or later: `pi --tools +codemode`.

3. Pick the presentation that matches your old `/ptc` setting
   ([settings: Tools](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/settings.md#tools)):

   | pi-ptc | Pi codemode |
   |---|---|
   | `presentation: "code"` (`/ptc on`, the default) | `"codemode": { "mode": "only" }`: only `codemode` is declared and the other tools are called through scripts |
   | `presentation: "both"` (`/ptc both`) | `"codemode": { "mode": "on" }` (Pi's default): tools stay declared and are also callable from scripts |
   | `presentation: "native"` (`/ptc off`) | Leave codemode out of `defaultTools`, or remove it with `"-codemode"` |
   | `~/.pi/agent/ptc.json`, trusted `.pi/ptc.json` | `~/.pi/agent/settings.json`, project `.pi/settings.json` |
   | `timeoutMs` (120 s default) | Per script: `// @options: {"timeout_ms": 60000}` on the first line. There is no global setting, and no deadline by default |
   | `maxOutputBytes` / `maxOutputLines` | Per script: `max_output_tokens` (default 10000). Longer output is truncated and the full text is written to a temp file |
   | Binding signatures in the system prompt | `codemode.inlineBudget` (default 3000 estimated tokens), plus `searchTools()`, `describeTool()`, `describeNamespace()`, and `ALL_TOOLS` |
   | `tools.<name>(args)` | `tools.<name>(args)`. Non-identifier characters become `_`, for example `tools.mcp__dev_radius__search` |
   | `console`, return value | `console.*`, `text()`, `image()`, `return` |
   | `ToolCallError` / `ToolResultDeliveryError` | A failed tool call rejects with an `Error` carrying the tool's error text; use `Promise.allSettled()` |

### What codemode does differently

The comparison below uses the Pi 1.1.0
[codemode reference](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/codemode.md),
[extension tool docs](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md) and
[changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md).

- **Same:** nested tool calls go through argument validation and the `tool_call` / `tool_result`
  handlers like model-issued calls. They emit `tool_execution_*` events with
  `parentToolCallId`, and their intermediate results never reach the model.
- **Stricter:** scripts run in a QuickJS sandbox with no Node APIs, file system, network, or
  timers. pi-ptc's worker had ambient Node.js authority.
- **Added in codemode:** `store()`/`load()` keep state across calls, `models.classify()` and
  `models.generateImages()` run non-LLM models, MCP servers are built in, and `image()` adds image output.

Gaps, where pi-ptc behaviour has no documented codemode equivalent:

- **Language:** scripts are JavaScript only. pi-ptc type-stripped erasable TypeScript.
- **`artifact()`:** codemode has no way to copy an arbitrary file into session-owned storage
  and return a bounded reference. It does write truncated output and images to temp files.
- **Global limits:** codemode has no setting for a dispatch cap (pi-ptc: `maxDispatches`,
  1000), a parallel-dispatch cap (pi-ptc: 10), or a global timeout. Its documented limits are
  256 MB VM memory and the output caps above.
- **Lossless-JSON contract:** pi-ptc required lossless JSON across bindings and in results.
  Codemode adds non-string values as JSON and does not document an equivalent check.
- **Nested-call display:** pi-ptc rendered one TUI row per nested dispatch with each tool's own
  renderer. Codemode keeps a bounded `nestedCalls` record (at most 256 calls, no results) on its
  tool result. Its per-call TUI rendering is not documented, so it is unclear whether it matches.

## Historical documentation

What follows describes pi-ptc 0.1.0 on Pi 0.84.3–0.85.0 and is kept for reference only.
Open work such as the evaluation in
[#7](https://github.com/sagmans/pi-ptc/pull/7) will not continue.

> PTC runs model-written code with user-equivalent authority. Its worker is
> containment, not a sandbox. Tool-specific gate and permission extensions do
> not constrain direct Node.js operations inside a PTC program. Only nested
> `tools.*` calls pass through captured Pi tool hooks.

### When it helps

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

### Requirements

- Node `>=24.20.0`
- Pi `0.84.3`, `0.84.4`, or `0.85.0`

PTC uses an explicit verified-version allowlist and fail-closed adapter for Pi
runtime state. Package bootstrap checks the host before loading Pi-private, TUI,
or TypeBox-dependent implementation. An unsupported host stays native without
registering PTC; runtime shape drift after supported-host loading reports
`ptc: inert`. Future Pi versions require verification before joining the allowlist.

### Usage

The model calls `ptc` with two required arguments:

```ts
{
  code: string;
  description: string;
}
```

`code` is the body of an async function. PTC injects `tools`,
`ToolCallError`, `ToolResultDeliveryError`, `console`, and `artifact` into that
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

### Artifacts

`artifact` captures an existing regular file into session-owned storage and
returns a small bounded reference instead of file content:

```ts
await tools.write({ path: "report.html", content: "<h1>Report</h1>" });
return {
  report: await artifact({ path: "report.html", mimeType: "text/html" }),
};
```

The reference is `{ kind: "ptc-artifact", id, name, mimeType, bytes, path }`.
Relative paths resolve from the session working directory. The default MIME
type is `application/octet-stream`; `name` defaults to the source file name.
Copies survive worker termination and source deletion; read `path` to recover
the bytes. Captures accept regular files only.

Successful final results that exceed the byte or line limit spill automatically
to a `result.json` artifact with `application/json`; the outer payload then
carries only the reference and parsing the artifact file reconstructs the exact
lossless JSON value. Logs, failures, and nested tool values never spill.

Persistent sessions store artifacts beside the session file in a
`<session-file>.artifacts` sidecar directory. Ephemeral sessions use a
temporary process-scoped directory.

### Presentation

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

### Limits

Shipped limits live in [`config.json`](config.json). Defaults include:

- 120-second program timeout;
- 1000 dispatches per program;
- 100 progress updates per dispatch;
- 10 parallel dispatches;
- 128 MiB worker old-generation heap;
- 256,000-byte or 10,000-line outer output, checked in the worker before delivery;
  lines count CRLF, CR, and LF sequences inside string values, not JSON escapes;
- 2,000,000-byte render and 3,000,000-byte persistence budgets.

Output-limit failures report the measured byte or line count without echoing the
rejected output. A trusted project `.pi/ptc.json` overrides `~/.pi/agent/ptc.json` for presentation and `maxDispatches`.
