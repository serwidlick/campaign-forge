/**
 * Conversation state for table messages (docs/plans/table-messages.md):
 * what this device knows of its person's conversations, and the sends it
 * has not yet seen through. Pure: every function takes the state and what
 * arrived, changes the state, and says what happened. No DOM, no network.
 *
 * The host's frames carry:
 * - `chats`: the whole set (`snapshot: true`), or what changed, each
 *   conversation `{ cid, with, messages, seenByMe, seenByThem, unread,
 *   ended?, trimmed? }`;
 * - `acks`: answers to this socket's sends, by `clientId`;
 * - `typing`: who is typing to this person now;
 * - `messageRules`: `{ playersMayMessage }`;
 * - `epoch` (with `you`): the seat's identity epoch.
 */

/** How long a send is retried before it is shown as "may not have been
 *  sent". The host remembers client ids for longer. */
export const RESEND_FOR = 2 * 60_000;
/** Waits the host may ask for: "not ready" has none, so this. */
const NOT_READY_WAIT = 1_000;
/** Messages kept per conversation on this device, as on the host. */
export const KEEP_MESSAGES = 100;

/** Keeps a conversation to its last `KEEP_MESSAGES`. */
function trim(conversation) {
  const extra = conversation.messages.length - KEEP_MESSAGES;
  if (extra > 0) {
    conversation.messages.splice(0, extra);
    conversation.trimmed = true;
  }
}

/** A fresh state: nothing known yet. */
export function emptyChats() {
  return {
    /** The seat's identity epoch as last applied; commands carry it. */
    epoch: null,
    /** Conversations by the other person's key. */
    byWith: new Map(),
    /** Sends not yet seen through, by clientId. */
    pending: new Map(),
    typing: [],
    rules: { playersMayMessage: true },
    /** A snapshot has been applied on the current connection. */
    synced: false,
  };
}

function conversationFrom(c) {
  const conversation = {
    cid: c.cid,
    with: c.with,
    messages: [...(c.messages ?? [])].sort((a, b) => a.seq - b.seq),
    seenByMe: c.seenByMe ?? 0,
    seenByThem: c.seenByThem ?? 0,
    unread: c.unread ?? 0,
    trimmed: Boolean(c.trimmed),
  };
  trim(conversation);
  return conversation;
}

function byCid(state, cid) {
  for (const c of state.byWith.values()) if (c.cid === cid) return c;
  return null;
}

function fail(p, reason) {
  p.status = "failed";
  p.error = reason;
}

/** Drops pending sends the conversation's messages now show as delivered. */
function reconcile(state, conversation) {
  for (const m of conversation.messages) {
    if (m.clientId && state.pending.has(m.clientId)) {
      state.pending.delete(m.clientId);
    }
  }
}

/**
 * Applies one frame. Returns `{ changed, arrived }`: `arrived` lists, per
 * person, new messages from them that came live (never from a snapshot),
 * for notifications.
 */
export function applyFrame(state, frame) {
  let changed = false;
  const arrived = [];
  if (frame.epoch != null && frame.epoch !== state.epoch) {
    if (state.epoch != null) {
      // Someone else now: nothing of the old person's carries over.
      state.byWith.clear();
      for (const p of state.pending.values()) fail(p, "identity changed");
      state.synced = false;
    }
    state.epoch = frame.epoch;
    changed = true;
  }
  const chats = frame.chats;
  if (chats?.snapshot) {
    state.byWith.clear();
    for (const c of chats.conversations ?? []) {
      const conversation = conversationFrom(c);
      state.byWith.set(conversation.with, conversation);
      reconcile(state, conversation);
    }
    for (const p of state.pending.values()) {
      if (p.status === "failed") continue;
      if (p.cid && !byCid(state, p.cid)) {
        // It named a conversation that is no longer here: it went nowhere.
        fail(p, "conversation ended");
      } else if (!p.cid && p.sentOn != null) {
        // A first message that went out on the old socket and is not in the
        // new snapshot: it did not arrive, or its conversation has ended
        // since. Resending could start a conversation with someone who has
        // left and come back meanwhile, so it is left for the person to
        // retry.
        fail(p, "unsure");
      }
    }
    state.synced = true;
    changed = true;
  } else if (chats) {
    for (const c of chats.conversations ?? []) {
      if (c.ended) {
        const gone = byCid(state, c.cid);
        if (gone) state.byWith.delete(gone.with);
        for (const p of state.pending.values()) {
          if (p.cid === c.cid && p.status !== "failed") {
            fail(p, "conversation ended");
          }
        }
        changed = true;
        continue;
      }
      let conversation = state.byWith.get(c.with);
      if (!conversation || conversation.cid !== c.cid) {
        conversation = conversationFrom({ ...c, messages: [] });
        state.byWith.set(c.with, conversation);
      }
      const known = new Set(conversation.messages.map((m) => m.id));
      const fresh = (c.messages ?? []).filter((m) => !known.has(m.id));
      if (fresh.length) {
        conversation.messages.push(...fresh);
        conversation.messages.sort((a, b) => a.seq - b.seq);
        trim(conversation);
        const theirs = fresh.filter((m) => m.from === c.with);
        if (theirs.length) arrived.push({ with: c.with, messages: theirs });
      }
      conversation.seenByMe = c.seenByMe ?? conversation.seenByMe;
      conversation.seenByThem = c.seenByThem ?? conversation.seenByThem;
      conversation.unread = c.unread ?? conversation.unread;
      reconcile(state, conversation);
      changed = true;
    }
  }
  for (const ack of frame.acks ?? []) {
    if (applyAck(state, ack)) changed = true;
  }
  if (frame.typing) {
    state.typing = [...frame.typing];
    changed = true;
  }
  if (frame.messageRules) {
    state.rules = { ...frame.messageRules };
    changed = true;
  }
  return { changed, arrived };
}

/** Applies one answer to a send. Returns whether anything changed. */
export function applyAck(state, ack, now = Date.now()) {
  const p = state.pending.get(ack.clientId);
  if (!p) return false;
  if (!ack.error) {
    p.cid = ack.cid ?? p.cid;
    // The message itself may already be here (echo or snapshot first).
    const conversation = byCid(state, p.cid);
    if (conversation?.messages.some((m) => m.id === ack.id)) {
      state.pending.delete(ack.clientId);
    } else {
      p.status = "sent";
      p.id = ack.id;
      p.seq = ack.seq;
    }
    return true;
  }
  if (ack.error === "too fast" || ack.error === "not ready") {
    p.status = "sending";
    p.retryAt = now + (ack.retryAfter ?? NOT_READY_WAIT);
    p.sentOn = null;
    return true;
  }
  fail(p, ack.error);
  return true;
}

/** Starts a send: returns the pending item (shown at once). */
export function queueSend(state, { to, text, clientId, now = Date.now() }) {
  const conversation = state.byWith.get(to);
  const p = {
    clientId,
    to,
    cid: conversation?.cid ?? null,
    text,
    createdAt: now,
    status: "sending",
    error: null,
    retryAt: 0,
    /** The connection it last went out on. */
    sentOn: null,
  };
  state.pending.set(clientId, p);
  return p;
}

/** The command for a pending send, as of now. */
export function sendCommand(state, p) {
  const command = {
    t: "send",
    epoch: state.epoch ?? 0,
    to: p.to,
    clientId: p.clientId,
    text: p.text,
  };
  if (p.cid) command.cid = p.cid;
  return command;
}

/**
 * The sends that should go out now on connection `connection` (any value
 * that changes with each new socket): those not yet sent on it, and those
 * whose wait is over. Only once that connection's snapshot is in, so
 * nothing is resent before the host has said what already arrived. Sends
 * older than `RESEND_FOR` stop, marked unsure.
 */
export function dueSends(state, connection, now = Date.now()) {
  if (!state.synced) return [];
  const due = [];
  for (const p of state.pending.values()) {
    if (p.status !== "sending") continue;
    if (now - p.createdAt > RESEND_FOR) {
      fail(p, "unsure");
      continue;
    }
    if (p.sentOn === connection || p.retryAt > now) continue;
    p.sentOn = connection;
    p.retryAt = 0;
    due.push(sendCommand(state, p));
  }
  return due;
}

/** A new connection: wait for its snapshot before resending. */
export function disconnected(state) {
  state.synced = false;
  state.typing = [];
}

/** People no longer at the table: first messages to them (no conversation
 *  yet) go nowhere. */
export function rosterChanged(state, keys) {
  const here = new Set(keys);
  for (const p of state.pending.values()) {
    if (!p.cid && !here.has(p.to) && p.status === "sending") {
      fail(p, "not at the table");
    }
  }
}

/** Retries a failed send with a fresh id. */
export function retrySend(state, clientId, newId, now = Date.now()) {
  const old = state.pending.get(clientId);
  if (!old) return null;
  state.pending.delete(clientId);
  return queueSend(state, {
    to: old.to,
    text: old.text,
    clientId: newId,
    now,
  });
}

/** Drops a failed send from view. */
export function discardSend(state, clientId) {
  return state.pending.delete(clientId);
}

/** Total unread, and per person. */
export function unreadCounts(state) {
  const per = {};
  let total = 0;
  for (const c of state.byWith.values()) {
    if (c.unread) {
      per[c.with] = c.unread;
      total += c.unread;
    }
  }
  return { per, total };
}

/**
 * What the card shows for the conversation with `withKey`: its messages
 * with pending sends after them, who is typing, and the line under your
 * newest message ("Sending…", "Sent", "Seen", "Not sent").
 */
export function conversationView(state, withKey, you) {
  const c = state.byWith.get(withKey);
  const items = (c?.messages ?? []).map((m) => ({
    id: m.id,
    seq: m.seq,
    mine: m.from === you,
    text: m.text,
    at: m.at,
  }));
  for (const p of state.pending.values()) {
    if (p.to !== withKey) continue;
    items.push({
      id: "pending:" + p.clientId,
      clientId: p.clientId,
      mine: true,
      text: p.text,
      at: p.createdAt,
      pending: p.status,
      error: p.error,
    });
  }
  const lastMine = [...items].reverse().find((m) => m.mine);
  let status = null;
  if (lastMine) {
    if (lastMine.pending === "failed") {
      status = lastMine.error === "unsure" ? "unsure" : "failed";
    } else if (lastMine.pending === "sending") status = "sending";
    else if (lastMine.pending === "sent") status = "sent";
    else if (c && lastMine.seq <= c.seenByThem) status = "seen";
    else status = "sent";
  }
  // The newest of your messages they have seen carries "Seen".
  const seenId =
    c && c.seenByThem
      ? ([...items]
          .reverse()
          .find((m) => m.mine && m.seq && m.seq <= c.seenByThem)?.id ?? null)
      : null;
  return {
    cid: c?.cid ?? null,
    items,
    trimmed: Boolean(c?.trimmed),
    status,
    statusFor: lastMine?.id ?? null,
    seenId,
    typing: state.typing.includes(withKey),
    unread: c?.unread ?? 0,
    lastSeq: c?.messages.at(-1)?.seq ?? 0,
    seenByMe: c?.seenByMe ?? 0,
  };
}

/** A pause this long between two messages gets a time line between them. */
export const TIME_GAP = 5 * 60_000;

/**
 * The conversation's items with a time line (`{ kind: "time", id, at }`)
 * before the first and wherever it paused for `gap` or crossed midnight.
 * Sent messages carry the host's clock and `offset` (this clock minus the
 * host's) brings them to this one; pending sends are already on it. `at`
 * on a time line is this device's clock.
 */
export function withTimeBreaks(items, { offset = 0, gap = TIME_GAP } = {}) {
  const out = [];
  let last = null;
  for (const item of items) {
    const at = item.at ? (item.pending ? item.at : item.at + offset) : null;
    if (
      at != null &&
      (last == null || at - last >= gap || !sameDay(at, last))
    ) {
      out.push({ kind: "time", id: "time:" + item.id, at });
    }
    out.push(item);
    if (at != null) last = at;
  }
  return out;
}

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}
