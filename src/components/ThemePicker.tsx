import { Check, Palette } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { railButtonClass } from "@/components/toolbar-style";
import { THEMES, type Theme } from "@/lib/theme";
import { useThemeStore } from "@/stores/theme-store";

interface ThemePickerProps {
  /**
   * An icon button for toolbars, a text link for footers, or a square
   * button for the workspace rail.
   */
  variant?: "icon" | "text" | "rail";
  /** Where the menu opens relative to the button. */
  placement?: "below-end" | "above-start" | "right-end";
}

const PLACEMENT: Record<NonNullable<ThemePickerProps["placement"]>, string> = {
  "below-end": "top-full right-0 mt-1 w-64",
  "above-start": "bottom-full left-0 mb-1 w-64",
  "right-end": "bottom-0 left-full ml-1 w-64",
};

export function ThemePicker({
  variant = "icon",
  placement = "below-end",
}: ThemePickerProps) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const trigger =
    variant === "icon" ? (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Theme"
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`rounded-md p-1 transition-colors ${
          open
            ? "bg-ink-700/60 text-ink-100"
            : "text-ink-400 hover:bg-ink-800 hover:text-ink-200"
        }`}
      >
        <Palette size={14} />
      </button>
    ) : variant === "rail" ? (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Theme"
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={railButtonClass({ active: open })}
      >
        <Palette size={18} />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="text-ink-300 hover:text-ember-300"
      >
        Theme
      </button>
    );

  return (
    <div ref={rootRef} className="relative inline-block">
      {trigger}
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Theme"
          className={`absolute z-50 rounded-lg border border-ink-700 bg-ink-850 p-1 shadow-xl shadow-ink-950/60 ${PLACEMENT[placement]}`}
        >
          {THEMES.map((t) => (
            <ThemeOption
              key={t.id}
              theme={t}
              active={t.id === theme}
              onPick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeOption({
  theme,
  active,
  onPick,
}: {
  theme: Theme;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? "bg-ink-700/60" : "hover:bg-ink-800"
      }`}
    >
      <Swatch id={theme.id} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink-100">{theme.label}</span>
        <span className="block truncate text-xs text-ink-400">
          {theme.description}
        </span>
      </span>
      {active && <Check size={14} className="shrink-0 text-ember-400" />}
    </button>
  );
}

/**
 * A preview of the theme's page, panel and accent colours. The swatch
 * carries its own `data-theme`, so the stylesheet resolves the tokens for
 * that theme inside it and nothing here needs to know the colour values.
 */
function Swatch({ id }: { id: Theme["id"] }) {
  return (
    <span
      data-theme={id}
      aria-hidden
      className="flex h-7 w-10 shrink-0 overflow-hidden rounded border border-ink-600 bg-ink-950"
    >
      <span className="h-full w-1/3 bg-ink-900" />
      <span className="flex flex-1 flex-col justify-center gap-1 px-1">
        <span className="h-1 w-full rounded-full bg-ink-300" />
        <span className="h-1 w-2/3 rounded-full bg-ember-500" />
      </span>
    </span>
  );
}
