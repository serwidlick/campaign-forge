/**
 * What players are allowed to see.
 *
 * The rules live in Rust (`src-tauri/src/table/share.rs`) and are applied
 * there both for the GM's "preview as player" and for the table server, so
 * the two can never disagree. In short: an element is visible when its
 * frontmatter has `shared: true`; map pins, routes and territories carry
 * their own `shared` flag; links to private elements become plain text.
 *
 * `PlayerSource` is the seam between the player screen and wherever the data
 * comes from: the GM's own files (preview) or a GM's machine over the network.
 */
import { storage, table } from "@/lib/tauri";
import type { Element, ElementSummary } from "@/lib/types";

export interface PlayerSource {
  /** Shared elements only, already sanitised. */
  elements: ElementSummary[];
  /** A shared element with its body, or null when it is not shared. */
  readElement(id: string): Promise<Element | null>;
  /** Raw bytes of a shared map image. */
  readAsset(path: string): Promise<ArrayBuffer>;
}

export function isShared(e: Record<string, unknown>): boolean {
  return e.shared === true;
}

/** The GM's own campaign, seen as a player would see it. */
export function localPreviewSource(
  sharedElements: ElementSummary[],
): PlayerSource {
  return {
    elements: sharedElements,
    readElement: (id) => storage.readSharedElement(id),
    readAsset: (path) => storage.readAsset(path),
  };
}

/** A GM's table joined over the network. */
export function remoteSource(elements: ElementSummary[]): PlayerSource {
  return {
    elements,
    readElement: (id) => table.fetchElement(id),
    readAsset: (path) => table.fetchAsset(path),
  };
}
