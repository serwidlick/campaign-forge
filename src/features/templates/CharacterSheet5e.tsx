import { useEffect, useId, useRef, useState } from "react";

import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  sameSet,
  shiftAbilities,
  withAutoSlots,
  withGrantedSkills,
} from "./dnd5e-build";
import {
  BACKGROUNDS,
  CLASSES,
  SPECIES,
  backgroundByName,
  classByName,
  speciesByName,
} from "./dnd5e-data";
import {
  ABILITIES,
  ABILITY_NAMES,
  ALIGNMENTS,
  EMPTY_SHEET,
  SKILLS,
  modifier,
  passivePerception,
  proficiencyBonus,
  readSheet5e,
  saveBonus,
  signed,
  skillBonus,
  type Ability,
  type Sheet5e,
} from "./dnd5e-model";
import { SheetExtras } from "./SheetExtras";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";
const LABEL = "text-[11px] text-ink-400";
const AUTOSAVE_MS = 400;

/**
 * The structured part of a D&D 5e character. Edits save on a short
 * debounce; everything derived (modifiers, proficiency, totals) is computed
 * from the stored scores.
 */
export function CharacterSheet5e({ element }: { element: Element }) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const [sheet, setSheet] = useState<Sheet5e>(
    () => readSheet5e(element.sheet) ?? EMPTY_SHEET,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  function update(fn: (s: Sheet5e) => Sheet5e) {
    setSheet(fn);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }

  function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setSheet((s) => {
      void saveElement(element.id, { sheet: s });
      return s;
    });
  }

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  /**
   * Picking a class fills its saving throws unless the GM already chose
   * their own, and clears a subclass that belonged to the previous class.
   */
  function setClass(value: string) {
    update((s) => {
      const prev = classByName(s.class);
      const next = classByName(value);
      const savesUntouched =
        s.saves.length === 0 ||
        (prev !== undefined && sameSet(s.saves, prev.saves));
      const subclassStale =
        prev !== undefined &&
        prev.subclasses.includes(s.subclass) &&
        !(next?.subclasses.includes(s.subclass) ?? false);
      const startingHp = next
        ? Math.max(1, next.hitDie + modifier(s.abilities.con))
        : null;
      const hp =
        s.hp.max === null && startingHp !== null
          ? { ...s.hp, max: startingHp, current: s.hp.current ?? startingHp }
          : s.hp;
      return withAutoSlots({
        ...s,
        hp,
        class: value,
        saves: next && savesUntouched ? [...next.saves] : s.saves,
        subclass: subclassStale ? "" : s.subclass,
      });
    });
  }

  /**
   * Picking a species applies what it grants: fixed ability bonuses go
   * straight onto the scores, its skills are ticked, and speed, senses and
   * languages are filled in unless typed by hand. Whatever the previous
   * species had given is taken back first.
   */
  function setSpecies(value: string) {
    update((s) => {
      const prev = speciesByName(s.species);
      const next = speciesByName(value);
      let abilities = s.abilities;
      if (prev && s.asiFrom === prev.name) {
        abilities = shiftAbilities(abilities, prev.asi, -1);
      }
      abilities = shiftAbilities(abilities, s.asiChosen, -1);
      if (next) abilities = shiftAbilities(abilities, next.asi, 1);

      const speedUntouched =
        s.speed === EMPTY_SHEET.speed ||
        (prev !== undefined && s.speed === `${prev.speed} ft.`);
      const prevSenses = prev?.darkvision
        ? `Darkvision ${prev.darkvision} ft.`
        : "";
      const sensesUntouched = s.senses.trim() === "" || s.senses === prevSenses;
      const languagesUntouched =
        s.languages.trim() === "" || s.languages === prev?.languages;

      return {
        ...s,
        species: value,
        abilities,
        asiFrom: next && Object.keys(next.asi).length > 0 ? next.name : "",
        asiChosen: {},
        skills: withGrantedSkills(
          s.skills,
          prev?.skills ?? [],
          next?.skills ?? [],
        ),
        speed: next && speedUntouched ? `${next.speed} ft.` : s.speed,
        senses: sensesUntouched
          ? next?.darkvision
            ? `Darkvision ${next.darkvision} ft.`
            : ""
          : s.senses,
        languages: languagesUntouched && next ? next.languages : s.languages,
      };
    });
  }

  /** Places or removes one bonus point from the species' pool. */
  function adjustChoice(a: Ability, delta: 1 | -1) {
    update((s) => {
      const pool = speciesByName(s.species)?.asiChoice;
      if (!pool) return s;
      const current = s.asiChosen[a] ?? 0;
      const used = Object.values(s.asiChosen).reduce((n, v) => n + (v ?? 0), 0);
      if (delta > 0 && (used >= pool.points || current >= pool.maxPer)) {
        return s;
      }
      if (delta < 0 && current <= 0) return s;
      const asiChosen = { ...s.asiChosen, [a]: current + delta };
      if (asiChosen[a] === 0) delete asiChosen[a];
      return {
        ...s,
        asiChosen,
        abilities: shiftAbilities(s.abilities, { [a]: 1 }, delta),
      };
    });
  }

  /** For sheets made before bonuses applied themselves. */
  function applyAsi() {
    update((s) => {
      const sp = speciesByName(s.species);
      if (!sp || s.asiFrom === sp.name) return s;
      return {
        ...s,
        abilities: shiftAbilities(s.abilities, sp.asi, 1),
        asiFrom: sp.name,
      };
    });
  }

  /** Picking a background swaps its skill proficiencies in. */
  function setBackground(value: string) {
    update((s) => {
      const prev = backgroundByName(s.background);
      const next = backgroundByName(value);
      return {
        ...s,
        background: value,
        skills: withGrantedSkills(
          s.skills,
          prev?.skills ?? [],
          next?.skills ?? [],
        ),
      };
    });
  }

  const hitDie = classByName(sheet.class)?.hitDie;
  const classSkills = classByName(sheet.class)?.skills.from ?? [];
  const speciesInfo = speciesByName(sheet.species);
  const pool = speciesInfo?.asiChoice;
  const choiceUsed = Object.values(sheet.asiChosen).reduce(
    (n, v) => n + (v ?? 0),
    0,
  );
  const choiceLeft = pool ? Math.max(0, pool.points - choiceUsed) : 0;
  const fixedApplied =
    speciesInfo !== undefined && sheet.asiFrom === speciesInfo.name;
  const fixedText = speciesInfo
    ? (Object.entries(speciesInfo.asi) as [Ability, number][])
        .map(([k, v]) => `${signed(v)} ${k.toUpperCase()}`)
        .join(", ")
    : "";
  const pb = proficiencyBonus(sheet.level);
  const number = (v: string): number | null => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  return (
    <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      {/* Identity */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className={LABEL}>
          Role
          <select
            value={sheet.role}
            onChange={(e) =>
              update((s) => ({ ...s, role: e.target.value as Sheet5e["role"] }))
            }
            className={`mt-1 block ${FIELD}`}
          >
            <option value="pc">Player character</option>
            <option value="npc">NPC</option>
          </select>
        </label>
        <Combo
          label="Class"
          value={sheet.class}
          onChange={setClass}
          options={CLASSES.map((c) => c.name)}
          width="w-32"
          placeholder="Fighter"
        />
        <Combo
          label="Subclass"
          value={sheet.subclass}
          onChange={(v) => update((s) => withAutoSlots({ ...s, subclass: v }))}
          options={
            classByName(sheet.class)?.subclasses ??
            CLASSES.flatMap((c) => c.subclasses)
          }
          width="w-44"
          placeholder="Champion"
        />
        <label className={LABEL}>
          Level
          <input
            type="number"
            min={1}
            max={20}
            value={sheet.level}
            onChange={(e) =>
              update((s) =>
                withAutoSlots({
                  ...s,
                  level: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                }),
              )
            }
            className={`mt-1 block w-16 ${FIELD}`}
          />
        </label>
        <Combo
          label="Species"
          value={sheet.species}
          onChange={setSpecies}
          options={SPECIES.map((sp) => sp.name)}
          width="w-36"
          placeholder="Human"
        />
        <Combo
          label="Background"
          value={sheet.background}
          onChange={setBackground}
          options={BACKGROUNDS.map((b) => b.name)}
          width="w-36"
          placeholder="Soldier"
        />
        <label className={LABEL}>
          Alignment
          <select
            value={sheet.alignment}
            onChange={(e) =>
              update((s) => ({ ...s, alignment: e.target.value }))
            }
            className={`mt-1 block ${FIELD}`}
          >
            <option value="">—</option>
            {ALIGNMENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Grants sheet={sheet} />

      {/* Abilities */}
      {pool && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <span className="font-semibold">
            {speciesInfo?.name}: {choiceLeft === 0 ? "all" : choiceLeft} of{" "}
            {pool.points} bonus {pool.points === 1 ? "point" : "points"}{" "}
            {choiceLeft === 0 ? "placed" : "still to place"}
          </span>
          <span className="text-amber-200/80">
            at most +{pool.maxPer} to one score · use the + and − under each
            score
          </span>
        </div>
      )}
      {speciesInfo && !fixedApplied && fixedText && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-ink-300">
          <span>
            {speciesInfo.name} gives {fixedText}. These scores do not include it
            yet.
          </span>
          <button
            type="button"
            onClick={applyAsi}
            className="rounded border border-ember-500/50 px-2 py-0.5 text-ember-200 hover:bg-ember-500/15"
          >
            Add to scores
          </button>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {ABILITIES.map((a) => {
          const chosen = sheet.asiChosen[a] ?? 0;
          const fixed =
            fixedApplied && speciesInfo ? (speciesInfo.asi[a] ?? 0) : 0;
          return (
            <div
              key={a}
              className="flex flex-col items-center rounded-md border border-ink-800 bg-ink-900 px-2 py-2"
            >
              <span className="text-[10px] font-semibold tracking-wider text-ink-500 uppercase">
                {a}
              </span>
              <span className="font-serif text-2xl font-semibold text-ink-100">
                {signed(modifier(sheet.abilities[a]))}
              </span>
              <input
                type="number"
                min={1}
                max={30}
                value={sheet.abilities[a]}
                onChange={(e) =>
                  update((s) => ({
                    ...s,
                    abilities: {
                      ...s.abilities,
                      [a]: Math.max(
                        1,
                        Math.min(30, Number(e.target.value) || 10),
                      ),
                    },
                  }))
                }
                aria-label={`${ABILITY_NAMES[a]} score`}
                className="mt-1 w-14 rounded border border-ink-700 bg-ink-850 px-1 py-0.5 text-center text-xs text-ink-200 outline-none focus:border-ember-500"
              />
              {(fixed > 0 || chosen > 0) && (
                <span className="mt-1 text-[10px] text-ember-300">
                  {fixed > 0 ? `+${fixed} species` : ""}
                  {fixed > 0 && chosen > 0 ? " · " : ""}
                  {chosen > 0 ? `+${chosen} chosen` : ""}
                </span>
              )}
              {pool && (
                <div className="mt-1 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => adjustChoice(a, -1)}
                    disabled={chosen <= 0}
                    aria-label={`Remove a bonus point from ${ABILITY_NAMES[a]}`}
                    className="h-5 w-5 rounded border border-ink-700 text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-30"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-xs text-ember-200">
                    {chosen > 0 ? `+${chosen}` : "0"}
                  </span>
                  <button
                    type="button"
                    onClick={() => adjustChoice(a, 1)}
                    disabled={choiceLeft <= 0 || chosen >= pool.maxPer}
                    aria-label={`Add a bonus point to ${ABILITY_NAMES[a]}`}
                    className="h-5 w-5 rounded border border-ink-700 text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-30"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Combat */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Num
          label="AC"
          value={sheet.ac}
          onChange={(v) => update((s) => ({ ...s, ac: v }))}
        />
        <div className={LABEL}>
          Hit points
          <div className="mt-1 flex items-center gap-1">
            <input
              type="number"
              min={0}
              value={sheet.hp.current ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  hp: { ...s.hp, current: number(e.target.value) },
                }))
              }
              placeholder="now"
              aria-label="Current hit points"
              className={`w-16 ${FIELD}`}
            />
            <span className="text-ink-500">/</span>
            <input
              type="number"
              min={0}
              value={sheet.hp.max ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  hp: { ...s.hp, max: number(e.target.value) },
                }))
              }
              placeholder="max"
              aria-label="Maximum hit points"
              className={`w-16 ${FIELD}`}
            />
            <input
              type="number"
              min={0}
              value={sheet.hp.temp ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  hp: { ...s.hp, temp: number(e.target.value) },
                }))
              }
              placeholder="temp"
              aria-label="Temporary hit points"
              className={`ml-1 w-16 ${FIELD}`}
            />
          </div>
        </div>
        <Text
          label="Speed"
          value={sheet.speed}
          onChange={(v) => update((s) => ({ ...s, speed: v }))}
          width="w-24"
          placeholder="30 ft."
        />
        <Derived
          label="Initiative"
          value={signed(modifier(sheet.abilities.dex))}
        />
        <Derived label="Proficiency" value={signed(pb)} />
        <Derived label="Hit die" value={hitDie ? `d${hitDie}` : "—"} />
        <Derived
          label="Passive Perception"
          value={String(passivePerception(sheet))}
        />
      </div>

      {/* Saves and skills */}
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <div>
          <div className={LABEL}>Saving throws</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ABILITIES.map((a) => (
              <Chip
                key={a}
                active={sheet.saves.includes(a)}
                onClick={() =>
                  update((s) => ({ ...s, saves: toggle(s.saves, a) }))
                }
                title={`${ABILITY_NAMES[a]} saving throw`}
              >
                {a.toUpperCase()} {signed(saveBonus(sheet, a))}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div className={LABEL}>
            Skills
            <span className="ml-2 text-ink-600">
              click for proficiency, click again for expertise · dot marks a
              class skill choice
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {SKILLS.map((sk) => {
              const expert = sheet.expertise.includes(sk.id);
              const prof = expert || sheet.skills.includes(sk.id);
              return (
                <Chip
                  key={sk.id}
                  active={prof}
                  strong={expert}
                  onClick={() =>
                    update((s) => {
                      if (s.expertise.includes(sk.id)) {
                        return {
                          ...s,
                          expertise: s.expertise.filter((x) => x !== sk.id),
                          skills: s.skills.filter((x) => x !== sk.id),
                        };
                      }
                      if (s.skills.includes(sk.id)) {
                        return { ...s, expertise: [...s.expertise, sk.id] };
                      }
                      return { ...s, skills: [...s.skills, sk.id] };
                    })
                  }
                  title={`${sk.name} (${ABILITY_NAMES[sk.ability]})`}
                >
                  {classSkills.includes(sk.id) && (
                    <span className="mr-1 text-ember-400" aria-hidden="true">
                      •
                    </span>
                  )}
                  {sk.name} <span className="text-ink-500">{sk.ability}</span>{" "}
                  {signed(skillBonus(sheet, sk))}
                </Chip>
              );
            })}
          </div>
        </div>
      </div>

      {/* Senses and languages */}
      <div className="flex flex-wrap gap-4">
        <Text
          label="Senses"
          value={sheet.senses}
          onChange={(v) => update((s) => ({ ...s, senses: v }))}
          width="w-72"
          placeholder="Darkvision 60 ft."
        />
        <Text
          label="Languages"
          value={sheet.languages}
          onChange={(v) => update((s) => ({ ...s, languages: v }))}
          width="w-72"
          placeholder="Common, Elvish"
        />
      </div>

      <SheetExtras sheet={sheet} update={update} />
    </section>
  );
}

/**
 * Keeps the spellcasting ability and slot maximums in step with class,
 * subclass and level, until the GM edits a maximum by hand.
 */
function skillName(id: string): string {
  return SKILLS.find((s) => s.id === id)?.name ?? id;
}

/** What the chosen class, species and background give, in one glance. */
function Grants({ sheet }: { sheet: Sheet5e }) {
  const cls = classByName(sheet.class);
  const sp = speciesByName(sheet.species);
  const bg = backgroundByName(sheet.background);
  if (!cls && !sp && !bg) return null;

  const fixed = sp
    ? (Object.entries(sp.asi) as [Ability, number][])
        .map(([a, n]) => `${signed(n)} ${a.toUpperCase()}`)
        .join(", ")
    : "";

  return (
    <div className="space-y-1.5 rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-[11px] leading-relaxed text-ink-400">
      {cls && (
        <GrantRow label={cls.name}>
          Hit die d{cls.hitDie} · Saves{" "}
          {cls.saves.map((a) => a.toUpperCase()).join(" and ")} · Skills: choose{" "}
          {cls.skills.choose}
          {cls.skills.from.length > 0
            ? ` from ${cls.skills.from.map(skillName).join(", ")}`
            : " of any"}{" "}
          · Armour: {cls.armor} · Weapons: {cls.weapons}
        </GrantRow>
      )}
      {sp && (
        <GrantRow label={sp.name}>
          {fixed
            ? `Ability scores ${fixed}${sheet.asiFrom === sp.name ? " (applied)" : ""} · `
            : ""}
          {sp.asiChoice
            ? `${sp.asiChoice.points} bonus ${sp.asiChoice.points === 1 ? "point" : "points"} of your choice, at most +${sp.asiChoice.maxPer} per score · `
            : ""}
          Speed {sp.speed} ft. · {sp.size}
          {sp.darkvision ? ` · Darkvision ${sp.darkvision} ft.` : ""}
          {sp.skills?.length
            ? ` · Skills: ${sp.skills.map(skillName).join(", ")}`
            : ""}
          {sp.traits.length > 0 ? ` · Traits: ${sp.traits.join(", ")}` : ""} ·
          Languages: {sp.languages}
        </GrantRow>
      )}
      {bg && (
        <GrantRow label={bg.name}>
          Skills:{" "}
          {[
            ...bg.skills.map(skillName),
            ...(bg.choose
              ? [
                  `choose ${bg.choose.count} of ${bg.choose.from.map(skillName).join(", ")}`,
                ]
              : []),
          ].join(", ") || "none"}
          {bg.tools ? ` · Tools: ${bg.tools}` : ""}
          {bg.languages ? ` · Languages: ${bg.languages}` : ""}
        </GrantRow>
      )}
    </div>
  );
}

function GrantRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="font-semibold text-ink-200">{label}</span>
      <span className="mx-1.5 text-ink-600">·</span>
      {children}
    </div>
  );
}

/** A text field with suggestions: pick from the list or type anything. */
function Combo({
  label,
  value,
  onChange,
  options,
  width,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  width: string;
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <label className={LABEL}>
      {label}
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={`mt-1 block ${width} ${FIELD} placeholder:text-ink-600`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </label>
  );
}

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function Text({
  label,
  value,
  onChange,
  width,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  width: string;
  placeholder?: string;
}) {
  return (
    <label className={LABEL}>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 block ${width} ${FIELD} placeholder:text-ink-600`}
      />
    </label>
  );
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <label className={LABEL}>
      {label}
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === "" ? null : Math.round(Number(v)) || 0);
        }}
        className={`mt-1 block w-16 ${FIELD}`}
      />
    </label>
  );
}

function Derived({ label, value }: { label: string; value: string }) {
  return (
    <div className={LABEL}>
      {label}
      <div className="mt-1 rounded-md border border-ink-800 bg-ink-900/60 px-2 py-1 text-center font-serif text-base text-ink-100">
        {value}
      </div>
    </div>
  );
}

function Chip({
  active,
  strong,
  onClick,
  title,
  children,
}: {
  active: boolean;
  strong?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        strong
          ? "border-ember-400 bg-ember-500/30 text-ember-100"
          : active
            ? "border-ember-500/60 bg-ember-500/15 text-ember-200"
            : "border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-200"
      }`}
    >
      {children}
    </button>
  );
}

export type { Ability };
