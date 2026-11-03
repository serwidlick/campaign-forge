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

export interface Attack {
  id: string;
  name: string;
  /** "+7", or whatever the table says. */
  bonus: string;
  damage: string;
  notes: string;
}

export interface Feature {
  id: string;
  name: string;
  /** Where it comes from: "Fighter 1", "Elf", a feat. */
  source: string;
  notes: string;
}

export interface Spell {
  id: string;
  name: string;
  /** 0 for a cantrip. */
  level: number;
  prepared: boolean;
  notes: string;
}

export interface SlotRow {
  max: number;
  used: number;
}

export interface Spellcasting {
  ability: Ability | "";
  /** While true, slot maximums follow class and level. */
  slotsAuto: boolean;
  /** Keyed "1".."9". */
  slots: Record<string, SlotRow>;
  spells: Spell[];
}

export interface InventoryItem {
  id: string;
  name: string;
  qty: number;
  /** Free text; summed when numeric. */
  weight: string;
  notes: string;
}

export interface Currency {
  cp: number;
  sp: number;
  ep: number;
  gp: number;
  pp: number;
}

export interface Personality {
  traits: string;
  ideals: string;
  bonds: string;
  flaws: string;
}

export interface Status {
  inspiration: boolean;
  deathSaves: { successes: number; failures: number };
  conditions: string[];
  exhaustion: number;
  hitDiceUsed: number;
}

export const CONDITIONS = [
  "Blinded",
  "Charmed",
  "Deafened",
  "Frightened",
  "Grappled",
  "Incapacitated",
  "Invisible",
  "Paralyzed",
  "Petrified",
  "Poisoned",
  "Prone",
  "Restrained",
  "Stunned",
  "Unconscious",
];

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

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
  /** Species whose fixed ability bonuses were added to the scores, if any. */
  asiFrom: string;
  /** Bonus points the player placed from the species' pool, by ability. */
  asiChosen: Partial<Record<Ability, number>>;
  senses: string;
  languages: string;
  attacks: Attack[];
  features: Feature[];
  spellcasting: Spellcasting;
  inventory: InventoryItem[];
  currency: Currency;
  personality: Personality;
  status: Status;
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
  asiFrom: "",
  asiChosen: {},
  senses: "",
  languages: "",
  attacks: [],
  features: [],
  spellcasting: { ability: "", slotsAuto: true, slots: {}, spells: [] },
  inventory: [],
  currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
  personality: { traits: "", ideals: "", bonds: "", flaws: "" },
  status: {
    inspiration: false,
    deathSaves: { successes: 0, failures: 0 },
    conditions: [],
    exhaustion: 0,
    hitDiceUsed: 0,
  },
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
    asiFrom: str(o.asiFrom),
    asiChosen: readAsiChosen(o.asiChosen),
    senses: str(o.senses),
    languages: str(o.languages),
    attacks: readList(o.attacks, (r) => ({
      id: str(r.id) || newId(),
      name: str(r.name),
      bonus: str(r.bonus),
      damage: str(r.damage),
      notes: str(r.notes),
    })),
    features: readList(o.features, (r) => ({
      id: str(r.id) || newId(),
      name: str(r.name),
      source: str(r.source),
      notes: str(r.notes),
    })),
    spellcasting: readSpellcasting(o.spellcasting),
    inventory: readList(o.inventory, (r) => ({
      id: str(r.id) || newId(),
      name: str(r.name),
      qty: Math.max(0, int(r.qty) ?? 1),
      weight: str(r.weight),
      notes: str(r.notes),
    })),
    currency: readCurrency(o.currency),
    personality: readPersonality(o.personality),
    status: readStatus(o.status),
  };
}

function readAsiChosen(v: unknown): Partial<Record<Ability, number>> {
  const out: Partial<Record<Ability, number>> = {};
  if (!v || typeof v !== "object") return out;
  for (const a of ABILITIES) {
    const n = int((v as Record<string, unknown>)[a]);
    if (n !== null && n > 0) out[a] = n;
  }
  return out;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function readList<T>(
  v: unknown,
  read: (row: Record<string, unknown>) => T,
): T[] {
  return Array.isArray(v)
    ? v.filter((r) => r && typeof r === "object").map((r) => read(obj(r)))
    : [];
}

function readSpellcasting(v: unknown): Spellcasting {
  const o = obj(v);
  const slots: Record<string, SlotRow> = {};
  const raw = obj(o.slots);
  for (let l = 1; l <= 9; l++) {
    const row = obj(raw[String(l)]);
    const max = Math.max(0, int(row.max) ?? 0);
    const used = Math.max(0, Math.min(max, int(row.used) ?? 0));
    if (max > 0 || used > 0) slots[String(l)] = { max, used };
  }
  return {
    ability: isAbility(o.ability) ? o.ability : "",
    slotsAuto: o.slotsAuto !== false,
    slots,
    spells: readList(o.spells, (r) => ({
      id: str(r.id) || newId(),
      name: str(r.name),
      level: Math.max(0, Math.min(9, int(r.level) ?? 0)),
      prepared: r.prepared !== false,
      notes: str(r.notes),
    })),
  };
}

function readCurrency(v: unknown): Currency {
  const o = obj(v);
  const coin = (k: string) => Math.max(0, int(o[k]) ?? 0);
  return {
    cp: coin("cp"),
    sp: coin("sp"),
    ep: coin("ep"),
    gp: coin("gp"),
    pp: coin("pp"),
  };
}

function readPersonality(v: unknown): Personality {
  const o = obj(v);
  return {
    traits: str(o.traits),
    ideals: str(o.ideals),
    bonds: str(o.bonds),
    flaws: str(o.flaws),
  };
}

function readStatus(v: unknown): Status {
  const o = obj(v);
  const ds = obj(o.deathSaves);
  const clamp3 = (x: unknown) => Math.max(0, Math.min(3, int(x) ?? 0));
  return {
    inspiration: o.inspiration === true,
    deathSaves: {
      successes: clamp3(ds.successes),
      failures: clamp3(ds.failures),
    },
    conditions: Array.isArray(o.conditions)
      ? (o.conditions.filter((c) => typeof c === "string") as string[])
      : [],
    exhaustion: Math.max(0, Math.min(6, int(o.exhaustion) ?? 0)),
    hitDiceUsed: Math.max(0, int(o.hitDiceUsed) ?? 0),
  };
}

export function spellSaveDc(sheet: Sheet5e): number {
  const ability = sheet.spellcasting.ability;
  if (!ability) return 0;
  return 8 + proficiencyBonus(sheet.level) + modifier(sheet.abilities[ability]);
}

export function spellAttackBonus(sheet: Sheet5e): number {
  const ability = sheet.spellcasting.ability;
  if (!ability) return 0;
  return proficiencyBonus(sheet.level) + modifier(sheet.abilities[ability]);
}

export type SpellProgression = "full" | "half" | "artificer" | "third" | "pact";

/** Slots per spell level for a full caster, by class level 1..20. */
const FULL_CASTER_SLOTS: number[][] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

/** Slot maximums ("1".."9") a class grants at a level. */
export function slotsFor(
  progression: SpellProgression,
  level: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const lv = Math.max(1, Math.min(20, level));
  if (progression === "pact") {
    const count = lv === 1 ? 1 : lv <= 10 ? 2 : lv <= 16 ? 3 : 4;
    const slotLevel = lv <= 2 ? 1 : lv <= 4 ? 2 : lv <= 6 ? 3 : lv <= 8 ? 4 : 5;
    out[String(slotLevel)] = count;
    return out;
  }
  const effective =
    progression === "full"
      ? lv
      : progression === "half"
        ? Math.floor(lv / 2)
        : progression === "artificer"
          ? Math.ceil(lv / 2)
          : Math.floor(lv / 3);
  if (effective < 1) return out;
  const row = FULL_CASTER_SLOTS[effective - 1] ?? [];
  row.forEach((n, i) => {
    if (n > 0) out[String(i + 1)] = n;
  });
  return out;
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
