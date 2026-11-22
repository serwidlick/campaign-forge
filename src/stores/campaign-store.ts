import { create } from "zustand";

import { rulesOf, type RulesId } from "@/features/templates/rulesets";
import { templateFor } from "@/features/templates/templates";
import { forgetCampaign, rememberCampaign } from "@/lib/recent";
import { errorMessage, storage } from "@/lib/tauri";
import {
  campaignSettingsOf,
  extraOf,
  isConflictError,
  type CampaignMeta,
  type DiskChanges,
  type Element,
  type ElementSummary,
  type TrashedElement,
} from "@/lib/types";

/** Any subset of an element's fields, including kind-specific ones. */
export type ElementPatch = Partial<Element>;

/** Side columns beyond the main editor. */
const MAX_PANES = 3;

interface Layout {
  selectedId: string | null;
  paneIds: string[];
}

interface CampaignState {
  campaign: CampaignMeta | null;
  elements: ElementSummary[];
  /** Deleted elements that can still be restored, most recent first. */
  trash: TrashedElement[];
  /** The element in the main column. */
  selectedId: string | null;
  selected: Element | null;
  /** Elements open in side columns, left to right. */
  paneIds: string[];
  /** Full elements loaded for side columns, by id. */
  loaded: Record<string, Element>;
  /** Per-element reload counters. Editors are keyed on these so an external
   *  rewrite (the assistant) remounts them with the new content. */
  revisions: Record<string, number>;
  /** Elements whose file changed elsewhere while the GM was editing them.
   *  Saves to them pause until `resolveConflict` picks a side. */
  conflicts: Record<string, true>;
  busy: boolean;
  error: string | null;

  /** Re-attach to a campaign the Rust side already has open (dev reloads). */
  restore: () => Promise<void>;
  /** Re-read campaign.json after Rust changed it (pairing a device). */
  reloadCampaignMeta: () => Promise<void>;
  /**
   * Open the campaign at `path`. `replacing` is the stale path of a recent
   * entry whose folder was moved: it is dropped from the recent list once the
   * new folder opens, so the campaign keeps a single row there.
   */
  openCampaign: (path: string, replacing?: string) => Promise<void>;
  createCampaign: (
    path: string,
    name: string,
    system?: string,
    rules?: RulesId,
  ) => Promise<void>;
  closeCampaign: () => void;

  refreshElements: () => Promise<void>;
  /** Show an element in the main column. */
  select: (id: string | null) => Promise<void>;
  /** Open in a side column (`pane: true`) or the main column. */
  navigate: (id: string, opts?: { pane?: boolean }) => Promise<void>;
  openInPane: (id: string) => Promise<void>;
  closePane: (id: string) => void;
  /** Swap a side column with the main column. */
  promotePane: (id: string) => Promise<void>;

  createElement: (
    kind: string,
    name: string,
    extra?: Record<string, unknown>,
  ) => Promise<Element | null>;
  /** Save a patch to any open element (main or side column). */
  saveElement: (id: string, patch: ElementPatch) => Promise<void>;
  /** Shorthand for saving the main column's element. */
  saveSelected: (patch: ElementPatch) => Promise<void>;
  /** Move an element to Recently deleted, where it can be restored. */
  deleteElement: (id: string) => Promise<void>;
  /** Re-read the Recently deleted list from disk. */
  refreshTrash: () => Promise<void>;
  /** Bring a deleted element back, with its id, and open it. */
  restoreElement: (id: string) => Promise<void>;
  /** Remove a deleted element for good. */
  purgeElement: (id: string) => Promise<void>;
  /** Make an open element another kind; its id, body and fields stay. */
  changeElementKind: (id: string, kind: string) => Promise<void>;
  /** Re-read an element from disk after an external change. */
  reloadElement: (id: string) => Promise<void>;
  /** An editor has typed changes it has not handed to `saveElement` yet. */
  setEditing: (id: string, editing: boolean) => void;
  /** React to files changed outside this window (the folder watcher). */
  applyDiskChanges: (changes: DiskChanges) => Promise<void>;
  /** After a conflict: load the other version, or overwrite it with ours. */
  resolveConflict: (id: string, keep: "theirs" | "mine") => Promise<void>;

  /** Merge a patch into the campaign's settings (e.g. `{ calendar }`). */
  updateCampaignSettings: (patch: Record<string, unknown>) => Promise<void>;

  clearError: () => void;
  setError: (message: string) => void;
}

function layoutKey(campaign: CampaignMeta): string {
  return `cf.layout.${campaign.id}`;
}

function readLayout(campaign: CampaignMeta): Layout {
  try {
    const raw = localStorage.getItem(layoutKey(campaign));
    if (!raw) return { selectedId: null, paneIds: [] };
    const parsed = JSON.parse(raw) as Partial<Layout>;
    return {
      selectedId:
        typeof parsed.selectedId === "string" ? parsed.selectedId : null,
      paneIds: Array.isArray(parsed.paneIds)
        ? parsed.paneIds.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return { selectedId: null, paneIds: [] };
  }
}

function writeLayout(campaign: CampaignMeta | null, layout: Layout): void {
  if (!campaign) return;
  try {
    localStorage.setItem(layoutKey(campaign), JSON.stringify(layout));
  } catch {
    /* per-viewer convenience only */
  }
}

/**
 * Saves run one at a time per element, each starting from the version the
 * previous one wrote, so back-to-back autosaves never trip the conflict
 * check against each other.
 */
const saveChains = new Map<string, Promise<void>>();
/** Saves queued or running, per element. */
const savesInFlight = new Map<string, number>();
/** Editors holding typed changes not yet handed to `saveElement`. */
const editing = new Set<string>();

function busyWith(id: string): boolean {
  return editing.has(id) || (savesInFlight.get(id) ?? 0) > 0;
}

export const useCampaignStore = create<CampaignState>((set, get) => {
  const persistLayout = () => {
    const { campaign, selectedId, paneIds } = get();
    writeLayout(campaign, { selectedId, paneIds });
  };

  /** The element as shown, main column first. */
  const shown = (id: string): Element | undefined => {
    const s = get();
    return s.selected && s.selected.id === id ? s.selected : s.loaded[id];
  };

  /**
   * Writes the element as currently shown. `force` skips the version check
   * (the GM chose "keep mine" after a conflict).
   */
  const writeShown = (id: string, force = false): Promise<void> => {
    savesInFlight.set(id, (savesInFlight.get(id) ?? 0) + 1);
    const run = async () => {
      try {
        const current = shown(id);
        if (!current) return;
        if (!force && get().conflicts[id]) return;
        const saved = await storage.saveElement({
          id: current.id,
          name: current.name,
          tags: current.tags,
          body: current.body,
          extra: extraOf(current),
          baseVersion: force ? undefined : current.version,
        });
        // Only the metadata can differ (updatedAt, links, version); keep the
        // body the user is typing.
        applySaved(saved);
      } catch (err) {
        const message = errorMessage(err);
        if (isConflictError(message)) {
          set((s) => ({ conflicts: { ...s.conflicts, [id]: true } }));
        } else {
          set({ error: message });
        }
      } finally {
        const left = (savesInFlight.get(id) ?? 1) - 1;
        if (left > 0) savesInFlight.set(id, left);
        else savesInFlight.delete(id);
      }
    };
    const next = (saveChains.get(id) ?? Promise.resolve()).then(run);
    saveChains.set(id, next);
    return next;
  };

  /** Apply a saved element's metadata to every place it is shown. */
  const applySaved = (saved: Element) => {
    const meta = {
      updatedAt: saved.updatedAt,
      links: saved.links,
      version: saved.version,
    };
    set((s) => ({
      selected:
        s.selected && s.selected.id === saved.id
          ? { ...s.selected, ...meta }
          : s.selected,
      loaded: s.loaded[saved.id]
        ? {
            ...s.loaded,
            [saved.id]: { ...s.loaded[saved.id]!, ...meta },
          }
        : s.loaded,
      elements: s.elements.map((e) =>
        e.id === saved.id
          ? {
              ...e,
              ...extraOf(saved),
              name: saved.name,
              tags: saved.tags,
              updatedAt: saved.updatedAt,
              links: saved.links,
            }
          : e,
      ),
    }));
  };

  /** Restore the remembered main selection and side columns for a campaign. */
  const restoreLayout = async (campaign: CampaignMeta) => {
    const ids = new Set(get().elements.map((e) => e.id));
    const layout = readLayout(campaign);
    const paneIds = layout.paneIds
      .filter((id) => ids.has(id))
      .slice(0, MAX_PANES);
    set({ paneIds });
    await Promise.all(paneIds.map((id) => loadPane(id)));
    if (layout.selectedId && ids.has(layout.selectedId)) {
      await get().select(layout.selectedId);
    }
  };

  const loadPane = async (id: string) => {
    try {
      const element = await storage.readElement(id);
      if (get().paneIds.includes(id)) {
        set((s) => ({ loaded: { ...s.loaded, [id]: element } }));
      }
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  };

  return {
    campaign: null,
    elements: [],
    trash: [],
    selectedId: null,
    selected: null,
    paneIds: [],
    loaded: {},
    revisions: {},
    conflicts: {},
    busy: false,
    error: null,

    async restore() {
      try {
        const campaign = await storage.getCampaign();
        if (!campaign) return;
        set({ campaign });
        await get().refreshElements();
        await get().refreshTrash();
        await restoreLayout(campaign);
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async reloadCampaignMeta() {
      try {
        const campaign = await storage.getCampaign();
        if (campaign) set({ campaign });
      } catch {
        /* keep what we have */
      }
    },

    async openCampaign(path, replacing) {
      set({ busy: true, error: null });
      try {
        const campaign = await storage.openCampaign(path);
        if (replacing && replacing !== campaign.path) {
          await forgetCampaign(replacing);
        }
        await rememberCampaign({ path: campaign.path, name: campaign.name });
        set({
          campaign,
          selectedId: null,
          selected: null,
          paneIds: [],
          loaded: {},
          conflicts: {},
        });
        await get().refreshElements();
        await get().refreshTrash();
        await restoreLayout(campaign);
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        set({ busy: false });
      }
    },

    async createCampaign(path, name, system, rules) {
      set({ busy: true, error: null });
      try {
        const campaign = await storage.createCampaign(path, name, system);
        await rememberCampaign({ path: campaign.path, name: campaign.name });
        set({
          campaign,
          elements: [],
          trash: [],
          selectedId: null,
          selected: null,
          paneIds: [],
          loaded: {},
          conflicts: {},
        });
        if (rules) await get().updateCampaignSettings({ rules });
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        set({ busy: false });
      }
    },

    closeCampaign() {
      // The Rust side keeps its state until another campaign is opened; that
      // is fine because every command checks the open campaign explicitly.
      set({
        campaign: null,
        elements: [],
        trash: [],
        selectedId: null,
        selected: null,
        paneIds: [],
        loaded: {},
        conflicts: {},
      });
    },

    async refreshElements() {
      try {
        const elements = await storage.listElements();
        set({ elements });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async select(id) {
      if (!id) {
        set({ selectedId: null, selected: null });
        persistLayout();
        return;
      }
      // An element promoted from a side column leaves that column.
      set((s) => ({
        selectedId: id,
        paneIds: s.paneIds.filter((p) => p !== id),
      }));
      persistLayout();
      try {
        const selected = await storage.readElement(id);
        // Ignore a stale response if the user has already moved on.
        if (get().selectedId === id) set({ selected });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async navigate(id, opts) {
      if (opts?.pane) await get().openInPane(id);
      else await get().select(id);
    },

    async openInPane(id) {
      const { selectedId, paneIds } = get();
      // Already the main column, or already open beside: nothing to do.
      if (selectedId === id || paneIds.includes(id)) return;
      if (!selectedId) {
        await get().select(id);
        return;
      }
      const next = [...paneIds, id].slice(-MAX_PANES);
      set({ paneIds: next });
      persistLayout();
      await loadPane(id);
    },

    closePane(id) {
      set((s) => {
        const loaded = { ...s.loaded };
        delete loaded[id];
        return { paneIds: s.paneIds.filter((p) => p !== id), loaded };
      });
      persistLayout();
    },

    async promotePane(id) {
      const { selectedId, paneIds, loaded, selected } = get();
      if (!paneIds.includes(id)) return;
      const promoted = loaded[id];
      // Swap: the old main element takes the column the promoted one had.
      const nextPanes = paneIds
        .map((p) => (p === id ? selectedId : p))
        .filter((p): p is string => Boolean(p));
      const nextLoaded = { ...loaded };
      delete nextLoaded[id];
      if (selectedId && selected) nextLoaded[selectedId] = selected;
      set({
        selectedId: id,
        selected: promoted ?? null,
        paneIds: nextPanes,
        loaded: nextLoaded,
      });
      persistLayout();
      if (!promoted) {
        try {
          const element = await storage.readElement(id);
          if (get().selectedId === id) set({ selected: element });
        } catch (err) {
          set({ error: errorMessage(err) });
        }
      }
    },

    async createElement(kind, name, extra) {
      set({ error: null });
      try {
        // New elements start from the ruleset's template for their kind:
        // a body skeleton and, for a 5e character, an empty sheet.
        const template = templateFor(rulesOf(get().campaign), kind);
        let element = await storage.createElement(kind, name, {
          ...template.extra,
          ...(extra ?? {}),
        });
        if (template.body) {
          element = await storage.saveElement({
            id: element.id,
            name: element.name,
            tags: element.tags,
            body: template.body,
            extra: extraOf(element),
            baseVersion: element.version,
          });
        }
        await get().refreshElements();
        set({ selectedId: element.id, selected: element });
        persistLayout();
        return element;
      } catch (err) {
        set({ error: errorMessage(err) });
        return null;
      }
    },

    async saveElement(id, patch) {
      const s = get();
      const current =
        s.selected && s.selected.id === id ? s.selected : s.loaded[id];
      if (!current) return;
      const next: Element = { ...current, ...patch };
      // Optimistic update so typing never waits on disk. While a conflict is
      // open the edit stays in memory only, so "keep mine" still has it.
      set((st) => ({
        selected: st.selected && st.selected.id === id ? next : st.selected,
        loaded: st.loaded[id] ? { ...st.loaded, [id]: next } : st.loaded,
      }));
      if (get().conflicts[id]) return;
      await writeShown(id);
    },

    async saveSelected(patch) {
      const id = get().selectedId;
      if (id) await get().saveElement(id, patch);
    },

    async deleteElement(id) {
      set({ error: null });
      try {
        await storage.deleteElement(id);
        await get().refreshElements();
        await get().refreshTrash();
        set((s) => {
          const loaded = { ...s.loaded };
          delete loaded[id];
          return {
            selectedId: s.selectedId === id ? null : s.selectedId,
            selected: s.selectedId === id ? null : s.selected,
            paneIds: s.paneIds.filter((p) => p !== id),
            loaded,
          };
        });
        persistLayout();
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async refreshTrash() {
      try {
        const trash = await storage.listTrash();
        set({ trash });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async restoreElement(id) {
      set({ error: null });
      try {
        const element = await storage.restoreElement(id);
        await get().refreshElements();
        await get().refreshTrash();
        set({ selectedId: element.id, selected: element });
        persistLayout();
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async purgeElement(id) {
      set({ error: null });
      try {
        await storage.purgeElement(id);
        await get().refreshTrash();
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async changeElementKind(id, kind) {
      set({ error: null });
      // Queued behind any save in flight for this element, so the move
      // starts from the version that save wrote and the next save starts
      // from the version the move wrote.
      const run = async () => {
        try {
          const changed = await storage.changeElementKind(id, kind);
          const patch = {
            type: changed.type,
            path: changed.path,
            updatedAt: changed.updatedAt,
            version: changed.version,
          };
          set((s) => ({
            selected:
              s.selected && s.selected.id === id
                ? { ...s.selected, ...patch }
                : s.selected,
            loaded: s.loaded[id]
              ? { ...s.loaded, [id]: { ...s.loaded[id]!, ...patch } }
              : s.loaded,
          }));
          await get().refreshElements();
        } catch (err) {
          set({ error: errorMessage(err) });
        }
      };
      const next = (saveChains.get(id) ?? Promise.resolve()).then(run);
      saveChains.set(id, next);
      await next;
    },

    async reloadElement(id) {
      try {
        const element = await storage.readElement(id);
        set((s) => {
          const shownInMain = s.selectedId === id;
          const shownInPane = s.paneIds.includes(id);
          if (!shownInMain && !shownInPane) return {};
          return {
            selected: shownInMain ? element : s.selected,
            loaded: shownInPane ? { ...s.loaded, [id]: element } : s.loaded,
            revisions: { ...s.revisions, [id]: (s.revisions[id] ?? 0) + 1 },
          };
        });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    setEditing(id, on) {
      if (on) editing.add(id);
      else editing.delete(id);
    },

    async applyDiskChanges(changes) {
      if (!get().campaign) return;
      if (changes.campaignChanged) await get().reloadCampaignMeta();
      if (changes.listChanged || changes.elementIds.length > 0) {
        // Names, tags and links in the list may have changed too.
        await get().refreshElements();
      }
      // A deletion or a restore elsewhere moves a file in or out of .trash/.
      if (changes.listChanged) await get().refreshTrash();
      const { selectedId, paneIds } = get();
      for (const id of changes.elementIds) {
        if (id !== selectedId && !paneIds.includes(id)) continue;
        // Our own save, echoed back by the host we work from: already shown.
        const version = changes.versions?.[id];
        if (version !== undefined && shown(id)?.version === version) continue;
        // Untouched here: show the new version. Being edited here: the next
        // save meets the version check and raises the conflict instead.
        if (!busyWith(id) && !get().conflicts[id])
          await get().reloadElement(id);
      }
    },

    async resolveConflict(id, keep) {
      set((s) => {
        const conflicts = { ...s.conflicts };
        delete conflicts[id];
        return { conflicts };
      });
      if (keep === "theirs") {
        await get().reloadElement(id);
      } else {
        await writeShown(id, true);
        await get().refreshElements();
      }
    },

    async updateCampaignSettings(patch) {
      const current = get().campaign;
      if (!current) return;
      const extra: Record<string, unknown> = {
        ...campaignSettingsOf(current),
      };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete extra[k];
        else extra[k] = v;
      }
      // Optimistic, so the UI follows immediately.
      set({ campaign: { ...current, ...patch } });
      try {
        const campaign = await storage.updateCampaign({ extra });
        set({ campaign });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    clearError() {
      set({ error: null });
    },

    setError(message) {
      set({ error: message });
    },
  };
});
