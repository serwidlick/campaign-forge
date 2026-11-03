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
  /** Why the player is back on the welcome screen, e.g. the GM ended the table. */
  notice: string | null;
  /** What the GM is showing everyone; `seq` distinguishes repeats. */
  spotlight: { id: string; seq: number } | null;

  error: string | null;

  /** Re-attach to a hosted or joined table after a reload. */
  restore: () => Promise<void>;
  startHosting: () => Promise<void>;
  stopHosting: () => Promise<void>;
  refreshHost: () => Promise<void>;
  /** GM: show an element to every player, or clear with null. */
  showToPlayers: (id: string | null) => Promise<void>;

  discover: () => Promise<void>;
  /** Forget earlier results so a new search starts clean. */
  clearFound: () => void;
  stopDiscovery: () => Promise<void>;
  join: (address: string, name: string, code: string) => Promise<boolean>;
  leave: () => Promise<void>;

  clearError: () => void;
  clearNotice: () => void;
}

const RETRY_MS = 3000;
/** Error text the Rust client uses when the GM ended the table. */
const CLOSED_ERROR = "TABLE_CLOSED";
const CLOSED_NOTICE = "The GM ended the table.";

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
    let event = 0;
    let needFetch = true;
    while (generation === loopGeneration) {
      try {
        if (needFetch) {
          const elements = await table.fetchElements();
          if (generation !== loopGeneration) return;
          set({ elements, version, connection: "connected" });
          needFetch = false;
        }
        const next = await table.waitForChange(version, event);
        if (generation !== loopGeneration) return;
        if (next.closed) {
          await detach(CLOSED_NOTICE);
          return;
        }
        if (next.spotlightSeq > event) {
          event = next.spotlightSeq;
          if (next.spotlight) {
            set({ spotlight: { id: next.spotlight, seq: next.spotlightSeq } });
          }
        }
        if (next.version > version) {
          version = next.version;
          needFetch = true;
        }
      } catch (err) {
        if (generation !== loopGeneration) return;
        if (errorMessage(err) === CLOSED_ERROR) {
          await detach(CLOSED_NOTICE);
          return;
        }
        set({ connection: "reconnecting" });
        needFetch = true;
        await sleep(RETRY_MS);
      }
    }
  }

  /** Leaves the table; with a notice, the welcome screen says why. */
  async function detach(notice: string | null) {
    loopGeneration += 1;
    set({ session: null, elements: [], version: 0, notice, spotlight: null });
    try {
      await table.leave();
    } catch {
      /* already gone */
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
    notice: null,
    spotlight: null,
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

    async showToPlayers(id) {
      try {
        set({ hosting: await table.spotlight(id) });
      } catch (err) {
        set({ error: errorMessage(err) });
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

    clearFound() {
      set({ found: [] });
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
        set({ notice: null });
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
      await detach(null);
    },

    clearError() {
      set({ error: null });
    },

    clearNotice() {
      set({ notice: null });
    },
  };
});
