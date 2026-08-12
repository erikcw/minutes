#!/usr/bin/env node

/**
 * Tool-search mode contract tests.
 *
 * Default mode (no flag) and tool-search mode (`--tool-search`) are both
 * exercised against the built server over stdio:
 *
 *  1. Default tools/list is unchanged - no meta-tool leaks into it.
 *  2. Tool-search tools/list advertises exactly the three meta-tools.
 *  3. list_capabilities covers the same tool set, names + summaries only.
 *  4. describe_tool returns, for EVERY tool, a descriptor byte-identical to
 *     the one default mode advertises. This is the guard against schema drift
 *     between the SDK's serializer and ours.
 *  5. call_tool round-trips a real tool (search_meetings) against fixtures.
 *  6. Deferred tools stay directly callable by their own name.
 *  7. Unknown names and invalid arguments fail as tool errors, not crashes.
 *
 * Run: node crates/mcp/test/tool_search_test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const serverPath = join(repoRoot, "crates", "mcp", "dist", "index.js");
const fixturesDir = join(repoRoot, "crates", "mcp", "fixtures", "demo");

const META_TOOLS = ["list_capabilities", "describe_tool", "call_tool"];

let passed = 0;
let failed = 0;
const cleanups = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "mismatch"}: expected ${expected}, got ${actual}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL: ${name} - ${error.message}`);
    failed++;
  }
}

/** Start the built server over stdio with an isolated HOME. */
async function connect(args = []) {
  const tempHome = mkdtempSync(join(tmpdir(), "minutes-tool-search-"));
  mkdirSync(join(tempHome, ".minutes"), { recursive: true });

  const stderrChunks = [];
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
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const client = new Client({ name: "minutes-tool-search-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const close = async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    rmSync(tempHome, { recursive: true, force: true });
  };
  cleanups.push(close);
  return { client, close, stderr: () => stderrChunks.join("") };
}

/** Text payload of a tool result, for error assertions. */
function resultText(result) {
  return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

/** Structured payload, falling back to parsing the text content. */
function resultJson(result) {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(resultText(result));
}

/** Stable serialization so descriptor comparison ignores key order. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

console.log("MCP Tool-Search Mode Tests\n");

const plain = await connect();
const searchable = await connect(["--tool-search"]);

const defaultList = await plain.client.listTools();
const searchList = await searchable.client.listTools();

// ── 1: default mode is untouched ──
await test("default tools/list advertises the full tool set", () => {
  assert(defaultList.tools.length > 3, "default mode must advertise the real tools");
  for (const tool of defaultList.tools) {
    assert(tool.inputSchema, `${tool.name} must ship its inputSchema in default mode`);
  }
});

await test("default tools/list contains no meta-tools", () => {
  const names = new Set(defaultList.tools.map((tool) => tool.name));
  for (const meta of META_TOOLS) {
    assert(!names.has(meta), `default mode must not advertise ${meta}`);
  }
});

// ── 2: tool-search mode advertises only the meta-tools ──
await test("tool-search tools/list advertises exactly the meta-tools", () => {
  const names = searchList.tools.map((tool) => tool.name).sort();
  assertEqual(names.join(","), [...META_TOOLS].sort().join(","), "meta-tool set");
});

await test("tool-search tools/list is far smaller than the default list", () => {
  const defaultChars = JSON.stringify(defaultList).length;
  const searchChars = JSON.stringify(searchList).length;
  assert(
    searchChars < defaultChars * 0.25,
    `tool-search list (${searchChars} chars) must be under 25% of default (${defaultChars} chars)`
  );
});

// ── 3: list_capabilities covers the same set, without schemas ──
let catalogue;
await test("list_capabilities covers every deferred tool, names and summaries only", async () => {
  const result = await searchable.client.callTool({ name: "list_capabilities", arguments: {} });
  assert(result.isError !== true, "list_capabilities must not error");
  catalogue = resultJson(result);

  const catalogued = catalogue.tools.map((tool) => tool.name).sort();
  const advertised = defaultList.tools.map((tool) => tool.name).sort();
  assertEqual(catalogued.join(","), advertised.join(","), "catalogue must match default tools/list");
  assertEqual(catalogue.count, advertised.length, "catalogue count");

  for (const tool of catalogue.tools) {
    assert(!("inputSchema" in tool), `${tool.name} must not carry a schema in the catalogue`);
    assert(tool.summary && tool.summary.length > 0, `${tool.name} must carry a summary`);
    assert(
      !/Docs:\s*https?:\/\//.test(tool.summary),
      `${tool.name} summary must drop the trailing docs URL`
    );
  }
});

await test("list_capabilities filter narrows the catalogue", async () => {
  const result = await searchable.client.callTool({
    name: "list_capabilities",
    arguments: { filter: "recording" },
  });
  const filtered = resultJson(result);
  assert(filtered.count > 0, "filter must match at least one tool");
  assert(filtered.count < filtered.total, "filter must narrow the catalogue");
  assert(
    filtered.tools.some((tool) => tool.name === "start_recording"),
    "filter 'recording' must match start_recording"
  );
});

// ── 4: describe_tool parity with default mode, for every tool ──
await test("describe_tool matches the default descriptor for every tool", async () => {
  const mismatches = [];
  for (const advertised of defaultList.tools) {
    const result = await searchable.client.callTool({
      name: "describe_tool",
      arguments: { name: advertised.name },
    });
    assert(result.isError !== true, `describe_tool(${advertised.name}) must not error`);
    const described = resultJson(result);
    if (JSON.stringify(canonical(described)) !== JSON.stringify(canonical(advertised))) {
      mismatches.push(advertised.name);
    }
  }
  assertEqual(mismatches.length, 0, `descriptors drifted for: ${mismatches.join(", ")}`);
});

await test("describe_tool rejects an unknown name as a tool error", async () => {
  const result = await searchable.client.callTool({
    name: "describe_tool",
    arguments: { name: "no_such_tool" },
  });
  assertEqual(result.isError, true, "unknown tool must be a tool error");
  assert(resultText(result).includes("Unknown tool"), "error must name the problem");
});

// ── 5: call_tool round trip against a real tool ──
// get_status runs to completion on a fresh HOME, so this is the case that
// proves dispatch reaches a handler rather than matching two refusals.
await test("call_tool dispatches to a handler that runs to completion", async () => {
  const direct = await plain.client.callTool({ name: "get_status", arguments: {} });
  const viaMeta = await searchable.client.callTool({
    name: "call_tool",
    arguments: { name: "get_status", arguments: {} },
  });

  assert(direct.isError !== true, "get_status must succeed for this test to mean anything");
  assert(viaMeta.isError !== true, "call_tool must not turn a successful call into an error");
  assert(resultText(viaMeta).length > 0, "call_tool must return the handler's content");
  assertEqual(resultText(viaMeta), resultText(direct), "payload must match the direct call");
});

// search_meetings needs an authorized corpus. Where the trust boundary
// refuses it (a fresh HOME, CI, any machine without a cleanup attestation),
// both paths must refuse identically, and the skip is printed rather than
// hidden behind a green parity assertion.
await test("call_tool mirrors a direct search_meetings call", async () => {
  const args = { query: "pricing", limit: 5 };
  const direct = await plain.client.callTool({ name: "search_meetings", arguments: args });
  const viaMeta = await searchable.client.callTool({
    name: "call_tool",
    arguments: { name: "search_meetings", arguments: args },
  });

  assertEqual(viaMeta.isError, direct.isError, "call_tool must mirror the direct error state");
  assertEqual(
    resultText(viaMeta),
    resultText(direct),
    "call_tool must return the same payload as a direct call"
  );
  if (direct.isError === true) {
    console.log(
      "    NOTE: the corpus trust boundary refused search_meetings here; this compared two refusals"
    );
  }
});

// Whatever this environment's trust boundary decides for list_meetings - a
// result or a refusal - both call paths must decide it the same way.
await test("call_tool mirrors a direct call for an empty-argument tool", async () => {
  const direct = await plain.client.callTool({ name: "list_meetings", arguments: {} });
  const viaMeta = await searchable.client.callTool({
    name: "call_tool",
    arguments: { name: "list_meetings", arguments: {} },
  });
  assertEqual(viaMeta.isError, direct.isError, "error state must match");
  assertEqual(resultText(viaMeta), resultText(direct), "payload must match");
});

await test("call_tool rejects invalid arguments as a tool error", async () => {
  const result = await searchable.client.callTool({
    name: "call_tool",
    arguments: { name: "search_meetings", arguments: { query: 42 } },
  });
  assertEqual(result.isError, true, "invalid arguments must be a tool error");
  assert(
    resultText(result).includes("Invalid arguments for search_meetings"),
    "error must identify the tool and the failure"
  );
});

await test("call_tool rejects an unknown name as a tool error", async () => {
  const result = await searchable.client.callTool({
    name: "call_tool",
    arguments: { name: "no_such_tool", arguments: {} },
  });
  assertEqual(result.isError, true, "unknown tool must be a tool error");
});

// ── 6: deferred tools stay directly callable ──
await test("a deferred tool is still callable by its own name", async () => {
  const result = await searchable.client.callTool({ name: "get_status", arguments: {} });
  assert(result.isError !== true, "get_status must remain callable while unadvertised");
  assert(resultText(result).length > 0, "get_status must return content");
});

// ── 7: resources are unaffected by tool-search mode ──
await test("resources/list is identical in both modes", async () => {
  const a = await plain.client.listResources();
  const b = await searchable.client.listResources();
  assertEqual(
    JSON.stringify(a.resources.map((r) => r.uri).sort()),
    JSON.stringify(b.resources.map((r) => r.uri).sort()),
    "resource URIs"
  );
});

for (const close of cleanups) await close();

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
