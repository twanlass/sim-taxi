import {
  GRID_I, GRID_J, PITCH, HALF_SPAN_X, HALF_SPAN_Z, lineX, lineZ, halfRoadX, halfRoadZ,
  nextIntersection, opposite,
} from '../city/grid.js';

/**
 * Tap a street to send the route down it.
 *
 * The route band can already be dragged (game/pathdrag.js), and a package can be tapped to bend the
 * route through its pad (`divertToParcel` in main.js). This is the second of those for plain road:
 * a tap on a street next to the route re-plans the trip so that it drives that street, with the
 * same destination, the same fare and the same clock. It is the drag's decision without the drag's
 * aiming — on a phone the band is a fingertip wide and lies under the thumb that is trying to pull
 * it, and a tap on the street you want is the whole of what the player meant.
 *
 * What it answers to is **a street, not a junction** — `findRouteAlong` in game/route.js. The drag
 * snaps to junctions because a finger sliding across the map has to commit to *something* discrete;
 * a tap lands in the middle of a block and names the road it landed on, and a route through either
 * end of that road could touch the corner and turn away without using it.
 *
 * Everything else that can be tapped wins: the picker only hands a tap here when no rider, pin,
 * package, building or taxi was under it (see main.js), and a tap on a roof is not a tap on the
 * street behind it — the ray meets the ground a long way up-screen of the building it went through,
 * so the ground point is checked against the city's height field first (`sightlineClear`).
 *
 * Like the package tap, the street is **spent when it is planned**. Nothing remembers it, so the next
 * re-plan (a pickup, a drawbridge lifting, an overtake detour) is free to drop it. A standing
 * waypoint re-applied every frame is the shape that stalls the taxi — see the trap in CLAUDE.md.
 */

// How far past the kerb a tap still counts as on the street, in world units. At play zoom that is
// ~15px of pavement — a fingertip that lands half on the kerb still means the road — and it leaves
// most of an ordinary 12-unit block (8 of it) answering to nothing, so a tap on a building's
// forecourt does not quietly re-route the taxi.
export const STREET_SLOP = 2;

// How much longer than the direct route a tapped street may make the trip, in legs. Tyler asked for
// *adjacent* streets, and this is that word as a number: a street one block off to the side costs 2
// (out and back), the one past it 4. Anything dearer has stopped being a detour and become a lap of
// the city, which a tap two blocks from the route is far more likely to be a fumble than a plan.
// Deliberately tighter than the drag's `MAX_VIA_DETOUR` (6): a drag shows the detour growing under
// the finger before it is let go, and a tap takes it in one go.
export const STREET_TAP_MAX_DETOUR = 4;

/**
 * The block-long street under a ground point, as `{ a, b }` — its two junctions, `a` the lower — or
 * null if the point is not on a road. Whether the street is *drivable* (a park can have built over
 * it, the river cuts every line but the bridges) is the router's question, not this one's.
 *
 * Where two roads meet, the junction box is on both. The one whose centreline is closer wins, so a
 * tap a little way into an arm reads as that arm.
 */
export function streetAt(x, z) {
  const clampIdx = (v, half, top) => Math.min(top, Math.max(0, Math.round((v + half) / PITCH)));
  // Out to the outer kerb of the ring road, which is the edge of the drivable map.
  const reachX = STREET_SLOP + Math.max(halfRoadZ(0), halfRoadZ(GRID_I));
  const reachZ = STREET_SLOP + Math.max(halfRoadX(0), halfRoadX(GRID_J));
  if (Math.abs(x) > HALF_SPAN_X + reachX || Math.abs(z) > HALF_SPAN_Z + reachZ) return null;

  // A road running along X sits on a z line; one running along Z, on an x line.
  const j = clampIdx(z, HALF_SPAN_Z, GRID_J);
  const i = clampIdx(x, HALF_SPAN_X, GRID_I);
  const offX = Math.abs(z - lineZ(j));       // distance off the X road's centreline
  const offZ = Math.abs(x - lineX(i));       // distance off the Z road's centreline
  const onX = offX <= halfRoadX(j) + STREET_SLOP;
  const onZ = offZ <= halfRoadZ(i) + STREET_SLOP;
  if (!onX && !onZ) return null;

  const cell = (v, half, top) => Math.min(top - 1, Math.max(0, Math.floor((v + half) / PITCH)));
  if (onX && (!onZ || offX <= offZ)) {
    const i0 = cell(x, HALF_SPAN_X, GRID_I);
    return { a: { i: i0, j }, b: { i: i0 + 1, j } };
  }
  const j0 = cell(z, HALF_SPAN_Z, GRID_J);
  return { a: { i, j: j0 }, b: { i, j: j0 + 1 } };
}

const sameStreet = (s, p, q) => (
  (s.a.i === p.i && s.a.j === p.j && s.b.i === q.i && s.b.j === q.j)
  || (s.a.i === q.i && s.a.j === q.j && s.b.i === p.i && s.b.j === p.j)
);

/**
 * Does the plan already drive this street — including the block the car is on now? A tap on one it
 * does is a no-op: the band is already there, and a tap on the band is also the first half of the
 * drag's double-tap reset, which must not do anything on its own.
 *
 * @param from  `planOrigin(car)` — the junction the car next chooses at, and its heading
 * @param route the car's planned directions out of each junction from `from` on
 */
export function routeDrives(from, route, street) {
  const behind = nextIntersection(opposite(from.d), from.i, from.j);
  if (behind && sameStreet(street, behind, from)) return true;
  let at = { i: from.i, j: from.j };
  for (const d of route) {
    const next = nextIntersection(d, at.i, at.j);
    if (!next) return false;
    if (sameStreet(street, at, next)) return true;
    at = next;
  }
  return false;
}
