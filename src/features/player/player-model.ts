/**
 * What players are allowed to see.
 *
 * Every element has an optional `shared: true` in its frontmatter. Map pins,
 * routes and territories carry their own `shared` flag so a map can be shown
 * without giving away everything on it. Nothing else is ever sent to or shown
 * in a player view, and links to unshared elements are turned back into plain
 * text so their names do not leak either.
 *
 * `PlayerSource` is the seam between the player screen and wherever the data
 * comes from: today the GM's own files (preview), later a GM's machine over
 * the network.
 */
import { readMap } from "@/features/map/map-model";
import { storage } from "@/lib/tauri";
import {
  ELEMENT_LINK_PREFIX,
  type Element,
  type ElementSummary,
} from "@/lib/types";

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

export function sharedIdsOf(elements: ElementSummary[]): Set<string> {
  return new Set(elements.filter(isShared).map((e) => e.id));
}

const LINK = new RegExp(
  `\\[([^\\]]*)\\]\\(${ELEMENT_LINK_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([0-9a-fA-F-]{36})\\)`,
  "g",
);

/** Links to elements players cannot see become their visible text. */
export function stripPrivateLinks(
  markdown: string,
  sharedIds: Set<string>,
): string {
  return markdown.replace(LINK, (whole, text: string, id: string) =>
    sharedIds.has(id) ? whole : text,
  );
}

/** The parts of a map a player may see. */
function mapForPlayers(
  e: Record<string, unknown>,
  sharedIds: Set<string>,
): Record<string, unknown> {
  const m = readMap(e);
  const visibleLink = (id: string | null) =>
    id && sharedIds.has(id) ? id : null;
  return {
    pins: m.pins
      .filter((p) => p.shared)
      .map((p) => ({ ...p, element: visibleLink(p.element) })),
    routes: m.routes.filter((r) => r.shared),
    territories: m.territories
      .filter((t) => t.shared)
      .map((t) => ({ ...t, element: visibleLink(t.element) })),
  };
}

/** A summary with everything a player must not see removed. */
export function summaryForPlayers(
  e: ElementSummary,
  sharedIds: Set<string>,
): ElementSummary {
  const out: ElementSummary = {
    ...e,
    links: e.links.filter((id) => sharedIds.has(id)),
  };
  if (e.type === "map") Object.assign(out, mapForPlayers(e, sharedIds));
  if (e.type === "session") {
    // Prep notes stay with the GM; players get number, date and status.
    delete out.beats;
    if (typeof out.arc === "string" && !sharedIds.has(out.arc)) {
      delete out.arc;
    }
  }
  if (e.type === "journal") {
    const scope = out.scope as { type?: string; id?: string } | undefined;
    if (scope?.id && !sharedIds.has(scope.id)) out.scope = { type: "campaign" };
  }
  return out;
}

export function elementForPlayers(e: Element, sharedIds: Set<string>): Element {
  return {
    ...summaryForPlayers(e, sharedIds),
    body: stripPrivateLinks(e.body, sharedIds),
  } as Element;
}

/** The GM's own campaign, seen as a player would see it. */
export function localPreviewSource(elements: ElementSummary[]): PlayerSource {
  const sharedIds = sharedIdsOf(elements);
  return {
    elements: elements
      .filter(isShared)
      .map((e) => summaryForPlayers(e, sharedIds)),
    async readElement(id) {
      if (!sharedIds.has(id)) return null;
      const full = await storage.readElement(id);
      return elementForPlayers(full, sharedIds);
    },
    readAsset: (path) => storage.readAsset(path),
  };
}
