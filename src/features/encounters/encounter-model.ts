/**
 * Encounters are ordinary elements (kind `encounter`). The fight itself, its
 * combatants, their order and whose turn it is, lives in frontmatter next to
 * `name` and `tags`; this module is the one place that knows those keys, how
 * to read them defensively, and how a turn advances.
 *
 * A combatant usually stands for a people element (a character, a creature)
 * and keeps a snapshot of its numbers from when it was added. Hit points are
 * tracked here, in the encounter, so the sheet is never rewritten by a fight.
 */
import { modifier, readSheet5e } from "@/features/templates/dnd5e-model";
import { readStatBlock5e } from "@/features/templates/dnd5e-statblock";
import { ELEMENT_KINDS, type ElementSummary } from "@/lib/types";

export type EncounterStatus = "planned" | "running" | "done";

export interface Combatant {
  id: string;
  /** Id of the element this combatant stands for; null for a one-off. */
  element: string | null;
  name: string;
  initiative: number | null;
  /** Dexterity modifier from the sheet or stat block when it was added. */
  initiativeBonus: number | null;
  hp: number | null;
  hpMax: number | null;
  ac: number | null;
  conditions: string[];
  notes: string;
  /** Out of the fight (dead, fled, unconscious): skipped in the order. */
  down: boolean;
}

export interface EncounterData {
  status: EncounterStatus;
  /** 1-based once running; 0 before the first round. */
  round: number;
  /** Index into `combatants` of whose turn it is. */
  turn: number;
  combatants: Combatant[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Math.round(Number(v));
  }
  return null;
}

function asCombatant(v: unknown): Combatant | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    id: asString(o.id) ?? newCombatantId(),
    element: asString(o.element),
    name: typeof o.name === "string" ? o.name : "",
    initiative: asInt(o.initiative),
    initiativeBonus: asInt(o.initiativeBonus),
    hp: asInt(o.hp),
    hpMax: asInt(o.hpMax),
    ac: asInt(o.ac),
    conditions: Array.isArray(o.conditions)
      ? o.conditions.filter((c): c is string => typeof c === "string")
      : [],
    notes: typeof o.notes === "string" ? o.notes : "",
    down: o.down === true,
  };
}

export function readEncounter(e: Record<string, unknown>): EncounterData {
  const combatants = Array.isArray(e.combatants)
    ? e.combatants.map(asCombatant).filter((c): c is Combatant => c !== null)
    : [];
  const status: EncounterStatus =
    e.status === "running" || e.status === "done" ? e.status : "planned";
  const round = Math.max(0, asInt(e.round) ?? 0);
  const turn = asInt(e.turn) ?? 0;
  return {
    status,
    round: status === "planned" ? 0 : Math.max(1, round),
    turn:
      combatants.length === 0
        ? 0
        : Math.min(Math.max(0, turn), combatants.length - 1),
    combatants,
  };
}

export function newCombatantId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** The kinds a combatant can be picked from: the People family. */
export const COMBATANT_KINDS: readonly string[] = ELEMENT_KINDS.filter(
  (k) => k.family === "people",
).map((k) => k.id);

/** People elements matching `query`, best matches first, at most `limit`. */
export function searchPeople(
  elements: ElementSummary[],
  query: string,
  limit = 8,
): ElementSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const people = elements.filter((e) => COMBATANT_KINDS.includes(e.type));
  const scored = people
    .map((e) => {
      const name = e.name.toLowerCase();
      let score = -1;
      if (name === q) score = 3;
      else if (name.startsWith(q)) score = 2;
      else if (name.includes(q)) score = 1;
      else if (e.tags.some((t) => t.toLowerCase().includes(q))) score = 0;
      return { e, score };
    })
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((s) => s.e);
}

/**
 * A name no other combatant has: the second goblin becomes "Goblin 2". The
 * first keeps its plain name so a single foe reads naturally.
 */
export function uniqueName(name: string, existing: Combatant[]): string {
  const taken = new Set(existing.map((c) => c.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A combatant for a people element, with its numbers snapshotted. */
export function combatantFrom(
  element: ElementSummary,
  existing: Combatant[],
): Combatant {
  const base: Combatant = {
    id: newCombatantId(),
    element: element.id,
    name: uniqueName(element.name, existing),
    initiative: null,
    initiativeBonus: null,
    hp: null,
    hpMax: null,
    ac: null,
    conditions: [],
    notes: "",
    down: false,
  };
  const sheet =
    element.type === "character" ? readSheet5e(element.sheet) : null;
  if (sheet) {
    return {
      ...base,
      initiativeBonus: modifier(sheet.abilities.dex),
      hp: sheet.hp.current ?? sheet.hp.max,
      hpMax: sheet.hp.max,
      ac: sheet.ac,
    };
  }
  const sb =
    element.type === "creature" ? readStatBlock5e(element.statblock) : null;
  if (sb) {
    return {
      ...base,
      initiativeBonus: modifier(sb.abilities.dex),
      hp: sb.hp,
      hpMax: sb.hp,
      ac: sb.ac,
    };
  }
  return base;
}

/** A combatant that stands for nothing in the bible: a nameless guard. */
export function customCombatant(
  name: string,
  existing: Combatant[],
): Combatant {
  return {
    id: newCombatantId(),
    element: null,
    name: uniqueName(name.trim(), existing),
    initiative: null,
    initiativeBonus: null,
    hp: null,
    hpMax: null,
    ac: null,
    conditions: [],
    notes: "",
    down: false,
  };
}

function currentId(data: EncounterData): string | null {
  return data.combatants[data.turn]?.id ?? null;
}

/** Points `turn` at `id` again after the list changed, when it is still there. */
function follow(data: EncounterData, id: string | null): EncounterData {
  if (data.combatants.length === 0) return { ...data, turn: 0 };
  const idx = id === null ? -1 : data.combatants.findIndex((c) => c.id === id);
  const turn = idx >= 0 ? idx : Math.min(data.turn, data.combatants.length - 1);
  return { ...data, turn };
}

export function addCombatant(
  data: EncounterData,
  combatant: Combatant,
): EncounterData {
  return follow(
    { ...data, combatants: [...data.combatants, combatant] },
    currentId(data),
  );
}

export function removeCombatant(
  data: EncounterData,
  id: string,
): EncounterData {
  const current = currentId(data);
  const combatants = data.combatants.filter((c) => c.id !== id);
  // Removing whose turn it is hands the turn to the next in line, which now
  // sits at the same index.
  return follow({ ...data, combatants }, current === id ? null : current);
}

export function patchCombatant(
  data: EncounterData,
  id: string,
  patch: Partial<Combatant>,
): EncounterData {
  return {
    ...data,
    combatants: data.combatants.map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    ),
  };
}

/** Moves the combatant at `from` so it sits at `to`; the turn follows it. */
export function moveCombatant(
  data: EncounterData,
  from: number,
  to: number,
): EncounterData {
  const n = data.combatants.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return data;
  const combatants = data.combatants.slice();
  const [item] = combatants.splice(from, 1);
  if (item) combatants.splice(to, 0, item);
  return follow({ ...data, combatants }, currentId(data));
}

/** Highest initiative first; ties go to the better bonus; blanks last. */
export function sortByInitiative(data: EncounterData): EncounterData {
  const combatants = data.combatants
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ai = a.c.initiative;
      const bi = b.c.initiative;
      if (ai === null && bi === null) return a.i - b.i;
      if (ai === null) return 1;
      if (bi === null) return -1;
      if (bi !== ai) return bi - ai;
      return (
        (b.c.initiativeBonus ?? 0) - (a.c.initiativeBonus ?? 0) || a.i - b.i
      );
    })
    .map(({ c }) => c);
  return follow({ ...data, combatants }, currentId(data));
}

function firstActive(combatants: Combatant[]): number {
  const idx = combatants.findIndex((c) => !c.down);
  return idx < 0 ? 0 : idx;
}

export function startEncounter(data: EncounterData): EncounterData {
  if (data.combatants.length === 0) return data;
  return {
    ...data,
    status: "running",
    round: 1,
    turn: firstActive(data.combatants),
  };
}

export function endEncounter(data: EncounterData): EncounterData {
  return { ...data, status: "done" };
}

/** Back to the plan: round and turn cleared, combatants and their HP kept. */
export function resetEncounter(data: EncounterData): EncounterData {
  return { ...data, status: "planned", round: 0, turn: 0 };
}

/**
 * The next combatant still standing. Passing the end of the list starts a
 * new round. With nobody standing, nothing moves.
 */
export function nextTurn(data: EncounterData): EncounterData {
  const n = data.combatants.length;
  if (data.status !== "running" || n === 0) return data;
  for (let step = 1; step <= n; step++) {
    const at = data.turn + step;
    const idx = at % n;
    if (data.combatants[idx]?.down) continue;
    return { ...data, turn: idx, round: data.round + (at >= n ? 1 : 0) };
  }
  return data;
}

/** The previous combatant still standing; never before round one's start. */
export function prevTurn(data: EncounterData): EncounterData {
  const n = data.combatants.length;
  if (data.status !== "running" || n === 0) return data;
  for (let step = 1; step <= n; step++) {
    const at = data.turn - step;
    const idx = ((at % n) + n) % n;
    if (data.combatants[idx]?.down) continue;
    const wraps = at < 0;
    if (wraps && data.round <= 1) return data;
    return { ...data, turn: idx, round: data.round - (wraps ? 1 : 0) };
  }
  return data;
}

/**
 * Reads what was typed into a hit-point field: "+5" heals, "-7" damages,
 * anything else sets the value; blank clears it.
 */
export function applyHpInput(
  current: number | null,
  text: string,
): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return current;
  if (t.startsWith("+") || t.startsWith("-")) return (current ?? 0) + n;
  return Math.round(n);
}

/** One line for lists: "4 combatants · round 3" or "Planned · 2 combatants". */
export function encounterSummary(data: EncounterData): string {
  const count = `${data.combatants.length} combatant${data.combatants.length === 1 ? "" : "s"}`;
  if (data.status === "running") return `Round ${data.round} · ${count}`;
  if (data.status === "done") return `Finished · ${count}`;
  return `Planned · ${count}`;
}
