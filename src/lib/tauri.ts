/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`.
 * This is the only module in the frontend that calls `invoke`.
 *
 * Every command here can also run on another machine: when this app sits at
 * a table as a GM (`setRemoteGm`), the campaign's commands are sent to the
 * hosting machine over the table (`table_gm_call`) and run against its
 * files, so the whole GM screen works unchanged from a second device. The
 * few commands that only make sense locally, such as opening a campaign
 * folder or reading a file from this disk, stay local.
 *
 * The frontend also runs in a plain browser, as the `/gm` page a hosting
 * machine serves. There is no Rust side then: the table commands go through
 * `web-table.ts` over `fetch`, and the campaign's commands go the same way
 * once the GM has made that browser a GM.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { inTauri, type PickedFile } from "./platform";
import type {
  CampaignMeta,
  ConversationSummary,
  DeviceIdentity,
  DiskChanges,
  Element,
  ElementSummary,
  FoundTable,
  HostStatus,
  PlayerRecord,
  ImportedDocument,
  ImportedImage,
  NoteInput,
  PdfSlice,
  PdfText,
  SaveElementInput,
  SearchHit,
  StoredConversation,
  TableChange,
  TableSession,
} from "./types";
import { deviceLabel, web } from "./web-table";

// ---- Where commands run ------------------------------------------------------

let remoteGm = false;

/**
 * Routes the campaign's commands to the hosting machine (true) or to this
 * one (false). Set by the table store when a GM's device joins a table.
 */
export function setRemoteGm(on: boolean): void {
  remoteGm = on;
}

/** Commands about this machine, never sent over the table. */
const LOCAL_ONLY = new Set([
  "create_campaign",
  "open_campaign",
  "probe_campaigns",
  "extract_document_text",
]);

/**
 * Where a browser keeps the API key when there is no credential store: this
 * tab only, gone when it closes. The page is served over plain HTTP at a
 * name every table shares (`forge.local`), so anything kept for the site
 * would be handed to whichever machine answers that name next; the key is
 * the one thing on the page worth keeping out of that.
 */
const WEB_API_KEY = "cf.apiKey";

/** The key as earlier builds kept it, for the site: moved on first read. */
function readWebApiKey(): string | null {
  const old = localStorage.getItem(WEB_API_KEY);
  if (old !== null) {
    localStorage.removeItem(WEB_API_KEY);
    sessionStorage.setItem(WEB_API_KEY, old);
  }
  return sessionStorage.getItem(WEB_API_KEY);
}

/**
 * A Rust command, or what a browser can do in its place: the table over
 * `fetch`, and a few things that are simply not there (hosting, this
 * machine's folders).
 */
function ipc<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (inTauri) return invoke<T>(command, args);
  return webCommand(command, args) as Promise<T>;
}

async function webCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "table_join":
      return web.join(args.name as string);
    case "table_leave":
      web.leave();
      return;
    case "table_session":
      return web.session();
    case "table_fetch_element":
      return web.fetchElement(args.id as string);
    case "table_fetch_asset":
      return web.fetchAsset(args.path as string);
    case "table_update_sheet":
      return web.updateSheet(
        args.id as string,
        args.sheet,
        args.baseVersion as string,
      );
    case "table_create_note":
      return web.createNote(args.input as NoteInput);
    case "table_update_note":
      return web.updateNote(args.id as string, args.input as NoteInput);
    case "table_delete_note":
      return web.deleteNote(args.id as string);
    case "table_next_event":
      return web.nextEvent(args.subscribe === true);
    case "table_gm_call":
      return web.gmCall(args.command as string, args.args);
    case "table_gm_asset":
      return web.gmAsset(args.path as string);
    case "table_host_status":
      // Not a GM yet: this browser hosts nothing. (As a GM the call is
      // routed to the hosting machine before it gets here.)
      return null;
    case "table_discover":
      return [];
    case "table_discover_stop":
      return;
    case "device_identity":
      return {
        fingerprint: "",
        label: deviceLabel(),
      } satisfies DeviceIdentity;
    case "get_api_key":
      return readWebApiKey();
    case "set_api_key":
      localStorage.removeItem(WEB_API_KEY);
      sessionStorage.setItem(WEB_API_KEY, String(args.key).trim());
      return;
    case "clear_api_key":
      localStorage.removeItem(WEB_API_KEY);
      sessionStorage.removeItem(WEB_API_KEY);
      return;
    default:
      throw `${command.replaceAll("_", " ")} is only available in the Campaign Forge app`;
  }
}

/** Runs a campaign command here, or on the hosting machine as a GM. */
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (remoteGm && !LOCAL_ONLY.has(command)) {
    return ipc<T>("table_gm_call", { command, args: args ?? {} });
  }
  return ipc<T>(command, args);
}

/**
 * Imports a file the user picked. Locally the Rust side reads the path; at
 * a table as a GM, this machine reads it and sends the bytes to the host;
 * in a browser the File's bytes go straight to the host.
 */
function importFile<T>(
  command: string,
  kind: "map" | "image" | "document",
  id: string | null,
  source: PickedFile,
): Promise<T> {
  if (typeof source !== "string") {
    if (!inTauri) return web.upload<T>(kind, id, source);
    return Promise.reject(
      new Error("a File can only be imported from a browser"),
    );
  }
  if (remoteGm) {
    return ipc<T>("table_gm_import", { kind, id, source });
  }
  const args =
    kind === "map"
      ? { mapId: id, source }
      : kind === "image"
        ? { elementId: id, source }
        : { source };
  return ipc<T>(command, args);
}

/** Handlers for changes to the open campaign's files, wherever they live. */
const changeHandlers = new Set<(changes: DiskChanges) => void>();

/**
 * Called by the table store with what changed on the hosting machine, so a
 * GM's device reloads exactly what the host's own window would.
 */
export function notifyFilesChanged(changes: DiskChanges): void {
  for (const handler of changeHandlers) handler(changes);
}

export const storage = {
  createCampaign(path: string, name: string, system?: string) {
    return call<CampaignMeta>("create_campaign", {
      path,
      name,
      system: system ?? null,
    });
  },

  openCampaign(path: string) {
    return call<CampaignMeta>("open_campaign", { path });
  },

  /** For each path, whether a campaign folder still exists there. */
  probeCampaigns(paths: string[]) {
    return call<boolean[]>("probe_campaigns", { paths });
  },

  getCampaign() {
    return call<CampaignMeta | null>("get_campaign");
  },

  /** Change name, system and/or settings. `system: null` clears it. */
  updateCampaign(patch: {
    name?: string;
    system?: string | null;
    extra?: Record<string, unknown>;
  }) {
    return call<CampaignMeta>("update_campaign", {
      name: patch.name ?? null,
      system: patch.system ?? null,
      clearSystem: patch.system === null,
      extra: patch.extra ?? null,
    });
  },

  listElements() {
    return call<ElementSummary[]>("list_elements");
  },

  readElement(id: string) {
    return call<Element>("read_element", { id });
  },

  createElement(kind: string, name: string, extra?: Record<string, unknown>) {
    return call<Element>("create_element", {
      kind,
      name,
      extra: extra ?? null,
    });
  },

  saveElement(input: SaveElementInput) {
    return call<Element>("save_element", { input });
  },

  /** Calls `handler` whenever the open campaign's files change outside this
   *  window (sync client, another program, a player at the table), or, as a
   *  GM at someone's table, whenever the hosting machine's files change. */
  onFilesChanged(handler: (changes: DiskChanges) => void): Promise<UnlistenFn> {
    changeHandlers.add(handler);
    if (!inTauri) {
      return Promise.resolve(() => changeHandlers.delete(handler));
    }
    // The local watcher speaks for this machine's folder, which is not the
    // campaign on screen while this device works from a table.
    const local = listen<DiskChanges>("campaign-files-changed", (event) => {
      if (!remoteGm) handler(event.payload);
    });
    return local.then((stop) => () => {
      changeHandlers.delete(handler);
      stop();
    });
  },

  /** Rewrites an element's `type` and moves its file to that kind's folder. */
  changeElementKind(id: string, kind: string) {
    return call<Element>("change_element_kind", { id, kind });
  },

  deleteElement(id: string) {
    return call<void>("delete_element", { id });
  },

  /** Copies an image into the campaign's assets folder for a map element. */
  importMapImage(mapId: string, source: PickedFile) {
    return importFile<ImportedImage>("import_map_image", "map", mapId, source);
  },

  /** Copies a picture into assets/images/ for any element. */
  importElementImage(elementId: string, source: PickedFile) {
    return importFile<ImportedImage>(
      "import_element_image",
      "image",
      elementId,
      source,
    );
  },

  importElementImageBytes(elementId: string, dataBase64: string) {
    return call<ImportedImage>("import_element_image_bytes", {
      elementId,
      dataBase64,
    });
  },

  /** Copies a PDF into assets/docs/. */
  importDocument(source: PickedFile) {
    return importFile<ImportedDocument>(
      "import_document",
      "document",
      null,
      source,
    );
  },

  /** Text of a PDF or .txt/.md file anywhere on disk, by page (a text file
   *  is cut into pseudo-pages); nothing is copied. */
  extractDocumentText(source: string, from?: number, to?: number) {
    return call<PdfText>("extract_document_text", {
      source,
      from: from ?? null,
      to: to ?? null,
    });
  },

  /** Pages `from`..`to` of a PDF anywhere on disk as a PDF of their own,
   *  base64, for sending scanned pages to the model as pictures. */
  sliceDocumentPages(source: string, from: number, to: number) {
    return call<PdfSlice>("slice_document_pages", { source, from, to });
  },

  /** Text of a PDF under assets/docs/, by page. Pages without text fall
   *  back to what an import kept beside the file. */
  readDocumentText(path: string, from?: number, to?: number) {
    return call<PdfText>("read_document_text", {
      path,
      from: from ?? null,
      to: to ?? null,
    });
  },

  /** Keeps text read off a PDF's pages beside it (`<name>.txt`, one entry
   *  per page), merged into what earlier imports left. Returns its path. */
  saveDocumentText(
    path: string,
    firstPage: number,
    pages: string[],
    pageCount: number,
  ) {
    return call<string>("save_document_text", {
      path,
      firstPage,
      pages,
      pageCount,
    });
  },

  /** Imports image bytes (base64) for a map element. */
  importMapImageBytes(mapId: string, dataBase64: string) {
    return call<ImportedImage>("import_map_image_bytes", {
      mapId,
      dataBase64,
    });
  },

  /** Downloads an http(s) image and imports it for a map element. */
  importMapImageFromUrl(mapId: string, url: string) {
    return call<ImportedImage>("import_map_image_from_url", { mapId, url });
  },

  /** Case-insensitive text search over names, tags and bodies. */
  searchElements(query: string, limit = 20) {
    return call<SearchHit[]>("search_elements", { query, limit });
  },

  /** Raw bytes of an asset by campaign-relative path. */
  readAsset(path: string) {
    return remoteGm
      ? ipc<ArrayBuffer>("table_gm_asset", { path })
      : ipc<ArrayBuffer>("read_asset", { path });
  },

  /** Shared elements exactly as players receive them; `playerId` previews
   *  one paired player's view, otherwise anyone's. */
  listSharedElements(playerId?: string) {
    return call<ElementSummary[]>("list_shared_elements", {
      playerId: playerId ?? null,
    });
  },

  readSharedElement(id: string, playerId?: string) {
    return call<Element | null>("read_shared_element", {
      id,
      playerId: playerId ?? null,
    });
  },
};

/** This device's identity for tables (`src-tauri/src/identity.rs`). */
export function deviceIdentity() {
  return ipc<DeviceIdentity>("device_identity");
}

/**
 * Hosting a table and joining one (`src-tauri/src/table`). The hosting
 * controls that read or steer the table (status, spotlight, pairing) also
 * follow a GM to a second device; starting and stopping the table do not.
 */
export const table = {
  startHosting() {
    return ipc<HostStatus>("table_start_hosting");
  },
  stopHosting() {
    return ipc<void>("table_stop_hosting");
  },
  hostStatus() {
    return call<HostStatus | null>("table_host_status");
  },
  /** Starts browsing if needed and returns the tables seen so far. */
  discover() {
    return ipc<FoundTable[]>("table_discover");
  },
  discoverStop() {
    return ipc<void>("table_discover_stop");
  },
  /** Joins; the code is only needed the first time from a device. */
  join(address: string, name: string, code?: string) {
    return ipc<TableSession>("table_join", {
      address,
      name,
      code: code ?? null,
    });
  },
  /** GM: pair a connected device with an existing player (id) or a new one (name). */
  bindDevice(token: string, playerId: string | null, name: string | null) {
    return call<HostStatus>("table_bind_device", { token, playerId, name });
  },
  players() {
    return call<PlayerRecord[]>("table_players");
  },
  leave() {
    return ipc<void>("table_leave");
  },
  session() {
    return ipc<TableSession | null>("table_session");
  },
  fetchElement(id: string) {
    return ipc<Element | null>("table_fetch_element", { id });
  },
  fetchAsset(path: string) {
    return ipc<ArrayBuffer>("table_fetch_asset", { path });
  },
  /** Player: save the sheet of the character the GM assigned to you. */
  updateSheet(id: string, sheet: unknown, baseVersion: string) {
    return ipc<Element>("table_update_sheet", { id, sheet, baseVersion });
  },
  /** Player: write a note into the GM's campaign folder, as yours. */
  createNote(input: NoteInput) {
    return ipc<Element>("table_create_note", { input });
  },
  /** Player: change or share a note you wrote. */
  updateNote(id: string, input: NoteInput) {
    return ipc<Element>("table_update_note", { id, input });
  },
  /** Player: delete a note you wrote. */
  deleteNote(id: string) {
    return ipc<void>("table_delete_note", { id });
  },
  /** Read the next WebSocket event. A fresh subscription starts with a snapshot. */
  nextEvent(subscribe: boolean) {
    return ipc<TableChange>("table_next_event", { subscribe });
  },
  /** Show an element on every player's screen; null clears it. */
  spotlight(id: string | null) {
    return call<HostStatus>("table_spotlight", { id });
  },
};

/** Saved assistant conversations in the open campaign's `conversations/`. */
export const conversations = {
  /** Most recently updated first. */
  list() {
    return call<ConversationSummary[]>("list_conversations");
  },
  read(id: string) {
    return call<StoredConversation>("read_conversation", { id });
  },
  /** Stamps `updatedAt` (and `createdAt` on first save) and returns the summary. */
  save(conversation: StoredConversation) {
    return call<ConversationSummary>("save_conversation", { conversation });
  },
  delete(id: string) {
    return call<void>("delete_conversation", { id });
  },
};

/** Rust commands reject with a plain string; normalise anything else too. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The user's Anthropic API key: in the OS credential store from the app,
 * in the browser's own storage from the `/gm` page.
 */
export const secrets = {
  getApiKey() {
    return ipc<string | null>("get_api_key");
  },
  setApiKey(key: string) {
    return ipc<void>("set_api_key", { key });
  },
  clearApiKey() {
    return ipc<void>("clear_api_key");
  },
};
