import type Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";

import {
  DEFAULT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
  EMPTY_USAGE,
  addUsage,
  type AgentSettings,
  type Effort,
  type Permission,
  type TurnUsage,
} from "@/features/agent/agent-settings";
import {
  announceChanges,
  runTurn,
  startSession,
  type AgentEvent,
  type AgentSession,
} from "@/features/agent/agent";
import {
  fromStored,
  titleFrom,
  toStored,
} from "@/features/agent/conversation-file";
import { conversations, errorMessage, secrets } from "@/lib/tauri";
import type { ConversationSummary } from "@/lib/types";

import { useCampaignStore } from "./campaign-store";

export interface UiTextPart {
  kind: "text";
  text: string;
}

export interface UiToolPart {
  kind: "tool";
  toolId: string;
  name: string;
  input: unknown;
  result?: { preview: string; isError: boolean };
}

export type UiPart = UiTextPart | UiToolPart;

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  parts: UiPart[];
  error?: string;
  /** Model that produced an assistant message; used to price its usage. */
  model?: string;
  /** Tokens across every model call that made up this assistant message. */
  usage?: TurnUsage;
  /** Something worth knowing that is not an error, e.g. reasoning dropped. */
  notice?: string;
}

interface AgentState {
  ready: boolean;
  hasApiKey: boolean;
  settings: AgentSettings;
  messages: UiMessage[];
  streaming: boolean;
  error: string | null;
  /** Saved conversations in the open campaign, newest first. */
  conversations: ConversationSummary[];
  /** The conversation on screen, once its first message is sent. */
  conversationId: string | null;

  /** Load key presence and settings. Safe to call more than once. */
  init: () => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEffort: (effort: Effort) => Promise<void>;
  setPermission: (permission: Permission, on: boolean) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  /** Start an empty chat. The current one stays saved. */
  newConversation: () => Promise<void>;
  /** Re-read the open campaign's saved conversations. */
  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  /** Deletes the file. Deleting the one on screen starts an empty chat. */
  deleteConversation: (id: string) => Promise<void>;
  clearError: () => void;
}

/** API-shaped history, kept out of React state: it only matters to the loop. */
let history: Anthropic.Beta.BetaMessageParam[] = [];
/**
 * The frozen request prefix for the current conversation. Built with the
 * first message and reused until the chat is cleared: the API binds every
 * thinking block it returns to the system prompt and tool list that produced
 * it, so those must not change mid-conversation.
 */
let session: AgentSession | null = null;
/** Envelope of the conversation on screen; null until its first message. */
let current: {
  id: string;
  title: string;
  createdAt: string;
  campaignId: string;
} | null = null;
/**
 * Bumped whenever the conversation on screen is replaced. A turn that was
 * stopped finishes in the background; it checks this before saving so it
 * never writes into the conversation that replaced it.
 */
let generation = 0;
/** The assistant message the running turn writes into. */
let pendingAssistantId: string | null = null;
/**
 * Settles when the running turn has finished and saved. Switching away waits
 * for it, so a stopped turn's last tool results land in its own file and the
 * saved transcript never ends on an unanswered tool call.
 */
let turnDone: Promise<void> | null = null;
let abort: AbortController | null = null;

export const useAgentStore = create<AgentState>((set, get) => ({
  ready: false,
  hasApiKey: false,
  settings: DEFAULT_SETTINGS,
  messages: [],
  streaming: false,
  error: null,
  conversations: [],
  conversationId: null,

  async init() {
    const [key, settings] = await Promise.all([
      secrets.getApiKey().catch(() => null),
      loadAgentSettings(),
    ]);
    set({ ready: true, hasApiKey: Boolean(key), settings });
  },

  async setApiKey(key) {
    try {
      await secrets.setApiKey(key);
      set({ hasApiKey: true, error: null });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async clearApiKey() {
    try {
      await secrets.clearApiKey();
      set({ hasApiKey: false });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async setModel(model) {
    const settings = { ...get().settings, model };
    set({ settings });
    await saveAgentSettings(settings);
  },

  async setEffort(effort) {
    const settings = { ...get().settings, effort };
    set({ settings });
    await saveAgentSettings(settings);
  },

  async setPermission(permission, on) {
    const current = get().settings;
    const settings: AgentSettings = {
      ...current,
      permissions: { ...current.permissions, [permission]: on },
    };
    set({ settings });
    await saveAgentSettings(settings);
  },

  async send(text) {
    const trimmed = text.trim();
    if (!trimmed || get().streaming) return;
    const campaign = useCampaignStore.getState().campaign;
    if (!campaign) {
      set({ error: "Open a campaign first." });
      return;
    }
    const apiKey = await secrets.getApiKey().catch(() => null);
    if (!apiKey) {
      set({
        hasApiKey: false,
        error: "Add your Anthropic API key in settings.",
      });
      return;
    }
    // A conversation belongs to one campaign; switching campaigns starts over.
    if (current && current.campaignId !== campaign.id) resetChat(set);
    if (!current) {
      current = {
        id: crypto.randomUUID(),
        title: titleFrom(trimmed),
        createdAt: "",
        campaignId: campaign.id,
      };
      set({ conversationId: current.id });
    }
    const turn = generation;

    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ kind: "text", text: trimmed }],
    };
    const assistantId = crypto.randomUUID();
    set((s) => ({
      messages: [
        ...s.messages,
        userMessage,
        {
          id: assistantId,
          role: "assistant",
          parts: [],
          model: s.settings.model,
        },
      ],
      streaming: true,
      error: null,
    }));
    history.push({ role: "user", content: trimmed });

    const { settings } = get();
    const elements = useCampaignStore.getState().elements;
    if (!session) {
      session = startSession(campaign, elements, settings.permissions);
    } else {
      announceChanges(session, history, settings.permissions, elements);
    }

    // This turn's own references: if the GM opens another conversation
    // meanwhile, the module variables move on but this turn must not.
    const turnHistory = history;
    const turnSession = session;

    let finish = () => {};
    turnDone = new Promise((resolve) => (finish = resolve));
    try {
      // Save the question before the reply, so a crash mid-turn keeps it.
      await persist(set, get);
      if (turn !== generation) return;
      if (!get().streaming) {
        // Stopped while the question was being saved.
        markIfEmpty(assistantId, "Stopped before a reply.");
        await persist(set, get);
        return;
      }

      abort = new AbortController();
      pendingAssistantId = assistantId;
      await runTurn({
        apiKey,
        model: settings.model,
        effort: settings.effort,
        permissions: settings.permissions,
        session: turnSession,
        history: turnHistory,
        signal: abort.signal,
        onEvent: (event) => applyEvent(assistantId, event),
      });
      // The conversation was deleted while the turn ran: nothing to save.
      if (turn !== generation) return;
      abort = null;
      pendingAssistantId = null;
      set({ streaming: false });
      await persist(set, get);
    } finally {
      turnDone = null;
      finish();
    }
  },

  stop() {
    abort?.abort();
    abort = null;
    if (pendingAssistantId) {
      applyEvent(pendingAssistantId, {
        type: "notice",
        message: "Stopped.",
      });
      markIfEmpty(pendingAssistantId, "Stopped before a reply.");
      pendingAssistantId = null;
    }
    set({ streaming: false });
  },

  async newConversation() {
    await leaveCurrent(get);
    resetChat(set);
    set({ error: null });
  },

  async loadConversations() {
    const campaign = useCampaignStore.getState().campaign;
    if (current && current.campaignId !== campaign?.id) resetChat(set);
    if (!campaign) {
      set({ conversations: [] });
      return;
    }
    try {
      const list = await conversations.list();
      // The campaign may have changed while the list was loading.
      if (useCampaignStore.getState().campaign?.id === campaign.id) {
        set({ conversations: list });
      }
    } catch (err) {
      set({ error: `Could not list conversations: ${errorMessage(err)}` });
    }
  },

  async openConversation(id) {
    if (id === current?.id) return;
    const campaign = useCampaignStore.getState().campaign;
    if (!campaign) return;
    try {
      const state = fromStored(await conversations.read(id));
      await leaveCurrent(get);
      generation++;
      history = state.history;
      session = state.session;
      // A file copied in from another campaign is resumed here, in this one.
      session.campaignId = campaign.id;
      current = {
        id: state.id,
        title: state.title,
        createdAt: state.createdAt,
        campaignId: campaign.id,
      };
      set({
        messages: state.messages.map((m) =>
          m.role === "assistant" && m.parts.length === 0 && !m.error
            ? { ...m, error: "No reply was saved for this message." }
            : m,
        ),
        conversationId: state.id,
        error: null,
      });
    } catch (err) {
      set({ error: `Could not open that conversation: ${errorMessage(err)}` });
    }
  },

  async deleteConversation(id) {
    try {
      // Let a running turn stop and save first, or its final save would
      // write the file straight back after the delete.
      if (id === current?.id) {
        await leaveCurrent(get);
        resetChat(set);
      }
      await conversations.delete(id);
      set((s) => ({
        conversations: s.conversations.filter((c) => c.id !== id),
      }));
    } catch (err) {
      set({
        error: `Could not delete that conversation: ${errorMessage(err)}`,
      });
    }
  },

  clearError() {
    set({ error: null });
  },
}));

type SetState = (
  partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>),
) => void;
type GetState = () => AgentState;

/** Empties the chat on screen. Does not touch any saved file. */
function resetChat(set: SetState): void {
  generation++;
  history = [];
  session = null;
  current = null;
  pendingAssistantId = null;
  set({ messages: [], conversationId: null });
}

/**
 * Stops a running turn and waits for it to finish and save, so switching
 * away never cuts a turn off between a tool call and its result.
 */
async function leaveCurrent(get: GetState): Promise<void> {
  if (!turnDone) return;
  get().stop();
  await turnDone;
}

/**
 * Writes the conversation on screen to `conversations/<id>.json` and moves
 * it to the top of the list. A failed save is shown but never stops the chat.
 */
async function persist(set: SetState, get: GetState): Promise<void> {
  if (!current || !session) return;
  const snapshot = toStored({
    ...current,
    messages: get().messages,
    history,
    session,
  });
  const saving = current;
  try {
    const summary = await conversations.save(snapshot);
    if (current === saving) current.createdAt = summary.createdAt;
    set((s) => ({
      conversations: [
        summary,
        ...s.conversations.filter((c) => c.id !== summary.id),
      ],
    }));
  } catch (err) {
    set({ error: `Could not save this conversation: ${errorMessage(err)}` });
  }
}

function markIfEmpty(assistantId: string, error: string): void {
  useAgentStore.setState((s) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId && m.parts.length === 0 && !m.error
        ? { ...m, error, notice: undefined }
        : m,
    ),
  }));
}

function applyEvent(assistantId: string, event: AgentEvent): void {
  useAgentStore.setState((s) => ({
    messages: s.messages.map((m) => {
      if (m.id !== assistantId) return m;
      const parts = [...m.parts];
      switch (event.type) {
        case "text": {
          const last = parts[parts.length - 1];
          if (last && last.kind === "text") {
            parts[parts.length - 1] = {
              kind: "text",
              text: last.text + event.delta,
            };
          } else {
            parts.push({ kind: "text", text: event.delta });
          }
          return { ...m, parts };
        }
        case "tool_use":
          parts.push({
            kind: "tool",
            toolId: event.id,
            name: event.name,
            input: event.input,
          });
          return { ...m, parts };
        case "tool_result": {
          const idx = parts.findIndex(
            (p) => p.kind === "tool" && p.toolId === event.id,
          );
          const existing = parts[idx];
          if (existing && existing.kind === "tool") {
            parts[idx] = {
              ...existing,
              result: { preview: event.preview, isError: event.isError },
            };
          }
          return { ...m, parts };
        }
        case "usage":
          return { ...m, usage: addUsage(m.usage ?? EMPTY_USAGE, event.usage) };
        case "notice":
          return { ...m, notice: event.message };
        case "error":
          return { ...m, error: event.message };
        case "done":
          return m;
      }
    }),
  }));
}
