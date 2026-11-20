import { useEffect, useRef } from "react";

import presenceStylesheet from "@/lib/table-presence.css?url";
import {
  mountTablePresence,
  watchIdle,
  type TablePresence,
} from "@/lib/table-presence.js";
import { table } from "@/lib/tauri";
import {
  useRosterOffset,
  useRosterYou,
  useTableOffline,
  useTableRoster,
} from "@/stores/table-store";

/**
 * Mounts the self-contained `<table-presence>` bubbles (src/lib/presence/)
 * once for the whole window and keeps them in step with the table: the
 * roster, the host's clock, which bubble is the person at this window,
 * whether the table can be reached, and whether that person has gone idle
 * (which the table then shows everyone as away). Rendered at the app
 * root, so the bubbles float over every screen and survive navigation.
 */
export function PresenceBar() {
  const roster = useTableRoster();
  const offset = useRosterOffset();
  const you = useRosterYou();
  const offline = useTableOffline();
  const bubbles = useRef<TablePresence | null>(null);
  const atTable = roster.length > 0;

  useEffect(() => {
    const node = mountTablePresence({ stylesheet: presenceStylesheet });
    bubbles.current = node;
    return () => {
      node.remove();
      bubbles.current = null;
    };
  }, []);

  useEffect(() => {
    if (!bubbles.current) return;
    bubbles.current.clockOffset = offset;
    bubbles.current.you = you;
    bubbles.current.offline = offline;
    bubbles.current.roster = roster;
  }, [roster, offset, you, offline]);

  // While at a table, tell it when this window goes idle and comes back.
  // A failed report is not worth an error: the next change tries again.
  useEffect(() => {
    if (!atTable) return;
    const stop = watchIdle({
      onChange: (away) => void table.reportPresence(away).catch(() => {}),
    });
    return () => {
      stop();
      void table.reportPresence(false).catch(() => {});
    };
  }, [atTable]);

  return null;
}
