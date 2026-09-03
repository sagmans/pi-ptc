# PTC architecture

This document records the implemented architecture of `pi-ptc` for verified Pi
versions `0.84.3` and `0.84.4`.

## Goal

PTC replaces repeated model/tool round trips with one TypeScript program:

```text
model -> ptc program -> active Pi tools -> { logs, result? } -> model
```

Intermediate dispatch results stay in the program. Nested rows and bounded
session details remain visible to the user without entering model context.

The program's `artifact` helper and automatic final-result spill write through
a model-hidden path in the worker: sources are copied into session-owned
storage with user-equivalent filesystem authority, and the model-visible outer
payload carries only the bounded artifact reference.

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

`src/package-bootstrap.ts` checks Pi's explicit verified-version allowlist before
importing private-runtime, TUI, or TypeBox-dependent implementation. Host peer
ranges stay open for Pi package resolution, while the adapter accepts only Pi
`0.84.3` and `0.84.4`. Future versions remain fail-closed until verified.

`src/pi-runtime.ts` is the façade for the exact-version adapter. Internal
modules own shape checks, global registries and patch leases, session
association, active-tool actions, hooks/events, argument preparation, and
session capture. Association state and stale/current guards have one owner;
pure shape validation does not mutate lifecycle state.

The adapter captures:

- executable tools and render definitions;
- active-tool actions and refreshes;
- Pi argument preparation and schema validation;
- before/after tool hooks;
- tool execution events;
- reload and shutdown ownership.

Version or private-shape drift leaves PTC inert and preserves native tools.
`src/pi-runtime-association.ts` alone publishes slots and mutates generation,
parts, and installed-capability state. Mixed module copies share versioned
global registries and release independent leases without removing another
copy's patches. Downgrading the complete extension lifecycle requires restarting
Pi; same-process coexistence does not claim full-lifecycle hot rollback.

`src/tool-catalog.ts` owns logical active state and additive activation.
Refreshes preserve still-valid logical tools, drop removed tools, and adopt
newly active registrations. A failed refresh attempts rollback and native
restoration. Unverified recovery stays inert and reports diagnostics.

Lifecycle issues each PTC call an immutable execution lease containing its
sorted catalog snapshot, dispatch capability, generation guard, and failure
transition. Execution captures renderer definitions from that snapshot. Tool and
renderer changes apply to the next call, never midway through a running program.

## Program execution

`src/transport.ts` accepts:

```ts
{
  code: string;
  description: string;
}
```

Execution follows this path:

1. `src/sdk.ts` renders stable guidance, reference schemas, and compact examples.
2. `src/runtime.ts` type-strips the async-function body.
3. A fresh `worker_threads.Worker` starts with an empty environment and bounded heap.
4. `src/worker-bindings.ts` injects one async binding per snapshot entry.
5. Calls cross the worker boundary as lossless JSON after worker-side argument
   and outer-result byte checks.
6. `src/tool-executor.ts` orchestrates the captured Pi argument, hook, event,
   execution, and finalization capabilities.
7. `src/canonical.ts` returns canonical JSON or throws `ToolCallError`.
8. The worker exposes `ToolCallError` and `ToolResultDeliveryError` to the program.
9. Failure paths preserve stable codes, causes, resolutions, and retry safety.
10. The worker returns captured logs and an optional JSON result. Output-limit
    failures report only their scope, measured count, configured limit, and limit
    name. Rejected output is never echoed.

Published tarballs include a precompiled worker graph because Node does not strip
TypeScript below `node_modules`. Checkout development retains the source-worker
fallback. Package smoke executes the installed worker before loading the extension
through Pi.

The worker is killable containment, not a sandbox. Model code has
user-equivalent host authority. PTC reports program errors but does not rewrite
or retry model code.

## Dispatch lifecycle

A dispatch receives a unique nested call ID and emits Pi execution start,
update, and end events. Each dispatch accepts at most the configured number of
progress updates; later updates are ignored while finalization still runs.
Captured before-tool hooks may mutate or block the call; after-tool hooks may
replace content, details, usage, termination, or error state.

Arguments are prepared and validated against the captured schema. Core tools
retain specialized return shapes. Core `read` returns `.text` plus truncation
metadata, omitting the duplicate `truncation.content` body. Other tools receive
this canonical envelope:

```ts
{
  text: string;
  content: Array<TextBlock | ImageBlock>;
  details?: JsonValue;
  usage?: JsonValue;
}
```

A tool result with additive `addedToolNames` asks the catalog owner to activate
available registrations for later PTC runs. Built-in, SDK, extension, and
adapter-backed tools such as MCP all use this schema-derived path; no fixed-name
allowlist selects arbitrary tools.

## Scheduling and cancellation

Tools with `executionMode: "sequential"` run exclusively; tools with
`executionMode: "parallel"` may overlap. Without an explicit mode, `bash`,
`edit`, and `write` are exclusive and other tools are parallel.

Exclusive work waits for active parallel work to drain. Queue order is stable.
Abort propagates to queued and active tools, terminates the worker, drains host
bindings within the configured deadline, and rejects late reports.
`src/orphan-binding-governor.ts` stores one versioned process-global governor,
so concurrent workers and separately loaded physical module copies share the
same conservative unresolved-binding ceiling.

## Context and persistence

Only serialized `{ logs, result? }` content reaches the model. Dispatch logs,
render details, and live attachments stay model-hidden.

Versioned dispatch details retain bounded arguments, previews, and render data.
Lifecycle leases reject failure-detail writes after release or generation
revocation. `src/dispatch-retention.ts` owns execution-scoped accounting. Replacement and
clear operations reclaim their exact retained capacity. Whole native results are
omitted when a budget is exhausted; partial native objects are never persisted.
Failure details are consume-once and cleared by lifecycle shutdown,
reload, or inert recovery. Historical unversioned details migrate on read, and
malformed details render a diagnostic.

## Rendering

PTC owns the outer shell and one row per dispatch. The outer program card stays
empty. Rows use:

1. Pi built-in definitions for core tools;
2. captured execution-scoped definitions for other tools;
3. bounded generic text when no safe renderer is available.

Renderer storage separates two policies. Each transport instance owns a
revocable raw store; custom arguments/results require its exact in-memory
details object and never permit call-ID lookup. Lifecycle clear revokes existing
and late-settling raw attachments. Bounded renderer definitions may be restored
by execution token and call ID after versioned details replacement.

Renderer failures, timers, invalidation, terminal controls, images, and theme
changes remain contained inside the affected PTC row.

## Fail-closed conditions

PTC restores or preserves native tools when:

- package bootstrap cannot verify an allowlisted Pi version, or runtime validation fails;
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
9. Adapter approval, authentication, and OAuth remain adapter-owned.
10. Result-delivery failure never masquerades as a retry-safe tool failure.

## Verification

```bash
npm run verify
npm run test:bun
```

Node tests cover runtime capture, virtualization, schemas, execution lifecycle,
scheduling, cancellation, canonical JSON, retention, persistence, rendering,
mixed-copy patch/adapter coexistence, baseline details readers, and a real MCP
adapter path. Bun smoke tests cover the
worker and Pi renderer bindings used by the shipped host.
