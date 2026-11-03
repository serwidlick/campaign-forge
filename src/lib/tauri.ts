/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`.
 * This is the only module in the frontend that calls `invoke`.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  CampaignMeta,
  Element,
  ElementSummary,
  FoundTable,
  HostStatus,
  ImportedImage,
  SaveElementInput,
  SearchHit,
  TableChange,
  TableSession,
} from "./types";

export const storage = {
  createCampaign(path: string, name: string, system?: string) {
    return invoke<CampaignMeta>("create_campaign", {
      path,
      name,
      system: system ?? null,
    });
  },

  openCampaign(path: string) {
    return invoke<CampaignMeta>("open_campaign", { path });
  },

  getCampaign() {
    return invoke<CampaignMeta | null>("get_campaign");
  },

  /** Change name, system and/or settings. `system: null` clears it. */
  updateCampaign(patch: {
    name?: string;
    system?: string | null;
    extra?: Record<string, unknown>;
  }) {
    return invoke<CampaignMeta>("update_campaign", {
      name: patch.name ?? null,
      system: patch.system ?? null,
      clearSystem: patch.system === null,
      extra: patch.extra ?? null,
    });
  },

  listElements() {
    return invoke<ElementSummary[]>("list_elements");
  },

  readElement(id: string) {
    return invoke<Element>("read_element", { id });
  },

  createElement(kind: string, name: string, extra?: Record<string, unknown>) {
    return invoke<Element>("create_element", {
      kind,
      name,
      extra: extra ?? null,
    });
  },

  saveElement(input: SaveElementInput) {
    return invoke<Element>("save_element", { input });
  },

  deleteElement(id: string) {
    return invoke<void>("delete_element", { id });
  },

  /** Copies an image into the campaign's assets folder for a map element. */
  importMapImage(mapId: string, source: string) {
    return invoke<ImportedImage>("import_map_image", { mapId, source });
  },

  /** Imports image bytes (base64) for a map element. */
  importMapImageBytes(mapId: string, dataBase64: string) {
    return invoke<ImportedImage>("import_map_image_bytes", {
      mapId,
      dataBase64,
    });
  },

  /** Downloads an http(s) image and imports it for a map element. */
  importMapImageFromUrl(mapId: string, url: string) {
    return invoke<ImportedImage>("import_map_image_from_url", { mapId, url });
  },

  /** Case-insensitive text search over names, tags and bodies. */
  searchElements(query: string, limit = 20) {
    return invoke<SearchHit[]>("search_elements", { query, limit });
  },

  /** Raw bytes of an asset by campaign-relative path. */
  readAsset(path: string) {
    return invoke<ArrayBuffer>("read_asset", { path });
  },

  /** Shared elements exactly as players receive them. */
  listSharedElements() {
    return invoke<ElementSummary[]>("list_shared_elements");
  },

  readSharedElement(id: string) {
    return invoke<Element | null>("read_shared_element", { id });
  },
};

/** Hosting a table and joining one (`src-tauri/src/table`). */
export const table = {
  startHosting() {
    return invoke<HostStatus>("table_start_hosting");
  },
  stopHosting() {
    return invoke<void>("table_stop_hosting");
  },
  hostStatus() {
    return invoke<HostStatus | null>("table_host_status");
  },
  /** Starts browsing if needed and returns the tables seen so far. */
  discover() {
    return invoke<FoundTable[]>("table_discover");
  },
  discoverStop() {
    return invoke<void>("table_discover_stop");
  },
  join(address: string, name: string, code: string) {
    return invoke<TableSession>("table_join", { address, name, code });
  },
  leave() {
    return invoke<void>("table_leave");
  },
  session() {
    return invoke<TableSession | null>("table_session");
  },
  fetchElements() {
    return invoke<ElementSummary[]>("table_fetch_elements");
  },
  fetchElement(id: string) {
    return invoke<Element | null>("table_fetch_element", { id });
  },
  fetchAsset(path: string) {
    return invoke<ArrayBuffer>("table_fetch_asset", { path });
  },
  /** Resolves when the GM's version passes `after`, after ~25 s, or when
   *  the GM stops hosting (`closed`). */
  waitForChange(after: number) {
    return invoke<TableChange>("table_wait_for_change", { after });
  },
};

/** Rust commands reject with a plain string; normalise anything else too. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The user's Anthropic API key, held in the OS credential store. */
export const secrets = {
  getApiKey() {
    return invoke<string | null>("get_api_key");
  },
  setApiKey(key: string) {
    return invoke<void>("set_api_key", { key });
  },
  clearApiKey() {
    return invoke<void>("clear_api_key");
  },
};
