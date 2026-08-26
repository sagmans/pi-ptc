# pi-ptc

Programmatic Tool Call for Pi. The model writes one TypeScript program against
Pi core tools. Only the curated outer result re-enters model context.

Default presentation is `code`: core tools are hidden, `ptc` is registered, and
foreign tools stay native. MCP is out of v1.

The worker isolate is bash-equivalent containment, not a sandbox.

## Install

Local checkout:

```bash
pi install /absolute/path/to/pi-ptc
```

One-off load:

```bash
pi -e /absolute/path/to/pi-ptc
```

Requires Node `>=22.19.0` and Pi `>=0.84.1`.

## Usage

The model calls `ptc` with a program body:

```ts
const [pkg, ts] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "tsconfig.json" }),
]);
return { pkg: pkg.text, ts: ts.text };
```

Slash command:

```text
/ptc on     # hide core tools, keep ptc
/ptc both   # core tools + ptc
/ptc off    # native core tools, no ptc
```

Project `.pi/ptc.json` wins over `~/.pi/agent/ptc.json`.

## Display

Nested core dispatches reuse Pi's native tool components, including read ranges,
streaming output, edit diffs, expansion, and error states. The outer `ptc` shell,
program, and curated return stay hidden. Full nested results reach the renderer
through in-memory state and are not serialized into model-visible dispatch details.

## Coexistence

Keep `pi-mcp-adapter`. `mcp` and `mcpScript` stay native.

Do not install `pi-fabric` or `pi-retype` beside this package. Both steal
`setActiveTools`. If those transports are already registered, pi-ptc stays inert.

## Honest gap

Pi 0.84 has no public `invokeTool`. Nested factory execute skips other
extensions' `tool_call` gates. Cooperating extensions can observe
`pi-ptc:dispatch`.
