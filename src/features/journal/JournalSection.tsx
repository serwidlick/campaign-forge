import { Plus } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/Button";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  defaultEntryName,
  entriesFor,
  formatIsoDate,
  readJournal,
  todayIso,
  type JournalScope,
} from "./journal-model";

/**
 * The journal entries attached to one arc or session, with a one-click way
 * to write a new one in that scope. Rendered inside the arc and session panels.
 */
export function JournalSection({ scope }: { scope: JournalScope }) {
  const elements = useCampaignStore((s) => s.elements);
  const navigate = useCampaignStore((s) => s.navigate);
  const createElement = useCampaignStore((s) => s.createElement);

  const entries = useMemo(() => entriesFor(elements, scope), [elements, scope]);

  async function handleNew() {
    const date = todayIso();
    await createElement("journal", defaultEntryName(date), { date, scope });
  }

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Journal
          {entries.length > 0 && (
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
              {entries.length}
            </span>
          )}
        </h2>
        <Button size="sm" variant="ghost" onClick={() => void handleNew()}>
          <Plus size={14} /> New entry
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-ink-600">
          No entries yet. Recaps, prep notes and what the players did go here.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
          {entries.map((e) => {
            const data = readJournal(e);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={(ev) =>
                    void navigate(e.id, { pane: ev.ctrlKey || ev.metaKey })
                  }
                  title="Click to open · Ctrl+click to open beside"
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-ink-850"
                >
                  <span className="w-32 shrink-0 text-xs text-ink-500">
                    {data.date ? formatIsoDate(data.date) : "Undated"}
                  </span>
                  <span className="truncate text-ink-100">{e.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
