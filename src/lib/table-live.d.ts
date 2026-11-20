import type { ElementSummary, TableChange } from "./types";

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
