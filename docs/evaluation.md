# PTC evaluation harness

Reproducible session-level measurement of PTC transport tradeoffs against
native tool calling. Lives in [`eval/`](../eval) and stays out of the npm
package.

## Matrix

Exactly 16 runs:

```text
2 models × 2 cases × 2 conditions × 2 repetitions
```

- `openai-codex:gpt-5.6-sol:medium`
- `zai:glm-5.3:max`

Anthropic is forbidden by configuration and rejected by validation. Repetition
two reverses the condition order to reduce simple ordering bias. Runs execute
sequentially.

## Conditions

| Condition | pi-ptc loaded | Model-visible tools |
|---|---|---|
| `absent` | no | logical active set |
| `code` | yes | `ptc` only |

pi-ptc is code-only: when loaded, the model sees exactly `ptc`. There are no
other presentations. Every condition loads `eval/observer.ts`, which records
only the serialized byte size of each provider request in a model-hidden
session entry. Payload contents, headers, credentials, and environment values
are never persisted.

## Cases

Both cases use synthetic workspaces and deterministic non-LLM judges. Prompts
require filesystem access through active tools only and require exactly one
final `EVAL_RESULT {…}` JSON line.

- **dependent-reads** creates record files whose first line controls inclusion
  and whose second line holds an integer; the model must find included
  records, read only those, and return the sorted names plus exact sum.
  Active tools: `read`, `grep`.
- **paged-read** creates a 6,000-line file with a unique target near the end;
  only `read` is active, forcing data-dependent offset pagination.

## Terminal-Bench 2.1 pilot

A separate 16-run matrix adds one adapted public task:

```text
2 models × 1 case × 4 conditions × 2 repetitions
```

The `large-scale-text-editing` case creates a deterministic CSV file with
1,000,000 rows. The agent must transform the file with three distinct Vim
macros that use fewer than 200 keystrokes. The active tools are `read`,
`write`, and `bash`.

The judge discards the agent's transformed file and creates the input again.
It checks the script commands and macro definitions. Then it runs Vim and
compares the output SHA-256 hash with a generated hash. No answer file exists
when the agent runs.

This case adapts the Terminal-Bench 2.1 task
[`large-scale-text-editing`](https://github.com/harbor-framework/terminal-bench-2-1/tree/main/tasks/large-scale-text-editing).
It does not use the upstream container or Harbor runner. Thus, its results are
not official Terminal-Bench leaderboard results. See the
[attribution and task digest](../eval/terminal-bench/NOTICE.md).

The pilot requires Vim on `PATH`. The agent gets 20 minutes to finish the task.
The judge gives Vim 10 minutes to transform the file.

## Metrics

Per run: correctness, assistant turns, visible tool calls, ptc calls, native
tool calls, nested dispatches (`ptc-dispatch` session entries, never counted
as model-visible calls), provider request bytes, visible tool-result bytes,
input/output/cache tokens, cost, wall time, and tool errors.

## Cost cap

USD 50 is a best-effort stop. The harness never starts a new run once observed
cumulative cost reaches the cap and requests an abort for the in-flight run
when completed cost plus current streamed cost reaches it. Provider cost
reporting can lag, so overshoot is possible and recorded.

## Commands

```bash
npm run eval:ptc:dry                  # validate the 16-run core matrix
npm run eval:ptc                      # run the core matrix
npm run eval:ptc:terminal-bench:dry   # validate the 8-run pilot matrix
npm run eval:ptc:terminal-bench       # run the pilot matrix
```

The dry-run commands make zero provider calls.

## Heavy tool-use matrix

A separate 8-run matrix measures total tokens, wall time, assistant turns, and
visible tool calls with and without PTC on one tool-heavy task:

```bash
npm run eval:heavy:dry   # validate the 8-run heavy matrix
npm run eval:heavy        # run the heavy matrix
```

The `transitive-ledger` case spreads 160 account files over `ledger/`; 65 are
open and reachable from three seeds through counterparty edges (depth 7, with
cycles, closed-account and missing-file decoys). Natively this needs dozens of
data-dependent reads; under code presentation one program can traverse the same
graph with model-hidden nested dispatches. The case is machine-generated with a
fixed seed (`20260904`); per-run JSON already records `totalTokens`,
`wallTimeMs`, `assistantTurns`, and `visibleToolCalls` with the
ptc/native split, so the comparison needs no extra instrumentation.

## Code-vs-absent matrix

A 36-run binary matrix compares code against absent across 9 model
configurations: 9 models × `transitive-ledger` × `absent`/`code` × 2
repetitions.

```bash
npm run eval:code-vs-absent:dry   # validate the 36-run matrix
npm run eval:code-vs-absent       # run the matrix
```

Conditions may be any non-empty unique subset of the two canonical
conditions. Model IDs must match
`pi --list-models` exactly (for example `qwen3.8-max`, not `qwen-3.8`).

## Code-proof matrix

A 120-run binary matrix built to justify code-only: 10 model
configurations (including `xai/grok-4.6`) × three dramatic cases
(`scatter-gather`, `cursor-walk`, `noisy-ledger`) × `absent`/`code` × 2
repetitions. Each case is noise-padded to defeat bulk-dump shortcuts and
force honest per-file work.

```bash
npm run eval:proof:dry   # validate the 120-run matrix
npm run eval:proof       # run the matrix
```

CAUTION: Run an evaluation only in a disposable, non-production workspace.
The agent has user-equivalent host authority, and provider calls cost money.

Runs persist under `.ptc-eval/run-<timestamp>/`: raw RPC JSONL, copied Pi
session JSONL, per-run JSON (written atomically after each run for resume),
`summary.json`, and `summary.md`. The directory is git-ignored; never commit
sessions or reports. To resume, pass `--resume <run-directory>` to
`eval/run.ts`.

## Parallel execution

Pass `--jobs N` to run up to N cells concurrently (default 1). Each cell keeps
an isolated workspace, session directory, RPC log, and result file, so cells
share nothing but the cost accumulator and the results list. A crashed cell
writes `<key>.error.json` and never kills its siblings; error records are
skipped on resume, so the next run retries exactly the crashed cells. The
budget start gate stays best-effort under concurrency: cells already running can
push observed spend past the cap before the next dispatch notices, exactly like
provider cost-reporting lag. Keep host sleep disabled during parallel runs
(`caffeinate -is` on macOS); a suspended RPC wait still times out on wake.

## Interpretation limits

Two repetitions per cell cannot support statistical significance claims.
Report per-condition medians and deltas against `absent` descriptively, and
report both repetitions individually.
