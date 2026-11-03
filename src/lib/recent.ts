/**
 * Recently opened campaigns, persisted in the app's settings store
 * (tauri-plugin-store). This is app state, not campaign data, so it lives in
 * the OS app-data directory rather than in any campaign folder.
 */
import { load, type Store } from "@tauri-apps/plugin-store";

export interface RecentCampaign {
  path: string;
  name: string;
  openedAt: string;
}

const KEY = "recentCampaigns";
const MAX_RECENT = 8;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load("settings.json", {
    defaults: { [KEY]: [] },
    autoSave: true,
  });
  return storePromise;
}

export async function getRecentCampaigns(): Promise<RecentCampaign[]> {
  try {
    const store = await getStore();
    return (await store.get<RecentCampaign[]>(KEY)) ?? [];
  } catch {
    // Outside the Tauri shell (plain `vite` in a browser) the store plugin is
    // unavailable. A missing recent list is not worth an error banner.
    return [];
  }
}

export async function rememberCampaign(
  entry: Pick<RecentCampaign, "path" | "name">,
): Promise<void> {
  const store = await getStore();
  const existing = (await store.get<RecentCampaign[]>(KEY)) ?? [];
  const next: RecentCampaign[] = [
    { ...entry, openedAt: new Date().toISOString() },
    ...existing.filter((r) => r.path !== entry.path),
  ].slice(0, MAX_RECENT);
  await store.set(KEY, next);
}

export async function forgetCampaign(path: string): Promise<void> {
  const store = await getStore();
  const existing = (await store.get<RecentCampaign[]>(KEY)) ?? [];
  await store.set(
    KEY,
    existing.filter((r) => r.path !== path),
  );
}

/** "today", "yesterday", "6 days ago", "3 weeks ago", for recent rows. */
export function relativeOpened(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.round(days / 7);
    return `${w} ${w === 1 ? "week" : "weeks"} ago`;
  }
  if (days < 365) {
    const m = Math.round(days / 30);
    return `${m} ${m === 1 ? "month" : "months"} ago`;
  }
  const y = Math.round(days / 365);
  return `${y} ${y === 1 ? "year" : "years"} ago`;
}
