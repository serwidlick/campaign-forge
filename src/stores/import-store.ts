/**
 * State of the PDF import wizard. Lives outside the panel so a long run
 * survives the GM clicking around the campaign while it works.
 */
import { create } from "zustand";

import {
  EMPTY_USAGE,
  addUsage,
  loadAgentSettings,
  type TurnUsage,
} from "@/features/agent/agent-settings";
import {
  DEFAULT_OPTIONS,
  chunkPages,
  createClient,
  describeError,
  extractFromChunk,
  mergeProposals,
  sortProposals,
  systemPromptFor,
  writeProposals,
  type ImportOptions,
  type Proposal,
  type WriteResult,
} from "@/features/import/pdf-import";
import { errorMessage, secrets, storage } from "@/lib/tauri";
import type { PdfText } from "@/lib/types";

import { useCampaignStore } from "./campaign-store";

export type ImportStage =
  "idle" | "extracting" | "ready" | "building" | "review" | "writing" | "done";

export interface ImportSource {
  /** Absolute path of the file on disk. */
  path: string;
  /** File name without extension. */
  name: string;
  /** A PDF can be kept as a Document element; a text file is read only. */
  kind: "pdf" | "text";
  text: PdfText;
}

export interface BuildProgress {
  chunk: number;
  chunks: number;
  found: number;
  failed: number;
  usage: TurnUsage;
  model: string;
}

export interface WriteProgress {
  done: number;
  total: number;
}

interface ImportState {
  stage: ImportStage;
  error: string | null;
  source: ImportSource | null;
  options: ImportOptions;
  progress: BuildProgress | null;
  writeProgress: WriteProgress | null;
  proposals: Proposal[];
  /** Problems from chunks that failed; the rest of the run went on. */
  failures: string[];
  result: WriteResult | null;

  /** Read the text of a PDF chosen in the file dialog. */
  load: (path: string) => Promise<void>;
  setOptions: (patch: Partial<ImportOptions>) => void;
  /** Run the model over the text and collect proposals. */
  build: () => Promise<void>;
  cancel: () => void;
  toggle: (key: string) => void;
  setAll: (selected: boolean) => void;
  /** Write the ticked proposals as elements. */
  write: () => Promise<void>;
  /** Back from the review list to the options. */
  backToOptions: () => void;
  reset: () => void;
  clearError: () => void;
}

let abort: AbortController | null = null;

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(pdf|txt|text|md|markdown)$/i, "") || "document";
}

function sourceKind(path: string): ImportSource["kind"] {
  return /\.pdf$/i.test(path) ? "pdf" : "text";
}

export const useImportStore = create<ImportState>((set, get) => ({
  stage: "idle",
  error: null,
  source: null,
  options: DEFAULT_OPTIONS,
  progress: null,
  writeProgress: null,
  proposals: [],
  failures: [],
  result: null,

  async load(path) {
    set({ stage: "extracting", error: null, source: null });
    try {
      const text = await storage.extractDocumentText(path);
      set({
        stage: "ready",
        source: { path, name: fileStem(path), kind: sourceKind(path), text },
        options: { ...get().options, from: undefined, to: undefined },
        proposals: [],
        failures: [],
        result: null,
      });
    } catch (err) {
      set({ stage: "idle", error: errorMessage(err) });
    }
  },

  setOptions(patch) {
    set((s) => ({ options: { ...s.options, ...patch } }));
  },

  async build() {
    const { source, options } = get();
    if (!source || get().stage === "building") return;
    const campaign = useCampaignStore.getState().campaign;
    if (!campaign) {
      set({ error: "Open a campaign first." });
      return;
    }
    if (options.kinds.length === 0) {
      set({ error: "Tick at least one kind of element to look for." });
      return;
    }
    const apiKey = await secrets.getApiKey().catch(() => null);
    if (!apiKey) {
      set({
        error:
          "Add your Anthropic API key in the assistant settings first. The import reads the book with the assistant's model.",
      });
      return;
    }
    const settings = await loadAgentSettings();

    // Narrow to the page range if one was given; the extraction is cheap
    // compared with the model calls, so re-reading is fine.
    let text = source.text;
    if (options.from !== undefined || options.to !== undefined) {
      try {
        text = await storage.extractDocumentText(
          source.path,
          options.from,
          options.to,
        );
      } catch (err) {
        set({ error: errorMessage(err) });
        return;
      }
    }
    const chunks = chunkPages(text);
    if (chunks.length === 0) {
      set({
        error:
          "No text to read in those pages. A scanned PDF has pictures of pages, not text; it would need OCR first.",
      });
      return;
    }

    abort = new AbortController();
    const signal = abort.signal;
    const client = createClient(apiKey);
    const system = systemPromptFor(campaign, options);

    set({
      stage: "building",
      error: null,
      proposals: [],
      failures: [],
      result: null,
      progress: {
        chunk: 0,
        chunks: chunks.length,
        found: 0,
        failed: 0,
        usage: EMPTY_USAGE,
        model: settings.model,
      },
    });

    const existing = useCampaignStore.getState().elements;
    for (const chunk of chunks) {
      if (signal.aborted) break;
      try {
        const { proposals, usage } = await extractFromChunk(chunk, {
          client,
          model: settings.model,
          effort: settings.effort,
          system,
          signal,
        });
        set((s) => {
          const merged = mergeProposals(s.proposals, proposals, existing);
          return {
            proposals: merged,
            progress: s.progress && {
              ...s.progress,
              chunk: chunk.index + 1,
              found: merged.length,
              usage: addUsage(s.progress.usage, usage),
            },
          };
        });
      } catch (err) {
        if (signal.aborted) break;
        const reason = describeError(err);
        set((s) => ({
          failures: [
            ...s.failures,
            `Pages ${chunk.firstPage}–${chunk.lastPage}: ${reason}`,
          ],
          progress: s.progress && {
            ...s.progress,
            chunk: chunk.index + 1,
            failed: s.progress.failed + 1,
          },
        }));
      }
    }
    const cancelled = signal.aborted;
    abort = null;
    set((s) => ({
      stage: s.proposals.length > 0 || !cancelled ? "review" : "ready",
      proposals: sortProposals(s.proposals),
    }));
  },

  cancel() {
    abort?.abort();
  },

  toggle(key) {
    set((s) => ({
      proposals: s.proposals.map((p) =>
        p.key === key ? { ...p, selected: !p.selected } : p,
      ),
    }));
  },

  setAll(selected) {
    set((s) => ({
      proposals: s.proposals.map((p) => ({ ...p, selected })),
    }));
  },

  async write() {
    const { source, options, proposals } = get();
    const campaign = useCampaignStore.getState().campaign;
    if (!source || !campaign || get().stage === "writing") return;
    set({ stage: "writing", error: null, writeProgress: null });
    try {
      const result = await writeProposals({
        campaign,
        proposals,
        sourceName: source.name,
        // Only a PDF can live in assets/docs; a text file is cited by name.
        attach:
          options.attachDocument && source.kind === "pdf" ? source.path : null,
        onProgress: (done, total) => set({ writeProgress: { done, total } }),
      });
      const store = useCampaignStore.getState();
      await store.refreshElements();
      // An element that got a section appended may be open in an editor.
      for (const u of result.updated) await store.reloadElement(u.id);
      set({ stage: "done", result });
    } catch (err) {
      // Whatever was written stays; the list shows it after a refresh.
      await useCampaignStore.getState().refreshElements();
      set({ stage: "review", error: errorMessage(err) });
    }
  },

  backToOptions() {
    set({ stage: "ready", proposals: [], failures: [], progress: null });
  },

  reset() {
    get().cancel();
    set({
      stage: "idle",
      error: null,
      source: null,
      progress: null,
      writeProgress: null,
      proposals: [],
      failures: [],
      result: null,
    });
  },

  clearError() {
    set({ error: null });
  },
}));
