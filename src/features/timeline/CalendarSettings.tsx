import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/Button";
import { useCampaignStore } from "@/stores/campaign-store";

import { WorldDatePicker } from "./WorldDatePicker";
import {
  DEFAULT_CALENDAR,
  calendarOf,
  clampDate,
  daysInYear,
  type Calendar,
  type CalendarEra,
  type CalendarMonth,
} from "./calendar-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";

const AUTOSAVE_MS = 500;

/**
 * Edits the campaign's calendar: months, weekdays, eras, the epoch weekday
 * and the in-world today. Saved to `campaign.json` on a short debounce.
 */
export function CalendarSettings({ onClose }: { onClose: () => void }) {
  const campaign = useCampaignStore((s) => s.campaign);
  const updateCampaignSettings = useCampaignStore(
    (s) => s.updateCampaignSettings,
  );
  const initial = useMemo(() => calendarOf(campaign), [campaign]);

  const [draft, setDraft] = useState<Calendar>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  function update(fn: (c: Calendar) => Calendar) {
    setDraft((c) => {
      const next = fn(c);
      // Keep today valid when months shrink or disappear.
      return next.today
        ? { ...next, today: clampDate(next, next.today) }
        : next;
    });
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }

  function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setDraft((c) => {
      void updateCampaignSettings({ calendar: c });
      return c;
    });
  }

  // Flush on unmount so closing the panel never loses an edit. The ref is
  // refreshed in an effect so the unmount cleanup sees the latest closure.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => flushRef.current(), []);

  const yearLength = daysInYear(draft);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-ink-800 px-6 py-4">
        <div className="flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Campaign calendar
          </div>
          <input
            value={draft.name}
            onChange={(e) => update((c) => ({ ...c, name: e.target.value }))}
            className="mt-0.5 w-full bg-transparent font-serif text-2xl font-semibold text-ink-100 outline-none"
            aria-label="Calendar name"
          />
          <div className="mt-1 text-xs text-ink-400">
            {draft.months.length} months · {yearLength} days a year ·{" "}
            {draft.weekdays.length}-day week
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <X size={14} />
        </Button>
      </header>

      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        {/* Today */}
        <section>
          <SectionTitle>Today in the world</SectionTitle>
          <p className="mb-2 text-xs text-ink-500">
            The timeline marks this date and shows how far away everything else
            is. Move it forward as the campaign advances.
          </p>
          <WorldDatePicker
            calendar={draft}
            value={draft.today}
            onChange={(today) => update((c) => ({ ...c, today }))}
          />
        </section>

        {/* Months */}
        <section>
          <SectionTitle>Months</SectionTitle>
          <ol className="space-y-1">
            {draft.months.map((m, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-6 text-right font-mono text-[11px] text-ink-600">
                  {i + 1}
                </span>
                <input
                  value={m.name}
                  onChange={(e) =>
                    update((c) => ({
                      ...c,
                      months: replaceAt(c.months, i, {
                        ...m,
                        name: e.target.value,
                      }),
                    }))
                  }
                  className={`${FIELD} flex-1`}
                  aria-label={`Month ${i + 1} name`}
                />
                <input
                  type="number"
                  min={1}
                  value={m.days}
                  onChange={(e) =>
                    update((c) => ({
                      ...c,
                      months: replaceAt(c.months, i, {
                        ...m,
                        days: Math.max(1, Number(e.target.value) || 1),
                      }),
                    }))
                  }
                  className={`${FIELD} w-20`}
                  aria-label={`Month ${i + 1} days`}
                />
                <span className="text-[11px] text-ink-600">days</span>
                <MoveButtons
                  isFirst={i === 0}
                  isLast={i === draft.months.length - 1}
                  onMove={(d) =>
                    update((c) => ({ ...c, months: move(c.months, i, d) }))
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    update((c) => ({
                      ...c,
                      months:
                        c.months.length > 1
                          ? c.months.filter((_, j) => j !== i)
                          : c.months,
                    }))
                  }
                  disabled={draft.months.length <= 1}
                  aria-label="Remove month"
                  className="text-ink-600 hover:text-red-300 disabled:opacity-30"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ol>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() =>
              update((c) => ({
                ...c,
                months: [
                  ...c.months,
                  { name: `Month ${c.months.length + 1}`, days: 30 },
                ],
              }))
            }
          >
            <Plus size={14} /> Add month
          </Button>
        </section>

        {/* Weekdays */}
        <section>
          <SectionTitle>Weekdays</SectionTitle>
          <ol className="space-y-1">
            {draft.weekdays.map((w, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-6 text-right font-mono text-[11px] text-ink-600">
                  {i + 1}
                </span>
                <input
                  value={w}
                  onChange={(e) =>
                    update((c) => ({
                      ...c,
                      weekdays: replaceAt(c.weekdays, i, e.target.value),
                    }))
                  }
                  className={`${FIELD} flex-1`}
                  aria-label={`Weekday ${i + 1}`}
                />
                <MoveButtons
                  isFirst={i === 0}
                  isLast={i === draft.weekdays.length - 1}
                  onMove={(d) =>
                    update((c) => ({ ...c, weekdays: move(c.weekdays, i, d) }))
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    update((c) => ({
                      ...c,
                      weekdays:
                        c.weekdays.length > 1
                          ? c.weekdays.filter((_, j) => j !== i)
                          : c.weekdays,
                    }))
                  }
                  disabled={draft.weekdays.length <= 1}
                  aria-label="Remove weekday"
                  className="text-ink-600 hover:text-red-300 disabled:opacity-30"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update((c) => ({
                  ...c,
                  weekdays: [...c.weekdays, `Day ${c.weekdays.length + 1}`],
                }))
              }
            >
              <Plus size={14} /> Add weekday
            </Button>
            <label className="text-[11px] text-ink-400">
              Day 1 of year 1 was a
              <select
                value={Math.min(draft.epochWeekday, draft.weekdays.length - 1)}
                onChange={(e) =>
                  update((c) => ({
                    ...c,
                    epochWeekday: Number(e.target.value),
                  }))
                }
                className={`${FIELD} ml-2`}
              >
                {draft.weekdays.map((w, i) => (
                  <option key={i} value={i}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {/* Eras */}
        <section>
          <SectionTitle>Eras</SectionTitle>
          <p className="mb-2 text-xs text-ink-500">
            Optional. Years are shown relative to the era they fall in, for
            example absolute year 1492 in an era starting at year 1 reads as
            “1492 DR”.
          </p>
          {draft.eras.length > 0 && (
            <ol className="space-y-1">
              {draft.eras.map((era, i) => (
                <li key={i} className="flex items-center gap-2">
                  <input
                    value={era.name}
                    placeholder="Name"
                    onChange={(e) =>
                      update((c) => ({
                        ...c,
                        eras: replaceAt(c.eras, i, {
                          ...era,
                          name: e.target.value,
                        }),
                      }))
                    }
                    className={`${FIELD} flex-1`}
                    aria-label="Era name"
                  />
                  <input
                    value={era.abbreviation}
                    placeholder="Abbr."
                    onChange={(e) =>
                      update((c) => ({
                        ...c,
                        eras: replaceAt(c.eras, i, {
                          ...era,
                          abbreviation: e.target.value,
                        }),
                      }))
                    }
                    className={`${FIELD} w-20`}
                    aria-label="Era abbreviation"
                  />
                  <span className="text-[11px] text-ink-600">from year</span>
                  <input
                    type="number"
                    value={era.startYear}
                    onChange={(e) =>
                      update((c) => ({
                        ...c,
                        eras: sortEras(
                          replaceAt(c.eras, i, {
                            ...era,
                            startYear: Number(e.target.value) || 0,
                          }),
                        ),
                      }))
                    }
                    className={`${FIELD} w-24`}
                    aria-label="Era start year"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      update((c) => ({
                        ...c,
                        eras: c.eras.filter((_, j) => j !== i),
                      }))
                    }
                    aria-label="Remove era"
                    className="text-ink-600 hover:text-red-300"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() =>
              update((c) => ({
                ...c,
                eras: sortEras([
                  ...c.eras,
                  { name: "New era", abbreviation: "", startYear: 1 },
                ]),
              }))
            }
          >
            <Plus size={14} /> Add era
          </Button>
        </section>

        <section className="border-t border-ink-800 pt-4">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update(() => ({ ...DEFAULT_CALENDAR, today: null }))}
          >
            Reset to a 12-month, 7-day calendar
          </Button>
          <p className="mt-2 text-xs text-ink-600">
            Every year has the same length; there are no leap years. Changes
            save automatically.
          </p>
        </section>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </h3>
  );
}

function MoveButtons({
  isFirst,
  isLast,
  onMove,
}: {
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={isFirst}
        aria-label="Move up"
        className="text-ink-600 hover:text-ink-300 disabled:opacity-30"
      >
        <ArrowUp size={13} />
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={isLast}
        aria-label="Move down"
        className="text-ink-600 hover:text-ink-300 disabled:opacity-30"
      >
        <ArrowDown size={13} />
      </button>
    </>
  );
}

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  return list.map((x, i) => (i === index ? value : x));
}

function move<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function sortEras(eras: CalendarEra[]): CalendarEra[] {
  return eras.slice().sort((a, b) => a.startYear - b.startYear);
}

export type { CalendarMonth };
