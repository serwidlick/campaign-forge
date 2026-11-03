import { useEffect, useState } from "react";

import { cachedAssetUrl } from "@/lib/asset-cache";

/** Reads an asset's bytes: the campaign folder, or a GM's table. */
export type AssetLoader = (path: string) => Promise<ArrayBuffer>;

/** The portrait path stored on an element, if any. */
export function portraitOf(e: Record<string, unknown>): string | null {
  return typeof e.portrait === "string" && e.portrait ? e.portrait : null;
}

/** Blob URL for one portrait, or null until it has loaded. */
export function usePortraitUrl(
  path: string | null | undefined,
  scope: string,
  load: AssetLoader,
): string | null {
  const key = path ? `${scope}:${path}` : null;
  const [state, setState] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key || !path) return;
    let cancelled = false;
    cachedAssetUrl(key, () => load(path))
      .then((url) => {
        if (!cancelled) setState({ key, url });
      })
      .catch(() => {
        /* missing file: the fallback initial shows instead */
      });
    return () => {
      cancelled = true;
    };
  }, [key, path, load]);
  return key && state?.key === key ? state.url : null;
}

/** Blob URLs for several portraits at once, keyed by path. */
export function usePortraitUrls(
  paths: string[],
  scope: string,
  load: AssetLoader,
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const wanted = Array.from(new Set(paths)).sort().join("\n");
  useEffect(() => {
    let cancelled = false;
    const list = wanted ? wanted.split("\n") : [];
    for (const path of list) {
      cachedAssetUrl(`${scope}:${path}`, () => load(path))
        .then((url) => {
          if (cancelled) return;
          setUrls((prev) =>
            prev[path] === url ? prev : { ...prev, [path]: url },
          );
        })
        .catch(() => {
          /* missing file: no thumbnail for that pin */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [wanted, scope, load]);
  return urls;
}

/** First letter or digit of a name, for the fallback tile. */
export function initialOf(name: string): string {
  const word = name
    .trim()
    .split(/\s+/)
    .find((w) => /[\p{L}\p{N}]/u.test(w));
  const ch = word ? Array.from(word).find((c) => /[\p{L}\p{N}]/u.test(c)) : "";
  return (ch ?? "?").toUpperCase();
}

/** Tooltip markup for a map pin: thumbnail plus name, HTML-escaped. */
export function pinTooltipHtml(name: string, url: string | undefined): string {
  const safe = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const img = url ? `<img class="cf-pin-portrait" src="${url}" alt="">` : "";
  return `${img}<span>${safe}</span>`;
}
