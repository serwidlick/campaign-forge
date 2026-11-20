/**
 * Durations in words, for "away for 7 min". Pure, so it is unit tested.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "1 min", "45 min", "1 h", "2 h 5 min", "3 days". */
export function formatDuration(ms) {
  const span = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (span < MINUTE) return "just now";
  if (span < HOUR) return Math.floor(span / MINUTE) + " min";
  if (span < DAY) {
    const hours = Math.floor(span / HOUR);
    const minutes = Math.floor((span % HOUR) / MINUTE);
    return hours + " h" + (minutes ? " " + minutes + " min" : "");
  }
  const days = Math.floor(span / DAY);
  return days + (days === 1 ? " day" : " days");
}

/** How long ago `since` (the host's Unix ms) was, on this device's clock:
 *  `offset` is this clock minus the host's, so skew does not show. */
export function elapsedSince(since, now = Date.now(), offset = 0) {
  return now - offset - since;
}
