# pi-ptc language

Use these terms consistently in code, documentation, and reviews.

**PTC**  
The presentation where the model reaches Pi tools through one program instead
of direct tool calls.

**Transport**  
The single model-visible tool that accepts a TypeScript program and UI label.
Shipped name: `ptc`.

**Active runtime tool**  
A built-in, SDK, extension, or adapter-provided tool in Pi's logical active set.
Registered but inactive tools are not included.

**Core tool**  
One of Pi's built-in file and shell tools: `read`, `bash`, `edit`,
`write`, `grep`, `find`, or `ls`. Core tools have specialized canonical
return shapes and built-in renderer fallbacks.

**Logical active set**  
The tools Pi and its extensions consider active. PTC preserves this set while
changing model visibility.

**Model-visible set**  
The schemas sent to the model: `ptc` only for `code`, `ptc` plus the
logical set for `both`, or the logical set for `native`.

**Catalog snapshot**  
The fixed, sorted active-tool definitions used by one PTC execution for
bindings, SDK guidance, validation, and rendering.

**Execution lease**  
The immutable per-call capabilities issued by lifecycle ownership: catalog
snapshot, dispatch adapter, generation guard, and failure transition. Renderer
definitions are captured from the leased snapshot by execution.

**Binding**  
An async function exposed to the program, such as `tools.read(args)` or
`tools.mcp(args)`.

**Dispatch**  
One nested tool execution started by a binding.

**Canonical value**  
Lossless JSON returned from a successful dispatch to the program. Core tools
use specialized shapes; other tools receive `text`, `content`, and optional
`details` and `usage`.

**Outer result**  
The only PTC value sent back to model context: captured logs plus the program's
optional return value.

**Dispatch log**  
A model-hidden session entry emitted for each settled dispatch. Persisted row
details are stored separately.

**ToolCallError**  
The program-visible rejection for a failed tool dispatch. It contains
`toolName` and `message`.

**ToolResultDeliveryError**  
The program-visible rejection when execution may have completed but its result
could not be delivered. It must not be treated as proof that retry is safe.

**Renderer definition**  
A bounded renderer capability restorable by execution token and call ID.

**Raw renderer attachment**  
Sensitive custom-renderer arguments and result retained only for the exact
in-memory details object. Call-ID lookup is forbidden.

**Parallel dispatch**  
A dispatch allowed to overlap under the configured limit.

**Exclusive dispatch**  
A dispatch that drains parallel work and runs alone. Sequential Pi tools are
exclusive; `bash`, `edit`, and `write` are exclusive fallbacks.

**Presentation**  
The tool-surface setting: `code`, `both`, or `native`.

**Inert**  
Fail-closed state where PTC does not own the tool surface and Pi keeps native
tools active.

**Process governor**  
Process-wide owner of unresolved worker-binding capacity across concurrent PTC
runs.

**Retention ledger**  
Execution-scoped accounting for bounded renderer and persisted dispatch data.
