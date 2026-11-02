import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { kindById } from "@/lib/types";

import type { MentionKeyHandler, MentionState } from "./element-mention";

interface Props {
  state: MentionState;
  keyHandlerRef: { current: MentionKeyHandler | null };
}

const GAP = 6;

/**
 * The `@` suggestion list. Positioned next to the caret, driven entirely by
 * `state` from the ElementMention extension, and steered with the keyboard
 * through `keyHandlerRef`.
 */
export function MentionPopup({ state, keyHandlerRef }: Props) {
  const { items, rect, command } = state;

  const listRef = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);

  // New results reset the highlight (state derived from props, adjusted
  // during render rather than in an effect).
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setIndex(0);
  }
  const activeIndex = items.length ? Math.min(index, items.length - 1) : 0;

  // Keyboard navigation, consumed by the editor's key handling.
  useEffect(() => {
    const move = (delta: number) => {
      if (items.length) {
        setIndex((i) => (i + delta + items.length) % items.length);
      }
      return true;
    };
    keyHandlerRef.current = (event) => {
      // Down, Tab: next. Up, Shift+Tab: previous. Enter: insert.
      if (event.key === "ArrowDown") return move(1);
      if (event.key === "ArrowUp") return move(-1);
      if (event.key === "Tab") return move(event.shiftKey ? -1 : 1);
      if (event.key === "Enter") {
        const item = items[activeIndex];
        if (item) command(item);
        return Boolean(item);
      }
      return false;
    };
    return () => {
      keyHandlerRef.current = null;
    };
  }, [items, activeIndex, command, keyHandlerRef]);

  // Flip above the caret when there is no room below. Measured after layout
  // and applied straight to the element so it never lags a frame.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !rect) return;
    const height = el.offsetHeight;
    const above = rect.bottom + GAP + height > window.innerHeight;
    el.style.left = `${rect.left}px`;
    el.style.top = above ? `${rect.top - GAP}px` : `${rect.bottom + GAP}px`;
    el.style.transform = above ? "translateY(-100%)" : "";
  }, [rect, items]);

  if (!rect) return null;

  return createPortal(
    <ul
      ref={listRef}
      role="listbox"
      className="fixed z-50 max-h-72 w-72 overflow-y-auto rounded-md border border-ink-700 bg-ink-900 py-1 shadow-xl shadow-black/40"
    >
      {items.length === 0 ? (
        <li className="px-3 py-2 text-xs text-ink-500">No matching elements</li>
      ) : (
        items.map((item, i) => (
          <li
            key={item.id}
            role="option"
            aria-selected={i === activeIndex}
            onMouseDown={(e) => {
              // mousedown, not click, so the editor keeps focus and the
              // suggestion range is still valid when we insert.
              e.preventDefault();
              command(item);
            }}
            onMouseEnter={() => setIndex(i)}
            className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-sm ${
              i === activeIndex ? "bg-ink-700/70 text-ink-100" : "text-ink-200"
            }`}
          >
            <span className="truncate">{item.name}</span>
            <span className="shrink-0 text-[11px] text-ink-500">
              {kindById(item.type).label}
            </span>
          </li>
        ))
      )}
    </ul>,
    document.body,
  );
}
