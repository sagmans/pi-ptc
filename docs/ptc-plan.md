# PTC architecture

This document records the implemented architecture of `pi-ptc` for Pi
`0.84.3`.

## Goal

PTC replaces repeated model/tool round trips with one TypeScript program:

```text
model -> ptc program -> active Pi tools -> { logs, result? } -> model
```

Intermediate dispatch results stay in the program. Nested rows and bounded
session details remain visible to the user without entering model context.

## Tool surface

PTC separates Pi's logical active set from the schemas shown to the model.

| Presentation | Model-visible set |
|---|---|
| `code` | `ptc` |
| `both` | logical active tools plus `ptc` |
| `native` | logical active tools |

The logical set can contain built-in, SDK, extension, and adapter-provided tools.
PTC never activates a registered tool merely because it exists.

## Runtime capture

`src/pi-runtime.ts` installs an exact-version adapter around Pi's bound
session. It captures:

- executable tools and render definitions;
- active-tool actions and refreshes;
- before/after tool hooks;
- tool execution events;
- reload and shutdown ownership.

The adapter validates private runtime shapes before taking ownership. Version
or shape drift leaves PTC inert and preserves native tools.

`src/tool-catalog.ts` virtualizes active state. Refreshes preserve still-valid
logical tools, drop removed tools, and adopt newly active registrations. A
failed refresh attempts rollback and native restoration. Unverified recovery stays
inert and reports diagnostics.

Each PTC call receives a sorted catalog snapshot. Tool and renderer changes
apply to the next call, never midway through a running program.

## Program execution

`src/transport.ts` accepts:

```ts
{
  code: string;
  description: string;
}
```

Execution follows this path:

1. `src/sdk.ts` renders stable model guidance from active schemas.
2. `src/runtime.ts` type-strips erasable TypeScript.
3. A fresh `worker_threads.Worker` starts with an empty environment and bounded heap.
4. `src/worker.ts` exposes one async binding per snapshot entry.
5. Calls cross the worker boundary as lossless JSON.
6. `src/tool-executor.ts` prepares, validates, gates, executes, and finalizes the Pi tool.
7. `src/canonical.ts` returns canonical JSON or throws `ToolCallError`.
8. The worker returns captured logs and an optional JSON result.

The worker is killable containment, not a sandbox. Model code has
user-equivalent host authority.

## Dispatch lifecycle

A dispatch receives a unique nested call ID and emits Pi execution start,
update, and end events. Captured before-tool hooks may mutate or block the call;
after-tool hooks may replace content, details, usage, termination, or error
state.

Arguments are prepared and validated against the captured schema. Core tools
retain specialized return shapes. Other tools receive this canonical envelope:

```ts
{
  text: string;
  content: Array<TextBlock | ImageBlock>;
  details?: JsonValue;
  usage?: JsonValue;
}
```

A tool result with additive `addedToolNames` updates the logical set for later
PTC runs.

## Scheduling and cancellation

Tools with `executionMode: "sequential"` run exclusively; tools with
`executionMode: "parallel"` may overlap. Without an explicit mode, `bash`,
`edit`, and `write` are exclusive and other tools are parallel.

Exclusive work waits for active parallel work to drain. Queue order is stable.
Abort propagates to queued and active tools, terminates the worker, drains host
bindings within the configured deadline, and rejects late reports.

## Context and persistence

Only serialized `{ logs, result? }` content reaches the model. Dispatch logs,
render details, and live attachments stay model-hidden.

Versioned dispatch details retain bounded arguments, previews, and render data.
Whole native results are omitted when a budget is exhausted; partial native
objects are never persisted. Historical unversioned details migrate on read,
and malformed details render a diagnostic.

## Rendering

PTC owns the outer shell and one row per dispatch. The outer program card stays
empty. Rows use:

1. Pi built-in definitions for core tools;
2. captured execution-scoped definitions for other tools;
3. bounded generic text when no safe renderer is available.

Renderer failures, timers, invalidation, terminal controls, images, and theme
changes remain contained inside the affected PTC row.

## Fail-closed conditions

PTC restores or preserves native tools when:

- Pi is not the verified version or runtime validation fails;
- the `ptc` transport is missing;
- `fabric_exec`, `retype`, or `execute_tools` owns the tool surface;
- catalog refresh, rollback, or restoration cannot be verified.

## Invariants

1. `code` exposes only `ptc` to the model.
2. Bindings come only from one logical active-set snapshot.
3. Intermediate dispatch values never enter model context.
4. Direct hidden-tool calls are blocked; marked nested calls pass captured hooks.
5. Running programs do not observe tool or renderer refreshes.
6. Exclusive dispatches never overlap another dispatch.
7. Abort owns worker and nested-dispatch lifetime.
8. PTC never claims to be a security boundary.

## Verification

```bash
npm run verify
npm run test:bun
```

Node tests cover runtime capture, virtualization, schemas, execution lifecycle,
scheduling, cancellation, canonical JSON, retention, persistence, and rendering.
Bun smoke tests cover the worker and Pi renderer bindings used by the shipped
host.
