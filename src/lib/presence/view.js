/**
 * The roster as this device shows it. The host sends one roster to
 * everyone; each device then knows two things the host cannot put in it:
 *
 * - which entry is the person holding this device (`you`), marked so they
 *   can find themselves among the bubbles, and placed right after the host;
 * - who has written to them (`priority`): people whose messages came in
 *   unread move up to just after you, the most recent first, and keep that
 *   place once read, so the row does not jump back;
 * - whether this device can still reach the host (`offline`). While it
 *   cannot, the last roster is out of date: the host (and this device) show
 *   as disconnected, in step with the page's "trying to reconnect", and
 *   everyone else keeps their last known state, marked as such.
 *
 * Pure, so tested; the stored roster is never changed.
 */

/** Entries for the bubbles, in the order shown: copies with `self` and
 *  `stale` set as needed. */
export function viewRoster(
  roster,
  { you = null, offline = false, priority = null } = {},
) {
  return inOrder(roster, you, priority).map((entry) => {
    const self = you != null && entry.key === you;
    if (!offline) return self ? { ...entry, self } : entry;
    if (self || entry.role === "host") {
      // Cut off: no away time or activity can be trusted now.
      const { awaySince: _since, activity: _activity, ...rest } = entry;
      return { ...rest, state: "disconnected", self };
    }
    return { ...entry, stale: true };
  });
}

/** Host first, then you, then people who have written to you (latest
 *  first, by `priority`: key to a number that grows with each new unread
 *  message), then everyone else as the host listed them. */
function inOrder(roster, you, priority) {
  const rank = (entry) =>
    entry.role === "host" ? 0 : you != null && entry.key === you ? 1 : 2;
  const promoted = (entry) => priority?.get?.(entry.key) ?? 0;
  // A stable sort, so people of the same rank keep the host's order.
  return [...roster].sort(
    (a, b) => rank(a) - rank(b) || promoted(b) - promoted(a),
  );
}

/**
 * Updates `priority` (key to number) from unread counts: anyone whose
 * count went up since `before` moves to the front, after the rest
 * promoted so far. Nobody moves back when they are read. Returns whether
 * the order changed.
 */
export function promoteUnread(priority, before, after) {
  let next = Math.max(0, ...priority.values());
  let changed = false;
  // A stable order for several at once: by key.
  for (const key of Object.keys(after).sort()) {
    if ((after[key] ?? 0) > (before[key] ?? 0)) {
      priority.set(key, ++next);
      changed = true;
    }
  }
  return changed;
}

/** The entries to show when only `max` bubbles fit, the last place going
 *  to "+N". You come right after the host, so you are never folded away. */
export function shownEntries(entries, max, expanded) {
  if (entries.length <= max || expanded) return entries;
  return entries.slice(0, max - 1);
}
