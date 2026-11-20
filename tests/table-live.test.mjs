import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_PROTOCOL, tableSocket } from "../src/lib/table-live.js";

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
