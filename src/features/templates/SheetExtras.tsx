import { Plus, X } from "lucide-react";

import {
  ABILITIES,
  CONDITIONS,
  modifier,
  newId,
  proficiencyBonus,
  signed,
  spellAttackBonus,
  spellSaveDc,
  type Ability,
  type Sheet5e,
} from "./dnd5e-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";
const SMALL = `${FIELD} py-0.5 text-xs`;
const ICON_BTN =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-600 hover:bg-ink-800 hover:text-red-300";

type Update = (fn: (s: Sheet5e) => Sheet5e) => void;

/**
 * The rest of a player character's sheet, below the stats: what they fight
 * with, what they can do, what they cast, what they carry, who they are,
 * and how they are doing right now. Each part folds away.
 */
export function SheetExtras({
  sheet,
  update,
}: {
  sheet: Sheet5e;
  update: Update;
}) {
  return (
    <div className="space-y-3">
      <Attacks sheet={sheet} update={update} />
      <Features sheet={sheet} update={update} />
      <Spellcasting sheet={sheet} update={update} />
      <Inventory sheet={sheet} update={update} />
      <Personality sheet={sheet} update={update} />
      <Status sheet={sheet} update={update} />
    </div>
  );
}

function Section({
  title,
  count,
  right,
  open = true,
  children,
}: {
  title: string;
  count?: number;
  right?: React.ReactNode;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={open}
      className="rounded-lg border border-ink-800 bg-ink-900/60"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-semibold tracking-wider text-ink-500 uppercase select-none [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        {count !== undefined && count > 0 && (
          <span className="font-normal normal-case tracking-normal text-ink-600">
            {count}
          </span>
        )}
        <span className="flex-1" />
        {right}
      </summary>
      <div className="space-y-2 px-3 pb-3">{children}</div>
    </details>
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
    >
      <Plus size={12} /> {label}
    </button>
  );
}

// ---- Attacks ----------------------------------------------------------------

function Attacks({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const set = (id: string, patch: Partial<Sheet5e["attacks"][number]>) =>
    update((s) => ({
      ...s,
      attacks: s.attacks.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  return (
    <Section title="Attacks" count={sheet.attacks.length}>
      {sheet.attacks.length > 0 && (
        <div className="grid grid-cols-[1fr_4rem_8rem_1fr_auto] gap-x-2 gap-y-1 text-[10px] text-ink-500 uppercase">
          <span>Name</span>
          <span>To hit</span>
          <span>Damage</span>
          <span>Notes</span>
          <span />
        </div>
      )}
      {sheet.attacks.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[1fr_4rem_8rem_1fr_auto] items-center gap-x-2"
        >
          <input
            value={a.name}
            onChange={(e) => set(a.id, { name: e.target.value })}
            placeholder="Longsword"
            className={SMALL}
          />
          <input
            value={a.bonus}
            onChange={(e) => set(a.id, { bonus: e.target.value })}
            placeholder="+5"
            className={`${SMALL} text-center font-mono`}
          />
          <input
            value={a.damage}
            onChange={(e) => set(a.id, { damage: e.target.value })}
            placeholder="1d8+3 slashing"
            className={`${SMALL} font-mono`}
          />
          <input
            value={a.notes}
            onChange={(e) => set(a.id, { notes: e.target.value })}
            placeholder="Versatile (1d10)"
            className={SMALL}
          />
          <button
            type="button"
            onClick={() =>
              update((s) => ({
                ...s,
                attacks: s.attacks.filter((x) => x.id !== a.id),
              }))
            }
            aria-label={`Remove ${a.name || "attack"}`}
            className={ICON_BTN}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <AddButton
        label="Add attack"
        onClick={() =>
          update((s) => ({
            ...s,
            attacks: [
              ...s.attacks,
              { id: newId(), name: "", bonus: "", damage: "", notes: "" },
            ],
          }))
        }
      />
    </Section>
  );
}

// ---- Features and traits -----------------------------------------------------

function Features({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const set = (id: string, patch: Partial<Sheet5e["features"][number]>) =>
    update((s) => ({
      ...s,
      features: s.features.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
  return (
    <Section title="Features and traits" count={sheet.features.length}>
      {sheet.features.map((f) => (
        <div
          key={f.id}
          className="grid grid-cols-[12rem_8rem_1fr_auto] items-center gap-x-2"
        >
          <input
            value={f.name}
            onChange={(e) => set(f.id, { name: e.target.value })}
            placeholder="Second Wind"
            className={SMALL}
          />
          <input
            value={f.source}
            onChange={(e) => set(f.id, { source: e.target.value })}
            placeholder="Fighter 1"
            className={SMALL}
          />
          <input
            value={f.notes}
            onChange={(e) => set(f.id, { notes: e.target.value })}
            placeholder="Bonus action, 1d10 + level, once per short rest"
            className={SMALL}
          />
          <button
            type="button"
            onClick={() =>
              update((s) => ({
                ...s,
                features: s.features.filter((x) => x.id !== f.id),
              }))
            }
            aria-label={`Remove ${f.name || "feature"}`}
            className={ICON_BTN}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <AddButton
        label="Add feature"
        onClick={() =>
          update((s) => ({
            ...s,
            features: [
              ...s.features,
              { id: newId(), name: "", source: "", notes: "" },
            ],
          }))
        }
      />
    </Section>
  );
}

// ---- Spellcasting --------------------------------------------------------------

const SLOT_LEVELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function Spellcasting({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const sc = sheet.spellcasting;
  const ability = sc.ability || null;
  const pb = proficiencyBonus(sheet.level);
  const hasSlots = SLOT_LEVELS.some((l) => (sc.slots[l]?.max ?? 0) > 0);
  const spells = [...sc.spells].sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name),
  );
  const setSpell = (
    id: string,
    patch: Partial<Sheet5e["spellcasting"]["spells"][number]>,
  ) =>
    update((s) => ({
      ...s,
      spellcasting: {
        ...s.spellcasting,
        spells: s.spellcasting.spells.map((x) =>
          x.id === id ? { ...x, ...patch } : x,
        ),
      },
    }));

  return (
    <Section
      title="Spellcasting"
      count={sc.spells.length}
      open={ability !== null || sc.spells.length > 0}
      right={
        hasSlots ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              update((s) => ({
                ...s,
                spellcasting: {
                  ...s.spellcasting,
                  slots: Object.fromEntries(
                    Object.entries(s.spellcasting.slots).map(([l, r]) => [
                      l,
                      { ...r, used: 0 },
                    ]),
                  ),
                },
              }));
            }}
            className="rounded border border-ink-700 px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal text-ink-300 hover:bg-ink-800"
          >
            Long rest: restore slots
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-[11px] text-ink-400">
          Spellcasting ability
          <select
            value={sc.ability}
            onChange={(e) =>
              update((s) => ({
                ...s,
                spellcasting: {
                  ...s.spellcasting,
                  ability: e.target.value as Ability | "",
                },
              }))
            }
            className={`mt-1 block ${FIELD}`}
          >
            <option value="">None</option>
            {ABILITIES.map((a) => (
              <option key={a} value={a}>
                {a.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        {ability && (
          <>
            <Derived label="Spell save DC" value={String(spellSaveDc(sheet))} />
            <Derived
              label="Spell attack"
              value={signed(spellAttackBonus(sheet))}
            />
            <Derived
              label="Modifier"
              value={signed(modifier(sheet.abilities[ability]))}
            />
            <Derived label="Proficiency" value={signed(pb)} />
          </>
        )}
      </div>

      <div>
        <div className="mb-1 text-[11px] text-ink-400">
          Spell slots
          <span className="ml-2 text-ink-600">
            used / max · max follows class and level until you change it
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-9">
          {SLOT_LEVELS.map((l) => {
            const row = sc.slots[l] ?? { max: 0, used: 0 };
            return (
              <div
                key={l}
                className={`flex flex-col items-center rounded-md border px-1 py-1 ${
                  row.max > 0
                    ? "border-ink-700 bg-ink-900"
                    : "border-ink-800 bg-ink-900/40 opacity-60"
                }`}
              >
                <span className="text-[10px] text-ink-500">
                  {l}
                  {l === "1"
                    ? "st"
                    : l === "2"
                      ? "nd"
                      : l === "3"
                        ? "rd"
                        : "th"}
                </span>
                <div className="flex items-center gap-0.5">
                  <input
                    type="number"
                    min={0}
                    max={row.max}
                    value={row.used}
                    onChange={(e) =>
                      update((s) => ({
                        ...s,
                        spellcasting: {
                          ...s.spellcasting,
                          slots: {
                            ...s.spellcasting.slots,
                            [l]: {
                              ...row,
                              used: Math.max(
                                0,
                                Math.min(row.max, Number(e.target.value) || 0),
                              ),
                            },
                          },
                        },
                      }))
                    }
                    aria-label={`Level ${l} slots used`}
                    className="w-8 rounded border border-ink-700 bg-ink-850 px-0.5 text-center text-xs text-ink-200 outline-none focus:border-ember-500"
                  />
                  <span className="text-ink-600">/</span>
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={row.max}
                    onChange={(e) =>
                      update((s) => ({
                        ...s,
                        spellcasting: {
                          ...s.spellcasting,
                          slotsAuto: false,
                          slots: {
                            ...s.spellcasting.slots,
                            [l]: {
                              max: Math.max(0, Number(e.target.value) || 0),
                              used: Math.min(
                                row.used,
                                Math.max(0, Number(e.target.value) || 0),
                              ),
                            },
                          },
                        },
                      }))
                    }
                    aria-label={`Level ${l} slots`}
                    className="w-8 rounded border border-ink-700 bg-ink-850 px-0.5 text-center text-xs text-ink-200 outline-none focus:border-ember-500"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {spells.length > 0 && (
        <div className="grid grid-cols-[1fr_6rem_4rem_1fr_auto] gap-x-2 text-[10px] text-ink-500 uppercase">
          <span>Spell</span>
          <span>Level</span>
          <span>Prepared</span>
          <span>Notes</span>
          <span />
        </div>
      )}
      {spells.map((sp) => (
        <div
          key={sp.id}
          className="grid grid-cols-[1fr_6rem_4rem_1fr_auto] items-center gap-x-2"
        >
          <input
            value={sp.name}
            onChange={(e) => setSpell(sp.id, { name: e.target.value })}
            placeholder="Fireball"
            className={SMALL}
          />
          <select
            value={sp.level}
            onChange={(e) => setSpell(sp.id, { level: Number(e.target.value) })}
            className={SMALL}
          >
            <option value={0}>Cantrip</option>
            {SLOT_LEVELS.map((l) => (
              <option key={l} value={Number(l)}>
                Level {l}
              </option>
            ))}
          </select>
          <input
            type="checkbox"
            checked={sp.prepared}
            onChange={(e) => setSpell(sp.id, { prepared: e.target.checked })}
            aria-label={`${sp.name || "Spell"} prepared`}
            className="h-4 w-4 justify-self-center accent-ember-500"
          />
          <input
            value={sp.notes}
            onChange={(e) => setSpell(sp.id, { notes: e.target.value })}
            placeholder="8d6 fire, 20 ft radius, DEX save"
            className={SMALL}
          />
          <button
            type="button"
            onClick={() =>
              update((s) => ({
                ...s,
                spellcasting: {
                  ...s.spellcasting,
                  spells: s.spellcasting.spells.filter((x) => x.id !== sp.id),
                },
              }))
            }
            aria-label={`Remove ${sp.name || "spell"}`}
            className={ICON_BTN}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <AddButton
        label="Add spell"
        onClick={() =>
          update((s) => ({
            ...s,
            spellcasting: {
              ...s.spellcasting,
              spells: [
                ...s.spellcasting.spells,
                { id: newId(), name: "", level: 0, prepared: true, notes: "" },
              ],
            },
          }))
        }
      />
    </Section>
  );
}

// ---- Inventory and coin ----------------------------------------------------------

const COINS = ["pp", "gp", "ep", "sp", "cp"] as const;

function Inventory({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const set = (id: string, patch: Partial<Sheet5e["inventory"][number]>) =>
    update((s) => ({
      ...s,
      inventory: s.inventory.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
  const totalWeight = sheet.inventory.reduce((n, i) => {
    const w = parseFloat(i.weight);
    return Number.isFinite(w) ? n + w * (i.qty || 1) : n;
  }, 0);
  return (
    <Section
      title="Inventory and coin"
      count={sheet.inventory.length}
      right={
        totalWeight > 0 ? (
          <span className="font-normal normal-case tracking-normal text-ink-500">
            {Math.round(totalWeight * 10) / 10} lb
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        {COINS.map((c) => (
          <label key={c} className="text-[11px] text-ink-400 uppercase">
            {c}
            <input
              type="number"
              min={0}
              value={sheet.currency[c]}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  currency: {
                    ...s.currency,
                    [c]: Math.max(0, Math.round(Number(e.target.value)) || 0),
                  },
                }))
              }
              className={`mt-1 block w-20 ${FIELD} font-mono`}
            />
          </label>
        ))}
      </div>
      {sheet.inventory.length > 0 && (
        <div className="grid grid-cols-[1fr_4rem_5rem_1fr_auto] gap-x-2 text-[10px] text-ink-500 uppercase">
          <span>Item</span>
          <span>Qty</span>
          <span>Weight</span>
          <span>Notes</span>
          <span />
        </div>
      )}
      {sheet.inventory.map((i) => (
        <div
          key={i.id}
          className="grid grid-cols-[1fr_4rem_5rem_1fr_auto] items-center gap-x-2"
        >
          <input
            value={i.name}
            onChange={(e) => set(i.id, { name: e.target.value })}
            placeholder="Rope, 50 ft"
            className={SMALL}
          />
          <input
            type="number"
            min={0}
            value={i.qty}
            onChange={(e) =>
              set(i.id, {
                qty: Math.max(0, Math.round(Number(e.target.value)) || 0),
              })
            }
            className={`${SMALL} text-center`}
          />
          <input
            value={i.weight}
            onChange={(e) => set(i.id, { weight: e.target.value })}
            placeholder="10"
            className={`${SMALL} text-center font-mono`}
          />
          <input
            value={i.notes}
            onChange={(e) => set(i.id, { notes: e.target.value })}
            placeholder=""
            className={SMALL}
          />
          <button
            type="button"
            onClick={() =>
              update((s) => ({
                ...s,
                inventory: s.inventory.filter((x) => x.id !== i.id),
              }))
            }
            aria-label={`Remove ${i.name || "item"}`}
            className={ICON_BTN}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <AddButton
        label="Add item"
        onClick={() =>
          update((s) => ({
            ...s,
            inventory: [
              ...s.inventory,
              { id: newId(), name: "", qty: 1, weight: "", notes: "" },
            ],
          }))
        }
      />
    </Section>
  );
}

// ---- Personality ---------------------------------------------------------------

function Personality({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const fields: [keyof Sheet5e["personality"], string, string][] = [
    ["traits", "Personality traits", "Two things anyone notices quickly."],
    ["ideals", "Ideals", "What they believe in."],
    ["bonds", "Bonds", "Who or what they would not abandon."],
    ["flaws", "Flaws", "What gets them into trouble."],
  ];
  return (
    <Section
      title="Personality"
      open={Object.values(sheet.personality).some((v) => v.trim() !== "")}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label, hint]) => (
          <label key={key} className="text-[11px] text-ink-400">
            {label}
            <textarea
              value={sheet.personality[key]}
              onChange={(e) =>
                update((s) => ({
                  ...s,
                  personality: { ...s.personality, [key]: e.target.value },
                }))
              }
              placeholder={hint}
              rows={2}
              className={`mt-1 block w-full resize-y ${FIELD}`}
            />
          </label>
        ))}
      </div>
    </Section>
  );
}

// ---- Status ---------------------------------------------------------------------

function Status({ sheet, update }: { sheet: Sheet5e; update: Update }) {
  const st = sheet.status;
  const setStatus = (patch: Partial<Sheet5e["status"]>) =>
    update((s) => ({ ...s, status: { ...s.status, ...patch } }));
  const pips = (kind: "successes" | "failures") => (
    <div className="flex items-center gap-1">
      {[1, 2, 3].map((n) => {
        const on = st.deathSaves[kind] >= n;
        return (
          <button
            key={n}
            type="button"
            onClick={() =>
              setStatus({
                deathSaves: {
                  ...st.deathSaves,
                  [kind]: on && st.deathSaves[kind] === n ? n - 1 : n,
                },
              })
            }
            aria-label={`${kind} ${n}`}
            aria-pressed={on}
            className={`h-4 w-4 rounded-full border ${
              on
                ? kind === "successes"
                  ? "border-green-400 bg-green-500/70"
                  : "border-red-400 bg-red-500/70"
                : "border-ink-600"
            }`}
          />
        );
      })}
    </div>
  );
  return (
    <Section title="Right now">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            checked={st.inspiration}
            onChange={(e) => setStatus({ inspiration: e.target.checked })}
            className="h-4 w-4 accent-ember-500"
          />
          Inspiration
        </label>
        <div className="text-[11px] text-ink-400">
          Death saves
          <div className="mt-1 flex items-center gap-3 text-xs">
            <span className="flex items-center gap-2">
              <span className="text-ink-500">Successes</span>
              {pips("successes")}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-ink-500">Failures</span>
              {pips("failures")}
            </span>
            {(st.deathSaves.successes > 0 || st.deathSaves.failures > 0) && (
              <button
                type="button"
                onClick={() =>
                  setStatus({ deathSaves: { successes: 0, failures: 0 } })
                }
                className="text-ink-500 hover:text-ink-200"
              >
                reset
              </button>
            )}
          </div>
        </div>
        <label className="text-[11px] text-ink-400">
          Hit dice used
          <div className="mt-1 flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={sheet.level}
              value={st.hitDiceUsed}
              onChange={(e) =>
                setStatus({
                  hitDiceUsed: Math.max(
                    0,
                    Math.min(sheet.level, Number(e.target.value) || 0),
                  ),
                })
              }
              className={`w-14 ${FIELD}`}
            />
            <span className="text-xs text-ink-500">of {sheet.level}</span>
          </div>
        </label>
        <label className="text-[11px] text-ink-400">
          Exhaustion
          <select
            value={st.exhaustion}
            onChange={(e) => setStatus({ exhaustion: Number(e.target.value) })}
            className={`mt-1 block ${FIELD}`}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "None" : `Level ${n}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <div className="text-[11px] text-ink-400">Conditions</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CONDITIONS.map((c) => {
            const on = st.conditions.includes(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() =>
                  setStatus({
                    conditions: on
                      ? st.conditions.filter((x) => x !== c)
                      : [...st.conditions, c],
                  })
                }
                aria-pressed={on}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  on
                    ? "border-red-400/70 bg-red-500/15 text-red-200"
                    : "border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-200"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function Derived({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-[11px] text-ink-400">
      {label}
      <div className="mt-1 rounded-md border border-ink-800 bg-ink-900/60 px-2 py-1 text-center font-serif text-base text-ink-100">
        {value}
      </div>
    </div>
  );
}
