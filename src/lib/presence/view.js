/**
 * The roster as this device shows it. The host sends one roster to
 * everyone; each device then knows two things the host cannot put in it:
 *
 * - which entry is the person holding this device (`you`), marked so they
 *   can find themselves among the bubbles, and placed right after the host
 *   (host, you, then everyone else in the host's order);
 * - whether this device can still reach the host (`offline`). While it
 *   cannot, the last roster is out of date: the host (and this device) show
 *   as disconnected, in step with the page's "trying to reconnect", and
 *   everyone else keeps their last known state, marked as such.
 *
 * Pure, so tested; the stored roster is never changed.
 */

/** Entries for the bubbles, in the order shown: copies with `self` and
 *  `stale` set as needed. */
export function viewRoster(roster, { you = null, offline = false } = {}) {
  return inOrder(roster, you).map((entry) => {
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

/** Host first, then you, then everyone else as the host listed them. */
function inOrder(roster, you) {
  const rank = (entry) =>
    entry.role === "host" ? 0 : you != null && entry.key === you ? 1 : 2;
  // A stable sort, so people of the same rank keep the host's order.
  return [...roster].sort((a, b) => rank(a) - rank(b));
}

/** The entries to show when only `max` bubbles fit, the last place going
 *  to "+N". You come right after the host, so you are never folded away. */
export function shownEntries(entries, max, expanded) {
  if (entries.length <= max || expanded) return entries;
  return entries.slice(0, max - 1);
}
