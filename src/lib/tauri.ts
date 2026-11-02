/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands.rs`.
 * This is the only module in the frontend that calls `invoke`.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  CampaignMeta,
  Element,
  ElementSummary,
  SaveElementInput,
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

  createElement(kind: string, name: string) {
    return invoke<Element>("create_element", { kind, name });
  },

  saveElement(input: SaveElementInput) {
    return invoke<Element>("save_element", { input });
  },

  deleteElement(id: string) {
    return invoke<void>("delete_element", { id });
  },
};

/** Rust commands reject with a plain string; normalise anything else too. */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
