/** Classes shared by the sidebar footer tiles and the theme picker tile. */
export function toolbarButtonClass({
  pressed,
  tone = "default",
}: {
  pressed?: boolean;
  tone?: "default" | "accent" | "live";
}) {
  const state =
    tone === "live"
      ? "bg-green-500/15 text-green-300"
      : tone === "accent"
        ? "bg-ember-500/20 text-ember-200"
        : pressed
          ? "bg-ink-700/60 text-ink-100"
          : "text-ink-400 hover:bg-ink-800 hover:text-ink-200";
  return `flex w-full flex-col items-center gap-1 rounded-md px-0.5 py-1.5 text-[10px] leading-none transition-colors ${state}`;
}
