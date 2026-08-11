import { wrapAngle } from '../city/curves.js';
import { opposite } from '../city/grid.js';
import { RIGHT, UP } from './camera.js';

/**
 * Reading a swipe as a driving instruction.
 *
 * The pure half of the control scheme: screen-space pixels in, a grid direction out. No DOM and no
 * scene, so `tools/probe.mjs` can assert the mapping directly rather than inferring it from where a
 * car ended up. `game/swipe.js` is the half that owns the pointer events.
 *
 * ## The four directions are the four screen diagonals
 *
 * The camera never rotates, so the mapping is a constant. Projecting the grid's four directions
 * (`grid.js`: +X, +Z, -X, -Z) onto the view's screen basis lands them exactly 45 degrees off the
 * screen cardinals:
 *
 *        -Z (up-right)
 *   -X            +X
 *  (up-left)     (down-right)
 *        +Z (down-left)
 *
 * That reads as a design problem — the sector boundaries fall on straight up, down, left and right,
 * which is where a thumb naturally goes — and in practice it is not one, because **the roads are
 * drawn along those diagonals too**. The gesture is "swipe along the road you want", and the road
 * is right there under the finger. The boundary is handled anyway, below.
 */

// How far off a direction a swipe may land and still be read as that direction. Anything up to 45
// degrees is simply the nearest one; past that the swipe was aimed between two roads, and this is
// how much benefit of the doubt the *legal* neighbour gets before the gesture is refused outright.
// 60 leaves a 30-degree dead zone straight behind the car, which is what refuses a U-turn.
const MAX_SNAP = Math.PI / 3;

// Bearing of each grid direction in the xz-plane, indexed by direction. Matches `bearingOf` in
// curves.js: +X is 0 and a right turn is a positive delta.
const DIR_BEARING = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * A screen-space swipe as a bearing in the world's xz-plane.
 *
 * `dy` is in DOM coordinates, so it grows *downward* — hence the negation. The basis comes from
 * camera.js rather than being written out here: one set of numbers, used in both directions.
 */
function swipeBearing(dx, dy) {
  const x = RIGHT.x * dx + UP.x * -dy;
  const z = RIGHT.z * dx + UP.z * -dy;
  return Math.atan2(z, x);
}

/** The grid direction a swipe points most nearly at. Always one of the four. */
export function snapToDir(dx, dy) {
  const bearing = swipeBearing(dx, dy);
  let best = 0;
  let bestOff = Infinity;
  for (let d = 0; d < 4; d++) {
    const off = Math.abs(wrapAngle(bearing - DIR_BEARING[d]));
    if (off < bestOff) { bestOff = off; best = d; }
  }
  return best;
}

/**
 * Read a swipe against what the taxi is doing and where it is allowed to go.
 *
 * @param dx, dy    swipe delta in CSS pixels, DOM axes
 * @param heading   the taxi's current grid direction (`car.d`)
 * @param legalDirs directions that are actual exits at the junction the car will next choose at —
 *                  `legalDirsFrom(planOrigin(car))` in route.js. U-turns are already absent.
 * @returns `{kind: 'boost'}`, `{kind: 'turn', dir}` or `{kind: 'refused', dir}`, where `dir` on a
 *          refusal is the direction that was asked for and could not be given.
 *
 * **Boost is decided before legality.** Swiping the way the car is already pointing means "go
 * faster", and that is true at a T-junction where carrying straight on is not even an option.
 * Checking the exits first would have made Loco Mode silently unavailable on the approach to one.
 */
export function resolveSteer(dx, dy, heading, legalDirs) {
  const asked = snapToDir(dx, dy);
  if (asked === heading) return { kind: 'boost' };

  // Nothing behind the car. Not a legality test — it is the one direction the road network can
  // never express, so refusing it here keeps `route.js` out of a question it has no answer to.
  if (asked === opposite(heading)) return { kind: 'refused', dir: asked };

  const bearing = swipeBearing(dx, dy);
  // Ranked by angle, then walked, so a swipe that lands near a boundary resolves toward whichever
  // of the two neighbours is a road. Taking the nearest and testing it alone would refuse a
  // perfectly clear gesture for being two degrees the wrong side of a line the player cannot see.
  const ranked = [0, 1, 2, 3]
    .map((d) => ({ d, off: Math.abs(wrapAngle(bearing - DIR_BEARING[d])) }))
    .filter((c) => c.off <= MAX_SNAP)
    .sort((p, q) => p.off - q.off);

  for (const cand of ranked) {
    if (cand.d === heading) return { kind: 'boost' };
    if (legalDirs.includes(cand.d)) return { kind: 'turn', dir: cand.d };
  }
  return { kind: 'refused', dir: asked };
}
