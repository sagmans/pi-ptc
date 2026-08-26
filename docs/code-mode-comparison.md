# pi-ptc compared with PTC and Code Mode implementations

Scope: current `feat-ptc-plan` working tree.

```text
pi-ptc
├─ Shape
│  ├─ One model-visible `ptc` transport
│  ├─ Handwritten TypeScript SDK for Pi's seven core tools
│  ├─ Foreign and MCP tools remain native
│  └─ Fresh local worker for every call
├─ Closest relative: DeepSeek Harness Code Mode
│  ├─ Shared
│  │  ├─ `native` / `code` / `both` presentation ownership
│  │  ├─ Type-stripped programs over async bindings
│  │  ├─ Canonical JSON and `ToolCallError`
│  │  ├─ Parallel reads plus exclusive mutations
│  │  ├─ Fresh worker, empty environment, heap/time/output limits
│  │  └─ Worker containment explicitly is not a security boundary
│  ├─ pi-ptc stronger for Pi UX
│  │  ├─ Hides the outer transport card
│  │  ├─ Shows every nested dispatch as a separate native-like row
│  │  ├─ Shows compact output previews
│  │  └─ Keeps unrelated Pi extensions visible
│  └─ DSH stronger as a general harness
│     ├─ Generates argument and output types from the live visible registry
│     ├─ Routes nested calls through the complete host policy pipeline
│     ├─ Supports arbitrary visible tool names and TypeScript/Python runtimes
│     ├─ Logs richer reconstructable nested-call events
│     └─ Separates canonical values from native/rich presentation more completely
├─ Anthropic Programmatic Tool Calling
│  ├─ Model writes Python in provider-hosted Code Execution
│  ├─ Eligible tools opt in through `allowed_callers`
│  ├─ Intermediate results remain in the program; final output reaches Claude
│  ├─ Provider owns container lifecycle and isolation
│  └─ Trade-off: stronger execution boundary, less local runtime/UI control
├─ Cloudflare Code Mode
│  ├─ Generates TypeScript definitions; executes JavaScript
│  ├─ Runs each pass in an isolated Dynamic Worker
│  ├─ Blocks Node APIs, credentials, and outbound network by default
│  ├─ Supports namespaced connectors, MCP, OpenAPI, and custom tools
│  ├─ Supports `search()` / `describe()` progressive discovery
│  ├─ Durable runtime adds approvals, replay, rollback, history, and snippets
│  └─ Trade-off: broadest platform feature set, but Cloudflare runtime complexity
└─ Pydantic AI Harness CodeMode
   ├─ Runs Python in Monty with no ambient host access
   ├─ Selects all, named, predicate-matched, or metadata-tagged tools
   ├─ Integrates deferred tool discovery and cache-stable catalogs
   ├─ Keeps REPL state across `run_code` calls in one agent run
   ├─ Bounds heap, execution time, printed output, and nested-call count
   └─ Trade-off: stronger local sandbox and richer agent integration, but Python/Rust stack
```

## Assessment

`pi-ptc` is best described as **DSH-shaped, Pi-specialized Code Mode**, not a
general Code Mode platform.

Its distinctive advantage is presentation: user sees each real core-tool dispatch
and preview while the orchestration transport stays hidden. None of the compared
reference designs makes that Pi-native UX its primary contract.

Its main gaps are:

1. **Policy re-entry** — official Pi factories bypass other extensions'
   `tool_call` / `tool_result` gates because Pi 0.84 has no public nested invoke API.
   DSH nested calls traverse its complete registry pipeline.
2. **Isolation** — the Node worker is killable containment, but model code retains
   ambient Node authority. Cloudflare Dynamic Workers, Monty, and Anthropic Code
   Execution provide stronger boundaries.
3. **Schema breadth** — the SDK and canonical mappings are handwritten for seven
   tools. DSH, Cloudflare, and Pydantic project live tool definitions.
4. **Execution controls** — concurrency, wall time, heap, and output are bounded,
   but total nested-call count is not. Pydantic reserves a configurable call budget.
5. **Durability** — each call starts clean and nested logs are thin. Cloudflare adds
   pause/approval/replay/rollback; Pydantic retains run-local REPL state.

## Recommendation

Keep current v1 scope. It fits trusted local Pi coding better than importing a
larger sandbox or connector framework.

Priority order before broadening scope:

1. Switch nested dispatches to a future public Pi invoke/policy path.
2. Add a total dispatch budget.
3. Generate SDK argument/output declarations if foreign tools become eligible.
4. Add a real sandbox only if the product claim changes from bash-equivalent local
   code to untrusted or multi-tenant execution.
5. Add replay, approvals, or persistent state only for evidenced workflows.

## Sources

### Local implementation

- `src/index.ts` — presentation ownership and foreign-tool coexistence
- `src/runtime.ts`, `src/worker.ts` — worker lifecycle and trust boundary
- `src/bridge.ts`, `src/scheduler.ts` — canonical dispatch and scheduling
- `src/sdk.ts` — fixed model-facing SDK
- `src/renderer.ts`, `src/transport.ts` — hidden transport and nested dispatch UI
- `README.md`, `SECURITY.md` — documented trust posture and Pi invoke gap

### Primary external sources

- Anthropic, [Programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
- Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Cloudflare, [Code Mode overview](https://developers.cloudflare.com/agents/tools/codemode/)
- Cloudflare, [How Code Mode works](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)
- Cloudflare, [`@cloudflare/codemode` README](https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md)
- DeepSeek Harness, [`code-mode.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/code-mode.ts)
- DeepSeek Harness, [Code Mode foundation](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-code-mode.md)
- DeepSeek Harness, [Typed tool returns](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-20-code-mode-typed-tool-returns.md)
- Pydantic, [AI Harness Code Mode](https://pydantic.dev/docs/ai/harness/code-mode/)
- Pydantic, [Monty](https://pydantic.dev/docs/monty/get-started/)
