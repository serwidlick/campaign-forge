import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  ABILITIES,
  ABILITY_NAMES,
  ALIGNMENTS,
  modifier,
  newId,
  signed,
} from "./dnd5e-model";
import {
  CREATURE_TYPES,
  CRS,
  EMPTY_STATBLOCK,
  SIZES,
  crInfo,
  readStatBlock5e,
  type NamedEntry,
  type StatBlock5e,
} from "./dnd5e-statblock";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";
const LABEL = "text-[11px] text-ink-400";
const AUTOSAVE_MS = 400;

type ListKey =
  "traits" | "actions" | "bonusActions" | "reactions" | "legendary";

const LISTS: { key: ListKey; title: string; hint: string }[] = [
  { key: "traits", title: "Traits", hint: "Pack Tactics, Keen Smell…" },
  { key: "actions", title: "Actions", hint: "Multiattack, Bite, Claw…" },
  { key: "bonusActions", title: "Bonus actions", hint: "" },
  { key: "reactions", title: "Reactions", hint: "Parry…" },
  { key: "legendary", title: "Legendary actions", hint: "" },
];

/** A D&D 5e stat block above a creature's body. Saves on a short debounce. */
export function StatBlock5e({ element }: { element: Element }) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const [sb, setSb] = useState<StatBlock5e>(
    () => readStatBlock5e(element.statblock) ?? EMPTY_STATBLOCK,
  );
  // Kept outside React state so the unmount flush can still save it; a state
  // update during unmount is ignored (see CharacterSheet5e).
  const latest = useRef(sb);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  function update(fn: (s: StatBlock5e) => StatBlock5e) {
    latest.current = fn(latest.current);
    setSb(latest.current);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_MS);
  }
  function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    void saveElement(element.id, { statblock: latest.current });
  }
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  const cr = crInfo(sb.cr);
  return (
    <section className="space-y-4 rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      {/* Identity */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className={LABEL}>
          Size
          <select
            value={sb.size}
            onChange={(e) => update((s) => ({ ...s, size: e.target.value }))}
            className={`mt-1 block ${FIELD}`}
          >
            {SIZES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <Combo
          label="Type"
          value={sb.type}
          onChange={(v) => update((s) => ({ ...s, type: v }))}
          options={CREATURE_TYPES}
          width="w-40"
          placeholder="Humanoid (goblinoid)"
        />
        <label className={LABEL}>
          Alignment
          <select
            value={sb.alignment}
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
        <Combo
          label="Challenge"
          value={sb.cr}
          onChange={(v) => update((s) => ({ ...s, cr: v }))}
          options={CRS}
          width="w-20"
          placeholder="1/2"
        />
        {cr && (
          <>
            <Derived label="XP" value={cr.xp.toLocaleString()} />
            <Derived label="Proficiency" value={signed(cr.pb)} />
          </>
        )}
      </div>

      {/* Defences and speed */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className={LABEL}>
          Armour class
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              value={sb.ac ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  ac:
                    e.target.value === "" ? null : Number(e.target.value) || 0,
                }))
              }
              className={`w-16 ${FIELD}`}
            />
            <input
              value={sb.acNote}
              onChange={(e) =>
                update((s) => ({ ...s, acNote: e.target.value }))
              }
              placeholder="natural armour"
              className={`w-36 ${FIELD}`}
            />
          </div>
        </label>
        <label className={LABEL}>
          Hit points
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              value={sb.hp ?? ""}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  hp:
                    e.target.value === "" ? null : Number(e.target.value) || 0,
                }))
              }
              className={`w-16 ${FIELD}`}
            />
            <input
              value={sb.hpFormula}
              onChange={(e) =>
                update((s) => ({ ...s, hpFormula: e.target.value }))
              }
              placeholder="7d8 + 14"
              className={`w-28 font-mono ${FIELD}`}
            />
          </div>
        </label>
        <Text
          label="Speed"
          value={sb.speed}
          onChange={(v) => update((s) => ({ ...s, speed: v }))}
          width="w-48"
          placeholder="30 ft., fly 60 ft."
        />
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
              {signed(modifier(sb.abilities[a]))}
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={sb.abilities[a]}
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

      {/* Lines */}
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Text
          label="Saving throws"
          value={sb.saves}
          onChange={(v) => update((s) => ({ ...s, saves: v }))}
          width="w-full"
          placeholder="Dex +5, Con +6"
        />
        <Text
          label="Skills"
          value={sb.skills}
          onChange={(v) => update((s) => ({ ...s, skills: v }))}
          width="w-full"
          placeholder="Perception +4, Stealth +6"
        />
        <Text
          label="Damage vulnerabilities"
          value={sb.vulnerabilities}
          onChange={(v) => update((s) => ({ ...s, vulnerabilities: v }))}
          width="w-full"
        />
        <Text
          label="Damage resistances"
          value={sb.resistances}
          onChange={(v) => update((s) => ({ ...s, resistances: v }))}
          width="w-full"
        />
        <Text
          label="Damage immunities"
          value={sb.immunities}
          onChange={(v) => update((s) => ({ ...s, immunities: v }))}
          width="w-full"
        />
        <Text
          label="Condition immunities"
          value={sb.conditionImmunities}
          onChange={(v) => update((s) => ({ ...s, conditionImmunities: v }))}
          width="w-full"
        />
        <Text
          label="Senses"
          value={sb.senses}
          onChange={(v) => update((s) => ({ ...s, senses: v }))}
          width="w-full"
          placeholder="darkvision 60 ft., passive Perception 14"
        />
        <Text
          label="Languages"
          value={sb.languages}
          onChange={(v) => update((s) => ({ ...s, languages: v }))}
          width="w-full"
          placeholder="Common, Goblin"
        />
      </div>

      {/* Lists */}
      {LISTS.map(({ key, title, hint }) => (
        <EntryList
          key={key}
          title={title}
          hint={hint}
          entries={sb[key]}
          onChange={(entries) => update((s) => ({ ...s, [key]: entries }))}
        />
      ))}
    </section>
  );
}

function EntryList({
  title,
  hint,
  entries,
  onChange,
}: {
  title: string;
  hint: string;
  entries: NamedEntry[];
  onChange: (entries: NamedEntry[]) => void;
}) {
  const set = (id: string, patch: Partial<NamedEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-ink-500 uppercase">
          {title}
        </span>
        <button
          type="button"
          onClick={() =>
            onChange([...entries, { id: newId(), name: "", text: "" }])
          }
          className="inline-flex items-center gap-1 rounded border border-ink-700 px-1.5 py-0.5 text-[11px] text-ink-300 hover:bg-ink-800"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      <div className="space-y-1.5">
        {entries.map((e) => (
          <div key={e.id} className="flex items-start gap-2">
            <input
              value={e.name}
              onChange={(ev) => set(e.id, { name: ev.target.value })}
              placeholder={hint || "Name"}
              className={`w-44 shrink-0 ${FIELD} font-semibold italic`}
            />
            <textarea
              value={e.text}
              onChange={(ev) => set(e.id, { text: ev.target.value })}
              placeholder="Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage."
              rows={2}
              className={`min-w-0 flex-1 resize-y ${FIELD}`}
            />
            <button
              type="button"
              onClick={() => onChange(entries.filter((x) => x.id !== e.id))}
              aria-label={`Remove ${e.name || "entry"}`}
              className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-600 hover:bg-ink-800 hover:text-red-300"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
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
        className={`mt-1 block ${width} ${FIELD}`}
      />
    </label>
  );
}

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
        className={`mt-1 block ${width} ${FIELD}`}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
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
