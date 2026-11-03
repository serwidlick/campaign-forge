/**
 * Journal entries are elements of kind `journal`. Frontmatter:
 *
 *   date:      2026-11-03                 (real-world, YYYY-MM-DD)
 *   worldDate: { year, month, day }      (optional, in the campaign calendar)
 *   scope:     { type: "campaign" } | { type: "arc", id } | { type: "session", id }
 *
 * The scope is the "three-level tier": an entry belongs to the campaign as a
 * whole, to an arc, or to one session.
 */
import {
  readWorldDate,
  type WorldDate,
} from "@/features/timeline/calendar-model";
import type { ElementSummary } from "@/lib/types";

export type JournalScope =
  | { type: "campaign" }
  | { type: "arc"; id: string }
  | { type: "session"; id: string };

export interface JournalData {
  /** YYYY-MM-DD, or null when unset. */
  date: string | null;
  worldDate: WorldDate | null;
  scope: JournalScope;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function readScope(v: unknown): JournalScope {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (
      (o.type === "arc" || o.type === "session") &&
      typeof o.id === "string" &&
      o.id
    ) {
      return { type: o.type, id: o.id };
    }
  }
  return { type: "campaign" };
}

export function readJournal(e: Record<string, unknown>): JournalData {
  return {
    date: typeof e.date === "string" && ISO_DATE.test(e.date) ? e.date : null,
    worldDate: readWorldDate(e.worldDate),
    scope: readScope(e.scope),
  };
}

export function sameScope(a: JournalScope, b: JournalScope): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "campaign" || b.type === "campaign") return true;
  return a.id === (b as { id: string }).id;
}

export function isJournal(e: ElementSummary): boolean {
  return e.type === "journal";
}

/** Entries newest first; undated ones last, then by name. */
export function byDateDesc(a: ElementSummary, b: ElementSummary): number {
  const ad = readJournal(a).date;
  const bd = readJournal(b).date;
  if (ad && bd && ad !== bd) return ad < bd ? 1 : -1;
  if (ad && !bd) return -1;
  if (!ad && bd) return 1;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

export function entriesFor(
  elements: ElementSummary[],
  scope: JournalScope,
): ElementSummary[] {
  return elements
    .filter((e) => isJournal(e) && sameScope(readJournal(e).scope, scope))
    .sort(byDateDesc);
}

/** Human label for a scope, looked up against the element list. */
export function scopeLabel(
  scope: JournalScope,
  elements: ElementSummary[],
): string {
  if (scope.type === "campaign") return "Campaign";
  const target = elements.find((e) => e.id === scope.id);
  const prefix = scope.type === "arc" ? "Arc" : "Session";
  return target ? `${prefix} · ${target.name}` : `${prefix} (missing)`;
}

/** Default name for a new entry on a given day. */
export function defaultEntryName(date: string): string {
  return `Journal · ${date}`;
}

/** "Mon 3 Nov 2026" for list rows. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "November 2026" group headers. */
export function formatIsoMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return iso;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}
