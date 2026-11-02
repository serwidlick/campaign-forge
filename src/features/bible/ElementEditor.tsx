import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/Button";
import { kindById, type Element } from "@/lib/types";
import { useCampaignStore } from "@/stores/campaign-store";

const AUTOSAVE_MS = 600;

interface Props {
  element: Element;
}

/**
 * Edits one element. Mount with `key={element.id}` so the editor is rebuilt
 * when the selection changes; the component owns a debounced autosave and
 * flushes it on unmount.
 */
export function ElementEditor({ element }: Props) {
  const saveSelected = useCampaignStore((s) => s.saveSelected);
  const deleteElement = useCampaignStore((s) => s.deleteElement);

  const [name, setName] = useState(element.name);
  const [tagsText, setTagsText] = useState(element.tags.join(", "));
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");

  const pending = useRef<Partial<Pick<Element, "name" | "tags" | "body">>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;
    setStatus("saving");
    await saveSelected(patch);
    setStatus((s) => (Object.keys(pending.current).length > 0 ? s : "saved"));
  }, [saveSelected]);

  const queue = useCallback(
    (patch: Partial<Pick<Element, "name" | "tags" | "body">>) => {
      pending.current = { ...pending.current, ...patch };
      setStatus("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  // Flush on unmount (element switch, campaign close, window close).
  useEffect(() => () => void flush(), [flush]);

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: element.body,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "tiptap", spellcheck: "true" },
    },
    onUpdate: ({ editor }) => queue({ body: editor.getMarkdown() }),
  });

  function handleTagsBlur() {
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    queue({ tags });
  }

  async function handleDelete() {
    if (
      !window.confirm(
        `Delete "${element.name}"? The file will be removed from disk.`,
      )
    )
      return;
    pending.current = {};
    await deleteElement(element.id);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b border-ink-800 px-6 py-4">
        <div className="flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            {kindById(element.type).label}
          </div>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              queue({ name: e.target.value });
            }}
            className="mt-0.5 w-full bg-transparent font-serif text-2xl font-semibold text-ink-100 outline-none"
            aria-label="Element name"
          />
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            onBlur={handleTagsBlur}
            placeholder="tags, comma, separated"
            className="mt-1 w-full bg-transparent text-xs text-ink-400 outline-none placeholder:text-ink-600"
            aria-label="Tags"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-500">
            {status === "saved"
              ? "Saved"
              : status === "saving"
                ? "Saving…"
                : "Unsaved"}
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            aria-label="Delete element"
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl">
          <EditorContent editor={editor} />
        </div>
      </div>
      <footer className="border-t border-ink-800 px-6 py-1.5 font-mono text-[11px] text-ink-600">
        {element.path}
      </footer>
    </div>
  );
}
