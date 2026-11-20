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
  /** Fingerprint of the file as last read or written. Pass it back as a
   *  save's `baseVersion` so an edit made elsewhere is never overwritten. */
  version?: string;
}

/** A saved assistant conversation, as listed: `conversations/<id>.json`. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A saved conversation file. Rust owns only the envelope; everything else is
 * stored and returned untouched (see `features/agent/conversation-file.ts`).
 */
export interface StoredConversation extends ConversationSummary {
  [key: string]: unknown;
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
  /** The element's `version` when the edit began. If the file has changed
   *  since, the save fails with a `conflict:` error. Omit to overwrite. */
  baseVersion?: string;
}

/** Payload of the `campaign-files-changed` event: edits made outside this
 *  window (a sync client, another program, a player at the table). */
export interface DiskChanges {
  elementIds: string[];
  listChanged: boolean;
  campaignChanged: boolean;
  /** The file version each changed element now has. A window already
   *  showing that version made the change itself and need not reload. */
  versions?: Record<string, string>;
}

/** Whether an error from a save is a version conflict. */
export function isConflictError(message: string): boolean {
  return message.startsWith("conflict:");
}

export interface ImportedDocument {
  /** Campaign-relative path under assets/docs. */
  path: string;
  bytes: number;
  /** Source file name without extension. */
  name: string;
}

/** Text extracted from a PDF, page by page (`src-tauri/src/pdf.rs`). */
export interface PdfText {
  /** Pages in the whole document. */
  pageCount: number;
  /** 1-based number of the first entry in `pages`. */
  firstPage: number;
  /** One string per page in the requested range; unreadable pages are "". */
  pages: string[];
  /** Pages in the range with no text at all (scans, art). */
  emptyPages: number;
  chars: number;
  /** The text was cut at the extraction ceiling. */
  truncated: boolean;
}

/** A page range of a PDF as a smaller PDF (`slice_document_pages`). */
export interface PdfSlice {
  /** Base64 of the PDF, or null when the range is too large to send. */
  data: string | null;
  bytes: number;
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
  "version",
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
    id: "encounter",
    label: "Encounter",
    plural: "Encounters",
    family: "play",
  },
  { id: "note", label: "Note", plural: "Notes", family: "play" },
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
  { id: "document", label: "Document", plural: "Documents", family: "things" },
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

// ---- Characters: player characters and NPCs ---------------------------------

/**
 * Whether a character belongs to a player or to the GM. Stored as `role` in
 * the character's frontmatter; the kind stays `character`, so ids, links and
 * files are untouched by the split.
 */
export type CharacterRole = "pc" | "npc";

export interface CharacterRoleInfo {
  id: CharacterRole;
  label: string;
  plural: string;
}

export const CHARACTER_ROLES: CharacterRoleInfo[] = [
  { id: "pc", label: "Player character", plural: "Player characters" },
  { id: "npc", label: "NPC", plural: "NPCs" },
];

export const DEFAULT_CHARACTER_ROLE: CharacterRole = "npc";

export function isCharacterRole(v: unknown): v is CharacterRole {
  return v === "pc" || v === "npc";
}

export function roleById(id: CharacterRole): CharacterRoleInfo {
  return CHARACTER_ROLES.find((r) => r.id === id) ?? CHARACTER_ROLES[1]!;
}

/**
 * A character's role. Files written before the field existed may carry it
 * inside the 5e sheet (`sheet.role`); anything else is an NPC, so a GM's
 * existing cast lands where they expect it.
 */
export function characterRoleOf(e: Record<string, unknown>): CharacterRole {
  if (isCharacterRole(e.role)) return e.role;
  const sheet = e.sheet;
  if (sheet && typeof sheet === "object") {
    const legacy = (sheet as Record<string, unknown>).role;
    if (isCharacterRole(legacy)) return legacy;
  }
  return DEFAULT_CHARACTER_ROLE;
}

/**
 * What the element list is narrowed to: one kind, and for characters one
 * role. `null` is everything.
 */
export interface ListFilter {
  kind: string;
  role?: CharacterRole;
}

export function matchesFilter(
  e: Record<string, unknown> & { type: string },
  filter: ListFilter | null,
): boolean {
  if (!filter) return true;
  if (e.type !== filter.kind) return false;
  return filter.role === undefined || characterRoleOf(e) === filter.role;
}

/** Singular and plural names for what a filter shows. */
export function filterNames(filter: ListFilter): {
  label: string;
  plural: string;
} {
  if (filter.role !== undefined) return roleById(filter.role);
  const kind = kindById(filter.kind);
  return { label: kind.label, plural: kind.plural };
}

/** The sidebar rows for a kind: characters are split by role. */
export function filtersForKind(kind: string): ListFilter[] {
  if (kind === "character") {
    return CHARACTER_ROLES.map((r) => ({ kind, role: r.id }));
  }
  return [{ kind }];
}

/** The label shown under an element's name in lists. */
export function elementLabel(
  e: Record<string, unknown> & { type: string },
): string {
  if (e.type === "character") return roleById(characterRoleOf(e)).label;
  return kindById(e.type).label;
}

// ---- Playing at a table over the local network -----------------------------

export interface TablePlayer {
  name: string;
  joinedAt: string;
  lastSeen: string;
  /** Opaque connection ID used by the GM for pairing. */
  token: string;
  /** Present when the app joined; a browser has no device key. */
  device: { fingerprint: string; publicKey: string; label: string } | null;
  /** Set once the device is paired with a player. */
  playerId: string | null;
  /** The paired player is a GM: this connection runs the GM view. */
  gm: boolean;
  /** At least one live socket is open for this seat right now. */
  online: boolean;
}

/** Someone at the table, as everyone there sees them. Mirrors `RosterEntry`
 *  in `src-tauri/src/table/share/roster.rs`. */
export interface RosterEntry {
  /** Stable while they are at the table: `host`, `player:<id>` or `guest:<opaque>`. */
  key: string;
  name: string;
  role: "host" | "gm" | "player" | "guest";
  /** `active`: here and using their device. `away`: idle for five minutes.
   *  `disconnected`: their connection dropped moments ago. A newer host may
   *  send others; the bubbles show those as plain words. */
  state: "active" | "away" | "disconnected" | (string & {});
  /** While away: when they went idle (Unix ms, host clock). */
  awaySince?: number;
  /** Something they are doing, from the activity registry. */
  activity?: string;
}

export interface PlayerDevice {
  fingerprint: string;
  publicKey: string;
  label: string;
  addedAt: string;
}

/** A player of the campaign, stored in campaign.json under `players`. */
export interface PlayerRecord {
  id: string;
  name: string;
  devices: PlayerDevice[];
  lastSeen: string | null;
  /** A second GM: their devices get the whole campaign, editable, at the
   *  table (the GM's own laptop while the desktop holds the files). */
  gm: boolean;
}

export interface DeviceIdentity {
  fingerprint: string;
  label: string;
}

export interface HostStatus {
  port: number;
  code: string;
  /** `ip:port` pairs players can type if discovery fails. */
  addresses: string[];
  /** mDNS name browsers can open instead of an IP, when announced. */
  hostName: string | null;
  players: TablePlayer[];
  announceError: string | null;
  /** Element currently shown to everyone, if any. */
  spotlight: string | null;
  /** Who is at the table, as everyone there sees it. */
  roster: RosterEntry[];
}

export interface FoundTable {
  endpoints: string[];
  id: string;
  name: string;
  system: string | null;
  addresses: string[];
}

export interface TableInfo {
  liveProtocol?: string | null;
  name: string;
  system: string | null;
  calendar: unknown;
  version: number;
  /** The campaign's paired players by id, for naming a sheet's owner. */
  players: PlayerName[];
}

export interface PlayerName {
  id: string;
  name: string;
}

/** An authorized update from the table WebSocket. */
export interface TableChange {
  playerId?: string | null;
  delta?: { reset: boolean; upserts: ElementSummary[]; removed: string[] };

  version: number;
  /** The GM stopped hosting; leave the table. */
  closed: boolean;
  /** Element the GM is showing everyone, if any. */
  spotlight: string | null;
  /** Grows on every spotlight change. */
  spotlightSeq: number;
  /** Whether this device counts as a GM right now; the host can grant or
   *  revoke that while we are connected. */
  gm: boolean;
  /** For a GM's device: what changed on the host since our version. */
  changes: DiskChanges | null;
  /** Who is at the table; absent when it has not changed. */
  roster?: RosterEntry[];
  /** The host's clock (Unix ms) when a frame with the roster was sent. */
  serverTime?: number;
  /** Sent with the roster: which entry is the device receiving the frame. */
  you?: string;
  /** Sent with `you`: the seat's identity epoch, for message commands. */
  epoch?: number;
  /** This person's conversations: the whole set, or what changed. */
  chats?: Chats;
  /** Answers to this socket's sends. */
  acks?: ChatAck[];
  /** Who is typing to this person now. */
  typing?: string[];
  /** Whether players may message each other. */
  messageRules?: MessageRules;
}

/** One message. Mirrors `ChatMessage` in src-tauri/src/table/server/messages.rs. */
export interface ChatMessage {
  id: string;
  /** Counts within the conversation only. */
  seq: number;
  from: string;
  text: string;
  /** Unix ms, host clock. */
  at: number;
  /** Only on the sender's own copies. */
  clientId?: string;
}

export interface ChatConversation {
  cid: string;
  with: string;
  messages: ChatMessage[];
  seenByMe: number;
  seenByThem: number;
  /** Messages from them not yet seen, counted by the host. */
  unread: number;
  ended?: boolean;
  trimmed?: boolean;
}

export interface Chats {
  snapshot?: boolean;
  conversations: ChatConversation[];
}

export interface ChatAck {
  clientId: string;
  id?: string;
  cid?: string;
  seq?: number;
  error?: string;
  retryAfter?: number;
}

export interface MessageRules {
  playersMayMessage: boolean;
}

/** A message command a device sends on its live socket. */
export type TableCommand =
  | {
      t: "send";
      epoch: number;
      to: string;
      cid?: string;
      clientId: string;
      text: string;
    }
  | { t: "typing"; epoch: number; to: string; on: boolean }
  | { t: "seen"; epoch: number; cid: string; seq: number };

/**
 * What a player sends to write or change a note of their own at the table.
 * Mirrors `NoteInput` in `src-tauri/src/table/share.rs`.
 */
export interface NoteInput {
  name: string;
  body: string;
  /** Share with everyone at the table, or take it back; absent keeps it. */
  shared?: boolean;
  /** The `version` the edit started from; absent overwrites. */
  baseVersion?: string;
}

export interface TableSession {
  address: string;
  playerName: string;
  /** Set when the GM has paired this device with a player. */
  playerId: string | null;
  /** True when no code was needed because the device was known. */
  recognized: boolean;
  /** This device belongs to a GM: the GM screen, fed from the table. */
  gm: boolean;
  info: TableInfo;
}
