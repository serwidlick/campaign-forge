/**
 * Agent preferences (model, effort, permissions) live in the app settings
 * store. The API key does not: it is in the OS credential store, see
 * `secrets` in tauri.ts.
 */
import { load, type Store } from "@tauri-apps/plugin-store";

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

/** Current-generation models. The first is the default. */
export const MODELS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "Best judgement; the default.",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    note: "Faster and cheaper, still strong.",
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    note: "Cheapest; fine for quick lookups.",
  },
];

export type Effort = "low" | "medium" | "high";

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low (quick answers)" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High (thinks harder)" },
];

/**
 * What the assistant is allowed to do to the campaign. Each permission gates
 * a set of tools; a tool the model cannot see, it cannot call.
 */
export type Permission = "read" | "create" | "update" | "delete";

export type Permissions = Record<Permission, boolean>;

export const PERMISSIONS: {
  id: Permission;
  label: string;
  detail: string;
  danger?: boolean;
}[] = [
  {
    id: "read",
    label: "Read",
    detail: "Search, list and read elements. Needed for almost everything.",
  },
  {
    id: "create",
    label: "Write",
    detail:
      "Create new elements: an NPC it just invented, a session skeleton, a location.",
  },
  {
    id: "update",
    label: "Put",
    detail:
      "Change existing elements: rename, retag, rewrite or append to the body, edit fields such as a session's beats.",
  },
  {
    id: "delete",
    label: "Delete",
    detail:
      "Remove elements. The file is deleted from disk. Off unless you really want it.",
    danger: true,
  },
];

export interface AgentSettings {
  model: string;
  effort: Effort;
  permissions: Permissions;
}

export const DEFAULT_PERMISSIONS: Permissions = {
  read: true,
  create: false,
  update: false,
  delete: false,
};

export const DEFAULT_SETTINGS: AgentSettings = {
  model: MODELS[0]?.id ?? "claude-opus-5-5",
  effort: "medium",
  permissions: DEFAULT_PERMISSIONS,
};

const KEY = "agent";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load("settings.json", { autoSave: true });
  return storePromise;
}

export async function loadAgentSettings(): Promise<AgentSettings> {
  try {
    const store = await getStore();
    const saved = (await store.get<Partial<AgentSettings>>(KEY)) ?? {};
    const model = MODELS.some((m) => m.id === saved.model)
      ? (saved.model as string)
      : DEFAULT_SETTINGS.model;
    const effort = EFFORTS.some((e) => e.id === saved.effort)
      ? (saved.effort as Effort)
      : DEFAULT_SETTINGS.effort;
    const savedPerms = (saved.permissions ?? {}) as Partial<Permissions>;
    const permissions: Permissions = {
      read: savedPerms.read ?? DEFAULT_PERMISSIONS.read,
      create: savedPerms.create ?? DEFAULT_PERMISSIONS.create,
      update: savedPerms.update ?? DEFAULT_PERMISSIONS.update,
      delete: savedPerms.delete ?? DEFAULT_PERMISSIONS.delete,
    };
    return { model, effort, permissions };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveAgentSettings(
  settings: AgentSettings,
): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, settings);
  } catch {
    // Settings are a convenience; a failed save is not worth an error banner.
  }
}

export function enabledPermissions(p: Permissions): Permission[] {
  return PERMISSIONS.map((x) => x.id).filter((id) => p[id]);
}

// ---- Usage and cost ---------------------------------------------------------

/** Tokens consumed by one or more model calls. */
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Number of model calls (one per tool-loop iteration). */
  calls: number;
}

export const EMPTY_USAGE: TurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 0,
};

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    calls: a.calls + b.calls,
  };
}

/** USD per million tokens. Anthropic list prices; update when they change. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICING: Record<string, Pricing> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  },
};

/** Approximate cost in USD, or null when the model's prices are unknown. */
export function estimateCostUsd(
  usage: TurnUsage,
  model: string | undefined,
): number | null {
  const p = model ? PRICING[model] : undefined;
  if (!p) return null;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatUsd(x: number): string {
  if (x < 0.005) return "<$0.01";
  return `$${x.toFixed(2)}`;
}

/** Share of prompt tokens that were served from the cache, 0-1. */
export function cacheShare(usage: TurnUsage): number {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt === 0 ? 0 : usage.cacheRead / prompt;
}
