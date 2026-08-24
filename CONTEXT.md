# pi-ptc

Programmatic Tool Call for Pi. The model writes one program against core tools.
Only the curated outer result re-enters model context.

## Language

**PTC**:
The presentation where the model reaches core tools only through a program,
not through native JSON tool calls.
_Avoid_: Code Mode, code execution, eval, REPL

**Transport**:
The single model-visible tool that accepts a program and a short description.
Shipped name: `ptc`.
_Avoid_: run_code, exec, eval, codemode

**Binding**:
An async host function the program calls, such as `tools.read(args)`.
_Avoid_: native tool, proxy, wrapper

**Dispatch**:
One nested execution of a core tool started by a binding.
_Avoid_: sub-tool, inner call, invoke

**Presentation**:
What the model is allowed to call on the wire: `code` (transport only for
core tools), `both`, or `native` (PTC off).
_Avoid_: mode (overloaded with Pi run mode), full code mode

**Core tool**:
One of Pi's built-in file/shell tools: `read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`.
_Avoid_: builtin (too broad), host tool

**Foreign tool**:
Any non-core tool still registered by Pi or another extension (`mcp`,
`mcpScript`, web search, and similar).
_Avoid_: MCP tool, extension tool (those are subsets)

**Canonical value**:
The lossless JSON a successful dispatch returns to the program.
_Avoid_: rendered content, Native text, tool result card

**Outer result**:
The only PTC output that re-enters model context: captured logs plus the
program's return value.
_Avoid_: transcript, tool result (ambiguous with dispatch)

**Dispatch log**:
A session-local record of each dispatch for UI and reconstruction. It does
not enter model context.
_Avoid_: telemetry, trace (overloaded)

**ToolCallError**:
The program-visible rejection for a failed dispatch. It carries `toolName`
and `message` only.
_Avoid_: failure union, error code

**Exclusive dispatch**:
A mutating core tool that must run alone (`bash`, `edit`, `write`).
_Avoid_: serial, barrier (implementation words)

**Parallel dispatch**:
A read-only core tool that may overlap (`read`, `grep`, `find`, `ls`).
_Avoid_: concurrent (too broad)
