import { useEffect, useState } from "react";

import type { AssetLoader } from "@/features/images/portrait-model";
import { cachedAssetUrl } from "@/lib/asset-cache";

/**
 * Shows a PDF from the campaign's assets (or a GM's table) using the
 * webview's own viewer, so paging, zoom and search come for free.
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

  const current = state?.key === key ? state : null;

  return (
    <div
      className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900"
      style={{ height }}
    >
      {current?.url ? (
        <iframe
          src={current.url}
          title={title}
          className="h-full w-full border-0 bg-ink-900"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-ink-500">
          {current?.error
            ? `Could not open the file: ${current.error}`
            : "Opening…"}
        </div>
      )}
    </div>
  );
}
