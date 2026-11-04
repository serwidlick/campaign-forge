/**
 * The rules for turning picks into a 5e sheet, shared by the sheet (which
 * applies them one field at a time) and the charactermancer (which applies
 * them all at once at the end). Pure functions over the stored shape only.
 */
import {
  THIRD_CASTERS,
  backgroundByName,
  classByName,
  speciesByName,
  type Asi,
} from "./dnd5e-data";
import {
  ABILITIES,
  EMPTY_SHEET,
  modifier,
  newId,
  slotsFor,
  type Ability,
  type Personality,
  type Sheet5e,
} from "./dnd5e-model";

/** Slot maximums follow class, subclass and level while `slotsAuto` holds. */
export function withAutoSlots(s: Sheet5e): Sheet5e {
  const cls = classByName(s.class);
  const third = THIRD_CASTERS[s.subclass.trim()];
  const progression =
    cls?.spellcasting?.progression ?? (third ? "third" : null);
  const ability = cls?.spellcasting?.ability ?? third ?? null;
  const sc = s.spellcasting;
  const nextAbility = sc.ability || ability || "";
  if (!sc.slotsAuto) {
    return nextAbility === sc.ability
      ? s
      : { ...s, spellcasting: { ...sc, ability: nextAbility } };
  }
  const maxes = progression ? slotsFor(progression, s.level) : {};
  const slots: Sheet5e["spellcasting"]["slots"] = {};
  for (const [level, max] of Object.entries(maxes)) {
    const used = sc.slots[level]?.used ?? 0;
    slots[level] = { max, used: Math.min(used, max) };
  }
  return { ...s, spellcasting: { ...sc, ability: nextAbility, slots } };
}

export function shiftAbilities(
  abilities: Sheet5e["abilities"],
  asi: Asi,
  sign: 1 | -1,
): Sheet5e["abilities"] {
  const out = { ...abilities };
  for (const [key, bonus] of Object.entries(asi) as [Ability, number][]) {
    out[key] = Math.max(1, Math.min(30, out[key] + sign * bonus));
  }
  return out;
}

/** Drops skills the previous pick granted and adds the next pick's. */
export function withGrantedSkills(
  current: string[],
  previous: string[],
  next: string[],
): string[] {
  const kept = current.filter(
    (id) => !previous.includes(id) || next.includes(id),
  );
  for (const id of next) if (!kept.includes(id)) kept.push(id);
  return kept;
}

export function sameSet<T>(a: T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The level at which a class picks its subclass; three unless listed. */
const SUBCLASS_LEVEL: Record<string, number> = {
  Cleric: 1,
  Sorcerer: 1,
  Warlock: 1,
  Druid: 2,
  Wizard: 2,
};

export function subclassLevel(className: string): number {
  return SUBCLASS_LEVEL[classByName(className)?.name ?? ""] ?? 3;
}

/** Classes that choose skills for expertise, and from what level. */
const EXPERTISE: Record<string, { level: number; count: number }> = {
  Rogue: { level: 1, count: 2 },
  Bard: { level: 3, count: 2 },
};

export function expertisePicks(className: string, level: number): number {
  const rule = EXPERTISE[classByName(className)?.name ?? ""];
  return rule && level >= rule.level ? rule.count : 0;
}

/**
 * Hit point maximum by the book: the full hit die at first level, then the
 * die's average (rounded up) for every level after, each with the
 * Constitution modifier and never less than one per level.
 */
export function hitPointsFor(
  hitDie: number,
  level: number,
  conScore: number,
): number {
  const con = modifier(conScore);
  const first = Math.max(1, hitDie + con);
  const perLevel = Math.max(1, Math.floor(hitDie / 2) + 1 + con);
  return first + perLevel * (Math.max(1, level) - 1);
}

// ---- Ability score generation --------------------------------------------

export type ScoreMethod = "array" | "pointbuy" | "roll" | "manual";

export const SCORE_METHODS: {
  id: ScoreMethod;
  label: string;
  blurb: string;
}[] = [
  {
    id: "array",
    label: "Standard array",
    blurb: "Place 15, 14, 13, 12, 10 and 8 where you want them.",
  },
  {
    id: "pointbuy",
    label: "Point buy",
    blurb: "Spend 27 points; every score starts at 8 and tops out at 15.",
  },
  {
    id: "roll",
    label: "Roll",
    blurb: "Roll 4d6 six times, drop the lowest die, then place the results.",
  },
  {
    id: "manual",
    label: "Type them in",
    blurb: "Enter the six scores yourself.",
  },
];

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;

const POINT_COST: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export function pointCost(score: number): number {
  return POINT_COST[score] ?? 0;
}

export function pointsSpent(scores: Record<Ability, number>): number {
  return ABILITIES.reduce((n, a) => n + pointCost(scores[a]), 0);
}

/** 4d6, drop the lowest. */
export function roll4d6DropLowest(random: () => number = Math.random): number {
  const dice = [0, 0, 0, 0].map(() => 1 + Math.floor(random() * 6));
  dice.sort((a, b) => a - b);
  return dice[1]! + dice[2]! + dice[3]!;
}

export function rollScores(random: () => number = Math.random): number[] {
  return ABILITIES.map(() => roll4d6DropLowest(random)).sort((a, b) => b - a);
}

// ---- The draft a wizard builds up ----------------------------------------

export interface Build5e {
  name: string;
  level: number;
  species: string;
  class: string;
  subclass: string;
  background: string;
  alignment: string;
  method: ScoreMethod;
  /** Scores before any species bonus, for point buy and typed scores. */
  base: Record<Ability, number>;
  /** The six values to place, for the standard array and rolling. */
  pool: number[];
  /** Which pool entry (by index) each ability took. */
  assign: Partial<Record<Ability, number>>;
  /** Points placed from a species' flexible pool. */
  asiChosen: Partial<Record<Ability, number>>;
  /** Skill proficiencies chosen from the class list. */
  classSkills: string[];
  /** Skill proficiencies chosen where the background offers a choice. */
  backgroundSkills: string[];
  expertise: string[];
  /** Overrides the computed maximum when set. */
  hpMax: number | null;
  personality: Personality;
}

export function emptyBuild(name = ""): Build5e {
  return {
    name,
    level: 1,
    species: "",
    class: "",
    subclass: "",
    background: "",
    alignment: "",
    method: "array",
    base: { ...EMPTY_SHEET.abilities },
    pool: [...STANDARD_ARRAY],
    assign: {},
    asiChosen: {},
    classSkills: [],
    backgroundSkills: [],
    expertise: [],
    hpMax: null,
    personality: { traits: "", ideals: "", bonds: "", flaws: "" },
  };
}

export function placesScores(method: ScoreMethod): boolean {
  return method === "array" || method === "roll";
}

/** Scores before species bonuses; an unplaced pool value counts as 10. */
export function baseScores(b: Build5e): Record<Ability, number> {
  if (!placesScores(b.method)) return { ...b.base };
  const out = { ...EMPTY_SHEET.abilities };
  for (const a of ABILITIES) {
    const idx = b.assign[a];
    const v = idx === undefined ? undefined : b.pool[idx];
    out[a] = v ?? 10;
  }
  return out;
}

/** Final scores: base, plus fixed species bonuses, plus placed points. */
export function finalAbilities(b: Build5e): Record<Ability, number> {
  const species = speciesByName(b.species);
  let out = baseScores(b);
  if (species) out = shiftAbilities(out, species.asi, 1);
  out = shiftAbilities(out, b.asiChosen, 1);
  return out;
}

/** Skills granted outright by species and background, before any choice. */
export function grantedSkills(b: Build5e): string[] {
  const species = speciesByName(b.species)?.skills ?? [];
  const background = backgroundByName(b.background)?.skills ?? [];
  const out: string[] = [];
  for (const id of [...species, ...background]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function allSkills(b: Build5e): string[] {
  const out = grantedSkills(b);
  for (const id of [...b.backgroundSkills, ...b.classSkills]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function computedHp(b: Build5e): number | null {
  const cls = classByName(b.class);
  if (!cls) return null;
  return hitPointsFor(cls.hitDie, b.level, finalAbilities(b).con);
}

/** What the wizard still needs before it can finish, in step order. */
export function buildProblems(b: Build5e): string[] {
  const out: string[] = [];
  if (!b.name.trim()) out.push("Give the character a name.");
  if (!b.species.trim()) out.push("Pick a species.");
  if (!b.class.trim()) out.push("Pick a class.");
  const cls = classByName(b.class);
  if (cls && cls.subclasses.length > 0 && b.level >= subclassLevel(b.class)) {
    if (!b.subclass.trim()) out.push("Pick a subclass.");
  }
  if (!b.background.trim()) out.push("Pick a background.");
  const pool = speciesByName(b.species)?.asiChoice;
  if (pool) {
    const used = Object.values(b.asiChosen).reduce((n, v) => n + (v ?? 0), 0);
    if (used < pool.points) out.push("Place the species' bonus points.");
  }
  if (b.method === "pointbuy" && pointsSpent(b.base) > POINT_BUY_BUDGET) {
    out.push("Point buy is over budget.");
  }
  if (
    placesScores(b.method) &&
    ABILITIES.some((a) => b.assign[a] === undefined)
  ) {
    out.push("Place all six ability scores.");
  }
  if (cls && b.classSkills.length < cls.skills.choose) {
    out.push(
      `Choose ${cls.skills.choose} class ${cls.skills.choose === 1 ? "skill" : "skills"}.`,
    );
  }
  const bg = backgroundByName(b.background);
  if (bg?.choose && b.backgroundSkills.length < bg.choose.count) {
    out.push(`Choose ${bg.choose.count} background skill(s).`);
  }
  const expertise = expertisePicks(b.class, b.level);
  if (expertise > 0 && b.expertise.length < expertise) {
    out.push(`Choose ${expertise} skills for expertise.`);
  }
  return out;
}

/** The finished sheet: everything the picks grant, written down once. */
export function buildSheet(b: Build5e): Sheet5e {
  const cls = classByName(b.class);
  const species = speciesByName(b.species);
  const abilities = finalAbilities(b);
  const hpMax = b.hpMax ?? computedHp(b);
  const sheet: Sheet5e = {
    ...EMPTY_SHEET,
    role: "pc",
    class: b.class.trim(),
    subclass: b.subclass.trim(),
    level: Math.max(1, Math.min(20, b.level)),
    species: b.species.trim(),
    background: b.background.trim(),
    alignment: b.alignment,
    abilities,
    hp: { max: hpMax, current: hpMax, temp: null },
    speed: species ? `${species.speed} ft.` : EMPTY_SHEET.speed,
    saves: cls ? [...cls.saves] : [],
    skills: allSkills(b),
    expertise: b.expertise.filter((id) => allSkills(b).includes(id)),
    asiFrom: species && Object.keys(species.asi).length > 0 ? species.name : "",
    asiChosen: { ...b.asiChosen },
    senses: species?.darkvision ? `Darkvision ${species.darkvision} ft.` : "",
    languages: species?.languages ?? "",
    features: (species?.traits ?? []).map((name) => ({
      id: newId(),
      name,
      source: species!.name,
      notes: "",
    })),
    spellcasting: { ability: "", slotsAuto: true, slots: {}, spells: [] },
    currency: { ...EMPTY_SHEET.currency },
    personality: { ...b.personality },
    status: {
      ...EMPTY_SHEET.status,
      deathSaves: { successes: 0, failures: 0 },
      conditions: [],
    },
  };
  return withAutoSlots(sheet);
}
