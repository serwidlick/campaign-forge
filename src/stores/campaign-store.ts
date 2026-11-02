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

interface CampaignState {
  campaign: CampaignMeta | null;
  elements: ElementSummary[];
  selectedId: string | null;
  /** Bumped when something other than the editor rewrites the selected element. */
  selectedRevision: number;
  selected: Element | null;
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
  select: (id: string | null) => Promise<void>;
  createElement: (
    kind: string,
    name: string,
    extra?: Record<string, unknown>,
  ) => Promise<Element | null>;
  saveSelected: (patch: ElementPatch) => Promise<void>;
  deleteElement: (id: string) => Promise<void>;

  clearError: () => void;
  setError: (message: string) => void;
  /** Re-read the selected element from disk after an external change. */
  reloadSelected: () => Promise<void>;
}

export const useCampaignStore = create<CampaignState>((set, get) => ({
  campaign: null,
  elements: [],
  selectedId: null,
  selectedRevision: 0,
  selected: null,
  busy: false,
  error: null,

  async restore() {
    try {
      const campaign = await storage.getCampaign();
      if (!campaign) return;
      set({ campaign });
      await get().refreshElements();
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async openCampaign(path) {
    set({ busy: true, error: null });
    try {
      const campaign = await storage.openCampaign(path);
      await rememberCampaign({ path: campaign.path, name: campaign.name });
      set({ campaign, selectedId: null, selected: null });
      await get().refreshElements();
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
      set({ campaign, elements: [], selectedId: null, selected: null });
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      set({ busy: false });
    }
  },

  closeCampaign() {
    // The Rust side keeps its state until another campaign is opened; that is
    // fine because every command checks the open campaign explicitly.
    set({ campaign: null, elements: [], selectedId: null, selected: null });
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
      return;
    }
    set({ selectedId: id });
    try {
      const selected = await storage.readElement(id);
      // Ignore a stale response if the user has already moved on.
      if (get().selectedId === id) set({ selected });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async createElement(kind, name, extra) {
    set({ error: null });
    try {
      const element = await storage.createElement(kind, name, extra);
      await get().refreshElements();
      set({ selectedId: element.id, selected: element });
      return element;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  async saveSelected(patch) {
    const current = get().selected;
    if (!current) return;
    const next: Element = { ...current, ...patch };
    // Optimistic update so typing never waits on disk.
    set({ selected: next });
    try {
      const saved = await storage.saveElement({
        id: next.id,
        name: next.name,
        tags: next.tags,
        body: next.body,
        extra: extraOf(next),
      });
      // Only the metadata can differ (updatedAt); keep the user's latest body.
      if (get().selectedId === saved.id) {
        set((s) => ({
          selected: s.selected
            ? { ...s.selected, updatedAt: saved.updatedAt, links: saved.links }
            : s.selected,
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
      }
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async deleteElement(id) {
    set({ error: null });
    try {
      await storage.deleteElement(id);
      const wasSelected = get().selectedId === id;
      await get().refreshElements();
      if (wasSelected) set({ selectedId: null, selected: null });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async reloadSelected() {
    const id = get().selectedId;
    if (!id) return;
    try {
      const selected = await storage.readElement(id);
      if (get().selectedId === id) {
        set((s) => ({ selected, selectedRevision: s.selectedRevision + 1 }));
      }
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
}));
