# MCP tool-search mode

Opt-in flag that shrinks the always-on `tools/list` payload. Off by default;
default behaviour is unchanged.

## Why

Every MCP session pays for `tools/list` before the model does any work. The
full Minutes surface serializes to roughly 33 KB (~8k tokens estimated at
chars/4), and about 45% of that is JSON Schema for tools a given session will
never call.

## Enabling it

```jsonc
{
  "mcpServers": {
    "minutes": {
      "command": "npx",
      "args": ["minutes-mcp", "--tool-search"]
    }
  }
}
```

Or set `MINUTES_MCP_TOOL_SEARCH=1` for hosts that only pass environment
variables. Accepted truthy values: `1`, `true`, `yes`, `on`.

## What changes

`tools/list` advertises three meta-tools instead of the full set:

| Tool | Purpose |
|---|---|
| `list_capabilities` | Every tool as name + one-line summary + read-only bit. No schemas. Optional `filter` substring. |
| `describe_tool` | One tool's full descriptor: description, JSON Schema, annotations, `_meta`. Identical to its default-mode `tools/list` entry. |
| `call_tool` | Invoke any tool by name with an `arguments` object. |

The deferred tools stay **registered and callable**. Only their advertisement
is withheld, by overriding the `tools/list` request handler after the SDK
installs its own. `tools/call` is untouched, so a client that has fetched a
schema through `describe_tool` can call the tool by its real name; `call_tool`
exists for clients that refuse to call a name they never saw in `tools/list`.

Argument validation, the agent trust-boundary policy wrappers, and every
handler are shared with the normal dispatch path - `call_tool` runs the same
policy-wrapped callback the SDK would have run.

## Both transports

The three meta-tools and the `tools/list` override belong to one `McpServer`
instance, and `--transport http` builds a fresh instance per session. So the
install is recorded as the last entry in the server-builder list in
`index.ts`, not called once at startup: every instance gets it, and it runs
after that instance's tools are registered. Installing it once against the
stdio singleton instead would leave HTTP sessions advertising the full
schema dump while stdio showed three.

Instance teardown drops that server's entries from the deferrable registry
(`forgetDeferrableTools`). That registry is populated on every tool
registration whether or not the mode is enabled, so the teardown is
unconditional; without it a long-lived HTTP process grows the registry by the
full tool count per session.

`crates/mcp/test/http_tool_search_prompts_test.mjs` covers the combination
over three sequential HTTP sessions.

## Trade-offs

- **MCP Apps dashboard.** Eleven tools carry `_meta.ui.resourceUri` linking
  them to the interactive dashboard. A host that discovers those tools from
  `tools/list` will not see them in tool-search mode. `describe_tool` returns
  `_meta` intact, but a host that binds UI at list time loses that binding.
  Use default mode with Claude Desktop's dashboard.
- **Round-trip cost.** A session pays the catalogue once (~5 KB) plus roughly
  1 KB per `describe_tool`. Break-even against the full list is around 23
  distinct tools per session - see the numbers below.

## Measuring it

```bash
cd crates/mcp && npm run build && npm run measure:tools-list
```

Prints both modes side by side and fails if the advertised list is not well
under the default. `--json` emits the same report as machine-readable JSON.
Observed on a 34-tool surface:

| | default | `--tool-search` |
|---|---|---|
| tools advertised | 34 | 3 |
| `tools/list` chars | 32,704 | 1,828 |
| estimated tokens | 8,176 | 457 |

Tool counts are environment-dependent, since some tools register only when the
installed CLI reports the matching capability, so the script reports what it
observes rather than asserting a fixed number.

## Tests

- `crates/mcp/src/toolSearch.test.ts` - unit tests over an in-memory transport
  (flag parsing, summaries, schema defaults, validation, server isolation).
- `crates/mcp/test/tool_search_test.mjs` - contract tests against the built
  server in both modes, including a `describe_tool` descriptor parity check
  against default-mode `tools/list` for every tool.
