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

/** The heading that marks the player-facing part of a body. */
export const PLAYERS_HEADING = "Players know";

const PLAYERS_HEADING_LINE =
  /^#{1,6}[ \t]+(players know|what players know|what the players know|player-facing|player facing)[ \t]*#*[ \t]*[:.]?[ \t]*$/im;

/**
 * Mirrors the Rust rule in `table/share.rs`: when a body has a "Players
 * know" heading, players receive only that section.
 */
export function hasPlayersSection(body: string): boolean {
  return PLAYERS_HEADING_LINE.test(body);
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
