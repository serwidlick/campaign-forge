/**
 * Where a person's card goes: beside their bubble, on the side away from
 * the edge the bubbles are docked to, kept inside the free area. On a
 * narrow screen it is a sheet across the bottom (or the top, when the
 * bubbles sit at the bottom). Pure, so tested.
 */

/** Space between the bubble and the card, and the card and the edges. */
export const CARD_GAP = 12;
/** Below this width the card becomes a sheet. */
export const SHEET_BELOW = 520;

function clamp(n, min, max) {
  return Math.max(min, Math.min(n, Math.max(min, max)));
}

/**
 * `area` is `{ left, top, right, bottom, width, height }`, `bubble` the
 * bubble's rect, `side` the docked edge and `size` the card's natural
 * `{ width, height }`. Returns `{ x, y, width, sheet, origin }`: where the
 * card's top-left goes, its width, whether it is a sheet, and the point it
 * grows from (the bubble's centre, relative to the card).
 */
export function placeCard(area, bubble, side, size) {
  const centre = {
    x: bubble.left + bubble.width / 2,
    y: bubble.top + bubble.height / 2,
  };
  if (area.width < SHEET_BELOW) {
    const width = Math.max(0, area.width - 2 * CARD_GAP);
    const height = Math.min(size.height, area.height - 2 * CARD_GAP);
    const x = area.left + CARD_GAP;
    const y =
      side === "bottom" ? area.top + CARD_GAP : area.bottom - CARD_GAP - height;
    return {
      x,
      y,
      width,
      sheet: true,
      origin: { x: centre.x - x, y: centre.y - y },
    };
  }
  const { width, height } = size;
  let x;
  let y;
  if (side === "right") {
    x = bubble.left - CARD_GAP - width;
    y = centre.y - height / 2;
  } else if (side === "top") {
    x = centre.x - width / 2;
    y = bubble.top + bubble.height + CARD_GAP;
  } else if (side === "bottom") {
    x = centre.x - width / 2;
    y = bubble.top - CARD_GAP - height;
  } else {
    x = bubble.left + bubble.width + CARD_GAP;
    y = centre.y - height / 2;
  }
  x = clamp(x, area.left + CARD_GAP, area.right - CARD_GAP - width);
  y = clamp(y, area.top + CARD_GAP, area.bottom - CARD_GAP - height);
  return {
    x,
    y,
    width,
    sheet: false,
    origin: { x: centre.x - x, y: centre.y - y },
  };
}
