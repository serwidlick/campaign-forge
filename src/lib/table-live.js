export const LIVE_PROTOCOL = "table.ws.v1";

/** One reader per joined browser tab. Queue overflow forces a fresh snapshot. */
export function tableSocket(ticket, player = false) {
  const { location, WebSocket, clearTimeout, setTimeout } = globalThis;
  if (location.protocol !== "https:" && location.protocol !== "http:")
    throw new Error("Unsupported table URL");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(
    scheme + "//" + location.host + "/api/live",
    LIVE_PROTOCOL,
  );
  const queue = [];
  let waiting;
  let shutdown;
  let ended = false;
  let timer;
  function close() {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    queue.length = 0;
    socket.close();
    waiting?.reject(new Error("Table disconnected"));
    waiting = undefined;
  }
  function deadline(ms) {
    clearTimeout(timer);
    timer = setTimeout(close, ms);
  }
  deadline(10000);
  socket.onopen = () => {
    if (ended || socket.protocol !== LIVE_PROTOCOL) return close();
    socket.send(JSON.stringify({ ticket, player }));
  };
  socket.onclose = socket.onerror = close;
  socket.onmessage = ({ data }) => {
    if (ended) return;
    deadline(55000);
    if (data === "heartbeat") return;
    try {
      const change = JSON.parse(data);
      if (typeof change.version !== "number" || typeof change.gm !== "boolean")
        return close();
      if (change.closed === true) {
        // The host can close the wire before the UI finishes its previous event.
        if (waiting) waiting.resolve(change);
        else shutdown = change;
        waiting = undefined;
        close();
        return;
      }
      if (waiting) {
        waiting.resolve(change);
        waiting = undefined;
      } else if (queue.length < 16) {
        queue.push(change);
      } else close();
    } catch {
      close();
    }
  };
  return {
    close() {
      shutdown = undefined;
      close();
    },
    next() {
      if (shutdown) {
        const change = shutdown;
        shutdown = undefined;
        return Promise.resolve(change);
      }
      if (ended || waiting)
        return Promise.reject(new Error("Table disconnected"));
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
  };
}

/** Host frames carry complete replacement summaries for each updated id. */
export function applyDelta(elements, delta) {
  const visible = new Map((delta.reset ? [] : elements).map((e) => [e.id, e]));
  for (const id of delta.removed) visible.delete(id);
  for (const e of delta.upserts) visible.set(e.id, e);
  return [...visible.values()].sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Roster icon backgrounds, shared by the app and the phone page so a person
 * has the same colour everywhere. Each meets WCAG 4.5:1 with white initials
 * (tests/table-live.test.mjs checks it).
 */
export const ROSTER_PALETTE = Object.freeze([
  "#b42318",
  "#b54708",
  "#027a48",
  "#107569",
  "#026aa2",
  "#175cd3",
  "#5925dc",
  "#c11574",
]);

function firstGrapheme(word) {
  const { Intl } = globalThis;
  if (Intl && typeof Intl.Segmenter === "function") {
    const first = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(word)
      [Symbol.iterator]()
      .next();
    return first.done ? "" : first.value.segment;
  }
  return Array.from(word)[0] ?? "";
}

/** Up to two letters, whole graphemes, from the first and last words. */
export function rosterInitials(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const first = firstGrapheme(words[0]);
  const last = words.length > 1 ? firstGrapheme(words[words.length - 1]) : "";
  return (first + last).toLocaleUpperCase();
}

/** 32-bit FNV-1a of the roster key into the palette: stable everywhere. */
export function rosterColour(key) {
  let hash = 0x811c9dc5;
  const text = String(key);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ROSTER_PALETTE[hash % ROSTER_PALETTE.length];
}
