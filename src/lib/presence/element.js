/**
 * <table-presence>: who is at the table, as bubbles docked to an edge of
 * the screen. This file only composes the parts:
 *
 * - bubble.js      the round buttons (people, "+N", the eye) and their paint
 * - statuses.js    what each state looks like (active, away, disconnected)
 * - activities.js  animated things people do (sending a message, ...)
 * - dock.js        edge geometry: placing, clamping, snapping
 * - drag.js        press-and-drag with taps left as taps
 * - prefs.js       per-device choices (edge, hidden)
 *
 * The page sets `.roster` (and `.clockOffset` when the roster came from
 * another machine); everything else happens here. Names only ever go in as
 * text.
 */

import { playActivity } from "./activities.js";
import { createBubble, paintCounter, paintEye, paintPerson } from "./bubble.js";
import { DragController } from "./drag.js";
import {
  SIDES,
  clampToArea,
  isVertical,
  placeOnEdge,
  snapToEdge,
} from "./dock.js";
import { readDock, readHidden, writeDock, writeHidden } from "./prefs.js";
import { statusOf } from "./statuses.js";

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
/** How long a tapped bubble shows its name on a touch screen. */
const TIP_MS = 2500;
/** How long the glide onto an edge takes; matches the stylesheet. */
const SETTLE_MS = 260;
/** How often "away for 7 min" is brought up to date. */
const TICK_MS = 30_000;

export class TablePresence extends HTMLElement {
  #roster = [];
  #clockOffset = 0;
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
  /** The bubble showing its name after a tap, and the timer that hides it. */
  #tipped = null;
  #tipTimer = 0;
  #settleTimer = 0;
  #ticker = 0;
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
    if (this.#built) this.#render();
  }

  /** How far this device's clock is ahead of the host's (ms), so "away for"
   *  is right even when the two disagree. */
  get clockOffset() {
    return this.#clockOffset;
  }

  set clockOffset(ms) {
    this.#clockOffset = Number.isFinite(ms) ? ms : 0;
    if (this.#built) this.#render();
  }

  /** Starts an activity (see activities.js) on someone's bubble, or stops
   *  it with `null`. Wins over any activity the roster gives them. */
  setActivity(key, activity) {
    if (activity) this.#activities.set(key, activity);
    else this.#activities.delete(key);
    if (this.#built) this.#render();
  }

  connectedCallback() {
    if (!this.#built) this.#build();
    this.#narrow = window.matchMedia(NARROW);
    this.#narrow.addEventListener("change", this.#onNarrow);
    window.addEventListener("resize", this.#onResize);
    document.addEventListener("pointerdown", this.#onOutside, true);
    this.#render();
  }

  disconnectedCallback() {
    // Removal releases pointer capture; a drag must not outlive it.
    this.#drag?.reset();
    this.#hideTip();
    clearInterval(this.#ticker);
    this.#ticker = 0;
    for (const handle of this.#playing.values()) handle.stop();
    this.#playing.clear();
    this.#narrow?.removeEventListener("change", this.#onNarrow);
    window.removeEventListener("resize", this.#onResize);
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
      "Drag any bubble to move them to another edge, or use the arrow keys.";

    this.#anchor = document.createElement("div");
    this.#anchor.className = "anchor";
    this.#group = document.createElement("div");
    this.#group.className = "group";
    this.#group.setAttribute("role", "group");
    this.#anchor.append(this.#group);
    this.#root.append(sheet, hint, this.#anchor);

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

  #render() {
    const visible = this.#styled && this.#roster.length > 0;
    this.hidden = !visible;
    if (!visible) {
      this.#expanded = false;
      this.#hideTip();
      this.#tick(false);
      return;
    }
    const roster = this.#roster;
    const max = this.#narrow?.matches ? BUBBLES_NARROW : BUBBLES;
    const folds = roster.length > max;
    if (!folds) this.#expanded = false;
    const shown = folds && !this.#expanded ? roster.slice(0, max - 1) : roster;
    const ctx = { now: Date.now(), offset: this.#clockOffset };

    const people = shown.map((entry) => {
      let bubble = this.#bubbles.get(entry.key);
      if (!bubble) {
        bubble = createBubble();
        this.#bubbles.set(entry.key, bubble);
      }
      const activity =
        this.#activities.get(entry.key) ?? entry.activity ?? null;
      paintPerson(bubble, entry, { ...ctx, activity });
      this.#animate(entry.key, bubble, activity);
      return bubble;
    });
    this.#forget(new Set(shown.map((e) => e.key)));

    if (folds) {
      this.#more ??= createBubble("more");
      paintCounter(this.#more, {
        folded: roster.length - shown.length,
        expanded: this.#expanded,
      });
    } else if (this.#more) {
      this.#more.remove();
      this.#more = null;
    }
    this.#eye ??= createBubble("toggle");
    paintEye(this.#eye, { hidden: this.#concealed, count: roster.length });

    // The eye leads. Hidden, it is all that shows: the rest leave the page
    // (and are kept, to come back as they were).
    const order = this.#concealed
      ? [this.#eye]
      : [this.#eye, ...people, ...(this.#more ? [this.#more] : [])];
    this.#arrange(order);
    this.#group.setAttribute("aria-label", "At the table, " + roster.length);
    this.#tick(roster.some((e) => statusOf(e.state).ticks));
    this.#place();
  }

  /** Drops bubbles for people who left, stopping anything they played. */
  #forget(keep) {
    for (const [key, bubble] of this.#bubbles) {
      if (keep.has(key)) continue;
      if (this.#tipped === bubble) this.#hideTip();
      this.#playing.get(key)?.stop();
      this.#playing.delete(key);
      bubble.remove();
      this.#bubbles.delete(key);
    }
  }

  /** Puts bubbles in order, moving only those out of place (moving a
   *  focused element would drop its focus), and removes the rest. */
  #arrange(order) {
    order.forEach((bubble, index) => {
      if (this.#group.children[index] !== bubble) {
        this.#group.insertBefore(bubble, this.#group.children[index] ?? null);
      }
    });
    while (this.#group.children.length > order.length) {
      const extra = this.#group.lastElementChild;
      if (this.#tipped === extra) this.#hideTip();
      extra.remove();
    }
  }

  /** Starts, keeps or stops the animation of someone's activity. */
  #animate(key, bubble, activity) {
    const playing = this.#playing.get(key);
    if (playing?.id === activity) return;
    playing?.stop();
    this.#playing.delete(key);
    if (activity) {
      this.#playing.set(
        key,
        playActivity(bubble, activity, { side: this.#spot.side }),
      );
    }
  }

  /** Keeps time-based words ("away for 7 min") current while any show. */
  #tick(on) {
    if (on && !this.#ticker) {
      this.#ticker = setInterval(() => this.#render(), TICK_MS);
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

  /** Glides the group to its spot instead of jumping. */
  #settle() {
    this.#anchor.classList.add("settling");
    this.#place();
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(
      () => this.#anchor.classList.remove("settling"),
      SETTLE_MS,
    );
  }

  #moveToSide(side) {
    this.#spot = { side, t: this.#spot.t };
    writeDock(this.#spot);
    this.#settle();
  }

  #dragStart = () => {
    this.#dragFrom = { ...this.#pos };
    this.#hideTip();
    this.#anchor.classList.remove("settling");
    this.#anchor.classList.add("dragging");
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
    this.#spot = snapToEdge(area, rect, (side) => this.#layoutFor(side, area));
    writeDock(this.#spot);
    this.#settle();
  };

  // ---- Interaction ----------------------------------------------------------

  #showTip(bubble) {
    this.#hideTip();
    this.#tipped = bubble;
    bubble.classList.add("tip-on");
    this.#tipTimer = setTimeout(() => this.#hideTip(), TIP_MS);
  }

  #hideTip() {
    clearTimeout(this.#tipTimer);
    this.#tipped?.classList.remove("tip-on");
    this.#tipped = null;
  }

  #onClick = (event) => {
    const bubble = event.target.closest?.(".bubble");
    if (!bubble) return;
    if (bubble === this.#eye) {
      this.#concealed = !this.#concealed;
      writeHidden(this.#concealed);
      this.#expanded = false;
      this.#hideTip();
      this.#render();
    } else if (bubble === this.#more) {
      this.#expanded = !this.#expanded;
      this.#hideTip();
      this.#render();
    } else if (this.#tipped === bubble) {
      this.#hideTip();
    } else {
      // A tap names the person; on a mouse the name already shows on hover.
      this.#showTip(bubble);
    }
  };

  #onKey = (event) => {
    const side = ARROWS[event.key];
    if (side && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.#moveToSide(side);
    } else if (event.key === "Escape" && (this.#tipped || this.#expanded)) {
      event.stopPropagation();
      this.#hideTip();
      if (this.#expanded) {
        this.#expanded = false;
        this.#render();
      }
    }
  };

  #onOutside = (event) => {
    if (!event.composedPath().includes(this)) this.#hideTip();
  };

  #onResize = () => {
    if (!this.hidden) this.#place();
  };

  #onNarrow = () => {
    if (this.#built) this.#render();
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
