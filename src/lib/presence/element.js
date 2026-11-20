/**
 * <table-presence>: who is at the table, as bubbles docked to an edge of
 * the screen. This file only composes the parts:
 *
 * - bubble.js      the round buttons (people, "+N", the eye) and their paint
 * - statuses.js    what each state looks like (active, away, disconnected)
 * - activities.js  animated things people do (sending a message, ...)
 * - dock.js        edge geometry: placing, clamping, snapping
 * - motion.js      every change animates: shuffles between edges, hiding
 *                  into the eye, opening "+N", people arriving and leaving
 * - drag.js        press-and-drag with taps left as taps
 * - prefs.js       per-device choices (edge, hidden)
 * - view.js        the roster as this device sees it: you, and while offline
 * - haptics.js     a light buzz on phones for picks, snaps and taps
 * - card.js        a person's card, opened by pressing their bubble, made of
 *                  sections (card-sections.js; messages.js is one)
 * - chat.js        table messages for a page: state, resends, the card's events
 *
 * The page sets `.roster` (and `.clockOffset` when the roster came from
 * another machine), `.you` (which entry is this device's person) and
 * `.offline` (while it cannot reach the host); everything else happens
 * here. Card sections get their state through `setSectionState`. Names
 * only ever go in as text.
 */

import { playActivity } from "./activities.js";
import {
  createBubble,
  paintCounter,
  paintEye,
  paintInbox,
  paintPerson,
} from "./bubble.js";
import { Card } from "./card.js";
import { envelope } from "./card-motion.js";
import { icon } from "./icons.js";
import "./messages.js";
import { DragController } from "./drag.js";
import { haptic } from "./haptics.js";
import { emerge, measure, revive, shuffle, slide, vanish } from "./motion.js";
import {
  SIDES,
  clampToArea,
  isVertical,
  placeOnEdge,
  snapToEdge,
} from "./dock.js";
import { readDock, readHidden, writeDock, writeHidden } from "./prefs.js";
import { statusOf } from "./statuses.js";
import { promoteUnread, shownEntries, viewRoster } from "./view.js";

export const TAG = "table-presence";

/** Arrow keys on a focused bubble move the group to that edge. */
const ARROWS = {
  ArrowLeft: "left",
  ArrowUp: "top",
  ArrowRight: "right",
  ArrowDown: "bottom",
};
/** Bubbles shown before the rest fold into "+N" (which counts as one). */
const BUBBLES = 6;
const BUBBLES_NARROW = 4;
const NARROW = "(max-width: 480px)";
/** How often "away for 7 min" is brought up to date. */
const TICK_MS = 30_000;

export class TablePresence extends HTMLElement {
  #roster = [];
  #clockOffset = 0;
  #you = null;
  #offline = false;
  #spot = readDock();
  #pos = { x: 0, y: 0 };
  #concealed = readHidden();
  /** "+N" pressed: every bubble shows, wrapping along the edge if need be. */
  #expanded = false;
  #styled = false;
  #built = false;
  #narrow = null;
  #drag = null;
  #dragFrom = null;
  /** The bubbles' trips of the last shuffle, cancelled if another starts. */
  #shuffles = [];
  /** The bubble whose press caused the next render (the eye or "+N"):
   *  arrivals come out of it and departures fold into it. */
  #motion = null;
  #ticker = 0;
  /** A render is queued for the end of this task (see #update). */
  #queued = false;
  /** Bubbles by roster key, kept across updates so focus, animation and
   *  the pop-in stay with the right person. */
  #bubbles = new Map();
  /** Activities set from the page, by roster key; and those playing. */
  #activities = new Map();
  #playing = new Map();
  #more = null;
  #eye = null;
  #root;
  #anchor;
  #group;
  /** The open person's card, if any (card.js). */
  #card = null;
  /** What the page handed each card section (`setSectionState`). */
  #sectionState = new Map();
  /** Unread messages by person, and those counts as last painted. */
  #unread = {};
  #unreadShown = {};
  /** The roster as last painted (with `self` and `stale`), by key. */
  #entries = new Map();
  /** People who wrote to you, moved up the row, and how recently. */
  #priority = new Map();
  /** Beside the eye while everyone is hidden: messages waiting unread. */
  #inbox = null;

  constructor() {
    super();
    // No attributes here: an element made by createElement may not gain any
    // in its constructor. The DOM is built on first connection.
    this.#root = this.attachShadow({ mode: "open" });
  }

  /** Everyone at the table, host first: `{ key, name, role, state,
   *  awaySince?, activity? }`. */
  get roster() {
    return this.#roster;
  }

  set roster(entries) {
    this.#roster = Array.isArray(entries) ? entries : [];
    this.#update();
  }

  /** How far this device's clock is ahead of the host's (ms), so "away for"
   *  is right even when the two disagree. */
  get clockOffset() {
    return this.#clockOffset;
  }

  set clockOffset(ms) {
    this.#clockOffset = Number.isFinite(ms) ? ms : 0;
    this.#update();
  }

  /** The roster key of the person at this device, so their own bubble is
   *  marked "you" (and never folded into "+N"); `null` for none. */
  get you() {
    return this.#you;
  }

  set you(key) {
    const next = typeof key === "string" && key ? key : null;
    if (next === this.#you) return;
    this.#you = next;
    this.#update();
  }

  /** True while this device cannot reach the host: the host shows as
   *  disconnected and everyone else as last known (see view.js). Only a
   *  change does anything, so a page may set it on every retry. */
  get offline() {
    return this.#offline;
  }

  set offline(on) {
    const next = Boolean(on);
    if (next === this.#offline) return;
    this.#offline = next;
    if (next && this.#roster.length) haptic("warn");
    this.#update();
  }

  /** Starts an activity (see activities.js) on someone's bubble, or stops
   *  it with `null`. Wins over any activity the roster gives them. */
  setActivity(key, activity) {
    if (activity) this.#activities.set(key, activity);
    else this.#activities.delete(key);
    this.#update();
  }

  /** Hands a card section its state (for messages: chat.js does this). The
   *  open card is brought up to date. */
  setSectionState(id, value) {
    this.#sectionState.set(id, value);
    if (this.#card?.key) this.#update();
  }

  /** Unread messages by person key (and the total, for the hidden eye). */
  setUnread(per, total = 0) {
    const next = { ...(per ?? {}) };
    promoteUnread(this.#priority, this.#unread, next);
    this.#unread = next;
    this.#unreadTotal = total;
    this.#update();
  }

  /** Who to open from the inbox: whoever wrote most recently, unread. */
  #latestUnread() {
    let best = null;
    for (const key of Object.keys(this.#unread)) {
      if (!this.#unread[key] || !this.#entries.has(key)) continue;
      if (
        !best ||
        (this.#priority.get(key) ?? 0) > (this.#priority.get(best) ?? 0)
      ) {
        best = key;
      }
    }
    return best;
  }

  #unreadTotal = 0;

  /** Messages arrived live from `from`: unless their card is open, an
   *  envelope travels from their bubble to yours. */
  messageArrived(from, count = 1) {
    if (!count || this.#card?.key === from || this.hidden) return;
    const sender = this.#bubbles.get(from);
    const mine = this.#you ? this.#bubbles.get(this.#you) : null;
    const target = mine?.isConnected ? mine : this.#eye;
    if (!sender?.isConnected || !target?.isConnected || this.#concealed) {
      return;
    }
    envelope(
      this.#root.querySelector(".card-layer"),
      this.getBoundingClientRect(),
      sender.getBoundingClientRect(),
      target.getBoundingClientRect(),
      icon("mail"),
    );
  }

  /** Opens someone's card, as pressing their bubble does. */
  openCard(key) {
    const entry = this.#entries.get(key);
    if (entry && this.#card) this.#card.open(entry);
  }

  /** Closes the open card, if any. */
  closeCard() {
    this.#card?.close({ focus: "none" });
  }

  connectedCallback() {
    if (!this.#built) this.#build();
    this.#narrow = window.matchMedia(NARROW);
    this.#narrow.addEventListener("change", this.#onNarrow);
    window.addEventListener("resize", this.#onResize);
    // A phone's keyboard shrinks only the visual viewport: the card follows.
    globalThis.visualViewport?.addEventListener("resize", this.#onViewport);
    globalThis.visualViewport?.addEventListener("scroll", this.#onViewport);
    document.addEventListener("pointerdown", this.#onOutside, true);
    this.#render();
  }

  disconnectedCallback() {
    // Removal releases pointer capture; a drag must not outlive it.
    this.#drag?.reset();
    this.#card?.close({ focus: "none" });
    clearInterval(this.#ticker);
    this.#ticker = 0;
    for (const handle of this.#playing.values()) handle.stop();
    this.#playing.clear();
    this.#narrow?.removeEventListener("change", this.#onNarrow);
    window.removeEventListener("resize", this.#onResize);
    globalThis.visualViewport?.removeEventListener("resize", this.#onViewport);
    globalThis.visualViewport?.removeEventListener("scroll", this.#onViewport);
    document.removeEventListener("pointerdown", this.#onOutside, true);
  }

  #build() {
    this.#built = true;
    this.hidden = true;
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = this.getAttribute("stylesheet") || "/table-presence.css";
    // Show nothing until the styles are in, rather than a flash of raw DOM.
    const styled = () => {
      this.#styled = true;
      this.#render();
    };
    sheet.addEventListener("load", styled);
    sheet.addEventListener("error", styled);

    const hint = document.createElement("span");
    hint.id = "tp-hint";
    hint.hidden = true;
    hint.textContent =
      "Press a person to open their card. Drag any bubble to move them to another edge, or use the arrow keys.";

    const cardLayer = document.createElement("div");
    cardLayer.className = "card-layer";

    this.#anchor = document.createElement("div");
    this.#anchor.className = "anchor";
    this.#group = document.createElement("div");
    this.#group.className = "group";
    this.#group.setAttribute("role", "group");
    this.#anchor.append(this.#group);
    this.#root.append(sheet, hint, this.#anchor, cardLayer);
    this.#card = new Card({
      layer: cardLayer,
      element: this,
      area: () => this.#visibleArea(),
      side: () => this.#spot.side,
      bubbleFor: (key) => {
        const b = this.#bubbles.get(key);
        if (b?.isConnected && !b.classList.contains("exiting")) return b;
        // Everyone hidden: a card opened from the inbox sits by it, or by
        // the eye once nothing is left unread.
        if (!this.#concealed) return null;
        if (this.#inbox?.isConnected) return this.#inbox;
        return this.#eye?.isConnected ? this.#eye : null;
      },
      context: () => this.#cardContext(),
      state: (id) => this.#sectionState.get(id),
      focusBubble: (key) => this.#bubbles.get(key)?.focus(),
      focusNext: (key) => {
        const b = this.#bubbles.get(key);
        const next = b?.nextElementSibling ?? this.#eye;
        next?.focus();
      },
      focusEye: () => this.#eye?.focus(),
    });

    this.#drag = new DragController(this.#group, {
      handle: ".bubble",
      onStart: this.#dragStart,
      onMove: this.#dragMove,
      onEnd: this.#dragEnd,
    });
    this.#group.addEventListener("click", this.#onClick);
    this.#group.addEventListener("keydown", this.#onKey);
  }

  // ---- Rendering ----------------------------------------------------------

  /**
   * Renders once at the end of the current task, however many properties
   * the page set in it: a roster frame usually sets the clock offset and
   * the roster together, and two renders would paint, measure and start a
   * slide twice. Presses that cause motion still render at once.
   */
  #update() {
    if (!this.#built || this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (this.isConnected) this.#render();
    });
  }

  #render() {
    const visible = this.#styled && this.#roster.length > 0;
    this.hidden = !visible;
    if (!visible) {
      this.#expanded = false;
      this.#motion = null;
      this.#tick(false);
      return;
    }
    // Where every bubble is laid out now, so whatever changes below can
    // animate from here (presence/motion.js).
    const before = measure([...this.#group.children], this.#layoutRect);
    const roster = viewRoster(this.#roster, {
      you: this.#you,
      offline: this.#offline,
      priority: this.#priority,
    });
    const max = this.#narrow?.matches ? BUBBLES_NARROW : BUBBLES;
    const folds = roster.length > max;
    if (!folds) this.#expanded = false;
    const shown = shownEntries(roster, max, this.#expanded);
    const ctx = { now: Date.now(), offset: this.#clockOffset };
    this.#entries = new Map(roster.map((e) => [e.key, e]));

    const people = shown.map((entry) => {
      let bubble = this.#bubbles.get(entry.key);
      if (!bubble) {
        bubble = createBubble();
        this.#bubbles.set(entry.key, bubble);
      }
      const activity =
        this.#activities.get(entry.key) ?? entry.activity ?? null;
      const unread = this.#unread[entry.key] ?? 0;
      const grew = unread > (this.#unreadShown[entry.key] ?? 0);
      paintPerson(bubble, entry, { ...ctx, activity, unread, grew });
      this.#animate(entry.key, bubble, activity, entry.self === true);
      return bubble;
    });
    this.#forget(new Set(shown.map((e) => e.key)));

    if (folds) {
      this.#more ??= createBubble("more");
      paintCounter(this.#more, {
        folded: roster.length - shown.length,
        expanded: this.#expanded,
      });
    } else {
      // Gone from the order below, so it leaves with the rest.
      this.#more = null;
    }
    this.#unreadShown = { ...this.#unread };
    this.#eye ??= createBubble("toggle");
    paintEye(this.#eye, { hidden: this.#concealed, count: roster.length });
    // Hidden, messages waiting show as their own bubble beside the eye.
    const latest = this.#concealed ? this.#latestUnread() : null;
    if (latest) {
      this.#inbox ??= createBubble("inbox");
      paintInbox(this.#inbox, {
        count: this.#unreadTotal,
        from: this.#entries.get(latest)?.name ?? "",
      });
    } else {
      this.#inbox = null;
    }

    // The eye leads. Hidden, it is all that shows: the rest leave the page
    // (and are kept, to come back as they were).
    const order = this.#concealed
      ? [this.#eye, ...(this.#inbox ? [this.#inbox] : [])]
      : [this.#eye, ...people, ...(this.#more ? [this.#more] : [])];
    const leaving = this.#arrange(order);
    this.#group.setAttribute("aria-label", "At the table, " + roster.length);
    this.#tick(roster.some((e) => statusOf(e.state).ticks));
    // While the group is carried it stays where the finger has it: placing
    // it would snap it back to its edge, and the drop would then land
    // there. Bubbles still come and go; the drop lays everything out.
    if (this.#drag?.dragging) return;
    this.#place();
    this.#move(order, leaving, before);
    // The open card follows its person: new state, a new place, or "has
    // left" if they are gone (or hidden behind the eye or "+N").
    if (this.#card?.key) {
      const key = this.#card.key;
      // Hidden, a card opened from the inbox stays open while you read and
      // reply, even once nothing is unread.
      const shownNow = this.#concealed || shown.some((e) => e.key === key);
      if (!this.#entries.has(key)) this.#card.refresh(null);
      else if (!shownNow) this.#card.close({ focus: "none" });
      else this.#card.refresh(this.#entries.get(key));
    }
  }

  /** What card sections are told: you, the clock, and page state. */
  #cardContext() {
    const me = this.#you ? (this.#entries.get(this.#you) ?? null) : null;
    return {
      you: this.#you,
      me,
      now: Date.now(),
      offset: this.#clockOffset,
      state: (id) => this.#sectionState.get(id),
    };
  }

  /**
   * Animates what the render changed. Bubbles that stayed slide to their
   * new places. Arrivals come out of the eye (shown again) or "+N"
   * (opened) when that is what was pressed, else they pop in. Departures
   * fold into the eye or "+N" (hidden, closed), or shrink where they stood
   * (someone left).
   */
  #move(order, leaving, before) {
    const cause = this.#motion;
    this.#motion = null;
    const stayed = order.filter((el) => before.has(el));
    const arrived = order.filter((el) => !before.has(el));
    slide(stayed, before, this.#layoutRect);
    const origin = cause?.isConnected ? this.#layoutRect(cause) : null;
    if (origin) emerge(arrived, origin, this.#layoutRect);
    vanish(leaving, before, this.#anchor, origin);
  }

  /** Where a bubble is laid out, in screen pixels, ignoring any animation
   *  in flight: its offset within the group plus where the group sits. */
  #layoutRect = (el) => ({
    left: this.#pos.x + el.offsetLeft,
    top: this.#pos.y + el.offsetTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  });

  /** Forgets bubbles for people who left, stopping anything they played;
   *  the render then plays them out. */
  #forget(keep) {
    for (const [key, bubble] of this.#bubbles) {
      if (keep.has(key)) continue;
      this.#playing.get(key)?.stop();
      this.#playing.delete(key);
      this.#bubbles.delete(key);
    }
  }

  /** Puts bubbles in order, moving only those out of place (moving a
   *  focused element would drop its focus). Returns the bubbles that are no
   *  longer wanted, taken out of the group for the render to play out. A
   *  bubble on its way out comes back if wanted again. */
  #arrange(order) {
    const wanted = new Set(order);
    const leaving = [...this.#group.children].filter((el) => !wanted.has(el));
    for (const el of leaving) {
      el.remove();
    }
    order.forEach((bubble, index) => {
      // Wanted again while leaving: cancel the exit. Others keep whatever
      // they are playing (a pop-in, a shuffle).
      if (bubble.classList.contains("exiting")) revive(bubble);
      if (this.#group.children[index] !== bubble) {
        this.#group.insertBefore(bubble, this.#group.children[index] ?? null);
      }
    });
    return leaving;
  }

  /** Starts, keeps or stops the animation of someone's activity. */
  #animate(key, bubble, activity, self) {
    const playing = this.#playing.get(key);
    if (playing?.id === activity) return;
    playing?.stop();
    this.#playing.delete(key);
    if (activity) {
      this.#playing.set(
        key,
        playActivity(bubble, activity, { side: this.#spot.side, self }),
      );
    }
  }

  /** Keeps time-based words ("away for 7 min") current while any show. */
  #tick(on) {
    if (on && !this.#ticker) {
      this.#ticker = setInterval(() => this.#update(), TICK_MS);
    } else if (!on && this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = 0;
    }
  }

  // ---- Docking ------------------------------------------------------------

  /** The free area the bubbles may sit in, inside the host's padding. */
  #area() {
    const style = getComputedStyle(this);
    const left = parseFloat(style.paddingLeft) || 0;
    const top = parseFloat(style.paddingTop) || 0;
    const right = this.clientWidth - (parseFloat(style.paddingRight) || 0);
    const bottom = this.clientHeight - (parseFloat(style.paddingBottom) || 0);
    return {
      left,
      top,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  /** Lays the group out for an edge and returns its size there. */
  #layoutFor(side, area) {
    for (const s of SIDES)
      this.#anchor.classList.toggle("side-" + s, s === side);
    const vertical = isVertical(side);
    this.#group.style.maxHeight = vertical ? area.height + "px" : "";
    this.#group.style.maxWidth = vertical ? "" : area.width + "px";
    return { width: this.#group.offsetWidth, height: this.#group.offsetHeight };
  }

  #place() {
    const area = this.#area();
    const size = this.#layoutFor(this.#spot.side, area);
    const { x, y } = placeOnEdge(area, this.#spot, size);
    this.#moveTo(x, y);
  }

  #moveTo(x, y) {
    this.#pos = { x, y };
    this.#anchor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /**
   * Moves the group to `spot` with the shuffle: every bubble is measured
   * where it is now (mid-flight, if a shuffle is still running), the group
   * is laid out in its new place at once, and each bubble then travels
   * there on its own (presence/motion.js).
   */
  #relocate(spot, before = measure([...this.#group.children])) {
    for (const trip of this.#shuffles) trip.cancel();
    this.#spot = spot;
    writeDock(spot);
    this.#place();
    this.#shuffles = shuffle([...before.keys()], before);
  }

  #moveToSide(side) {
    this.#card?.close({ focus: "none" });
    this.#relocate({ side, t: this.#spot.t });
  }

  #dragStart = () => {
    this.#dragFrom = { ...this.#pos };
    this.#card?.close({ focus: "none" });
    for (const trip of this.#shuffles) trip.cancel();
    this.#shuffles = [];
    this.#anchor.classList.add("dragging");
    haptic("pick");
  };

  // Free while carried; the edge is chosen on release.
  #dragMove = (dx, dy) => {
    const area = this.#area();
    const size = {
      width: this.#group.offsetWidth,
      height: this.#group.offsetHeight,
    };
    const { x, y } = clampToArea(
      area,
      size,
      this.#dragFrom.x + dx,
      this.#dragFrom.y + dy,
    );
    this.#moveTo(x, y);
  };

  #dragEnd = () => {
    this.#anchor.classList.remove("dragging");
    if (!this.isConnected) return;
    const area = this.#area();
    const rect = {
      ...this.#pos,
      width: this.#group.offsetWidth,
      height: this.#group.offsetHeight,
    };
    // Where everyone is as dropped, before the group is laid out for its
    // new edge: the shuffle starts from here.
    const before = measure([...this.#group.children]);
    const spot = snapToEdge(area, rect, (side) => this.#layoutFor(side, area));
    this.#relocate(spot, before);
    haptic("snap");
  };

  // ---- Interaction ----------------------------------------------------------

  #onClick = (event) => {
    const bubble = event.target.closest?.(".bubble");
    if (!bubble) return;
    if (bubble === this.#eye) {
      this.#card?.close({ focus: "none" });
      this.#motion = bubble;
      this.#concealed = !this.#concealed;
      writeHidden(this.#concealed);
      this.#expanded = false;
      haptic("tap");
      this.#render();
    } else if (bubble === this.#inbox) {
      // The latest person to write, opened right here, still hidden.
      const key = this.#latestUnread();
      const entry = key ? this.#entries.get(key) : null;
      if (!entry || !this.#card) return;
      haptic("tap");
      if (this.#card.key === key) this.#card.close();
      else this.#card.open(entry);
    } else if (bubble === this.#more) {
      this.#motion = bubble;
      this.#expanded = !this.#expanded;
      haptic("tap");
      this.#render();
    } else {
      // A person: their card opens (or closes, if it was theirs).
      const key = [...this.#bubbles].find(([, b]) => b === bubble)?.[0];
      const entry = key ? this.#entries.get(key) : null;
      if (!entry || !this.#card) return;
      if (this.#card.key === key) this.#card.close();
      else this.#card.open(entry);
    }
  };

  #onKey = (event) => {
    const side = ARROWS[event.key];
    if (side && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.#moveToSide(side);
    } else if (event.key === "Escape" && this.#expanded) {
      event.stopPropagation();
      this.#motion = this.#more;
      this.#expanded = false;
      this.#render();
    }
  };

  #onOutside = (event) => {
    if (!event.composedPath().includes(this)) {
      // A press elsewhere closes the card and keeps its own focus.
      this.#card?.close({ focus: "none" });
    }
  };

  #onViewport = () => {
    this.#card?.reposition();
  };

  /** The free area, cut to what is actually on screen: with a phone's
   *  keyboard up, only the part above it. */
  #visibleArea() {
    const area = this.#area();
    const vv = globalThis.visualViewport;
    if (!vv) return area;
    const left = Math.max(area.left, vv.offsetLeft);
    const top = Math.max(area.top, vv.offsetTop);
    const right = Math.min(area.right, vv.offsetLeft + vv.width);
    const bottom = Math.min(area.bottom, vv.offsetTop + vv.height);
    if (right - left < 120 || bottom - top < 120) return area;
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  #onResize = () => {
    // A carried group stays under the finger; the drop places it.
    if (!this.hidden && !this.#drag?.dragging) {
      this.#place();
      this.#card?.reposition();
    }
  };

  #onNarrow = () => {
    this.#update();
  };
}

/** Registers the element once; safe to call from every page that uses it. */
export function defineTablePresence() {
  if (!customElements.get(TAG)) customElements.define(TAG, TablePresence);
}

/** Adds the presence bubbles to the page and returns the element; set
 *  `.roster` to fill it. */
export function mountTablePresence({
  stylesheet = "/table-presence.css",
  parent = document.body,
} = {}) {
  defineTablePresence();
  const node = document.createElement(TAG);
  node.setAttribute("stylesheet", stylesheet);
  parent.appendChild(node);
  return node;
}
