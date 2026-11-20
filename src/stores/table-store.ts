import { applyDelta } from "@/lib/table-live.js";
import { create } from "zustand";

import { inTauri, isMobile } from "@/lib/platform";
import {
  errorMessage,
  notifyFilesChanged,
  setRemoteGm,
  table,
} from "@/lib/tauri";
import type {
  ElementSummary,
  FoundTable,
  HostStatus,
  TableSession,
} from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

type Connection = "connected" | "reconnecting";

interface TableState {
  // ---- GM side ----
  /** The table this machine hosts, or, as a GM at someone's table, theirs. */
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
  join: (address: string, name: string, code?: string) => Promise<boolean>;
  /** GM: pair a connected device with a player (existing id, or new by name). */
  bindDevice: (
    token: string,
    playerId: string | null,
    name: string | null,
  ) => Promise<void>;
  leave: () => Promise<void>;

  clearError: () => void;
  clearNotice: () => void;
}

const RETRY_MS = 3000;
/** Error text the Rust client uses when the GM ended the table. */
const CLOSED_ERROR = "TABLE_CLOSED";
const CLOSED_NOTICE = "The GM ended the table.";
const REVOKED_NOTICE =
  "The GM took back this browser's GM standing. Ask them to press Make GM again, then try again.";

/** Bumped to cancel the running sync loop. */
let loopGeneration = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useTableStore = create<TableState>((set, get) => {
  /**
   * A GM's device: route the campaign's commands to the host and load its
   * campaign into the GM screen, as if it had just been opened here.
   */
  async function enterGm() {
    setRemoteGm(true);
    const campaign = useCampaignStore.getState();
    campaign.closeCampaign();
    await campaign.restore();
    await get().refreshHost();
  }

  /** Back to this machine's own files (and no campaign open). */
  function exitGm() {
    setRemoteGm(false);
    useCampaignStore.getState().closeCampaign();
    set({ hosting: null });
  }

  /** Consume the host's initial snapshot, then process live changes in order. */
  async function runSyncLoop(generation: number) {
    let event = 0;
    let subscribe = true;
    while (generation === loopGeneration) {
      try {
        const next = await table.nextEvent(subscribe);
        subscribe = false;
        if (generation !== loopGeneration) return;
        if (next.closed) {
          await detach(CLOSED_NOTICE);
          return;
        }
        set({ connection: "connected" });
        const session = get().session;
        if (
          session &&
          next.playerId !== undefined &&
          next.playerId !== session.playerId
        ) {
          set({ session: { ...session, playerId: next.playerId } });
        }
        if (session && next.gm !== session.gm) {
          // The host granted or revoked GM standing while we are connected.
          if (!next.gm && !inTauri) {
            // The browser's GM page has no player view to fall back to.
            await detach(REVOKED_NOTICE);
            return;
          }
          set({
            session: {
              ...session,
              playerId: next.playerId ?? null,
              gm: next.gm,
            },
          });
          // The phone app has no GM screen to load the campaign into.
          if (next.gm) {
            if (!isMobile) await enterGm();
          } else {
            exitGm();
          }
          if (generation !== loopGeneration) return;
        }
        if (next.delta) {
          set({ elements: applyDelta(get().elements, next.delta) });
        }
        if (!next.spotlight) set({ spotlight: null });
        if (
          next.spotlightSeq > event ||
          (next.spotlight && next.spotlight !== get().spotlight?.id)
        ) {
          event = next.spotlightSeq;
          if (next.gm) {
            void get().refreshHost();
          } else if (next.spotlight) {
            set({ spotlight: { id: next.spotlight, seq: next.spotlightSeq } });
          }
        }
        set({ version: next.version });
        if (next.gm && next.changes) notifyFilesChanged(next.changes);
      } catch (err) {
        if (generation !== loopGeneration) return;
        if (errorMessage(err) === "TABLE_UNAUTHORIZED") {
          await detach("Your table session has ended. Join the table again.");
          return;
        }
        if (errorMessage(err) === CLOSED_ERROR) {
          await detach(CLOSED_NOTICE);
          return;
        }
        subscribe = true;
        set({ connection: "reconnecting" });
        await sleep(RETRY_MS + Math.random() * 1000);
      }
    }
  }

  /** Leaves the table; with a notice, the welcome screen says why. */
  async function detach(notice: string | null) {
    loopGeneration += 1;
    if (get().session?.gm) exitGm();
    set({ session: null, elements: [], version: 0, notice, spotlight: null });
    try {
      await table.leave();
    } catch {
      /* already gone */
    }
  }

  async function attach(session: TableSession) {
    const generation = ++loopGeneration;
    set({
      session,
      elements: [],
      version: session.info.version,
      connection: "connected",
      error: null,
    });
    if (session.gm && !isMobile) await enterGm();
    void runSyncLoop(generation);
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
        if (session && !get().session) await attach(session);
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
      if (!get().hosting || get().session?.gm) return;
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

    async bindDevice(token, playerId, name) {
      try {
        set({ hosting: await table.bindDevice(token, playerId, name) });
      } catch (err) {
        set({ error: errorMessage(err) });
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
        await attach(session);
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
