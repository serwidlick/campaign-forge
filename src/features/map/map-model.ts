/**
 * A map is an element of kind `map`. Its image lives under `assets/maps/` in
 * the campaign folder and its structure lives in frontmatter:
 *
 *   image:  assets/maps/sword-coast.png
 *   width:  4096           (pixels)
 *   height: 3072
 *   fit:    contain        (how the image is framed when opened)
 *   scale:  { pixels: 512, distance: 100, unit: miles }
 *   pins:   [{ id, x, y, label, element }]      (x, y in image pixels, top-left origin)
 *   routes: [{ id, name, color, points: [{ x, y }] }]
 *   territories: [{ id, name, color, element, points: [{ x, y }] }]
 *
 * A pin or territory linked to another map nests that map inside this one.
 */
import type { ElementSummary } from "@/lib/types";

export interface Point {
  x: number;
  y: number;
}

export interface MapPin extends Point {
  id: string;
  label: string;
  /** Linked element id, if any. */
  element: string | null;
}

export interface MapRoute {
  id: string;
  name: string;
  color: string;
  points: Point[];
}

/** A named area: a faction's reach, a kingdom, a forest. Closed polygon. */
export interface MapTerritory {
  id: string;
  name: string;
  color: string;
  /** Linked element id (usually a faction or location), if any. */
  element: string | null;
  points: Point[];
}

export interface MapScale {
  /** This many image pixels... */
  pixels: number;
  /** ...span this much distance... */
  distance: number;
  /** ...in this unit (free text: miles, km, leagues). */
  unit: string;
}

export type FitMode = "contain" | "cover" | "width" | "height" | "actual";

export const FIT_MODES: { id: FitMode; label: string }[] = [
  { id: "contain", label: "Fit" },
  { id: "cover", label: "Fill" },
  { id: "width", label: "Fit width" },
  { id: "height", label: "Fit height" },
  { id: "actual", label: "Actual size" },
];

export interface MapData {
  image: string | null;
  width: number | null;
  height: number | null;
  fit: FitMode;
  scale: MapScale | null;
  pins: MapPin[];
  routes: MapRoute[];
  territories: MapTerritory[];
}

export const ROUTE_COLORS = [
  "#e69a57",
  "#7dd3fc",
  "#86efac",
  "#f9a8d4",
  "#c4b5fd",
  "#fde68a",
];

export const TERRITORY_COLORS = [
  "#ef6b6b",
  "#5aa9e6",
  "#6fcf8a",
  "#c084fc",
  "#f2c14e",
  "#f08a4b",
  "#2dd4bf",
  "#f472b6",
];

/** Territories are usually a faction's or a realm's; then other maps. */
export const TERRITORY_LINK_KIND_ORDER = [
  "faction",
  "location",
  "map",
  "character",
  "creature",
  "event",
  "quest",
  "lore",
  "item",
  "arc",
  "session",
];

/**
 * Kinds in the order a pin is most likely to link to them. Locations first,
 * then other maps (a pin can open a sub-map), then the rest.
 */
export const PIN_LINK_KIND_ORDER = [
  "location",
  "map",
  "faction",
  "character",
  "creature",
  "item",
  "event",
  "quest",
  "lore",
  "arc",
  "session",
];

// ---- Parsing ----------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function point(v: unknown): Point | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const x = num(o.x);
  const y = num(o.y);
  return x === null || y === null ? null : { x, y };
}

export function readMap(e: Record<string, unknown>): MapData {
  const scaleRaw =
    e.scale && typeof e.scale === "object"
      ? (e.scale as Record<string, unknown>)
      : null;
  const pixels = num(scaleRaw?.pixels);
  const distance = num(scaleRaw?.distance);
  const scale =
    pixels && distance && pixels > 0 && distance > 0
      ? { pixels, distance, unit: str(scaleRaw?.unit) ?? "miles" }
      : null;

  const pins: MapPin[] = Array.isArray(e.pins)
    ? e.pins.flatMap((p) => {
        const pt = point(p);
        if (!pt) return [];
        const o = p as Record<string, unknown>;
        return [
          {
            ...pt,
            id: str(o.id) ?? newId(),
            label: typeof o.label === "string" ? o.label : "",
            element: str(o.element),
          },
        ];
      })
    : [];

  const routes: MapRoute[] = Array.isArray(e.routes)
    ? e.routes.flatMap((r, i) => {
        if (!r || typeof r !== "object") return [];
        const o = r as Record<string, unknown>;
        const points = Array.isArray(o.points)
          ? o.points.map(point).filter((p): p is Point => p !== null)
          : [];
        return [
          {
            id: str(o.id) ?? newId(),
            name: str(o.name) ?? `Route ${i + 1}`,
            color: str(o.color) ?? routeColor(i),
            points,
          },
        ];
      })
    : [];

  const territories: MapTerritory[] = Array.isArray(e.territories)
    ? e.territories.flatMap((t, i) => {
        if (!t || typeof t !== "object") return [];
        const o = t as Record<string, unknown>;
        const points = Array.isArray(o.points)
          ? o.points.map(point).filter((p): p is Point => p !== null)
          : [];
        return [
          {
            id: str(o.id) ?? newId(),
            name: str(o.name) ?? `Territory ${i + 1}`,
            color: str(o.color) ?? territoryColor(i),
            element: str(o.element),
            points,
          },
        ];
      })
    : [];

  const fit = FIT_MODES.some((m) => m.id === e.fit)
    ? (e.fit as FitMode)
    : "contain";

  return {
    image: str(e.image),
    width: num(e.width),
    height: num(e.height),
    fit,
    scale,
    pins,
    routes,
    territories,
  };
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function routeColor(index: number): string {
  return ROUTE_COLORS[index % ROUTE_COLORS.length] ?? "#e69a57";
}

export function territoryColor(index: number): string {
  return TERRITORY_COLORS[index % TERRITORY_COLORS.length] ?? "#ef6b6b";
}

// ---- Geometry ----------------------------------------------------------

export function pixelDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pathPixelLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (prev && cur) total += pixelDistance(prev, cur);
  }
  return total;
}

/** Area of a closed polygon in square image pixels (shoelace formula). */
export function polygonPixelArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a && b) sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export interface RouteSnap {
  /** Nearest point on the route. */
  point: Point;
  /** Distance along the route from its start to `point`, in pixels. */
  along: number;
  /** Index of the segment's first vertex. */
  segment: number;
  /** Straight-line distance from the clicked point, in pixels. */
  offset: number;
}

/** Nearest point on a polyline to `c`, with its position along the line. */
export function snapToRoute(points: Point[], c: Point): RouteSnap | null {
  if (points.length === 0) return null;
  const first = points[0];
  if (!first) return null;
  if (points.length === 1) {
    return {
      point: first,
      along: 0,
      segment: 0,
      offset: pixelDistance(first, c),
    };
  }
  let best: RouteSnap | null = null;
  let cumulative = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2),
          );
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    const offset = pixelDistance(p, c);
    if (!best || offset < best.offset) {
      best = {
        point: p,
        along: cumulative + t * Math.sqrt(len2),
        segment: i,
        offset,
      };
    }
    cumulative += Math.sqrt(len2);
  }
  return best;
}

/** The part of a route between two snapped positions, as drawable points. */
export function routeSubPath(
  points: Point[],
  s1: RouteSnap,
  s2: RouteSnap,
): Point[] {
  const [from, to] = s1.along <= s2.along ? [s1, s2] : [s2, s1];
  return [
    from.point,
    ...points.slice(from.segment + 1, to.segment + 1),
    to.point,
  ];
}

// ---- Scale and formatting ---------------------------------------------

export function toDistance(pixels: number, scale: MapScale): number {
  return (pixels / scale.pixels) * scale.distance;
}

/** Square pixels to square map units. */
export function toArea(pixelArea: number, scale: MapScale): number {
  const perPixel = scale.distance / scale.pixels;
  return pixelArea * perPixel * perPixel;
}

export function formatArea(value: number, unit: string): string {
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString()} sq ${unit}`;
}

export function formatDistance(value: number, unit: string): string {
  const rounded =
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString()} ${unit}`;
}

/** Leaflet zoom (CRS.Simple, zoom 0 = 1 image px per screen px) for a fit mode. */
export function fitZoom(
  mode: FitMode,
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): number {
  if (imageWidth <= 0 || imageHeight <= 0) return 0;
  const sx = containerWidth / imageWidth;
  const sy = containerHeight / imageHeight;
  const scale =
    mode === "contain"
      ? Math.min(sx, sy)
      : mode === "cover"
        ? Math.max(sx, sy)
        : mode === "width"
          ? sx
          : mode === "height"
            ? sy
            : 1;
  return Math.log2(scale);
}

/** Display name for a pin: its label, else the linked element's name. */
export function pinName(pin: MapPin, elements: ElementSummary[]): string {
  if (pin.label.trim()) return pin.label;
  const linked = pin.element
    ? elements.find((e) => e.id === pin.element)
    : undefined;
  return linked?.name ?? "Unnamed pin";
}

/** Display name for a territory: its name, else the linked element's name. */
export function territoryName(
  t: MapTerritory,
  elements: ElementSummary[],
): string {
  if (t.name.trim()) return t.name;
  const linked = t.element
    ? elements.find((e) => e.id === t.element)
    : undefined;
  return linked?.name ?? "Unnamed territory";
}

// ---- Nesting -----------------------------------------------------------

export interface SubMapRef {
  /** What on this map leads to the sub-map. */
  via: "pin" | "territory";
  label: string;
  map: ElementSummary;
}

/** Maps reachable from this one through a pin or a territory. */
export function subMapsOf(
  data: MapData,
  elements: ElementSummary[],
): SubMapRef[] {
  const out: SubMapRef[] = [];
  const seen = new Set<string>();
  const mapById = (id: string | null) =>
    id ? elements.find((e) => e.id === id && e.type === "map") : undefined;
  for (const pin of data.pins) {
    const map = mapById(pin.element);
    if (!map || seen.has(map.id)) continue;
    seen.add(map.id);
    out.push({ via: "pin", label: pinName(pin, elements), map });
  }
  for (const t of data.territories) {
    const map = mapById(t.element);
    if (!map || seen.has(map.id)) continue;
    seen.add(map.id);
    out.push({ via: "territory", label: territoryName(t, elements), map });
  }
  return out;
}

/** Maps that contain this one through a pin or a territory. */
export function parentMapsOf(
  mapId: string,
  elements: ElementSummary[],
): ElementSummary[] {
  return elements.filter((e) => {
    if (e.type !== "map" || e.id === mapId) return false;
    const d = readMap(e);
    return (
      d.pins.some((p) => p.element === mapId) ||
      d.territories.some((t) => t.element === mapId)
    );
  });
}

/** Pulls an image URL out of a browser drag, if there is one. */
export function imageUrlFromDrag(dt: DataTransfer): string | null {
  const uriList = dt.getData("text/uri-list");
  const fromList = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (fromList && /^https?:\/\//i.test(fromList)) return fromList;

  const html = dt.getData("text/html");
  const img = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  if (img && /^https?:\/\//i.test(img)) return img;

  const text = dt.getData("text/plain").trim();
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  return null;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}
