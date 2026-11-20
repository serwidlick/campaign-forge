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

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which day `at` falls on, relative to `now` (both this device's clock):
 *  0 today, 1 yesterday, and so on. Calendar days, not 24-hour spans. */
export function daysAgo(at, now = Date.now()) {
  return Math.round((startOfDay(now) - startOfDay(at)) / DAY);
}

/** When a message was sent, as people say it: "4:32 PM" today,
 *  "Yesterday 4:32 PM", the weekday within the week, else the date. */
export function formatClock(at, now = Date.now(), locale) {
  const time = new Date(at).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = daysAgo(at, now);
  if (days <= 0) return time;
  if (days === 1) return "Yesterday " + time;
  if (days < 7) {
    return (
      new Date(at).toLocaleDateString(locale, { weekday: "long" }) + " " + time
    );
  }
  return (
    new Date(at).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
    }) +
    " " +
    time
  );
}
