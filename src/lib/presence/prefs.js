/**
 * Per-device presence preferences: which edge the bubbles sit on and
 * whether they are hidden. Kept in localStorage; every read and write
 * tolerates storage being missing, blocked or full.
 */

import { DEFAULT_SPOT, SIDES } from "./dock.js";

const DOCK_KEY = "cf.presence.dock";
const HIDDEN_KEY = "cf.presence.hidden";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The saved edge and place along it, or the default. */
export function readDock() {
  try {
    const spot = JSON.parse(storage()?.getItem(DOCK_KEY) ?? "null");
    if (
      spot &&
      SIDES.includes(spot.side) &&
      Number.isFinite(spot.t) &&
      spot.t >= 0 &&
      spot.t <= 1
    ) {
      return { side: spot.side, t: spot.t };
    }
  } catch {
    /* unreadable, or something else wrote there */
  }
  return { ...DEFAULT_SPOT };
}

export function writeDock(spot) {
  try {
    storage()?.setItem(DOCK_KEY, JSON.stringify(spot));
  } catch {
    /* no storage: the spot lasts until the page reloads */
  }
}

export function readHidden() {
  try {
    return storage()?.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHidden(hidden) {
  try {
    if (hidden) storage()?.setItem(HIDDEN_KEY, "1");
    else storage()?.removeItem(HIDDEN_KEY);
  } catch {
    /* no storage: the choice lasts until the page reloads */
  }
}
