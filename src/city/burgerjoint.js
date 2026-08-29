import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { arcCurve, lineCurve } from './curves.js';
import { KERB_H } from './ground.js';
import {
  DIR, GRID, LANE_TO_KERB, isSegmentClosed, junctionReach, lineCoord,
} from './grid.js';

// The city's one burger joint: a single-storey roadside restaurant with a drive-through lane
// wrapped round its street side, and a burger turning on a pole above the roof.
//
// It is the second building the tower generator doesn't draw (the first is the depot — see
// city/garage.js) and it is built the same way for the same reasons: it takes a whole block,
// because a drive-through needs an apron and a lot rather than a footprint inside one that
// `splitLot` is about to divide; and `null` is a real answer, because a city with nowhere to put
// one should still be a playable city.
//
// The lane here is geometry only. Which cars pull in, how long they sit at the window and how they
// get back onto the road is `game/drivethru.js`, which drives them along `site.path` below with
// `stageCar`/`releaseCar` — the same split the opening vignette uses to drive the taxi out of its
// garage (game/opening.js).
//
// **PROTOTYPE**, in the same three ways the depot is: the orientation is fixed rather than chosen
// per city, the joint always takes a whole block, and every manoeuvre at either end is a right
// turn. Each is called out where it lands.

// --- Which way it faces, and why none of it is a choice ----------------------
//
// The camera looks down the +X+Z diagonal and never rotates, so of a building's four faces only
// +X and +Z are ever visible, and of a *block's* four strips only those two are ever in front of
// the building rather than behind it. A drive-through nobody can see is a drive-through that may
// as well not run, so:
//
//   - the **building** sits against the block's −X−Z corner,
//   - the **lane** runs down the +X strip, in front of it,
//   - the **windows** face +X, out of the near flank, straight at the camera.
//
// The travel direction along that lane is not free either. Right-hand traffic puts the driver on
// the left of the car and a drive-through window is on the driver's side, so the lane has to run
// **−Z**, whose left-hand side is the building. Running it +Z reads just as well on paper — and
// puts every car nose-on to the camera — and serves every driver through their passenger's window.
//
// That fixes both ends. A car may only *leave* a road by turning right off the kerbside lane and
// may only *join* one by turning right into it: a left turn across oncoming traffic is a yielding
// problem this module has no business inventing. Which leaves exactly one pair of roads:
//
//   - **in** off the +Z-edge road, whose kerbside lane runs −X — a right turn into −Z, onto the
//     lane;
//   - **out** onto the +X-edge road, whose kerbside lane runs +Z — right off the lane onto a short
//     +X run across the near kerb, then right again onto the road. Two quarter turns rather than
//     one, and the reason is arithmetic rather than taste: see `EXIT_LIFT`.

/**
 * How fast the burger turns, in radians per second — one revolution every 17 seconds.
 *
 * Slow on purpose, and it stayed slow when the sign doubled in size. At forty pixels across it is
 * a thing you can actually read from play zoom rather than a warm dot, so the turn no longer has
 * to do the work of announcing it — and anything much past this stops reading as a sign that turns
 * and starts reading as a sign that is being spun.
 */
export const SIGN_SPIN = 0.37;

// --- The lot, in block-local terms ------------------------------------------
// Every number below is measured off the block's own bounds, so the joint is the same building
// wherever it lands. A block is not always 12 across: an arterial takes its extra third of width
// out of the blocks either side, so the narrowest a block gets is 10.67 (see grid.js). Everything
// here is sized to survive that, which is why `chooseBurgerBlock` has no size filter.

/** Drive lane centre, in from the block's +X kerb. */
const LANE_INSET = 3.0;
/** Half-width of the asphalt the lane is painted on. A car is 1.7 wide. */
const LANE_HALF = 1.7;
/**
 * Radius of all three quarter turns, and it is not a free choice: each has to be tangent to a lane
 * centre at one end and to a kerbside lane at the other, so the radius is exactly the gap between
 * a kerb and the lane nearest it. `LANE_TO_KERB` is that gap, and it is the *same* on an arterial
 * as on a side street — which is what makes one constant right for every site. It is also the
 * radius every right turn in this city already uses (`turnControl` in grid.js), so a car pulling
 * into the lot corners like a car pulling round a junction.
 */
const TURN_R = LANE_TO_KERB;

/**
 * How far above the block's −Z edge the lane turns out of the lot.
 *
 * The obvious exit is to run the lane down to the −Z kerb and turn right onto that road there,
 * which is one quarter turn instead of two. It does not survive being measured. That exit lands on
 * the −Z road at `laneX + TURN_R`, which with a lane 3 units off the +X kerb is **0.7 units short
 * of the junction** at the block's corner — past its own hold line before it can see the light, so
 * a car released there drives into cross traffic on a red, and ambient cars do not collide (see
 * sim/collisions.js), so it drives *through* it.
 *
 * Turning out through the +X kerb instead puts the merge on the road running along Z, where the
 * distance back to the junction is the whole depth of the block less this number — eight units on
 * the narrowest block there is, against a `STOP_SETBACK` of 3.4. So the lane leaves the lot early
 * and crosses the near kerb, and the joint keeps the −Z end of its block for the building.
 *
 * The floor is `TURN_R + RAMP_HALF`: the turn out of the lane loses a whole radius of z, and what
 * it lands on — a car on the run, and the dropped kerb it drives over — has to still be on the
 * block. A first pass at 2.6 put the ramp 1.1 units out into the road behind it, which the
 * bounding-box check in `tools/probe.mjs` is there to catch.
 */
const EXIT_LIFT = 3.4;

const SIDE_INSET = 0.9;          // the building, off the block's −X and −Z edges
const FRONT_INSET = 1.5;         // ...and back off its +Z edge, so it has a forecourt on the street
const BUILD_GAP = 1.8;           // lane centre to the building's +X face
const APRON_BACK = 0.2;          // the asphalt stops this far short of the block's −Z edge
/** Half-width of a dropped kerb. Wider than a car and narrower than the lane's own asphalt. */
const RAMP_HALF = 1.2;

// --- What lies on the ground, and in what order ------------------------------
//
// Three flat surfaces stack on this block, and the whole of the trap is that a flat surface has to
// sit at a *different* height from the one under it — coplanar is not "just touching", it is two
// polygons the depth buffer cannot separate, and it shows as the ground shimmering as the camera
// moves. The first cut of the apron had its top face at `KERB_H + 0.01`, which is exactly where
// `createGround` lays the block's pavement, and the lot flickered.
//
// So they are named rather than nudged, each measured off the one below it:
/** The block platform's walking surface, laid a centimetre over the kerb by `createGround`. */
const PAVEMENT_Y = KERB_H + 0.01;
/** The drive-through's asphalt over that. Exported: `game/drivethru.js` rides its cars on it. */
export const APRON_Y = PAVEMENT_Y + 0.02;
/** ...and the paint over the asphalt: the lane's edge line and its chevrons. */
const PAINT_Y = APRON_Y + 0.015;

const WALL_H = 3.4;              // eaves: the top of the street glazing
const BAND_H = 1.0;              // the coloured mansard over it
const HEIGHT = WALL_H + BAND_H;
const CAP_H = 0.12;              // the parapet cap on top of that
/** The parapet line the pole comes out of. Exported because the probe measures the sign off it. */
export const ROOF_Y = KERB_H + HEIGHT + CAP_H;
/**
 * The drive-through canopy: how high its soffit is over the pavement, and how far past the lane
 * centre it reaches. Neither is free, and they are the same constraint from two ends — the car
 * under it has to stay *visible from a camera that is above and behind it*.
 *
 * A car on the apron has its roof about 1.86 up. The sightline off that climbs 0.92 per unit of x
 * (`VIEW_RISE`), so at the canopy's outer edge it is at `1.86 + 0.92 · CANOPY_OUT` = 3.19, against
 * a soffit at `KERB_H + CANOPY_Y` = 3.45. It passes under the edge with a quarter of a unit to
 * spare and there is no canopy past that edge to meet — so the car at the window is in shade and
 * in shot, which is the whole point of putting a window there.
 *
 * The post under that edge has its own floor: it stands 1.35 off the lane centre against a car's
 * half-width of 0.85, so there is half a unit between the two. `tools/probe.mjs` sweeps every
 * vertex of this building against the car's envelope, which is what caught the first pass at 0.9.
 */
const CANOPY_Y = 3.1;
const CANOPY_OUT = 1.45;
const CANOPY_POST = 1.35;

const POLE_H = 3.6;              // parapet to the middle of the burger
/**
 * The burger's radius, and **the only size this sign has**: every thickness in `burgerGeometry` is
 * a fraction of it, so this one number scales the whole thing. Exported because the probe measures
 * against it.
 *
 * 1.9 makes the sign about 5.1 units across at its widest, which is forty pixels at play zoom —
 * about a car and a half. It came up from 0.95, where the thing was legible up close and a warm
 * dot from the framing the game is actually played in.
 */
export const BURGER_R = 1.9;

/**
 * How far the sign leans, and which way — and the direction is the surprising half.
 *
 * It leans **away** from the camera. That reads backwards and is not: this camera sits 33° above
 * the horizon, so the angle between a level burger's top face and the line to the eye is already
 * 57°, and tilting the top *toward* the viewer closes that angle and shows more **bun**. Leaning it
 * away opens the angle to 79° instead, which turns the stack side-on and puts the patty, the cheese
 * and the lettuce — the only parts that say what the thing is — square in front of the lens.
 *
 * The lean rides on the pivot rather than on the mesh, so the burger turns about its own tilted
 * axis and holds one three-quarter attitude all the way round instead of wobbling like a coin.
 */
export const SIGN_TILT = 0.38;                                     // 22°
const SIGN_TILT_AXIS = new THREE.Vector3(-1, 0, 1).normalize();    // horizontal, across the view

/**
 * Height gained per unit travelled along x, on the sightline from any point on the ground to this
 * camera. `VIEW_DIR` in game/camera.js is `(1, 0.92, 1)` normalised and this is that ratio,
 * written out rather than imported because `city/` does not import from `game/`.
 * `tools/probe.mjs` asserts the two agree, which is what stops a change to the camera silently
 * detuning the site filter below.
 */
export const VIEW_RISE = 0.92;

// --- Can the camera see the lane? --------------------------------------------
//
// This is the whole of the site filter and the only subtle part of this file. It is the question
// `occlusionClear` asks about the depot's door, asked along a whole lane rather than at one point
// — and it has to be asked, because the answer is routinely *no*. Every block in this city is
// eight units of road from the next, so a sightline leaving the ground has climbed only 7.4 units
// by the time it reaches the far façade, and downtown towers go to 16. That is the same arithmetic
// `game/sightline.js` records about the courier pads, and the reason two junctions in a typical
// city cannot hold one.
//
// The march is the cheap kind: the ray climbs monotonically, so the lowest it ever is inside a
// block's footprint is where it *enters*, and one height comparison per block settles it. Twenty
// five blocks by nine samples, once per city.

const SIGHT_SAMPLES = 9;
/**
 * Headroom the ray has to clear an occluder by. A car's roof is about 1.5 above the road, so a
 * lane whose *ground* is visible by a hair still shows all of everything driving down it; this
 * asks for most of that back, which costs a few candidate blocks and buys the cars themselves.
 */
const SIGHT_MARGIN = 1.2;

/**
 * The tallest thing the generators will put on a block, before they have put anything there.
 *
 * `buildTower` ceilings on centrality (`5 + centrality * 11`, buildings.js) and the parks' tallest
 * tree tops out a shade under 6 (`treeParts`, props.js). Both are predictions rather than
 * measurements, because the block has to be *chosen* before anything stands on it — the same bind
 * `chooseGarageBlock` is in, and the same way out of it.
 */
function ceilingOf(block) {
  if (block.type === 'park') return 6;
  if (block.type === 'garage' || block.type === 'burger') return KERB_H + HEIGHT + CAP_H;
  return 5 + block.centrality * 11;
}

function laneSeen(blocks, block, site) {
  for (let n = 0; n < SIGHT_SAMPLES; n++) {
    // Sampled over the part of the path that is in the lot. The two road ends are on the
    // carriageway, where the question is answered by whether the *road* is visible — and every
    // road in this city is, or half the traffic model would be invisible too.
    const s = site.enterS + (site.exitS - site.enterS) * (n / (SIGHT_SAMPLES - 1));
    const p = site.path.at(s);
    for (const other of blocks) {
      if (other === block) continue;               // the joint stands west of its own lane
      // The sightline leaves in +X and +Z and never comes back, so only blocks up-camera of the
      // sample can be in it.
      if (other.bounds.x1 <= p.x || other.bounds.z1 <= p.z) continue;
      // Where the ray is inside this block's footprint, as a range of travel along it. One unit of
      // travel is one unit of x *and* one of z, which is what turns a clip into two clamps.
      const enter = Math.max(other.bounds.x0 - p.x, other.bounds.z0 - p.z, 0);
      const leave = Math.min(other.bounds.x1 - p.x, other.bounds.z1 - p.z);
      if (leave <= enter) continue;                // the ray misses this block
      if (ceilingOf(other) + SIGHT_MARGIN > KERB_H + enter * VIEW_RISE) return false;
    }
  }
  return true;
}

/**
 * Which block the joint takes, or null if this city has nowhere to put one.
 *
 * Called at the very end of `createLayout`, after the depot and after every other draw, for the
 * reason stated there: the generators downstream each run their own offset stream, so a draw here
 * cannot reshuffle a park, an arterial or a tower.
 */
export function chooseBurgerBlock(rng, blocks) {
  const candidates = blocks.filter((b) => b.type === 'built'
    // Half of a merged park district is not a lot. The depot has already claimed its block by the
    // time this runs, and `type` covers that one — `chooseGarageBlock` sets it first.
    && (b.districtId === null || b.districtId === undefined)
    // Both roads the lane uses have to exist. A park district closes the road between its two
    // blocks, and a drive-through with no way in is a restaurant with a car park.
    && !isSegmentClosed(b.bi + 1, b.bj + 1, DIR.NX)
    && !isSegmentClosed(b.bi + 1, b.bj, DIR.PZ)
    && laneSeen(blocks, b, burgerSite(b)));
  if (!candidates.length) return null;

  // Prefer somewhere off the outer ring, the same way the depot does and for a related reason: the
  // joint is scenery you are meant to keep driving past, and a lot in a corner is one most runs
  // never go near.
  //
  // ...and off the top of the density curve, which is a preference the depot does not have and this
  // one earns twice over. A drive-through is a roadside building and downtown is where it least
  // belongs; and the block is one the tower generator no longer gets, so taking a *downtown* one
  // costs the skyline its tallest deck. That is not hypothetical — it is measured in
  // `tools/probe.mjs`, where the helicopter's pad is chosen from every flat deck in the city and
  // its low tail moved 5.79 → 5.45 over 192 cities when this module started taking a block at all.
  // `laneSeen` above already leans this way (a tall neighbour to the east hides the lane), but only
  // through the *neighbours*: without this the joint still landed on blocks of its own at
  // centrality 0.98.
  //
  // Each filter falls back to the pool it narrows rather than to nothing.
  const inner = candidates.filter((b) => b.bi > 0 && b.bi < GRID - 1 && b.bj > 0 && b.bj < GRID - 1);
  const pool = inner.length ? inner : candidates;
  const quiet = pool.filter((b) => b.centrality <= 0.6);
  return rng.pick(quiet.length ? quiet : pool);
}

/**
 * A chain of curves, arc-length parameterised end to end.
 *
 * `curves.js` offers lines and arcs and nothing that joins them, because the road network never
 * needs one — a lane is a single curve and a turn is a single Bézier. A drive-through is five
 * pieces, so this is the join: the same `at`/`tangentAt`/`length` shape, over a list.
 */
function chainCurves(curves) {
  const spans = [];
  let total = 0;
  for (const curve of curves) {
    spans.push({ curve, from: total });
    total += curve.length;
  }
  const spanAt = (s) => {
    for (let n = spans.length - 1; n > 0; n--) if (s >= spans[n].from) return spans[n];
    return spans[0];
  };
  const local = (s) => {
    const span = spanAt(s);
    return { span, u: Math.min(Math.max(s - span.from, 0), span.curve.length) };
  };
  return {
    total,
    at(s) { const { span, u } = local(s); return span.curve.at(u); },
    tangentAt(s) { const { span, u } = local(s); return span.curve.tangentAt(u); },
  };
}

/**
 * Every number the drive-through needs about a joint, derived from its block. Separate from the
 * mesh so `game/drivethru.js` can run the lane without holding onto geometry — and so the site
 * filter above can measure a candidate before anything has been built on it.
 */
export function burgerSite(block) {
  const { x0, z0, x1, z1 } = block.bounds;

  const laneX = x1 - LANE_INSET;          // the lane's centreline, running −Z
  const turnZ = z0 + EXIT_LIFT;           // where it turns out of the lot
  const exitZ = turnZ - TURN_R;           // the short +X run across the near kerb
  const kerbZ = z1;                       // the +Z kerb the lane comes in over
  const kerbX = x1;                       // the +X kerb it goes out over

  const wall = {
    x0: x0 + SIDE_INSET,
    x1: laneX - BUILD_GAP,
    z0: z0 + SIDE_INSET,
    z1: z1 - FRONT_INSET,
  };

  // Every arc below has its centre one radius to the *right* of the car all the way round, which
  // is what a right turn is — see the note at the top of this file for why all three are right
  // turns. The angles are the arcCurve convention: a point at angle `a` is `centre + r(cos a,
  // sin a)`, and a positive sweep runs anticlockwise in (x, z).
  //
  // In, off the +Z-edge road's −X lane, which sits LANE_TO_KERB beyond that kerb. −X to −Z, so the
  // centre lands on the kerb line one radius east of the lane.
  const entryArc = arcCurve({ x: laneX + TURN_R, z: kerbZ }, TURN_R, Math.PI / 2, Math.PI / 2);
  const run = lineCurve({ x: laneX, z: kerbZ }, { x: laneX, z: turnZ });
  // Out: −Z to +X, then the run to the kerb, then +X to +Z onto the road's near lane.
  const outArc = arcCurve({ x: laneX + TURN_R, z: turnZ }, TURN_R, Math.PI, Math.PI / 2);
  const cross = lineCurve({ x: laneX + TURN_R, z: exitZ }, { x: kerbX, z: exitZ });
  const mergeArc = arcCurve({ x: kerbX, z: exitZ + TURN_R }, TURN_R, -Math.PI / 2, Math.PI / 2);

  const path = chainCurves([entryArc, run, outArc, cross, mergeArc]);
  const enterS = entryArc.length;                                     // over the +Z kerb, into the lot
  const exitS = enterS + run.length + outArc.length + cross.length;   // over the +X kerb, leaving

  // The two stops. Cars come in at the +Z end and drive −Z, so they meet the menu board first and
  // the window second: the board sits far enough down that a car at it is off the entry arc and
  // straight, and the window far enough above the exit turn that a car at it is straight too.
  // The board sits far enough down that a car at it is off the entry arc and straight, and far
  // enough *up* that the panel on the wall beside it is still on a wall — the mass stops
  // `FRONT_INSET` short of the street kerb. The window sits above the exit turn by the same
  // argument from the other end.
  const orderZ = kerbZ - 2.6;
  const pickupZ = turnZ + 1.5;

  return {
    bi: block.bi,
    bj: block.bj,
    bounds: block.bounds,
    wall,
    apron: { x0: wall.x1, x1: kerbX, z0: z0 + APRON_BACK, z1: kerbZ },
    laneX,
    laneHalf: LANE_HALF,
    turnZ,
    exitZ,
    kerbX,
    kerbZ,
    turnR: TURN_R,
    orderZ,
    pickupZ,
    path,
    enterS,
    exitS,
    orderS: enterS + (kerbZ - orderZ),
    pickupS: enterS + (kerbZ - pickupZ),
    // Where a car waits for a gap before it commits to the road: the near end of the last arc,
    // which is the last point on the path still on the block.
    holdS: exitS,
    // Where a car is taken off the road...
    entry: entryArc.at(0),
    // ...and where it is put back on it.
    merge: {
      point: mergeArc.at(mergeArc.length),
      d: DIR.PZ,
      i: block.bi + 1,
      j: block.bj + 1,
      // `placeCar` counts back from the junction box. The lane the car lands on ends one crossing
      // road's reach short of the junction centre — `junctionReach` and not a hard-coded
      // half-road, because that crossing road can be an arterial and an arterial is a third wider.
      back: (lineCoord(block.bj + 1) - junctionReach(DIR.PZ, block.bi + 1, block.bj + 1)) - turnZ,
    },
    // The review framing's subject: the middle of the lane, at a car's roofline.
    focus: { x: laneX, y: KERB_H + 1.4, z: (kerbZ + turnZ) / 2 },
    // And where the sign turns, which is the other thing worth pointing a camera at.
    signAt: {
      x: wall.x1 - 1.3,
      z: wall.z1 - 1.5,
      y: ROOF_Y + POLE_H,
    },
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
 * The dropped kerb a lane crosses, as a rotated box.
 *
 * A `BoxGeometry` rather than a hand-wound wedge, for the reason city/garage.js gives at length:
 * this project has shipped a ramp inside out once already, and a box three wound itself cannot be
 * wound backwards by rotating it. The bulk of it sinks under the road slab, which is opaque, so
 * only the sloped top and the two sides show.
 *
 * @param axis  'x' or 'z' — which coordinate the ramp descends along
 * @param lip   the kerb line on that axis
 * @param sign  +1 if the road is on the far side of the lip, −1 if it is on the near side
 * @param from  on the *other* axis: where the ramp starts...
 * @param to    ...and where it ends
 */
function dropKerb(axis, lip, sign, from, to, rng) {
  // The slope by its two endpoints: from a hair over the *apron* 1.5 units back from the lip, to a
  // hair under the road just past it. Over the apron and not the pavement — the ramp is what the
  // lot's asphalt runs off, so a ramp starting at the pavement would surface below its own lane.
  const highAt = lip - sign * 1.5;
  const highY = APRON_Y + 0.02;
  const lowAt = lip + sign * 0.1;
  const lowY = -0.02;
  const runLen = Math.hypot(lowAt - highAt, highY - lowY);
  const theta = Math.atan2(highY - lowY, Math.abs(lowAt - highAt));
  const thickness = 0.5;
  const width = to - from;

  const geo = axis === 'x'
    ? new THREE.BoxGeometry(runLen, thickness, width)
    : new THREE.BoxGeometry(width, thickness, runLen);
  // In both cases the box's own axis has to descend *toward the road*, and rotateZ and rotateX
  // turn opposite ways about the axis each leaves alone — hence the sign flip between them.
  if (axis === 'x') geo.rotateZ(-sign * theta);
  else geo.rotateX(sign * theta);

  // Where the top face's centre has landed as a result, so the slope can be placed by its
  // endpoints rather than by trial and error.
  const drop = (thickness / 2) * Math.cos(theta);
  const shift = (thickness / 2) * Math.sin(theta) * sign;
  const mid = (highAt + lowAt) / 2;
  const y = (highY + lowY) / 2 - drop;
  if (axis === 'x') geo.translate(mid - shift, y, (from + to) / 2);
  else geo.translate((from + to) / 2, y, mid - shift);
  return bakeColor(geo, jitterColor(color('kerb'), rng, { l: 0.02 }));
}

// One chevron on the lane: two bars meeting at a point, aimed the way the traffic runs (−Z).
const CHEV_HALF = 0.9;      // half the span across the lane
const CHEV_DROP = 0.62;     // how far the apex leads the wings

function chevron(x, z, col) {
  const len = Math.hypot(CHEV_HALF, CHEV_DROP);
  const phi = Math.atan2(CHEV_DROP, CHEV_HALF);
  const parts = [];
  for (const side of [-1, 1]) {
    const geo = new THREE.BoxGeometry(len, PAINT_Y - APRON_Y, 0.2);
    // rotateY(-phi) sends +X to (cos phi, 0, sin phi), so each bar runs from the shared apex at
    // (x, z) out to its own wing at (x ± CHEV_HALF, z + CHEV_DROP).
    geo.rotateY(-side * phi);
    geo.translate(x + side * CHEV_HALF / 2, (APRON_Y + PAINT_Y) / 2, z + CHEV_DROP / 2);
    parts.push(bakeColor(geo, col));
  }
  return parts;
}

/**
 * The burger, as its own geometry about its own origin.
 *
 * Built centred rather than in world space because it is the one part of this building that
 * **moves**: it turns about its own Y axis, which is only a rotation of the object if the object's
 * origin is on that axis. That is also why it stays out of the merged shell and out of the city's
 * entrance wave — the wave is a vertex shader that scales about a *world* anchor stamped into the
 * geometry (`stampEntry` in util/geo.js), and a world coordinate in a rotating object's local
 * space is not a coordinate at all. `createCityEntry` grows it as an `objects` entry instead, on
 * the CPU, on the same curve and the same delay as the building under it.
 *
 * Five slices and a scatter of seeds, every one of them a cylinder or a box — which at twelve
 * radial segments under `flatShading` is what makes it read as a *toy* burger rather than as a
 * small photograph of lunch. The cheese is the only piece that is not round: a square slice turned
 * 45° so its corners come out past the patty, which is the single detail that says "cheeseburger"
 * rather than "bap".
 *
 * **Every dimension in here is a fraction of `BURGER_R`**, thicknesses included, so that constant
 * is the one place the sign's size lives and doubling it doubles the whole stack rather than
 * flattening it into a pancake.
 */
export function burgerGeometry() {
  const parts = [];
  const R = BURGER_R;
  const disc = (rTop, rBottom, h, y, col) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, 12);
    geo.translate(0, y + h / 2, 0);
    return bakeColor(geo, col);
  };

  // Stacked upward from zero and centred at the end — see the note by the return. It comes out
  // 1.36·R tall against 1.34·R of radius at the widest, so it is very nearly twice as wide as it is
  // tall: the proportion a burger is *drawn* in, rather than the proportion one is.
  //
  // The stack is deliberately **bottom-heavy**, and the fillings are deliberately **wider than the
  // crown**. Both come from the same fact about this camera: it looks down at 33°, so what it
  // mostly sees of a thing on a pole is the *top* of it — and the top of a burger is a bun, which
  // identifies nothing. What says burger is everything between the two halves, and from up here
  // that only reads as a ring of it standing out past the dome. So the dome came down to 0.90·R
  // and the lettuce and cheese went out to 1.20 and 1.34, which leaves a third of a unit of
  // annulus showing all the way round. A first pass had them at 1.06/1.15 against a 0.97 dome and
  // photographed as a tan blob with a green edge.
  let y = 0;
  parts.push(disc(R * 0.94, R * 0.82, R * 0.34, y, color('bunBase')));
  y += R * 0.34;
  parts.push(disc(R * 1.08, R * 1.08, R * 0.25, y, color('patty')));
  y += R * 0.25;

  // The cheese. Sized off the patty's *diameter* rather than its radius — a square of side 1.9·R
  // turned 45° has its corners 1.34·R out and its flats 0.95·R out, so it stands proud at four
  // points and tucks inside at four others, which is what a slice of cheese does.
  const cheese = new THREE.BoxGeometry(R * 1.9, R * 0.075, R * 1.9);
  cheese.rotateY(Math.PI / 4);
  cheese.translate(0, y + R * 0.0375, 0);
  parts.push(bakeColor(cheese, color('cheese')));
  y += R * 0.075;

  parts.push(disc(R * 1.20, R * 1.12, R * 0.14, y, color('lettuce')));
  y += R * 0.14;

  // The crown: a hemisphere squashed to 0.72 of its radius. A full one reads as a ball balanced on
  // a stack, and the whole silhouette has to stay wider than it is tall to be a burger at all.
  const dome = new THREE.SphereGeometry(R * 0.90, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.62, 1);
  dome.translate(0, y, 0);
  parts.push(bakeColor(dome, color('bunTop')));

  // Sesame. Five, and not a ring: an even ring reads as a machined pattern, and at play zoom these
  // are a pixel or two apiece whose whole job is to break the dome's silhouette. Each is placed by
  // its angle and how far out along the dome it sits, with the height that follows from both.
  const seeds = [[0.30, 0.9], [1.55, 0.55], [2.6, 0.95], [3.8, 0.4], [5.2, 0.75]];
  for (const [angle, out] of seeds) {
    const r = R * 0.90 * out;
    const h = Math.sqrt(Math.max(0, 1 - out * out)) * R * 0.90 * 0.62;
    const seed = new THREE.BoxGeometry(R * 0.18, R * 0.075, R * 0.105);
    seed.rotateY(-angle);
    seed.translate(Math.cos(angle) * r, y + h, Math.sin(angle) * r);
    parts.push(bakeColor(seed, color('sesame')));
  }

  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  // Dropped onto its own centre rather than started at a constant that has to be kept in step with
  // five slice thicknesses by hand. Being centred is the property the spin depends on — off-centre
  // it orbits the pole instead of turning on it — so it is computed rather than remembered, and
  // `tools/probe.mjs` asserts it against the mesh that actually got built.
  geo.computeBoundingBox();
  geo.translate(0, -(geo.boundingBox.min.y + geo.boundingBox.max.y) / 2, 0);
  geo.computeBoundingBox();
  return geo;
}

/**
 * The joint: three meshes, one of which turns.
 *
 * Three rather than one because they are three different materials' worth of thing. The shell
 * takes the sun; the window glow does not (`unlitMaterial` — it *is* a light, and a pale box
 * standing in its own shadow reads as grey paint, which is the argument `garageLight` makes); and
 * the burger moves. The first two are stamped with one entrance anchor so the city's opening wave
 * lifts them as a single building, and the third is grown beside them by `createCityEntry`'s
 * `objects` list — see `burgerGeometry` for why it cannot ride in the shader with them.
 */
export function createBurgerJoint(block, rng) {
  const site = burgerSite(block);
  const { wall, apron, laneX, kerbZ, kerbX, turnZ, exitZ, orderZ, pickupZ } = site;

  const base = KERB_H;
  const eaves = base + WALL_H;
  const top = base + HEIGHT;
  const roof = ROOF_Y;              // === top + CAP_H, and the one the sign is measured off

  const shellCol = jitterColor(color('burgerWall'), rng, { l: 0.02 });
  const band = color('burgerBand');
  const trim = color('burgerTrim');
  const glass = color('shopfront');
  const paint = color('laneMark');

  const parts = [
    // The apron: asphalt laid over the pavement from the building's near face out to both kerbs.
    // This is what says "cars come in here" on a block that is otherwise bare paving, and it is
    // one rectangle rather than a strip following the lane because a drive-through's lot *is* a
    // rectangle of tarmac with a lane painted on it.
    span(apron.x0, apron.x1, APRON_Y - 0.04, APRON_Y, apron.z0, apron.z1,
      jitterColor(color('asphalt'), rng, { l: 0.02 })),

    // The mass, the band round the top of it, and the cap on that. The band oversails the walls by
    // 0.2 on every side, which is the whole read of a mansard: a lid a size too big for the box
    // under it.
    span(wall.x0, wall.x1, base, eaves, wall.z0, wall.z1, shellCol),
    span(wall.x0 - 0.2, wall.x1 + 0.2, eaves, top, wall.z0 - 0.2, wall.z1 + 0.2, band),
    span(wall.x0 - 0.3, wall.x1 + 0.3, top, roof, wall.z0 - 0.3, wall.z1 + 0.3, trim),

    // The street elevation. `+Z` is the second of the two faces this camera can ever see, and it is
    // the one somebody would walk up to — so it gets the full-height glazing a restaurant has, a
    // door, and a canopy over the door.
    span(wall.x0 + 0.7, wall.x1 - 0.5, base + 0.5, eaves - 0.35, wall.z1, wall.z1 + 0.06, glass),
    span(wall.x0 + 0.6, wall.x0 + 1.5, base, base + 2.1, wall.z1 + 0.02, wall.z1 + 0.1,
      color('door')),
    span(wall.x0 + 0.45, wall.x0 + 1.65, base + 2.1, base + 2.24, wall.z1, wall.z1 + 0.75, band),

    // --- The drive-through elevation --------------------------------------
    // Everything on this face is aimed at a car standing in the lane, which is why both openings
    // are on it and nowhere else. Each piece sits *proud* of the wall rather than recessed into
    // it: the mass is one solid box, so there is no hole to line, and two coplanar faces a
    // hundredth apart is a z-fight rather than a window.
    //
    // A skirt stripe along the bottom, below everything else, so a five-by-nine blank flank has
    // something on it. Deliberately clear of the openings above — the window sill starts at 0.7.
    span(wall.x1, wall.x1 + 0.05, base + 0.25, base + 0.5, wall.z0 + 0.3, wall.z1 - 0.3, band),

    // The menu board, standing proud at the height of a driver's window. Wall-mounted rather than
    // free-standing on a post, and that is clearance rather than styling: the lane centre is 1.8
    // off the façade and the asphalt is 1.7 of that, so there is a tenth of a unit of ground
    // between the two and nothing can stand in it.
    span(wall.x1, wall.x1 + 0.28, base + 0.7, base + 2.5, orderZ - 0.85, orderZ + 0.85, trim),

    // The pickup window: a sill, a surround, and a canopy over the lane outside it. The canopy
    // stops `CANOPY_OUT` past the lane centre for a measured reason — a sightline leaving a car's
    // roof at 1.5 has climbed to 2.6 by the time it reaches that edge, still under the 2.9 soffit,
    // so the car at the window stays visible from this camera from under its own shade.
    span(wall.x1, wall.x1 + 0.02, base + 0.85, base + 2.35, pickupZ - 0.78, pickupZ + 0.78, trim),
    span(wall.x1, wall.x1 + 0.22, base + 0.7, base + 0.85, pickupZ - 0.9, pickupZ + 0.9, trim),
    span(wall.x1, laneX + CANOPY_OUT, base + CANOPY_Y, base + CANOPY_Y + 0.22,
      pickupZ - 1.7, pickupZ + 1.7, band),
    span(laneX + CANOPY_OUT - 0.18, laneX + CANOPY_OUT, base + CANOPY_Y - 0.3, base + CANOPY_Y,
      pickupZ - 1.7, pickupZ + 1.7, trim),
    // The one post holding the far edge of it up, at the back corner so it is not in a driver's way.
    box(0.2, base + CANOPY_Y - 0.3, 0.2, laneX + CANOPY_POST, 0, pickupZ + 1.55, trim),

    // The pole the sign turns on, and the plinth it comes out of. Both part of the shell and not
    // part of the sign: a pole that turned with the burger would be a barber's pole.
    box(0.9, 0.34, 0.9, site.signAt.x, roof, site.signAt.z, trim),
    box(0.4, POLE_H, 0.4, site.signAt.x, roof, site.signAt.z, trim),

    // Rooftop plant. Same argument the depot's makes: a flat lid reads as an unfinished box, and
    // every tower in this city carries some.
    box(1.3, 0.5, 0.9, wall.x0 + 1.4, roof, wall.z0 + 1.6, color('rooftop')),
    box(0.8, 0.36, 0.8, wall.x0 + 1.3, roof, wall.z0 + 3.4, color('rooftopIron')),

    // The two dropped kerbs the lane comes in and goes out over.
    dropKerb('z', kerbZ, 1, laneX - RAMP_HALF, laneX + RAMP_HALF, rng),
    dropKerb('x', kerbX, 1, exitZ - RAMP_HALF, exitZ + RAMP_HALF, rng),

    // Lane markings: one white edge line, on the building side only. A lane with an edge on both
    // sides reads as a road, and this is a lane inside a car park.
    span(laneX - LANE_HALF, laneX - LANE_HALF + 0.16, APRON_Y, PAINT_Y,
      turnZ + 0.4, kerbZ - 0.6, paint),
  ];

  // ...and three chevrons saying which way it runs.
  for (const at of [0.22, 0.5, 0.78]) {
    parts.push(...chevron(laneX, kerbZ - (kerbZ - turnZ) * at, paint));
  }

  // The entrance wave scales every vertex about its object's ground anchor. One anchor for the
  // whole joint — shell, glow and sign alike — so the building comes up as one object.
  const anchorX = (wall.x0 + wall.x1) / 2;
  const anchorZ = (wall.z0 + wall.z1) / 2;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);

  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'burger-joint';

  // --- What is lit ----------------------------------------------------------
  // The room behind the pickup window, and the panel on the menu board. Both stand a hair proud of
  // the piece of trim framing them, so each reads as a lit surface with a dark border rather than
  // as a decal.
  const glowParts = [
    span(wall.x1 + 0.02, wall.x1 + 0.04, base + 0.95, base + 2.25,
      pickupZ - 0.66, pickupZ + 0.66, color('burgerGlow')),
    span(wall.x1 + 0.28, wall.x1 + 0.30, base + 0.85, base + 2.35,
      orderZ - 0.7, orderZ + 0.7, color('burgerGlow')),
  ];
  glowParts.forEach(stampAll);
  const glow = new THREE.Mesh(mergeGeometries(glowParts, false),
    unlitMaterial({ vertexColors: true }));
  glowParts.forEach((p) => p.dispose());
  glow.name = 'burger-glow';

  // --- The sign -------------------------------------------------------------
  // Two objects, and the split is what lets the thing lean: the **pivot** carries the position and
  // the lean, and the **mesh** turns inside it about the pivot's own (tilted) Y. One object cannot
  // do both — `rotation.y` on a tilted mesh turns it about the *world* vertical, which sweeps the
  // burger round a cone and reads as a coin about to fall over.
  const sign = new THREE.Mesh(burgerGeometry(), propMaterial());
  sign.castShadow = true;
  sign.name = 'burger-sign';
  // Opened at a hashed angle rather than at zero, and that is not decoration: shot mode ticks the
  // world once and then freezes, so a sign that started square-on would be square-on in every
  // screenshot ever taken of it. Same class of trap as the ground discs that opened at scale 0
  // (see CLAUDE.md), with a cheaper fix — a burger has no wrong angle to be caught at.
  sign.rotation.y = rand * Math.PI * 2;

  const signPivot = new THREE.Group();
  signPivot.name = 'burger-sign-pivot';
  signPivot.position.set(site.signAt.x, site.signAt.y, site.signAt.z);
  signPivot.setRotationFromAxisAngle(SIGN_TILT_AXIS, SIGN_TILT);
  signPivot.add(sign);

  const group = new THREE.Group();
  group.add(shell, glow, signPivot);

  /** Turn the sign. One rotation and no state, so a paused frame simply stops being advanced. */
  function update(dt, spin = SIGN_SPIN) {
    sign.rotation.y += spin * dt;
  }

  return {
    site,
    group,
    shell,
    glow,
    /** The turning mesh, and the leaning pivot it turns inside. */
    sign,
    signPivot,
    update,
    /** Both stamped meshes, for the city's entrance wave and for the AO prepass. */
    meshes: [shell, glow],
    /**
     * ...and the sign, which the wave has to grow on the CPU instead. The **pivot** goes in, not
     * the mesh: scaling it takes the burger with it and leaves the lean alone, where scaling the
     * mesh inside a rotated parent would have the wave fighting the tilt.
     */
    entryObject: { object: signPivot, x: anchorX, z: anchorZ, rand },
    entrySite: {
      x: anchorX,
      z: anchorZ,
      r: Math.max(wall.x1 - wall.x0, wall.z1 - wall.z0) / 2,
      rand,
    },
  };
}
