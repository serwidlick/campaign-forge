import { useEffect, useId, useRef, useState } from "react";

import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  BACKGROUNDS,
  CLASSES,
  SPECIES,
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
      return {
        ...s,
        class: value,
        saves: next && savesUntouched ? [...next.saves] : s.saves,
        subclass: subclassStale ? "" : s.subclass,
      };
    });
  }

  /** Picking a species sets its walking speed unless one was typed by hand. */
  function setSpecies(value: string) {
    update((s) => {
      const prev = speciesByName(s.species);
      const next = speciesByName(value);
      const speedUntouched =
        s.speed === EMPTY_SHEET.speed ||
        (prev !== undefined && s.speed === `${prev.speed} ft.`);
      return {
        ...s,
        species: value,
        speed: next && speedUntouched ? `${next.speed} ft.` : s.speed,
      };
    });
  }

  const hitDie = classByName(sheet.class)?.hitDie;
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
          onChange={(v) => update((s) => ({ ...s, subclass: v }))}
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
              update((s) => ({
                ...s,
                level: Math.max(1, Math.min(20, Number(e.target.value) || 1)),
              }))
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
          onChange={(v) => update((s) => ({ ...s, background: v }))}
          options={BACKGROUNDS}
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

      {/* Abilities */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {ABILITIES.map((a) => (
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
          </div>
        ))}
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
              click for proficiency, click again for expertise
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
    </section>
  );
}

function sameSet<T>(a: T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
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
