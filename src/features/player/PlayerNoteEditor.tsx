import { Eye, EyeOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/Button";
import type { Element, NoteInput } from "@/lib/types";

const AUTOSAVE_MS = 600;

const FIELD =
  "w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-ink-100 outline-none placeholder:text-ink-600 focus:border-ember-500";

type Status = "saved" | "unsaved" | "saving" | "failed";

interface Draft {
  name: string;
  body: string;
  shared: boolean;
}

function draftOf(element: Element): Draft {
  return {
    name: element.name,
    body: element.body,
    shared: element.shared === true,
  };
}

/**
 * A note of the player's own, edited at the table: title, Markdown body and
 * whether the rest of the table gets it. Every change saves on its own a
 * moment later, straight into the GM's file; the GM's copy comes back
 * through the usual refresh. If a save fails the draft is kept and offered
 * again. If GM and player edit the same note at once, the last save wins.
 */
export function PlayerNoteEditor({
  element,
  onSave,
  onDelete,
  onDeleted,
  onNameChange,
}: {
  element: Element;
  onSave: (input: NoteInput) => Promise<Element>;
  onDelete: () => Promise<void>;
  /** The note is gone: leave its page. */
  onDeleted: () => void;
  /** The title as typed, so the header can follow before the save lands. */
  onNameChange?: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(element));
  const [status, setStatus] = useState<Status>("saved");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The newest draft lives outside React state too, so a flush can read it
  // at any moment, including while the component unmounts.
  const latest = useRef(draft);
  const dirty = useRef(false);
  const saving = useRef(false);
  const version = useRef(element.version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The GM's copy arriving (after our own save, or an edit of theirs) is
  // adopted only while nothing is typed here, so a draft is never lost.
  useEffect(() => {
    version.current = element.version;
    if (dirty.current || saving.current) return;
    const next = draftOf(element);
    latest.current = next;
    setDraft(next);
  }, [element]);

  function update(patch: Partial<Draft>) {
    latest.current = { ...latest.current, ...patch };
    setDraft(latest.current);
    dirty.current = true;
    setStatus("unsaved");
    if (patch.name !== undefined) onNameChange?.(patch.name);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_MS);
  }

  async function flush() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current || saving.current) return;
    dirty.current = false;
    saving.current = true;
    setStatus("saving");
    setError(null);
    const d = latest.current;
    try {
      const saved = await onSave({
        name: d.name,
        body: d.body,
        shared: d.shared,
        baseVersion: version.current,
      });
      version.current = saved.version;
      saving.current = false;
      if (dirty.current) void flushRef.current();
      else setStatus("saved");
    } catch (err) {
      saving.current = false;
      dirty.current = true;
      setStatus("failed");
      const text = err instanceof Error ? err.message : String(err);
      setError(
        text.startsWith("conflict:")
          ? "The note changed on the GM's side. Retry to save your version over it."
          : `Could not save: ${text}`,
      );
    }
  }

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => () => void flushRef.current(), []);

  async function handleDelete() {
    setConfirming(false);
    setDeleting(true);
    dirty.current = false;
    try {
      await onDelete();
      onDeleted();
    } catch (err) {
      setDeleting(false);
      setError(
        `Could not delete: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-ember-300">
          Your note. It is saved in the GM's campaign folder.
        </span>
        <span className="flex-1" />
        <span className={status === "failed" ? "text-red-300" : "text-ink-500"}>
          {status === "saved"
            ? "Saved"
            : status === "saving"
              ? "Saving…"
              : status === "failed"
                ? "Not saved"
                : "Unsaved"}
        </span>
        {status === "failed" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void flushRef.current()}
          >
            Retry
          </Button>
        )}
      </div>

      <input
        value={draft.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Title"
        aria-label="Title"
        className={`${FIELD} font-serif text-lg font-semibold`}
      />
      <textarea
        value={draft.body}
        onChange={(e) => update({ body: e.target.value })}
        placeholder="Write here. Markdown works: # headings, - lists, **bold**."
        aria-label="Note"
        rows={Math.max(8, Math.min(30, draft.body.split("\n").length + 2))}
        className={`${FIELD} resize-y text-[15px] leading-relaxed`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => update({ shared: !draft.shared })}
          aria-pressed={draft.shared}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
            draft.shared
              ? "border-ember-500/60 bg-ember-500/15 text-ember-200"
              : "border-ink-700 text-ink-300 hover:border-ink-500"
          }`}
        >
          {draft.shared ? <Eye size={13} /> : <EyeOff size={13} />}
          {draft.shared ? "Shared with the table" : "Only you and the GM"}
        </button>
        <span className="flex-1" />
        {confirming ? (
          <span className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 py-0.5 pl-2 pr-0.5 text-[11px] text-red-200">
            Delete this note?
            <Button
              variant="danger"
              size="sm"
              autoFocus
              onClick={() => void handleDelete()}
              onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}
            >
              Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
          </span>
        ) : (
          <Button
            variant="danger"
            size="sm"
            disabled={deleting}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={13} /> Delete
          </Button>
        )}
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
