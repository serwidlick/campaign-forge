import type { ElementSummary, RosterEntry, TableChange } from "./types";

export const LIVE_PROTOCOL: "table.ws.v1";

export function tableSocket(
  ticket: string,
  player?: boolean,
): {
  next(): Promise<TableChange>;
  close(): void;
};
export function applyDelta(
  elements: ElementSummary[],
  delta: NonNullable<TableChange["delta"]>,
): ElementSummary[];

/** Background colours for roster icons; each meets 4.5:1 with white text. */
export const ROSTER_PALETTE: readonly string[];
/** Up to two letters (whole graphemes) from the first and last words. */
export function rosterInitials(name: string): string;
/** The same colour for the same roster key on every client. */
export function rosterColour(key: RosterEntry["key"]): string;
