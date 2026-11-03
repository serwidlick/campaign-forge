import { open } from "@tauri-apps/plugin-dialog";
import { FileText, FileUp, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/Button";
import { errorMessage, storage } from "@/lib/tauri";
import type { Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

import { documentFileOf, formatBytes } from "./document-model";
import { PdfViewer } from "./PdfViewer";

/**
 * A Document is a PDF (a rulebook, a handout, a letter) kept in the
 * campaign's `assets/docs/` folder, shown inline above the notes. Open it
 * beside anything else with Ctrl+click, like any element.
 */
export function DocumentPanel({ element }: { element: Element }) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const setError = useCampaignStore((s) => s.setError);
  const [busy, setBusy] = useState(false);

  const file = documentFileOf(element);
  const fileName =
    typeof element.fileName === "string" ? element.fileName : null;
  const fileBytes =
    typeof element.fileBytes === "number" ? element.fileBytes : null;

  async function choose() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose a PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const doc = await storage.importDocument(picked);
      await saveElement(element.id, {
        file: doc.path,
        fileName: doc.name,
        fileBytes: doc.bytes,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    await saveElement(element.id, {
      file: undefined,
      fileName: undefined,
      fileBytes: undefined,
    });
  }

  if (!file) {
    return (
      <section className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-ink-700 bg-ink-900/60 px-6 py-10 text-center">
        <FileText size={28} className="text-ink-600" />
        <p className="text-sm text-ink-400">
          Attach a PDF: a rulebook, a handout, a letter for the party. It is
          copied into the campaign folder so it travels with your notes.
        </p>
        <Button onClick={() => void choose()} disabled={busy}>
          <FileUp size={16} /> {busy ? "Copying…" : "Choose a PDF"}
        </Button>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-400">
        <FileText size={14} className="text-ink-500" />
        <span className="truncate text-ink-200">{fileName ?? file}</span>
        {fileBytes !== null && <span>{formatBytes(fileBytes)}</span>}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void choose()}
          disabled={busy}
        >
          <FileUp size={14} /> {busy ? "Copying…" : "Replace"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void detach()}
          title="Detach the PDF (the file stays in assets/docs)"
        >
          <Trash2 size={14} />
        </Button>
      </div>
      <PdfViewer
        path={file}
        scope="local"
        load={storage.readAsset}
        title={element.name}
      />
    </section>
  );
}
