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
    name: "meeting_prep",
    title: "Prepare for an upcoming meeting",
    description:
      "Pull the decisions, open commitments, and context worth reviewing before a meeting on a given topic.",
    args: [
      {
        name: "meeting_topic",
        description: "What the upcoming meeting is about (a topic, project, or agenda item).",
        required: true,
      },
    ],
    build: ({ meeting_topic }) =>
      joinSections([
        `I have a meeting coming up about: ${meeting_topic}`,
        "Give me the context I need before I walk in. Work in this order:",
        [
          `1. search_meetings for ${meeting_topic}. Search for what people would have said, not for a document title, and keep the result limit small.`,
          "2. Resolve the two or three most relevant hits with get_meeting. Do not read more than three; this is a briefing, not a research report.",
          "3. get_meeting_insights for decisions on this topic, and track_commitments for anything still owed.",
        ].join("\n"),
        "Then give me four short sections, in this order:",
        [
          "**Already settled** - decisions that are locked in, with the date each was made.",
          "**Still open** - questions raised and never resolved.",
          "**Who owes what** - open commitments touching this topic, with owner and due date. Flag anything overdue.",
          "**Worth raising** - one concrete thing I should put on the table, phrased so I could say it out loud.",
        ].join("\n"),
        CORPUS_RULES,
        "Keep the whole thing to one screen. Cut anything that would not change what I do in the meeting.",
      ]),
  },
  {
    name: "weekly_review",
    title: "Review this week's meetings",
    description:
      "Synthesize the past week into themes, decision arcs, overdue commitments, and what deserves attention next.",
    args: [
      {
        name: "focus",
        description:
          "Optional ordering preference: decisions, commitments, or memos. Defaults to themes first.",
        required: false,
      },
    ],
    build: ({ focus }) => {
      const ordering =
        focus === MISSING_ARG
          ? "Default ordering: themes, then decision arcs, then the commitment audit, then what deserves attention next."
          : [
              `Order the sections for this focus: ${focus}`,
              "",
              "- decisions: decision arcs, themes, commitment audit, attention next.",
              "- commitments: commitment audit, decision arcs, themes, attention next.",
              "- memos: themes first, with voice memos and captured ideas surfaced explicitly inside the theme summary, then the commitment audit, decision arcs, attention next.",
              "",
              "If the focus is none of those, keep the default order (themes, decision arcs, commitment audit, attention next) and lead with whatever it names.",
            ].join("\n");
      return joinSections([
        "Synthesize my last seven days of meetings and voice memos into a forward-looking brief.",
        "Gather first:",
        [
          "1. list_meetings, then keep only entries whose date falls in the last seven days. Do not search for a date string; dates live in frontmatter, not in transcript text.",
          "2. Resolve each kept entry with get_meeting.",
          "3. get_meeting_insights for this week's decisions, and search_meetings on each recurring topic over the last 30 days so you can see how a decision moved.",
          "4. track_commitments for what is open or stale, and consistency_report for decisions that contradict each other.",
        ].join("\n"),
        "Then produce:",
        [
          "**Themes** - the three to five topics that came up in two or more recordings. For each: which meetings, how the conversation moved, and whether it resolved.",
          "**Decision arcs** - a table of decisions with a status of STABLE (held across mentions), VOLATILE (changed twice or more in 14 days), CONFLICTING (two contradictory decisions are both live), or NEW. Call out CONFLICTING items prominently; they are the ones that cost real time.",
          "**Commitment audit** - completed, on track, overdue, and owed to me by someone else. State overdue items factually, with the date and who is waiting. Do not nag.",
          "**Attention next** - a ranked list. Order by conflicting decisions, then overdue commitments, then open commitments.",
        ].join("\n"),
        ordering,
        CORPUS_RULES,
        "If there were no recordings in the last seven days, say exactly that and offer to widen the window to 14 days. Do not synthesize a week that has no source material. If there were only one or two, still write the brief and note that it was a light week.",
      ]);
    },
  },
  {
    name: "find_action_items",
    title: "Find action items for a person",
    description:
      "Surface every open commitment a person owes or is owed, with the meeting each came from.",
    args: [
      {
        name: "person",
        description: "Name of the person whose action items you want.",
        required: true,
      },
    ],
    build: ({ person }) =>
      joinSections([
        `Show me the open action items involving ${person}.`,
        [
          `1. track_commitments filtered to ${person}.`,
          `2. get_meeting_insights for commitments mentioning ${person}, so items captured as insights are not missed.`,
          "3. Resolve the source meeting of anything unclear with get_meeting before you describe it.",
        ].join("\n"),
        "Group the result into what they owe me and what I owe them. For each item give the commitment as it was actually stated, the meeting and date it came from, and the due date if there is one. Sort overdue items to the top.",
        CORPUS_RULES,
        `If track_commitments fails or returns a partial view, say the commitment projection is unavailable. Do not tell me ${person} has nothing open.`,
      ]),
  },
  {
    name: "person_briefing",
    title: "Brief me on a person",
    description:
      "A one-page briefing on someone before a call: recent history, what they are focused on, open commitments, and a concrete opening line.",
    args: [
      {
        name: "name",
        description: "Name of the person you are about to meet.",
        required: true,
      },
    ],
    build: ({ name }) =>
      joinSections([
        `Brief me on ${name} before my next conversation with them. I want to read this in 60 seconds.`,
        "Gather these in parallel, then synthesize only from what actually came back:",
        [
          `1. get_person_profile for ${name}.`,
          `2. search_meetings for ${name}, limited to the last 60 days and a small result count.`,
          `3. get_meeting_insights for decisions involving ${name} in the last 30 days.`,
          `4. track_commitments filtered to ${name}.`,
          "5. Resolve at most the two most recent meetings with get_meeting. Past three, you are padding.",
        ].join("\n"),
        "Write the brief in exactly this shape:",
        [
          `# Brief: ${name}`,
          "",
          "**Last conversation** (date) - two or three sentences of prose, including the tone if the transcript makes it clear. If the most recent meeting is three or more months old, lead with that fact; my sense of the relationship is probably more current than reality.",
          "",
          "**They have been thinking about** - three to five topics from the last 30 days, ordered by recency and frequency.",
          "",
          "**Commitments** - what is open in each direction, with dates. Flag overdue items.",
          "",
          "**Where things stand** - one line: warming, cooling, stable, urgent, or drifting.",
          "",
          "**Open with** - one sentence I could say verbatim at the top of the call. It has to cite something specific from our actual history.",
        ].join("\n"),
        [
          "The opening line is the part that matters. \"Hey, how is everything going?\" is filler that could be said to anyone. \"Last time you said the hiring freeze was making your roadmap impossible - did legal come back on the contractor question?\" is usable, because only our history could produce it.",
          "",
          "Be specific everywhere else too. \"They want to talk about Q2\" is useless; \"they have raised the Q2 hiring freeze in three of their last four meetings\" is not.",
        ].join("\n"),
        CORPUS_RULES,
        SPEAKER_RULES,
        `If the searches come back empty, say plainly that no matching history was found for ${name} and stop there. Never invent a relationship history. Keep the body under about 25 lines; if it is longer, it has filler in it.`,
      ]),
  },
  {
    name: "topic_research",
    title: "Research a topic across meetings",
    description:
      "Trace how a topic developed across meetings: what was decided, what is still open, and where it was discussed most.",
    args: [
      {
        name: "topic",
        description: "The topic, project, or question to trace across your meeting history.",
        required: true,
      },
    ],
    build: ({ topic }) =>
      joinSections([
        `Research ${topic} across my meeting history.`,
        [
          `1. research_topic for ${topic}.`,
          "2. search_meetings with two or three different phrasings. Search is substring matching, not fuzzy: \"price\" finds \"pricing\", but a typo finds nothing, and a phrase people would actually say beats a title.",
          "3. Resolve the meetings that matter with get_meeting.",
          "4. get_meeting_insights for decisions on this topic, and consistency_report if the decisions look like they disagree.",
        ].join("\n"),
        "Then give me:",
        [
          "**How it developed** - a timeline of the discussion, oldest to newest, one line per meeting. Show where the thinking changed and why.",
          "**Where it landed** - the decisions that are currently live, with dates. If two live decisions contradict, say so outright.",
          "**Still open** - questions raised and never answered, and commitments still outstanding.",
          "**Who drives it** - who raises this topic most, and who has been quiet on it.",
        ].join("\n"),
        CORPUS_RULES,
        SPEAKER_RULES,
      ]),
  },
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
