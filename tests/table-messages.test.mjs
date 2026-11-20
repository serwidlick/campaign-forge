import assert from "node:assert/strict";
import { test } from "node:test";

import { TableChat } from "../src/lib/presence/chat.js";
import {
  RESEND_FOR,
  applyAck,
  applyFrame,
  conversationView,
  disconnected,
  dueSends,
  emptyChats,
  queueSend,
  rosterChanged,
  unreadCounts,
  withTimeBreaks,
} from "../src/lib/presence/conversation.js";
import { daysAgo, formatClock } from "../src/lib/presence/time.js";
import { CARD_GAP, placeCard } from "../src/lib/presence/placement.js";
import { setHapticDriver } from "../src/lib/presence/haptics.js";

setHapticDriver(() => {});

const ME = "guest:me";
const BO = "player:bo";

function message(seq, from, text, extra = {}) {
  return { id: "id" + seq + from, seq, from, text, at: seq, ...extra };
}

function snapshot(conversations, extra = {}) {
  return { epoch: 1, chats: { snapshot: true, conversations }, ...extra };
}

test("a snapshot replaces the whole set, and is never news", () => {
  const s = emptyChats();
  applyFrame(
    s,
    snapshot([
      {
        cid: "c1",
        with: BO,
        messages: [message(1, BO, "hi")],
        seenByMe: 0,
        seenByThem: 0,
        unread: 1,
      },
    ]),
  );
  assert.equal(s.synced, true);
  assert.equal(unreadCounts(s).total, 1);
  // Ended while this device was away: the next snapshot simply lacks it.
  const { arrived } = applyFrame(s, snapshot([]));
  assert.equal(s.byWith.size, 0);
  assert.deepEqual(arrived, []);
});

test("live messages from them are news; your own echo is not", () => {
  const s = emptyChats();
  applyFrame(s, snapshot([]));
  const { arrived } = applyFrame(s, {
    chats: {
      conversations: [
        {
          cid: "c1",
          with: BO,
          messages: [message(1, BO, "hey"), message(2, ME, "yo")],
          seenByMe: 0,
          seenByThem: 0,
          unread: 1,
        },
      ],
    },
  });
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].messages.length, 1);
  assert.equal(arrived[0].messages[0].text, "hey");
  // The same frame again adds nothing.
  const again = applyFrame(s, {
    chats: {
      conversations: [
        {
          cid: "c1",
          with: BO,
          messages: [message(1, BO, "hey")],
          seenByMe: 0,
          seenByThem: 0,
          unread: 1,
        },
      ],
    },
  });
  assert.equal(again.arrived.length, 0);
  assert.equal(s.byWith.get(BO).messages.length, 2);
});

test("a send waits for its snapshot, goes out once per connection, and settles", () => {
  const s = emptyChats();
  queueSend(s, { to: BO, text: "first", clientId: "m1", now: 0 });
  assert.deepEqual(dueSends(s, 0, 0), [], "nothing before the snapshot");
  applyFrame(s, snapshot([]));
  const out = dueSends(s, 0, 0);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    t: "send",
    epoch: 1,
    to: BO,
    clientId: "m1",
    text: "first",
  });
  assert.deepEqual(dueSends(s, 0, 0), [], "not twice on one connection");
  // The socket drops before any answer: the next one resends it.
  disconnected(s);
  applyFrame(s, snapshot([]));
  assert.equal(dueSends(s, 1, 10).length, 1);
  // Two minutes on, it stops and says it may not have gone.
  disconnected(s);
  applyFrame(s, snapshot([]));
  assert.equal(dueSends(s, 2, RESEND_FOR + 1).length, 0);
  assert.equal(conversationView(s, BO, ME).status, "unsure");
});

test("ack, echo and snapshot settle a send in any order, with no copies", () => {
  for (const order of [
    "ack-first",
    "echo-first",
    "snapshot-first",
    "together",
  ]) {
    const s = emptyChats();
    applyFrame(s, snapshot([]));
    queueSend(s, { to: BO, text: "hello", clientId: "m1", now: 0 });
    dueSends(s, 0, 0);
    const ack = { clientId: "m1", id: "real", cid: "c1", seq: 1 };
    const conversation = {
      cid: "c1",
      with: BO,
      messages: [
        { id: "real", seq: 1, from: ME, text: "hello", at: 1, clientId: "m1" },
      ],
      seenByMe: 1,
      seenByThem: 0,
      unread: 0,
    };
    const echo = { chats: { conversations: [conversation] } };
    if (order === "ack-first") {
      applyFrame(s, { acks: [ack] });
      applyFrame(s, echo);
    } else if (order === "echo-first") {
      applyFrame(s, echo);
      applyFrame(s, { acks: [ack] });
    } else if (order === "snapshot-first") {
      // The ack was lost with the socket; the next snapshot has the message.
      disconnected(s);
      applyFrame(s, snapshot([conversation]));
      assert.deepEqual(dueSends(s, 1, 1), [], "nothing to resend");
    } else {
      applyFrame(s, { ...echo, acks: [ack] });
    }
    const view = conversationView(s, BO, ME);
    assert.equal(view.items.length, 1, order);
    assert.equal(view.items[0].id, "real", order);
    assert.equal(view.status, "sent", order);
  }
});

test("a send into a conversation that ended, or to someone who left, fails", () => {
  const s = emptyChats();
  applyFrame(
    s,
    snapshot([
      {
        cid: "c1",
        with: BO,
        messages: [],
        seenByMe: 0,
        seenByThem: 0,
        unread: 0,
      },
    ]),
  );
  queueSend(s, { to: BO, text: "still there?", clientId: "m1", now: 0 });
  applyFrame(s, { chats: { conversations: [{ cid: "c1", ended: true }] } });
  assert.equal(conversationView(s, BO, ME).status, "failed");
  // A first message (no conversation yet) to someone who then leaves.
  queueSend(s, { to: "guest:x", text: "hi", clientId: "m2", now: 0 });
  rosterChanged(s, ["host", ME]);
  assert.equal(s.pending.get("m2").status, "failed");
});

test("a new identity drops everything of the old one", () => {
  const s = emptyChats();
  applyFrame(
    s,
    snapshot([
      {
        cid: "c1",
        with: BO,
        messages: [message(1, BO, "a")],
        seenByMe: 0,
        seenByThem: 0,
        unread: 1,
      },
    ]),
  );
  queueSend(s, { to: BO, text: "x", clientId: "m1", now: 0 });
  applyFrame(s, { epoch: 2, chats: { snapshot: true, conversations: [] } });
  assert.equal(s.byWith.size, 0);
  assert.equal(s.pending.get("m1").status, "failed");
  assert.equal(s.pending.get("m1").error, "identity changed");
});

test("too fast waits and goes again; a refusal fails", () => {
  const s = emptyChats();
  applyFrame(s, snapshot([]));
  queueSend(s, { to: BO, text: "x", clientId: "m1", now: 0 });
  dueSends(s, 0, 0);
  applyAck(s, { clientId: "m1", error: "too fast", retryAfter: 2000 }, 0);
  assert.deepEqual(dueSends(s, 0, 1000), []);
  assert.equal(dueSends(s, 0, 2000).length, 1);
  applyAck(s, { clientId: "m1", error: "not allowed" }, 2000);
  assert.equal(conversationView(s, BO, ME).status, "failed");
});

test("Seen marks your newest message they have read", () => {
  const s = emptyChats();
  applyFrame(
    s,
    snapshot([
      {
        cid: "c1",
        with: BO,
        messages: [
          message(1, ME, "one"),
          message(2, ME, "two"),
          message(3, BO, "ok"),
        ],
        seenByMe: 3,
        seenByThem: 1,
        unread: 0,
      },
    ]),
  );
  let view = conversationView(s, BO, ME);
  assert.equal(view.status, "sent", "two is not seen yet");
  assert.equal(view.seenId, "id1" + ME);
  applyFrame(s, {
    chats: {
      conversations: [
        {
          cid: "c1",
          with: BO,
          messages: [],
          seenByMe: 3,
          seenByThem: 2,
          unread: 0,
        },
      ],
    },
  });
  view = conversationView(s, BO, ME);
  assert.equal(view.status, "seen");
  assert.equal(view.statusFor, "id2" + ME);
});

test("a card opens beside its bubble, away from the edge, inside the area", () => {
  const area = {
    left: 0,
    top: 0,
    right: 1200,
    bottom: 800,
    width: 1200,
    height: 800,
  };
  const bubble = { left: 10, top: 380, width: 42, height: 42 };
  const size = { width: 300, height: 400 };
  const left = placeCard(area, bubble, "left", size);
  assert.equal(left.x, 10 + 42 + CARD_GAP);
  assert.equal(left.sheet, false);
  assert.equal(left.origin.x, 10 + 21 - left.x, "grows from the bubble");
  const right = placeCard(area, { ...bubble, left: 1148 }, "right", size);
  assert.equal(right.x, 1148 - CARD_GAP - 300);
  // Near the top: clamped inside.
  const high = placeCard(area, { ...bubble, top: 0 }, "left", size);
  assert.equal(high.y, CARD_GAP);
  // A phone: a sheet across the bottom, or the top when docked at the bottom.
  const phone = {
    left: 0,
    top: 0,
    right: 375,
    bottom: 800,
    width: 375,
    height: 800,
  };
  const sheet = placeCard(phone, bubble, "left", size);
  assert.equal(sheet.sheet, true);
  assert.equal(sheet.width, 375 - 2 * CARD_GAP);
  assert.equal(sheet.y, 800 - CARD_GAP - 400);
  assert.equal(placeCard(phone, bubble, "bottom", size).y, CARD_GAP);
});

test("the chat controller resends on a new socket after its snapshot", async () => {
  const sent = [];
  let up = true;
  const chat = new TableChat({
    send: (command) => {
      if (!up) return false;
      sent.push(command);
      return true;
    },
    now: () => 0,
  });
  chat.receive({
    you: ME,
    epoch: 4,
    chats: { snapshot: true, conversations: [] },
  });
  chat.sendMessage(BO, "  hello  ");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "hello");
  assert.equal(sent[0].epoch, 4);
  chat.connected(false);
  up = false;
  chat.sendMessage(BO, "while down");
  chat.connected(true);
  up = true;
  assert.equal(sent.length, 1, "waits for the snapshot");
  chat.receive({ epoch: 4, chats: { snapshot: true, conversations: [] } });
  assert.deepEqual(
    sent.slice(1).map((c) => c.text),
    ["hello", "while down"],
  );
  chat.dispose();
});

test("the hosting window's chat takes acks straight from its commands", async () => {
  const chat = new TableChat({
    send: (command) =>
      Promise.resolve(
        command.t === "send"
          ? { clientId: command.clientId, id: "m", cid: "c", seq: 1 }
          : undefined,
      ),
    now: () => 0,
  });
  chat.you = "host";
  chat.receive({ chats: { snapshot: true, conversations: [] } });
  const shown = [];
  const fake = {
    setSectionState: (_, state) => shown.push(state),
    setUnread() {},
    setActivity() {},
    addEventListener() {},
    removeEventListener() {},
  };
  chat.attach(fake);
  chat.sendMessage(BO, "hi");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const view = shown.at(-1).view(BO);
  assert.equal(view.items.length, 1);
  assert.equal(view.status, "sent");
  chat.dispose();
});

test("a time line goes above the first message and after every pause", () => {
  const noon = new Date(2026, 10, 20, 12, 0).getTime();
  const min = 60_000;
  const items = [
    { id: "a", at: noon },
    { id: "b", at: noon + 2 * min },
    { id: "c", at: noon + 9 * min },
    { id: "d", at: noon + 10 * min, pending: "sending" },
  ];
  const shown = withTimeBreaks(items).map((i) => i.id);
  assert.deepEqual(shown, ["time:a", "a", "b", "time:c", "c", "d"]);
  // Host times are moved onto this clock; pending ones already are.
  const ahead = withTimeBreaks(items, { offset: 3 * min });
  assert.equal(ahead[0].at, noon + 3 * min);
  // A pause across midnight always gets a line, however short.
  const late = new Date(2026, 10, 20, 23, 58).getTime();
  const marks = withTimeBreaks([
    { id: "x", at: late },
    { id: "y", at: late + 3 * min },
  ]).map((i) => i.id);
  assert.deepEqual(marks, ["time:x", "x", "time:y", "y"]);
});

test("times read as today, yesterday, the weekday, then the date", () => {
  const now = new Date(2026, 10, 20, 9, 0).getTime();
  const at = (d, h) => new Date(2026, 10, d, h, 30).getTime();
  assert.equal(daysAgo(at(20, 8), now), 0);
  assert.equal(daysAgo(at(19, 23), now), 1, "late last night is yesterday");
  assert.equal(daysAgo(at(14, 12), now), 6);
  const today = formatClock(at(20, 8), now, "en-GB");
  assert.match(today, /^0?8:30$/);
  assert.match(formatClock(at(19, 23), now, "en-GB"), /^Yesterday 23:30$/);
  assert.match(formatClock(at(16, 10), now, "en-GB"), /^Monday 10:30$/);
  assert.match(formatClock(at(2, 10), now, "en-GB"), /^2 Nov 10:30$/);
});
