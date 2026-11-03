import { Plus } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Button } from "@/components/Button";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  byDateDesc,
  defaultEntryName,
  formatIsoDate,
  formatIsoMonth,
  isJournal,
  readJournal,
  scopeLabel,
  todayIso,
} from "./journal-model";

type Filter = "all" | "campaign" | "arc" | "session";

/** The Journal view's list column: every entry, newest first, by month. */
export function JournalList({ selectedId }: { selectedId: string | null }) {
  const elements = useCampaignStore((s) => s.elements);
  const navigate = useCampaignStore((s) => s.navigate);
  const createElement = useCampaignStore((s) => s.createElement);

  const [filter, setFilter] = useState<Filter>("all");

  const entries = useMemo(
    () =>
      elements
        .filter(isJournal)
        .filter((e) => filter === "all" || readJournal(e).scope.type === filter)
        .sort(byDateDesc),
    [elements, filter],
  );

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: typeof entries }[] = [];
    for (const e of entries) {
      const date = readJournal(e).date;
      const key = date ? date.slice(0, 7) : "undated";
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(e);
      else
        out.push({
          key,
          label: date ? formatIsoMonth(date) : "Undated",
          items: [e],
        });
    }
    return out;
  }, [entries]);

  async function handleNew() {
    const date = todayIso();
    await createElement("journal", defaultEntryName(date), {
      date,
      scope: { type: "campaign" },
    });
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <div className="flex flex-1 overflow-hidden rounded-md border border-ink-700 text-[11px]">
          {(
            [
              ["all", "All"],
              ["campaign", "Campaign"],
              ["arc", "Arcs"],
              ["session", "Sessions"],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={`flex-1 px-2 py-1 ${
                filter === id
                  ? "bg-ember-500/25 text-ember-200"
                  : "text-ink-300 hover:bg-ink-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => void handleNew()}>
          <Plus size={14} /> Entry
        </Button>
      </div>

      <ul className="flex-1 overflow-y-auto py-1">
        {entries.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-ink-500">
            No journal entries yet. Write one for today, or from an arc or
            session to attach it there.
          </li>
        )}
        {groups.map((g) => (
          <Fragment key={g.key}>
            <li className="sticky top-0 z-[1] bg-ink-850/95 px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500 backdrop-blur">
              {g.label}
            </li>
            {g.items.map((e) => {
              const data = readJournal(e);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={(ev) =>
                      void navigate(e.id, { pane: ev.ctrlKey || ev.metaKey })
                    }
                    title="Click to open · Ctrl+click to open beside"
                    className={`flex w-full items-start gap-3 px-4 py-2 text-left transition-colors ${
                      e.id === selectedId ? "bg-ink-700/60" : "hover:bg-ink-800"
                    }`}
                  >
                    <span className="mt-0.5 w-7 shrink-0 text-right font-mono text-xs text-ink-400">
                      {data.date ? Number(data.date.slice(8, 10)) : "—"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-100">
                        {e.name}
                      </span>
                      <span className="block text-[11px] text-ink-500">
                        {data.date ? formatIsoDate(data.date) : "Undated"} ·{" "}
                        {scopeLabel(data.scope, elements)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>
    </>
  );
}
