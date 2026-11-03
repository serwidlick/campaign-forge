import { create } from "zustand";

import { rememberCampaign } from "@/lib/recent";
import { errorMessage, storage } from "@/lib/tauri";
import {
  extraOf,
  type CampaignMeta,
  type Element,
  type ElementSummary,
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
  busy: boolean;
  error: string | null;

  /** Re-attach to a campaign the Rust side already has open (dev reloads). */
  restore: () => Promise<void>;
  openCampaign: (path: string) => Promise<void>;
  createCampaign: (
    path: string,
    name: string,
    system?: string,
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
  deleteElement: (id: string) => Promise<void>;
  /** Re-read an element from disk after an external change. */
  reloadElement: (id: string) => Promise<void>;

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

export const useCampaignStore = create<CampaignState>((set, get) => {
  const persistLayout = () => {
    const { campaign, selectedId, paneIds } = get();
    writeLayout(campaign, { selectedId, paneIds });
  };

  /** Apply a saved element's metadata to every place it is shown. */
  const applySaved = (saved: Element) => {
    set((s) => ({
      selected:
        s.selected && s.selected.id === saved.id
          ? { ...s.selected, updatedAt: saved.updatedAt, links: saved.links }
          : s.selected,
      loaded: s.loaded[saved.id]
        ? {
            ...s.loaded,
            [saved.id]: {
              ...s.loaded[saved.id]!,
              updatedAt: saved.updatedAt,
              links: saved.links,
            },
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
    selectedId: null,
    selected: null,
    paneIds: [],
    loaded: {},
    revisions: {},
    busy: false,
    error: null,

    async restore() {
      try {
        const campaign = await storage.getCampaign();
        if (!campaign) return;
        set({ campaign });
        await get().refreshElements();
        await restoreLayout(campaign);
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async openCampaign(path) {
      set({ busy: true, error: null });
      try {
        const campaign = await storage.openCampaign(path);
        await rememberCampaign({ path: campaign.path, name: campaign.name });
        set({
          campaign,
          selectedId: null,
          selected: null,
          paneIds: [],
          loaded: {},
        });
        await get().refreshElements();
        await restoreLayout(campaign);
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        set({ busy: false });
      }
    },

    async createCampaign(path, name, system) {
      set({ busy: true, error: null });
      try {
        const campaign = await storage.createCampaign(path, name, system);
        await rememberCampaign({ path: campaign.path, name: campaign.name });
        set({
          campaign,
          elements: [],
          selectedId: null,
          selected: null,
          paneIds: [],
          loaded: {},
        });
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
        selectedId: null,
        selected: null,
        paneIds: [],
        loaded: {},
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
        const element = await storage.createElement(kind, name, extra);
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
      // Optimistic update so typing never waits on disk.
      set((st) => ({
        selected: st.selected && st.selected.id === id ? next : st.selected,
        loaded: st.loaded[id] ? { ...st.loaded, [id]: next } : st.loaded,
      }));
      try {
        const saved = await storage.saveElement({
          id: next.id,
          name: next.name,
          tags: next.tags,
          body: next.body,
          extra: extraOf(next),
        });
        // Only the metadata can differ (updatedAt, links); keep the body the
        // user is typing.
        applySaved(saved);
      } catch (err) {
        set({ error: errorMessage(err) });
      }
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

    clearError() {
      set({ error: null });
    },

    setError(message) {
      set({ error: message });
    },
  };
});
