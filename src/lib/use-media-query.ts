import { useSyncExternalStore } from "react";

/** True while the window matches a CSS media query; follows resizes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * A phone-sized viewport, below Tailwind's `md` breakpoint. Screens that
 * put panes side by side show one at a time instead.
 */
export function useNarrow(): boolean {
  return useMediaQuery("(max-width: 47.99rem)");
}
