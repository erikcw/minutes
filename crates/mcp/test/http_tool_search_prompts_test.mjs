#!/usr/bin/env node

/**
 * HTTP + tool-search + prompts interaction tests.
 *
 * Each of those three landed on its own branch, and each was tested in
 * isolation. This suite covers the combination none of them could:
 *
 *  - `--transport http --tool-search` together, over two SEQUENTIAL sessions.
 *    One session proves nothing. A tool-search install that closes over the
 *    module singleton instead of the per-session instance still answers the
 *    first session correctly, because the singleton is fully populated. It is
 *    the second session that exposes it — and a per-session registry that is
 *    never cleaned up shows here too, as a deferred count that climbs.
 *  - prompts/list over HTTP. Prompts were registered on the singleton, which
 *    an HTTP session never serves from.
 *  - the stdio regression leg with tool-search off: existing clients must see
 *    the full tool list and the prompts, exactly as before.
 *
 * Requires the debug CLI at target/debug/minutes and a built dist/index.js.
 *
 * Run: node crates/mcp/test/http_tool_search_prompts_test.mjs
 */

import { spawn } from "child_process";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CAPABILITY_GATED_TOOLS,
  assertCoreParity,
  assertOwnStateGatedSurface,
  assertSameCli,
  capabilityStatesAgree,
  describeStateDivergence,
  probeCapabilityReport,
  readDeclaredCapabilityState,
  resolveMinutesBinary,
} from "./lib/surface-parity.mjs";

const MCP_DIR = join(import.meta.dirname, "..");
const SERVER_ENTRY = join(MCP_DIR, "dist", "index.js");
const STARTUP_TIMEOUT_MS = 30000;

const META_TOOLS = ["call_tool", "describe_tool", "list_capabilities"];
/** Kept in sync with MINUTES_PROMPTS in src/prompts.ts. */
const EXPECTED_PROMPT_COUNT = 7;

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL: ${name} — ${e.message}`);
      failed++;
    }
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(msg || `expected ${expected}, got ${actual}`);
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || "mismatch"}: expected ${b}, got ${a}`);
}

/** Start the server on an OS-assigned port and read the port back from stderr. */
function startHttpServer(extraArgs = []) {
  const child = spawn(
    process.execPath,
    [SERVER_ENTRY, "--transport", "http", "--port", "0", ...extraArgs],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: "error" },
    }
  );

  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(
          `server did not report a listening port in ${STARTUP_TIMEOUT_MS}ms:\n${stderr}`
        )
      );
    }, STARTUP_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on (http:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ child, url: match[1], stderrSoFar: () => stderr });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`server exited early (code ${code}):\n${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function connectHttpClient(url, name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function connectStdioClient(name, extraArgs = []) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...extraArgs],
    env: { ...process.env, RUST_LOG: "error" },
    stderr: "ignore",
  });
  await client.connect(transport);
  // The pid is how the caller finds this process's own capability-probe
  // outcome, which any cross-process surface comparison has to condition on.
  client.serverPid = transport.pid;
  return client;
}

function textOf(result) {
  return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

async function closeQuietly(client) {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // The server may already be gone; teardown is best-effort.
  }
}

/** Everything one session can tell us about the deferred surface. */
async function probeSession(client) {
  const tools = (await client.listTools()).tools;
  const names = tools.map((tool) => tool.name);

  let prompts;
  try {
    prompts = (await client.listPrompts()).prompts;
  } catch (e) {
    throw new Error(`prompts/list is not served on this session: ${e.message}`);
  }

  // When tool-search never got installed on this instance, list_capabilities
  // does not exist and the SDK throws a bare "Tool not found". Say what the
  // session actually advertised instead — that is the diagnosis.
  let catalogue;
  try {
    catalogue = JSON.parse(
      textOf(await client.callTool({ name: "list_capabilities", arguments: {} }))
    );
  } catch (e) {
    throw new Error(
      `list_capabilities unavailable (${e.message}); this session advertised ${names.length} tools: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}`
    );
  }
  return { tools, prompts, catalogue };
}

/**
 * A deferred tool's reply in default stdio mode, used as the routing baseline.
 *
 * Asserting success would tie this suite to the state of the local corpus —
 * `list_meetings` is gated on a qmd attestation that fails on a machine
 * without qmd installed. What matters here is that the deferred paths reach
 * the same handler and get the same answer, whatever that answer is. An
 * unrouted call fails differently: tool-search replies `Unknown tool "..."`.
 */
const PROBE_TOOL = "list_meetings";
const PROBE_ARGS = { limit: 1 };
let routingBaseline;

console.log("MCP HTTP + tool-search + prompts Interaction Tests\n");

// Warm the binary the server will actually resolve (release before debug) and
// read its capability report with a budget the server's own 2s probe lacks.
// Warming lowers the chance of a child's probe timing out; the cross-process
// assertions below do not assume it succeeded.
const MINUTES_BIN = resolveMinutesBinary();
const CAPABILITY_REPORT = probeCapabilityReport(MINUTES_BIN);
const TEST_START_ISO = new Date().toISOString();

const server = await startHttpServer(["--tool-search"]);
// The HTTP process's own probe outcome. Every gated-surface assertion about
// this process is made against this, not against the sibling process.
const httpState = await readDeclaredCapabilityState({
  pid: server.child.pid,
  sinceIso: TEST_START_ISO,
  label: "http tool-search server",
});
assertSameCli("http tool-search server", httpState, CAPABILITY_REPORT);

let sessionOne;
let sessionTwo;
let firstProbe;
let secondProbe;

try {
  test("baseline: the probe tool's reply in default stdio mode", async () => {
    const client = await connectStdioClient("routing-baseline");
    try {
      routingBaseline = textOf(
        await client.callTool({ name: PROBE_TOOL, arguments: PROBE_ARGS })
      );
      assert(routingBaseline.length > 0, "the probe tool should return content");
      assert(
        !routingBaseline.includes("Unknown tool"),
        "the baseline itself must be a real dispatch"
      );
    } finally {
      await closeQuietly(client);
    }
  });

  test("session 1 over HTTP advertises only the meta-tools", async () => {
    sessionOne = await connectHttpClient(server.url, "tool-search-session-1");
    firstProbe = await probeSession(sessionOne);

    assertDeepEqual(
      firstProbe.tools.map((tool) => tool.name).sort(),
      META_TOOLS,
      "tools/list should be the three meta-tools"
    );
    assert(
      firstProbe.catalogue.total > 20,
      `expected a populated catalogue, got total=${firstProbe.catalogue.total}`
    );
  });

  test("session 1 over HTTP serves prompts/list", async () => {
    assertEqual(
      firstProbe.prompts.length,
      EXPECTED_PROMPT_COUNT,
      `expected ${EXPECTED_PROMPT_COUNT} prompts over HTTP, got ${firstProbe.prompts.length}`
    );
    // Registered on the singleton only, this would be an empty list here.
    assert(
      firstProbe.prompts.every((prompt) => typeof prompt.name === "string"),
      "every prompt needs a name"
    );
  });

  test("session 1 renders a prompt body over HTTP", async () => {
    const target = firstProbe.prompts[0];
    const args = {};
    for (const arg of target.arguments ?? []) {
      if (arg.required) args[arg.name] = "integration probe";
    }
    const rendered = await sessionOne.getPrompt({ name: target.name, arguments: args });
    assert(rendered.messages.length > 0, "prompts/get should return messages");
    const body = rendered.messages.map((m) => m.content?.text ?? "").join("\n");
    assert(body.length > 0, "the rendered prompt body should not be empty");
  });

  // The discriminating case. A tool-search install bound to the module
  // singleton, or a deferred registry that is never cleaned up, both pass
  // session 1 and fail here.
  test("session 2 sees the identical deferred surface", async () => {
    sessionTwo = await connectHttpClient(server.url, "tool-search-session-2");
    secondProbe = await probeSession(sessionTwo);

    assertDeepEqual(
      secondProbe.tools.map((tool) => tool.name).sort(),
      META_TOOLS,
      "session 2 tools/list should also be the three meta-tools"
    );
    assertEqual(
      secondProbe.catalogue.total,
      firstProbe.catalogue.total,
      "the deferred tool count must not drift between sessions"
    );
    assertDeepEqual(
      secondProbe.catalogue.tools.map((tool) => tool.name),
      firstProbe.catalogue.tools.map((tool) => tool.name),
      "session 2 should catalogue the same tools in the same order"
    );
  });

  test("session 2 serves the same prompts", async () => {
    assertDeepEqual(
      secondProbe.prompts.map((prompt) => prompt.name).sort(),
      firstProbe.prompts.map((prompt) => prompt.name).sort(),
      "both sessions should serve the same prompts"
    );
  });

  test("describe_tool returns a real schema over HTTP", async () => {
    const descriptor = JSON.parse(
      textOf(
        await sessionTwo.callTool({
          name: "describe_tool",
          arguments: { name: "list_meetings" },
        })
      )
    );
    assertEqual(descriptor.name, "list_meetings", "descriptor should name the tool");
    assertEqual(
      descriptor.inputSchema?.type,
      "object",
      "descriptor should carry a JSON Schema"
    );
    assert(
      typeof descriptor.description === "string" && descriptor.description.length > 0,
      "descriptor should carry a description"
    );
  });

  test("a deferred tool is still callable by its own name over HTTP", async () => {
    // toolSearch.ts promises dispatch is untouched — only advertisement is
    // withheld. Unverified over HTTP until now.
    const result = await sessionTwo.callTool({
      name: PROBE_TOOL,
      arguments: PROBE_ARGS,
    });
    assertEqual(
      textOf(result),
      routingBaseline,
      "an unadvertised tool called by name should answer exactly as it does in default mode"
    );
  });

  test("call_tool routes to a deferred tool over HTTP", async () => {
    const result = await sessionOne.callTool({
      name: "call_tool",
      arguments: { name: PROBE_TOOL, arguments: PROBE_ARGS },
    });
    assertEqual(
      textOf(result),
      routingBaseline,
      "call_tool should reach the same handler with the same result"
    );
  });

  test("call_tool rejects an unknown name with a hint", async () => {
    const result = await sessionOne.callTool({
      name: "call_tool",
      arguments: { name: "no_such_tool", arguments: {} },
    });
    assertEqual(result.isError, true, "an unknown tool should be an error");
    assert(
      textOf(result).includes("no_such_tool"),
      `error should name the tool: ${textOf(result)}`
    );
  });

  test("stdio with tool-search off is unchanged", async () => {
    const client = await connectStdioClient("stdio-default");
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      const prompts = (await client.listPrompts()).prompts;

      assert(
        tools.length > META_TOOLS.length,
        `default stdio should advertise every tool, got ${tools.length}`
      );
      for (const meta of META_TOOLS) {
        assert(!tools.includes(meta), `${meta} must not appear with tool-search off`);
      }
      assert(
        tools.includes("list_meetings"),
        "default stdio should still advertise list_meetings"
      );
      assertEqual(
        prompts.length,
        EXPECTED_PROMPT_COUNT,
        `stdio should serve ${EXPECTED_PROMPT_COUNT} prompts`
      );
    } finally {
      await closeQuietly(client);
    }
  });

  test("stdio with tool-search on matches the HTTP deferred surface", async () => {
    const client = await connectStdioClient("stdio-tool-search", ["--tool-search"]);
    try {
      const probe = await probeSession(client);
      assertDeepEqual(
        probe.tools.map((tool) => tool.name).sort(),
        META_TOOLS,
        "stdio tool-search should advertise the three meta-tools"
      );
      // Both transports replay the same builder list, so the deferred set
      // must be identical — but only on the part of it no capability gate can
      // move. The catalogue is built from the same registrations tools/list
      // would advertise, so the eight capability-gated tools are in it, and
      // the two processes probe the CLI independently. Compare core exactly
      // across processes, and the gated part against each process's own probe
      // outcome. See test/lib/surface-parity.mjs.
      const stdioState = await readDeclaredCapabilityState({
        pid: client.serverPid,
        sinceIso: TEST_START_ISO,
        label: "stdio tool-search server",
      });
      assertSameCli("stdio tool-search server", stdioState, CAPABILITY_REPORT);

      const stdioCatalogue = probe.catalogue.tools.map((tool) => tool.name);
      const httpCatalogue = firstProbe.catalogue.tools.map((tool) => tool.name);
      assertCoreParity({
        label: "deferred catalogue",
        aLabel: "stdio",
        aNames: stdioCatalogue,
        bLabel: "http",
        bNames: httpCatalogue,
        gatedMap: CAPABILITY_GATED_TOOLS,
        requiredAnchors: ["get_status", "list_meetings"],
      });
      assertOwnStateGatedSurface({
        label: "stdio deferred catalogue",
        names: stdioCatalogue,
        gatedMap: CAPABILITY_GATED_TOOLS,
        state: stdioState,
        report: CAPABILITY_REPORT,
      });
      assertOwnStateGatedSurface({
        label: "http deferred catalogue",
        names: httpCatalogue,
        gatedMap: CAPABILITY_GATED_TOOLS,
        state: httpState,
        report: CAPABILITY_REPORT,
      });
      if (!capabilityStatesAgree(stdioState, httpState)) {
        console.log(`  ${describeStateDivergence("stdio", stdioState, "http", httpState)}`);
      }
      assertEqual(
        probe.prompts.length,
        EXPECTED_PROMPT_COUNT,
        "tool-search must not affect the prompts surface"
      );
    } finally {
      await closeQuietly(client);
    }
  });

  test("resources survive tool-search over HTTP", async () => {
    // tools/list is overridden by name; resources/list must be untouched.
    const resources = (await sessionOne.listResources()).resources;
    assert(resources.length > 0, "resources should still be advertised");
  });

  // Closing a session runs its teardown, which drops that instance's entries
  // from the process-global deferrable registry. If that teardown reached too
  // far — say it cleared the whole array — the next session would come up with
  // an empty catalogue, and only a post-teardown session would notice.
  test("a session opened after two closes has the same surface", async () => {
    await closeQuietly(sessionOne);
    await closeQuietly(sessionTwo);
    sessionOne = undefined;
    sessionTwo = undefined;

    const third = await connectHttpClient(server.url, "tool-search-session-3");
    try {
      const probe = await probeSession(third);
      assertDeepEqual(
        probe.tools.map((tool) => tool.name).sort(),
        META_TOOLS,
        "session 3 should still advertise the three meta-tools"
      );
      assertEqual(
        probe.catalogue.total,
        firstProbe.catalogue.total,
        "session 3 should defer the same number of tools"
      );
      assertEqual(
        probe.prompts.length,
        EXPECTED_PROMPT_COUNT,
        "session 3 should still serve every prompt"
      );
      const result = await third.callTool({
        name: PROBE_TOOL,
        arguments: PROBE_ARGS,
      });
      assertEqual(
        textOf(result),
        routingBaseline,
        "dispatch should still work in a session opened after teardowns"
      );
    } finally {
      await closeQuietly(third);
    }
  });

  await runTests();
} finally {
  await closeQuietly(sessionOne);
  await closeQuietly(sessionTwo);
  await stopChild(server.child);
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
