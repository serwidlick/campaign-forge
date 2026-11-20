/**
 * Binds table messages to a page: the conversation state
 * (conversation.js), a transport, and the presence bubbles. Every page
 * uses this one controller (the phone page, the browser GM page and the
 * app), so the rules for resending, Seen and notifications live in one
 * place.
 *
 *   const chat = new TableChat({
 *     // Hands one command ({t: "send" | "typing" | "seen", ...}) to the
 *     // table. Return true if it went out, false if not (no socket), or a
 *     // promise of either, or of the ack for a send (the hosting window).
 *     send: (command) => socket.send(command),
 *   });
 *   chat.receive(frame);        // every frame from the table, from the first
 *   chat.connected(false);      // the socket dropped (true once back)
 *   chat.attach(bubbles);       // whenever the bubbles exist
 *
 * It lives with the connection, not the bubbles, so nothing is missed
 * before they mount. The bubbles' card emits `table-presence:send`,
 * `…:typing`, `…:seen`, `…:retry` and `…:discard`; this answers them, and
 * hands the card its state with `setSectionState`.
 */

import {
  applyAck,
  applyFrame,
  conversationView,
  disconnected,
  discardSend,
  dueSends,
  emptyChats,
  queueSend,
  retrySend,
  rosterChanged,
  unreadCounts,
} from "./conversation.js";
import { haptic } from "./haptics.js";

/** A failed hand-over is tried again this much later. */
const RETRY_MS = 1_000;

function newId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export class TableChat {
  #el = null;
  #send;
  #now;
  #state = emptyChats();
  #you = null;
  #connection = 0;
  #online = true;
  #timer = 0;
  #typing = new Set();
  #listeners = [];
  #disposed = false;

  constructor({ send, now = () => Date.now() } = {}) {
    this.#send = send;
    this.#now = now;
  }

  /** Shows the conversations on `element` (a <table-presence>) and answers
   *  its card. Replaces any element attached before. */
  attach(element) {
    this.detach();
    if (!element) return;
    this.#el = element;
    const on = (name, fn) => {
      const handler = (event) => fn(event.detail ?? {});
      element.addEventListener("table-presence:" + name, handler);
      this.#listeners.push(() =>
        element.removeEventListener("table-presence:" + name, handler),
      );
    };
    on("send", ({ to, text }) => this.sendMessage(to, text));
    on("typing", ({ to, on: typing }) =>
      this.#command({ t: "typing", epoch: this.#epoch(), to, on: typing }),
    );
    on("seen", ({ cid, seq }) =>
      this.#command({ t: "seen", epoch: this.#epoch(), cid, seq }),
    );
    on("retry", ({ clientId }) => {
      retrySend(this.#state, clientId, newId(), this.#now());
      this.#flush();
    });
    on("discard", ({ clientId }) => {
      discardSend(this.#state, clientId);
      this.#publish();
    });
    this.#typing = new Set();
    this.#publish();
  }

  /** Stops showing on the attached element. */
  detach() {
    for (const off of this.#listeners) off();
    this.#listeners = [];
    if (this.#el) {
      for (const key of this.#typing) this.#el.setActivity?.(key, null);
      this.#el.setUnread?.({}, 0);
      this.#el.setSectionState?.("message", undefined);
    }
    this.#el = null;
  }

  /** Done with this table: detach and stop every timer. */
  dispose() {
    this.detach();
    clearTimeout(this.#timer);
    this.#disposed = true;
  }

  #epoch() {
    return this.#state.epoch ?? 0;
  }

  /** Who this device's person is, when the frames do not say (the hosting
   *  window is always "host"). */
  set you(key) {
    this.#you = key;
    this.#publish();
  }

  get you() {
    return this.#you;
  }

  /** Every frame from the table: roster, chats, acks, typing, rules. */
  receive(frame) {
    if (!frame || this.#disposed) return;
    if (typeof frame.you === "string") this.#you = frame.you;
    if (Array.isArray(frame.roster)) {
      rosterChanged(
        this.#state,
        frame.roster.map((e) => e.key),
      );
    }
    const { arrived } = applyFrame(this.#state, frame);
    for (const a of arrived) {
      this.#el?.messageArrived?.(a.with, a.messages.length);
    }
    if (arrived.length) haptic("notice");
    this.#flush();
  }

  /** The socket dropped (false) or a new one is up (true). Sends wait for
   *  the new socket's snapshot, then go out again. */
  connected(on) {
    on = Boolean(on);
    if (on === this.#online) return;
    this.#online = on;
    if (!on) {
      disconnected(this.#state);
      this.#connection += 1;
    }
    this.#flush();
  }

  /** Sends a message (what the card's message box does). */
  sendMessage(to, text) {
    const clean = String(text ?? "").trim();
    if (!clean) return null;
    const p = queueSend(this.#state, {
      to,
      text: clean,
      clientId: newId(),
      now: this.#now(),
    });
    this.#flush();
    return p.clientId;
  }

  /** A send that did not go out: tried again shortly. */
  #notSent(command) {
    const p = this.#state.pending.get(command.clientId);
    if (!p || p.status !== "sending") return;
    p.sentOn = null;
    p.retryAt = this.#now() + RETRY_MS;
  }

  #command(command) {
    let result;
    try {
      result = this.#send?.(command);
    } catch {
      result = false;
    }
    if (result && typeof result.then === "function") {
      result.then(
        (answer) => {
          if (command.t !== "send") return;
          if (answer && typeof answer === "object" && answer.clientId) {
            applyAck(this.#state, answer, this.#now());
          } else if (answer === false) {
            this.#notSent(command);
          }
          this.#flush();
        },
        () => {
          if (command.t !== "send") return;
          this.#notSent(command);
          this.#flush();
        },
      );
      return true;
    }
    if (result === false && command.t === "send") this.#notSent(command);
    return result !== false;
  }

  /** Sends what is due, schedules any wait, and repaints. */
  #flush() {
    if (this.#disposed) return;
    if (this.#online) {
      for (const command of dueSends(
        this.#state,
        this.#connection,
        this.#now(),
      )) {
        this.#command(command);
      }
    }
    clearTimeout(this.#timer);
    // Only a wait that can end in a send is timed: offline, or before the
    // new socket's snapshot, the reconnect itself flushes again.
    let wake = Infinity;
    const now = this.#now();
    if (this.#online && this.#state.synced) {
      for (const p of this.#state.pending.values()) {
        if (p.status === "sending" && p.retryAt > now) {
          wake = Math.min(wake, p.retryAt);
        }
      }
    }
    if (wake < Infinity) {
      this.#timer = setTimeout(() => this.#flush(), wake - now);
    }
    this.#publish();
  }

  #publish() {
    const el = this.#el;
    if (!el) return;
    const state = this.#state;
    const you = this.#you;
    // Typing shows on their bubble too, on this device only.
    const typing = new Set(state.typing);
    for (const key of this.#typing) {
      if (!typing.has(key)) el.setActivity?.(key, null);
    }
    for (const key of typing) {
      if (!this.#typing.has(key)) el.setActivity?.(key, "messaging");
    }
    this.#typing = typing;
    const { per, total } = unreadCounts(state);
    el.setUnread?.(per, total);
    el.setSectionState?.("message", {
      you,
      online: this.#online,
      synced: state.synced,
      rules: state.rules,
      view: (withKey) => conversationView(state, withKey, you),
    });
  }
}
