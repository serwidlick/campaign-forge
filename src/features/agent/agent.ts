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
import { AGENT_TOOLS, findTool } from "./agent-tools";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; isError: boolean; preview: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "done"; stopReason: string }
  | { type: "notice"; message: string }
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
const MAX_DELTA_ENTRIES = 50;

const SYSTEM_PROMPT = [
  "You are the campaign assistant inside Campaign Forge, a desktop app a game master (GM) uses to prepare and run a tabletop RPG campaign.",
  "",
  "## The campaign",
  "Everything the GM has written lives in elements of these kinds: character, faction, creature, location, map, item, document, quest, event, lore, arc, session, journal. Each element has an id, a name, tags, kind-specific fields, an optional portrait (a picture file path) and a Markdown body.",
  "Sessions have a number, a date, a status (planned/played), an arc, and a list of beats; one beat may be the main encounter and one the cliffhanger. Arcs group sessions. Maps have pins that link to elements, territories (named areas, usually a faction's or a realm's, each optionally linked to an element), routes, and a scale; a pin or territory linked to another map nests that map inside this one. Documents hold a PDF (a rulebook, a handout) in their file field plus notes. Every character has a role field: pc (one of the players' characters) or npc (anyone else; the default when the field is missing). In a D&D 5e campaign (campaign setting rules = dnd5e) a character also carries a sheet object: { owner (table name of the player allowed to edit it), class, subclass, level, species, background, alignment, abilities: { str, dex, con, int, wis, cha } (scores, not modifiers), ac, hp: { max, current, temp }, speed, saves: [ability keys], skills: [skill ids such as perception, stealth], expertise: [skill ids], senses, languages, attacks: [{ name, bonus, damage, notes }], features: [{ name, source, notes }], spellcasting: { ability, slots keyed by spell level 1-9 each { max, used }, spells: [{ name, level, prepared, notes }] }, inventory: [{ name, qty, weight, notes }], currency: { cp, sp, ep, gp, pp }, personality: { traits, ideals, bonds, flaws }, status: { inspiration, deathSaves, conditions, exhaustion, hitDiceUsed } }; set it through update_element fields. A creature in a 5e campaign carries a statblock object: { size, type, alignment, ac, acNote, hp, hpFormula, speed, abilities, saves, skills, vulnerabilities, resistances, immunities, conditionImmunities, senses, languages, cr such as 1/4 or 5, traits/actions/bonusActions/reactions/legendary: [{ name, text }] }. Journal entries have a real-world date, an optional in-world date, and a scope: the campaign, an arc, or a session; they hold recaps and notes. Any element may have shared: true, which lets players see it in the player view, and an optional audience: [player ids] that limits it to those players (players and their ids are listed in the campaign's players setting); map pins, routes and territories carry their own shared flag. Treat everything else as GM-only. If a shared element's body has a '## Players know' heading, players receive only that section and the rest stays GM-only; when asked to write player-facing text, put it under that heading.",
  "",
  "## How to work",
  "- Look things up with the tools before answering questions about the campaign. Never invent campaign facts; if the files do not say, say so.",
  "- Start with search_campaign or list_elements to find ids, then read_element for detail. Read only what you need.",
  "- A document element's PDF is readable with read_document, a few pages at a time. Elements tagged 'imported' were built from a PDF and end with a Source line naming the document and pages; read those pages when the GM wants detail the notes lack.",
  "- When you mention an element, link it as [Name](cf://element/<id>) so the GM can click straight to it. Use the exact ids the tools return.",
  "- You may brainstorm when asked (names, plot hooks, NPC motives, what an NPC would do next). Ground suggestions in what you read, and make clear they are suggestions.",
  "- Be concise. Prefer short paragraphs and bullet lists. Do not restate the question.",
  "- If a request is unrelated to the campaign or to running the game, say so briefly.",
  "",
  "## Changing the campaign",
  "The GM decides which abilities you have. Every tool is listed, but a tool whose ability is off answers PERMISSION_DENIED; the abilities in force are stated below, and a system message in the conversation says when they change. When you do have write abilities:",
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
  /** Abilities in force for this turn; tools outside them answer PERMISSION_DENIED. */
  permissions: Permissions;
  /** The conversation's frozen request prefix, from `startSession`. */
  session: AgentSession;
  /** Conversation so far. Mutated in place: the assistant turn and any tool round-trips are appended. */
  history: Anthropic.Beta.BetaMessageParam[];
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * The part of every request that must not change for the life of a
 * conversation. A thinking block the model returns is signed against the
 * `system` prompt, the `tools` list and every earlier message; replaying it
 * after any of those changed is a 400 ("bound to a different conversation").
 * So the prefix is built once per conversation and anything that moves
 * afterwards (abilities, new elements) is appended as a system message.
 */
export interface AgentSession {
  campaignId: string;
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  /**
   * What the model was last told, so each turn appends only the delta.
   * Plain JSON (element id -> "kind · name") so a saved conversation can
   * carry the session as-is.
   */
  announced: {
    permissions: Permissions;
    elements: Record<string, string>;
  };
}

export function startSession(
  campaign: CampaignMeta,
  elements: ElementSummary[],
  permissions: Permissions,
): AgentSession {
  return {
    campaignId: campaign.id,
    system: buildSystem(campaign, elements, permissions),
    tools: AGENT_TOOLS.map((t) => t.definition),
    announced: {
      permissions: { ...permissions },
      elements: indexLabels(elements),
    },
  };
}

/**
 * Appends a mid-conversation system message describing what changed since
 * the model was last told: abilities toggled, elements added or removed.
 * Must follow the user message it belongs to, so call it right after pushing
 * one. Returns true when something was appended.
 */
export function announceChanges(
  session: AgentSession,
  history: Anthropic.Beta.BetaMessageParam[],
  permissions: Permissions,
  elements: ElementSummary[],
): boolean {
  const lines: string[] = [];
  const { announced } = session;

  const same = PERMISSIONS.every(
    (p) => announced.permissions[p.id] === permissions[p.id],
  );
  if (!same) {
    lines.push(`Your abilities are now: ${describeAbilities(permissions)}.`);
    announced.permissions = { ...permissions };
  }

  const current = indexLabels(elements);
  const added: string[] = [];
  for (const [id, label] of Object.entries(current)) {
    if (!(id in announced.elements)) added.push(`- ${label} · ${id}`);
  }
  const removed: string[] = [];
  for (const id of Object.keys(announced.elements)) {
    if (!(id in current)) removed.push(id);
  }
  if (added.length > 0) {
    lines.push("Elements added since the index:");
    lines.push(...added.slice(0, MAX_DELTA_ENTRIES));
    if (added.length > MAX_DELTA_ENTRIES) {
      lines.push(`…and ${added.length - MAX_DELTA_ENTRIES} more.`);
    }
  }
  if (removed.length > 0) {
    const more =
      removed.length > MAX_DELTA_ENTRIES
        ? ` and ${removed.length - MAX_DELTA_ENTRIES} more`
        : "";
    lines.push(
      `Elements removed: ${removed.slice(0, MAX_DELTA_ENTRIES).join(", ")}${more}.`,
    );
  }
  announced.elements = current;

  if (lines.length === 0) return false;
  history.push({ role: "system", content: lines.join("\n") });
  return true;
}

function indexLabels(elements: ElementSummary[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of elements) out[e.id] = `${e.type} · ${e.name}`;
  return out;
}

function describeAbilities(permissions: Permissions): string {
  const abilities = enabledPermissions(permissions).map(
    (id) => PERMISSIONS.find((p) => p.id === id)?.label.toLowerCase() ?? id,
  );
  return abilities.length ? abilities.join(", ") : "none";
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
  const { history, onEvent, signal, permissions, session } = opts;
  const client = createClient(opts.apiKey);
  // Haiku has no server-side fallback model; sending the parameter there is
  // pointless. Everywhere else, a safety-classifier decline reroutes.
  const supportsFallback = !opts.model.includes("haiku");
  const betas: Anthropic.AnthropicBeta[] = [
    "thinking-binding-controls-2026-08-01",
  ];
  if (supportsFallback) betas.push("server-side-fallback-2026-07-01");

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model: opts.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: opts.effort },
          // The prefix is append-only (see AgentSession). Should a replayed
          // thinking block still fail the conversation check, drop it and
          // carry on rather than fail the turn with a 400.
          thinking: {
            type: "adaptive",
            block_binding: { prefix_mismatch_behavior: "drop_block" },
          },
          system: session.system,
          tools: session.tools,
          messages: withCacheBreakpoint(history),
          betas,
          ...(supportsFallback ? { fallbacks: "default" as const } : {}),
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
    reportDroppedThinking(message, onEvent);

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
    // Answer each call anyway: a tool call left without a result makes the
    // API reject the next message in this conversation.
    if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
      history.push({
        role: "user",
        content: toolUses.map((use) => ({
          type: "tool_result" as const,
          tool_use_id: use.id,
          content:
            "Not run: the reply was cut off before this call was complete.",
          is_error: true,
        })),
      });
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

/**
 * With `drop_block`, a thinking block that failed the conversation check is
 * removed instead of failing the request. That should not happen now that
 * the prefix is frozen per conversation, so say so when it does: the model
 * answered without its earlier reasoning.
 */
function reportDroppedThinking(
  message: Anthropic.Beta.BetaMessage,
  onEvent: (event: AgentEvent) => void,
): void {
  const dropped = (message.input_transformations ?? []).filter(
    (t) => t.type === "thinking_dropped",
  );
  if (dropped.length === 0) return;
  console.warn("Anthropic dropped thinking blocks", dropped);
  const switchedModel = dropped.some(
    (t) => t.reason === "model_binding_mismatch",
  );
  onEvent({
    type: "notice",
    message: switchedModel
      ? "Earlier reasoning came from a different model and was set aside for this reply."
      : "Earlier reasoning no longer matched this conversation and was set aside for this reply.",
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
  const lines = [
    `## This campaign`,
    `Name: ${campaign.name}${campaign.system ? ` · System: ${campaign.system}` : ""}`,
    `Elements: ${elements.length}`,
    `Your abilities: ${describeAbilities(permissions)}.`,
    "",
    "Index when this conversation started (kind · name · id); later additions and removals arrive as system messages:",
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
  // Only user/assistant turns carry content blocks we can mark; a
  // mid-conversation system message (an abilities or index update) has a
  // different shape, so mark the last turn before it instead.
  let at = history.length - 1;
  while (at >= 0 && history[at]?.role === "system") at--;
  const last = history[at];
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
  return [...history.slice(0, at), marked, ...history.slice(at + 1)];
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
