import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  FINISH, bakeColor, hash01, propMaterial, setFinish, stampEntry, unlitMaterial,
} from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { taxiSignGeometry } from '../geometry/taxi.js';
import { KERB_H } from './ground.js';
import { lippedCap } from './buildings.js';
import {
  DIR, GRID_I, GRID_J, HALF_ROAD, LANE, LTRAIN_NS, LTRAIN_WEST, isArterialX, isArterialZ,
  isSegmentClosed, junctionReach, laneOffZ, lineX, lineZ,
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

// --- The roofline neon ------------------------------------------------------
// A blue tube tracing the parapet on the two elevations the camera sees, the way the burger joint
// across town traces its own (`neonParts` in city/burgerjoint.js) — same placement argument, same
// mitre, the sign's `depotNeon` blue. `?depotneon=classic` leaves it off.
//
// It hangs under the coping, in the reveal `CHECK_DROP` leaves above the chequer, and that reveal
// is what it is replacing as the separator: a blue line between a dark lid and a dark-and-white
// course does that job better than a sliver of wall did. Standing `TRIM_OUT` proud keeps it inside
// the coping's 0.18 overhang with 0.04 to spare, so its outer face is never coplanar with the
// coping's — and the lip over it hides only `0.04 × VIEW_RISE` = 0.04 of height, which is spent in
// `TRIM_DROP` before the tube starts.
const TRIM_H = 0.2;              // a pixel and a half at play zoom, as the burger's
const TRIM_DROP = 0.06;          // under the coping's underside
const TRIM_OUT = 0.14;           // proud of the wall

// --- The office windows after dark ----------------------------------------------------------------
// The two windows on the +Z elevation light up with the rest of the city when night or a squall
// comes over (`switchedLights` in game/citylights.js — main.js builds the mesh, since only a city
// with weather has the switch). Early in the darkening, with the shops rather than the flats: the
// depot is where the night shift is. Each pane sits `LIT_PROUD` off the glass and inset a little,
// so it reads as a lit room in a dark frame rather than as the frame changing colour.
// `?depotwindows=classic` leaves them dark.
const LIT_PROUD = 0.015;
const LIT_INSET = 0.08;
const LIT_AT = [0.1, 0.22];

// --- The sign on the roof ---------------------------------------------------
// The depot is where the player brings the taxi back for repairs and upgrades, and from play zoom
// the building has to *say* that before anybody has learned it. So the roof carries a sign the way
// the burger joint does: one oversized object on a pole.
//
// The object is **a taxi, cut out of board**: a flat side-on silhouette in the taxi's paint with a
// blue neon tube round its edge. A yellow car is the one shape the player is already scanning the
// map for, so it is the fastest thing to find — and being *flat* is what stops it being mistaken
// for their car, because a car on the road never is. The neon says "sign" in a second way that
// survives daylight (it is unlit, so it is a line of full colour against a sunlit roof) and takes
// over at night (it blooms). It **sways** on its pole rather than turning, facing the camera: a flat
// board that turned would go edge-on twice a revolution, which is the problem the wrench had.
//
// Two earlier signs are kept for comparison. `?depot=model` is the first cut of this one — the
// real taxi's 3D model banked on the pole and turning — which read as a car parked on the roof
// rather than as a sign. `?depot=classic` is the wrench, which said "repairs" only to someone who
// already knew the depot did repairs, and at play zoom was a grey sliver half the time.
//
// The wrench before it replaced a radio mast and dish, which said "dispatch" — true, and nothing
// the player can act on.
//
// **Almost nothing here is placed by a literal**, which is a habit carried over from the dish: it
// was resized twice, and both times the numbers that broke were the hand-tuned ones around it. The
// pole's position is derived from the wrench's measured sweep (`createGarage`), and its height from
// the wrench's measured underside, so changing any number below moves them rather than clipping.
const POLE_PLINTH = 0.16;
// Between the two head centres. The whole tool is this plus both heads' radii — 4.4 units, a
// little under the burger across the road: oversized for a wrench, still a sign on a roof. 6.0
// was tried first and read as the building's main feature rather than as its sign.
const WRENCH_L = 2.84;
const RING_R = 0.72;             // the closed end
const RING_HOLE = 0.38;          // ...and the hexagon through it
const JAW_R = 0.84;              // the open end, a touch bigger, as on the real thing
const JAW_GAP = 0.35;            // half the jaw's opening
const HANDLE_W = 0.3;            // half the handle's width
// Thick for a spanner, on purpose. It turns about a vertical axis, so twice a revolution the camera
// sees it edge-on — and an edge this deep is still a bar of steel rather than a line.
const WRENCH_T = 0.32;
const WRENCH_BEVEL = 0.065;
// How far the long axis leans off vertical, open end up: the 45° of every spanner icon, which is
// what reads as "repairs" rather than as a tool hung on a hook. 31° was tried first and still
// looked like it was hanging.
const WRENCH_CANT = Math.PI / 4;
// What its lowest point keeps above the roof plant's tops as it sweeps over them.
const WRENCH_CLEAR = 0.3;
// And what its whole sweep keeps between itself and the two things it must not reach: the roof's
// own edge, and the curtain plane every sightline out of the door starts on.
const POLE_STANDOFF = 0.4;
// How much of the metal finish's sky reflection it keeps. The finish is tuned on bumpers and hubcaps,
// which are small and mostly face the camera; on a slab this thin the gloss bends nearly every
// fragment to a grazing angle, and at the full share the wrench came out as pale blue as the sky
// whatever its base colour was. Down here the steel is mostly its own colour with a sheen of sky.
const WRENCH_MIRROR = 0.35;

// --- The cutout (default) ---
// The board's outline, side-on, nose toward +x: the body, the cabin on it, the roof light on that.
// Cartoon proportions rather than the car's — a taller cabin and a bigger roof light — because at
// play zoom it is the outline that has to say "taxi", and the real car's cabin is a low dark box.
const CUT_L = 5.0;               // nose to tail
const CUT_SILL = 0.55;           // the body's underside, over the wheel centres
const CUT_BELT = 1.45;           // the body's top, where the cabin starts
const CUT_ROOF = 2.3;            // the cabin's top
const CUT_LAMP = 0.32;           // the roof light's height over the cabin
const CUT_WHEEL_R = 0.5;
const CUT_WHEEL_X = 1.55;        // each wheel's centre, either side of the middle
// Board thickness, plus a chamfer round every edge so the board catches light as it sways.
const CUT_T = 0.3;
const CUT_BEVEL = 0.05;
// Everything stuck on the faces — windows, chequer, wheels, roof light — is one solid through the
// board, this much proud of each face. A solid each, not a decal each side: three winds a box, and
// a hand-wound decal on the back face is the reversed-triangle trap in CLAUDE.md.
const CUT_PROUD = 0.03;
// The neon: a tube round the board's whole edge, centred on its mid-plane — flattened, thin in the
// board's plane and deep across it. Deep so it stands proud of both faces (an outline from the front
// and a bright rim from the side); thin because the line the camera sees is its in-plane width.
// A round tube had to be 0.2 in radius to clear the faces, and that drew a 0.4 band round the car
// that read as a fat outline rather than as a tube of light.
const NEON_R = 0.085;
const NEON_DEPTH = CUT_T / 2 + 0.04;
// The neon's life: a brighter spot chasing round the tube, and now and then a stutter. Both are
// colour written per vertex, which the bloom's copy of the material reads too, so the glow chases
// and stutters with it.
const CHASE_RATE = 0.35;         // laps a second
const CHASE_WIDTH = 0.06;        // the hot spot's half-width, as a fraction of a lap
const CHASE_BASE = 0.8;          // the rest of the tube, against the hot spot's 1 + its white
const CHASE_WHITE = 0.35;        // how far the hot spot runs toward white
const FLICKER_GAP = [4, 11];     // seconds between stutters
const FLICKER_LEN = 0.4;         // ...and how long each one lasts
const FLICKER_DIM = 0.35;        // the low the tube drops to while it stutters
// How much of the board's own yellow it gives off, so a face turned from the sun stays yellow.
// 0.35 left the late-afternoon board peach rather than yellow.
const BOARD_LIFT = 0.5;
// The sway. The board faces the camera's diagonal and swings this far either side of it.
const CUT_FACING = Math.PI / 4;
const CUT_SWAY = 0.38;
/** How fast it sways, in radians of phase a second — about six seconds a swing there and back. */
export const CUT_SWAY_RATE = 1.05;
// The tailpipe and the painted flame out of it (`?signflames=classic` has neither). The pipe is a
// stub through the board like the wheels, poking back past the tail's neon, just over the sill
// tube it would otherwise sit inside.
const PIPE_R = 0.12;
const PIPE_Y = CUT_SILL + 0.24;
const PIPE_OUT = 0.28;           // how far it pokes back past the tail
// The flame is **sign paint, not fire**: a hot-rod lick cut out of board like the taxi, three
// tongues curling up and back, red round yellow, and it does not move. An animated backfire in the
// Loco plume's own tongue was the first cut, and it read as the game's boost effect going off on
// the roof rather than as part of the sign. Unlit like the neon, so it holds its colour on the
// shaded face the board's BOARD_LIFT exists for, but kept out of the bloom: it is paint.
const FLAME_PROUD = 0.03;        // each inner layer stands this much prouder than the one under it

// --- The 3D model (`?depot=model`) ---
// The taxi sign. A size up on the player's car (drawn at TAXI_SCALE = 1.18) so that side by side
// the one on the roof is plainly the bigger of the two — the cue that it is a model and not a car.
const TAXI_SIGN_SCALE = 1.5;
// Banked onto one side, off level: enough that it never reads as parked, not so much it reads as
// rolling over. A bank rather than nose-up on purpose. Pitched 30° nose-up, the car's end faces
// came round to the camera twice a revolution, and an end face is a pale slab of bumper and grille
// — the sign read as a pink box with a cabin on it. Banked, what turns toward the camera is a
// flank, and the flank is the yellow with the chequer down it.
const TAXI_SIGN_CANT = Math.PI / 7;
// How much sky its paint keeps, against the live car's 1.33. Up on a pole and leaning, more of the
// body faces the sky the gloss bends toward than on a car on the road, and the sign is there to be
// *yellow* at a glance. Mostly its own colour, then.
const TAXI_SIGN_GLOSS = 0.3;
const TAXI_SIGN_MIRROR = 0.5;
// Higher off the plant than the wrench's WRENCH_CLEAR. From this camera a car's underside covers
// the top of its own pole, so at the wrench's clearance the pole vanished and the car looked parked
// on the roof — the one misreading the sign must not invite.
const TAXI_SIGN_CLEAR = 1.4;
// The roof plant's taller box, which the wrench's low end sweeps over.
const PLANT_H = 0.55;

/**
 * How fast the sign turns, in radians a second — about sixteen seconds a revolution.
 *
 * Slow, for the reason `SIGN_SPIN` is one building over: anything much past this stops reading as
 * a sign that turns and starts reading as a tool being spun.
 */
export const DEPOT_SPIN = 0.4;

// The block platform's walking surface — `createGround` lays the pavement one centimetre over the
// kerb box. A car standing on it rides this much higher than one on the road.
export const PAVEMENT_Y = KERB_H + 0.01;

// The forecourt asphalt's own top face, and the paint on it. Named off each other rather than
// nudged as literals, the way `city/burgerjoint.js` names its apron levels: two flat surfaces at
// the same height is a shimmer, not a touch, and the level anything standing on the forecourt
// wants is the one the forecourt itself lays.
export const APRON_Y = PAVEMENT_Y + 0.01;
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

// Whether the depot stays out from behind the L (on by default, `?garageplace=classic` to compare).
// Read here rather than in main.js because the layout is what decides, and the headless tools take
// `GARAGEPLACE=classic` from the environment the way they take `CITY=big`.
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const AVOID_LTRAIN = params
  ? params.get('garageplace') !== 'classic' && params.get('ltrain') !== 'classic'
  : globalThis.process?.env?.GARAGEPLACE !== 'classic';

/**
 * Does the elevated train stand between this block's door and the camera?
 *
 * Only on one column: the block whose +X street *is* the L's north-south arterial. The door faces
 * the median across the forecourt and one carriageway, so the sightline reaches the track ~8-10
 * units out, 7-9 up — exactly the deck (6.4) and a train on it (8.2). Measured over 200 seeds
 * before this filter (tools/probe.mjs re-measures it): 46 put the depot there, every one of them
 * with **55%** of the forecourt the taxi drives out over behind the deck and up to 89% once a train
 * is passing, and the door itself under the train. One block further west is clear: the line is 21+
 * units out by then and well over the train's roof.
 *
 * Mirrors `planLTrain` (game/ltrain.js) rather than calling it, because that module builds meshes
 * and city/ must not import game/: the line is the first interior north-south arterial, and on
 * `?city=big` it only runs north of the east-west arterial it turns west along. An east-west line
 * hides nothing — the door faces it side-on and the sightline climbs 12 units before reaching it.
 */
function behindLTrain(bi, bj) {
  if (!AVOID_LTRAIN || !LTRAIN_NS) return false;
  let iz = null;
  for (let i = 1; i < GRID_I; i++) if (isArterialZ(i)) { iz = i; break; }
  if (iz === null || bi + 1 !== iz) return false;
  if (LTRAIN_WEST) {
    let jx = null;
    for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) { jx = j; break; }
    if (jx !== null && jx > 0 && jx < GRID_J) return bj < jx;
  }
  return true;
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
  const pool = inner.length ? inner : candidates;

  // Off the column behind the L. **One draw either way**, and the same draw indexes both lists: a
  // seed whose depot was already clear of the track keeps it exactly where it was (and so does the
  // burger joint, drawn next from the same stream), and only the 23% that landed behind it move.
  // Filtering `pool` before the pick would have moved the depot on most seeds that never had the
  // problem, every pinned seed and reference screenshot with them.
  const roll = rng.next();
  const pick = pool[Math.floor(roll * pool.length)];
  if (!behindLTrain(pick.bi, pick.bj)) return pick;
  const clear = pool.filter((b) => !behindLTrain(b.bi, b.bj));
  const fallback = clear.length ? clear : candidates.filter((b) => !behindLTrain(b.bi, b.bj));
  return fallback.length ? fallback[Math.floor(roll * fallback.length)] : pick;
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
    // The way in from the other side of the road: the far lane, running −Z towards the junction at
    // the near end of this block, and a left turn across the near lane into the driveway. Null on a
    // main street, whose planted median stands between the far carriageway and the door.
    //
    // `x` is the lane's centre. The turn off it is a quarter circle of radius `x − near lane` — the
    // two lane centres apart, so it lands square across the near lane on its centreline — and then
    // `turnR` of straight over the rest of the near lane to the kerb (`entryPath` in
    // game/opening.js). `back` is where `placeCar` has a car on that lane level with the mouth,
    // counted back from the junction it runs to, exactly as `merge.back` is for the exit.
    far: isArterialZ(block.bi + 1) ? null : (() => {
      const x = lineX(block.bi + 1) + laneOffZ(block.bi + 1);
      const leftR = 2 * laneOffZ(block.bi + 1);
      return {
        d: DIR.NZ,
        i: block.bi + 1,
        j: block.bj,
        x,
        leftR,
        back: (doorZ + leftR) - (lineZ(block.bj) + junctionReach(DIR.NZ, block.bi + 1, block.bj)),
      };
    })(),
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
 * The pole the wrench turns on — static, so it rides in the shell's merge and is lifted by the
 * entrance wave like the rest of the building. A pole that turned with the wrench would be a
 * barber's pole, the same argument the burger's makes.
 *
 * @param foot  the top of the coping, which is what it stands on
 * @param hub   the world height of the wrench's centre, which is where the pole stops: inside the
 *              handle, so the tool reads as mounted on it rather than floating over it
 */
function signPole(x, z, foot, hub) {
  const trim = color('garageTrim');
  const base = foot + POLE_PLINTH;
  const pole = new THREE.CylinderGeometry(0.12, 0.16, hub - base, 6);
  pole.translate(x, base + (hub - base) / 2, z);
  return [box(0.6, POLE_PLINTH, 0.6, x, foot, z, trim), bakeColor(pole, trim)];
}

/**
 * The wrench, in its pivot's own space: a combination spanner, open jaw at the top and a ring at
 * the bottom.
 *
 * One `Shape` extruded, rather than a handle and two heads merged, for two reasons. Three winds an
 * extrusion itself, so there is no hand-written triangle here to get backwards (CLAUDE.md has three
 * of those). And separate solids would share their top faces on one plane wherever the handle runs
 * into a head — coplanar *overlap*, which is the kind that shimmers.
 *
 * The bevel is a single chamfer, and it is most of the "metal". Under `flatShading` every face is
 * one flat colour, and a flat slab lit by one sun is a cut-out; the chamfer is a ring of faces at
 * 45° round every edge, which is what catches the metal finish's glint as the thing turns.
 *
 * **The pivot stands on the kerb, under the pole, not at the wrench's centre** — the same contract
 * the dish had. The entrance wave scales the shell about `KERB_H`, and all the CPU path that grows
 * this owns is `object.scale` (see `objects` in game/cityentry.js), so a pivot on that plane is the
 * one place a uniform scale rides up the pole as the pole grows.
 *
 * Built about its own centre; `createGarage` lifts it once it has measured how far below that
 * centre it reaches.
 */
function wrenchGeometry() {
  const top = WRENCH_L / 2;      // the jaw's centre
  const bot = -WRENCH_L / 2;     // the ring's centre
  const w = HANDLE_W;
  const sr = Math.sqrt(RING_R ** 2 - w ** 2);
  const sj = Math.sqrt(JAW_R ** 2 - w ** 2);
  const sn = Math.sqrt(JAW_R ** 2 - JAW_GAP ** 2);

  // Counter-clockwise from the bottom of the handle's right edge: up the handle, round the jaw to
  // the gap, down into it and out again, round the rest of the jaw, down the left edge, and the
  // whole way round the ring.
  const shape = new THREE.Shape();
  shape.moveTo(w, bot + sr);
  shape.lineTo(w, top - sj);
  shape.absarc(0, top, JAW_R, Math.atan2(-sj, w), Math.atan2(sn, JAW_GAP), false);
  // The throat: a half-round at the bottom of the gap, bitten in a little past the jaw's centre.
  const throat = top + 0.1;
  shape.lineTo(JAW_GAP, throat);
  shape.absarc(0, throat, JAW_GAP, 0, Math.PI, true);
  shape.lineTo(-JAW_GAP, top + sn);
  shape.absarc(0, top, JAW_R, Math.atan2(sn, -JAW_GAP), Math.atan2(-sj, -w) + Math.PI * 2, false);
  shape.lineTo(-w, bot + sr);
  shape.absarc(0, bot, RING_R, Math.atan2(sr, -w), Math.atan2(sr, w) + Math.PI * 2, false);

  // The hexagon the bolt goes through. Wound clockwise, as a hole; three checks and would reverse
  // it anyway, but a hole that happens to be right is not the same as one that is.
  const hole = new THREE.Path();
  for (let k = 0; k <= 6; k++) {
    const a = -k * (Math.PI / 3) + Math.PI / 6;
    const x = Math.cos(a) * RING_HOLE;
    const y = bot + Math.sin(a) * RING_HOLE;
    if (k === 0) hole.moveTo(x, y);
    else hole.lineTo(x, y);
  }
  shape.holes.push(hole);

  const depth = WRENCH_T - 2 * WRENCH_BEVEL;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments: 7,
    bevelEnabled: true,
    bevelThickness: WRENCH_BEVEL,
    bevelSize: WRENCH_BEVEL,
    bevelSegments: 1,
  });
  geo.deleteAttribute('uv');
  geo.translate(0, 0, -depth / 2);
  geo.rotateZ(-WRENCH_CANT);
  return setFinish(bakeColor(geo, color('wrenchSteel')), FINISH.METAL);
}

/**
 * The taxi sign, in the same terms as `wrenchGeometry`: built about its own centre, canted, and
 * handed back for `createGarage` to lift. Centred on its bounding box rather than on the car's
 * origin, which sits on the road under it — the pole stops at this centre, inside the body.
 */
function taxiGeometry() {
  const geo = taxiSignGeometry();
  geo.deleteAttribute('uv');
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  geo.scale(TAXI_SIGN_SCALE, TAXI_SIGN_SCALE, TAXI_SIGN_SCALE);
  geo.rotateX(TAXI_SIGN_CANT);
  return geo;
}

/**
 * The taxi cutout and its neon, in the same terms as `wrenchGeometry`: built about the board's own
 * centre and handed back for `createGarage` to lift. The board faces ±z, nose toward +x.
 *
 * The board is one extruded `Shape`, for the wrench's reasons: three winds it, and nothing in it
 * shares a face with anything else. Every detail on it is a solid running *through* it (see
 * `CUT_PROUD`), so each shows on both faces and none is a hand-wound triangle.
 */
function cutoutGeometry({ flame: withFlame = true } = {}) {
  const half = CUT_L / 2;
  const lampW = 0.8;
  const lampX = -0.2;
  // The cabin, as its four corners: a raked windscreen at the front and a gentler one behind.
  const cab = { rearFoot: -1.45, rearTop: -1.0, frontTop: 0.55, frontFoot: 1.1 };

  // Counter-clockwise from the tail's bottom corner, seen from +z. The roof light is part of the
  // outline rather than stuck on, so the neon runs up and over it.
  const outline = [
    [-half, CUT_SILL], [half, CUT_SILL], [half, CUT_BELT],
    [cab.frontFoot, CUT_BELT], [cab.frontTop, CUT_ROOF],
    [lampX + lampW / 2, CUT_ROOF], [lampX + lampW / 2, CUT_ROOF + CUT_LAMP],
    [lampX - lampW / 2, CUT_ROOF + CUT_LAMP], [lampX - lampW / 2, CUT_ROOF],
    [cab.rearTop, CUT_ROOF], [cab.rearFoot, CUT_BELT], [-half, CUT_BELT],
  ];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = CUT_T - 2 * CUT_BEVEL;
  const board = new THREE.ExtrudeGeometry(shape, {
    depth, curveSegments: 1, bevelEnabled: true,
    bevelThickness: CUT_BEVEL, bevelSize: CUT_BEVEL, bevelSegments: 1,
  });
  board.deleteAttribute('uv');
  board.translate(0, 0, -depth / 2);

  const through = CUT_T + 2 * CUT_PROUD;
  const slab = (pts, col) => {
    const geo = new THREE.ExtrudeGeometry(
      new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))),
      { depth: through, bevelEnabled: false, curveSegments: 1 });
    geo.deleteAttribute('uv');
    geo.translate(0, 0, -through / 2);
    return bakeColor(geo, col);
  };
  const glass = color('carGlass');
  const paint = bakeColor(board, color('taxiBody'));
  const parts = [
    // Two windows split by the B-pillar, each inset from the cabin's edge so a rim of yellow frames it.
    slab([[cab.rearFoot + 0.3, CUT_BELT + 0.12], [-0.35, CUT_BELT + 0.12], [-0.35, CUT_ROOF - 0.14],
      [cab.rearTop + 0.12, CUT_ROOF - 0.14]], glass),
    slab([[-0.15, CUT_BELT + 0.12], [cab.frontFoot - 0.32, CUT_BELT + 0.12],
      [cab.frontTop - 0.08, CUT_ROOF - 0.14], [-0.15, CUT_ROOF - 0.14]], glass),
    // The roof light's face, lit the way the live car's is with a rider aboard.
    slab([[lampX - lampW / 2 + 0.08, CUT_ROOF + 0.06], [lampX + lampW / 2 - 0.08, CUT_ROOF + 0.06],
      [lampX + lampW / 2 - 0.08, CUT_ROOF + CUT_LAMP - 0.06],
      [lampX - lampW / 2 + 0.08, CUT_ROOF + CUT_LAMP - 0.06]], color('taxiSign')),
  ];
  // The chequer along the flank, one row as on the car — and for the car's reason, a two-row
  // chequer at this size is a grey smear.
  const CELLS = 8;
  const run = CUT_L - 0.9;
  const cell = run / CELLS;
  for (let k = 0; k < CELLS; k++) {
    const x0 = -run / 2 + k * cell;
    parts.push(slab([[x0, 1.0], [x0 + cell, 1.0], [x0 + cell, 1.22], [x0, 1.22]],
      color(k % 2 ? 'taxiSign' : 'taxiTrim')));
  }
  // Wheels: a tyre each with a hubcap, as cylinders along z through the board. Their tops are
  // inside the body, so the board reads as a car standing on them. Wider than the neon tube is
  // deep (`2 · NEON_DEPTH`), so the tube running along the sill is buried in them rather than
  // grazing their faces — at the same depth it drew neon through the tyres.
  const tread = Math.max(through, 2 * NEON_DEPTH) + 0.08;
  for (const sx of [-1, 1]) {
    const tyre = new THREE.CylinderGeometry(CUT_WHEEL_R, CUT_WHEEL_R, tread, 12);
    tyre.rotateX(Math.PI / 2);
    tyre.translate(sx * CUT_WHEEL_X, CUT_SILL, 0);
    parts.push(bakeColor(tyre, color('taxiTrim')));
    const hub = new THREE.CylinderGeometry(CUT_WHEEL_R * 0.5, CUT_WHEEL_R * 0.5, tread + 0.04, 12);
    hub.rotateX(Math.PI / 2);
    hub.translate(sx * CUT_WHEEL_X, CUT_SILL, 0);
    parts.push(bakeColor(hub, color('hubcap')));
  }
  // The tailpipe: a cylinder along x through the tail, deeper than the neon for the wheels' reason.
  if (withFlame) {
    const pipe = new THREE.CylinderGeometry(PIPE_R, PIPE_R, PIPE_OUT + 0.3, 10);
    pipe.rotateZ(Math.PI / 2);
    pipe.translate(-half - PIPE_OUT / 2 + 0.15, PIPE_Y, 0);
    parts.push(bakeColor(pipe, color('hubcap')));
  }
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  parts.forEach((g) => g.dispose());

  // The neon: one closed tube along the outline, on the board's mid-plane. It runs along the sill
  // too, and the wheels swallow it there, so it reads as passing behind them.
  const path = new THREE.CurvePath();
  for (let k = 0; k < outline.length; k++) {
    const [ax, ay] = outline[k];
    const [bx, by] = outline[(k + 1) % outline.length];
    path.add(new THREE.LineCurve3(new THREE.Vector3(ax, ay, 0), new THREE.Vector3(bx, by, 0)));
  }
  // Enough segments that every corner lands on a ring rather than being cut across: the tube is
  // sampled evenly by length, so it is sized off the shortest edge.
  const SEGS = outline.length * 12;
  const RADIAL = 6;
  const neon = new THREE.TubeGeometry(path, SEGS, NEON_R, RADIAL, true);
  neon.deleteAttribute('uv');
  // Flattened: the path lies on z = 0, so a vertex's z *is* its offset across the board, and
  // scaling z deepens the tube without widening the line it draws.
  neon.scale(1, 1, NEON_DEPTH / NEON_R);
  // Left indexed and coloured by hand rather than through `bakeColor`, which de-indexes: the chase
  // rewrites every vertex's colour every frame, and indexed that is about a thousand vertices
  // rather than five. Each vertex also carries how far round the lap its ring is, for the chase.
  // TubeGeometry lays its vertices out ring by ring, RADIAL + 1 to a ring.
  const count = neon.attributes.position.count;
  const lap = new Float32Array(count);
  for (let i = 0; i < count; i++) lap[i] = Math.floor(i / (RADIAL + 1)) / SEGS;
  neon.userData.lap = lap;
  neon.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));

  // About the centre of the whole thing — wheels and tube included — like the wrench.
  const box = new THREE.Box3();
  for (const g of [geo, paint, neon]) {
    g.computeBoundingBox();
    box.union(g.boundingBox);
  }
  const c = box.getCenter(new THREE.Vector3());
  for (const g of [geo, paint, neon]) g.translate(-c.x, -c.y, -c.z);
  // The flame is left out of the centring on purpose: the pole stays under the taxi, and the flame
  // hangs off the back of it the way a sign's flourish does — over the roof's edge, on some blocks.
  const flame = withFlame ? flameGeometry() : null;
  flame?.translate(-half - PIPE_OUT - c.x, PIPE_Y - c.y, -c.z);
  return { geo, paint, neon, flame };
}

/**
 * The painted flame, about the pipe's mouth with the licks running back along −x. Three layers of
 * the one outline: the outer cut as board (bevelled like the taxi's), the two inner ones as solids
 * through it, each `FLAME_PROUD` prouder than the last so no two faces share a plane — the reason
 * `CUT_PROUD` exists, one layer further out. Inner layers are the outline scaled toward the mouth,
 * which keeps them inside it: the shape is star-shaped about the pipe.
 */
function flameGeometry() {
  const outline = (sx, sy) => {
    const s = new THREE.Shape();
    const p = (x, y) => [x * sx, y * sy];
    s.moveTo(...p(0, -0.3));
    s.quadraticCurveTo(...p(-0.9, -0.48), ...p(-1.75, -0.08));   // the low lick
    s.quadraticCurveTo(...p(-1.15, -0.04), ...p(-0.95, 0.12));
    s.quadraticCurveTo(...p(-1.75, 0.04), ...p(-2.4, 0.45));     // the long one
    s.quadraticCurveTo(...p(-1.6, 0.34), ...p(-1.2, 0.5));
    s.quadraticCurveTo(...p(-1.65, 0.62), ...p(-1.95, 1.02));    // the high one
    s.quadraticCurveTo(...p(-0.9, 0.78), ...p(0, 0.3));
    s.closePath();
    return s;
  };
  const depth = CUT_T - 2 * CUT_BEVEL;
  const outer = new THREE.ExtrudeGeometry(outline(1, 1), {
    depth, curveSegments: 6, bevelEnabled: true,
    bevelThickness: CUT_BEVEL, bevelSize: CUT_BEVEL, bevelSegments: 1,
  });
  outer.translate(0, 0, -depth / 2);
  const layer = (sx, sy, through, key) => {
    const g = new THREE.ExtrudeGeometry(outline(sx, sy), {
      depth: through, curveSegments: 6, bevelEnabled: false,
    });
    g.translate(0, 0, -through / 2);
    return bakeColor(g, color(key));
  };
  const parts = [
    bakeColor(outer, color('signFlameOuter')),
    layer(0.7, 0.62, CUT_T + 2 * FLAME_PROUD, 'signFlameMid'),
    layer(0.42, 0.36, CUT_T + 4 * FLAME_PROUD, 'signFlameCore'),
  ];
  parts.forEach((g) => g.deleteAttribute('uv'));
  const geo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  parts.forEach((g) => g.dispose());
  return geo;
}

/**
 * The depot: two merged meshes, a light and a sign.
 *
 * Two meshes rather than one because the curtain moves and the shell does not. Both are stamped
 * with the same entrance anchor (see `stampEntry`), so the city's opening wave lifts the door with
 * its own building rather than leaving it hanging in the air. The light is unlit and outside the
 * wave, and the sign is outside it for a different reason — see `wrenchGeometry`.
 */
/** What the model workshop finds this landmark by (src/workshop/catalog.js, `LANDMARKS`). */
// `glow` is what blooms and at which `BLOOM_INTENSITY` kind (game/bloom.js), read by main.js and the
// bench alike so the two cannot disagree. The office panes are not here: main.js builds them
// through `switchedLights` from `litWindows`, and the bench has no evening to switch them on in.
export const LANDMARK = {
  id: 'depot',
  label: 'Taxi depot',
  create: createGarage,
  glow: (g) => [[g.light, 'bay'], [g.neon, 'window'], [g.roofNeon, 'window']].filter(([m]) => m),
};

export function createGarage(block, rng, {
  sign: style = 'cutout', trim: withTrim = true, flames: withFlames = true,
  driveway = 'paved',
} = {}) {
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
  // The coping, hollowed into a lip like every flat roof in the city (`lippedCap`). `deck` is the
  // floor inside it, which the pole and the plant stand on.
  const coping = [];
  // The guide lines' paint: the taxi's own yellow on asphalt, a deeper amber on the paved
  // forecourt where the yellow is the pavement's value exactly (`drivewayPaint`).
  const linePaint = color(driveway === 'classic' ? 'garageSign' : 'drivewayPaint');
  const deck = lippedCap(coping, frontX - bx0 + 0.36, 0.34, bz1 - bz0 + 0.36,
    (bx0 + frontX) / 2, top, (bz0 + bz1) / 2, color('garageTrim'));

  // --- The pole's placement, worked out from the sign rather than chosen.
  //
  // The sign is built first because everything about the pole depends on how much room it takes:
  // how high it has to stand to sweep clear of the roof plant, and how far in from the roof's edge.
  const {
    geo: signGeo, paint: paintGeo = null, neon: neonGeo = null, flame: flameGeo = null,
  } = style === 'classic' ? { geo: wrenchGeometry() }
    : style === 'model' ? { geo: taxiGeometry() } : cutoutGeometry({ flame: withFlames });
  // Everything that turns with the sign, measured together. The flame rides along but is left out
  // of the sweep below: the cutout only sways, and its tail always swings away from the curtain
  // plane (−x), so the flame cannot reach the door's sightlines — the probe sways it and measures.
  // Measured in, it pushed the pole a flame's length further onto the roof and into the plant.
  const signGeos = [signGeo, paintGeo, neonGeo].filter(Boolean);
  const low = Math.min(...signGeos.map((g) => {
    g.computeBoundingBox();
    return g.boundingBox.min.y;
  }));
  const clear = style === 'classic' ? WRENCH_CLEAR : TAXI_SIGN_CLEAR;
  const hub = deck + PLANT_H + clear - low;
  for (const g of [...signGeos, flameGeo].filter(Boolean)) g.translate(0, hub - KERB_H, 0);

  // The radius it sweeps: the furthest any of its vertices gets from the pivot's own axis. Not
  // `boundingBox.max.x` — the box is measured in one pose and the sign **turns**, so its
  // footprint is the circle that pose inscribes.
  // The cutout only sways, but it is measured as if it turned: the standoff then holds for any
  // sway, and the board is no deeper for it.
  let orbit = 0;
  for (const g of signGeos) {
    const wp = g.attributes.position;
    for (let i = 0; i < wp.count; i++) orbit = Math.max(orbit, Math.hypot(wp.getX(i), wp.getZ(i)));
  }

  // One standoff answers both of the things the sweep must not reach, because they are the same
  // distance from two different planes. It has to keep its whole orbit **on the roof**, off the +Z
  // parapet; and it has to keep it **behind the curtain plane**, since every sightline out of the
  // opening starts there and runs +X — so anything wholly behind it cannot occlude the door at any
  // height, and anything past it can. `curtainX` is the tighter of the two on x, being 0.3 back
  // from the wall.
  const stand = orbit + POLE_STANDOFF;
  const poleX = curtainX - stand;
  const poleZ = bz1 - stand;

  const wall = jitterColor(color('garageWall'), rng, { l: 0.03 });
  const trim = color('garageTrim');
  const bay = color('garageBay');

  // The office windows, shared by the glass below and the light behind it.
  const officeWindows = [[bx0 + 3.0, bx0 + 4.6], [bx0 + 5.2, bx0 + 6.8]];
  const winY0 = base + 1.6;
  const winY1 = base + 2.9;
  const glassZ = bz1 + 0.05;

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
    ...coping,

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

    // The forecourt, laid over the pavement from under the door out to the kerb and back to where
    // the bay floor stops, so the threshold is continuous. Paved in the block's own `sidewalk`
    // (Tyler, 2026-10-26) — a slab of road-dark asphalt read as a hole in the block at play zoom —
    // so what says "cars come out of here" is now the paint and the dropped kerb, not the surface.
    // `?driveway=classic` is the asphalt.
    span(curtainX - 0.12, kerbX, PAVEMENT_Y - 0.01, APRON_Y, dz0 - 0.5, dz1 + 0.5,
      jitterColor(color(driveway === 'classic' ? 'asphalt' : 'sidewalk'), rng, { l: 0.02 })),

    // The other elevation. `+Z` is the second of the two faces this camera can ever see, and on a
    // one-storey box it is 8 × 5 units of nothing — which at the vignette's zoom is a quarter of
    // the frame. An office door and two windows are what a depot has besides the big hole, and
    // they are also the only thing on the building giving its height a human scale.
    span(bx0 + 1.0, bx0 + 1.9, base, base + 2.1, bz1, bz1 + 0.06, color('door')),
    span(bx0 + 0.82, bx0 + 2.08, base, base + 2.28, bz1, bz1 + 0.03, trim),
    ...officeWindows.map(([wx0, wx1]) => span(wx0, wx1, winY0, winY1, bz1, glassZ, color('shopfront'))),

    // Rooftop plant, on top of the coping rather than under it. Same argument as the elevation
    // above: a flat lid reads as an unfinished box, and the city's own towers all carry some.
    //
    // Both are measured off the roof's **back** corner, because the pole owns the front one and
    // stands a whole sweep-radius in from it. The small one used to be at (bx0 + 5.6, bz1 - 2.2) —
    // one offset from the back in x and one from the front in z — and the two placements only
    // stayed apart because an ordinary block is 12 wide. A block squeezed between two arterials is
    // 9.33, the old radio mast walked into the box, and nothing in the geometry said so. Same corner for
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
    span(curtainX, kerbX - KERB_RUN, APRON_Y, PAINT_Y, dz0 + 0.35, dz0 + 0.63, linePaint),
    span(curtainX, kerbX - KERB_RUN, APRON_Y, PAINT_Y, dz1 - 0.63, dz1 - 0.35, linePaint),
    ...(driveway === 'classic' ? [] : noParking(frontX, kerbX - KERB_RUN, doorZ)),

    // The pole. Static, so it rides in the shell's merge and the entrance wave lifts it with the
    // building; only the sign is excluded from that, and only because it turns.
    ...signPole(poleX, poleZ, deck, hub),
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

  // --- The roofline neon ----------------------------------------------------
  // Two arms mitred the burger joint's way: the +X arm carries the corner, running on past the +Z
  // arm, and the +Z arm stops on its inner face, so no front-facing pair is ever coincident. Their
  // far ends stop on the wall corners, where the caps face away and are culled. Stamped and in
  // `meshes`, unlike the bay light: it is on the outside of the building, so it has to rise with it.
  let roofNeon = null;
  if (withTrim) {
    const neonBlue = color('depotNeon');
    const y1 = top - TRIM_DROP;
    const y0 = y1 - TRIM_H;
    const trimParts = [
      span(frontX, frontX + TRIM_OUT, y0, y1, bz0, bz1 + TRIM_OUT, neonBlue),
      span(bx0, frontX, y0, y1, bz1, bz1 + TRIM_OUT, neonBlue),
    ];
    trimParts.forEach(stampAll);
    roofNeon = new THREE.Mesh(mergeGeometries(trimParts, false), unlitMaterial({ vertexColors: true }));
    trimParts.forEach((p) => p.dispose());
    roofNeon.name = 'garage-roof-neon';
  }

  // --- The sign: the taxi, or under `?depot=classic` the wrench -------------
  // Built at the top of this function, because the pole is placed off its bounds. Its own mesh and
  // its own pivot, for the reason the burger over the drive-through is one: it turns, and the
  // entrance wave cannot animate anything with a transform of its own. See `wrenchGeometry` for why
  // the pivot sits on the kerb rather than at the sign's centre.
  //
  // The vehicles' **metal** finish (FINISH_DEFAULTS in util/geo.js): a darkened base, a tight sun
  // glint and a share of the sky and skyline in it. That last is what makes it steel rather than
  // grey paint — and since it turns, the glint walks round the chamfer once a revolution. Under
  // Crayon and Cartoon `gloss` is declined and this is an ordinary prop, as the cars are.
  //
  // **Out of the AO lookup**, and that is the rule in `markOccluder` rather than a preference. It
  // refuses to put this mesh in the depth prepass and so does main.js — but *receiving* is the
  // default, so left alone it samples the occlusion of whatever is behind it on screen. The dish
  // that stood here did exactly that and came out with a soft dark blotch of its own roof's crease
  // across it, moving with the camera.
  // The cutout is painted board, so it takes no gloss; the other two are metal and a car.
  const gloss = style === 'classic' ? { geometry: signGeo, mirror: WRENCH_MIRROR }
    : style === 'model' ? { geometry: signGeo, amount: TAXI_SIGN_GLOSS, mirror: TAXI_SIGN_MIRROR }
      : null;
  const sign = new THREE.Mesh(signGeo, propMaterial({ ao: false, gloss }));
  sign.castShadow = true;
  sign.name = 'garage-sign';

  const signPivot = new THREE.Group();
  signPivot.name = 'garage-sign-pivot';
  signPivot.position.set(poleX, KERB_H, poleZ);
  // Seeded rather than zero, the same as the burger's: shot mode ticks once and freezes, so a
  // sign that started edge-on would be edge-on in every screenshot of every city.
  signPivot.rotation.y = rand * Math.PI * 2;
  signPivot.add(sign);

  // The cutout's board, on its own material for one reason: a lift of its own yellow. Facing the
  // camera, the board's face is lit only when the sun is round that side, and for much of the day
  // it is not — and in shadow the taxi's yellow goes lilac under the shadow tint, which is the one
  // thing this sign must not do. A sign is lit, so this one is: an emissive share of its own paint,
  // on the board only, so the glass and tyres stuck through it stay dark.
  let board = null;
  if (paintGeo) {
    const paintMat = propMaterial({ ao: false });
    paintMat.emissive.set(color('taxiBody')).multiplyScalar(BOARD_LIFT);
    board = new THREE.Mesh(paintGeo, paintMat);
    board.castShadow = true;
    board.name = 'garage-board';
    signPivot.add(board);
  }

  // The neon, unlit: full colour whatever the sun is doing, which is what lets it read by day, and
  // put in the bloom by main.js so it glows at night. Its own mesh for both reasons.
  let neon = null;
  if (neonGeo) {
    neon = new THREE.Mesh(neonGeo, unlitMaterial({ vertexColors: true }));
    neon.castShadow = true;
    neon.name = 'garage-neon';
    signPivot.add(neon);
  }
  // The painted flame — see FLAME_PROUD for why unlit and why not in the bloom.
  let flame = null;
  if (flameGeo) {
    flame = new THREE.Mesh(flameGeo, unlitMaterial({ vertexColors: true }));
    flame.castShadow = true;
    flame.name = 'garage-sign-flame';
    signPivot.add(flame);
  }
  // The chase and the stutter. Seeded off the block like the sway, and the stutter's timing off a
  // hash of how many there have been, so a run replays the same.
  const neonColor = color('depotNeon');
  let chase = rand;
  let flickers = 0;
  let flickerAt = THREE.MathUtils.lerp(FLICKER_GAP[0], FLICKER_GAP[1], hash01(rand, 0.5));
  let clock = 0;
  function runNeon(dt) {
    clock += dt;
    chase = (chase + CHASE_RATE * dt) % 1;
    let level = 1;
    if (clock > flickerAt) {
      const into = clock - flickerAt;
      if (into > FLICKER_LEN) {
        flickers++;
        flickerAt = clock + THREE.MathUtils.lerp(FLICKER_GAP[0], FLICKER_GAP[1], hash01(flickers, rand));
      } else {
        // A few uneven blinks rather than a fade: on or dimmed, switching every 50ms or so.
        level = hash01(Math.floor(into / 0.05), flickers + rand) < 0.5 ? FLICKER_DIM : 1;
      }
    }
    const lap = neonGeo.userData.lap;
    const col = neonGeo.attributes.color;
    const a = col.array;
    for (let i = 0; i < lap.length; i++) {
      let d = Math.abs(lap[i] - chase);
      d = Math.min(d, 1 - d) / CHASE_WIDTH;
      const hot = Math.exp(-d * d);
      const k = (CHASE_BASE + (1 - CHASE_BASE) * hot) * level;
      const w = CHASE_WHITE * hot * level;
      a[i * 3] = neonColor.r * k + w;
      a[i * 3 + 1] = neonColor.g * k + w;
      a[i * 3 + 2] = neonColor.b * k + w;
    }
    col.needsUpdate = true;
  }
  if (neonGeo) runNeon(0);
  // The sway's phase, seeded for the same reason the spin's start is.
  let phase = rand * Math.PI * 2;
  const swing = () => { signPivot.rotation.y = CUT_FACING + CUT_SWAY * Math.sin(phase); };
  if (neonGeo) swing();

  const group = new THREE.Group();
  group.add(shell, curtain, light, signPivot);
  if (roofNeon) group.add(roofNeon);

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

  /** Turn the sign. One rotation and no state, so a paused frame simply stops being advanced. */
  function update(dt, spin = DEPOT_SPIN) {
    if (neonGeo) {
      phase += CUT_SWAY_RATE * dt;
      swing();
      runNeon(dt);
      return;
    }
    signPivot.rotation.y += spin * dt;
  }

  // Geometry only: `switchedLights` turns these into the mesh, in main.js.
  const litWindows = officeWindows.map(([wx0, wx1], k) => ({
    geo: span(wx0 + LIT_INSET, wx1 - LIT_INSET, winY0 + LIT_INSET, winY1 - LIT_INSET,
      glassZ, glassZ + LIT_PROUD, color(k ? 'litPale' : 'litWarm')),
    at: THREE.MathUtils.lerp(LIT_AT[0], LIT_AT[1], hash01(wx0, rand)),
    x: (wx0 + wx1) / 2,
    z: glassZ,
  }));

  return {
    site,
    group,
    shell,
    curtain,
    /** The office's lit panes, as `{ geo, at, x, z }` for `switchedLights`. */
    litWindows,
    light,
    sign,
    signPivot,
    /** The cutout's yellow board and its neon tube; null on the other two signs. */
    board,
    neon,
    /** The cutout's painted tailpipe flame; null under `?signflames=classic` and on the other signs. */
    signFlame: flame,
    /** The roofline neon; null under `?depotneon=classic`. */
    roofNeon,
    /** The sign's centre, in world y — where the pole stops. */
    hub,
    update,
    /**
     * The two stamped meshes, for the entrance wave and for the AO prepass — and **not** the sign,
     * which is neither: the wave's vertex shader cannot reach a turning object, and a mesh whose
     * matrix changes every frame has no business writing into a screen-space occlusion buffer.
     */
    meshes: roofNeon ? [shell, curtain, roofNeon] : [shell, curtain],
    setDoor,
    /** ...so the sign grows on the CPU instead, on the shell's own delay. */
    entryObject: { object: signPivot, x: anchorX, z: anchorZ, rand },
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
// --- NO PARKING ---------------------------------------------------------------
// Stencilled on the forecourt between the guide lines, stacked the way road lettering is. A pixel
// font of `NO_PARK_GLYPHS` cells, each its own flat span at PAINT_Y like the lines beside it.
//
// It reads *from the camera*, not from the street: a letter's up is −x (into the bay) and the line
// runs toward −z, which is up-screen and to the right — the same diagonal the forecourt itself lies
// on. The room is fixed by everything around it: 1.5 units of flat between the door frame and
// where the dropped kerb falls (`KERB_RUN`), and 3.8 between the guide lines. PARKING is 33 cells
// wide, so a cell is 0.1 across and 0.11 tall, and the two lines take 1.3 of the 1.5.
//
// At play zoom (7.7 px a unit) a cell is under a pixel: the word is a smudge of lettering that
// resolves as you pinch in, which is about what worn paint on a driveway is.
const NO_PARK_GLYPHS = {
  N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
  O: ['.XX.', 'X..X', 'X..X', 'X..X', '.XX.'],
  P: ['XXX.', 'X..X', 'XXX.', 'X...', 'X...'],
  A: ['.XX.', 'X..X', 'XXXX', 'X..X', 'X..X'],
  R: ['XXX.', 'X..X', 'XXX.', 'X.X.', 'X..X'],
  K: ['X..X', 'X.X.', 'XX..', 'X.X.', 'X..X'],
  I: ['XXX', '.X.', '.X.', '.X.', 'XXX'],
  G: ['.XXX', 'X...', 'X.XX', 'X..X', '.XXX'],
};
const NO_PARK_CELL_Z = 0.1;
const NO_PARK_CELL_X = 0.11;
const NO_PARK_LEADING = 0.2;     // between the two lines
// How far the paint has worn back toward the pavement it is laid on. No per-cell jitter: that
// would draw from the depot's rng and reshuffle everything built after it.
const NO_PARK_FADE = 0.3;
/** The lettering's paint, exported so the probe can tell it from the paving it is laid on. */
export const NO_PARK_INK = color('drivewayPaint').lerp(color('sidewalk'), NO_PARK_FADE);

function noParking(xTop, xBottom, zMid) {
  const ink = NO_PARK_INK;
  const lineH = 5 * NO_PARK_CELL_X;
  const block = 2 * lineH + NO_PARK_LEADING;
  // Centred in the flat between the frame and the top of the ramp.
  let rowX = (xTop + xBottom) / 2 - block / 2;
  const parts = [];
  for (const word of ['NO', 'PARKING']) {
    const cells = [...word].reduce((n, ch) => n + NO_PARK_GLYPHS[ch][0].length, 0) + word.length - 1;
    // The first letter sits at the high-z end: −z is the reading direction.
    let z = zMid + (cells * NO_PARK_CELL_Z) / 2;
    for (const ch of word) {
      const glyph = NO_PARK_GLYPHS[ch];
      glyph.forEach((row, r) => [...row].forEach((on, c) => {
        if (on !== 'X') return;
        const x0 = rowX + r * NO_PARK_CELL_X;
        const z1 = z - c * NO_PARK_CELL_Z;
        parts.push(span(x0, x0 + NO_PARK_CELL_X, APRON_Y, PAINT_Y, z1 - NO_PARK_CELL_Z, z1, ink));
      }));
      z -= (glyph[0].length + 1) * NO_PARK_CELL_Z;
    }
    rowX += lineH + NO_PARK_LEADING;
  }
  return parts;
}

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
