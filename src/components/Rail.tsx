import type { ReactNode } from "react";

import { railButtonClass } from "@/components/toolbar-style";

/**
 * The icon rail down the left edge of the workspace: one button per view,
 * the table and the assistant, with the tools that apply everywhere at the
 * bottom. Icon only, so every button carries its label as a tooltip.
 */
export function Rail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <nav
      aria-label={label}
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-ink-950 py-2"
    >
      {children}
    </nav>
  );
}

export function RailDivider() {
  return <span aria-hidden className="my-1.5 h-px w-6 bg-ink-800" />;
}

export function RailSpacer() {
  return <span className="flex-1" />;
}

export function RailButton({
  label,
  icon,
  title,
  active,
  tone = "default",
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  /** A longer tooltip than the label, when the state needs explaining. */
  title?: string;
  active?: boolean;
  tone?: "default" | "accent" | "live";
  /** A small count in the corner, e.g. players at the table. */
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      className={railButtonClass({ active, tone })}
    >
      {icon}
      {badge !== undefined && (
        <span
          aria-hidden
          className="absolute top-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-green-400 px-1 text-[9px] font-semibold leading-none text-ink-950"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
