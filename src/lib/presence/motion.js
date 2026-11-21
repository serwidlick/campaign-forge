/**
 * Motion for the presence bubbles: every change to the group animates
 * instead of jumping. Four moves, all FLIP-style (measure, change the
 * layout, then animate each element from where it was):
 *
 * - shuffle: the group moves to another edge; each bubble travels on its
 *   own, one after another, weaving slightly, as a column becomes a row.
 * - slide:   bubbles that stay but move (someone left, a counter changed)
 *   glide to their new place.
 * - emerge:  bubbles appearing out of another one: people spilling out of
 *   the eye when shown, or out of "+N" when it opens.
 * - vanish:  bubbles leaving: folding into the eye or "+N", or shrinking
 *   away where they stood when someone leaves the table.
 *
 * Only `transform` and `opacity` are animated, through the Web Animations
 * API, so it is cheap and the phone page's strict CSP allows it. Everything
 * is skipped for people who ask for reduced motion.
 */

/** Tuning, in one place. */
export const SHUFFLE = Object.freeze({
  /** How long each bubble's trip takes. */
  duration: 460,
  /** How long each bubble waits after the one before it. */
  stagger: 34,
  /** How far a trip bows sideways, as a share of its length... */
  arc: 0.14,
  /** ...and at most, in pixels. */
  maxArc: 22,
  /** How small a bubble gets mid-trip. */
  squeeze: 0.88,
  /** A little overshoot as each bubble lands. */
  easing: "cubic-bezier(0.22, 0.9, 0.3, 1.12)",
});

export const SLIDE = Object.freeze({
  duration: 260,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
});

export const EMERGE = Object.freeze({
  duration: 360,
  stagger: 32,
  /** How small a bubble starts, inside the one it comes out of. */
  from: 0.3,
  easing: "cubic-bezier(0.22, 0.9, 0.3, 1.18)",
});

export const VANISH = Object.freeze({
  duration: 260,
  stagger: 26,
  /** How small a bubble ends: into another bubble, or where it stood. */
  into: 0.3,
  inPlace: 0.5,
  easing: "cubic-bezier(0.4, 0, 0.7, 0.2)",
});

/** Where an element is on screen right now, mid-animation included. */
export const onScreen = (el) => el.getBoundingClientRect();

/** Where each element is: on screen by default, or by `rectOf` (say, its
 *  laid-out place, ignoring any animation in flight). */
export function measure(elements, rectOf = onScreen) {
  return new Map(elements.map((el) => [el, rectOf(el)]));
}

function centre(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Elements nearest `point` first: a cascade out of, or into, one spot. */
function byDistance(elements, rects, point) {
  const distance = (el) => {
    const c = centre(rects.get(el));
    return Math.hypot(c.x - point.x, c.y - point.y);
  };
  return [...elements].sort((a, b) => distance(a) - distance(b));
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function at(x, y, scale) {
  return `translate(${round(x)}px, ${round(y)}px) scale(${scale})`;
}

export function prefersReducedMotion() {
  try {
    return Boolean(
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    );
  } catch {
    return false;
  }
}

function animate(el, keyframes, options) {
  if (typeof el.animate !== "function") return null;
  try {
    return el.animate(keyframes, options);
  } catch {
    return null;
  }
}

// ---- Shuffle ---------------------------------------------------------------

/**
 * The keyframes for one bubble's trip, from `(dx, dy)` away back to where
 * it now sits. Neighbours bow to opposite sides, which reads as the group
 * shuffling past itself rather than sliding as a block. Pure, so tested.
 */
export function tripFrames(dx, dy, index, tuning = SHUFFLE) {
  const length = Math.hypot(dx, dy);
  const bow = Math.min(tuning.maxArc, length * tuning.arc);
  // A unit vector at right angles to the trip, alternating side per bubble.
  const side = index % 2 === 0 ? 1 : -1;
  const nx = length ? (-dy / length) * bow * side : 0;
  const ny = length ? (dx / length) * bow * side : 0;
  return [
    { transform: at(dx, dy, 1) },
    { transform: at(dx / 2 + nx, dy / 2 + ny, tuning.squeeze), offset: 0.5 },
    { transform: at(0, 0, 1) },
  ];
}

/**
 * Plays the shuffle for `elements`, which were at `before` (from
 * `measure`) and have since been laid out in their new place. Elements
 * that did not move, or are new, are left alone. Returns the animations.
 */
export function shuffle(elements, before, tuning = SHUFFLE) {
  if (prefersReducedMotion()) return [];
  const played = [];
  let index = 0;
  for (const el of elements) {
    const from = before.get(el);
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const trip = animate(el, tripFrames(dx, dy, index, tuning), {
      duration: tuning.duration,
      delay: index * tuning.stagger,
      easing: tuning.easing,
      // Hold the old spot until each bubble's turn comes.
      fill: "backwards",
    });
    if (trip) played.push(trip);
    index += 1;
  }
  return played;
}

// ---- Slide -----------------------------------------------------------------

/** Glides elements that moved from `before` to where they are now (by
 *  `rectOf`). A moved element's own running motion is replaced. */
export function slide(elements, before, rectOf = onScreen, tuning = SLIDE) {
  if (prefersReducedMotion()) return;
  for (const el of elements) {
    const from = before.get(el);
    if (!from) continue;
    const to = rectOf(el);
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    revive(el);
    animate(el, [{ transform: at(dx, dy, 1) }, { transform: at(0, 0, 1) }], {
      duration: tuning.duration,
      easing: tuning.easing,
    });
  }
}

// ---- Emerge ----------------------------------------------------------------

/** Brings `elements` out of `origin` (a rect), nearest first, each growing
 *  from small inside it to its own place (by `rectOf`). */
export function emerge(elements, origin, rectOf = onScreen, tuning = EMERGE) {
  if (prefersReducedMotion() || !origin || !elements.length) return;
  const rects = measure(elements, rectOf);
  const from = centre(origin);
  byDistance(elements, rects, from).forEach((el, index) => {
    // This entrance replaces the plain pop-in.
    el.classList.remove("enter");
    revive(el);
    const to = centre(rects.get(el));
    animate(
      el,
      [
        {
          transform: at(from.x - to.x, from.y - to.y, tuning.from),
          opacity: 0,
        },
        { transform: at(0, 0, 1), opacity: 1 },
      ],
      {
        duration: tuning.duration,
        delay: index * tuning.stagger,
        easing: tuning.easing,
        fill: "backwards",
      },
    );
  });
}

// ---- Vanish ----------------------------------------------------------------

/**
 * Takes `elements` out of the layout and plays them out: into `target` (a
 * rect) if given, nearest first, or shrinking where they stood. They are
 * pinned where they were (`before`), relative to `layer`, while they go,
 * then removed. Calling `revive` on one brings it back mid-exit.
 */
export function vanish(
  elements,
  before,
  layer,
  target = null,
  tuning = VANISH,
) {
  if (!elements.length) return;
  const base = layer.getBoundingClientRect();
  const into = target ? centre(target) : null;
  const order = into ? byDistance(elements, before, into) : elements;
  order.forEach((el, index) => {
    const from = before.get(el);
    revive(el);
    // A pop-in not yet finished would restart when the bubble moves layer.
    el.classList.remove("enter");
    if (!from || prefersReducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add("exiting");
    el.style.left = round(from.left - base.left) + "px";
    el.style.top = round(from.top - base.top) + "px";
    layer.appendChild(el);
    const start = centre(from);
    const dx = into ? into.x - start.x : 0;
    const dy = into ? into.y - start.y : 0;
    const exit = animate(
      el,
      [
        { transform: at(0, 0, 1), opacity: 1 },
        {
          transform: at(dx, dy, into ? tuning.into : tuning.inPlace),
          opacity: 0,
        },
      ],
      {
        duration: tuning.duration,
        delay: index * tuning.stagger,
        easing: tuning.easing,
        fill: "both",
      },
    );
    // Gone once the exit ends, or soon after anyway if the page's clock is
    // not running (a background tab): nothing lingers in the layer.
    const done = () => {
      if (el.classList.contains("exiting")) el.remove();
    };
    if (!exit) {
      done();
      return;
    }
    exit.finished.then(done, () => {});
    setTimeout(done, tuning.duration + index * tuning.stagger + 250);
  });
}

/** Cancels an element's exit (and any other motion) so it can be laid out
 *  again as if nothing happened. Safe on elements that were not leaving. */
export function revive(el) {
  for (const animation of el.getAnimations?.() ?? []) {
    // Activities run on the face, not the bubble, so they are untouched.
    if (animation.effect?.target === el) animation.cancel();
  }
  if (el.classList.contains("exiting")) {
    el.classList.remove("exiting");
    el.style.left = "";
    el.style.top = "";
  }
}
