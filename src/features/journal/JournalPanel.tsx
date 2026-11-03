import { useMemo } from "react";

import { WorldDatePicker } from "@/features/timeline/WorldDatePicker";
import { calendarOf } from "@/features/timeline/calendar-model";
import { displayName } from "@/features/sessions/session-model";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { readJournal, readScope } from "./journal-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";

/**
 * Structured part of a journal entry: the day it was written, the in-world
 * date it describes, and what it belongs to. The entry itself is the body.
 */
export function JournalPanel({ element }: { element: Element }) {
  const campaign = useCampaignStore((s) => s.campaign);
  const elements = useCampaignStore((s) => s.elements);
  const saveElement = useCampaignStore((s) => s.saveElement);
  const navigate = useCampaignStore((s) => s.navigate);
  const calendar = useMemo(() => calendarOf(campaign), [campaign]);

  const data = useMemo(() => readJournal(element), [element]);
  const arcs = useMemo(
    () => elements.filter((e) => e.type === "arc"),
    [elements],
  );
  const sessions = useMemo(
    () => elements.filter((e) => e.type === "session"),
    [elements],
  );

  const scopeValue =
    data.scope.type === "campaign"
      ? "campaign"
      : `${data.scope.type}:${data.scope.id}`;
  const scopeTarget =
    data.scope.type === "campaign"
      ? null
      : (elements.find((e) => e.id === (data.scope as { id: string }).id) ??
        null);

  function setScope(value: string) {
    if (value === "campaign") {
      void saveElement(element.id, { scope: { type: "campaign" } });
      return;
    }
    const [type, id] = value.split(":");
    void saveElement(element.id, { scope: readScope({ type, id }) });
  }

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      <div className="flex flex-wrap items-end gap-6">
        <label className="text-[11px] text-ink-400">
          Written on
          <input
            type="date"
            value={data.date ?? ""}
            onChange={(e) =>
              void saveElement(element.id, {
                date: e.target.value || undefined,
              })
            }
            className={`mt-1 block ${FIELD}`}
          />
        </label>

        <label className="text-[11px] text-ink-400">
          Belongs to
          <select
            value={scopeValue}
            onChange={(e) => setScope(e.target.value)}
            className={`mt-1 block w-64 ${FIELD}`}
          >
            <option value="campaign">The campaign</option>
            {arcs.length > 0 && (
              <optgroup label="Arcs">
                {arcs.map((a) => (
                  <option key={a.id} value={`arc:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
            {sessions.length > 0 && (
              <optgroup label="Sessions">
                {sessions.map((s) => (
                  <option key={s.id} value={`session:${s.id}`}>
                    {displayName(s)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <WorldDatePicker
          label="In-world date (optional)"
          calendar={calendar}
          value={data.worldDate}
          onChange={(d) =>
            void saveElement(element.id, { worldDate: d ?? undefined })
          }
        />
      </div>

      {scopeTarget && (
        <button
          type="button"
          onClick={(e) =>
            void navigate(scopeTarget.id, { pane: e.ctrlKey || e.metaKey })
          }
          className="mt-3 text-[11px] text-ember-400 hover:underline"
          title="Click to open · Ctrl+click to open beside"
        >
          Open {scopeTarget.type === "arc" ? "arc" : "session"}:{" "}
          {scopeTarget.name} →
        </button>
      )}
    </section>
  );
}
