import { Plus } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/Button";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  nextSessionNumber,
  readArc,
  readSession,
  sessionsOfArc,
} from "./session-model";

/**
 * Structured part of an arc: its sessions in play order, with a one-click way
 * to add the next one. The arc's premise and notes live in the Markdown body.
 */
export function ArcPanel({ element }: { element: Element }) {
  const elements = useCampaignStore((s) => s.elements);
  const saveElement = useCampaignStore((s) => s.saveElement);
  const createElement = useCampaignStore((s) => s.createElement);
  const navigate = useCampaignStore((s) => s.navigate);

  const arc = useMemo(() => readArc(element), [element]);
  const sessions = useMemo(
    () => sessionsOfArc(elements, element.id),
    [elements, element.id],
  );

  async function handleNewSession() {
    const number = nextSessionNumber(elements);
    await createElement("session", `Session ${number}`, {
      arc: element.id,
      number,
      status: "planned",
      beats: [],
    });
  }

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Sessions
          {sessions.length > 0 && (
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-600">
              {sessions.filter((s) => s.status === "played").length}/
              {sessions.length} played
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void saveElement(element.id, {
                status: arc.status === "complete" ? "active" : "complete",
              })
            }
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${
              arc.status === "complete"
                ? "bg-emerald-500/20 text-emerald-200"
                : "bg-ink-800 text-ink-300 hover:bg-ink-700"
            }`}
          >
            {arc.status === "complete" ? "Complete" : "Active"}
          </button>
          <Button size="sm" onClick={() => void handleNewSession()}>
            <Plus size={14} /> New session
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="mt-2 text-sm text-ink-600">
          No sessions in this arc yet.
        </p>
      ) : (
        <ol className="mt-2 divide-y divide-ink-800 rounded-md border border-ink-800 bg-ink-900">
          {sessions.map((s) => {
            const data = readSession(s);
            const encounter = data.beats.find((b) => b.role === "encounter");
            const done = data.beats.filter((b) => b.done).length;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={(e) =>
                    void navigate(s.id, { pane: e.ctrlKey || e.metaKey })
                  }
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ink-850"
                >
                  <span className="w-8 shrink-0 font-mono text-xs text-ink-500">
                    {data.number === null ? "—" : `#${data.number}`}
                  </span>
                  <span className="flex-1 truncate text-sm text-ink-100">
                    {s.name}
                    {encounter?.title && (
                      <span className="ml-2 text-xs text-ink-500">
                        · {encounter.title}
                      </span>
                    )}
                  </span>
                  {data.beats.length > 0 && (
                    <span className="text-[11px] text-ink-500">
                      {done}/{data.beats.length}
                    </span>
                  )}
                  {data.date && (
                    <span className="text-[11px] text-ink-500">
                      {data.date}
                    </span>
                  )}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      data.status === "played"
                        ? "bg-emerald-500/20 text-emerald-200"
                        : "bg-ink-800 text-ink-400"
                    }`}
                  >
                    {data.status === "played" ? "Played" : "Planned"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
