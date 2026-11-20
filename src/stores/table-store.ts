import { applyDelta } from "@/lib/table-live.js";
import { create } from "zustand";

import { inTauri, isMobile } from "@/lib/platform";
import { TableChat } from "@/lib/table-presence.js";
import {
  errorMessage,
  notifyFilesChanged,
  setRemoteGm,
  table,
} from "@/lib/tauri";
import type {
  ChatAck,
  ElementSummary,
  FoundTable,
  HostStatus,
  RosterEntry,
  TableChange,
  TableCommand,
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
  /** Who is at the joined table, as its host last said. */
  roster: RosterEntry[];
  /** How far this clock is ahead of the joined host's, for "away for". */
  rosterOffset: number;
  /** Which roster entry is this device's person, as the joined host said. */
  rosterYou: string | null;
  /** Table messages for this window: the joined table's, or the hosting
   *  GM's own. Lives with the connection, so nothing is missed before the
   *  bubbles mount; PresenceBar attaches it to them. */
  chat: TableChat | null;

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
  join: (
    address: string,
    name: string,
    code?: string,
    endpoints?: string[],
  ) => Promise<boolean>;
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
        // A frame came through: the socket is up, and its frames (the first
        // one carries the whole set of conversations) go to the chat.
        get().chat?.connected(true);
        get().chat?.receive(next);
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
        // Frames on one socket arrive in order and each new socket starts
        // with the roster, so the latest one always replaces ours.
        if (next.roster) {
          set({
            roster: next.roster,
            rosterOffset:
              next.serverTime === undefined ? 0 : Date.now() - next.serverTime,
            rosterYou: next.you ?? null,
          });
        }
        if (!next.spotlight) set({ spotlight: null });
        if (
          next.spotlightSeq > event ||
          (!next.gm && next.spotlight && next.spotlight !== get().spotlight?.id)
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
        get().chat?.connected(false);
        await sleep(RETRY_MS + Math.random() * 1000);
      }
    }
  }

  /** Leaves the table; with a notice, the welcome screen says why. */
  async function detach(notice: string | null) {
    loopGeneration += 1;
    get().chat?.dispose();
    set({ chat: null });
    if (get().session?.gm) exitGm();
    set({
      session: null,
      elements: [],
      version: 0,
      notice,
      spotlight: null,
      roster: [],
      rosterYou: null,
    });
    try {
      await table.leave();
    } catch {
      /* already gone */
    }
  }

  async function attach(session: TableSession) {
    const generation = ++loopGeneration;
    get().chat?.dispose();
    // Message commands go out on the joined table's live socket.
    set({
      chat: new TableChat({
        send: (command: TableCommand) => table.liveSend(command),
      }),
    });
    set({
      session,
      elements: [],
      roster: [],
      rosterYou: null,
      version: session.info.version,
      connection: "connected",
      error: null,
    });
    if (session.gm && !isMobile) await enterGm();
    void runSyncLoop(generation);
  }

  // The hosting GM hears roster changes from Rust, between status polls.
  void table.onRoster((roster) => {
    const hosting = get().hosting;
    if (hosting) set({ hosting: { ...hosting, roster } });
  });

  return {
    chat: null,
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
    roster: [],
    rosterOffset: 0,
    rosterYou: null,
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

    async join(address, name, code, endpoints) {
      set({ joining: true, error: null });
      try {
        const session = await table.join(address, name, code, endpoints);
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

/** Who is at the table this window is part of: the joined table's roster,
 *  or, on the hosting machine, the one it publishes. */
export function useTableRoster(): RosterEntry[] {
  return useTableStore((s) =>
    s.session ? s.roster : (s.hosting?.roster ?? NO_ONE),
  );
}

const NO_ONE: RosterEntry[] = [];

/** How far this clock is ahead of the clock the roster's times use: the
 *  joined host's, or none on the hosting machine itself. */
export function useRosterOffset(): number {
  return useTableStore((s) => (s.session ? s.rosterOffset : 0));
}

/** Which roster entry is the person at this window: what the joined host
 *  said, or the host's own entry on the hosting machine. */
export function useRosterYou(): string | null {
  return useTableStore((s) =>
    s.session ? s.rosterYou : s.hosting ? "host" : null,
  );
}

/** True while a joined table cannot be reached ("trying to reconnect"):
 *  the bubbles then show its host as disconnected. */
export function useTableOffline(): boolean {
  return useTableStore(
    (s) => s.session !== null && s.connection === "reconnecting",
  );
}

/** The table messages for this window, once there are any. */
export function useTableChat(): TableChat | null {
  return useTableStore((s) => s.chat);
}

/** Hands a message command to the hosting machine's own message hub. */
function hostSend(command: TableCommand): Promise<ChatAck | void> {
  switch (command.t) {
    case "send":
      return table.sendMessage(
        command.to,
        command.text,
        command.clientId,
        command.cid,
      );
    case "typing":
      return table.setTyping(command.to, command.on);
    case "seen":
      return table.markSeen(command.cid, command.seq);
  }
}

// The hosting GM's own messages: while this window hosts (and is not also
// joined to a table), its chat talks to the host's hub through commands and
// hears what changes through `table://chats`.
let hostChat: { chat: TableChat; stop: () => void } | null = null;
useTableStore.subscribe((s) => {
  const hosting = inTauri && s.hosting !== null && s.session === null;
  if (hosting && !hostChat) {
    const chat = new TableChat({ send: hostSend });
    chat.you = "host";
    let unlisten: (() => void) | null = null;
    let stopped = false;
    // Listen first, then take the snapshot: events from before it are held
    // and only those newer than the snapshot's revision are applied, so
    // nothing falls between the two and nothing old overwrites it.
    let base: number | null = null;
    const held: TableChange[] = [];
    const onChange = (frame: TableChange) => {
      if (base === null) held.push(frame);
      else if ((frame.revision ?? Infinity) > base) chat.receive(frame);
    };
    void table
      .onChats(onChange)
      .then((off) => {
        if (stopped) {
          off();
          return;
        }
        unlisten = off;
        return table.chats().then((snapshot) => {
          if (stopped) return;
          base = snapshot.revision ?? 0;
          chat.receive(snapshot);
          for (const frame of held.splice(0)) onChange(frame);
        });
      })
      .catch(() => {});
    hostChat = {
      chat,
      stop: () => {
        stopped = true;
        unlisten?.();
        chat.dispose();
      },
    };
    useTableStore.setState({ chat });
  } else if (!hosting && hostChat) {
    const { chat, stop } = hostChat;
    hostChat = null;
    stop();
    if (useTableStore.getState().chat === chat) {
      useTableStore.setState({ chat: null });
    }
  }
});
