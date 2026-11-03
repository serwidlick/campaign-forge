import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  Presentation,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/Button";
import {
  elementIdFromHref,
  kindById,
  type Element,
  type ElementSummary,
} from "@/lib/types";
import { useCampaignStore, type ElementPatch } from "@/stores/campaign-store";
import {
  PLAYERS_HEADING,
  hasPlayersSection,
} from "@/features/player/player-model";
import { PortraitPicker } from "@/features/images/PortraitPicker";
import { useTableStore } from "@/stores/table-store";

import {
  ElementMention,
  filterMentionItems,
  type MentionKeyHandler,
  type MentionState,
} from "./element-mention";
import { MentionPopup } from "./MentionPopup";

const AUTOSAVE_MS = 600;

interface Props {
  element: Element;
  /** Kind-specific controls rendered between the header and the body. */
  panel?: React.ReactNode;
}

function getMentionItems(query: string): ElementSummary[] {
  return filterMentionItems(useCampaignStore.getState().elements, query);
}

/**
 * Edits one element. Mount with `key={element.id}` so the editor is rebuilt
 * when the selection changes; the component owns a debounced autosave and
 * flushes it on unmount.
 */
export function ElementEditor({ element, panel }: Props) {
  const saveElement = useCampaignStore((s) => s.saveElement);
  const deleteElement = useCampaignStore((s) => s.deleteElement);
  const navigate = useCampaignStore((s) => s.navigate);
  const elements = useCampaignStore((s) => s.elements);

  const [name, setName] = useState(element.name);
  const [tagsText, setTagsText] = useState(element.tags.join(", "));
  const [status, setStatus] = useState<"saved" | "dirty" | "saving">("saved");
  const [mention, setMention] = useState<MentionState | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const shared = element.shared === true;
  const hosting = useTableStore((s) => s.hosting);
  const showToPlayers = useTableStore((s) => s.showToPlayers);
  const showing = hosting?.spotlight === element.id;
  const playersSection = hasPlayersSection(element.body);

  async function handleShow() {
    if (showing) {
      await showToPlayers(null);
      return;
    }
    if (!shared) await saveElement(element.id, { shared: true });
    await showToPlayers(element.id);
  }

  // A plain mutable holder, not a React ref: it is handed to the Tiptap
  // extension at construction time, which the hooks lint forbids for refs.
  const [mentionKeysRef] = useState<{ current: MentionKeyHandler | null }>(
    () => ({ current: null }),
  );
  const pending = useRef<ElementPatch>({});
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
    await saveElement(element.id, patch);
    setStatus((s) => (Object.keys(pending.current).length > 0 ? s : "saved"));
  }, [saveElement, element.id]);

  const queue = useCallback(
    (patch: ElementPatch) => {
      pending.current = { ...pending.current, ...patch };
      setStatus("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  // Flush on unmount (element switch, campaign close, window close).
  useEffect(() => () => void flush(), [flush]);

  // Ctrl/Cmd held turns element links into clickable links.
  useEffect(() => {
    const update = (e: KeyboardEvent) => setLinkMode(e.ctrlKey || e.metaKey);
    const clear = () => setLinkMode(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          protocols: [{ scheme: "cf", optionalSlashes: true }],
        },
      }),
      Markdown,
      ElementMention.configure({
        getItems: getMentionItems,
        onStateChange: setMention,
        keyHandler: mentionKeysRef,
      }),
    ],
    content: element.body,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "tiptap", spellcheck: "true" },
      handleClick: (_view, _pos, event) => {
        // Ctrl/Cmd+click opens beside; Alt+click opens here; plain click edits.
        const pane = event.ctrlKey || event.metaKey;
        if (!pane && !event.altKey) return false;
        const anchor = (event.target as HTMLElement | null)?.closest("a");
        const id = elementIdFromHref(anchor?.getAttribute("href"));
        if (!id) return false;
        event.preventDefault();
        void navigate(id, { pane });
        return true;
      },
    },
    onUpdate: ({ editor }) => queue({ body: editor.getMarkdown() }),
  });

  const { linksTo, linkedFrom } = useMemo(() => {
    const byId = new Map(elements.map((e) => [e.id, e]));
    const linksTo = element.links
      .map((id) => byId.get(id))
      .filter((e): e is ElementSummary => Boolean(e));
    const linkedFrom = elements.filter(
      (e) => e.id !== element.id && e.links.includes(element.id),
    );
    return { linksTo, linkedFrom };
  }, [elements, element.id, element.links]);

  function handleTagsBlur() {
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    queue({ tags });
  }

  /** Puts a "Players know" heading at the top with a placeholder line. */
  function insertPlayersSection() {
    if (!editor) return;
    editor
      .chain()
      .focus("start")
      .insertContentAt(0, [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: PLAYERS_HEADING }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "What the party has learned so far." },
          ],
        },
      ])
      .run();
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
      <header className="flex items-start gap-4 border-b border-ink-800 px-6 py-4">
        <PortraitPicker element={element} />
        <div className="min-w-0 flex-1">
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
          <button
            type="button"
            onClick={() => void saveElement(element.id, { shared: !shared })}
            aria-pressed={shared}
            title={
              shared
                ? "Players can see this. Click to make it private."
                : "Private to you. Click to share it with players."
            }
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              shared
                ? "bg-ember-500/25 text-ember-200"
                : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
            }`}
          >
            {shared ? <Eye size={13} /> : <EyeOff size={13} />}
            {shared ? "Shared" : "Private"}
          </button>
          {hosting && (
            <button
              type="button"
              onClick={() => void handleShow()}
              aria-pressed={showing}
              title={
                showing
                  ? "Players are looking at this. Click to stop showing it."
                  : shared
                    ? "Open this on every player's screen"
                    : "Share this and open it on every player's screen"
              }
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                showing
                  ? "bg-green-500/20 text-green-300"
                  : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
              }`}
            >
              <Presentation size={13} />
              {showing
                ? "Showing"
                : shared
                  ? "Show to players"
                  : "Share and show"}
            </button>
          )}
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

      {shared && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ember-500/20 bg-ember-500/5 px-6 py-1.5 text-[11px] text-ember-200/90">
          {playersSection ? (
            <>
              Players see only the <strong>{PLAYERS_HEADING}</strong> section.
              Everything else here is yours.
            </>
          ) : (
            <>
              Players see everything in this element.
              <button
                type="button"
                onClick={insertPlayersSection}
                className="rounded px-1.5 py-0.5 text-ember-100 underline decoration-ember-500/60 hover:bg-ember-500/15"
              >
                Add a {PLAYERS_HEADING} section
              </button>
              <span className="text-ember-200/60">
                and only that part goes to them.
              </span>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {panel && <div className="mx-auto mb-8 max-w-3xl">{panel}</div>}
        <div className={`mx-auto max-w-3xl ${linkMode ? "link-mode" : ""}`}>
          <EditorContent editor={editor} />
        </div>

        {(linksTo.length > 0 || linkedFrom.length > 0) && (
          <aside className="mx-auto mt-12 max-w-3xl border-t border-ink-800 pt-4">
            <LinkList
              title="Links to"
              icon={<ArrowRight size={12} />}
              items={linksTo}
              onOpen={(id, pane) => void navigate(id, { pane })}
            />
            <LinkList
              title="Linked from"
              icon={<ArrowLeft size={12} />}
              items={linkedFrom}
              onOpen={(id, pane) => void navigate(id, { pane })}
            />
          </aside>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-ink-800 px-6 py-1.5 text-[11px] text-ink-600">
        <span className="font-mono">{element.path}</span>
        <span>
          Type @ to link · Ctrl+click opens beside · Alt+click opens here
        </span>
      </footer>

      {mention && (
        <MentionPopup state={mention} keyHandlerRef={mentionKeysRef} />
      )}
    </div>
  );
}

function LinkList({
  title,
  icon,
  items,
  onOpen,
}: {
  title: string;
  icon: React.ReactNode;
  items: ElementSummary[];
  onOpen: (id: string, pane: boolean) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
        {icon} {title}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={(ev) => onOpen(e.id, ev.ctrlKey || ev.metaKey)}
              title="Click to open here · Ctrl+click to open beside"
              className="rounded-md bg-ink-850 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 hover:text-ink-100"
            >
              {e.name}
              <span className="ml-1.5 text-ink-500">
                {kindById(e.type).label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
