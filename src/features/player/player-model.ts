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
import type {
  Element,
  ElementSummary,
  NoteInput,
  PlayerName,
} from "@/lib/types";

export interface PlayerSource {
  /** Shared elements only, already sanitised. */
  elements: ElementSummary[];
  /** A shared element with its body, or null when it is not shared. */
  readElement(id: string): Promise<Element | null>;
  /** Raw bytes of a shared map image. */
  readAsset(path: string): Promise<ArrayBuffer>;
  /** The player's table name, when sitting at a table. */
  playerName?: string;
  /** The player's id once the GM has paired them; sheet owners point at it. */
  playerId?: string | null;
  /** The campaign's paired players, for naming a sheet's owner. */
  players?: PlayerName[];
  /** Saves the sheet of a character this player owns. */
  updateSheet?(
    id: string,
    sheet: unknown,
    baseVersion: string,
  ): Promise<Element>;
  /** Writes a new note, as this player, into the GM's campaign folder. */
  createNote?(input: NoteInput): Promise<Element>;
  /** Changes or shares a note this player wrote. */
  updateNote?(id: string, input: NoteInput): Promise<Element>;
  /** Deletes a note this player wrote. */
  deleteNote?(id: string): Promise<void>;
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
  as?: PlayerName,
  players: PlayerName[] = [],
): PlayerSource {
  return {
    elements: sharedElements,
    readElement: (id) => storage.readSharedElement(id, as?.id),
    readAsset: (path) => storage.readAsset(path),
    playerName: as?.name,
    playerId: as?.id,
    players,
  };
}

/** A GM's table joined over the network. */
export function remoteSource(
  elements: ElementSummary[],
  playerName: string,
  playerId: string | null = null,
  players: PlayerName[] = [],
): PlayerSource {
  return {
    elements,
    readElement: (id) => table.fetchElement(id),
    readAsset: (path) => table.fetchAsset(path),
    playerName,
    playerId,
    players,
    updateSheet: (id, sheet, baseVersion) =>
      table.updateSheet(id, sheet, baseVersion),
    createNote: (input) => table.createNote(input),
    updateNote: (id, input) => table.updateNote(id, input),
    deleteNote: (id) => table.deleteNote(id),
  };
}

/**
 * Whether this player wrote a note: its `author` is their player id, or
 * the table name they joined with before pairing, matched
 * case-insensitively as the Rust rule in `share.rs` does.
 */
export function ownsNote(
  element: Record<string, unknown>,
  playerName: string | undefined,
  playerId?: string | null,
): boolean {
  if (element.type !== "note") return false;
  const author =
    typeof element.author === "string" ? element.author.trim() : "";
  if (author === "") return false;
  if (playerId && author === playerId) return true;
  return (
    !!playerName && author.toLowerCase() === playerName.trim().toLowerCase()
  );
}

/** Who wrote a note, as a name: the name stored with it, else its author. */
export function noteAuthorLabel(
  element: Record<string, unknown>,
  players: PlayerName[],
): string | null {
  const author =
    typeof element.author === "string" ? element.author.trim() : "";
  if (author === "") return null;
  const named = players.find((p) => p.id === author);
  if (named) return named.name;
  const stored =
    typeof element.authorName === "string" ? element.authorName.trim() : "";
  return stored || ownerLabel(author, players);
}

/**
 * How a sheet's owner reads to a player: the paired player's name, the
 * stored text for files that still hold a name, or a neutral phrase when
 * the id is of a player this table has not named.
 */
export function ownerLabel(owner: string, players: PlayerName[]): string {
  const named = players.find((p) => p.id === owner);
  if (named) return named.name;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(owner) ? "another player" : owner;
}

/**
 * Whether this player may edit a character: the GM named them as owner.
 * Owners are player ids since pairing; files from before hold a table
 * name, matched case-insensitively, as the Rust rule in `share.rs` does.
 */
export function ownsCharacter(
  element: Record<string, unknown>,
  playerName: string | undefined,
  playerId?: string | null,
): boolean {
  if (element.type !== "character") return false;
  const sheet = element.sheet as { owner?: unknown } | undefined;
  const owner = typeof sheet?.owner === "string" ? sheet.owner.trim() : "";
  if (owner === "") return false;
  if (playerId && owner === playerId) return true;
  return (
    !!playerName && owner.toLowerCase() === playerName.trim().toLowerCase()
  );
}
