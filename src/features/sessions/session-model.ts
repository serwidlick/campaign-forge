/**
 * Sessions and arcs are ordinary elements (kinds `session` and `arc`). Their
 * structured fields live in frontmatter next to `name` and `tags`; this module
 * is the one place that knows those keys and how to read them defensively.
 */
import type { ElementSummary } from "@/lib/types";

export type BeatRole = "beat" | "encounter" | "cliffhanger";

export interface Beat {
  id: string;
  title: string;
  notes: string;
  role: BeatRole;
  done: boolean;
}

export type SessionStatus = "planned" | "played";

export interface SessionData {
  /** Id of the arc this session belongs to. */
  arc: string | null;
  /** Session number within the campaign (not the arc). */
  number: number | null;
  /** Play date as YYYY-MM-DD. */
  date: string | null;
  status: SessionStatus;
  beats: Beat[];
}

export interface ArcData {
  status: "active" | "complete";
}

const BEAT_ROLES: readonly BeatRole[] = ["beat", "encounter", "cliffhanger"];

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function asBeat(v: unknown): Beat | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const role = BEAT_ROLES.includes(o.role as BeatRole)
    ? (o.role as BeatRole)
    : "beat";
  return {
    id: asString(o.id) ?? newBeatId(),
    title: typeof o.title === "string" ? o.title : "",
    notes: typeof o.notes === "string" ? o.notes : "",
    role,
    done: o.done === true,
  };
}

export function readSession(e: Record<string, unknown>): SessionData {
  return {
    arc: asString(e.arc),
    number: asNumber(e.number),
    date: asString(e.date),
    status: e.status === "played" ? "played" : "planned",
    beats: Array.isArray(e.beats)
      ? e.beats.map(asBeat).filter((b): b is Beat => b !== null)
      : [],
  };
}

export function readArc(e: Record<string, unknown>): ArcData {
  return { status: e.status === "complete" ? "complete" : "active" };
}

export function newBeatId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function newBeat(role: BeatRole = "beat"): Beat {
  return { id: newBeatId(), title: "", notes: "", role, done: false };
}

/** Sets `role` on one beat and clears it from any other beat that had it. */
export function setBeatRole(beats: Beat[], id: string, role: BeatRole): Beat[] {
  return beats.map((b) => {
    if (b.id === id) return { ...b, role };
    if (role !== "beat" && b.role === role) return { ...b, role: "beat" };
    return b;
  });
}

export function moveBeat(beats: Beat[], id: string, delta: -1 | 1): Beat[] {
  const from = beats.findIndex((b) => b.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= beats.length) return beats;
  const next = beats.slice();
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  return next;
}

/** Sessions belonging to an arc, in play order. */
export function sessionsOfArc(
  elements: ElementSummary[],
  arcId: string,
): ElementSummary[] {
  return elements
    .filter((e) => e.type === "session" && asString(e.arc) === arcId)
    .sort(bySessionNumber);
}

export function nextSessionNumber(elements: ElementSummary[]): number {
  const max = elements
    .filter((e) => e.type === "session")
    .reduce((m, e) => Math.max(m, asNumber(e.number) ?? 0), 0);
  return max + 1;
}

export function bySessionNumber(a: ElementSummary, b: ElementSummary): number {
  const an = asNumber(a.number);
  const bn = asNumber(b.number);
  if (an === null && bn === null) return a.name.localeCompare(b.name);
  if (an === null) return 1;
  if (bn === null) return -1;
  return an - bn;
}

/** Name as shown in lists: sessions are prefixed with their number. */
export function displayName(e: ElementSummary): string {
  if (e.type === "session") {
    const n = asNumber(e.number);
    if (n !== null) return `#${n} ${e.name}`;
  }
  return e.name;
}

/** List ordering for a kind filter; sessions go in play order. */
export function sortForList(
  items: ElementSummary[],
  kindFilter: string | null,
): ElementSummary[] {
  if (kindFilter === "session") return items.slice().sort(bySessionNumber);
  return items;
}
