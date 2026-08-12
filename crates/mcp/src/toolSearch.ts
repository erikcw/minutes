/**
 * Opt-in tool-search mode (`--tool-search` / `MINUTES_MCP_TOOL_SEARCH=1`).
 *
 * Default behaviour is untouched: `tools/list` returns all Minutes tools with
 * full JSON Schemas. That is roughly 33 KB of context that every session pays
 * for whether or not a single meeting tool gets called.
 *
 * With tool-search enabled, `tools/list` returns only three meta-tools:
 *
 *   list_capabilities  - every tool's name + one-line summary, no schemas
 *   describe_tool      - the full descriptor (schema, annotations) for one tool
 *   call_tool          - invoke any tool by name with an arguments object
 *
 * The deferred tools stay *registered and callable*. Only their advertisement
 * is withheld, by overriding the `tools/list` request handler after the SDK has
 * installed its own. `tools/call` is left completely alone, so a client that
 * has fetched a schema via `describe_tool` may either call the tool by its real
 * name or route through `call_tool`. Nothing about dispatch, argument
 * validation, or the agent trust-boundary policy wrappers changes.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** CLI flag that turns the mode on. */
export const TOOL_SEARCH_FLAG = "--tool-search";
/** Environment variable equivalent, for hosts that only pass env. */
export const TOOL_SEARCH_ENV = "MINUTES_MCP_TOOL_SEARCH";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Tool-search is opt-in from either the command line or the environment.
 * Hosts that build their own argv (Claude Desktop extensions, `npx` wrappers)
 * often find one easier to set than the other.
 */
export function isToolSearchEnabled(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (argv.includes(TOOL_SEARCH_FLAG)) return true;
  const raw = env[TOOL_SEARCH_ENV];
  return typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase());
}

/** A tool that tool-search mode may hide from `tools/list`. */
export interface DeferrableTool {
  server: McpServer;
  name: string;
  tool: RegisteredTool;
}

const deferrable: DeferrableTool[] = [];

/**
 * Record a registered tool so tool-search mode can advertise it lazily.
 *
 * Called from the two registration funnels in `index.ts`. The `RegisteredTool`
 * is captured by reference, so later `update()`/`disable()` calls are reflected
 * without any bookkeeping here. Registrations are keyed by server instance
 * because unit tests register throwaway tools against their own `McpServer`.
 */
export function recordDeferrableTool(
  server: McpServer,
  name: string,
  tool: RegisteredTool
): void {
  const existing = deferrable.findIndex(
    (entry) => entry.server === server && entry.name === name
  );
  if (existing >= 0) {
    deferrable[existing] = { server, name, tool };
    return;
  }
  deferrable.push({ server, name, tool });
}

/** Tools recorded against one server, in registration order. */
export function deferrableToolsFor(server: McpServer): DeferrableTool[] {
  return deferrable.filter((entry) => entry.server === server);
}

/**
 * Drop every registration recorded against one server.
 *
 * The registry is process-global and keyed by instance, which was fine when
 * there was exactly one long-lived server. With the HTTP transport each
 * session builds its own, so without this the array grows by the full tool
 * count per session and never shrinks — and `recordDeferrableTool` scans it
 * linearly, so the cost of registering session N grows with N.
 */
export function forgetDeferrableTools(server: McpServer): void {
  for (let i = deferrable.length - 1; i >= 0; i--) {
    if (deferrable[i].server === server) {
      deferrable.splice(i, 1);
    }
  }
}

/** Test seam: drop every recorded registration. */
export function resetDeferrableTools(): void {
  deferrable.length = 0;
}

/**
 * Wrap a raw Zod shape into an object schema. The SDK stores whatever was
 * passed to `server.tool()` - a raw shape for every Minutes tool - and
 * normalizes it only when serving `tools/list`.
 */
function asObjectSchema(schema: unknown): z.ZodType | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const candidate = schema as Record<string, unknown>;
  if (candidate._zod || candidate._def) return schema as z.ZodType;
  return z.object(schema as z.ZodRawShape);
}

/**
 * Convert to JSON Schema with the exact options the SDK's `tools/list` uses
 * (`draft-7`, input side of any pipe), so a `describe_tool` schema is
 * byte-identical to what default mode advertises. The parity is asserted for
 * every tool in `test/tool_search_test.mjs`.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> {
  const object = asObjectSchema(schema);
  if (!object) return { type: "object", properties: {} };
  return z.toJSONSchema(object, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
}

/** The `tools/list` entry a tool would have produced in default mode. */
export function toolDescriptor(name: string, tool: RegisteredTool): Record<string, unknown> {
  return {
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  };
}

/**
 * Every tool description carries a trailing docs URL (see `withToolDocs`).
 * The catalogue is a routing aid, not documentation - drop it there.
 */
export function summarize(description: string | undefined, maxLength = 160): string {
  const withoutDocs = (description ?? "").replace(/\s*Docs:\s*https?:\/\/\S+\s*$/, "").trim();
  if (withoutDocs.length <= maxLength) return withoutDocs;
  const sentenceEnd = withoutDocs.indexOf(". ");
  if (sentenceEnd > 0 && sentenceEnd + 1 <= maxLength) {
    return withoutDocs.slice(0, sentenceEnd + 1);
  }
  return `${withoutDocs.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * Compact JSON, and only in `content` - no `structuredContent` mirror.
 * These tools exist to cut context, and a host that surfaces both fields to
 * the model would pay for the same payload twice.
 */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function unknownToolMessage(name: string, known: string[]): string {
  const suggestions = known
    .filter((candidate) => candidate.includes(name) || name.includes(candidate))
    .slice(0, 5);
  const hint = suggestions.length
    ? ` Did you mean: ${suggestions.join(", ")}?`
    : " Call list_capabilities for the catalogue.";
  return `Unknown tool "${name}".${hint}`;
}

const LIST_CAPABILITIES_DESCRIPTION =
  "List every Minutes tool as name + one-line summary, without input schemas. " +
  "Fetch a schema with describe_tool, then invoke the tool by its own name or through call_tool.";

const DESCRIBE_TOOL_DESCRIPTION =
  "Return one tool's full descriptor: description, JSON Schema, and safety annotations.";

const CALL_TOOL_DESCRIPTION =
  "Invoke any Minutes tool by name. Arguments are validated against that tool's schema, " +
  "which describe_tool returns.";

/**
 * Install tool-search mode on an already-populated server: register the three
 * meta-tools, then replace the SDK's `tools/list` handler so only those three
 * are advertised.
 *
 * Must run after every tool registration and before `connect()`. Overriding is
 * safe: `Protocol.setRequestHandler` replaces by method name, and the SDK's
 * one-shot `assertCanSetRequestHandler` guard only fires during its own lazy
 * init, which the first tool registration already completed.
 */
export function installToolSearchMode(server: McpServer): {
  deferredCount: number;
  metaToolNames: string[];
} {
  const deferred = deferrableToolsFor(server);
  const byName = new Map(deferred.map((entry) => [entry.name, entry.tool]));
  const knownNames = deferred.map((entry) => entry.name);

  const metaTools = new Map<string, RegisteredTool>();

  metaTools.set(
    "list_capabilities",
    server.tool(
      "list_capabilities",
      LIST_CAPABILITIES_DESCRIPTION,
      {
        filter: z
          .string()
          .max(128)
          .optional()
          .describe("Case-insensitive substring matched against name and summary"),
      },
      {
        title: "List Capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async ({ filter }: { filter?: string }) => {
        const needle = filter?.trim().toLowerCase();
        // Name, one line, and the read-only bit. Everything else - title,
        // schema, the remaining hints - is what describe_tool is for.
        const tools = deferred
          .map((entry) => ({
            name: entry.name,
            summary: summarize(entry.tool.description),
            read_only: entry.tool.annotations?.readOnlyHint === true,
          }))
          .filter(
            (entry) =>
              !needle ||
              entry.name.toLowerCase().includes(needle) ||
              entry.summary.toLowerCase().includes(needle)
          );
        return jsonResult({ count: tools.length, total: deferred.length, tools });
      }
    )
  );

  metaTools.set(
    "describe_tool",
    server.tool(
      "describe_tool",
      DESCRIBE_TOOL_DESCRIPTION,
      {
        name: z.string().min(1).max(128).describe("Tool name from list_capabilities"),
      },
      {
        title: "Describe Tool",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async ({ name }: { name: string }) => {
        const tool = byName.get(name) ?? metaTools.get(name);
        if (!tool) return errorResult(unknownToolMessage(name, knownNames));
        return jsonResult(toolDescriptor(name, tool));
      }
    )
  );

  metaTools.set(
    "call_tool",
    server.tool(
      "call_tool",
      CALL_TOOL_DESCRIPTION,
      {
        name: z.string().min(1).max(128).describe("Tool name from list_capabilities"),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments object matching that tool's input schema"),
      },
      {
        title: "Call Tool",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }, extra: any) => {
        const tool = byName.get(name);
        if (!tool) return errorResult(unknownToolMessage(name, knownNames));

        const schema = asObjectSchema(tool.inputSchema);
        if (!schema) {
          return (tool.handler as any)(extra);
        }

        const parsed = await schema.safeParseAsync(args ?? {});
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          return errorResult(`Invalid arguments for ${name}: ${detail}`);
        }

        // The recorded handler is the same policy-wrapped callback the SDK's
        // own tools/call dispatch would invoke - no boundary is skipped here.
        return (tool.handler as any)(parsed.data, extra);
      }
    )
  );

  const advertised = [...metaTools.entries()].map(([name, tool]) => toolDescriptor(name, tool));
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: advertised }));

  return { deferredCount: deferred.length, metaToolNames: [...metaTools.keys()] };
}
