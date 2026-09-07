import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';
import {
  DIR, GRID_I, GRID_J, HALF_ROAD, LANE, isSegmentClosed, junctionReach, lineX, lineZ,
} from './grid.js';

// The taxi's garage: a single-storey depot with a roller door on the street, and the one building
// in the city the tower generator doesn't draw. It exists for the opening vignette
// (game/opening.js) — the camera comes down onto the door, the door goes up, and the player's car
// drives out of it — so everything here is arranged around one shot from one fixed camera.
//
// **PROTOTYPE.** Three things are hard-coded that a finished version would probably decide per
// city, and each is called out where it lands: the door always faces **+X**, the depot always
// takes a **whole block**, and the exit is always a **right turn** into the near lane.
//
// Why +X and not a side chosen per seed: the camera looks down the +X+Z diagonal and never
// rotates, so only two of a building's four faces are ever visible at all. Of those two, +X is the
// one whose sightline to the camera leaves the block over the *road* rather than over the
// neighbouring block — see `occlusionClear` below, which is the whole of the site filter and the
// only part of this file that is subtle.

// --- The building, in block-local terms -------------------------------------
// All of these are measured off the block's own bounds, so the depot is the same building wherever
// it lands.

// Forecourt: kerb back to the building's street face. The generated city gives a lot 0.85 units of
// pavement, which is not a driveway — a car pulling out of a door that close to the kerb is over
// the lip before it has straightened up. Three units is enough apron to read as a forecourt and to
// give the drive-out a beat on the pavement before the drop.
const APRON = 3.0;
const SIDE_INSET = 0.9;          // setback off the block's other three edges
const HEIGHT = 5.0;              // parapet line
const DOOR_W = 5.4;
const DOOR_H = 3.4;
// How far the bay is sunk into the mass. Sized off the car that has to fit in it: the *drawn*
// taxi is 4.01 units long (CAR_LEN through TAXI_SCALE — see the note on `parkedX` in
// game/opening.js), and it parks with its nose clear of the shut door, so the bay needs that plus
// the recess plus somewhere to put the back bumper.
const BAY_D = 5.2;
const RECESS = 0.3;              // the curtain plane, behind the street face

// The door's centre, measured from the block's **−Z** edge rather than from its middle. This is
// the placement `occlusionClear` depends on: the sightline from the door to the camera runs +X+Z,
// so a door near the −Z end of the block has 7.8 units of z to spend before it crosses the block's
// far edge — and 7.8 units of x buys it, which is inside the 8-unit road. Centre the door and the
// line leaves over the *next block along* instead, where a tower can stand in front of it.
const DOOR_OFF = 4.5;

// Slat pitch on the curtain. Nine over the opening puts a shadow line every 0.36 units, which at
// play zoom is under three pixels and reads as texture — but the vignette watches this door at
// zoom 15, where it is nine distinct slats winding away.
const SLATS = 9;
const RAIL_H = 0.16;             // the bottom rail: the leading edge the eye tracks

// --- The livery -------------------------------------------------------------
// The depot is painted in the company's colours: the envelope itself is `garageWall` yellow (see
// palette.js, which carries the audit for spending that much of the taxi's own colour on a
// building), and one chequer course runs under the parapet on the two elevations this camera can
// ever see.
//
// The chequer is **boxes standing off the wall**, not a colour baked into the wall's own vertices,
// and that is the coplanar rule rather than laziness: a stripe painted onto a face is two surfaces
// on one plane, and an exact tie does not shimmer on the machine you are looking at (see
// CLAUDE.md). A tenth of a unit is also enough to catch the sun's own edge, so the course reads as
// painted metal screwed to a shed rather than as a decal.
const PAINT_PROUD = 0.1;
const CHECK_H = 0.46;
// How far the course hangs below the parapet line, and it is doing a job rather than being a
// margin. The coping is `garageTrim` dark and every other square in the chequer is nearly as dark
// — run the course flush under the coping and half of it merges into it. This leaves a reveal of
// the **wall** between the two, so the building's own yellow is what separates them. That is the
// same job the yellow band did while the wall was grey; on a yellow wall a yellow band is not a
// band, so the wall does it directly.
//
// **0.17 of it is spent before it shows**, which is why this is not the 0.30 it was first set to.
// The coping overhangs the paint by 0.08 and the wall by 0.18, and this camera looks *down* the
// sightline at 0.92 of rise per unit of x — so the coping's own lip hides the top `0.18 × 0.92` of
// everything under it. A 0.30 drop leaves 0.13 of visible wall, which at play zoom is one pixel.
const CHECK_DROP = 0.40;
// A square's target width. Each run is then divided into a whole number of squares of whatever
// width comes out nearest this, so a course ends flush on the corner rather than on a half of one
// — the two faces are different lengths and neither is a multiple of anything.
//
// **Wider than CHECK_H rather than equal to it**, which is the difference between a chequer that is
// square on the wall and one that is square in the frame. A face running along z is seen at 45° to
// the view, so its horizontal extent is foreshortened by about 1/√2 while its height is not: at
// 0.46 square the course drew as a row of narrow vertical bars. 0.62 across against 0.46 tall lands
// at 0.44 × 0.46 on screen.
const CHECK_SQ = 0.62;

// --- The radio mast ---------------------------------------------------------
// Dispatch has to reach the car somehow. A mast on the roof with a dish sweeping on it, which is
// the only moving part on this building other than the door itself.
//
// **Almost nothing here is placed by a literal.** The dish has been resized twice now, and both
// times the numbers that broke were the hand-tuned ones around it: where the crossbars sit under
// it, and how far in from the roof's edge the mast stands. Those are derived from the dish's own
// measured geometry below (`radioMast` takes the height to stay under; `createGarage` takes the
// radius it sweeps), so growing DISH_R again moves them rather than clipping through them.
const MAST_PLINTH = 0.16;
const WHIP_H = 0.8;              // the aerial above the dish
// The dish. 0.72 read as a pale smudge next to a mast that was darker than it, and this is double
// that — a 2.9-unit dish, about twenty pixels across at play zoom, which is a landmark rather than
// a detail.
const DISH_R = 1.44;
// The pole, above the plinth it is bolted to. Sized off the dish rather than chosen — it has two
// jobs and the dish sets both. Above: the head has to show past the dish's top, which reaches
// `1.36 · DISH_R / 1.44` over the dish's centre, or the whip appears to grow out of the rim.
// Below: the space between the plinth and the dish's underside has to hold two crossbars.
const MAST_H = 4.0;
// How far the dish is tipped off vertical. 0.95 rad is 54°, which points its face up steeply
// enough to read as a dish from a camera 33° above the horizon, and shallowly enough that its rim
// still draws as an ellipse rather than as a line.
const DISH_TILT = 0.95;
/**
 * How far off the mast's axis the dish orbits — derived, because at this size a fixed arm puts the
 * pole *through* the dish.
 *
 * The disc is tilted about the z axis, so its nearest point to the mast sits at
 * `DISH_ARM - DISH_R * cos(DISH_TILT)` — which at the arm this had while the dish was half the size
 * is 0.32 units on the **far** side of the pole. It has to be at least the pole's own radius out,
 * plus something to see daylight through.
 */
const DISH_ARM = DISH_R * Math.cos(DISH_TILT) + 0.26;
// Where up the mast it sits, as a fraction of MAST_H — the one number here still chosen by eye, and
// the two things it is squeezed between are checked rather than assumed: `radioMast` hangs the
// crossbars off the dish's measured underside, and the probe asserts the pole's head clears its top.
const DISH_AT = 0.58;
// What the crossbars keep between themselves and the dish sweeping over them.
const CROSSBAR_CLEAR = 0.28;
// And what the mast's whole orbit keeps between itself and the two things it must not reach: the
// roof's own edge, and the curtain plane every sightline out of the door starts on.
const MAST_STANDOFF = 0.4;

/**
 * How fast the dish sweeps, in radians a second — fourteen seconds a revolution.
 *
 * Slow, for the reason `SIGN_SPIN` is one building over: at play zoom this thing is about five
 * pixels across, and anything much past this stops reading as a radar and starts reading as a toy
 * being spun. It is only at the vignette's zoom that it is a dish at all.
 */
export const DISH_SPIN = 0.45;

// The block platform's walking surface — `createGround` lays the pavement one centimetre over the
// kerb box. A car standing on it rides this much higher than one on the road.
export const PAVEMENT_Y = KERB_H + 0.01;

// The forecourt asphalt's own top face, and the paint on it. Named off each other rather than
// nudged as literals, the way `city/burgerjoint.js` names its apron levels: two flat surfaces at
// the same height is a shimmer, not a touch, and the level anything standing on the forecourt
// wants is the one the forecourt itself lays.
const APRON_Y = PAVEMENT_Y + 0.01;
const PAINT_Y = APRON_Y + 0.015;
// How far back from the lip the dropped kerb starts falling — `dropKerb`'s own run, and therefore
// also where anything laid flat on the forecourt has to stop. One constant rather than two because
// the second copy is the one that drifts.
const KERB_RUN = 1.5;

/**
 * Can the camera actually see this block's +X face?
 *
 * The view never rotates, so this is one ray, computed rather than eyeballed. From a point on the
 * door the sightline runs (+1, +0.92, +1) per unit of x — see VIEW_DIR — and the question is
 * whether anything the city is about to build stands in it.
 *
 * Worked through once, from the bottom of the opening — the worst case, being the lowest — with
 * `DOOR_OFF` 4.5 and the door face 3 units back from the kerb:
 *
 *   - **The block straight across the road** (bi+1, bj) never occludes. The line leaves this
 *     block's z band after 7.5 units of x, which is still inside the 8-unit road, so it is already
 *     past that block in z before it reaches its façade.
 *   - **The diagonal block** (bi+1, bj+1) is the one that can. The line reaches its façade 16.35
 *     units of z out, by which point it is 15.4 units up — inside `buildTower`'s 16-unit ceiling.
 *     So the filter is on that block's *height*, and height comes from centrality: a ceiling of
 *     `5 + centrality * 11` clears the line whenever centrality is under 0.945, and 0.75 below
 *     leaves room for the top of the door as well as the bottom.
 *   - **Two blocks out** is safe on its own: the line is 20.7 units up by the far edge of
 *     (bi+1, bj+1), past `SKYLINE_CEILING`.
 *
 * A block on the eastern edge has no diagonal neighbour at all, which is why those pass for free.
 */
function occlusionClear(blocks, bi, bj) {
  if (bi + 1 > GRID_I - 1 || bj + 1 > GRID_J - 1) return true;  // nothing built out there
  const diagonal = blocks.find((b) => b.bi === bi + 1 && b.bj === bj + 1);
  if (!diagonal) return true;
  if (diagonal.type === 'park') return true;
  return diagonal.centrality < 0.75;
}

/**
 * Which block the depot takes, or null if this city has nowhere to put one.
 *
 * Null is a real answer and callers have to handle it: the vignette is a flourish, and a seed that
 * cannot host it should still open a playable run. `main.js` falls straight back to the old
 * opening.
 *
 * Called at the **end** of `createLayout`, after every other draw, so adding it cannot reshuffle a
 * single park, arterial or building — the generators downstream each run their own offset stream
 * and nothing in layout.js reads `rng` after this.
 */
export function chooseGarageBlock(rng, blocks) {
  const candidates = blocks.filter((b) => b.type === 'built'
    // A district block is half of a merged park; a lone pocket park is already excluded by `type`.
    && (b.districtId === null || b.districtId === undefined)
    // The road the door faces has to exist. A park district closes the road between its two
    // blocks, and a depot whose forecourt opens onto grass has nowhere to drive to.
    && !isSegmentClosed(b.bi + 1, b.bj, DIR.PZ)
    && occlusionClear(blocks, b.bi, b.bj));
  if (!candidates.length) return null;

  // Prefer somewhere off the outer ring: a depot in a corner puts the player's first fare — biased
  // to spawn near the taxi, see fares.js — out on the edge of the map with the whole city behind
  // it. Falls back to the full list rather than to nothing.
  const inner = candidates.filter((b) => b.bi > 0 && b.bj > 0 && b.bj < GRID_J - 1);
  return rng.pick(inner.length ? inner : candidates);
}

/**
 * Every number the vignette needs about a depot, derived from its block. Separate from the mesh so
 * `game/opening.js` can plan the drive-out without holding onto geometry.
 */
export function garageSite(block) {
  const { x0, z0, x1, z1 } = block.bounds;
  const frontX = x1 - APRON;
  const doorZ = z0 + DOOR_OFF;
  const curtainX = frontX - RECESS;
  // The kerb lip is the block's own +X bound: `blockBounds` stops where the road starts.
  const kerbX = x1;
  const laneX = lineX(block.bi + 1) - LANE;

  return {
    bi: block.bi,
    bj: block.bj,
    frontX,
    curtainX,
    doorZ,
    doorW: DOOR_W,
    doorH: DOOR_H,
    kerbX,
    laneX,
    // The back wall of the bay. Exported because the drive-out is planned against the door plane
    // and the probe checks the void is actually a void.
    bayX: frontX - BAY_D,
    exitZ: doorZ,
    // The fillet onto the lane, and it is not a free choice: the arc has to be tangent to the lane
    // it lands in *and* to the driveway it leaves, so its radius is exactly the gap between the
    // kerb and the near lane's centre. Which comes out at 2 — the same radius every right turn in
    // this city already uses (see `turnControl` in grid.js), so the manoeuvre reads as one of them.
    turnR: HALF_ROAD - LANE,
    // Where it hands back to the traffic model: the near lane on the road the door faces, running
    // +Z, approaching the junction at the far end of this block. Right-hand traffic puts that lane
    // nearest the kerb the taxi is pulling off, so the exit is a right turn.
    merge: {
      d: DIR.PZ,
      i: block.bi + 1,
      j: block.bj + 1,
      // `placeCar` counts back from the junction. The arc lands at `doorZ + turnR`; the lane's far
      // end stops one **crossing** road's reach short of the junction centre.
      //
      // `junctionReach` and not a hard-coded `HALF_ROAD`, for the reason `city/burgerjoint.js`
      // spells out at its own merge: that crossing road can be an arterial, and an arterial is a
      // third wider. This read `HALF_ROAD` until a depot happened to land on a block whose exit
      // junction is crossed by a main street, and then the vignette handed the taxi to the traffic
      // model 1.33 units from where the arc had just put it — a car twitching sideways on the one
      // frame the whole opening is built around.
      back: (lineZ(block.bj + 1) - junctionReach(DIR.PZ, block.bi + 1, block.bj + 1))
        - (doorZ + (HALF_ROAD - LANE)),
    },
    // The camera's subject: the middle of the opening, in three dimensions.
    focus: { x: curtainX, y: KERB_H + DOOR_H / 2, z: doorZ },
  };
}

function box(dx, dy, dz, x, base, z, col) {
  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(x, base + dy / 2, z);
  return bakeColor(geo, col);
}

/** A box between two corners, which is how every piece below is actually specified. */
function span(x0, x1, y0, y1, z0, z1, col) {
  return box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, y0, (z0 + z1) / 2, col);
}

/**
 * The chequer course, on one elevation.
 *
 * `axis` says which way the face runs — `'z'` for the +X elevation, `'x'` for the +Z one — and
 * `at` is the wall plane it stands off. Only those two faces get one: the camera never rotates,
 * so the other two are paint nobody will ever be shown.
 */
function livery(parts, axis, at, from, to, top) {
  const y1 = top - CHECK_DROP;
  const y0 = y1 - CHECK_H;
  // One helper so the loop below doesn't have to know which way round the world is.
  const face = (a, b, col) => (axis === 'z'
    ? span(at, at + PAINT_PROUD, y0, y1, a, b, col)
    : span(a, b, y0, y1, at, at + PAINT_PROUD, col));

  // A whole number of squares, so the course lands on the corner rather than halfway through one.
  const n = Math.max(4, Math.round((to - from) / CHECK_SQ));
  const sq = (to - from) / n;
  for (let k = 0; k < n; k++) {
    parts.push(face(from + k * sq, from + (k + 1) * sq,
      color(k % 2 ? 'garageWhite' : 'garageCheck')));
  }
}

/**
 * The mast, minus the dish — everything on it that doesn't turn, so it can ride in the shell's
 * merge and be lifted by the entrance wave like the rest of the building.
 *
 * @param foot   the top of the coping, which is what it stands on
 * @param under  the world height of the **lowest point of the dish**, measured off the built
 *               geometry rather than worked out here. The crossbars hang below it: the dish orbits,
 *               so it passes over them once a revolution and a clearance derived from a fraction of
 *               MAST_H holds only until somebody changes DISH_R. It has been changed twice.
 */
function radioMast(x, z, foot, under) {
  const trim = color('garageTrim');
  const parts = [box(0.6, MAST_PLINTH, 0.6, x, foot, z, trim)];
  const base = foot + MAST_PLINTH;

  const pole = new THREE.CylinderGeometry(0.11, 0.15, MAST_H, 6);
  pole.translate(x, base + MAST_H / 2, z);
  parts.push(bakeColor(pole, trim));

  // Two crossbars under the dish and a whip above it. A bare rod on a roof is a flagpole; these
  // are the whole of what says *communications* at a size where nothing else can. Crossed rather
  // than stacked on one axis, because this camera never rotates and a bar laid along the sightline
  // is a dot.
  const upper = under - CROSSBAR_CLEAR;
  parts.push(box(0.05, 0.05, 0.9, x, upper, z, trim));
  parts.push(box(1.1, 0.05, 0.05, x, base + (upper - base) * 0.5, z, trim));

  const whip = new THREE.CylinderGeometry(0.025, 0.05, WHIP_H, 4);
  whip.translate(x, base + MAST_H + WHIP_H / 2, z);
  parts.push(bakeColor(whip, color('pole')));

  return parts;
}

/**
 * The dish, in its pivot's own space.
 *
 * **The pivot stands at the mast's foot on the kerb, not at the mast's head**, and that is the one
 * subtle thing here. This is the only piece of the depot the entrance wave cannot reach — it turns,
 * and the wave's anchor is a *world* coordinate stamped into a vertex, which stops meaning anything
 * in a rotating object's local space — so it grows on the CPU instead, and all the CPU path owns is
 * `object.scale` (see `objects` in game/cityentry.js). The shader scales the shell about `KERB_H`;
 * a uniform scale about a pivot placed on `KERB_H` is that same arithmetic, so the dish rides up
 * the mast as the mast grows. Put the pivot at the mast's head and it would instead shrink toward a
 * point two seconds of animation away from where the mast actually is.
 *
 * @param dishY  the dish's height above the pivot, i.e. above `KERB_H`
 */
function dishGeometry(dishY) {
  // The arm, out along +X. The dish hangs off the end of it rather than sitting on the mast's own
  // axis, so the assembly **orbits**: a radar sweeps, it does not spin on the spot. Every dimension
  // below is a fraction of DISH_R, so the whole assembly is one number — at the 0.72 it was first
  // built at, each of these fractions is exactly the literal it replaced.
  const arm = DISH_R * 0.125;
  const parts = [box(DISH_ARM, arm, arm, DISH_ARM / 2, dishY - arm / 2, 0, color('garageTrim'))];

  // Built pointing straight up and tipped afterwards, so everything on the dish's own axis — the
  // strut, the feed at the end of it — can be placed by one number and then carried along.
  //
  // A shallow frustum rather than a bowl, and that is a winding decision rather than a triangle
  // budget. The face you look at on a bowl is its *inside*, and an inside is a back face — which
  // under `flatShading` takes its normal from a screen-space derivative and lights as though the
  // sun were behind it (docs/rendering.md, and the boats' wake in CLAUDE.md). A solid frustum has
  // no inside: the face pointed at the sky is its own front face.
  const face = [];
  const thick = DISH_R * 0.222;
  const dish = new THREE.CylinderGeometry(DISH_R, DISH_R * 0.4, thick, 12);
  dish.translate(0, thick / 2, 0);
  face.push(bakeColor(dish, color('garageWhite')));
  // The feed on its strut, standing off the face. A few pixels at play zoom, and the whole of what
  // makes the frustum read as a dish rather than as a drum.
  const reach = DISH_R * 0.611;
  const horn = DISH_R * 0.222;
  const strut = new THREE.CylinderGeometry(DISH_R * 0.049, DISH_R * 0.049, reach, 4);
  strut.translate(0, thick + reach / 2, 0);
  face.push(bakeColor(strut, color('garageTrim')));
  face.push(box(horn, horn, horn, 0, thick + reach - horn * 0.125, 0, color('garageTrim')));

  // Negative, so the dish's own +Y tips toward +X — away from the mast, out over the arm.
  for (const geo of face) {
    geo.rotateZ(-DISH_TILT);
    geo.translate(DISH_ARM, dishY, 0);
    parts.push(geo);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}

/**
 * The depot: two merged meshes, a light and a dish.
 *
 * Two meshes rather than one because the curtain moves and the shell does not. Both are stamped
 * with the same entrance anchor (see `stampEntry`), so the city's opening wave lifts the door with
 * its own building rather than leaving it hanging in the air. The light is unlit and outside the
 * wave, and the dish is outside it for a different reason — see `dishGeometry`.
 */
export function createGarage(block, rng) {
  const site = garageSite(block);
  const { x0, z0, z1 } = block.bounds;
  const { frontX, curtainX, doorZ, kerbX } = site;

  const bx0 = x0 + SIDE_INSET;
  const bz0 = z0 + SIDE_INSET;
  const bz1 = z1 - SIDE_INSET;
  const dz0 = doorZ - DOOR_W / 2;
  const dz1 = doorZ + DOOR_W / 2;
  const bayX = site.bayX;               // the back wall of the bay
  const base = KERB_H;
  const head = base + DOOR_H;           // the lintel: where the curtain winds away
  const top = base + HEIGHT;
  const deck = top + 0.34;              // the top of the coping, which the mast stands on

  // --- The mast's placement, worked out from the dish rather than chosen.
  //
  // The dish is built first because everything about the mast depends on how much room it takes.
  // Its height off the pole is the one free number; the rest — where the crossbars hang, and how
  // far in from the roof's edge the whole thing stands — comes off its measured bounds.
  const dishY = deck + MAST_PLINTH + MAST_H * DISH_AT;
  const dishGeo = dishGeometry(dishY - KERB_H);
  dishGeo.computeBoundingBox();

  // The radius it sweeps: the furthest any of its vertices gets from the pivot's own axis. Not
  // `boundingBox.max.x` — the box is measured in the dish's rest pose and the dish **turns**, so
  // its footprint is the circle that pose inscribes, and the disc is widest across its z axis
  // where the box is narrowest along x.
  const dp = dishGeo.attributes.position;
  let orbit = 0;
  for (let i = 0; i < dp.count; i++) orbit = Math.max(orbit, Math.hypot(dp.getX(i), dp.getZ(i)));

  // One standoff answers both of the things the mast must not reach, because they are the same
  // distance from two different planes. It has to keep its whole orbit **on the roof**, off the +Z
  // parapet; and it has to keep it **behind the curtain plane**, since every sightline out of the
  // opening starts there and runs +X — so anything wholly behind it cannot occlude the door at any
  // height, and anything past it can. `curtainX` is the tighter of the two on x, being 0.3 back
  // from the wall.
  const stand = orbit + MAST_STANDOFF;
  const mastX = curtainX - stand;
  const mastZ = bz1 - stand;

  const wall = jitterColor(color('garageWall'), rng, { l: 0.03 });
  const trim = color('garageTrim');
  const bay = color('garageBay');

  const parts = [
    // The mass, hollowed for the bay: a back slab, a wing either side of the opening, and a header
    // over it. Built as four solids rather than as one box with a hole because the faces lining
    // the void are then each some solid's *outward* face, and so front-facing from inside it —
    // a hole cut in a single box shows nothing but the sky behind the building.
    span(bx0, bayX, base, top, bz0, bz1, wall),
    span(bayX, frontX, base, top, bz0, dz0, wall),
    span(bayX, frontX, base, top, dz1, bz1, wall),
    span(bayX, frontX, head, top, dz0, dz1, wall),

    // Parapet cap. A one-storey box with a lid reads as a building; without it, as a crate.
    span(bx0 - 0.18, frontX + 0.18, top, top + 0.34, bz0 - 0.18, bz1 + 0.18, trim),

    // The bay lining. Sits a hair inside every surface it covers, so it wins the depth test
    // against the wall behind it rather than arguing with it — and every panel stops short of
    // `curtainX`, because a lining that reached the street face would cross the closed door and
    // show as a dark sliver up each edge of it.
    span(bayX + 0.02, curtainX - 0.12, PAVEMENT_Y - 0.01, PAVEMENT_Y + 0.01,
      dz0 + 0.03, dz1 - 0.03, bay),
    span(bayX + 0.02, bayX + 0.1, base, head - 0.05, dz0 + 0.03, dz1 - 0.03, bay),
    span(bayX + 0.02, curtainX - 0.12, base, head - 0.05, dz0 + 0.03, dz0 + 0.11, bay),
    span(bayX + 0.02, curtainX - 0.12, base, head - 0.05, dz1 - 0.11, dz1 - 0.03, bay),
    span(bayX + 0.02, curtainX - 0.12, head - 0.11, head - 0.05, dz0 + 0.03, dz1 - 0.03, bay),

    // Door frame: a post either side. There is no separate lintel — the drum below is the head of
    // the opening, and a second bar in the same place is two coincident faces to z-fight.
    span(frontX, frontX + 0.14, base, head, dz0 - 0.22, dz0, trim),
    span(frontX, frontX + 0.14, base, head, dz1, dz1 + 0.22, trim),

    // The drum the curtain winds onto. Decoration — the slats are clamped away at the lintel, so
    // nothing needs hiding — but it is the one part that says *roller* rather than *shutter*.
    span(curtainX - 0.25, frontX + 0.15, head - 0.08, head + 0.62, dz0 - 0.25, dz1 + 0.25, trim),

    // The forecourt: asphalt laid over the pavement from under the door out to the kerb, which is
    // what says "cars come out of here" on a block that is otherwise bare paving. It runs back to
    // where the bay floor stops, so the threshold is continuous.
    span(curtainX - 0.12, kerbX, PAVEMENT_Y - 0.01, APRON_Y, dz0 - 0.5, dz1 + 0.5,
      jitterColor(color('asphalt'), rng, { l: 0.02 })),

    // The other elevation. `+Z` is the second of the two faces this camera can ever see, and on a
    // one-storey box it is 8 × 5 units of nothing — which at the vignette's zoom is a quarter of
    // the frame. An office door and two windows are what a depot has besides the big hole, and
    // they are also the only thing on the building giving its height a human scale.
    span(bx0 + 1.0, bx0 + 1.9, base, base + 2.1, bz1, bz1 + 0.06, color('door')),
    span(bx0 + 0.82, bx0 + 2.08, base, base + 2.28, bz1, bz1 + 0.03, trim),
    span(bx0 + 3.0, bx0 + 4.6, base + 1.6, base + 2.9, bz1, bz1 + 0.05, color('shopfront')),
    span(bx0 + 5.2, bx0 + 6.8, base + 1.6, base + 2.9, bz1, bz1 + 0.05, color('shopfront')),

    // Rooftop plant, on top of the coping rather than under it. Same argument as the elevation
    // above: a flat lid reads as an unfinished box, and the city's own towers all carry some.
    //
    // Both are measured off the roof's **back** corner, because the mast owns the front one and
    // stands a whole dish-radius in from it. The small one used to be at (bx0 + 5.6, bz1 - 2.2) —
    // one offset from the back in x and one from the front in z — and the two placements only
    // stayed apart because an ordinary block is 12 wide. A block squeezed between two arterials is
    // 9.33, the mast walked into the box, and nothing in the geometry said so. Same corner for
    // both, and the probe measures the gap.
    box(1.6, 0.55, 1.2, bx0 + 1.4, deck, bz0 + 1.3, color('rooftop')),
    box(1.0, 0.42, 1.0, bx0 + 1.2, deck, bz0 + 3.4, color('rooftopIron')),

    dropKerb(kerbX, doorZ, rng),

    // The forecourt's own paint: two guide lines out of the bay, the way any yard marks the way out
    // of a shed. Laid *on* the asphalt rather than in it — see PAINT_Y, which exists so this cannot
    // be nudged onto the plane it is standing on.
    //
    // They stop at `KERB_RUN` short of the lip rather than running to it, because that is where the
    // dropped kerb starts falling away: a flat strip carried out over a ramp is buried in it at one
    // end and hanging over it at the other, and neither is a thing anybody painted.
    span(curtainX, kerbX - KERB_RUN, APRON_Y, PAINT_Y, dz0 + 0.35, dz0 + 0.63, color('garageSign')),
    span(curtainX, kerbX - KERB_RUN, APRON_Y, PAINT_Y, dz1 - 0.63, dz1 - 0.35, color('garageSign')),

    // The mast. Static, so it rides in the shell's merge and the entrance wave lifts it with the
    // building; only the dish is excluded from that, and only because it turns.
    ...radioMast(mastX, mastZ, deck, KERB_H + dishGeo.boundingBox.min.y),
  ];

  // The livery, on the two elevations this camera can ever see. The +X run takes the corner — it
  // runs PAINT_PROUD past `bz1` — so the +Z run can stop dead on the wall plane and the two meet
  // without either one burying a face inside the other.
  livery(parts, 'z', frontX, bz0, bz1 + PAINT_PROUD, top);
  livery(parts, 'x', bz1, bx0, frontX, top);

  // The entrance wave scales every vertex about its object's ground anchor. One anchor for the
  // whole depot — shell and curtain alike — so the building comes up as one object.
  const anchorX = (bx0 + frontX) / 2;
  const anchorZ = (bz0 + bz1) / 2;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);

  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'garage';

  // --- The curtain ----------------------------------------------------------
  const slatH = (DOOR_H - RAIL_H) / SLATS;
  const slats = [box(0.16, RAIL_H - 0.02, DOOR_W - 0.06, curtainX, base, doorZ,
    color('garageDoorRail'))];
  for (let k = 0; k < SLATS; k++) {
    slats.push(box(0.1, slatH - 0.045, DOOR_W - 0.1, curtainX,
      base + RAIL_H + k * slatH + 0.02, doorZ, color('garageDoor')));
  }
  slats.forEach(stampAll);
  const curtainGeo = mergeGeometries(slats, false);
  slats.forEach((s) => s.dispose());
  const curtain = new THREE.Mesh(curtainGeo, propMaterial());
  curtain.castShadow = true;
  curtain.name = 'garage-door';
  // The rest positions, kept so `setDoor` is a function of the open fraction rather than an
  // accumulating offset — a state machine that can be scrubbed, replayed and settled.
  const restY = Float32Array.from(curtainGeo.attributes.position.array);

  // --- The bay's strip light ------------------------------------------------
  // Unlit, because it is a light. Deliberately outside the entrance animation: the door is shut
  // while the city builds itself, so there is nothing for the wave to hide.
  const lightGeo = box(0.16, 0.08, DOOR_W - 1.6, curtainX - 1.3, head - 0.18, doorZ,
    color('garageLight'));
  const light = new THREE.Mesh(lightGeo, unlitMaterial({ vertexColors: true }));
  light.name = 'garage-light';

  // --- The dish -------------------------------------------------------------
  // Built at the top of this function, because the mast is placed off its bounds. Its own mesh and
  // its own pivot, for the reason the burger over the drive-through is one: it turns, and the
  // entrance wave cannot animate anything with a transform of its own. See `dishGeometry` for why
  // the pivot sits on the kerb rather than at the head of its mast.
  //
  // **Out of the AO lookup**, and that is the rule in `markOccluder` rather than a preference. It
  // refuses to put this mesh in the depth prepass and so does main.js — but *receiving* is the
  // default, so left alone the dish samples the occlusion of whatever is behind it on screen. What
  // is behind it is its own roof, and the crease where its own mast meets that roof: the shaded
  // dish came out with a soft dark blotch across it that moved with the camera and belonged to a
  // surface two units below. It is the river water's bug (see `propMaterial` in util/geo.js) with
  // an opaque surface instead of a transparent one, and it is louder here because the water at
  // least sampled something under itself.
  //
  // Nothing is lost by opting out. AO in this game is a contact darkening a world unit wide, and
  // the nearest thing to the dish is the roof it floats two units over.
  const dish = new THREE.Mesh(dishGeo, propMaterial({ ao: false }));
  dish.castShadow = true;
  dish.name = 'garage-dish';

  const dishPivot = new THREE.Group();
  dishPivot.name = 'garage-dish-pivot';
  dishPivot.position.set(mastX, KERB_H, mastZ);
  // Seeded rather than zero, the same as the burger's: shot mode ticks once and freezes, so a dish
  // that started square-on would be square-on in every screenshot of every city.
  dishPivot.rotation.y = rand * Math.PI * 2;
  dishPivot.add(dish);

  const group = new THREE.Group();
  group.add(shell, curtain, light, dishPivot);

  /**
   * Wind the curtain up. `open` is 0 (shut) to 1 (gone).
   *
   * The whole door is one mesh and one draw call, and the winding is a clamp: every vertex rises
   * by the same travel and stops dead at the lintel, so a slat reaching the top collapses to zero
   * height there and disappears. That *is* what winding onto a drum looks like at this scale, and
   * it costs a rewrite of 360 floats rather than a mesh per slat, a shader patch, or a second
   * depth material for each of the two depth passes.
   *
   * Normals are not recomputed and do not need to be: every material in this project is
   * `flatShading`, which takes its normal from a screen-space derivative and never reads the
   * attribute (see docs/rendering.md).
   */
  function setDoor(open) {
    const travel = THREE.MathUtils.clamp(open, 0, 1) * DOOR_H;
    const position = curtainGeo.attributes.position;
    const array = position.array;
    for (let i = 1; i < array.length; i += 3) array[i] = Math.min(restY[i] + travel, head);
    position.needsUpdate = true;
    // The curtain only ever shrinks upward inside its shut bounds, so the sphere computed at
    // construction stays valid and there is nothing to refresh.
  }

  /** Sweep the dish. One rotation and no state, so a paused frame simply stops being advanced. */
  function update(dt, spin = DISH_SPIN) {
    dishPivot.rotation.y += spin * dt;
  }

  return {
    site,
    group,
    shell,
    curtain,
    light,
    dish,
    dishPivot,
    update,
    /**
     * The two stamped meshes, for the entrance wave and for the AO prepass — and **not** the dish,
     * which is neither: the wave's vertex shader cannot reach a turning object, and a mesh whose
     * matrix changes every frame has no business writing into a screen-space occlusion buffer.
     */
    meshes: [shell, curtain],
    setDoor,
    /** ...so the dish grows on the CPU instead, on the shell's own delay. */
    entryObject: { object: dishPivot, x: anchorX, z: anchorZ, rand },
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(frontX - bx0, bz1 - bz0) / 2, rand },
  };
}

/**
 * The dropped kerb the taxi comes off.
 *
 * A rotated `BoxGeometry` rather than a hand-wound wedge, on purpose: this project has shipped a
 * ramp inside out once already (see CLAUDE.md), and a box that three wound itself cannot be wound
 * backwards by rotating it. The bulk of the box sinks under the road slab, which is opaque, so
 * only the sloped top and the two sides show.
 */
function dropKerb(kerbX, doorZ, rng) {
  // The slope, by its two endpoints: from a hair over the pavement KERB_RUN back from the lip, to a
  // hair under the road just past it.
  const ax = kerbX - KERB_RUN;
  const ay = PAVEMENT_Y + 0.02;
  const bx = kerbX + 0.1;
  const by = -0.02;
  const theta = Math.atan2(ay - by, bx - ax);
  const thickness = 0.5;

  const geo = new THREE.BoxGeometry(Math.hypot(bx - ax, ay - by), thickness, DOOR_W + 1.2);
  // Negative, so the box's own +x descends: (1, 0) rotates to (cos θ, −sin θ).
  geo.rotateZ(-theta);
  // Where the top face's centre has landed as a result, so the slope can be placed by its
  // endpoints rather than by trial and error.
  const cx = (thickness / 2) * Math.sin(theta);
  const cy = (thickness / 2) * Math.cos(theta);
  geo.translate((ax + bx) / 2 - cx, (ay + by) / 2 - cy, doorZ);
  return bakeColor(geo, jitterColor(color('kerb'), rng, { l: 0.02 }));
}
