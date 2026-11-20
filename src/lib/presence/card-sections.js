/**
 * What a person's card is made of: sections, top to bottom, and actions,
 * as buttons in its header. Both are registries, like statuses and
 * activities, so a feature adds itself without touching the card:
 *
 *   defineCardSection("dice", {
 *     order: 200,                          // where it sits, top to bottom
 *     when: (entry, ctx) => !entry.self,   // shown for this person? (each render)
 *     mount: (root, entry, api) => handle, // built once per (section, person)
 *     update: (handle, entry, ctx) => {},  // same person, new state
 *     unmount: (handle) => {},             // api.signal aborts first
 *   });
 *
 *   defineCardAction("spotlight", {
 *     label: "Show to",                    // its accessible name and tip
 *     icon: "eye",                         // an icon name (icons.js)
 *     when: (entry, ctx) => ctx.isGm,
 *     run: (entry, api) => api.emit("spotlight", { to: entry.key }),
 *   });
 *
 * `ctx` is `{ you, me, now, offset, state(id) }`: your key and roster
 * entry, the clock, and whatever the page handed a section with
 * `el.setSectionState(id, value)`. `api` is `{ emit(name, detail),
 * state(id), announce(text), signal, motion }`: `emit` dispatches
 * `table-presence:<name>` on the element for the page to act on. Sections
 * build their DOM with `textContent` only and style through the stylesheet,
 * which keeps the phone page's strict CSP happy.
 */

import { rosterColour, rosterInitials } from "../table-live.js";
import { statusOf } from "./statuses.js";

const SECTIONS = new Map();
const ACTIONS = new Map();

export function defineCardSection(id, def) {
  SECTIONS.set(id, {
    id,
    order: 100,
    when: () => true,
    update: () => {},
    unmount: () => {},
    ...def,
  });
}

export function defineCardAction(id, def) {
  ACTIONS.set(id, {
    id,
    label: id,
    icon: null,
    when: () => true,
    ...def,
  });
}

function pick(registry, entry, ctx) {
  const out = [];
  for (const def of registry.values()) {
    try {
      if (def.when(entry, ctx)) out.push(def);
    } catch {
      // A section that cannot decide is left out, never breaks the card.
    }
  }
  return out;
}

/** The sections to show for `entry`, in order. */
export function cardSections(entry, ctx) {
  return pick(SECTIONS, entry, ctx).sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
}

/** The header actions to show for `entry`. */
export function cardActions(entry, ctx) {
  return pick(ACTIONS, entry, ctx);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function roleOf(entry) {
  if (entry.role === "host") return "GM, hosting";
  if (entry.role === "gm") return "GM";
  if (entry.role === "guest") return "Guest";
  return "Player";
}

/* ---- Built in: who they are and how they are ------------------------- */

defineCardSection("header", {
  order: 0,
  mount(root) {
    const face = el("span", "card-face");
    face.setAttribute("aria-hidden", "true");
    const name = el("span", "card-name");
    const detail = el("span", "card-detail");
    const words = el("span", "card-words");
    words.append(name, detail);
    root.append(face, words);
    return { face, name, detail };
  },
  update(h, entry, ctx) {
    h.face.style.setProperty("--tp-colour", rosterColour(entry.key));
    h.face.textContent = rosterInitials(entry.name);
    h.name.textContent = entry.self ? entry.name + " (you)" : entry.name;
    const status = statusOf(entry.state).detail(entry, ctx);
    h.detail.textContent = [roleOf(entry), status].filter(Boolean).join(" · ");
  },
});
