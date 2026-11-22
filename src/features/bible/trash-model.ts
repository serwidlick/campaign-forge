/** How long a deleted element stays restorable; matches `trash::KEEP_DAYS`. */
export const TRASH_KEEP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(deletedAt: string, now: number): number | null {
  const t = Date.parse(deletedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** "today", "yesterday", "5 days ago" for the line under a deleted element. */
export function deletedWhen(deletedAt: string, now = Date.now()): string {
  const days = daysSince(deletedAt, now);
  if (days === null) return "some time ago";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Days before the file is removed for good; never below zero. */
export function daysLeft(deletedAt: string, now = Date.now()): number {
  const days = daysSince(deletedAt, now);
  if (days === null) return TRASH_KEEP_DAYS;
  return Math.max(0, TRASH_KEEP_DAYS - days);
}
