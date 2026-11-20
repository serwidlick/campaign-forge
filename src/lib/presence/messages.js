/**
 * The message section of a person's card: the conversation with them,
 * who is typing, the line under your newest message ("Sending…", "Sent",
 * "Seen") and the message box. It reads its state from the page
 * (`el.setSectionState("message", …)`, which chat.js keeps up to date) and
 * says what the person did through events: `send`, `typing`, `seen`,
 * `retry` and `discard`. It does no networking itself.
 */

import { defineCardSection } from "./card-sections.js";
import { icon } from "./icons.js";

/** Typing is refreshed this often while the person keeps typing. */
const TYPING_REFRESH_MS = 2_500;
/** How close to the bottom counts as "reading the newest". */
const AT_BOTTOM_PX = 24;

const STATUS_WORDS = {
  sending: "Sending…",
  sent: "Sent",
  seen: "Seen",
  failed: "Not sent",
  unsure: "May not have been sent",
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isGm(role) {
  return role === "host" || role === "gm";
}

/** Whether you may write to `them` under `rules`. */
export function mayMessage(me, them, rules) {
  return (
    isGm(me?.role) || isGm(them?.role) || rules?.playersMayMessage !== false
  );
}

/** Why the message box is off, or null when it is on. */
export function composerBlocked(state, me, them) {
  if (!state) return "Messages are not available here.";
  if (!state.online) return "Offline. Messages wait until the table is back.";
  if (!state.synced) return "Connecting…";
  if (!mayMessage(me, them, state.rules)) {
    return "The GM has turned off messages between players.";
  }
  if (them.state === "disconnected") {
    return them.name + " is disconnected right now.";
  }
  return null;
}

function timeOf(at) {
  try {
    return new Date(at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function atBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM_PX;
}

defineCardSection("message", {
  order: 100,
  when: (entry) => !entry.self,
  mount(root, entry, api) {
    const thread = el("div", "thread");
    thread.setAttribute("role", "log");
    thread.setAttribute("aria-label", "Messages with " + entry.name);
    thread.tabIndex = 0;
    const note = el("p", "thread-note", "Earlier messages are no longer kept.");
    note.hidden = true;
    const empty = el("p", "thread-empty", "Say hello to " + entry.name + ".");
    const list = el("div", "thread-list");
    thread.append(note, empty, list);

    const typing = el("div", "typing");
    typing.hidden = true;
    const dots = el("span", "dots");
    dots.setAttribute("aria-hidden", "true");
    dots.append(el("span"), el("span"), el("span"));
    const typingWords = el("span", "typing-words", entry.name + " is typing");
    typing.append(dots, typingWords);

    const status = el("p", "msg-status");
    status.hidden = true;
    status.setAttribute("aria-live", "off");

    const form = el("form", "composer");
    const box = el("textarea", "composer-box");
    box.rows = 1;
    box.maxLength = 500;
    box.placeholder = "Message " + entry.name;
    box.setAttribute("aria-label", "Message " + entry.name);
    box.setAttribute("enterkeyhint", "send");
    box.dataset.autofocus = "";
    const send = el("button", "composer-send");
    send.type = "submit";
    send.setAttribute("aria-label", "Send");
    send.appendChild(icon("send"));
    form.append(box, send);
    const reason = el("p", "composer-reason");
    reason.hidden = true;
    root.append(thread, typing, status, form, reason);

    const h = {
      api,
      entry,
      thread,
      list,
      note,
      empty,
      typing,
      status,
      box,
      send,
      reason,
      nodes: new Map(),
      ready: false,
      typingOn: false,
      typingSent: 0,
      seenSent: 0,
      wasTyping: false,
      statusFor: null,
      statusWord: null,
      view: null,
      blocked: null,
    };

    const stopTyping = () => {
      if (!h.typingOn) return;
      h.typingOn = false;
      api.emit("typing", { to: h.entry.key, on: false });
    };
    h.stopTyping = stopTyping;

    const submit = () => {
      const text = box.value.trim();
      if (!text || h.blocked) return;
      stopTyping();
      api.emit("send", { to: h.entry.key, text });
      box.value = "";
      fit(box);
    };
    form.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        submit();
      },
      { signal: api.signal },
    );
    box.addEventListener(
      "keydown",
      (event) => {
        // Keys typed here are the message's, not the bubbles' docking keys.
        event.stopPropagation();
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          submit();
        }
      },
      { signal: api.signal },
    );
    box.addEventListener(
      "input",
      () => {
        fit(box);
        if (!box.value.trim()) return stopTyping();
        const now = Date.now();
        if (!h.typingOn || now - h.typingSent > TYPING_REFRESH_MS) {
          h.typingOn = true;
          h.typingSent = now;
          api.emit("typing", { to: h.entry.key, on: true });
        }
      },
      { signal: api.signal },
    );
    box.addEventListener("blur", stopTyping, { signal: api.signal });
    thread.addEventListener("scroll", () => markSeen(h), {
      signal: api.signal,
      passive: true,
    });
    document.addEventListener("visibilitychange", () => markSeen(h), {
      signal: api.signal,
    });
    return h;
  },
  update(h, entry, ctx) {
    h.entry = entry;
    const state = ctx.state("message");
    const view = state?.view?.(entry.key) ?? null;
    h.view = view;
    h.blocked = composerBlocked(state, ctx.me, entry);
    h.box.disabled = Boolean(h.blocked);
    h.send.disabled = Boolean(h.blocked);
    h.reason.hidden = !h.blocked;
    h.reason.textContent = h.blocked ?? "";
    if (h.blocked) h.stopTyping();
    if (!view) return;
    // Decided before anything moves: were they reading the newest?
    const stick = !h.ready || atBottom(h.thread);
    const sentNow = renderThread(h, view, entry);
    renderTyping(h, view, entry);
    renderStatus(h, view);
    // Scrolled once everything is laid out (the status line included), so
    // the newest message and its "Sent" or "Seen" are fully in view. Your
    // own message always brings you down; theirs does if you were there.
    if (stick || sentNow) scrollToEnd(h, h.ready);
    h.ready = true;
    markSeen(h);
  },
  unmount(h) {
    h.stopTyping?.();
  },
});

/** Grows the message box with its text, up to a few lines. */
function fit(box) {
  box.style.height = "";
  box.style.height = Math.min(box.scrollHeight, 120) + "px";
}

/** Tells the table you have read the newest message, when you can see it. */
function markSeen(h) {
  const v = h.view;
  if (!v?.cid || !v.lastSeq) return;
  if (v.lastSeq <= Math.max(v.seenByMe, h.seenSent)) return;
  if (document.visibilityState === "hidden") return;
  if (!atBottom(h.thread)) return;
  h.seenSent = v.lastSeq;
  h.api.emit("seen", { cid: v.cid, seq: v.lastSeq });
}

function messageNode(item, h) {
  const node = el("div", "msg " + (item.mine ? "mine" : "theirs"));
  const text = el("p", "msg-text", item.text);
  node.appendChild(text);
  if (item.at) node.title = timeOf(item.at);
  node.dataset.id = item.id;
  paintMessage(node, item, h);
  return node;
}

function paintMessage(node, item, h) {
  node.classList.toggle("pending", item.pending === "sending");
  node.classList.toggle("failed", item.pending === "failed");
  const old = node.querySelector(".msg-actions");
  if (item.pending === "failed") {
    if (old) return;
    const actions = el("span", "msg-actions");
    const retry = el("button", "msg-retry");
    retry.type = "button";
    retry.append(icon("rotate"), document.createTextNode("Retry"));
    retry.addEventListener("click", () =>
      h.api.emit("retry", { clientId: item.clientId }),
    );
    const discard = el("button", "msg-discard", "Remove");
    discard.type = "button";
    discard.addEventListener("click", () =>
      h.api.emit("discard", { clientId: item.clientId }),
    );
    actions.append(retry, discard);
    node.appendChild(actions);
  } else if (old) {
    old.remove();
  }
}

/** Brings the newest message into view, smoothly once the card is up. */
function scrollToEnd(h, smooth) {
  const top = h.thread.scrollHeight;
  if (smooth && !reducedMotion() && typeof h.thread.scrollTo === "function") {
    h.thread.scrollTo({ top, behavior: "smooth" });
  } else {
    h.thread.scrollTop = top;
  }
}

function reducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Puts the conversation's messages in place; returns whether one of your
 *  own just appeared. */
function renderThread(h, view, entry) {
  // The status line lives among the messages; it steps out while they are
  // put in order, and renderStatus puts it back (gliding from here).
  h.statusRect =
    h.status.isConnected && !h.status.hidden
      ? h.status.getBoundingClientRect()
      : null;
  h.status.remove();
  const before = new Map();
  for (const node of h.nodes.values()) {
    before.set(node, node.getBoundingClientRect());
  }
  const wanted = new Set(view.items.map((i) => i.id));
  // A pending send that turned into its message lifts into place from
  // where it was, rather than popping in.
  const liftFrom = new Map();
  for (const [id, node] of h.nodes) {
    if (wanted.has(id)) continue;
    if (id.startsWith("pending:")) {
      liftFrom.set(
        node.querySelector(".msg-text").textContent,
        before.get(node),
      );
    }
    node.remove();
    h.nodes.delete(id);
  }
  const fresh = [];
  view.items.forEach((item, index) => {
    let node = h.nodes.get(item.id);
    if (!node) {
      node = messageNode(item, h);
      h.nodes.set(item.id, node);
      fresh.push([node, item]);
    } else {
      paintMessage(node, item, h);
    }
    if (h.list.children[index] !== node) {
      h.list.insertBefore(node, h.list.children[index] ?? null);
    }
  });
  h.empty.hidden = view.items.length > 0;
  h.note.hidden = !view.trimmed;
  const sentNow = fresh.some(([, item]) => item.mine);
  if (!h.ready) return false;
  h.api.motion.slideMessages(
    [...before.keys()].filter((n) => n.isConnected),
    before,
  );
  for (const [node, item] of fresh) {
    const from = item.mine ? liftFrom.get(item.text) : null;
    if (from) {
      h.api.motion.slideMessages([node], new Map([[node, from]]));
    } else {
      h.api.motion.emergeMessage(node);
    }
    if (!item.mine) h.api.announce(entry.name + ": " + item.text);
    else if (item.pending === "failed") h.api.announce("Message not sent.");
  }
  return sentNow;
}

function renderTyping(h, view, entry) {
  const on = view.typing;
  if (on === h.wasTyping) return;
  h.wasTyping = on;
  h.typing.hidden = !on;
  if (on) {
    h.api.motion.emergeMessage(h.typing);
    h.api.announce(entry.name + " is typing");
  }
}

function renderStatus(h, view) {
  const word = view.status ? STATUS_WORDS[view.status] : null;
  const anchor = view.statusFor ? h.nodes.get(view.statusFor) : null;
  if (!word || !anchor) {
    h.status.hidden = true;
    h.statusFor = null;
    h.statusWord = null;
    return;
  }
  const before =
    h.statusFor && h.statusFor !== view.statusFor ? h.statusRect : null;
  anchor.after(h.status);
  const changed = word !== h.statusWord || view.statusFor !== h.statusFor;
  h.status.hidden = false;
  h.status.textContent = word;
  h.status.classList.toggle("seen", view.status === "seen");
  h.status.classList.toggle(
    "failed",
    view.status === "failed" || view.status === "unsure",
  );
  if (changed && h.ready) h.api.motion.statusChanged(h.status, before);
  h.statusFor = view.statusFor;
  h.statusWord = word;
}
