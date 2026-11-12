import type { ReactNode } from "react";

import { toolbarButtonClass } from "@/components/toolbar-style";

/**
 * One cell of the sidebar's footer toolbar: an icon over a short label, so
 * the controls read without hovering for a tooltip.
 */
export function ToolbarButton({
  label,
  icon,
  title,
  pressed,
  tone = "default",
  onClick,
}: {
  label: string;
  icon: ReactNode;
  title?: string;
  pressed?: boolean;
  tone?: "default" | "accent" | "live";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={pressed}
      className={toolbarButtonClass({ pressed, tone })}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
