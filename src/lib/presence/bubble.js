/**
 * Bubbles: the round buttons the presence row is made of. One kind per
 * job, each a pair of functions: `create*` builds the button once, `paint*`
 * brings it up to date. Painting reuses the same element, so focus and any
 * running animation stay with it across roster updates.
 */

import { rosterColour, rosterInitials } from "../table-live.js";
import { activityOf } from "./activities.js";
import { icon } from "./icons.js";
import { statusOf } from "./statuses.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function people(n) {
  return n + (n === 1 ? " person" : " people");
}

function roleOf(entry) {
  if (entry.role === "host") return "GM, hosting";
  if (entry.role === "gm") return "GM";
  if (entry.role === "guest") return "Guest";
  return "";
}

/** A bubble button: a face, and a name tip shown on hover, focus or tap. */
export function createBubble(kind = "") {
  const bubble = el("button", kind ? "bubble " + kind : "bubble");
  bubble.type = "button";
  bubble.setAttribute("aria-describedby", "tp-hint");
  const face = el("span", "face");
  const tip = el("span", "tip");
  face.setAttribute("aria-hidden", "true");
  tip.setAttribute("aria-hidden", "true");
  bubble.append(face, tip);
  // Pop in, once, when someone arrives.
  bubble.classList.add("enter");
  bubble.addEventListener(
    "animationend",
    () => bubble.classList.remove("enter"),
    { once: true },
  );
  return bubble;
}

function faceOf(bubble) {
  return bubble.firstChild;
}

function setTip(bubble, text) {
  bubble.lastChild.textContent = text;
}

/** The corner badge for a status: a dot, or an icon with its own tip. */
function statusBadge(status, entry, ctx) {
  const badge = status.badge;
  if (!badge) return null;
  const tone = badge.tone ? " tone-" + badge.tone : "";
  const node = el("span", (badge.dot ? "status dot" : "status icon") + tone);
  if (badge.icon) node.appendChild(icon(badge.icon));
  const tipText = status.badgeTip?.(entry, ctx);
  if (tipText) node.appendChild(el("span", "badge-tip", tipText));
  return node;
}

/**
 * Paints one person: initials in their colour, a crown for a GM, their
 * status badge and, while they are doing something, its badge. Your own
 * bubble (`entry.self`, see view.js) gets a ring and a "You" tag; an entry
 * not known to be current (`entry.stale`) is dimmed and says so.
 * `ctx` is `{ now, offset, activity }`.
 */
export function paintPerson(bubble, entry, ctx) {
  const status = statusOf(entry.state);
  const activity = ctx.activity ? activityOf(ctx.activity) : null;
  const face = faceOf(bubble);
  face.className = status.face ? "face " + status.face : "face";
  face.style.setProperty("--tp-colour", rosterColour(entry.key));
  face.replaceChildren(rosterInitials(entry.name));
  if (entry.role === "host" || entry.role === "gm") {
    face.appendChild(icon("crown", "crown"));
  }
  const badge = statusBadge(status, entry, ctx);
  if (badge) face.appendChild(badge);
  if (activity?.badge) {
    face.appendChild(el("span", "activity")).appendChild(icon(activity.badge));
  }
  if (entry.self) face.appendChild(el("span", "you", "You"));
  const detail = status.detail(entry, ctx);
  const label = [
    entry.self ? entry.name + " (you)" : entry.name,
    roleOf(entry),
    entry.stale ? detail + " when last seen" : detail,
    activity?.label ?? "",
  ]
    .filter(Boolean)
    .join(", ");
  setTip(bubble, label);
  bubble.setAttribute("aria-label", label);
  bubble.dataset.state = entry.state;
  bubble.classList.toggle("me", Boolean(entry.self));
  bubble.classList.toggle("stale", Boolean(entry.stale));
  bubble.removeAttribute("aria-expanded");
  bubble.removeAttribute("aria-pressed");
}

/** "+N" while the rest are folded away; "−" once they are shown. */
export function paintCounter(bubble, { folded, expanded }) {
  const face = faceOf(bubble);
  face.className = "face count";
  face.replaceChildren(expanded ? "−" : "+" + folded);
  setTip(bubble, expanded ? "Fewer" : folded + " more");
  bubble.setAttribute(
    "aria-label",
    expanded
      ? "Show fewer people"
      : "Show " + people(folded).replace(/^(\d+) /, "$1 more "),
  );
  bubble.setAttribute("aria-expanded", String(expanded));
}

/** The eye: hides everyone else, and shows how many while they are hidden. */
export function paintEye(bubble, { hidden, count }) {
  const face = faceOf(bubble);
  face.className = "face eye";
  face.replaceChildren(icon(hidden ? "eye-off" : "eye", "eye-icon"));
  if (hidden) face.appendChild(el("span", "tally", String(count)));
  setTip(bubble, hidden ? count + " at the table" : "Hide");
  bubble.setAttribute(
    "aria-label",
    hidden
      ? "Show " + people(count) + " at the table"
      : "Hide the people at the table",
  );
  bubble.setAttribute("aria-pressed", String(hidden));
}
