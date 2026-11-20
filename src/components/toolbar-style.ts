/** Classes shared by the rail's buttons and the theme picker's rail trigger. */
export function railButtonClass({
  active,
  tone = "default",
}: {
  active?: boolean;
  tone?: "default" | "accent" | "live";
}) {
  const colour =
    tone === "live"
      ? "text-green-300"
      : tone === "accent"
        ? "text-ember-200"
        : active
          ? "text-ember-300"
          : "text-ink-400 hover:text-ink-200";
  const fill = active
    ? tone === "live"
      ? "bg-green-500/15 shadow-[inset_2px_0_0_var(--color-green-400)]"
      : "bg-ember-500/15 shadow-[inset_2px_0_0_var(--color-ember-500)]"
    : tone === "accent"
      ? "bg-ember-500/20"
      : tone === "live"
        ? "bg-green-500/10"
        : "hover:bg-ink-800";
  return `relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${colour} ${fill}`;
}
