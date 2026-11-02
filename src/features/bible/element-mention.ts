/**
 * `@` mentions that insert a link to another element.
 *
 * The inserted content is plain text carrying the StarterKit `link` mark with
 * an `cf://element/<id>` href, so it round-trips through Markdown as an
 * ordinary `[Name](cf://element/<id>)` link and the Rust side can index it.
 *
 * The popup UI lives in React (`MentionPopup`). This extension only reports
 * suggestion state through `onStateChange` and forwards key events through
 * `keyHandler`, so there is no second React root inside the editor.
 */
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";

import { elementHref, type ElementSummary } from "@/lib/types";

export interface MentionState {
  items: ElementSummary[];
  query: string;
  /** Caret rectangle in viewport coordinates, for positioning the popup. */
  rect: DOMRect | null;
  command: (item: ElementSummary) => void;
}

export type MentionKeyHandler = (event: KeyboardEvent) => boolean;

export interface ElementMentionOptions {
  getItems: (query: string) => ElementSummary[];
  onStateChange: (state: MentionState | null) => void;
  /** Set by the popup while it is open; returns true when it consumed the key. */
  keyHandler: { current: MentionKeyHandler | null };
}

const PLUGIN_KEY = new PluginKey("elementMention");

export const ElementMention = Extension.create<ElementMentionOptions>({
  name: "elementMention",

  addOptions() {
    return {
      getItems: () => [],
      onStateChange: () => {},
      keyHandler: { current: null },
    };
  },

  addProseMirrorPlugins() {
    const { getItems, onStateChange, keyHandler } = this.options;

    const toState = (
      props: SuggestionProps<ElementSummary, ElementSummary>,
    ): MentionState => ({
      items: props.items,
      query: props.query,
      rect: props.clientRect?.() ?? null,
      command: props.command,
    });

    return [
      Suggestion<ElementSummary, ElementSummary>({
        editor: this.editor,
        pluginKey: PLUGIN_KEY,
        char: "@",
        allowSpaces: true,
        decorationClass: "mention-query",
        items: ({ query }) => getItems(query),
        command: ({ editor, range, props: item }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "text",
                text: item.name,
                marks: [
                  { type: "link", attrs: { href: elementHref(item.id) } },
                ],
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => ({
          onStart: (props) => onStateChange(toState(props)),
          onUpdate: (props) => onStateChange(toState(props)),
          onExit: () => onStateChange(null),
          onKeyDown: ({ event, view }: SuggestionKeyDownProps) => {
            if (event.key === "Escape") {
              exitSuggestion(view, PLUGIN_KEY);
              return true;
            }
            return keyHandler.current?.(event) ?? false;
          },
        }),
      }),
    ];
  },
});

/** Default item lookup: case-insensitive name match, prefix matches first. */
export function filterMentionItems(
  elements: ElementSummary[],
  query: string,
  limit = 8,
): ElementSummary[] {
  const q = query.trim().toLowerCase();
  const scored = elements
    .map((e) => {
      const name = e.name.toLowerCase();
      const score = !q ? 1 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0;
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((s) => s.e);
}
