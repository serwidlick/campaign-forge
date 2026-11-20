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
