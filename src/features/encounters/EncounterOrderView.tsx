import type { ElementSummary } from "@/lib/types";

import type { EncounterData } from "./encounter-model";

/**
 * A shared encounter as players see it: the turn order with initiative,
 * conditions and who is down, read-only. Hit points, AC and the GM's notes
 * never reach the table (`src-tauri/src/table/share.rs`).
 */
export function EncounterOrderView({
  data,
  byId,
  onOpen,
}: {
  data: EncounterData;
  /** Shared elements, so a combatant's name can link to its sheet. */
  byId: Map<string, ElementSummary>;
  onOpen: (id: string) => void;
}) {
  if (data.combatants.length === 0) return null;
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        Turn order
        {data.status === "running" && (
          <span className="ml-2 font-normal normal-case tracking-normal text-ink-400">
            Round {data.round}
          </span>
        )}
      </h3>
      <ol className="mt-2 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
        {data.combatants.map((c, i) => {
          const current = data.status === "running" && i === data.turn;
          const linked = c.element ? byId.get(c.element) : undefined;
          return (
            <li
              key={c.id}
              aria-current={current ? "step" : undefined}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm ${
                current ? "bg-ember-500/10" : ""
              } ${c.down ? "opacity-50" : ""}`}
            >
              <span className="w-8 shrink-0 text-right font-mono text-xs text-ink-500">
                {c.initiative === null ? "—" : c.initiative}
              </span>
              {linked ? (
                <button
                  type="button"
                  onClick={() => onOpen(linked.id)}
                  className={`truncate text-left hover:underline ${
                    current ? "font-semibold text-ember-100" : "text-ember-300"
                  } ${c.down ? "line-through" : ""}`}
                >
                  {c.name}
                </button>
              ) : (
                <span
                  className={`truncate ${
                    current ? "font-semibold text-ember-100" : "text-ink-100"
                  } ${c.down ? "line-through" : ""}`}
                >
                  {c.name}
                </span>
              )}
              {current && (
                <span className="rounded bg-ember-500/25 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ember-200">
                  Turn
                </span>
              )}
              {c.down && <span className="text-[11px] text-ink-500">down</span>}
              {c.conditions.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {c.conditions.map((cond) => (
                    <span
                      key={cond}
                      className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-100"
                    >
                      {cond}
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
