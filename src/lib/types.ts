/**
 * Shared types mirroring the Rust storage models in
 * `src-tauri/src/storage/model.rs`. Keep the two in sync.
 */

export interface CampaignMeta {
  id: string;
  name: string;
  system?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Absolute path of the campaign folder. */
  path: string;
  /** Campaign-level settings, flattened by the Rust side (`calendar`, ...). */
  [key: string]: unknown;
}

/** Keys owned by the campaign record itself; never part of its settings. */
export const RESERVED_CAMPAIGN_KEYS = new Set([
  "id",
  "name",
  "system",
  "createdAt",
  "updatedAt",
  "path",
]);

/** The settings of a campaign, minus nulls and undefineds. */
export function campaignSettingsOf(
  c: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (!RESERVED_CAMPAIGN_KEYS.has(k) && v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

export interface ElementMeta {
  id: string;
  /** Element kind; also the folder under `elements/`. */
  type: string;
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Path relative to the campaign root, forward slashes. */
  path: string;
  /**
   * Kind-specific frontmatter fields, flattened onto the object by the Rust
   * side (a session's `beats`, `arc`, `number`...). Read them through the
   * feature's own parser, never directly.
   */
  [key: string]: unknown;
}

/** What the element list carries: metadata plus the ids this element links to. */
export interface ElementSummary extends ElementMeta {
  /** Ids of elements this one links to (`cf://element/<id>` in the body). */
  links: string[];
}

export interface Element extends ElementSummary {
  /** Markdown body (everything after the frontmatter). */
  body: string;
}

/** The URL scheme used for links between elements. */
export const ELEMENT_LINK_PREFIX = "cf://element/";

export function elementHref(id: string): string {
  return `${ELEMENT_LINK_PREFIX}${id}`;
}

/** Returns the element id if `href` is an element link, else null. */
export function elementIdFromHref(
  href: string | null | undefined,
): string | null {
  if (!href?.startsWith(ELEMENT_LINK_PREFIX)) return null;
  const id = href.slice(ELEMENT_LINK_PREFIX.length);
  return id.length === 36 ? id : null;
}

export interface SaveElementInput {
  id: string;
  name: string;
  tags: string[];
  body: string;
  /** Replaces the kind-specific fields wholesale when present. */
  extra?: Record<string, unknown>;
}

export interface ImportedImage {
  /** Path relative to the campaign root. */
  path: string;
  width: number;
  height: number;
}

export interface SearchHit {
  id: string;
  type: string;
  name: string;
  snippet: string;
  matchedIn: "name" | "tag" | "body";
}

/** Keys owned by the element record itself; never part of `extra`. */
export const RESERVED_ELEMENT_KEYS = new Set([
  "id",
  "type",
  "name",
  "tags",
  "createdAt",
  "updatedAt",
  "path",
  "links",
  "body",
]);

/** The kind-specific fields of an element, minus nulls and undefineds. */
export function extraOf(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (!RESERVED_ELEMENT_KEYS.has(k) && v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The built-in element kinds, grouped into families the way a GM thinks about
 * them. The `id` is what goes on disk, so changing one is a migration.
 */
export interface ElementKind {
  id: string;
  label: string;
  plural: string;
  family: ElementFamily;
}

export type ElementFamily = "play" | "people" | "places" | "things" | "story";

export const ELEMENT_FAMILIES: { id: ElementFamily; label: string }[] = [
  { id: "play", label: "Play" },
  { id: "people", label: "People" },
  { id: "places", label: "Places" },
  { id: "things", label: "Things" },
  { id: "story", label: "Story" },
];

export const ELEMENT_KINDS: ElementKind[] = [
  { id: "arc", label: "Arc", plural: "Arcs", family: "play" },
  { id: "session", label: "Session", plural: "Sessions", family: "play" },
  { id: "journal", label: "Journal entry", plural: "Journal", family: "play" },
  {
    id: "character",
    label: "Character",
    plural: "Characters",
    family: "people",
  },
  { id: "faction", label: "Faction", plural: "Factions", family: "people" },
  { id: "creature", label: "Creature", plural: "Creatures", family: "people" },
  { id: "location", label: "Location", plural: "Locations", family: "places" },
  { id: "map", label: "Map", plural: "Maps", family: "places" },
  { id: "item", label: "Item", plural: "Items", family: "things" },
  { id: "quest", label: "Quest", plural: "Quests", family: "story" },
  { id: "event", label: "Event", plural: "Events", family: "story" },
  { id: "lore", label: "Lore", plural: "Lore", family: "story" },
];

export function kindById(id: string): ElementKind {
  return (
    ELEMENT_KINDS.find((k) => k.id === id) ?? {
      id,
      label: id,
      plural: id,
      family: "story",
    }
  );
}

// ---- Playing at a table over the local network -----------------------------

export interface TablePlayer {
  name: string;
  joinedAt: string;
  lastSeen: string;
}

export interface HostStatus {
  port: number;
  code: string;
  /** `ip:port` pairs players can type if discovery fails. */
  addresses: string[];
  players: TablePlayer[];
  announceError: string | null;
}

export interface FoundTable {
  id: string;
  name: string;
  system: string | null;
  addresses: string[];
}

export interface TableInfo {
  name: string;
  system: string | null;
  calendar: unknown;
  version: number;
}

export interface TableSession {
  address: string;
  playerName: string;
  info: TableInfo;
}
