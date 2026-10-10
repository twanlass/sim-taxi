// Where a thumb counts as being on a pedal — the geometry half of "The pedal slide" in main.js,
// kept out of there so it can be tested without a page.
//
// The zones are bigger than the buttons. Each pedal's rectangle is grown by `reach` on every side
// a thumb can come at it from, and the two facing edges are pulled in to meet a `deadband` either
// side of the middle of the gap between them. Tyler (2026-10-08), drifting one-thumbed — Loco, slide
// left to tag the brake, slide back — had the thumb slip on the way back and the car stop. With the
// zones at the buttons' own edges, a thumb that came back short of the gas sat in the 22px gap,
// which is inside the brake's slop, so the brake stayed down and stopped the car mid-drift; one
// that arced over the gas's top let go of both. A thumb's contact point is not where its pad is,
// and a thumb sliding on glass does not come back along the line it went out on.
//
// The deadband is the hysteresis that used to be the whole gap. A resting thumb straddling a single
// boundary would flip pedals on a pixel of jitter, and a flip is not quiet: brake, Loco, brake inside
// 350ms is a U-turn (BOOTLEG_GAP_MS), and every Loco press fires a wheelie and a flame. So in the
// band between the two zones the thumb keeps whichever pedal it already had.
//
// The same numbers size the buttons' `::before` in index.html, which is what makes the first press
// land on the grown zone too — `--pedal-reach` and `--pedal-deadband`, read back by main.js so the
// two cannot drift apart.

/** How far the thumb can be from a pedal it has claimed, measured from its *zone*, and keep it. */
export const PEDAL_SLOP = 16;

/**
 * Grow each rectangle into its zone. `rects` are DOMRect-likes in any order; the result is in the
 * same order. Every pair of neighbours is clipped to the middle of the gap between them less half
 * the deadband, never inside its own rectangle, so two zones can never overlap — across the gap
 * when the two sit side by side (the row), down it when one is stacked over the other (the stacked
 * layout, `?pedals=left|right`, where the brake hangs under Loco).
 */
export function pedalZones(rects, reach, deadband) {
  const zones = rects.map((r) => ({
    left: r.left - reach, right: r.right + reach, top: r.top - reach, bottom: r.bottom + reach,
  }));
  // `lo` is the side of the gap nearer the origin: left of it, or above it.
  const clip = (a, b, lo, hi) => {
    const mid = (rects[a][hi] + rects[b][lo]) / 2;
    zones[a][hi] = Math.max(rects[a][hi], Math.min(zones[a][hi], mid - deadband / 2));
    zones[b][lo] = Math.min(rects[b][lo], Math.max(zones[b][lo], mid + deadband / 2));
  };
  for (let a = 0; a < rects.length; a++) {
    for (let b = 0; b < rects.length; b++) {
      if (a === b) continue;
      if (rects[a].right <= rects[b].left) clip(a, b, 'left', 'right');
      else if (rects[a].bottom <= rects[b].top) clip(a, b, 'top', 'bottom');
    }
  }
  return zones;
}

/** Index of the zone the point is inside, or -1. */
export function zoneAt(zones, x, y) {
  return zones.findIndex((z) => x >= z.left && x <= z.right && y >= z.top && y <= z.bottom);
}

/** Distance from the point to a zone, in CSS px. Zero anywhere inside it. */
export function zoneDistance(zone, x, y) {
  return Math.hypot(
    Math.max(zone.left - x, 0, x - zone.right),
    Math.max(zone.top - y, 0, y - zone.bottom),
  );
}

/**
 * Which pedal the thumb is on after a move: inside a zone, that one outright (the handover);
 * outside every zone, the one already claimed until the thumb is PEDAL_SLOP clear of it; then none.
 * `current` and the answer are indices, -1 for none.
 */
export function pedalAfterMove(zones, current, x, y) {
  const inside = zoneAt(zones, x, y);
  if (inside >= 0) return inside;
  if (current >= 0 && zoneDistance(zones[current], x, y) <= PEDAL_SLOP) return current;
  return -1;
}
