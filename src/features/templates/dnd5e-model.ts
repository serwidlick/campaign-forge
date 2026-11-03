/**
 * A D&D 5e character sheet, stored on a character element as `sheet`.
 * Derived numbers (modifiers, proficiency bonus, skill and save totals) are
 * computed here from the stored scores so the file stays small and honest.
 */

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export interface Skill {
  id: string;
  name: string;
  ability: Ability;
}

export const SKILLS: Skill[] = [
  { id: "acrobatics", name: "Acrobatics", ability: "dex" },
  { id: "animal-handling", name: "Animal Handling", ability: "wis" },
  { id: "arcana", name: "Arcana", ability: "int" },
  { id: "athletics", name: "Athletics", ability: "str" },
  { id: "deception", name: "Deception", ability: "cha" },
  { id: "history", name: "History", ability: "int" },
  { id: "insight", name: "Insight", ability: "wis" },
  { id: "intimidation", name: "Intimidation", ability: "cha" },
  { id: "investigation", name: "Investigation", ability: "int" },
  { id: "medicine", name: "Medicine", ability: "wis" },
  { id: "nature", name: "Nature", ability: "int" },
  { id: "perception", name: "Perception", ability: "wis" },
  { id: "performance", name: "Performance", ability: "cha" },
  { id: "persuasion", name: "Persuasion", ability: "cha" },
  { id: "religion", name: "Religion", ability: "int" },
  { id: "sleight-of-hand", name: "Sleight of Hand", ability: "dex" },
  { id: "stealth", name: "Stealth", ability: "dex" },
  { id: "survival", name: "Survival", ability: "wis" },
];

export const ALIGNMENTS = [
  "Lawful good",
  "Neutral good",
  "Chaotic good",
  "Lawful neutral",
  "True neutral",
  "Chaotic neutral",
  "Lawful evil",
  "Neutral evil",
  "Chaotic evil",
  "Unaligned",
];

export type SheetRole = "pc" | "npc";

export interface Sheet5e {
  role: SheetRole;
  class: string;
  subclass: string;
  level: number;
  species: string;
  background: string;
  alignment: string;
  abilities: Record<Ability, number>;
  ac: number | null;
  hp: { max: number | null; current: number | null; temp: number | null };
  speed: string;
  /** Abilities with saving-throw proficiency. */
  saves: Ability[];
  /** Skill ids with proficiency. */
  skills: string[];
  /** Skill ids with expertise (double proficiency). */
  expertise: string[];
  senses: string;
  languages: string;
}

export const EMPTY_SHEET: Sheet5e = {
  role: "npc",
  class: "",
  subclass: "",
  level: 1,
  species: "",
  background: "",
  alignment: "",
  abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  ac: null,
  hp: { max: null, current: null, temp: null },
  speed: "30 ft.",
  saves: [],
  skills: [],
  expertise: [],
  senses: "",
  languages: "",
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function isAbility(v: unknown): v is Ability {
  return typeof v === "string" && (ABILITIES as readonly string[]).includes(v);
}

/** Reads a sheet defensively; `null` when the element has none. */
export function readSheet5e(v: unknown): Sheet5e | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ab =
    o.abilities && typeof o.abilities === "object"
      ? (o.abilities as Record<string, unknown>)
      : {};
  const hp =
    o.hp && typeof o.hp === "object" ? (o.hp as Record<string, unknown>) : {};
  const abilities = { ...EMPTY_SHEET.abilities };
  for (const a of ABILITIES) {
    const n = int(ab[a]);
    if (n !== null) abilities[a] = Math.max(1, Math.min(30, n));
  }
  const skillIds = new Set(SKILLS.map((s) => s.id));
  const list = (x: unknown, keep: (s: unknown) => boolean) =>
    Array.isArray(x) ? (x.filter(keep) as string[]) : [];
  return {
    role: o.role === "pc" ? "pc" : "npc",
    class: str(o.class),
    subclass: str(o.subclass),
    level: Math.max(1, Math.min(20, int(o.level) ?? 1)),
    species: str(o.species),
    background: str(o.background),
    alignment: str(o.alignment),
    abilities,
    ac: int(o.ac),
    hp: { max: int(hp.max), current: int(hp.current), temp: int(hp.temp) },
    speed: str(o.speed, EMPTY_SHEET.speed),
    saves: list(o.saves, isAbility) as Ability[],
    skills: list(o.skills, (s) => typeof s === "string" && skillIds.has(s)),
    expertise: list(
      o.expertise,
      (s) => typeof s === "string" && skillIds.has(s),
    ),
    senses: str(o.senses),
    languages: str(o.languages),
  };
}

export function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

export function saveBonus(sheet: Sheet5e, ability: Ability): number {
  const base = modifier(sheet.abilities[ability]);
  return sheet.saves.includes(ability)
    ? base + proficiencyBonus(sheet.level)
    : base;
}

export function skillBonus(sheet: Sheet5e, skill: Skill): number {
  const base = modifier(sheet.abilities[skill.ability]);
  const pb = proficiencyBonus(sheet.level);
  if (sheet.expertise.includes(skill.id)) return base + pb * 2;
  if (sheet.skills.includes(skill.id)) return base + pb;
  return base;
}

export function passivePerception(sheet: Sheet5e): number {
  const perception = SKILLS.find((s) => s.id === "perception")!;
  return 10 + skillBonus(sheet, perception);
}

/** "Level 5 Human Fighter (Champion)" or whatever parts are filled in. */
export function sheetSummary(sheet: Sheet5e): string {
  const parts = [
    `Level ${sheet.level}`,
    sheet.species,
    sheet.class + (sheet.subclass ? ` (${sheet.subclass})` : ""),
  ].filter((p) => p.trim());
  return parts.join(" ");
}
