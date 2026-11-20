import { Check, Dices, Minus, Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/Button";

import {
  POINT_BUY_BUDGET,
  POINT_BUY_MAX,
  POINT_BUY_MIN,
  SCORE_METHODS,
  STANDARD_ARRAY,
  allSkills,
  baseScores,
  buildLevel,
  buildProblems,
  buildSheet,
  choosesSubclass,
  classSkillChoice,
  computedHp,
  emptyBuild,
  expertiseFor,
  finalAbilities,
  grantedSkills,
  hitDiceText,
  placesScores,
  pointCost,
  pointsSpent,
  rollScores,
  startingClass,
  subclassLevel,
  type Build5e,
  type ScoreMethod,
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
  SKILLS,
  classSummary,
  modifier,
  proficiencyBonus,
  sheetSummary,
  signed,
  type Ability,
  type ClassLevel,
  type Sheet5e,
} from "./dnd5e-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";
const LABEL = "text-[11px] text-ink-400";

const STEPS = [
  "Species",
  "Class",
  "Background",
  "Abilities",
  "Skills",
  "Details",
  "Review",
] as const;
type Step = (typeof STEPS)[number];

/**
 * A guided character builder for D&D 5e: one pick per step, with everything
 * each pick grants applied for you, and a sheet written out at the end.
 * Nothing touches disk until "Create character".
 */
export function Charactermancer5e({
  initialName,
  onCancel,
  onCreate,
}: {
  initialName: string;
  onCancel: () => void;
  onCreate: (name: string, sheet: Sheet5e) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("Species");
  const [build, setBuild] = useState<Build5e>(() => emptyBuild(initialName));
  const [busy, setBusy] = useState(false);
  const problems = useMemo(() => buildProblems(build), [build]);
  const index = STEPS.indexOf(step);

  function patch(fn: (b: Build5e) => Build5e) {
    setBuild(fn);
  }

  async function finish() {
    if (problems.length > 0 || busy) return;
    setBusy(true);
    try {
      await onCreate(build.name.trim(), buildSheet(build));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Charactermancer"
    >
      <div className="flex h-[min(760px,94vh)] w-[min(1000px,96vw)] flex-col overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-ink-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-lg text-ink-100">Charactermancer</h2>
            <p className="truncate text-xs text-ink-400">
              {build.name.trim() || "Unnamed"}
              {build.species || classSummary(build.classes)
                ? ` · ${[build.species, classSummary(build.classes)].filter(Boolean).join(" ")}`
                : ""}
              {` · Level ${buildLevel(build)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Close without creating"
            className="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          >
            <X size={16} />
          </button>
        </div>

        {/* Step strip */}
        <ol className="flex flex-wrap gap-1 border-b border-ink-800 px-4 py-2">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => setStep(s)}
                aria-current={s === step ? "step" : undefined}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                  s === step
                    ? "border-ember-500 bg-ember-500/20 text-ember-100"
                    : i < index
                      ? "border-ink-600 text-ink-200 hover:border-ink-400"
                      : "border-ink-800 text-ink-400 hover:border-ink-600 hover:text-ink-200"
                }`}
              >
                {i + 1}. {s}
              </button>
            </li>
          ))}
        </ol>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {step === "Species" && <SpeciesStep build={build} patch={patch} />}
          {step === "Class" && <ClassStep build={build} patch={patch} />}
          {step === "Background" && (
            <BackgroundStep build={build} patch={patch} />
          )}
          {step === "Abilities" && (
            <AbilitiesStep build={build} patch={patch} />
          )}
          {step === "Skills" && <SkillsStep build={build} patch={patch} />}
          {step === "Details" && <DetailsStep build={build} patch={patch} />}
          {step === "Review" && (
            <ReviewStep build={build} problems={problems} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-ink-800 px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <span className="flex-1 truncate text-xs text-ink-400">
            {problems.length === 0
              ? "Everything is in place."
              : `${problems.length} ${problems.length === 1 ? "thing" : "things"} still to choose`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={index === 0}
            onClick={() => setStep(STEPS[index - 1] ?? step)}
          >
            Back
          </Button>
          {step === "Review" ? (
            <Button
              size="sm"
              disabled={problems.length > 0 || busy}
              onClick={() => void finish()}
            >
              <Check size={14} /> Create character
            </Button>
          ) : (
            <Button size="sm" onClick={() => setStep(STEPS[index + 1] ?? step)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

type StepProps = {
  build: Build5e;
  patch: (fn: (b: Build5e) => Build5e) => void;
};

// ---- Species ---------------------------------------------------------------

function SpeciesStep({ build, patch }: StepProps) {
  const [query, setQuery] = useState("");
  const visible = SPECIES.filter((s) =>
    s.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const current = speciesByName(build.species);
  return (
    <div className="space-y-3">
      <StepIntro
        title="Choose a species"
        blurb="Species sets speed, size, senses, languages and traits, and often ability bonuses. Fixed bonuses are added for you; flexible ones you place on the Abilities step."
      />
      <PickHeader
        query={query}
        onQuery={setQuery}
        custom={build.species}
        isKnown={current !== undefined}
        onCustom={(v) => patch((b) => ({ ...b, species: v, asiChosen: {} }))}
        placeholder="Search species"
        customPlaceholder="Or type a homebrew species"
      />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {visible.map((s) => (
          <Card
            key={s.name}
            selected={current?.name === s.name}
            onClick={() =>
              patch((b) => ({ ...b, species: s.name, asiChosen: {} }))
            }
            title={s.name}
          >
            <Line>
              {s.size} · {s.speed} ft.
              {s.darkvision ? ` · Darkvision ${s.darkvision} ft.` : ""}
            </Line>
            <Line>{asiText(s.asi, s.asiChoice)}</Line>
            <Line muted>{s.traits.join(", ")}</Line>
          </Card>
        ))}
        {visible.length === 0 && <Empty>No species match.</Empty>}
      </div>
    </div>
  );
}

function asiText(
  asi: Record<string, number | undefined>,
  choice?: { points: number; maxPer: number },
): string {
  const fixed = (Object.entries(asi) as [string, number][])
    .map(([k, v]) => `${signed(v)} ${k.toUpperCase()}`)
    .join(", ");
  const flex = choice
    ? `${choice.points} bonus ${choice.points === 1 ? "point" : "points"} to place (max +${choice.maxPer} each)`
    : "";
  return [fixed, flex].filter(Boolean).join(" · ") || "No ability bonuses";
}

// ---- Class -----------------------------------------------------------------

function ClassStep({ build, patch }: StepProps) {
  const first = startingClass(build);
  const current = classByName(first.name);
  const total = buildLevel(build);
  const multiclass = build.classes.length > 1;

  /** Changes one class row; skill and expertise picks start over. */
  function patchClass(
    index: number,
    fn: (c: ClassLevel) => ClassLevel,
    resetSkills = true,
  ) {
    patch((b) => ({
      ...b,
      classes: b.classes.map((c, i) => (i === index ? fn(c) : c)),
      ...(resetSkills ? { classSkills: [], expertise: [] } : { expertise: [] }),
    }));
  }

  function setLevel(index: number, value: number) {
    patch((b) => {
      const others = b.classes.reduce(
        (n, c, i) => (i === index ? n : n + c.level),
        0,
      );
      const level = Math.max(1, Math.min(Math.max(1, 20 - others), value || 1));
      return {
        ...b,
        classes: b.classes.map((c, i) => (i === index ? { ...c, level } : c)),
        expertise: [],
      };
    });
  }

  return (
    <div className="space-y-3">
      <StepIntro
        title="Choose a class and level"
        blurb="Class gives the hit die, saving throws, armour and weapon training, a choice of skills, and spellcasting where the class has it. A character can start out multiclassed: add the other classes below."
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          {multiclass ? `${current?.name ?? "Starting class"} level` : "Level"}
          <input
            type="number"
            min={1}
            max={20}
            value={first.level}
            onChange={(e) => setLevel(0, Number(e.target.value))}
            className={`mt-1 block w-20 ${FIELD}`}
          />
        </label>
        <label className={`${LABEL} flex-1`}>
          Homebrew class
          <input
            value={current ? "" : first.name}
            onChange={(e) =>
              patchClass(0, (c) => ({
                ...c,
                name: e.target.value,
                subclass: "",
              }))
            }
            placeholder="Or type a class of your own"
            className={`mt-1 block w-full ${FIELD} placeholder:text-ink-600`}
          />
        </label>
        {multiclass && (
          <span className="pb-1.5 text-xs text-ink-300">
            {classSummary(build.classes)} · character level {total} ·
            proficiency {signed(proficiencyBonus(total))}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {CLASSES.map((c) => (
          <Card
            key={c.name}
            selected={current?.name === c.name}
            onClick={() =>
              patchClass(0, (row) => ({ ...row, name: c.name, subclass: "" }))
            }
            title={c.name}
          >
            <Line>
              d{c.hitDie} hit die · Saves {c.saves.map(abbr).join(", ")}
            </Line>
            <Line>
              {c.skills.choose} {c.skills.choose === 1 ? "skill" : "skills"}
              {c.skills.from.length === 0 ? " from any" : ""}
              {c.spellcasting
                ? ` · Casts with ${abbr(c.spellcasting.ability)}`
                : ""}
            </Line>
            <Line muted>
              Armour: {c.armor || "none"} · Weapons: {c.weapons}
            </Line>
          </Card>
        ))}
      </div>
      <SubclassPicker
        row={first}
        onPick={(sub) => patchClass(0, (c) => ({ ...c, subclass: sub }), false)}
      />

      <div className="space-y-3 rounded-md border border-ink-800 bg-ink-900/60 p-3">
        <div>
          <p className="text-xs font-semibold text-ink-200">Multiclass</p>
          <p className="text-xs text-ink-400">
            Other classes the character already has levels in. Only the starting
            class above gives saving throws and its full choice of skills; a
            bard, ranger or rogue taken later adds one skill. Each class chooses
            its subclass by its own level; proficiency follows the character
            level.
          </p>
        </div>
        {build.classes.slice(1).map((row, i) => {
          const index = i + 1;
          const cls = classByName(row.name);
          return (
            <div
              key={index}
              className="space-y-2 rounded-md border border-ink-800 bg-ink-900 p-2.5"
            >
              <div className="flex flex-wrap items-end gap-3">
                <ClassNameInput
                  label={`Class ${index + 1}`}
                  value={row.name}
                  onChange={(v) =>
                    patchClass(index, (c) => ({
                      ...c,
                      name: v,
                      subclass: classByName(v)?.subclasses.includes(c.subclass)
                        ? c.subclass
                        : "",
                    }))
                  }
                />
                <label className={LABEL}>
                  {cls ? `${cls.name} level` : "Level"}
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={row.level}
                    onChange={(e) => setLevel(index, Number(e.target.value))}
                    className={`mt-1 block w-20 ${FIELD}`}
                  />
                </label>
                {cls && (
                  <span className="pb-1.5 text-xs text-ink-400">
                    d{cls.hitDie} hit die
                    {cls.spellcasting
                      ? ` · casts with ${abbr(cls.spellcasting.ability)}`
                      : ""}
                  </span>
                )}
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    patch((b) => ({
                      ...b,
                      classes: b.classes.filter((_, j) => j !== index),
                      classSkills: [],
                      expertise: [],
                    }))
                  }
                >
                  <X size={14} /> Remove
                </Button>
              </div>
              <SubclassPicker
                row={row}
                onPick={(sub) =>
                  patchClass(index, (c) => ({ ...c, subclass: sub }), false)
                }
              />
            </div>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          disabled={total >= 20}
          onClick={() =>
            patch((b) => ({
              ...b,
              classes: [...b.classes, { name: "", subclass: "", level: 1 }],
              classSkills: [],
              expertise: [],
            }))
          }
        >
          <Plus size={14} /> Add a class
        </Button>
      </div>
    </div>
  );
}

/** A class name: pick from the list, or type a homebrew one. */
function ClassNameInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const listId = useId();
  return (
    <label className={LABEL}>
      {label}
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Rogue"
        autoComplete="off"
        className={`mt-1 block w-40 ${FIELD} placeholder:text-ink-600`}
      />
      <datalist id={listId}>
        {CLASSES.map((c) => (
          <option key={c.name} value={c.name} />
        ))}
      </datalist>
    </label>
  );
}

/** The subclass chips for one class, or a note on when it gets to choose. */
function SubclassPicker({
  row,
  onPick,
}: {
  row: ClassLevel;
  onPick: (subclass: string) => void;
}) {
  const cls = classByName(row.name);
  if (!cls || cls.subclasses.length === 0) return null;
  const subAt = subclassLevel(row.name);
  const ready = choosesSubclass(row);
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900/60 p-3">
      <p className="text-xs text-ink-300">
        {ready
          ? `Subclass (${cls.name}s choose at level ${subAt})`
          : `${cls.name}s choose a subclass at level ${subAt}; this one is ${cls.name} ${row.level}, so none yet.`}
      </p>
      {ready && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {cls.subclasses.map((sub) => (
            <Chip
              key={sub}
              active={row.subclass === sub}
              onClick={() => onPick(sub)}
            >
              {sub}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Background ------------------------------------------------------------

function BackgroundStep({ build, patch }: StepProps) {
  const [query, setQuery] = useState("");
  const visible = BACKGROUNDS.filter((bg) =>
    bg.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const current = backgroundByName(build.background);
  return (
    <div className="space-y-3">
      <StepIntro
        title="Choose a background"
        blurb="Background adds skill proficiencies, and sometimes tools and languages. Where it offers a choice, you make it on the Skills step."
      />
      <PickHeader
        query={query}
        onQuery={setQuery}
        custom={build.background}
        isKnown={current !== undefined}
        onCustom={(v) =>
          patch((b) => ({ ...b, background: v, backgroundSkills: [] }))
        }
        placeholder="Search backgrounds"
        customPlaceholder="Or type a homebrew background"
      />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {visible.map((bg) => (
          <Card
            key={bg.name}
            selected={current?.name === bg.name}
            onClick={() =>
              patch((b) => ({
                ...b,
                background: bg.name,
                backgroundSkills: [],
              }))
            }
            title={bg.name}
          >
            <Line>
              {bg.skills.map(skillName).join(", ")}
              {bg.choose
                ? ` + ${bg.choose.count} of ${bg.choose.from.map(skillName).join(", ")}`
                : ""}
            </Line>
            <Line muted>
              {[
                bg.tools ? `Tools: ${bg.tools}` : "",
                bg.languages ? `Languages: ${bg.languages}` : "",
              ]
                .filter(Boolean)
                .join(" · ") || "No tools or languages"}
            </Line>
          </Card>
        ))}
        {visible.length === 0 && <Empty>No backgrounds match.</Empty>}
      </div>
    </div>
  );
}

// ---- Abilities -------------------------------------------------------------

function AbilitiesStep({ build, patch }: StepProps) {
  const species = speciesByName(build.species);
  const pool = species?.asiChoice;
  const base = baseScores(build);
  const final = finalAbilities(build);
  const spent = pointsSpent(build.base);
  const placed = Object.values(build.asiChosen).reduce(
    (n, v) => n + (v ?? 0),
    0,
  );
  const left = pool ? Math.max(0, pool.points - placed) : 0;

  function setMethod(method: ScoreMethod) {
    patch((b) => {
      const next: Build5e = { ...b, method, assign: {} };
      if (method === "array") next.pool = [...STANDARD_ARRAY];
      if (method === "roll") next.pool = rollScores();
      if (method === "pointbuy") {
        next.base = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };
      }
      return next;
    });
  }

  function assign(a: Ability, idx: number | null) {
    patch((b) => {
      const next = { ...b.assign };
      // The same pool entry cannot sit in two places.
      for (const other of ABILITIES)
        if (next[other] === idx) delete next[other];
      if (idx === null) delete next[a];
      else next[a] = idx;
      return { ...b, assign: next };
    });
  }

  function bump(a: Ability, delta: 1 | -1) {
    patch((b) => {
      const v = b.base[a] + delta;
      if (b.method === "pointbuy") {
        if (v < POINT_BUY_MIN || v > POINT_BUY_MAX) return b;
        const cost = pointsSpent({ ...b.base, [a]: v });
        if (delta > 0 && cost > POINT_BUY_BUDGET) return b;
      } else if (v < 1 || v > 30) {
        return b;
      }
      return { ...b, base: { ...b.base, [a]: v } };
    });
  }

  function place(a: Ability, delta: 1 | -1) {
    patch((b) => {
      if (!pool) return b;
      const current = b.asiChosen[a] ?? 0;
      const used = Object.values(b.asiChosen).reduce((n, v) => n + (v ?? 0), 0);
      if (delta > 0 && (used >= pool.points || current >= pool.maxPer)) {
        return b;
      }
      if (delta < 0 && current <= 0) return b;
      const asiChosen = { ...b.asiChosen, [a]: current + delta };
      if (asiChosen[a] === 0) delete asiChosen[a];
      return { ...b, asiChosen };
    });
  }

  const taken = new Set(Object.values(build.assign));

  return (
    <div className="space-y-3">
      <StepIntro
        title="Set ability scores"
        blurb="Pick how the six scores are generated, then place them. Species bonuses are shown alongside and added to the final score."
      />
      <div className="flex flex-wrap gap-1.5">
        {SCORE_METHODS.map((m) => (
          <Chip
            key={m.id}
            active={build.method === m.id}
            onClick={() => setMethod(m.id)}
            title={m.blurb}
          >
            {m.label}
          </Chip>
        ))}
      </div>
      <p className="text-xs text-ink-400">
        {SCORE_METHODS.find((m) => m.id === build.method)?.blurb}
      </p>

      {build.method === "roll" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-300">
          <Button size="sm" variant="ghost" onClick={() => setMethod("roll")}>
            <Dices size={14} /> Roll again
          </Button>
          <span>Rolled: {build.pool.join(", ")}</span>
        </div>
      )}
      {build.method === "pointbuy" && (
        <p
          className={`text-xs ${spent > POINT_BUY_BUDGET ? "text-red-300" : "text-ink-300"}`}
        >
          {spent} of {POINT_BUY_BUDGET} points spent
        </p>
      )}
      {pool && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {species?.name}: {left === 0 ? "all" : left} of {pool.points} bonus{" "}
          {pool.points === 1 ? "point" : "points"}{" "}
          {left === 0 ? "placed" : "left to place"}, at most +{pool.maxPer} on
          one score.
        </p>
      )}

      <table className="w-full text-sm">
        <thead className="text-[11px] text-ink-400">
          <tr>
            <th className="py-1 text-left font-normal">Ability</th>
            <th className="py-1 text-left font-normal">Base</th>
            <th className="py-1 text-left font-normal">Species</th>
            <th className="py-1 text-right font-normal">Score</th>
            <th className="py-1 text-right font-normal">Mod</th>
          </tr>
        </thead>
        <tbody>
          {ABILITIES.map((a) => {
            const fixed = species?.asi[a] ?? 0;
            const chosen = build.asiChosen[a] ?? 0;
            return (
              <tr key={a} className="border-t border-ink-800">
                <td className="py-1.5 pr-2 text-ink-200">{ABILITY_NAMES[a]}</td>
                <td className="py-1.5 pr-2">
                  {placesScores(build.method) ? (
                    <select
                      value={build.assign[a] ?? ""}
                      onChange={(e) =>
                        assign(
                          a,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                      className={`w-20 ${FIELD}`}
                    >
                      <option value="">—</option>
                      {build.pool.map((v, i) => (
                        <option
                          key={i}
                          value={i}
                          disabled={taken.has(i) && build.assign[a] !== i}
                        >
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Stepper onClick={() => bump(a, -1)} label="Lower">
                        <Minus size={12} />
                      </Stepper>
                      <span className="w-6 text-center font-serif">
                        {build.base[a]}
                      </span>
                      <Stepper onClick={() => bump(a, 1)} label="Raise">
                        <Plus size={12} />
                      </Stepper>
                      {build.method === "pointbuy" && (
                        <span className="ml-1 text-[11px] text-ink-500">
                          {pointCost(build.base[a])} pts
                        </span>
                      )}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-2 text-xs text-ink-300">
                  <span className="inline-flex items-center gap-1">
                    {fixed ? <span>{signed(fixed)}</span> : null}
                    {pool && (
                      <>
                        <Stepper onClick={() => place(a, -1)} label="Take back">
                          <Minus size={12} />
                        </Stepper>
                        <span className="w-6 text-center">
                          {chosen ? signed(chosen) : "—"}
                        </span>
                        <Stepper onClick={() => place(a, 1)} label="Place">
                          <Plus size={12} />
                        </Stepper>
                      </>
                    )}
                    {!fixed && !pool ? <span>—</span> : null}
                  </span>
                </td>
                <td className="py-1.5 text-right font-serif text-base text-ink-100">
                  {final[a]}
                  {base[a] !== final[a] && (
                    <span className="ml-1 text-[11px] text-ink-500">
                      ({base[a]})
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right text-ink-200">
                  {signed(modifier(final[a]))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Skills ----------------------------------------------------------------

function SkillsStep({ build, patch }: StepProps) {
  const cls = classByName(startingClass(build).name);
  const bg = backgroundByName(build.background);
  const granted = grantedSkills(build);
  const choice = classSkillChoice(build.classes);
  const classFrom =
    cls === undefined
      ? []
      : choice.from.length === 0
        ? SKILLS.map((s) => s.id)
        : choice.from;
  const classChoose = choice.choose;
  const expertiseCount = expertiseFor(build.classes);
  const proficient = allSkills(build);

  function toggleIn(
    key: "classSkills" | "backgroundSkills" | "expertise",
    id: string,
    max: number,
  ) {
    patch((b) => {
      const list = b[key];
      if (list.includes(id))
        return { ...b, [key]: list.filter((x) => x !== id) };
      if (list.length >= max) return b;
      return { ...b, [key]: [...list, id] };
    });
  }

  return (
    <div className="space-y-4">
      <StepIntro
        title="Choose skills"
        blurb="Skills from species and background are already yours. Pick the rest from the class list."
      />
      {granted.length > 0 && (
        <Group title="Already proficient" note="From species and background">
          {granted.map((id) => (
            <Chip key={id} active locked>
              {skillName(id)}
            </Chip>
          ))}
        </Group>
      )}
      {cls ? (
        <Group
          title={
            build.classes.length > 1
              ? `Class skills: choose ${classChoose}`
              : `${cls.name}: choose ${classChoose}`
          }
          note={`${build.classSkills.length} of ${classChoose} chosen${choice.from.length === 0 ? ", from any skill" : ""}${
            build.classes.length > 1 ? ` · ${choice.parts.join(", ")}` : ""
          }`}
        >
          {classFrom.map((id) => {
            const already =
              granted.includes(id) || build.backgroundSkills.includes(id);
            return (
              <Chip
                key={id}
                active={build.classSkills.includes(id)}
                locked={already}
                title={
                  already
                    ? "Already proficient from another source"
                    : skillName(id)
                }
                onClick={() =>
                  !already && toggleIn("classSkills", id, classChoose)
                }
              >
                {skillName(id)}
              </Chip>
            );
          })}
        </Group>
      ) : (
        <p className="text-xs text-ink-400">
          Pick a class first, or tick skills on the sheet afterwards for a
          homebrew class.
        </p>
      )}
      {bg?.choose && (
        <Group
          title={`${bg.name}: choose ${bg.choose.count}`}
          note={`${build.backgroundSkills.length} of ${bg.choose.count} chosen`}
        >
          {bg.choose.from.map((id) => {
            const already =
              granted.includes(id) || build.classSkills.includes(id);
            return (
              <Chip
                key={id}
                active={build.backgroundSkills.includes(id)}
                locked={already}
                onClick={() =>
                  !already && toggleIn("backgroundSkills", id, bg.choose!.count)
                }
              >
                {skillName(id)}
              </Chip>
            );
          })}
        </Group>
      )}
      {expertiseCount > 0 && (
        <Group
          title={`Expertise: choose ${expertiseCount}`}
          note={`Double proficiency · ${build.expertise.length} of ${expertiseCount} chosen`}
        >
          {proficient.length === 0 ? (
            <span className="text-xs text-ink-400">
              Choose proficiencies first.
            </span>
          ) : (
            proficient.map((id) => (
              <Chip
                key={id}
                active={build.expertise.includes(id)}
                strong={build.expertise.includes(id)}
                onClick={() => toggleIn("expertise", id, expertiseCount)}
              >
                {skillName(id)}
              </Chip>
            ))
          )}
        </Group>
      )}
    </div>
  );
}

// ---- Details ---------------------------------------------------------------

function DetailsStep({ build, patch }: StepProps) {
  const auto = computedHp(build);
  const cls = classByName(startingClass(build).name);
  const con = modifier(finalAbilities(build).con);
  const personality = build.personality;
  function setPersonality(key: keyof Build5e["personality"], value: string) {
    patch((b) => ({ ...b, personality: { ...b.personality, [key]: value } }));
  }
  return (
    <div className="space-y-4">
      <StepIntro
        title="Name and details"
        blurb="The rest of the first page: name, alignment, hit points and who this person is."
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className={`${LABEL} min-w-56 flex-1`}>
          Name
          <input
            autoFocus
            value={build.name}
            onChange={(e) => patch((b) => ({ ...b, name: e.target.value }))}
            placeholder="Name"
            className={`mt-1 block w-full ${FIELD} placeholder:text-ink-600`}
          />
        </label>
        <label className={LABEL}>
          Alignment
          <select
            value={build.alignment}
            onChange={(e) =>
              patch((b) => ({ ...b, alignment: e.target.value }))
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
        <label className={LABEL}>
          Hit point maximum
          <input
            type="number"
            min={1}
            value={build.hpMax ?? auto ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              patch((b) => ({
                ...b,
                hpMax:
                  v === "" ? null : Math.max(1, Math.round(Number(v)) || 1),
              }));
            }}
            className={`mt-1 block w-24 ${FIELD}`}
          />
        </label>
        {cls && auto !== null && (
          <span className="pb-1.5 text-xs text-ink-400">
            {build.hpMax !== null && build.hpMax !== auto ? (
              <>
                Book value is {auto}.{" "}
                <button
                  type="button"
                  className="text-ember-300 hover:underline"
                  onClick={() => patch((b) => ({ ...b, hpMax: null }))}
                >
                  Use it
                </button>
              </>
            ) : build.classes.length > 1 ? (
              `d${cls.hitDie} at level 1, then each class's average for its own levels, ${signed(con)} Con each level.`
            ) : (
              `d${cls.hitDie} at level 1, then average, ${signed(con)} Con each level.`
            )}
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(
          [
            ["traits", "Personality traits"],
            ["ideals", "Ideals"],
            ["bonds", "Bonds"],
            ["flaws", "Flaws"],
          ] as [keyof Build5e["personality"], string][]
        ).map(([key, label]) => (
          <label key={key} className={LABEL}>
            {label}
            <textarea
              value={personality[key]}
              onChange={(e) => setPersonality(key, e.target.value)}
              rows={3}
              className={`mt-1 block w-full resize-y ${FIELD}`}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

// ---- Review ----------------------------------------------------------------

function ReviewStep({
  build,
  problems,
}: {
  build: Build5e;
  problems: string[];
}) {
  const sheet = useMemo(() => buildSheet(build), [build]);
  const species = speciesByName(build.species);
  const cls = classByName(startingClass(build).name);
  const bg = backgroundByName(build.background);
  const pact = sheet.spellcasting.pact;
  const slots = [
    ...Object.entries(sheet.spellcasting.slots).map(
      ([lv, row]) => `${row.max}× level ${lv}`,
    ),
    ...(pact ? [`Pact Magic ${pact.max}× level ${pact.level}`] : []),
  ].join(", ");
  return (
    <div className="space-y-4">
      <StepIntro
        title="Review"
        blurb="What the sheet will say. Everything stays editable on the sheet afterwards."
      />
      {problems.length > 0 && (
        <ul className="list-disc space-y-0.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 pl-7 text-xs text-red-200">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <h3 className="font-serif text-xl text-ink-100">
        {build.name.trim() || <span className="text-ink-500">Unnamed</span>}
      </h3>
      <p className="text-sm text-ink-300">
        {sheetSummary(sheet)}
        {bg
          ? ` · ${bg.name}`
          : build.background
            ? ` · ${build.background}`
            : ""}
        {sheet.alignment ? ` · ${sheet.alignment}` : ""}
      </p>
      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        {ABILITIES.map((a) => (
          <div
            key={a}
            className="rounded-md border border-ink-800 bg-ink-900/60 px-2 py-1.5 text-center"
          >
            <div className={LABEL}>{abbr(a)}</div>
            <div className="font-serif text-lg text-ink-100">
              {sheet.abilities[a]}
            </div>
            <div className="text-xs text-ink-300">
              {signed(modifier(sheet.abilities[a]))}
            </div>
          </div>
        ))}
      </div>
      <dl className="grid gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">
        <Row label="Hit points">
          {sheet.hp.max ?? "—"}
          {cls ? ` (${hitDiceText(sheet.classes)})` : ""}
        </Row>
        <Row label="Speed">{sheet.speed}</Row>
        <Row label="Saving throws">
          {sheet.saves.length ? sheet.saves.map(abbr).join(", ") : "—"}
        </Row>
        <Row label="Senses">{sheet.senses || "—"}</Row>
        <Row label="Skills">
          {sheet.skills.length
            ? sheet.skills
                .map((id) =>
                  sheet.expertise.includes(id)
                    ? `${skillName(id)} (expertise)`
                    : skillName(id),
                )
                .join(", ")
            : "—"}
        </Row>
        <Row label="Languages">{sheet.languages || "—"}</Row>
        <Row label="Traits">
          {sheet.features.length
            ? sheet.features.map((f) => f.name).join(", ")
            : "—"}
        </Row>
        <Row label="Spellcasting">
          {sheet.spellcasting.ability
            ? `${abbr(sheet.spellcasting.ability)}${slots ? ` · ${slots}` : ""}`
            : "None"}
        </Row>
        {cls && (
          <Row label="Training">
            Armour: {cls.armor || "none"} · Weapons: {cls.weapons}
            {bg?.tools ? ` · Tools: ${bg.tools}` : ""}
          </Row>
        )}
        {species && <Row label="Size">{species.size}</Row>}
      </dl>
      <p className="text-xs text-ink-500">
        Equipment, class features and spells known are not filled in here; add
        them on the sheet.
      </p>
    </div>
  );
}

// ---- Small parts -----------------------------------------------------------

function StepIntro({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h3 className="font-serif text-base text-ink-100">{title}</h3>
      <p className="text-xs text-ink-400">{blurb}</p>
    </div>
  );
}

function PickHeader({
  query,
  onQuery,
  custom,
  isKnown,
  onCustom,
  placeholder,
  customPlaceholder,
}: {
  query: string;
  onQuery: (v: string) => void;
  custom: string;
  isKnown: boolean;
  onCustom: (v: string) => void;
  placeholder: string;
  customPlaceholder: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <input
        autoFocus
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={placeholder}
        className={`min-w-48 flex-1 ${FIELD} placeholder:text-ink-600`}
      />
      <input
        value={isKnown ? "" : custom}
        onChange={(e) => onCustom(e.target.value)}
        placeholder={customPlaceholder}
        className={`min-w-48 flex-1 ${FIELD} placeholder:text-ink-600`}
      />
    </div>
  );
}

function Card({
  selected,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`rounded-md border p-2.5 text-left transition-colors ${
        selected
          ? "border-ember-500 bg-ember-500/10"
          : "border-ink-800 bg-ink-900/60 hover:border-ink-600"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-serif text-sm text-ink-100">{title}</span>
        {selected && <Check size={14} className="shrink-0 text-ember-300" />}
      </div>
      {children}
    </button>
  );
}

function Line({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <p
      className={`text-[11px] leading-snug ${muted ? "text-ink-500" : "text-ink-300"}`}
    >
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="col-span-full text-xs text-ink-500">{children}</p>;
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-semibold text-ink-200">{title}</span>
        {note && <span className="text-[11px] text-ink-500">{note}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  strong,
  locked,
  onClick,
  title,
  children,
}: {
  active: boolean;
  strong?: boolean;
  locked?: boolean;
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      disabled={locked}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-default ${
        strong
          ? "border-ember-400 bg-ember-500/30 text-ember-100"
          : active
            ? "border-ember-500/60 bg-ember-500/15 text-ember-200"
            : locked
              ? "border-ink-800 text-ink-600"
              : "border-ink-700 text-ink-400 hover:border-ink-500 hover:text-ink-200"
      }`}
    >
      {children}
    </button>
  );
}

function Stepper({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded border border-ink-700 p-0.5 text-ink-300 hover:border-ink-500 hover:text-ink-100"
    >
      {children}
    </button>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-ink-400">{label}</dt>
      <dd className="min-w-0 text-ink-200">{children}</dd>
    </div>
  );
}

function abbr(a: Ability): string {
  return a.toUpperCase();
}

function skillName(id: string): string {
  return SKILLS.find((s) => s.id === id)?.name ?? id;
}
