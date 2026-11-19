import type { ElementSummary, TableChange } from "./types";

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
