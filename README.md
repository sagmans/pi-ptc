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

Requires Node `>=22.19.0`. TUI integration is verified against Pi `0.84.3`.
Pi supplies the bundled coding-agent, TUI, and TypeBox peer dependencies; local
compatibility tests keep those development dependencies pinned to the verified host.

Repeat the Node and Bun compatibility gates with:

```bash
npm run verify
npm run test:bun
```

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

PTC owns each nested row and invokes Pi's public built-in tool-definition renderers.
This preserves native read ranges, streaming output, edit diffs, expansion, and
error states without nesting Pi's host tool component. The outer `ptc` shell,
program, and curated return stay hidden.

Version-2 display details persist bounded native results so resumed sessions rebuild
rows without an in-memory cache. When the configured render-detail byte budget is
exhausted, the whole native result is omitted deterministically and the row uses its
bounded preview. Historical unversioned details are migrated on read; malformed
records produce a display diagnostic instead of disappearing.

Nested images are limited to the row's current viewport width. Pi `0.84.3` does not
expose the host image-width preference through its renderer context, so PTC cannot
mirror that separate setting.

## Coexistence

Keep `pi-mcp-adapter`. `mcp` and `mcpScript` stay native.

Do not install `pi-fabric` or `pi-retype` beside this package. Both steal
`setActiveTools`. If those transports are already registered, pi-ptc stays inert.

## Honest gap

Pi 0.84 has no public `invokeTool`. Nested factory execute skips other
extensions' `tool_call` gates. Cooperating extensions can observe
`pi-ptc:dispatch`.
