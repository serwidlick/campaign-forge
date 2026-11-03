/**
 * A Document element keeps a PDF under `assets/docs/`:
 *
 *   file:      assets/docs/players-handbook.pdf
 *   fileName:  Players Handbook          (display, from the source file)
 *   fileBytes: 12345678
 */

/** The PDF behind a Document element, if one has been attached. */
export function documentFileOf(e: Record<string, unknown>): string | null {
  return typeof e.file === "string" && e.file ? e.file : null;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
