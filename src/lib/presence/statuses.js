/**
 * The status registry: how each roster state looks and reads. A status is
 * data, so a new one (say "busy") is one `defineStatus` call here and one
 * variant on the host's `RosterState`; the bubbles need no change.
 *
 *   defineStatus("busy", {
 *     label: "busy",                       // short word, for the record
 *     face: "idle",                        // optional face style: "idle" | "gone"
 *     badge: { icon: "moon", tone: "muted" },  // or { dot: true, tone: "here" }
 *     detail: (entry, ctx) => "busy",      // words after the name
 *     badgeTip: (entry, ctx) => "Busy",    // optional: hovering the badge
 *     ticks: false,                        // true if detail changes over time
 *   });
 *
 * `ctx` is `{ now, offset }`: this device's clock and how far it is ahead
 * of the host's, for anything that says "for 7 min".
 */

import { elapsedSince, formatDuration } from "./time.js";

/** @type {Map<string, object>} */
const STATUSES = new Map();

export function defineStatus(id, def) {
  STATUSES.set(id, {
    label: id,
    face: "",
    badge: null,
    detail: () => def.label ?? id,
    badgeTip: null,
    ticks: false,
    ...def,
  });
}

/** The definition for a state; an unknown one falls back to plain words,
 *  so a newer host never breaks an older page. */
export function statusOf(id) {
  return (
    STATUSES.get(id) ?? {
      label: String(id),
      face: "",
      badge: null,
      detail: () => String(id),
      badgeTip: null,
      ticks: false,
    }
  );
}

function awayFor(entry, ctx) {
  return entry.awaySince == null
    ? ""
    : formatDuration(elapsedSince(entry.awaySince, ctx.now, ctx.offset));
}

defineStatus("active", {
  label: "here",
  badge: { dot: true, tone: "here" },
  detail: () => "here",
});

defineStatus("away", {
  label: "away",
  face: "idle",
  badge: { icon: "moon", tone: "muted" },
  detail: (entry, ctx) => {
    const span = awayFor(entry, ctx);
    return !span
      ? "away"
      : span === "just now"
        ? "away just now"
        : "away for " + span;
  },
  badgeTip: (entry, ctx) => {
    const span = awayFor(entry, ctx);
    return !span
      ? "Away"
      : span === "just now"
        ? "Away just now"
        : "Away for " + span;
  },
  ticks: true,
});

defineStatus("disconnected", {
  label: "disconnected",
  face: "gone",
  badge: { icon: "wifi-off", tone: "off" },
  detail: () => "disconnected",
  badgeTip: () => "Disconnected",
});
