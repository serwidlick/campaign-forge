import { CalendarCog, Plus } from "lucide-react";
import { Fragment, useMemo } from "react";

import { Button } from "@/components/Button";
import { kindById, type ElementSummary } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import {
  calendarOf,
  compareDates,
  dayIndex,
  formatMonthYear,
  formatWorldDate,
  formatYear,
  readWorldDate,
  relativeToToday,
  type Calendar,
  type WorldDate,
} from "./calendar-model";

interface TimelineItem {
  element: ElementSummary;
  date: WorldDate;
  until: WorldDate | null;
}

/** Which frontmatter field holds an element's in-world date, by kind. */
function dateOf(e: ElementSummary): WorldDate | null {
  if (e.type === "event") return readWorldDate(e.when);
  if (e.type === "session") return readWorldDate(e.worldDate);
  return null;
}

/**
 * Every dated element in calendar order, grouped by year and month, with a
 * marker for the in-world today.
 */
export function TimelineList({
  selectedId,
  onOpenCalendar,
  calendarOpen,
}: {
  selectedId: string | null;
  onOpenCalendar: () => void;
  calendarOpen: boolean;
}) {
  const campaign = useCampaignStore((s) => s.campaign);
  const elements = useCampaignStore((s) => s.elements);
  const navigate = useCampaignStore((s) => s.navigate);
  const createElement = useCampaignStore((s) => s.createElement);
  const calendar = useMemo(() => calendarOf(campaign), [campaign]);

  const items = useMemo(() => {
    const dated: TimelineItem[] = [];
    for (const e of elements) {
      const date = dateOf(e);
      if (!date) continue;
      dated.push({
        element: e,
        date,
        until: e.type === "event" ? readWorldDate(e.until) : null,
      });
    }
    return dated.sort(
      (a, b) =>
        compareDates(calendar, a.date, b.date) ||
        a.element.name.localeCompare(b.element.name),
    );
  }, [elements, calendar]);

  const todayIndex = calendar.today ? dayIndex(calendar, calendar.today) : null;

  async function handleNewEvent() {
    await createElement("event", "New event", {
      when: calendar.today ?? { year: 1, month: 1, day: 1 },
    });
  }

  // Group consecutive items by year, then month.
  const groups = useMemo(
    () => groupByMonth(calendar, items),
    [calendar, items],
  );

  // The today marker sits before the first item after today, or at the end.
  const markerBeforeId = useMemo(() => {
    if (todayIndex === null) return null;
    return (
      items.find((i) => dayIndex(calendar, i.date) > todayIndex)?.element.id ??
      null
    );
  }, [items, todayIndex, calendar]);
  const markerAtEnd =
    todayIndex !== null && markerBeforeId === null && items.length > 0;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink-100">{calendar.name}</div>
          <div className="truncate text-[11px] text-ink-500">
            {calendar.today
              ? `Today: ${formatWorldDate(calendar, calendar.today, { weekday: true })}`
              : "No in-world date set"}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenCalendar}
          title="Calendar settings"
          aria-label="Calendar settings"
          aria-pressed={calendarOpen}
          className={`rounded-md p-1.5 ${
            calendarOpen
              ? "bg-ember-500/25 text-ember-200"
              : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
          }`}
        >
          <CalendarCog size={14} />
        </button>
        <Button size="sm" onClick={() => void handleNewEvent()}>
          <Plus size={14} /> Event
        </Button>
      </div>

      <ul className="flex-1 overflow-y-auto py-1">
        {items.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-ink-500">
            Nothing dated yet. Give an event a “When” or a session a world date
            and it appears here.
          </li>
        )}
        {groups.map((g) => (
          <Fragment key={g.key}>
            <li className="sticky top-0 z-[1] bg-ink-850/95 px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500 backdrop-blur">
              {g.label}
            </li>
            {g.items.map((item) => {
              const idx = dayIndex(calendar, item.date);
              const showToday = item.element.id === markerBeforeId;
              const isToday = todayIndex !== null && idx === todayIndex;
              const relative = relativeToToday(calendar, item.date);
              return (
                <Fragment key={item.element.id}>
                  {showToday && <TodayMarker calendar={calendar} />}
                  <li>
                    <button
                      type="button"
                      onClick={(ev) =>
                        void navigate(item.element.id, {
                          pane: ev.ctrlKey || ev.metaKey,
                        })
                      }
                      title="Click to open · Ctrl+click to open beside"
                      className={`flex w-full items-start gap-3 px-4 py-2 text-left transition-colors ${
                        item.element.id === selectedId
                          ? "bg-ink-700/60"
                          : "hover:bg-ink-800"
                      }`}
                    >
                      <span
                        className={`mt-0.5 w-7 shrink-0 text-right font-mono text-xs ${
                          isToday ? "text-ember-300" : "text-ink-400"
                        }`}
                      >
                        {item.date.day}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-100">
                          {item.element.name}
                        </span>
                        <span className="block text-[11px] text-ink-500">
                          {kindById(item.element.type).label}
                          {item.until && (
                            <>
                              {" "}
                              · until {formatWorldDate(calendar, item.until)}
                            </>
                          )}
                          {relative && <> · {relative}</>}
                        </span>
                      </span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
        {markerAtEnd && <TodayMarker calendar={calendar} />}
      </ul>
    </>
  );
}

function TodayMarker({ calendar }: { calendar: Calendar }) {
  if (!calendar.today) return null;
  return (
    <li className="flex items-center gap-2 px-4 py-1 text-[11px] text-ember-300">
      <span className="h-px flex-1 bg-ember-500/60" />
      <span>Today · {formatWorldDate(calendar, calendar.today)}</span>
      <span className="h-px flex-1 bg-ember-500/60" />
    </li>
  );
}

function groupByMonth(
  calendar: Calendar,
  items: TimelineItem[],
): { key: string; label: string; items: TimelineItem[] }[] {
  const groups: { key: string; label: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const key = `${item.date.year}-${item.date.month}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      const sameYear =
        last && last.key.split("-")[0] === String(item.date.year);
      groups.push({
        key,
        label: sameYear
          ? formatMonthYear(calendar, item.date)
          : `${formatYear(calendar, item.date.year)} · ${formatMonthYear(calendar, item.date)}`,
        items: [item],
      });
    }
  }
  return groups;
}
