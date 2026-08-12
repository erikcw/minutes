import { describe, expect, it, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import {
  TOOL_SEARCH_ENV,
  TOOL_SEARCH_FLAG,
  installToolSearchMode,
  isToolSearchEnabled,
  recordDeferrableTool,
  resetDeferrableTools,
  summarize,
} from "./toolSearch.js";

describe("isToolSearchEnabled", () => {
  it("is off by default", () => {
    expect(isToolSearchEnabled(["node", "index.js"], {})).toBe(false);
  });

  it("is on with the flag", () => {
    expect(isToolSearchEnabled(["node", "index.js", TOOL_SEARCH_FLAG], {})).toBe(true);
  });

  it("is on with a truthy env var, whatever the casing", () => {
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(isToolSearchEnabled([], { [TOOL_SEARCH_ENV]: value })).toBe(true);
    }
  });

  it("treats other env values as off", () => {
    for (const value of ["", "0", "false", "no", "maybe"]) {
      expect(isToolSearchEnabled([], { [TOOL_SEARCH_ENV]: value })).toBe(false);
    }
  });
});

describe("summarize", () => {
  it("drops the trailing docs URL every tool description carries", () => {
    expect(summarize("Do a thing. Docs: https://useminutes.app/docs/mcp/tools#tool-x")).toBe(
      "Do a thing."
    );
  });

  it("truncates at the first sentence when the description is long", () => {
    const long = `First sentence. ${"padding ".repeat(40)}`;
    expect(summarize(long)).toBe("First sentence.");
  });

  it("hard-truncates a long single sentence", () => {
    const summary = summarize("x".repeat(400));
    expect(summary.length).toBeLessThanOrEqual(160);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("handles a missing description", () => {
    expect(summarize(undefined)).toBe("");
  });
});

/** A server carrying one recorded tool, wired to an in-memory client. */
async function toolSearchHarness() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const seen: Array<Record<string, unknown>> = [];

  const echo = server.tool(
    "echo_tool",
    "Echo the arguments back. Docs: https://example.invalid/docs",
    {
      query: z.string().describe("Anything"),
      limit: z.number().int().optional().default(7).describe("Defaulted"),
    },
    { title: "Echo Tool", readOnlyHint: true },
    async (args: any) => {
      seen.push(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(args) }] };
    }
  );
  recordDeferrableTool(server, "echo_tool", echo);

  const installed = installToolSearchMode(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { server, client, seen, installed };
}

function textOf(result: any): string {
  return (result.content ?? []).map((entry: any) => entry.text ?? "").join("\n");
}

describe("installToolSearchMode", () => {
  beforeEach(() => {
    resetDeferrableTools();
  });

  it("advertises only the meta-tools", async () => {
    const { client, installed } = await toolSearchHarness();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "call_tool",
      "describe_tool",
      "list_capabilities",
    ]);
    expect(installed.deferredCount).toBe(1);
  });

  it("catalogues deferred tools without their schemas", async () => {
    const { client } = await toolSearchHarness();
    const result: any = await client.callTool({ name: "list_capabilities", arguments: {} });

    const catalogue = JSON.parse(textOf(result));
    expect(catalogue.count).toBe(1);
    expect(catalogue.tools[0]).toEqual({
      name: "echo_tool",
      summary: "Echo the arguments back.",
      read_only: true,
    });
  });

  it("returns the full descriptor from describe_tool", async () => {
    const { client } = await toolSearchHarness();
    const result: any = await client.callTool({
      name: "describe_tool",
      arguments: { name: "echo_tool" },
    });

    const descriptor = JSON.parse(textOf(result));
    expect(descriptor.name).toBe("echo_tool");
    expect(descriptor.annotations.title).toBe("Echo Tool");
    expect(descriptor.inputSchema.type).toBe("object");
    expect(Object.keys(descriptor.inputSchema.properties).sort()).toEqual(["limit", "query"]);
    expect(descriptor.inputSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("applies the deferred tool's schema defaults when dispatching", async () => {
    const { client, seen } = await toolSearchHarness();
    await client.callTool({
      name: "call_tool",
      arguments: { name: "echo_tool", arguments: { query: "hello" } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ query: "hello", limit: 7 });
  });

  it("rejects arguments the deferred tool's schema refuses", async () => {
    const { client, seen } = await toolSearchHarness();
    const result: any = await client.callTool({
      name: "call_tool",
      arguments: { name: "echo_tool", arguments: { query: 42 } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments for echo_tool");
    expect(seen).toHaveLength(0);
  });

  it("keeps deferred tools callable by their own name", async () => {
    const { client } = await toolSearchHarness();
    const result: any = await client.callTool({
      name: "echo_tool",
      arguments: { query: "direct" },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({ query: "direct", limit: 7 });
  });

  it("does not leak tools recorded against another server", async () => {
    const other = new McpServer({ name: "other", version: "0.0.0" });
    const stray = other.tool("stray_tool", "Stray", {}, {}, async () => ({
      content: [{ type: "text" as const, text: "" }],
    }));
    recordDeferrableTool(other, "stray_tool", stray);

    const { client } = await toolSearchHarness();
    const result: any = await client.callTool({ name: "list_capabilities", arguments: {} });

    expect(JSON.parse(textOf(result)).tools.map((tool: any) => tool.name)).toEqual(["echo_tool"]);
  });
});
