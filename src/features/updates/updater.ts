/**
 * In-app updates. The release workflow publishes signed update packages and
 * a `latest.json` manifest with every GitHub release; Tauri's updater plugin
 * fetches the manifest, verifies the signature against the public key in
 * `tauri.conf.json`, and installs the package. Nothing here talks to any
 * server other than GitHub Releases.
 */
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export type UpdatePhase =
  "idle" | "checking" | "available" | "downloading" | "ready" | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** The update found, while one is available or being installed. */
  update: Update | null;
  /** 0..1 while downloading, when the server reports a size. */
  progress: number | null;
  error: string | null;
  /** Set once the user has dismissed the banner for this update. */
  dismissed: boolean;
  /** When the last check finished, for the "Check for updates" link. */
  checkedAt: number | null;
  upToDate: boolean;

  check: (opts?: { manual?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: "idle",
  update: null,
  progress: null,
  error: null,
  dismissed: false,
  checkedAt: null,
  upToDate: false,

  async check(opts) {
    // The dev build has no signed package to compare against.
    if (import.meta.env.DEV) {
      set({ checkedAt: Date.now(), upToDate: true });
      return;
    }
    if (get().phase === "downloading") return;
    set({ phase: "checking", error: null, upToDate: false });
    try {
      const update = await check();
      if (update) {
        set({
          phase: "available",
          update,
          dismissed: false,
          checkedAt: Date.now(),
        });
      } else {
        set({
          phase: "idle",
          update: null,
          checkedAt: Date.now(),
          upToDate: true,
        });
      }
    } catch (err) {
      set({
        phase: opts?.manual ? "error" : "idle",
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      });
    }
  },

  async install() {
    const update = get().update;
    if (!update) return;
    set({ phase: "downloading", progress: null, error: null });
    let total: number | null = null;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            received = 0;
            set({ progress: total ? 0 : null });
            break;
          case "Progress":
            received += event.data.chunkLength;
            if (total) set({ progress: Math.min(1, received / total) });
            break;
          case "Finished":
            set({ progress: 1 });
            break;
        }
      });
      set({ phase: "ready" });
      await relaunch();
    } catch (err) {
      set({
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  dismiss() {
    set({ dismissed: true });
  },
}));
