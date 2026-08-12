#!/usr/bin/env node

/**
 * Measure the always-on `tools/list` cost in both modes.
 *
 * Every MCP session pays for `tools/list` before the model does any work, so
 * this is the number tool-search mode exists to move. The script starts the
 * built server twice - once plain, once with `--tool-search` - and reports the
 * serialized size of each response, plus what a client pays to fetch schemas
 * back on demand.
 *
 * Token figures are estimates (chars / 4), not a tokenizer's output. They are
 * there for order-of-magnitude comparison, not for billing.
 *
 * Tool counts are environment-dependent: some tools register only when the
 * installed CLI reports the matching capability. The script prints what it
 * observed rather than asserting a fixed number, and asserts only relative
 * invariants that hold in any environment.
 *
 * Run:  node crates/mcp/test/tools_list_size.mjs [--json]
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const serverPath = join(repoRoot, "crates", "mcp", "dist", "index.js");
const fixturesDir = join(repoRoot, "crates", "mcp", "fixtures", "demo");

/** Ceiling on the advertised list, as a fraction of the default list. */
const MAX_ADVERTISED_FRACTION = 0.25;

const asJson = process.argv.includes("--json");

async function connect(args = []) {
  const tempHome = mkdtempSync(join(tmpdir(), "minutes-tools-size-"));
  mkdirSync(join(tempHome, ".minutes"), { recursive: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      MEETINGS_DIR: fixturesDir,
      RUST_LOG: "error",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "minutes-tools-list-size", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      rmSync(tempHome, { recursive: true, force: true });
    },
  };
}

const chars = (value) => JSON.stringify(value).length;
const tokens = (count) => Math.round(count / 4);

function measure(tools) {
  return {
    tools: tools.length,
    total_chars: chars({ tools }),
    description_chars: tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0),
    schema_chars: tools.reduce((sum, tool) => sum + chars(tool.inputSchema ?? {}), 0),
  };
}

const plain = await connect();
const searchable = await connect(["--tool-search"]);

try {
  const defaultTools = (await plain.client.listTools()).tools;
  const advertised = (await searchable.client.listTools()).tools;

  const catalogueResult = await searchable.client.callTool({
    name: "list_capabilities",
    arguments: {},
  });
  const catalogueChars = chars(catalogueResult);

  // What a client pays to pull one schema back on demand.
  const describeCosts = [];
  for (const tool of defaultTools) {
    const described = await searchable.client.callTool({
      name: "describe_tool",
      arguments: { name: tool.name },
    });
    describeCosts.push({ name: tool.name, chars: chars(described) });
  }

  const before = measure(defaultTools);
  const after = measure(advertised);
  const describeTotal = describeCosts.reduce((sum, entry) => sum + entry.chars, 0);
  const describeAvg = Math.round(describeTotal / Math.max(describeCosts.length, 1));
  const saved = before.total_chars - after.total_chars;

  // A session using N tools pays: advertised list + catalogue + N describes.
  // Below this many tools, tool-search is still cheaper than the full list.
  const breakEven = Math.floor(
    (before.total_chars - after.total_chars - catalogueChars) / Math.max(describeAvg, 1)
  );

  const report = {
    default: before,
    tool_search: {
      ...after,
      list_capabilities_chars: catalogueChars,
      describe_tool_avg_chars: describeAvg,
      describe_tool_max_chars: Math.max(...describeCosts.map((entry) => entry.chars)),
    },
    savings: {
      chars: saved,
      percent: Number(((saved / before.total_chars) * 100).toFixed(1)),
      estimated_tokens: tokens(saved),
    },
    break_even_tools_per_session: breakEven,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const row = (label, value) => console.log(`  ${label.padEnd(34)} ${String(value).padStart(8)}`);
    console.log("tools/list size - default vs tool-search\n");
    console.log("Default mode");
    row("tools advertised", before.tools);
    row("tools/list chars", before.total_chars);
    row("  of which descriptions", before.description_chars);
    row("  of which input schemas", before.schema_chars);
    row("estimated tokens", tokens(before.total_chars));
    console.log("\nTool-search mode (--tool-search)");
    row("tools advertised", after.tools);
    row("tools/list chars", after.total_chars);
    row("estimated tokens", tokens(after.total_chars));
    console.log("\nOn-demand cost");
    row("list_capabilities chars", catalogueChars);
    row("describe_tool avg chars", describeAvg);
    row("describe_tool max chars", report.tool_search.describe_tool_max_chars);
    console.log("\nSavings on the always-on list");
    row("chars saved", saved);
    row("percent saved", `${report.savings.percent}%`);
    row("estimated tokens saved", report.savings.estimated_tokens);
    row("break-even tools/session", breakEven);
  }

  const failures = [];
  if (after.total_chars >= before.total_chars * MAX_ADVERTISED_FRACTION) {
    failures.push(
      `advertised list is ${after.total_chars} chars, must be under ${Math.round(
        before.total_chars * MAX_ADVERTISED_FRACTION
      )} (${MAX_ADVERTISED_FRACTION * 100}% of default)`
    );
  }
  if (after.schema_chars >= before.schema_chars) {
    failures.push("tool-search mode must not advertise more schema bytes than default mode");
  }
  const catalogued = JSON.parse(catalogueResult.content[0].text).tools.map((tool) => tool.name);
  if (catalogued.length !== defaultTools.length) {
    failures.push(
      `list_capabilities covers ${catalogued.length} tools, default mode advertises ${defaultTools.length}`
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  } else if (!asJson) {
    console.log("\nPASS: tool-search list is smaller and the catalogue is complete");
  }
} finally {
  await plain.close();
  await searchable.close();
}
