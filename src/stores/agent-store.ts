import type Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";

import {
  DEFAULT_SETTINGS,
  loadAgentSettings,
  saveAgentSettings,
  type AgentSettings,
  type Effort,
  type Permission,
} from "@/features/agent/agent-settings";
import { runTurn, type AgentEvent } from "@/features/agent/agent";
import { errorMessage, secrets } from "@/lib/tauri";

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
}

interface AgentState {
  ready: boolean;
  hasApiKey: boolean;
  settings: AgentSettings;
  messages: UiMessage[];
  streaming: boolean;
  error: string | null;

  /** Load key presence and settings. Safe to call more than once. */
  init: () => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEffort: (effort: Effort) => Promise<void>;
  setPermission: (permission: Permission, on: boolean) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
  clearError: () => void;
}

/** API-shaped history, kept out of React state: it only matters to the loop. */
let history: Anthropic.Beta.BetaMessageParam[] = [];
let abort: AbortController | null = null;

export const useAgentStore = create<AgentState>((set, get) => ({
  ready: false,
  hasApiKey: false,
  settings: DEFAULT_SETTINGS,
  messages: [],
  streaming: false,
  error: null,

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
        { id: assistantId, role: "assistant", parts: [] },
      ],
      streaming: true,
      error: null,
    }));
    history.push({ role: "user", content: trimmed });

    abort = new AbortController();
    const { settings } = get();
    await runTurn({
      apiKey,
      model: settings.model,
      effort: settings.effort,
      permissions: settings.permissions,
      campaign,
      elements: useCampaignStore.getState().elements,
      history,
      signal: abort.signal,
      onEvent: (event) => applyEvent(assistantId, event),
    });
    abort = null;
    set({ streaming: false });
  },

  stop() {
    abort?.abort();
    abort = null;
    set({ streaming: false });
  },

  clear() {
    get().stop();
    history = [];
    set({ messages: [], error: null });
  },

  clearError() {
    set({ error: null });
  },
}));

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
        case "error":
          return { ...m, error: event.message };
        case "done":
          return m;
      }
    }),
  }));
}
