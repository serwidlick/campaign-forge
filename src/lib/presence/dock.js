/**
 * Docking geometry for the bubbles: where a group of a given size sits on
 * an edge, and which edge a dropped group snaps to. Pure functions on plain
 * rectangles, so they are unit tested without a DOM.
 *
 * An area is `{ left, top, right, bottom, width, height }` (the free space
 * inside the safe-area padding). A spot is `{ side, t }`: the edge and how
 * far along it, 0 to 1.
 */

/** The edges, in the order arrow keys and ties resolve them. */
export const SIDES = Object.freeze(["left", "top", "right", "bottom"]);

/** On the left edge, a third of the way down, clear of most top bars. */
export const DEFAULT_SPOT = Object.freeze({ side: "left", t: 0.3 });

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Left and right stack the bubbles in a column; top and bottom in a row. */
export function isVertical(side) {
  return side === "left" || side === "right";
}

/** The top-left corner for a group of `size` at `spot`. */
export function placeOnEdge(area, spot, size) {
  const along = (start, room, extent) =>
    start + spot.t * Math.max(0, room - extent);
  switch (spot.side) {
    case "right":
      return {
        x: area.right - size.width,
        y: along(area.top, area.height, size.height),
      };
    case "top":
      return { x: along(area.left, area.width, size.width), y: area.top };
    case "bottom":
      return {
        x: along(area.left, area.width, size.width),
        y: area.bottom - size.height,
      };
    default:
      return { x: area.left, y: along(area.top, area.height, size.height) };
  }
}

/** Keeps a group of `size` with its corner at (x, y) inside the area. */
export function clampToArea(area, size, x, y) {
  return {
    x: clamp(x, area.left, Math.max(area.left, area.right - size.width)),
    y: clamp(y, area.top, Math.max(area.top, area.bottom - size.height)),
  };
}

/** The edge nearest a group's rectangle `{ x, y, width, height }`. */
export function nearestSide(area, rect) {
  const gaps = {
    left: rect.x - area.left,
    top: rect.y - area.top,
    right: area.right - (rect.x + rect.width),
    bottom: area.bottom - (rect.y + rect.height),
  };
  return SIDES.reduce((best, side) => (gaps[side] < gaps[best] ? side : best));
}

/**
 * Where a dropped group lands: the nearest edge, keeping its centre's place
 * along that edge. `sizeOn(side)` gives the group's size laid out for an
 * edge, which differs between a column and a row.
 */
export function snapToEdge(area, rect, sizeOn) {
  const side = nearestSide(area, rect);
  const size = sizeOn(side);
  const fraction = (centre, start, room, extent) =>
    room > extent
      ? clamp((centre - extent / 2 - start) / (room - extent), 0, 1)
      : 0;
  const t = isVertical(side)
    ? fraction(rect.y + rect.height / 2, area.top, area.height, size.height)
    : fraction(rect.x + rect.width / 2, area.left, area.width, size.width);
  return { side, t };
}
