import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { AssetLoader } from "@/features/images/portrait-model";
import { cachedAssetUrl } from "@/lib/asset-cache";

/**
 * Shows a PDF from the campaign's assets (or a GM's table) using the
 * webview's own viewer, so paging, zoom and search come for free.
 *
 * A toggle takes the viewer over the whole window. The same iframe stays
 * mounted either way, so switching never reloads the file or loses the page.
 */
export function PdfViewer({
  path,
  scope,
  load,
  title,
  height = "70vh",
}: {
  path: string;
  scope: string;
  load: AssetLoader;
  title: string;
  height?: string | number;
}) {
  const key = `${scope}:${path}`;
  const [state, setState] = useState<{
    key: string;
    url: string | null;
    error: string | null;
  } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    cachedAssetUrl(key, () => load(path), "application/pdf")
      .then((url) => {
        if (!cancelled) setState({ key, url, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            key,
            url: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, path, load]);

  // Escape leaves full screen. Keys pressed while the PDF itself has focus
  // stay inside the viewer's frame, so the exit button is always shown too.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const current = state?.key === key ? state : null;

  return (
    // The outer box keeps its place in the layout while the viewer is away.
    <div style={{ height }}>
      <div
        className={
          fullscreen
            ? "fixed inset-0 z-50 flex flex-col bg-ink-950"
            : "relative flex h-full flex-col overflow-hidden rounded-lg border border-ink-800 bg-ink-900"
        }
      >
        {fullscreen && (
          <div className="flex items-center gap-3 border-b border-ink-800 px-3 py-1.5 text-sm">
            <span className="truncate text-ink-200">{title}</span>
            <span className="flex-1" />
            <span className="text-xs text-ink-500">Esc</span>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-200 transition-colors hover:bg-ink-800"
              title="Leave full screen"
            >
              <Minimize2 size={14} /> Exit full screen
            </button>
          </div>
        )}
        {current?.url ? (
          <iframe
            src={current.url}
            title={title}
            className="min-h-0 w-full flex-1 border-0 bg-ink-900"
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
            {current?.error
              ? `Could not open the file: ${current.error}`
              : "Opening…"}
          </div>
        )}
        {!fullscreen && current?.url && (
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900/90 px-2 py-1 text-xs text-ink-200 shadow transition-colors hover:bg-ink-800"
            title="Show the PDF over the whole window"
          >
            <Maximize2 size={14} /> Full screen
          </button>
        )}
      </div>
    </div>
  );
}
