/**
 * The campaign's own calendar: months of any length, named weekdays, eras,
 * and the in-world "today". Stored in `campaign.json` under `calendar`.
 *
 * Dates are `{ year, month, day }` with month and day both 1-based. There are
 * no leap years in this first version: every year has the same length, which
 * keeps day arithmetic exact and is how most fantasy calendars are written.
 */
import type { CampaignMeta } from "@/lib/types";

export interface CalendarMonth {
  name: string;
  days: number;
}

export interface CalendarEra {
  name: string;
  /** Shown after the year, e.g. "DR" in "1492 DR". */
  abbreviation: string;
  /** First year of this era, in absolute years. */
  startYear: number;
}

export interface WorldDate {
  year: number;
  /** 1-based month index. */
  month: number;
  /** 1-based day of month. */
  day: number;
}

export interface Calendar {
  name: string;
  months: CalendarMonth[];
  weekdays: string[];
  eras: CalendarEra[];
  /** Weekday index (into `weekdays`) of day 1 of month 1 of year 1. */
  epochWeekday: number;
  /** The in-world current date, if the GM has set one. */
  today: WorldDate | null;
}

export const DEFAULT_CALENDAR: Calendar = {
  name: "Calendar",
  months: [
    { name: "January", days: 31 },
    { name: "February", days: 28 },
    { name: "March", days: 31 },
    { name: "April", days: 30 },
    { name: "May", days: 31 },
    { name: "June", days: 30 },
    { name: "July", days: 31 },
    { name: "August", days: 31 },
    { name: "September", days: 30 },
    { name: "October", days: 31 },
    { name: "November", days: 30 },
    { name: "December", days: 31 },
  ],
  weekdays: [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ],
  eras: [],
  epochWeekday: 0,
  today: null,
};

// ---- Parsing -----------------------------------------------------------------

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function readWorldDate(v: unknown): WorldDate | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const year = int(o.year);
  const month = int(o.month);
  const day = int(o.day);
  if (year === null || month === null || day === null) return null;
  if (month < 1 || day < 1) return null;
  return { year, month, day };
}

export function readCalendar(campaign: Record<string, unknown>): Calendar {
  const raw =
    campaign.calendar && typeof campaign.calendar === "object"
      ? (campaign.calendar as Record<string, unknown>)
      : null;
  if (!raw) return DEFAULT_CALENDAR;

  const months: CalendarMonth[] = Array.isArray(raw.months)
    ? raw.months.flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const o = m as Record<string, unknown>;
        const name = str(o.name);
        const days = int(o.days);
        return name && days && days > 0 ? [{ name, days }] : [];
      })
    : [];
  const weekdays = Array.isArray(raw.weekdays)
    ? raw.weekdays.filter(
        (w): w is string => typeof w === "string" && !!w.trim(),
      )
    : [];
  const eras: CalendarEra[] = Array.isArray(raw.eras)
    ? raw.eras.flatMap((e) => {
        if (!e || typeof e !== "object") return [];
        const o = e as Record<string, unknown>;
        const name = str(o.name);
        const startYear = int(o.startYear);
        return name && startYear !== null
          ? [{ name, abbreviation: str(o.abbreviation) ?? "", startYear }]
          : [];
      })
    : [];

  return {
    name: str(raw.name) ?? DEFAULT_CALENDAR.name,
    months: months.length ? months : DEFAULT_CALENDAR.months,
    weekdays: weekdays.length ? weekdays : DEFAULT_CALENDAR.weekdays,
    eras: eras.sort((a, b) => a.startYear - b.startYear),
    epochWeekday: int(raw.epochWeekday) ?? 0,
    today: readWorldDate(raw.today),
  };
}

// ---- Arithmetic --------------------------------------------------------------

export function daysInYear(cal: Calendar): number {
  return cal.months.reduce((n, m) => n + m.days, 0);
}

export function daysInMonth(cal: Calendar, month: number): number {
  return cal.months[month - 1]?.days ?? 30;
}

/** Days since day 1 of month 1 of year 1 (which is day 0). Years may be 0 or negative. */
export function dayIndex(cal: Calendar, d: WorldDate): number {
  let n = (d.year - 1) * daysInYear(cal);
  for (let m = 1; m < d.month; m++) n += daysInMonth(cal, m);
  return n + (d.day - 1);
}

export function compareDates(
  cal: Calendar,
  a: WorldDate,
  b: WorldDate,
): number {
  return dayIndex(cal, a) - dayIndex(cal, b);
}

/** Keeps a date inside the calendar after the calendar itself changed. */
export function clampDate(cal: Calendar, d: WorldDate): WorldDate {
  const month = Math.min(Math.max(1, d.month), cal.months.length);
  const day = Math.min(Math.max(1, d.day), daysInMonth(cal, month));
  return { year: d.year, month, day };
}

export function addDays(cal: Calendar, d: WorldDate, delta: number): WorldDate {
  const dpy = daysInYear(cal);
  let n = dayIndex(cal, d) + delta;
  const year = Math.floor(n / dpy) + 1;
  n -= (year - 1) * dpy;
  let month = 1;
  while (month < cal.months.length && n >= daysInMonth(cal, month)) {
    n -= daysInMonth(cal, month);
    month++;
  }
  return { year, month, day: n + 1 };
}

export function weekdayOf(cal: Calendar, d: WorldDate): string {
  const count = cal.weekdays.length;
  if (count === 0) return "";
  const idx = (((cal.epochWeekday + dayIndex(cal, d)) % count) + count) % count;
  return cal.weekdays[idx] ?? "";
}

export function eraFor(cal: Calendar, year: number): CalendarEra | null {
  let found: CalendarEra | null = null;
  for (const era of cal.eras) {
    if (era.startYear <= year) found = era;
  }
  return found;
}

// ---- Formatting --------------------------------------------------------------

export function formatYear(cal: Calendar, year: number): string {
  const era = eraFor(cal, year);
  if (!era) return String(year);
  const inEra = year - era.startYear + 1;
  return era.abbreviation
    ? `${inEra} ${era.abbreviation}`
    : `${inEra} ${era.name}`;
}

export function formatWorldDate(
  cal: Calendar,
  d: WorldDate,
  opts: { weekday?: boolean } = {},
): string {
  const month = cal.months[d.month - 1]?.name ?? `Month ${d.month}`;
  const base = `${d.day} ${month} ${formatYear(cal, d.year)}`;
  return opts.weekday ? `${weekdayOf(cal, d)}, ${base}` : base;
}

export function formatMonthYear(cal: Calendar, d: WorldDate): string {
  const month = cal.months[d.month - 1]?.name ?? `Month ${d.month}`;
  return `${month} ${formatYear(cal, d.year)}`;
}

/** "in 3 days", "today", "12 days ago", "2 years ago" relative to today. */
export function relativeToToday(cal: Calendar, d: WorldDate): string | null {
  if (!cal.today) return null;
  const diff = dayIndex(cal, d) - dayIndex(cal, cal.today);
  if (diff === 0) return "today";
  const abs = Math.abs(diff);
  const dpy = daysInYear(cal);
  const unit =
    abs >= dpy * 2
      ? `${Math.round(abs / dpy)} years`
      : abs >= dpy
        ? "1 year"
        : abs === 1
          ? "1 day"
          : `${abs} days`;
  return diff > 0 ? `in ${unit}` : `${unit} ago`;
}

export function calendarOf(campaign: CampaignMeta | null): Calendar {
  return campaign ? readCalendar(campaign) : DEFAULT_CALENDAR;
}
