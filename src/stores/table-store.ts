import { create } from "zustand";

import { errorMessage, table } from "@/lib/tauri";
import type {
  ElementSummary,
  FoundTable,
  HostStatus,
  TableSession,
} from "@/lib/types";

type Connection = "connected" | "reconnecting";

interface TableState {
  // ---- GM side ----
  hosting: HostStatus | null;
  hostBusy: boolean;

  // ---- Player side ----
  found: FoundTable[];
  session: TableSession | null;
  /** Shared elements as last received from the GM. */
  elements: ElementSummary[];
  /** The GM's change counter we are caught up to. */
  version: number;
  connection: Connection;
  joining: boolean;

  error: string | null;

  /** Re-attach to a hosted or joined table after a reload. */
  restore: () => Promise<void>;
  startHosting: () => Promise<void>;
  stopHosting: () => Promise<void>;
  refreshHost: () => Promise<void>;

  discover: () => Promise<void>;
  stopDiscovery: () => Promise<void>;
  join: (address: string, name: string, code: string) => Promise<boolean>;
  leave: () => Promise<void>;

  clearError: () => void;
}

const RETRY_MS = 3000;

/** Bumped to cancel the running sync loop. */
let loopGeneration = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useTableStore = create<TableState>((set, get) => {
  /**
   * Keeps `elements` current: fetch, then wait for the GM's version to move,
   * then fetch again. On any failure, back off and retry until we leave.
   */
  async function runSyncLoop(generation: number, startVersion: number) {
    let version = startVersion;
    let needFetch = true;
    while (generation === loopGeneration) {
      try {
        if (needFetch) {
          const elements = await table.fetchElements();
          if (generation !== loopGeneration) return;
          set({ elements, version, connection: "connected" });
          needFetch = false;
        }
        const next = await table.waitForChange(version);
        if (generation !== loopGeneration) return;
        if (next > version) {
          version = next;
          needFetch = true;
        }
      } catch {
        if (generation !== loopGeneration) return;
        set({ connection: "reconnecting" });
        needFetch = true;
        await sleep(RETRY_MS);
      }
    }
  }

  function attach(session: TableSession) {
    loopGeneration += 1;
    set({
      session,
      elements: [],
      version: session.info.version,
      connection: "connected",
      error: null,
    });
    // Start one version behind so the first wait returns at once if the GM
    // changed something between join and now.
    void runSyncLoop(loopGeneration, Math.max(0, session.info.version - 1));
  }

  return {
    hosting: null,
    hostBusy: false,
    found: [],
    session: null,
    elements: [],
    version: 0,
    connection: "connected",
    joining: false,
    error: null,

    async restore() {
      try {
        const [hosting, session] = await Promise.all([
          table.hostStatus(),
          table.session(),
        ]);
        set({ hosting });
        if (session && !get().session) attach(session);
      } catch {
        /* not running inside Tauri */
      }
    },

    async startHosting() {
      set({ hostBusy: true, error: null });
      try {
        const hosting = await table.startHosting();
        set({ hosting });
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        set({ hostBusy: false });
      }
    },

    async stopHosting() {
      if (!get().hosting) return;
      set({ hostBusy: true });
      try {
        await table.stopHosting();
        set({ hosting: null });
      } catch (err) {
        set({ error: errorMessage(err) });
      } finally {
        set({ hostBusy: false });
      }
    },

    async refreshHost() {
      try {
        set({ hosting: await table.hostStatus() });
      } catch {
        /* keep the last status */
      }
    },

    async discover() {
      try {
        set({ found: await table.discover() });
      } catch (err) {
        set({ error: errorMessage(err) });
      }
    },

    async stopDiscovery() {
      try {
        await table.discoverStop();
      } catch {
        /* nothing to stop */
      }
    },

    async join(address, name, code) {
      set({ joining: true, error: null });
      try {
        const session = await table.join(address, name, code);
        attach(session);
        void get().stopDiscovery();
        return true;
      } catch (err) {
        set({ error: errorMessage(err) });
        return false;
      } finally {
        set({ joining: false });
      }
    },

    async leave() {
      loopGeneration += 1;
      set({ session: null, elements: [], version: 0 });
      try {
        await table.leave();
      } catch {
        /* already gone */
      }
    },

    clearError() {
      set({ error: null });
    },
  };
});
