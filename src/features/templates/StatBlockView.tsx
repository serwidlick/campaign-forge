import { signed } from "./dnd5e-model";
import {
  abilityLine,
  crInfo,
  statBlockLine,
  type NamedEntry,
  type StatBlock5e,
} from "./dnd5e-statblock";

/** A creature's stat block laid out the classic way, read-only. */
export function StatBlockView({ name, sb }: { name: string; sb: StatBlock5e }) {
  const cr = crInfo(sb.cr);
  const line = (label: string, value: string) =>
    value.trim() ? (
      <p key={label}>
        <span className="font-semibold text-ink-100">{label}</span> {value}
      </p>
    ) : null;
  const lists: [string, NamedEntry[]][] = [
    ["Traits", sb.traits],
    ["Actions", sb.actions],
    ["Bonus actions", sb.bonusActions],
    ["Reactions", sb.reactions],
    ["Legendary actions", sb.legendary],
  ];
  return (
    <section className="rounded-lg border border-ember-500/30 bg-ink-900/60 px-5 py-4 text-sm text-ink-300">
      <h3 className="font-serif text-xl font-semibold text-ember-300">
        {name}
      </h3>
      <p className="text-xs text-ink-400 italic">{statBlockLine(sb)}</p>
      <hr className="my-2 border-ember-500/30" />
      {line(
        "Armour Class",
        sb.ac !== null ? `${sb.ac}${sb.acNote ? ` (${sb.acNote})` : ""}` : "",
      )}
      {line(
        "Hit Points",
        sb.hp !== null
          ? `${sb.hp}${sb.hpFormula ? ` (${sb.hpFormula})` : ""}`
          : "",
      )}
      {line("Speed", sb.speed)}
      <hr className="my-2 border-ember-500/30" />
      <p className="font-mono text-xs text-ink-200">{abilityLine(sb)}</p>
      <hr className="my-2 border-ember-500/30" />
      {line("Saving Throws", sb.saves)}
      {line("Skills", sb.skills)}
      {line("Damage Vulnerabilities", sb.vulnerabilities)}
      {line("Damage Resistances", sb.resistances)}
      {line("Damage Immunities", sb.immunities)}
      {line("Condition Immunities", sb.conditionImmunities)}
      {line("Senses", sb.senses)}
      {line("Languages", sb.languages)}
      {cr &&
        line(
          "Challenge",
          `${sb.cr} (${cr.xp.toLocaleString()} XP) · Proficiency ${signed(cr.pb)}`,
        )}
      {lists.map(([title, entries]) =>
        entries.length === 0 ? null : (
          <div key={title}>
            <hr className="my-2 border-ember-500/30" />
            <h4 className="mb-1 font-serif text-base font-semibold text-ember-200">
              {title}
            </h4>
            <div className="space-y-1.5">
              {entries.map((e) => (
                <p key={e.id}>
                  <span className="font-semibold text-ink-100 italic">
                    {e.name}.
                  </span>{" "}
                  {e.text}
                </p>
              ))}
            </div>
          </div>
        ),
      )}
    </section>
  );
}
