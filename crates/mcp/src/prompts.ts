/**
 * MCP prompts primitive for the Minutes server.
 *
 * Prompts are reusable guidance templates a host can offer the user (slash
 * commands, "/" menus, prompt pickers). They are a third primitive alongside
 * tools and resources, and like resources they do NOT pass through the agent
 * tool registry in index.ts.
 *
 * That bypass is why every prompt here is deliberately content-free: a prompt
 * body is a static template plus the user's own sanitized arguments, and no
 * handler in this module reads the meeting corpus, spawns the CLI, or touches
 * the filesystem. Nothing here can disclose meeting content, so no readiness
 * or restricted-content gate is required. Keep it that way. If a prompt ever
 * needs live corpus data, it belongs behind the tool boundary instead, where
 * the readiness and sensitivity gates actually run.
 *
 * This module therefore imports nothing but zod and the McpServer type. The
 * unit tests assert that constraint against the source text.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Longest argument value accepted from a host before it is truncated. */
export const PROMPT_ARG_MAX_LENGTH = 200;

/** Placeholder used when a required argument arrives empty or unusable. */
const MISSING_ARG = "(not specified)";

/**
 * Bound and flatten a host-supplied prompt argument.
 *
 * Prompt arguments are free text typed by the user, and they get interpolated
 * into the message body. Control characters (including newlines) are collapsed
 * to spaces so a single argument cannot forge extra instruction lines in the
 * rendered prompt, and the value is length-bounded the same way tool output
 * fields are.
 */
export function sanitizePromptArg(value: string | undefined): string {
  if (typeof value !== "string") return MISSING_ARG;
  // eslint-disable-next-line no-control-regex
  const flattened = value.replace(/[\u0000-\u001F\u007F]+/g, " ");
  const collapsed = flattened.replace(/\s+/g, " ").trim();
  if (collapsed === "") return MISSING_ARG;
  if (collapsed.length <= PROMPT_ARG_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PROMPT_ARG_MAX_LENGTH)}...`;
}

/**
 * Shared reading rules, restated in MCP tool terms.
 *
 * The plugin skills say this in CLI terms (`minutes get "<path>" --json`,
 * require exit status 0). An MCP host has tools, not a `minutes` binary on
 * PATH, so the same invariants are expressed against the tool surface.
 */
const CORPUS_RULES = [
  "Ground rules for reading Minutes history:",
  "",
  "- Read only through the Minutes tools. A path returned by list_meetings or search_meetings is a hint, not read authorization: resolve it with get_meeting before quoting it, and never hand that path to a filesystem read tool.",
  "- An empty result means no matching history was found. It does not mean the topic was never discussed; a recording may never have been processed.",
  "- A tool that fails, or reports a partial view, means that source is unavailable. Say it is unavailable. Never report it as \"none\" or \"nothing open\".",
  "- Restricted meetings are excluded by default. An excluded item is not an absent fact, so do not reason as though it does not exist.",
].join("\n");

/** Speaker attribution caveat, used where the answer turns on who said what. */
const SPEAKER_RULES = [
  "Attributing quotes: speaker names come from the speaker_map in a meeting's frontmatter. High confidence is reliable and can be stated plainly. Medium confidence is a guess, so hedge it (\"likely Alex\") and mention that confirming the speaker in the Minutes app or CLI locks it in. Never upgrade a medium-confidence label into a plain assertion.",
].join("\n");

/** A prompt message as returned by prompts/get. */
export interface MinutesPromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

/** One registered prompt: metadata plus the pure body builder. */
export interface MinutesPromptDefinition {
  name: string;
  title: string;
  description: string;
  /** Argument names in declaration order, with their required flag. */
  args: Array<{ name: string; description: string; required: boolean }>;
  /** Builds the prompt body from already-sanitized argument values. */
  build: (args: Record<string, string>) => string;
}

function joinSections(sections: string[]): string {
  return sections.filter((section) => section.trim() !== "").join("\n\n");
}

/**
 * The prompt catalog.
 *
 * The first six names mirror `manifest.json`'s `prompts` array so the MCPB
 * manifest surface and the live prompts/list surface advertise one coherent
 * set rather than two competing ones. `mcp_prompts_test.mjs` enforces that.
 */
export const MINUTES_PROMPTS: MinutesPromptDefinition[] = [
  {
    name: "start_meeting",
    title: "Start recording a meeting",
    description:
      "Start a recording with a title, and get the notetaking and wrap-up steps that go with it.",
    args: [
      {
        name: "title",
        description: "Title for the meeting you are about to record.",
        required: true,
      },
    ],
    build: ({ title }) =>
      joinSections([
        `Start recording a meeting titled "${title}".`,
        [
          `1. start_recording with the title "${title}". Confirm with get_status that capture actually started before telling me it did.`,
          "2. While it runs, use add_note whenever I flag something worth timestamping. Notes attach to the active recording only; they never edit an existing meeting file.",
          "3. When I say we are done, stop_recording, then follow the job with list_processing_jobs. Transcription runs locally and takes a while, so tell me it is processing rather than pretending it is finished.",
          "4. Once it lands, get_meeting on the new file and give me the decisions and action items.",
        ].join("\n"),
        "Recording and transcription happen locally on my machine. Do not tell me the transcript is ready until a tool result says it is.",
      ]),
  },
  {
    name: "search_coaching",
    title: "Search my meetings (with coaching)",
    description:
      "Turn a vague recall question into a search that actually finds the meeting, instead of running a query that returns hundreds of hits or none.",
    args: [
      {
        name: "query",
        description: "What you are trying to find in your meeting history.",
        required: true,
      },
    ],
    build: ({ query }) =>
      joinSections([
        `I am trying to find this in my meeting history: ${query}`,
        "Before running anything, check whether the query is actually searchable. Push back first if it matches one of these, then search once I have narrowed it:",
        [
          "- \"everything\" or \"all my meetings\": that returns hundreds of results. Ask what I am actually after - a person, a topic, or a decision.",
          "- A single common word like \"meeting\" or \"project\": too broad. Ask for a name, a specific topic, or a date range.",
          "- \"that meeting\" or \"the one where\": ask what I do remember. Who was there, roughly when, or one thing that was said.",
          "- \"who said X\" or \"what did someone say\": this is answerable, but it depends on speaker attribution, so read the caveat below before answering.",
        ].join("\n"),
        "If the query is specific enough, search it directly. Match the strategy to what I am looking for:",
        [
          "- A person's input: search their name.",
          "- A decision: search the words people use when deciding, such as \"decided\", \"agreed\", or \"committed to\".",
          "- An idea I captured alone: filter to voice memos.",
          "- Something from a stretch of time: use a date filter, as an ISO date like 2026-03-01. Compute the ISO date yourself; the filter does not understand \"last week\".",
        ].join("\n"),
        "Search matches substrings against transcript text and titles, so search for what someone would have said out loud (\"we should postpone the launch\") rather than what a document would be called (\"launch delay meeting\"). A typo matches nothing, so if a term comes back empty, try a different wording before concluding it was never discussed. Always keep a result limit; a common word can match hundreds of files.",
        CORPUS_RULES,
        SPEAKER_RULES,
      ]),
  },
];

/**
 * Build one prompt's messages from raw host arguments.
 *
 * Exported for unit tests and for any caller that wants the body without a
 * live MCP server. Unknown names throw rather than returning an empty prompt.
 */
export function buildPromptMessages(
  name: string,
  rawArgs: Record<string, unknown> = {}
): MinutesPromptMessage[] {
  const definition = MINUTES_PROMPTS.find((prompt) => prompt.name === name);
  if (!definition) {
    throw new Error(`Unknown Minutes prompt: ${name}`);
  }
  const sanitized: Record<string, string> = {};
  for (const arg of definition.args) {
    const value = rawArgs[arg.name];
    sanitized[arg.name] = sanitizePromptArg(
      typeof value === "string" ? value : undefined
    );
  }
  return [
    {
      role: "user",
      content: { type: "text", text: definition.build(sanitized) },
    },
  ];
}

/** Zod shape for a definition's arguments. MCP prompt arguments are strings. */
function argsSchemaFor(
  definition: MinutesPromptDefinition
): Record<string, z.ZodType<string | undefined>> {
  const shape: Record<string, z.ZodType<string | undefined>> = {};
  for (const arg of definition.args) {
    // `.describe()` must be the outermost call: wrapping a described schema in
    // `.optional()` produces a wrapper with no description of its own, and the
    // argument would then be advertised without one in prompts/list.
    const base = z.string();
    shape[arg.name] = (arg.required ? base : base.optional()).describe(
      arg.description
    );
  }
  return shape;
}

/**
 * Register every Minutes prompt on the server, which is what turns
 * prompts/list and prompts/get from "Method not found" into a real surface.
 */
export function registerMinutesPrompts(serverArg: McpServer): void {
  for (const definition of MINUTES_PROMPTS) {
    serverArg.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        argsSchema: argsSchemaFor(definition) as any,
      },
      ((args: Record<string, unknown>) => ({
        description: definition.description,
        messages: buildPromptMessages(definition.name, args ?? {}),
      })) as any
    );
  }
}
