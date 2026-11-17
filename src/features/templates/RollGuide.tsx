import {
  ABILITIES,
  ABILITY_NAMES,
  SKILLS,
  abilityCheckRoll,
  attackRoll,
  formatRoll,
  initiativeRoll,
  rollTotal,
  saveRoll,
  signed,
  skillRoll,
  spellAttackRoll,
  spellSaveDcRoll,
  type RollFormula,
  type Sheet5e,
} from "./dnd5e-model";

const HEADING =
  "text-[11px] font-semibold tracking-wider text-ink-500 uppercase";

/**
 * What a player should pick up and add, for every roll the sheet knows
 * about. The app never rolls: it names the die and lists each bonus with
 * where it comes from, so "Stealth" reads "1d20 + 2 (prof) + 2 (dex)".
 * Open for a player at the table; folded away on the GM's editor, where
 * the fields it derives from matter more.
 */
export function RollGuide({
  sheet,
  open = true,
}: {
  sheet: Sheet5e;
  open?: boolean;
}) {
  const spellAttack = spellAttackRoll(sheet);
  const spellDc = spellSaveDcRoll(sheet);
  return (
    <details
      open={open}
      className="rounded-lg border border-ember-500/30 bg-ember-500/5"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-semibold tracking-wider text-ember-200 uppercase select-none [&::-webkit-details-marker]:hidden">
        What to roll
        <span className="font-normal normal-case tracking-normal text-ink-500">
          roll the die, add each number · advantage or disadvantage: roll two
          d20 and keep the higher or lower
        </span>
      </summary>
      <div className="space-y-4 px-3 pb-3">
        <div>
          <div className={HEADING}>Ability checks and saving throws</div>
          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {ABILITIES.map((a) => (
              <div
                key={a}
                className="rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5"
              >
                <div className="text-xs font-semibold text-ink-200">
                  {ABILITY_NAMES[a]}
                </div>
                <Line
                  label="Check"
                  labelWidth="3rem"
                  roll={abilityCheckRoll(sheet, a)}
                />
                <Line
                  label="Save"
                  labelWidth="3rem"
                  roll={saveRoll(sheet, a)}
                  strong={sheet.saves.includes(a)}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Line label="Initiative" roll={initiativeRoll(sheet)} />
            <Line
              label="Death save"
              roll={{ die: "1d20", parts: [] }}
              note="10 or more succeeds"
            />
          </div>
        </div>

        <div>
          <div className={HEADING}>Skill checks</div>
          <div className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {SKILLS.map((sk) => (
              <Line
                key={sk.id}
                label={sk.name}
                sub={sk.ability}
                roll={skillRoll(sheet, sk)}
                strong={
                  sheet.skills.includes(sk.id) ||
                  sheet.expertise.includes(sk.id)
                }
              />
            ))}
          </div>
        </div>

        <div>
          <div className={HEADING}>Attacks</div>
          <div className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Line
              label="Melee weapon"
              roll={attackRoll(sheet, blankAttack("melee"))}
              note="finesse weapons use DEX"
            />
            <Line
              label="Ranged weapon"
              roll={attackRoll(sheet, blankAttack("ranged"))}
              note="thrown weapons use STR"
            />
            {spellAttack && <Line label="Spell attack" roll={spellAttack} />}
            {spellDc && (
              <Line
                label="Spell save DC"
                roll={spellDc}
                note="the target rolls against this"
                total={rollTotal(spellDc) + 8}
              />
            )}
          </div>
          <p className="mt-1 text-[11px] text-ink-600">
            Weapon rolls assume you are proficient with the weapon. Damage is
            the weapon's die plus the same ability; a spell's damage is in its
            notes.
          </p>
          {sheet.attacks.length > 0 && (
            <div className="mt-2 space-y-1">
              {sheet.attacks.map((a) => {
                const roll = attackRoll(sheet, a);
                return (
                  <div
                    key={a.id}
                    className="grid grid-cols-1 gap-x-3 gap-y-0.5 rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 sm:grid-cols-[10rem_1fr_1fr]"
                  >
                    <div className="truncate text-xs font-semibold text-ink-200">
                      {a.name || "Unnamed attack"}
                      {a.notes && (
                        <span className="ml-1.5 font-normal text-ink-500">
                          {a.notes}
                        </span>
                      )}
                    </div>
                    <Line
                      label="To hit"
                      labelWidth="3.5rem"
                      roll={roll}
                      note={
                        roll.parts.length === 0
                          ? a.bonus.trim()
                            ? a.bonus
                            : "no bonus listed"
                          : undefined
                      }
                    />
                    <div className="grid grid-cols-[3.5rem_1fr] items-baseline gap-x-2 text-xs">
                      <span className="text-ink-500">Damage</span>
                      <span className="font-mono text-ink-100">
                        {a.damage.trim() || "—"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function blankAttack(kind: "melee" | "ranged") {
  return { id: "", name: "", bonus: "", damage: "", notes: "", kind };
}

/**
 * One roll as a table row: the label in a fixed-width column, the dice and
 * each bonus after it, and the total flush right, so a list of lines reads
 * down in straight columns and fits a phone without wrapping.
 */
function Line({
  label,
  sub,
  roll,
  strong,
  note,
  total,
  labelWidth = "7.5rem",
}: {
  label: string;
  sub?: string;
  roll: RollFormula;
  strong?: boolean;
  note?: string;
  /** Shown instead of the parts' sum, for a flat base like a save DC. */
  total?: number;
  /** Width of the label column; narrower inside the small cards. */
  labelWidth?: string;
}) {
  const sum = total ?? rollTotal(roll);
  return (
    <div
      className="grid items-baseline gap-x-2 text-xs"
      style={{ gridTemplateColumns: `${labelWidth} minmax(0, 1fr) auto` }}
    >
      <span className={strong ? "text-ember-200" : "text-ink-400"}>
        {label}
        {sub && <span className="ml-1 text-ink-600">{sub}</span>}
      </span>
      <span className="font-mono text-ink-300">{formatRoll(roll)}</span>
      <span className="justify-self-end font-mono text-ink-100">
        {roll.parts.length > 0 && (total !== undefined ? sum : signed(sum))}
      </span>
      {note && (
        <span className="col-start-2 col-span-2 text-ink-600">{note}</span>
      )}
    </div>
  );
}
