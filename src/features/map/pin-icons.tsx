import {
  Anchor,
  Beer,
  Building2,
  Castle,
  Church,
  Crown,
  Flag,
  Flame,
  Gem,
  Home,
  Landmark,
  Mountain,
  Scroll,
  Ship,
  Skull,
  Sparkles,
  Star,
  Swords,
  Tent,
  TreePine,
  type LucideIcon,
} from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_PIN_COLOR, type MapPin } from "./map-model";

export interface PinIcon {
  id: string;
  label: string;
  /** null draws the plain dot. */
  Icon: LucideIcon | null;
}

/** What a pin can look like. Ids are stored in the map file. */
export const PIN_ICONS: PinIcon[] = [
  { id: "dot", label: "Dot", Icon: null },
  { id: "town", label: "Town", Icon: Home },
  { id: "city", label: "City", Icon: Building2 },
  { id: "capital", label: "Capital", Icon: Crown },
  { id: "castle", label: "Castle", Icon: Castle },
  { id: "temple", label: "Temple", Icon: Church },
  { id: "ruins", label: "Ruins", Icon: Landmark },
  { id: "inn", label: "Inn", Icon: Beer },
  { id: "camp", label: "Camp", Icon: Tent },
  { id: "forest", label: "Forest", Icon: TreePine },
  { id: "mountain", label: "Mountain", Icon: Mountain },
  { id: "port", label: "Port", Icon: Anchor },
  { id: "ship", label: "Ship", Icon: Ship },
  { id: "danger", label: "Danger", Icon: Skull },
  { id: "battle", label: "Battle", Icon: Swords },
  { id: "quest", label: "Quest", Icon: Scroll },
  { id: "treasure", label: "Treasure", Icon: Gem },
  { id: "magic", label: "Magic", Icon: Sparkles },
  { id: "fire", label: "Fire", Icon: Flame },
  { id: "flag", label: "Flag", Icon: Flag },
  { id: "star", label: "Star", Icon: Star },
];

export function pinIconById(id: string): PinIcon {
  return PIN_ICONS.find((i) => i.id === id) ?? PIN_ICONS[0]!;
}

const DOT_SIZE = 14;
const ICON_SIZE = 24;

const svgCache = new Map<string, string>();

function iconSvg(icon: PinIcon): string {
  if (!icon.Icon) return "";
  let svg = svgCache.get(icon.id);
  if (!svg) {
    const Icon = icon.Icon;
    svg = renderToStaticMarkup(<Icon size={14} strokeWidth={2.4} />);
    svgCache.set(icon.id, svg);
  }
  return svg;
}

/**
 * Markup and size for a pin's Leaflet marker. Leaflet wants an HTML string,
 * so the icon is rendered to static SVG once and reused.
 */
export function pinMarker(
  pin: MapPin,
  opts: { selected?: boolean; linksMap?: boolean } = {},
): { html: string; size: number } {
  const icon = pinIconById(pin.icon);
  const color = pin.color || DEFAULT_PIN_COLOR;
  const classes = [
    "cf-pin",
    icon.Icon ? "cf-pin-icon" : "",
    opts.selected ? "is-selected" : "",
    opts.linksMap ? "is-map" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const size = icon.Icon ? ICON_SIZE : DOT_SIZE;
  return {
    html: `<div class="${classes}" style="--pin:${color}">${iconSvg(icon)}</div>`,
    size,
  };
}
