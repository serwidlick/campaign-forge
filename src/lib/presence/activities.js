/**
 * The activity registry: short-lived things someone is doing, such as
 * sending a message, each with a badge and an animation of its bubble.
 * Nothing at the table sends activities yet; this is the place a feature
 * plugs into. Start one with `el.setActivity(key, id)`, or have the host
 * put `activity: id` on a roster entry.
 *
 *   defineActivity("rolling", {
 *     label: "rolling dice",            // added to the person's name
 *     badge: "dice",                    // an icon name (see icons.js), optional
 *     target: "face",                   // what moves: "face" (default) or "bubble"
 *     keyframes: ({ inward }) => [...], // Web Animations keyframes, or a
 *                                       // function of { side, inward }
 *     options: { duration: 900, iterations: Infinity, easing: "ease-in-out" },
 *     haptic: "notice",                 // optional: a buzz (see haptics.js) when
 *                                       // it starts on your own bubble
 *   });
 *
 * `inward` points from the bubbles' edge towards the middle of the screen,
 * so a "moving bubble" can lean out from wherever it is docked. Animations
 * run through the Web Animations API (no inline styles, so the phone page's
 * strict CSP is fine with them) and are skipped for people who ask for
 * reduced motion; the badge still shows.
 */

import { haptic } from "./haptics.js";

/** @type {Map<string, object>} */
const ACTIVITIES = new Map();

export function defineActivity(id, def) {
  ACTIVITIES.set(id, {
    label: id,
    badge: null,
    target: "face",
    keyframes: [],
    options: { duration: 1000, iterations: 1 },
    haptic: null,
    ...def,
  });
}

export function activityOf(id) {
  return ACTIVITIES.get(id) ?? null;
}

/** The direction from an edge towards the middle of the screen. */
export function inwardFrom(side) {
  switch (side) {
    case "right":
      return { x: -1, y: 0 };
    case "top":
      return { x: 0, y: 1 };
    case "bottom":
      return { x: 0, y: -1 };
    default:
      return { x: 1, y: 0 };
  }
}

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Plays an activity on a bubble and returns a handle to stop it. A finite
 * animation ends by itself; `iterations: Infinity` runs until stopped.
 * On your own bubble (`self`) it also buzzes, if the activity says how.
 */
export function playActivity(bubble, id, { side = "left", self = false } = {}) {
  const def = activityOf(id);
  if (!def) return { id, stop() {} };
  if (self && def.haptic) haptic(def.haptic);
  const target =
    def.target === "bubble"
      ? bubble
      : (bubble.querySelector(".face") ?? bubble);
  let animation = null;
  if (!prefersReducedMotion() && typeof target.animate === "function") {
    const keyframes =
      typeof def.keyframes === "function"
        ? def.keyframes({ side, inward: inwardFrom(side) })
        : def.keyframes;
    try {
      animation = target.animate(keyframes, def.options);
    } catch {
      animation = null;
    }
  }
  return {
    id,
    stop() {
      animation?.cancel();
    },
  };
}

/* ---- Built in: messaging, ready for when the table can message ---------- */

defineActivity("messaging", {
  label: "sending a message",
  badge: "message",
  // The bubble leans out from its edge and back, as if passing a note.
  keyframes: ({ inward }) => [
    { transform: "translate(0, 0)" },
    {
      transform: `translate(${inward.x * 7}px, ${inward.y * 7}px)`,
      offset: 0.45,
    },
    { transform: "translate(0, 0)" },
  ],
  options: { duration: 1100, iterations: Infinity, easing: "ease-in-out" },
});

defineActivity("messaged", {
  label: "has a new message",
  badge: "mail",
  // A ripple out of the bubble, a few times.
  keyframes: [
    { boxShadow: "0 0 0 0 rgb(230 154 87 / 0.7)" },
    { boxShadow: "0 0 0 12px rgb(230 154 87 / 0)" },
  ],
  options: {
    duration: 900,
    iterations: 3,
    easing: "ease-out",
    composite: "add",
  },
  // Felt as well as seen, on the phone being messaged.
  haptic: "notice",
});
