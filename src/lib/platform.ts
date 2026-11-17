/**
 * Where the frontend is running: inside the Tauri window, or in a browser
 * that opened the table's `/gm` page. Everything that reaches for a Tauri
 * plugin asks here first and falls back to what a browser can do.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

export const inTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The phone and tablet build, decided when the bundle is made. It is the
 * player app only: it joins a GM's table and shows the player view. There
 * is no campaign folder to open, no hosting, no assistant and no updater.
 */
export const isMobile: boolean =
  import.meta.env.TAURI_ENV_PLATFORM === "android" ||
  import.meta.env.TAURI_ENV_PLATFORM === "ios";

/** Opens a link in the user's browser (or a new tab, when we are one). */
export function openExternal(url: string): void {
  if (inTauri) {
    void openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** A file the user picked: its path in the Tauri window, the File itself in a browser. */
export type PickedFile = string | File;

/**
 * Lets the user pick one file. The Tauri window shows the native dialog and
 * hands back a path; a browser shows its own picker and hands back the File,
 * whose bytes the caller sends to wherever the campaign lives.
 */
export async function pickFile(opts: {
  title: string;
  name: string;
  extensions: string[];
}): Promise<PickedFile | null> {
  if (inTauri) {
    const picked = await open({
      multiple: false,
      directory: false,
      title: opts.title,
      filters: [{ name: opts.name, extensions: opts.extensions }],
    });
    return typeof picked === "string" ? picked : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = opts.extensions.map((e) => `.${e}`).join(",");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
