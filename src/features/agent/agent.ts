/**
 * The assistant's tool loop. Modelled on powerdog's AnthropicChatService:
 * stream a turn, run any tools it asked for, append the results, repeat,
 * with a hard cap on iterations and on the size of what a tool feeds back.
 *
 * Runs inside the webview with the user's own key. Requests go through
 * Tauri's HTTP plugin so the webview's CORS rules do not apply.
 */
import Anthropic from "@anthropic-ai/sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { CampaignMeta, ElementSummary } from "@/lib/types";

import {
  PERMISSIONS,
  enabledPermissions,
  type Effort,
  type Permissions,
  type TurnUsage,
} from "./agent-settings";
import { findTool, toolsFor } from "./agent-tools";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

function usageOf(message: Anthropic.Beta.BetaMessage): TurnUsage {
  const u = message.usage;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    calls: 1,
  };
}

const MAX_TOOL_ITERATIONS = 10;
const MAX_TOKENS = 16000;
const TOOL_PREVIEW_LIMIT = 240;
/** ~8 KB ≈ 2K tokens per tool result keeps long loops affordable. */
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_INDEX_ENTRIES = 600;

const SYSTEM_PROMPT = [
  "You are the campaign assistant inside Campaign Forge, a desktop app a game master (GM) uses to prepare and run a tabletop RPG campaign.",
  "",
  "## The campaign",
  "Everything the GM has written lives in elements of these kinds: character, faction, creature, location, map, item, quest, event, lore, arc, session. Each element has an id, a name, tags, kind-specific fields and a Markdown body.",
  "Sessions have a number, a date, a status (planned/played), an arc, and a list of beats; one beat may be the main encounter and one the cliffhanger. Arcs group sessions. Maps have pins that link to elements, routes, and a scale.",
  "",
  "## How to work",
  "- Look things up with the tools before answering questions about the campaign. Never invent campaign facts; if the files do not say, say so.",
  "- Start with search_campaign or list_elements to find ids, then read_element for detail. Read only what you need.",
  "- When you mention an element, link it as [Name](cf://element/<id>) so the GM can click straight to it. Use the exact ids the tools return.",
  "- You may brainstorm when asked (names, plot hooks, NPC motives, what an NPC would do next). Ground suggestions in what you read, and make clear they are suggestions.",
  "- Be concise. Prefer short paragraphs and bullet lists. Do not restate the question.",
  "- If a request is unrelated to the campaign or to running the game, say so briefly.",
  "",
  "## Changing the campaign",
  "The GM decides which abilities you have; the current set is listed below and only those tools exist this turn. When you do have write abilities:",
  "- Say in one short line what you are about to create or change, then do it, then link the result.",
  "- Read an element before updating it, and prefer append over replacing a body the GM wrote.",
  "- Keep the GM's voice and formatting. Do not pad with headings or boilerplate.",
  "- Never delete anything the GM did not explicitly ask to delete in this conversation. If unsure, ask first.",
  "- If an ability you need is off, say which setting to turn on instead of working around it.",
].join("\n");

export interface RunTurnOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  permissions: Permissions;
  campaign: CampaignMeta;
  elements: ElementSummary[];
  /** Conversation so far. Mutated in place: the assistant turn and any tool round-trips are appended. */
  history: Anthropic.Beta.BetaMessageParam[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    // Route through Tauri so the request is not subject to webview CORS.
    fetch: (input, init) => tauriFetch(input, init),
    maxRetries: 2,
    timeout: 60_000,
  });
}

/** One user turn: streams text, runs tools, and settles when the model stops. */
export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { history, onEvent, signal, permissions } = opts;
  const client = createClient(opts.apiKey);
  const tools = toolsFor(permissions).map((t) => t.definition);
  const system = buildSystem(opts.campaign, opts.elements, permissions);
  // Haiku has no server-side fallback model; sending the parameter there is
  // pointless. Everywhere else, a safety-classifier decline reroutes.
  const supportsFallback = !opts.model.includes("haiku");

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model: opts.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: opts.effort },
          system,
          ...(tools.length > 0 ? { tools } : {}),
          messages: withCacheBreakpoint(history),
          ...(supportsFallback
            ? {
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default" as const,
              }
            : {}),
        },
        { signal },
      );
      stream.on("text", (delta) => onEvent({ type: "text", delta }));
      message = await stream.finalMessage();
    } catch (err) {
      if (signal?.aborted) return;
      onEvent({ type: "error", message: describeError(err) });
      return;
    }

    history.push({ role: "assistant", content: message.content });
    onEvent({ type: "usage", usage: usageOf(message) });

    if (message.stop_reason === "refusal") {
      onEvent({
        type: "error",
        message:
          "The model declined to continue with this request (safety classifier). Try rephrasing.",
      });
      return;
    }
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    // A tool input cut off at max_tokens can still parse; never run it.
    if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
      onEvent({
        type: "error",
        message:
          "The reply was cut off before a tool call completed. Try again.",
      });
      return;
    }
    if (message.stop_reason !== "tool_use") {
      onEvent({ type: "done", stopReason: message.stop_reason ?? "unknown" });
      return;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      onEvent({
        type: "tool_use",
        id: use.id,
        name: use.name,
        input: use.input,
      });
      const { text, isError } = await executeTool(
        use.name,
        use.input,
        permissions,
      );
      onEvent({
        type: "tool_result",
        id: use.id,
        isError,
        preview:
          text.length > TOOL_PREVIEW_LIMIT
            ? `${text.slice(0, TOOL_PREVIEW_LIMIT)}…`
            : text,
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: truncateToolResult(text),
        is_error: isError,
      });
    }
    history.push({ role: "user", content: results });
  }

  onEvent({
    type: "error",
    message: `Stopped after ${MAX_TOOL_ITERATIONS} tool calls without a final answer.`,
  });
}

async function executeTool(
  name: string,
  input: unknown,
  permissions: Permissions,
): Promise<{ text: string; isError: boolean }> {
  const tool = findTool(name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  if (!permissions[tool.permission]) {
    const label =
      PERMISSIONS.find((p) => p.id === tool.permission)?.label ??
      tool.permission;
    return {
      text: `PERMISSION_DENIED: the "${label}" ability is turned off in the assistant settings.`,
      isError: true,
    };
  }
  try {
    const text = await tool.run(input);
    return { text, isError: text.startsWith("INVALID_INPUT") };
  } catch (err) {
    return { text: `Tool error: ${describeError(err)}`, isError: true };
  }
}

function buildSystem(
  campaign: CampaignMeta,
  elements: ElementSummary[],
  permissions: Permissions,
): Anthropic.Beta.BetaTextBlockParam[] {
  const abilities = enabledPermissions(permissions).map(
    (id) => PERMISSIONS.find((p) => p.id === id)?.label.toLowerCase() ?? id,
  );
  const lines = [
    `## This campaign`,
    `Name: ${campaign.name}${campaign.system ? ` · System: ${campaign.system}` : ""}`,
    `Elements: ${elements.length}`,
    `Your abilities this turn: ${abilities.length ? abilities.join(", ") : "none (no tools)"}`,
    "",
    "Index (kind · name · id):",
  ];
  const shown = elements.slice(0, MAX_INDEX_ENTRIES);
  for (const e of shown) lines.push(`- ${e.type} · ${e.name} · ${e.id}`);
  if (elements.length > shown.length) {
    lines.push(
      `…and ${elements.length - shown.length} more. Use list_elements or search_campaign to find them.`,
    );
  }
  return [
    // Stable instructions first so the cached prefix survives index changes.
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: lines.join("\n"),
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * Marks a cache breakpoint on the last message so each loop iteration reuses
 * the prefix and pays only for the newly appended blocks. Returns a copy.
 */
function withCacheBreakpoint(
  history: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.BetaMessageParam[] {
  const last = history[history.length - 1];
  // Only user/assistant turns carry content blocks we can mark; a
  // mid-conversation system message has a different shape and we never
  // append one, so leave the history untouched in that case.
  if (!last || last.role === "system") return history;
  const content: Anthropic.Beta.BetaContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];
  const tail = content[content.length - 1];
  if (!tail || tail.type === "thinking" || tail.type === "redacted_thinking") {
    return history;
  }
  content[content.length - 1] = {
    ...tail,
    cache_control: { type: "ephemeral" },
  } as Anthropic.Beta.BetaContentBlockParam;
  const marked: Anthropic.Beta.BetaMessageParam = { role: last.role, content };
  return [...history.slice(0, -1), marked];
}

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated: showing first ${MAX_TOOL_RESULT_CHARS} of ${text.length} characters. Ask for a narrower read if you need the rest.]`;
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the API key. Check it in the assistant settings.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic rate limit hit. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach Anthropic. Check your connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic error ${err.status ?? ""}: ${err.message}`.trim();
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
