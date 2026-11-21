/**
 * Line icons for the presence bubbles, drawn as inline SVG (lucide paths, so
 * they match the app). Add your own with `defineIcon` and refer to it by
 * name from a status or an activity.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** @type {Map<string, string[]>} */
const ICONS = new Map([
  [
    "crown",
    [
      "M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z",
      "M5 21h14",
    ],
  ],
  ["moon", ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"]],
  [
    "wifi-off",
    [
      "M12 20h.01",
      "M8.5 16.429a5 5 0 0 1 7 0",
      "M5 12.859a10 10 0 0 1 5.17-2.69",
      "M19 12.859a10 10 0 0 0-2.007-1.523",
      "M2 8.82a15 15 0 0 1 4.177-2.643",
      "M22 8.82a15 15 0 0 0-11.288-3.764",
      "m2 2 20 20",
    ],
  ],
  [
    "eye",
    [
      "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    ],
  ],
  [
    "eye-off",
    [
      "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
      "M14.084 14.158a3 3 0 0 1-4.242-4.242",
      "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
      "m2 2 20 20",
    ],
  ],
  [
    "message",
    ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z", "M8 12h.01", "M12 12h.01", "M16 12h.01"],
  ],
  [
    "mail",
    [
      "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7",
      "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    ],
  ],
  [
    "send",
    [
      "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
      "m21.854 2.147-10.94 10.939",
    ],
  ],
  ["x", ["M18 6 6 18", "m6 6 12 12"]],
  ["rotate", ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"]],
]);

/** Adds (or replaces) an icon by name: SVG path data on a 24×24 grid. */
export function defineIcon(name, paths) {
  ICONS.set(name, [...paths]);
}

/** An icon as an SVG element, hidden from assistive technology. Unknown
 *  names draw nothing rather than throw. */
export function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  for (const d of ICONS.get(name) ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
