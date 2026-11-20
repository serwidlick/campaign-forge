import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIVE_PROTOCOL,
  ROSTER_PALETTE,
  rosterColour,
  rosterInitials,
  tableSocket,
} from "../src/lib/table-live.js";

function connect(t) {
  let peer;
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() {
      peer = this;
    }
    close() {}
  };
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://forge.local"),
  });
  t.after(() => {
    globalThis.WebSocket = originalSocket;
    if (location) Object.defineProperty(globalThis, "location", location);
    else delete globalThis.location;
  });
  const reader = tableSocket("test-ticket");
  t.after(() => reader.close());
  peer.protocol = LIVE_PROTOCOL;
  peer.send = () => {};
  peer.onopen();
  return {
    reader,
    send: (event) => peer.onmessage({ data: JSON.stringify(event) }),
    disconnect: () => peer.onclose(),
  };
}

const closed = { version: 0, gm: false, closed: true, spotlightSeq: 0 };

test("a busy reader receives host shutdown even when its queue is full", async (t) => {
  const { reader, send, disconnect } = connect(t);
  for (let version = 1; version <= 16; version++) send({ version, gm: false });
  send(closed);
  disconnect();
  assert.deepEqual(await reader.next(), closed);
  await assert.rejects(reader.next(), /disconnected/i);
});

test("an unexpected disconnect discards queued changes and requires a new snapshot", async (t) => {
  const { reader, send, disconnect } = connect(t);
  send({ version: 1, gm: false });
  disconnect();
  await assert.rejects(reader.next(), /disconnected/i);
});

test("roster initials take whole graphemes from the first and last words", () => {
  assert.equal(rosterInitials("mira"), "M");
  assert.equal(rosterInitials("  Mary   Jane Watson "), "MW");
  assert.equal(rosterInitials("élodie ørsted"), "ÉØ");
  assert.equal(rosterInitials("👩‍🚀 Ada"), "👩‍🚀A");
  assert.equal(rosterInitials("   "), "?");
  assert.equal(rosterInitials(""), "?");
});

test("a roster key always gets the same palette colour", () => {
  for (const key of ["host", "player:p1", "guest:4b0c"]) {
    assert.equal(rosterColour(key), rosterColour(key));
    assert.ok(ROSTER_PALETTE.includes(rosterColour(key)));
  }
  const spread = new Set(
    Array.from({ length: 64 }, (_, i) => rosterColour(`guest:${i}`)),
  );
  assert.ok(spread.size >= ROSTER_PALETTE.length - 1);
});

function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

test("every roster colour meets 4.5:1 contrast with white initials", () => {
  for (const colour of ROSTER_PALETTE) {
    const ratio = 1.05 / (luminance(colour) + 0.05);
    assert.ok(ratio >= 4.5, `${colour} is only ${ratio.toFixed(2)}:1`);
  }
});
