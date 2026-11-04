/**
 * A D&D 5e creature stat block, stored on a creature element as `statblock`.
 * Numbers that follow from others (modifiers, proficiency bonus and XP from
 * the challenge rating) are derived here.
 */
import {
  ABILITIES,
  modifier,
  newId,
  signed,
  type Ability,
} from "./dnd5e-model";

export interface NamedEntry {
  id: string;
  name: string;
  text: string;
}

export interface StatBlock5e {
  size: string;
  type: string;
  alignment: string;
  ac: number | null;
  acNote: string;
  hp: number | null;
  hpFormula: string;
  speed: string;
  abilities: Record<Ability, number>;
  saves: string;
  skills: string;
  vulnerabilities: string;
  resistances: string;
  immunities: string;
  conditionImmunities: string;
  senses: string;
  languages: string;
  /** "0", "1/8", "1/4", "1/2", "1" .. "30". */
  cr: string;
  traits: NamedEntry[];
  actions: NamedEntry[];
  bonusActions: NamedEntry[];
  reactions: NamedEntry[];
  legendary: NamedEntry[];
}

export const SIZES = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];

export const CREATURE_TYPES = [
  "Aberration",
  "Beast",
  "Celestial",
  "Construct",
  "Dragon",
  "Elemental",
  "Fey",
  "Fiend",
  "Giant",
  "Humanoid",
  "Monstrosity",
  "Ooze",
  "Plant",
  "Undead",
];

/** Challenge rating → experience points, in the order ratings go. */
export const CR_TABLE: [string, number][] = [
  ["0", 10],
  ["1/8", 25],
  ["1/4", 50],
  ["1/2", 100],
  ["1", 200],
  ["2", 450],
  ["3", 700],
  ["4", 1100],
  ["5", 1800],
  ["6", 2300],
  ["7", 2900],
  ["8", 3900],
  ["9", 5000],
  ["10", 5900],
  ["11", 7200],
  ["12", 8400],
  ["13", 10000],
  ["14", 11500],
  ["15", 13000],
  ["16", 15000],
  ["17", 18000],
  ["18", 20000],
  ["19", 22000],
  ["20", 25000],
  ["21", 33000],
  ["22", 41000],
  ["23", 50000],
  ["24", 62000],
  ["25", 75000],
  ["26", 90000],
  ["27", 105000],
  ["28", 120000],
  ["29", 135000],
  ["30", 155000],
];

export const CRS = CR_TABLE.map(([cr]) => cr);

export const EMPTY_STATBLOCK: StatBlock5e = {
  size: "Medium",
  type: "",
  alignment: "",
  ac: null,
  acNote: "",
  hp: null,
  hpFormula: "",
  speed: "30 ft.",
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  saves: "",
  skills: "",
  vulnerabilities: "",
  resistances: "",
  immunities: "",
  conditionImmunities: "",
  senses: "",
  languages: "",
  cr: "",
  traits: [],
  actions: [],
  bonusActions: [],
  reactions: [],
  legendary: [],
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function entries(v: unknown): NamedEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const o = r as Record<string, unknown>;
      return { id: str(o.id) || newId(), name: str(o.name), text: str(o.text) };
    });
}

/** Reads a stat block defensively; `null` when the element has none. */
export function readStatBlock5e(v: unknown): StatBlock5e | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ab =
    o.abilities && typeof o.abilities === "object"
      ? (o.abilities as Record<string, unknown>)
      : {};
  const abilities = { ...EMPTY_STATBLOCK.abilities };
  for (const a of ABILITIES) {
    const n = int(ab[a]);
    if (n !== null) abilities[a] = Math.max(1, Math.min(30, n));
  }
  return {
    size: str(o.size, EMPTY_STATBLOCK.size),
    type: str(o.type),
    alignment: str(o.alignment),
    ac: int(o.ac),
    acNote: str(o.acNote),
    hp: int(o.hp),
    hpFormula: str(o.hpFormula),
    speed: str(o.speed, EMPTY_STATBLOCK.speed),
    abilities,
    saves: str(o.saves),
    skills: str(o.skills),
    vulnerabilities: str(o.vulnerabilities),
    resistances: str(o.resistances),
    immunities: str(o.immunities),
    conditionImmunities: str(o.conditionImmunities),
    senses: str(o.senses),
    languages: str(o.languages),
    cr: CRS.includes(str(o.cr)) ? str(o.cr) : "",
    traits: entries(o.traits),
    actions: entries(o.actions),
    bonusActions: entries(o.bonusActions),
    reactions: entries(o.reactions),
    legendary: entries(o.legendary),
  };
}

export function crInfo(cr: string): { xp: number; pb: number } | null {
  const row = CR_TABLE.find(([c]) => c === cr);
  if (!row) return null;
  const n = cr.includes("/") ? 0 : Number(cr);
  const pb = n <= 4 ? 2 : 2 + Math.floor((n - 1) / 4);
  return { xp: row[1], pb };
}

/** "Medium humanoid (any), chaotic evil" or whatever parts exist. */
export function statBlockLine(sb: StatBlock5e): string {
  const kind = [sb.size, sb.type.toLowerCase()].filter(Boolean).join(" ");
  return [kind, sb.alignment.toLowerCase()].filter(Boolean).join(", ");
}

export function abilityLine(sb: StatBlock5e): string {
  return ABILITIES.map(
    (a) =>
      `${a.toUpperCase()} ${sb.abilities[a]} (${signed(modifier(sb.abilities[a]))})`,
  ).join(" · ");
}
