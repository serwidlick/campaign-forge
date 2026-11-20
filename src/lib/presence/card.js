/**
 * A person's card: opens out of their bubble when it is pressed, and holds
 * whatever sections are registered (card-sections.js), the header first.
 * This file is only the frame: opening, closing and moving it, keeping it
 * placed, focus and keys, the live region, and the sections' life cycle.
 *
 * It is a non-modal dialog. The bubble that opened it gets
 * `aria-expanded`; Escape, the close button or the same bubble close it
 * and return focus to the bubble (or the eye, if the bubble is gone). A
 * press elsewhere closes it and leaves focus where the press put it.
 */

import { cardActions, cardSections } from "./card-sections.js";
import * as motion from "./card-motion.js";
import { icon } from "./icons.js";
import { CARD_GAP, SHEET_BELOW, placeCard } from "./placement.js";

const FOCUSABLE =
  "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";
/** How long "X has left" shows before the card folds away. */
const LEFT_NOTICE_MS = 1400;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Card {
  #host;
  #card = null;
  #body = null;
  #actions = null;
  #live = null;
  #name = null;
  #entry = null;
  /** Section instances for the person shown, by section id. */
  #sections = new Map();
  #closing = null;
  #leaving = 0;

  /**
   * `host` is what the element lends the card: `layer` (where it goes),
   * `element` (where its events are dispatched), `area()`, `side()`,
   * `bubbleFor(key)`, `context(entry)`, `state(id)`, `focusBubble(key)`,
   * `focusNext(key)` and `focusEye()`.
   */
  constructor(host) {
    this.#host = host;
  }

  /** The key of the person whose card is open, or null. */
  get key() {
    return this.#card ? this.#entry.key : null;
  }

  /** Whether `node` is inside the open card. */
  contains(node) {
    return Boolean(this.#card && node && this.#card.contains(node));
  }

  /** Opens `entry`'s card, or moves the open card to them. */
  open(entry) {
    if (this.key === entry.key) return;
    clearTimeout(this.#leaving);
    this.#leaving = 0;
    if (this.#card) {
      const before = this.#card.getBoundingClientRect();
      this.#setExpanded(false);
      this.#unmountAll();
      this.#entry = entry;
      this.#render();
      this.#place();
      motion.glide(this.#card, before, this.#body);
      this.#setExpanded(true);
      this.#focusFirst();
      return;
    }
    // A card still folding away goes at once.
    this.#closing?.remove();
    this.#closing = null;
    this.#entry = entry;
    this.#build();
    this.#render();
    const origin = this.#place();
    motion.grow(this.#card, origin, [...this.#body.children]);
    this.#setExpanded(true);
    this.#focusFirst();
  }

  /** Closes the card. `focus` is "bubble" (keyboard and close button),
   *  or "none" (a press elsewhere keeps its own focus). */
  close({ focus = "bubble" } = {}) {
    if (!this.#card) return;
    clearTimeout(this.#leaving);
    this.#leaving = 0;
    const bubble = this.#host.bubbleFor(this.#entry.key);
    const card = this.#card;
    this.#setExpanded(false);
    this.#unmountAll();
    const origin = bubble ? this.#originOf(bubble) : null;
    this.#card = null;
    this.#closing = card;
    motion.fold(card, origin, () => {
      card.remove();
      if (this.#closing === card) this.#closing = null;
    });
    if (focus === "bubble") {
      if (bubble?.isConnected) bubble.focus();
      else this.#host.focusEye();
    }
  }

  /** Brings the open card up to date: `entry` is the person as the roster
   *  now has them, or null if they left (the card says so, then folds). */
  refresh(entry) {
    if (!this.#card) return;
    if (!entry) {
      if (this.#leaving) return;
      const name = this.#entry.name;
      this.#body.classList.add("card-gone");
      this.#body.inert = true;
      const note = el("p", "card-left", name + " has left the table.");
      this.#body.appendChild(note);
      this.announce(name + " has left the table.");
      this.#leaving = setTimeout(() => {
        this.#leaving = 0;
        this.close({ focus: "none" });
      }, LEFT_NOTICE_MS);
      return;
    }
    this.#entry = entry;
    this.#render();
    this.#place();
    // A repaint of the bubble clears its card attributes; set them again.
    this.#setExpanded(true);
  }

  /** Keeps the card beside its bubble (after a resize, say). */
  reposition() {
    if (this.#card) this.#place();
  }

  /** Says something through the card's polite live region. */
  announce(text) {
    if (!this.#live) return;
    this.#live.textContent = "";
    // A fresh node each time, so the same words are announced again.
    this.#live.appendChild(el("span", "", text));
  }

  #build() {
    const card = el("div", "card");
    card.id = "tp-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-labelledby", "tp-card-name");
    const name = el("span", "sr-only");
    name.id = "tp-card-name";
    const top = el("div", "card-top");
    const actions = el("div", "card-actions");
    const close = el("button", "card-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.appendChild(icon("x"));
    close.addEventListener("click", () => this.close());
    top.append(actions, close);
    const body = el("div", "card-body");
    const live = el("div", "sr-only");
    live.setAttribute("aria-live", "polite");
    card.append(name, top, body, live);
    card.addEventListener("keydown", this.#onKey);
    this.#host.layer.appendChild(card);
    this.#card = card;
    this.#body = body;
    this.#actions = actions;
    this.#live = live;
    this.#name = name;
  }

  #render() {
    const entry = this.#entry;
    const ctx = this.#host.context(entry);
    this.#name.textContent = entry.self ? entry.name + " (you)" : entry.name;
    // Header actions.
    this.#actions.replaceChildren(
      ...cardActions(entry, ctx).map((action) => {
        const b = el("button", "card-action");
        b.type = "button";
        b.setAttribute("aria-label", action.label);
        b.title = action.label;
        if (action.icon) b.appendChild(icon(action.icon));
        b.addEventListener("click", () =>
          action.run(entry, this.#api(action.id, null)),
        );
        return b;
      }),
    );
    // Sections, keyed by (section, person): a new person mounts afresh.
    const wanted = cardSections(entry, ctx);
    const ids = new Set(wanted.map((s) => s.id));
    for (const [id, instance] of this.#sections) {
      if (!ids.has(id)) this.#unmount(id, instance);
    }
    wanted.forEach((def, index) => {
      let instance = this.#sections.get(def.id);
      if (!instance) {
        const root = el("section", "card-section section-" + def.id);
        const abort = new AbortController();
        instance = { def, root, abort, handle: null };
        try {
          instance.handle = def.mount(
            root,
            entry,
            this.#api(def.id, abort.signal),
          );
        } catch {
          return;
        }
        this.#sections.set(def.id, instance);
      }
      if (this.#body.children[index] !== instance.root) {
        this.#body.insertBefore(
          instance.root,
          this.#body.children[index] ?? null,
        );
      }
      try {
        def.update(instance.handle, entry, ctx);
      } catch {
        // One section's trouble never takes the card down.
      }
    });
  }

  #api(id, signal) {
    const element = this.#host.element;
    return {
      signal,
      motion,
      state: (sid) => this.#host.state(sid),
      announce: (text) => this.announce(text),
      emit: (name, detail) =>
        element.dispatchEvent(
          new CustomEvent("table-presence:" + name, {
            detail: { ...detail, section: id },
            bubbles: true,
            composed: true,
          }),
        ),
    };
  }

  #unmount(id, instance) {
    instance.abort.abort();
    try {
      instance.def.unmount(instance.handle);
    } catch {
      // Leaving anyway.
    }
    instance.root.remove();
    this.#sections.delete(id);
  }

  #unmountAll() {
    for (const [id, instance] of [...this.#sections]) {
      this.#unmount(id, instance);
    }
  }

  #originOf(bubble) {
    const card = this.#card.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    return {
      x: b.left + b.width / 2 - card.left,
      y: b.top + b.height / 2 - card.top,
    };
  }

  /** Places the card beside its bubble; returns the point it grows from. */
  #place() {
    const card = this.#card;
    const bubble = this.#host.bubbleFor(this.#entry.key);
    const area = this.#host.area();
    // Take the final shape first (a sheet on a narrow screen, never taller
    // than what is on screen, a phone's keyboard included), then measure:
    // the conversation scrolls inside whatever is left.
    const sheet = area.width < SHEET_BELOW;
    card.classList.toggle("sheet", sheet);
    card.style.width = sheet
      ? Math.max(0, area.width - 2 * CARD_GAP) + "px"
      : "";
    card.style.maxHeight = Math.max(160, area.height - 2 * CARD_GAP) + "px";
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const rect = bubble
      ? bubble.getBoundingClientRect()
      : {
          left: area.left + area.width / 2,
          top: area.top + area.height / 2,
          width: 0,
          height: 0,
        };
    const spot = placeCard(area, rect, this.#host.side(), size);
    card.style.left = Math.round(spot.x) + "px";
    card.style.top = Math.round(spot.y) + "px";
    return bubble ? spot.origin : null;
  }

  #setExpanded(open) {
    const bubble = this.#entry && this.#host.bubbleFor(this.#entry.key);
    if (!bubble) return;
    if (open) {
      bubble.setAttribute("aria-expanded", "true");
      bubble.setAttribute("aria-controls", "tp-card");
    } else {
      bubble.removeAttribute("aria-expanded");
      bubble.removeAttribute("aria-controls");
    }
  }

  #focusables() {
    return [...this.#card.querySelectorAll(FOCUSABLE)].filter(
      (n) => !n.closest("[inert]"),
    );
  }

  #focusFirst() {
    const preferred = this.#card.querySelector(
      "[data-autofocus]:not([disabled])",
    );
    (preferred ?? this.#card.querySelector(".card-close"))?.focus({
      preventScroll: true,
    });
  }

  #onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const all = this.#focusables();
    if (!all.length) return;
    const active = this.#card.getRootNode().activeElement;
    if (event.shiftKey && active === all[0]) {
      event.preventDefault();
      this.#host.focusBubble(this.#entry.key);
    } else if (!event.shiftKey && active === all.at(-1)) {
      event.preventDefault();
      this.#host.focusNext(this.#entry.key);
    }
  };
}
