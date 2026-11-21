/**
 * A light buzz on phones for what the bubbles do: picking the group up,
 * dropping it on an edge, the eye and "+N", someone messaging you, losing
 * the host. Each moment is a named kind, so a page or an activity asks for
 * "snap", not for a number of milliseconds.
 *
 * The default driver is the Vibration API, which Android browsers (and the
 * app's Android WebView, with the VIBRATE permission) honour after the
 * first touch on the page. iOS Safari has no such API, so it stays silent
 * there. A page with something better (a native haptics bridge) replaces
 * the driver with `setHapticDriver`.
 *
 *   defineHaptic("dice", [12, 40, 12]);   // a pattern: buzz, pause, buzz (ms)
 *   haptic("dice");
 */

/** @type {Map<string, number[]>} */
const PATTERNS = new Map();

/** Adds or replaces a kind of buzz: a vibration pattern, in ms. */
export function defineHaptic(kind, pattern) {
  PATTERNS.set(kind, Array.isArray(pattern) ? [...pattern] : [pattern]);
}

defineHaptic("pick", [8]);
defineHaptic("snap", [12]);
defineHaptic("tap", [6]);
defineHaptic("notice", [14, 70, 14]);
defineHaptic("warn", [30, 60, 30]);

/** Buzzes through the Vibration API, where there is one. */
export function vibrate(kind, pattern) {
  const nav = globalThis.navigator;
  if (typeof nav?.vibrate !== "function") return false;
  try {
    return nav.vibrate(pattern);
  } catch {
    return false;
  }
}

let driver = vibrate;
let enabled = true;

/** Replaces how a buzz is made: `(kind, pattern) => void`. `null` puts the
 *  Vibration API back. */
export function setHapticDriver(next) {
  driver = typeof next === "function" ? next : vibrate;
}

/** Turns every buzz on or off, say from a page's own setting. */
export function setHapticsEnabled(on) {
  enabled = Boolean(on);
}

/** Buzzes for `kind`, if it is known and buzzing is on. Never throws. */
export function haptic(kind) {
  const pattern = PATTERNS.get(kind);
  if (!enabled || !pattern) return false;
  try {
    driver(kind, pattern);
    return true;
  } catch {
    return false;
  }
}
