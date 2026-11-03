import { useMemo } from "react";

import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { WorldDatePicker } from "./WorldDatePicker";
import {
  calendarOf,
  compareDates,
  formatWorldDate,
  readWorldDate,
  relativeToToday,
} from "./calendar-model";

/**
 * Structured part of an event: when it happens in the campaign's calendar,
 * and optionally when it ends. Everything else is the Markdown body.
 */
export function EventPanel({ element }: { element: Element }) {
  const campaign = useCampaignStore((s) => s.campaign);
  const saveElement = useCampaignStore((s) => s.saveElement);
  const calendar = useMemo(() => calendarOf(campaign), [campaign]);

  const when = readWorldDate(element.when);
  const until = readWorldDate(element.until);
  const relative = when ? relativeToToday(calendar, when) : null;
  const spanDays =
    when && until ? compareDates(calendar, until, when) + 1 : null;

  return (
    <section className="rounded-lg border border-ink-800 bg-ink-900/60 p-4">
      <div className="flex flex-wrap items-end gap-6">
        <WorldDatePicker
          label="When"
          calendar={calendar}
          value={when}
          onChange={(next) =>
            void saveElement(element.id, {
              when: next ?? undefined,
              // An end date cannot survive without a start date.
              ...(next ? {} : { until: undefined }),
            })
          }
        />
        {when && (
          <WorldDatePicker
            label="Until (optional)"
            calendar={calendar}
            value={until}
            onChange={(next) =>
              void saveElement(element.id, {
                until:
                  next && compareDates(calendar, next, when) >= 0
                    ? next
                    : undefined,
              })
            }
          />
        )}
      </div>
      {when && (
        <p className="mt-3 text-xs text-ink-400">
          {formatWorldDate(calendar, when, { weekday: true })}
          {until && ` → ${formatWorldDate(calendar, until, { weekday: true })}`}
          {spanDays !== null && spanDays > 1 && (
            <span className="text-ink-500"> · {spanDays} days</span>
          )}
          {relative && <span className="text-ink-500"> · {relative}</span>}
        </p>
      )}
      {!when && (
        <p className="mt-2 text-xs text-ink-600">
          Give this event a date and it appears on the timeline.
        </p>
      )}
    </section>
  );
}
