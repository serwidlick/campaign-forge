import { X } from "lucide-react";

import {
  daysInMonth,
  eraFor,
  weekdayOf,
  type Calendar,
  type WorldDate,
} from "./calendar-model";

const FIELD =
  "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100 outline-none focus:border-ember-500";

/**
 * Picks a date in the campaign's calendar: year, month, day. Shows the
 * weekday and era for the chosen date so the GM can sanity-check it.
 */
export function WorldDatePicker({
  calendar,
  value,
  onChange,
  clearable = true,
  label,
}: {
  calendar: Calendar;
  value: WorldDate | null;
  onChange: (next: WorldDate | null) => void;
  clearable?: boolean;
  label?: string;
}) {
  const current: WorldDate = value ??
    calendar.today ?? { year: 1, month: 1, day: 1 };
  const maxDay = daysInMonth(calendar, current.month);
  const era = eraFor(calendar, current.year);

  function update(patch: Partial<WorldDate>) {
    const next = { ...current, ...patch };
    next.day = Math.min(next.day, daysInMonth(calendar, next.month));
    onChange(next);
  }

  return (
    <div className="text-[11px] text-ink-400">
      {label && <div>{label}</div>}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <select
          value={value ? current.day : ""}
          onChange={(e) => update({ day: Number(e.target.value) })}
          className={`${FIELD} w-16`}
          aria-label="Day"
        >
          {!value && <option value="">Day</option>}
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          value={value ? current.month : ""}
          onChange={(e) => update({ month: Number(e.target.value) })}
          className={`${FIELD} w-36`}
          aria-label="Month"
        >
          {!value && <option value="">Month</option>}
          {calendar.months.map((m, i) => (
            <option key={`${m.name}-${i}`} value={i + 1}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          value={value ? current.year : ""}
          placeholder="Year"
          onChange={(e) => {
            const year = Number(e.target.value);
            if (Number.isInteger(year)) update({ year });
          }}
          className={`${FIELD} w-24`}
          aria-label="Year"
        />
        {era && value && (
          <span className="text-ink-500" title={era.name}>
            {era.abbreviation || era.name}
          </span>
        )}
        {value && (
          <span className="text-ink-500">· {weekdayOf(calendar, current)}</span>
        )}
        {clearable && value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear date"
            className="rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-300"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
