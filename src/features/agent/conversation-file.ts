/**
 * The frontend's half of a saved conversation (`conversations/<id>.json`).
 * Rust stores the envelope (id, title, timestamps) and returns everything
 * else untouched; this module owns that rest and checks it on load.
 *
 * Three things are saved, each for its own reason:
 * - `messages`: the chat as the GM saw it, tool cards and usage included.
 * - `history`: the API transcript, replayed verbatim. It carries signed
 *   thinking blocks, so it must not be rebuilt from `messages`.
 * - `session`: the system prompt and tool list the conversation started
 *   with. A thinking block is bound to that exact prefix, so a reopened
 *   conversation sends the saved one, not a freshly built one.
 */
import type Anthropic from "@anthropic-ai/sdk";

import type { StoredConversation } from "@/lib/types";
import type { UiMessage } from "@/stores/agent-store";

import type { AgentSession } from "./agent";

export const CONVERSATION_VERSION = 1;
const TITLE_CHARS = 80;

export interface ConversationState {
  id: string;
  title: string;
  /** Empty until the first save; Rust stamps it. */
  createdAt: string;
  campaignId: string;
  messages: UiMessage[];
  history: Anthropic.Beta.BetaMessageParam[];
  session: AgentSession;
}

export function toStored(c: ConversationState): StoredConversation {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: "",
    version: CONVERSATION_VERSION,
    campaignId: c.campaignId,
    messages: c.messages,
    history: c.history,
    session: c.session,
  };
}

/** Throws with a readable message when the file is not one we can resume. */
export function fromStored(file: StoredConversation): ConversationState {
  if (file.version !== CONVERSATION_VERSION) {
    throw new Error(
      `This conversation was saved by a different version of Campaign Forge (format ${String(file.version)}).`,
    );
  }
  const { campaignId, messages, history, session } = file;
  if (
    typeof campaignId !== "string" ||
    !Array.isArray(messages) ||
    !Array.isArray(history) ||
    !isSession(session)
  ) {
    throw new Error("This conversation file is damaged and cannot be opened.");
  }
  return {
    id: file.id,
    title: file.title,
    createdAt: file.createdAt,
    campaignId,
    messages: messages as UiMessage[],
    history: history as Anthropic.Beta.BetaMessageParam[],
    session,
  };
}

/** A list title from the first message: one line, trimmed, shortened. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_CHARS
    ? line
    : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

function isSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<AgentSession>;
  return (
    typeof s.campaignId === "string" &&
    Array.isArray(s.system) &&
    Array.isArray(s.tools) &&
    typeof s.announced === "object" &&
    s.announced !== null &&
    typeof s.announced.permissions === "object" &&
    typeof s.announced.elements === "object"
  );
}
