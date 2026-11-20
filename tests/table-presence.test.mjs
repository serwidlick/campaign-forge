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
import { defineStatus, statusOf } from "../src/lib/presence/statuses.js";
import { elapsedSince, formatDuration } from "../src/lib/presence/time.js";

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
