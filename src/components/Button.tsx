import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-ember-500 text-ink-950 hover:bg-ember-400 disabled:bg-ink-700 disabled:text-ink-400",
  ghost: "bg-transparent text-ink-200 hover:bg-ink-800 disabled:text-ink-600",
  danger:
    "bg-transparent text-red-300 hover:bg-red-500/10 disabled:text-ink-600",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const sizing = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizing} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
