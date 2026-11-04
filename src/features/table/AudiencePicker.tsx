import { ChevronDown, Users } from "lucide-react";

import type { PlayerRecord } from "@/lib/types";

/**
 * Who a shared element is for: everyone at the table, or only the players
 * ticked here. Shows as a small dropdown in the shared strip of an editor.
 */
export function AudiencePicker({
  players,
  value,
  onChange,
}: {
  players: PlayerRecord[];
  /** Player ids; empty means everyone. */
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const chosen = players.filter((p) => value.includes(p.id));
  const stale = value.filter((id) => !players.some((p) => p.id === id));
  const label =
    value.length === 0
      ? "Everyone at the table"
      : chosen.map((p) => p.name).join(", ") +
        (stale.length ? ` (+${stale.length} unknown)` : "");

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-1.5 py-0.5 hover:bg-ember-500/15 [&::-webkit-details-marker]:hidden">
        <Users size={12} />
        <span>
          Visible to <strong>{label}</strong>
        </span>
        <ChevronDown size={11} className="opacity-70" />
      </summary>
      <div className="absolute top-full left-0 z-20 mt-1 w-64 rounded-md border border-ink-700 bg-ink-900 p-2 text-xs text-ink-200 shadow-lg">
        <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-800">
          <input
            type="checkbox"
            checked={value.length === 0}
            onChange={() => onChange([])}
            className="accent-ember-500"
          />
          Everyone at the table
        </label>
        {players.length === 0 ? (
          <p className="px-1.5 py-1 text-ink-500">
            No paired players yet. Pair a device from the table panel while
            hosting, then pick names here.
          </p>
        ) : (
          players.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-ink-800"
            >
              <input
                type="checkbox"
                checked={value.includes(p.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, p.id]
                      : value.filter((id) => id !== p.id),
                  )
                }
                className="accent-ember-500"
              />
              {p.name}
            </label>
          ))
        )}
        {stale.length > 0 && (
          <button
            type="button"
            onClick={() => onChange(value.filter((id) => !stale.includes(id)))}
            className="mt-1 px-1.5 text-ink-500 hover:text-ink-200"
          >
            Drop {stale.length} removed player{stale.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </details>
  );
}
