/**
 * App colour themes. A theme is a set of values for the `ink` and `ember`
 * colour tokens, defined in index.css and selected by the `data-theme`
 * attribute on <html>. The choice is a UI preference, not campaign data, so
 * it lives in localStorage like the other window preferences.
 */

export type ThemeId =
  | "ember"
  | "moonstone"
  | "greenwood"
  | "obsidian"
  | "dusk"
  | "parchment"
  | "daylight"
  | "sage";

export interface Theme {
  id: ThemeId;
  label: string;
  description: string;
  appearance: "dark" | "light";
}

export const THEMES: Theme[] = [
  {
    id: "ember",
    label: "Ember",
    description: "Charcoal and firelight. The default.",
    appearance: "dark",
  },
  {
    id: "moonstone",
    label: "Moonstone",
    description: "Cool slate with a lavender glow.",
    appearance: "dark",
  },
  {
    id: "greenwood",
    label: "Greenwood",
    description: "Deep forest with gold leaf.",
    appearance: "dark",
  },
  {
    id: "obsidian",
    label: "Obsidian",
    description: "Near-black glass with an ice-blue edge.",
    appearance: "dark",
  },
  {
    id: "dusk",
    label: "Dusk",
    description: "Deep plum with a rose accent.",
    appearance: "dark",
  },
  {
    id: "parchment",
    label: "Parchment",
    description: "Warm paper and sealing wax. Light.",
    appearance: "light",
  },
  {
    id: "daylight",
    label: "Daylight",
    description: "Clean neutrals with a teal accent. Light.",
    appearance: "light",
  },
  {
    id: "sage",
    label: "Sage",
    description: "Soft green-grey paper with terracotta. Light.",
    appearance: "light",
  },
];

export const DEFAULT_THEME: ThemeId = "ember";

const KEY = "cf.theme";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function loadTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Private mode or a blocked store: the theme still applies this session.
  }
}

/** Point the stylesheet at a theme. Takes effect on the next paint. */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
}
