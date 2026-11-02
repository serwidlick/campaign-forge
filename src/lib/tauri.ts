/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`.
 * This is the only module in the frontend that calls `invoke`.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  CampaignMeta,
  Element,
  ElementSummary,
  ImportedImage,
  SaveElementInput,
  SearchHit,
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
