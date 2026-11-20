import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityOf,
  defineActivity,
  inwardFrom,
} from "../src/lib/presence/activities.js";
import {
  clampToArea,
  nearestSide,
  placeOnEdge,
  snapToEdge,
} from "../src/lib/presence/dock.js";
import {
  defineHaptic,
  haptic,
  setHapticDriver,
  setHapticsEnabled,
} from "../src/lib/presence/haptics.js";
import { SHUFFLE, tripFrames } from "../src/lib/presence/motion.js";
import { defineStatus, statusOf } from "../src/lib/presence/statuses.js";
import { elapsedSince, formatDuration } from "../src/lib/presence/time.js";
import { shownEntries, viewRoster } from "../src/lib/presence/view.js";

const area = {
  left: 10,
  top: 20,
  right: 410,
  bottom: 820,
  width: 400,
  height: 800,
};
const column = { width: 50, height: 200 };
const row = { width: 200, height: 50 };

test("a group sits on its edge, its fraction of the way along", () => {
  assert.deepEqual(placeOnEdge(area, { side: "left", t: 0 }, column), {
    x: 10,
    y: 20,
  });
  assert.deepEqual(placeOnEdge(area, { side: "left", t: 1 }, column), {
    x: 10,
    y: 620,
  });
  assert.deepEqual(placeOnEdge(area, { side: "right", t: 0.5 }, column), {
    x: 360,
    y: 320,
  });
  assert.deepEqual(placeOnEdge(area, { side: "top", t: 0.5 }, row), {
    x: 110,
    y: 20,
  });
  assert.deepEqual(placeOnEdge(area, { side: "bottom", t: 1 }, row), {
    x: 210,
    y: 770,
  });
});

test("a carried group stays inside the area", () => {
  assert.deepEqual(clampToArea(area, column, -50, 900), { x: 10, y: 620 });
  assert.deepEqual(clampToArea(area, column, 100, 100), { x: 100, y: 100 });
});

test("a dropped group snaps to the nearest edge, keeping its place along it", () => {
  const sizeOn = (side) => (side === "left" || side === "right" ? column : row);
  // Near the right edge, halfway down.
  assert.deepEqual(
    snapToEdge(area, { x: 340, y: 320, width: 50, height: 200 }, sizeOn),
    { side: "right", t: 0.5 },
  );
  // Near the bottom, at the far left: a row at the start of the edge.
  const bottom = snapToEdge(
    area,
    { x: 40, y: 705, width: 50, height: 110 },
    sizeOn,
  );
  assert.equal(bottom.side, "bottom");
  assert.equal(bottom.t, 0);
  assert.equal(
    nearestSide(area, { x: 200, y: 25, width: 10, height: 10 }),
    "top",
  );
});

test("durations read like a person would say them", () => {
  assert.equal(formatDuration(5_000), "just now");
  assert.equal(formatDuration(7 * 60_000), "7 min");
  assert.equal(formatDuration(60 * 60_000), "1 h");
  assert.equal(formatDuration(125 * 60_000), "2 h 5 min");
  assert.equal(formatDuration(26 * 60 * 60_000), "1 day");
  assert.equal(formatDuration(-1), "just now");
  // Seven minutes ago on the host, read on a phone two seconds ahead.
  assert.equal(
    elapsedSince(1_000_000, 1_000_000 + 7 * 60_000 + 2_000, 2_000),
    7 * 60_000,
  );
});

test("the built-in statuses describe active, away and disconnected", () => {
  const ctx = { now: 10 * 60_000, offset: 0 };
  assert.equal(statusOf("active").detail({}, ctx), "here");
  assert.equal(statusOf("active").badge.dot, true);
  const away = statusOf("away");
  assert.equal(away.detail({ awaySince: 3 * 60_000 }, ctx), "away for 7 min");
  assert.equal(away.badgeTip({ awaySince: 3 * 60_000 }, ctx), "Away for 7 min");
  assert.equal(away.detail({}, ctx), "away");
  assert.equal(away.ticks, true);
  assert.equal(statusOf("disconnected").face, "gone");
});

test("statuses are a registry, and unknown ones read as plain words", () => {
  defineStatus("busy", {
    label: "busy",
    badge: { icon: "moon", tone: "muted" },
  });
  assert.equal(statusOf("busy").detail({}, { now: 0, offset: 0 }), "busy");
  assert.equal(
    statusOf("dancing").detail({}, { now: 0, offset: 0 }),
    "dancing",
  );
  assert.equal(statusOf("dancing").badge, null);
});

test("activities are a registry with animations aimed away from the edge", () => {
  const messaging = activityOf("messaging");
  assert.equal(messaging.badge, "message");
  assert.equal(messaging.options.iterations, Infinity);
  const frames = messaging.keyframes({
    side: "right",
    inward: inwardFrom("right"),
  });
  assert.match(frames[1].transform, /translate\(-7px, 0px\)/);
  assert.equal(activityOf("messaged").options.iterations, 3);
  defineActivity("rolling", { label: "rolling dice", keyframes: [] });
  assert.equal(activityOf("rolling").target, "face");
  assert.equal(activityOf("nothing"), null);
  assert.deepEqual(inwardFrom("top"), { x: 0, y: 1 });
});

test("each bubble's shuffle trip starts where it was and lands in place", () => {
  const frames = tripFrames(-120, 300, 0);
  assert.equal(frames[0].transform, "translate(-120px, 300px) scale(1)");
  assert.equal(frames[2].transform, "translate(0px, 0px) scale(1)");
  assert.equal(frames[1].offset, 0.5);
  assert.ok(frames[1].transform.endsWith(`scale(${SHUFFLE.squeeze})`));
});

test("neighbours bow to opposite sides, by at most the arc limit", () => {
  const mid = (index) => {
    const [x, y] = tripFrames(0, 400, index)[1]
      .transform.match(/-?[\d.]+(?=px)/g)
      .map(Number);
    return { x, y };
  };
  // A trip straight down bows sideways, half way along.
  assert.equal(mid(0).y, 200);
  assert.equal(Math.abs(mid(0).x), SHUFFLE.maxArc);
  assert.equal(mid(0).x, -mid(1).x);
  // A short trip bows in proportion, and no trip bows at all on the spot.
  const short = tripFrames(50, 0, 0)[1].transform;
  assert.ok(short.startsWith("translate(25px, 7px)"));
  assert.equal(
    tripFrames(0, 0, 3)[1].transform,
    "translate(0px, 0px) scale(0.88)",
  );
});

const table = [
  { key: "host", name: "Ava", role: "host", state: "away", awaySince: 5 },
  { key: "guest:a", name: "Bo", role: "guest", state: "active" },
  {
    key: "player:c",
    name: "Cy",
    role: "player",
    state: "active",
    activity: "messaging",
  },
];

test("your own entry is marked, and nothing else changes while online", () => {
  const seen = viewRoster(table, { you: "player:c" });
  assert.deepEqual(
    seen.map((e) => e.key),
    ["host", "player:c", "guest:a"],
    "host first, then you, then the rest in the host's order",
  );
  assert.equal(seen[1].self, true);
  assert.equal(
    seen[0],
    table[0],
    "other entries are passed through as they are",
  );
  assert.deepEqual(viewRoster(table, {}), table);
  assert.equal(table[2].self, undefined, "the stored roster is never changed");
});

test("offline, the host and you are disconnected and the rest are last seen", () => {
  const seen = viewRoster(table, { you: "player:c", offline: true });
  assert.equal(seen[0].state, "disconnected");
  assert.equal(seen[0].awaySince, undefined);
  assert.equal(seen[1].state, "disconnected");
  assert.equal(seen[1].activity, undefined);
  assert.equal(seen[1].self, true);
  assert.equal(seen[2].state, "active");
  assert.equal(seen[2].stale, true);
  assert.equal(table[0].state, "away");
});

test("you come right after the host, so +N never folds you away", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    key: i ? "guest:" + i : "host",
    role: i ? "guest" : "host",
  }));
  const seen = viewRoster(many, { you: "guest:7" });
  assert.deepEqual(
    shownEntries(seen, 4, false).map((e) => e.key),
    ["host", "guest:7", "guest:1"],
  );
  // Without a host (a test page, say), you lead.
  assert.equal(viewRoster(many.slice(1), { you: "guest:7" })[0].key, "guest:7");
  assert.equal(shownEntries(seen, 4, true).length, 9);
  assert.equal(shownEntries(many.slice(0, 4), 4, false).length, 4);
});

test("haptics are named patterns through a replaceable driver", () => {
  const felt = [];
  setHapticDriver((kind, pattern) => felt.push([kind, pattern]));
  try {
    assert.equal(haptic("snap"), true);
    assert.equal(haptic("nothing"), false);
    defineHaptic("dice", [12, 40, 12]);
    haptic("dice");
    setHapticsEnabled(false);
    assert.equal(haptic("snap"), false);
    setHapticsEnabled(true);
    setHapticDriver(() => {
      throw new Error("no motor");
    });
    assert.equal(haptic("tap"), false, "a failing driver never throws");
  } finally {
    setHapticDriver(null);
  }
  assert.deepEqual(felt, [
    ["snap", [12]],
    ["dice", [12, 40, 12]],
  ]);
  // Without a Vibration API (Node, iOS Safari) the default is a quiet no.
  assert.equal(haptic("snap"), true);
});
