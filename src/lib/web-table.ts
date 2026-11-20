/**
 * The table, spoken to from a browser. When the frontend runs as the `/gm`
 * page a GM's machine serves, there is no Rust side of its own: this module
 * does what `src-tauri/src/table/client.rs` does for the app, over `fetch`
 * against the page's own origin, and `lib/tauri.ts` routes the usual
 * commands here.
 *
 * The browser's device key is the one the phone page uses (same seed, same
 * place in `localStorage`), so pairing either page pairs the browser.
 */
import nacl from "tweetnacl";

import { LIVE_PROTOCOL, tableSocket } from "./table-live.js";
import type {
  Element,
  NoteInput,
  TableChange,
  TableInfo,
  TableSession,
} from "./types";

/** Shared with the phone page, so both are the same device to the GM. */
const SEED_KEY = "cf.deviceSeed";
const SESSION_KEY = "cf.webSession";
/** Error text the table store recognises as "the table closed". */
export const CLOSED_ERROR = "TABLE_CLOSED";

interface JoinResponse {
  token: string;
  info: TableInfo;
  name: string;
  playerId?: string | null;
  recognized?: boolean;
  gm?: boolean;
}

interface Stored {
  token: string;
  session: TableSession;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** This browser's key pair, made on first use; null when it cannot have one. */
function deviceKey(): nacl.SignKeyPair | null {
  try {
    const stored = localStorage.getItem(SEED_KEY);
    let seed = stored ? fromB64(stored) : null;
    if (!seed || seed.length !== 32) {
      seed = nacl.randomBytes(32);
      localStorage.setItem(SEED_KEY, b64(seed));
    }
    return nacl.sign.keyPair.fromSeed(seed);
  } catch {
    return null;
  }
}

/** "Browser (Windows)", "Tablet (iOS)"... the same wording as the phone page. */
export function deviceLabel(): string {
  const ua = navigator.userAgent || "";
  const kind = /iPad|Tablet/i.test(ua)
    ? "Tablet"
    : /iPhone|Mobile/i.test(ua)
      ? "Phone"
      : "Browser";
  const os = /iPhone|iPad/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
      ? "Android"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  return os ? `${kind} (${os})` : kind;
}

function stored(): Stored | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function remember(s: Stored | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* no storage: the session lasts until the page is closed */
  }
}

let current: Stored | null = stored();
let live: ReturnType<typeof tableSocket> | undefined;

function closeLive() {
  live?.close();
  live = undefined;
}

/** The table's answer turned into the plain-string errors the stores expect. */
async function failure(resp: Response): Promise<string> {
  if (resp.status === 401) return "TABLE_UNAUTHORIZED";
  if (resp.status === 410) return CLOSED_ERROR;
  const body = (await resp.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string"
    ? body.error
    : `the table answered ${resp.status}`;
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (current) headers.set("Authorization", `Bearer ${current.token}`);
  let resp: Response;
  try {
    resp = await fetch(path, { ...init, headers });
  } catch {
    throw "could not reach the table (is the GM still hosting?)";
  }
  if (!resp.ok) throw await failure(resp);
  return resp;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json() as Promise<T>;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const UPGRADE_HOST =
  "Update the GM’s host and your client to compatible WebSocket versions to join this table.";

function requireLiveHost(info: TableInfo) {
  if (info.liveProtocol !== LIVE_PROTOCOL) throw UPGRADE_HOST;
}

export const web = {
  /**
   * Sits down at this page's own table as a GM. The browser's key is the
   * whole proof: the table seats this page only when the GM has paired the
   * browser (on the phone page) and made that player a GM, so there is no
   * code to give and the name on file is used.
   */
  async join(name: string): Promise<TableSession> {
    closeLive();
    current = null;
    requireLiveHost(await json<TableInfo>("/api/table"));
    const key = deviceKey();
    if (!key) {
      throw "this browser cannot make a device key, so the GM cannot pair it; try another browser";
    }
    let device: Record<string, string> | undefined;
    if (key) {
      const challenge = await json<{ nonce: string }>("/api/challenge");
      device = {
        publicKey: b64(key.publicKey),
        label: deviceLabel(),
        nonce: challenge.nonce,
        signature: b64(
          nacl.sign.detached(
            new TextEncoder().encode(challenge.nonce),
            key.secretKey,
          ),
        ),
      };
    }
    const joined = await json<JoinResponse>(
      "/api/join",
      postJson({ name, device, gmOnly: true, liveProtocol: LIVE_PROTOCOL }),
    );
    requireLiveHost(joined.info);
    const session: TableSession = {
      address: location.host,
      playerName: joined.name,
      playerId: joined.playerId ?? null,
      recognized: joined.recognized ?? false,
      gm: joined.gm ?? false,
      info: joined.info,
    };
    current = { token: joined.token, session };
    remember(current);
    return session;
  },

  /** The table joined before a reload, if its token still works. */
  async session(): Promise<TableSession | null> {
    if (!current) return null;
    // A seat from before this page became GM-only is no seat here.
    if (
      !current.session.gm ||
      current.session.info.liveProtocol !== LIVE_PROTOCOL
    ) {
      current = null;
      remember(null);
      return null;
    }
    try {
      await request("/api/elements");
      return current.session;
    } catch (err) {
      if (err === CLOSED_ERROR || err === "TABLE_UNAUTHORIZED") {
        current = null;
        remember(null);
        return null;
      }
      // Unreachable right now: keep the session and let the sync loop retry.
      return current.session;
    }
  },

  leave(): void {
    closeLive();
    current = null;
    remember(null);
  },

  async fetchElement(id: string): Promise<Element | null> {
    const resp = await fetch(`/api/elements/${id}`, {
      headers: current ? { Authorization: `Bearer ${current.token}` } : {},
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw await failure(resp);
    return resp.json() as Promise<Element>;
  },

  async fetchAsset(path: string): Promise<ArrayBuffer> {
    return (await request(`/api/assets/${path}`)).arrayBuffer();
  },

  updateSheet(
    id: string,
    sheet: unknown,
    baseVersion: string,
  ): Promise<Element> {
    return json(`/api/elements/${id}/sheet`, {
      ...postJson(sheet),
      headers: {
        "Content-Type": "application/json",
        "X-Base-Version": baseVersion,
      },
      method: "PUT",
    });
  },

  createNote(input: NoteInput): Promise<Element> {
    return json("/api/notes", postJson(input));
  },

  updateNote(id: string, input: NoteInput): Promise<Element> {
    return json(`/api/notes/${id}`, { ...postJson(input), method: "PUT" });
  },

  async deleteNote(id: string): Promise<void> {
    await request(`/api/notes/${id}`, { method: "DELETE" });
  },

  async nextEvent(subscribe: boolean): Promise<TableChange> {
    if (subscribe) closeLive();
    const seat = current;
    if (!seat) throw "TABLE_UNAUTHORIZED";
    if (!live) {
      const { ticket } = await json<{ ticket: string }>("/api/live/ticket", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      if (seat !== current) throw CLOSED_ERROR;
      live = tableSocket(ticket);
    }
    const socket = live;
    try {
      return await socket.next();
    } catch (err) {
      if (live === socket) closeLive();
      throw err;
    }
  },

  // ---- A GM's browser -------------------------------------------------------

  gmCall<T>(command: string, args: unknown): Promise<T> {
    return json("/api/gm/call", postJson({ command, args }));
  },

  async gmAsset(path: string): Promise<ArrayBuffer> {
    return (await request(`/api/gm/assets/${path}`)).arrayBuffer();
  },

  /** Sends a file the user picked in this browser to the hosting machine. */
  upload<T>(
    kind: "map" | "image" | "document",
    id: string | null,
    file: File,
  ): Promise<T> {
    const name = file.name.replace(/\.[^.]+$/, "");
    const query = new URLSearchParams({ name });
    if (id) query.set("id", id);
    return json(`/api/gm/upload/${kind}?${query}`, {
      method: "POST",
      body: file,
    });
  },
};
