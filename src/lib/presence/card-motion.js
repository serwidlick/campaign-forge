/**
 * Motion for a person's card and its messages, in the same style as the
 * bubbles' own (motion.js): only `transform` and `opacity`, through the Web
 * Animations API, tuning in frozen objects, everything skipped for reduced
 * motion. The card owns its animations: starting one cancels the one in
 * flight, and the logical state never waits for an animation (a closing
 * card is inert at once, and gone when its fold ends or a timer says so).
 */

import { prefersReducedMotion, tripFrames } from "./motion.js";

export const CARD = Object.freeze({
  /** Growing out of the bubble. */
  open: 320,
  openEasing: "cubic-bezier(0.22, 0.9, 0.3, 1.12)",
  /** Folding back into it. */
  close: 200,
  closeEasing: "cubic-bezier(0.4, 0, 0.7, 0.2)",
  /** How small the card is at the bubble. */
  from: 0.25,
  /** Sliding to another person, and the content swap. */
  glide: 260,
  glideEasing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** Each section after the one before, on opening. */
  stagger: 40,
});

export const ENVELOPE = Object.freeze({
  duration: 620,
  stagger: 0,
  arc: 0.22,
  maxArc: 36,
  squeeze: 1.2,
  easing: "cubic-bezier(0.3, 0.7, 0.3, 1)",
});

export const MESSAGE = Object.freeze({
  /** A message easing into the conversation. */
  emerge: 240,
  /** The status line changing words, and "Seen" moving along. */
  status: 180,
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
});

function animate(el, keyframes, options) {
  if (prefersReducedMotion() || typeof el?.animate !== "function") return null;
  try {
    return el.animate(keyframes, options);
  } catch {
    return null;
  }
}

/** Cancels whatever the card itself is playing. */
export function settle(card) {
  for (const a of card.getAnimations?.() ?? []) {
    if (a.effect?.target === card) a.cancel();
  }
}

/** The card grows out of `origin` (a point relative to the card), then its
 *  sections rise in one after another. */
export function grow(card, origin, sections = []) {
  settle(card);
  card.style.transformOrigin = origin
    ? `${Math.round(origin.x)}px ${Math.round(origin.y)}px`
    : "";
  animate(
    card,
    [
      { transform: `scale(${origin ? CARD.from : 0.96})`, opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: CARD.open, easing: CARD.openEasing },
  );
  sections.forEach((section, i) => {
    animate(
      section,
      [
        { transform: "translateY(6px)", opacity: 0 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      {
        duration: CARD.open - 60,
        delay: 60 + i * CARD.stagger,
        easing: CARD.glideEasing,
        fill: "backwards",
      },
    );
  });
}

/** Folds the card back into `origin` (or fades it where it is), then calls
 *  `done`, which removes it. `done` runs exactly once, also when the page's
 *  clock is paused. */
export function fold(card, origin, done) {
  settle(card);
  card.inert = true;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  card.style.transformOrigin = origin
    ? `${Math.round(origin.x)}px ${Math.round(origin.y)}px`
    : "";
  const a = animate(
    card,
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: `scale(${origin ? CARD.from : 0.96})`, opacity: 0 },
    ],
    { duration: CARD.close, easing: CARD.closeEasing, fill: "forwards" },
  );
  if (!a) return finish();
  a.finished.then(finish, finish);
  setTimeout(finish, CARD.close + 250);
}

/** The card was at `before` and has been placed somewhere new: it glides
 *  there, and its content fades over. */
export function glide(card, before, body) {
  const now = card.getBoundingClientRect();
  const dx = before.left - now.left;
  const dy = before.top - now.top;
  settle(card);
  if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
    animate(
      card,
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: "translate(0, 0)" },
      ],
      { duration: CARD.glide, easing: CARD.glideEasing },
    );
  }
  if (body) {
    animate(body, [{ opacity: 0 }, { opacity: 1 }], {
      duration: CARD.glide,
      easing: "ease-out",
    });
  }
}

/** A message eases into the conversation. */
export function emergeMessage(node) {
  animate(
    node,
    [
      { transform: "translateY(8px) scale(0.97)", opacity: 0 },
      { transform: "translateY(0) scale(1)", opacity: 1 },
    ],
    { duration: MESSAGE.emerge, easing: MESSAGE.easing },
  );
}

/** Messages that stayed glide from where they were (`before`, a Map of
 *  node to rect) to where they are now. */
export function slideMessages(nodes, before) {
  for (const node of nodes) {
    const from = before.get(node);
    if (!from) continue;
    const to = node.getBoundingClientRect();
    const dy = from.top - to.top;
    if (Math.abs(dy) < 1) continue;
    animate(
      node,
      [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      { duration: MESSAGE.emerge, easing: MESSAGE.easing },
    );
  }
}

/** The status line ("Sending…", "Sent", "Seen") changing words, or moving
 *  to a newer message (from `before`, its old rect). */
export function statusChanged(node, before) {
  if (before) {
    const now = node.getBoundingClientRect();
    const dy = before.top - now.top;
    if (Math.abs(dy) >= 1) {
      animate(
        node,
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: MESSAGE.emerge, easing: MESSAGE.easing },
      );
      return;
    }
  }
  animate(node, [{ opacity: 0 }, { opacity: 1 }], {
    duration: MESSAGE.status,
    easing: "ease-out",
  });
}

/**
 * A small envelope travels from one bubble to another, on an arc like the
 * bubbles' own shuffle, inside `layer` (positioned with `base`, the
 * layer's rect). `icon` is the envelope's content.
 */
export function envelope(layer, base, from, to, icon) {
  if (prefersReducedMotion()) return;
  const node = document.createElement("span");
  node.className = "envelope";
  node.setAttribute("aria-hidden", "true");
  if (icon) node.appendChild(icon);
  const size = 22;
  const end = {
    x: to.left + to.width / 2 - size / 2 - base.left,
    y: to.top + to.height / 2 - size / 2 - base.top,
  };
  node.style.left = Math.round(end.x) + "px";
  node.style.top = Math.round(end.y) + "px";
  layer.appendChild(node);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const frames = tripFrames(dx, dy, 0, ENVELOPE).map((f, i, all) => ({
    ...f,
    opacity: i === all.length - 1 ? 0 : 1,
  }));
  const a = animate(node, frames, {
    duration: ENVELOPE.duration,
    easing: ENVELOPE.easing,
    fill: "forwards",
  });
  const remove = () => node.remove();
  if (!a) return remove();
  a.finished.then(remove, remove);
  setTimeout(remove, ENVELOPE.duration + 250);
}
