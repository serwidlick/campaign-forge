import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Trash2 } from "lucide-react";
import { useState } from "react";

import { errorMessage, storage } from "@/lib/tauri";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { Portrait } from "./Portrait";
import { portraitOf } from "./portrait-model";

const SIZE = 72;

/**
 * The portrait in an element's header. Click to choose an image; it is copied
 * into the campaign's `assets/images/` folder and the file name stored in the
 * element's frontmatter as `portrait`.
 */
export function PortraitPicker({ element }: { element: Element }) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const setError = useCampaignStore((s) => s.setError);
  const [busy, setBusy] = useState(false);
  const path = portraitOf(element);

  async function pick() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: `Choose a picture for ${element.name}`,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const img = await storage.importElementImage(element.id, picked);
      await saveElement(element.id, { portrait: img.path });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await saveElement(element.id, { portrait: undefined });
  }

  return (
    <div
      className="group relative shrink-0"
      style={{ width: SIZE, height: SIZE }}
    >
      <button
        type="button"
        onClick={() => void pick()}
        disabled={busy}
        title={path ? "Replace picture" : "Add a picture"}
        aria-label={path ? "Replace picture" : "Add a picture"}
        className="block rounded-lg outline-none ring-ember-500 focus-visible:ring-2"
      >
        <Portrait
          path={path}
          name={element.name}
          kind={element.type}
          size={SIZE}
          scope="local"
          load={storage.readAsset}
          className={busy ? "opacity-50" : ""}
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-ink-950/60 text-ink-100 opacity-0 transition-opacity group-hover:opacity-100">
          <ImagePlus size={18} />
        </span>
      </button>
      {path && (
        <button
          type="button"
          onClick={() => void remove()}
          title="Remove picture"
          aria-label="Remove picture"
          className="absolute -top-1.5 -right-1.5 hidden rounded-full border border-ink-700 bg-ink-900 p-1 text-ink-400 hover:text-red-300 group-hover:block"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}
