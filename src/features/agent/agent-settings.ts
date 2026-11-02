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
