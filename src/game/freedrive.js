/**
 * Free driving: the taxi as a body with a heading and a speed, steered straight off the stick, with
 * no lane, no queued turn and no hold line (Tyler, 2026-11-24: "what's the maximalist version that
 * just uses real physics down the taxi and no on rails stuff? Like fully responsive to the
 * joystick?"). The default under the stick; `?steer=rails` puts back the Pac-Man queue.
 *
 * **The taxi leaves the traffic model.** `taxi.free` takes it out of every simulation loop on a
 * staged car's terms (sim/traffic.js) and this module owns `x`, `z`, `yaw` and `v`. What it keeps:
 * the render pass (suspension, wheels, the bridge's pitch), the collision detector (which reads
 * exactly those four) and the fare loop (which arrives by position). What it gives up is everything
 * that was lane arithmetic: signals do not bind it, cars behind do not queue for it, and the lane
 * moves — the overtake, the U-turn, the drift, the bridge hop — have nothing to stand on.
 *
 * **The stick is a heading.** Its screen direction is turned back into a ground direction through
 * the live camera, so the taxi goes where the thumb points *on screen*. Hands off, it holds its
 * heading and keeps rolling at cruise; Loco is the fast pedal and the brake is the brake.
 *
 * **It has weight.** The first cut swung the nose as fast as the stick asked and let the direction
 * of travel ease after it, and that read as "ice skating... missing all its weight and momentum"
 * (Tyler): a lag proportional to the error is a car that is *always* sliding a little. Now the body
 * carries a velocity. The tyres hold it sideways up to `LAT_GRIP` and no further, so it tracks its
 * nose until it is asked for more than they have, and only then slides; the swing itself has
 * inertia (`YAW_LAG`) and is capped by what the grip can turn at that speed, so at Loco the car
 * runs wide where at cruise it turns in; and a hard turn above cruise scrubs speed off.
 *
 * **Streets are diagonals, so the heading gets a magnet.** Every street lies ~29° off the
 * horizontal on screen, and a thumb cannot hold that to a degree: without help the taxi ground
 * along a kerb down every straight. A push within `ASSIST` of a street's direction is that street's
 * direction, and a hands-off heading that close settles onto it. Anything wider is the player's own
 * angle. `?freeassist=off` drives it raw.
 *
 * **Buildings, water and the coast stop it; kerbs do not, and nothing it slides along slows it.**
 * It drives anywhere on the island a building is not standing — pavements, plazas, parks — up the
 * kerb (`kerbLift`). The body is a circle of `bodyR` and the world is one signed distance field
 * (`createCollider`): the road corridors, unioned with the open ground (inside the ring road, off
 * the river), less one box per cluster of buildings, every seam blended round with a smooth min/max.
 * A contact pushes the body out along the field's normal and takes away only the velocity going
 * *into* the wall: what runs along it is kept whole, and the nose swings to follow it. Tyler on the
 * first wall model (a point test against the half-unit building raster, with an axis fallback and
 * a scrape that kept half the speed per second): "the car just comes to a grinding halt... it should
 * just feel like ice." The raster gave every wall a staircase edge to catch on, and every catch
 * cost speed — hence boxes, the smooth field, and no friction.
 *
 * **It still tells the city where it is.** Each frame the nearest lane running the taxi's way is
 * written to `taxi.lane`/`s`/`d`/`i`/`j`, which is what the router, the cops and the scripted trips
 * (the garage, the drive-through, the race) plan from — and what the traffic model picks the car up
 * on when one of those takes the wheel back (`taxi.free = false`).
 */
import { cityNetwork } from '../city/roadnet.js';
import { SPEED } from '../sim/traffic.js';
import { GRID_I, GRID_J, lineX, lineZ, riverBanks } from '../city/grid.js';

// Top speed with Loco held, in u/s, when main.js does not pass the game's own (`boostCruise`). The
// first cut ran 15 on the theory that a thumb aims worse than a lane; Tyler: "too slow".
export const FREE_LOCO_SPEED = 18.7;
const ACCEL = 9;
const BRAKE = 24;
// Coming down from Loco to cruise, in u/s². It was 7, which with the boost's one-second tail on top
// (`locoHeld` below) kept the taxi at Loco for ~2.5s after the thumb came up — Tyler: "when you're
// holding it, it's on. When you're letting go, it's off." 30 is Loco to cruise in ~0.35s.
const COAST = 30;
// The gas pedal (`gasPedal`): with neither pedal down the car rolls to a stop at this, in u/s² —
// 18.7 to nothing in ~6s, a car off the throttle rather than one with the brake on.
const ROLL = 3;
// ...and pulling away on the gas, in u/s²: 0 to Loco's top in ~1.6s.
const GAS_ACCEL = 12;
// Reverse: hold the brake once the car has stopped, and after `REVERSE_DELAY` seconds it backs up,
// to `REVERSE_SPEED` u/s at `REVERSE_ACCEL` (Tyler, 2026-11-25: nosed into a building, "I can't back
// up in any way"). Half cruise, so it is for getting out of a corner and not a way to drive. The
// delay is what keeps a brake held to *stop* from rolling backwards the instant the car does.
const REVERSE_DELAY = 0.3;
const REVERSE_SPEED = 4;
const REVERSE_ACCEL = 6;
// The drift (Tyler, 2026-11-25: "some drifting?"): steering at speed, a tap of the brake — the
// game's own drift gesture, a thumb sliding off the gas onto the brake and back (game/pedals, "The
// pedal slide") — breaks the rear loose. While it lasts the tyres take a sideways slide back at
// `DRIFT_GRIP` instead of `LAT_GRIP`, so turning the nose leaves the car travelling the old way and
// it goes round the corner sideways; the nose may swing `DRIFT_TURN` times as fast; and it costs
// `DRIFT_SCRUB` of speed a second. It ends when the stick stops asking for a turn for
// `DRIFT_UNWIND` seconds, when the car slows under `DRIFT_END_V`, on a wall, or on the next brake.
const DRIFT_TAP = 0.4;          // longest press that counts as a tap, seconds
const DRIFT_MIN_V = 10;         // slowest it starts at, u/s
const DRIFT_END_V = 6;
const DRIFT_GRIP = 9;           // u/s², against LAT_GRIP 46
const DRIFT_TURN = 1.4;
const DRIFT_SCRUB = 2;          // u/s²
const DRIFT_UNWIND = 0.35;
// The stick is asking for a turn: the heading it wants is this far off the nose, radians, or the
// nose is already swinging this fast, rad/s.
const ASK_OFF = 0.15;
const ASK_SPIN = 0.6;
// Under this the car counts as stopped, for starting the reverse clock, in u/s.
const STOPPED_V = 0.3;
// Sideways grip, in u/s² — the lateral acceleration the tyres can give before the car slides.
// 38 took 0.98s and 15.9 units to bring a quarter turn round at full Loco; 46 takes 0.83s and 13.5.
const LAT_GRIP = 46;
// How sharp the taxi can turn is two turning circles, in units of radius (Tyler, 2026-11-25, on the
// five sliders that used to share the job: "can we simplify that lol"). `TURN_TIGHT` is the tightest
// it will ever turn, which is what it does at low speed; above that the circle grows with the
// square of the speed, the way a car's grip-limited circle does, reaching `TURN_TOP` at top speed:
// `R(v) = max(TURN_TIGHT, TURN_TOP · (v / top)²)`. The nose then swings at `v / R(v)`, so:
// - a stopped car cannot pivot (Tyler: "you shouldn't be able to turn / pivot the car when standing
//   still... how easy you turn should ramp up a little w/ speed"), and steering builds in with speed;
// - at cruise the circle is ~2.9, and at full Loco 19 — the same as the five-slider model gave at
//   its tuned values (2.8 and 19.7), which this replaces: `turnMax` 3.2 rad/s, `turnRadius` 2.6, a
//   grip cap of `latGrip · 0.9 / v`, and `steerAtTop` 0.6 scaling the lot near top speed.
const TURN_TIGHT = 2.6;
const TURN_TOP = 19;
// The speed a stopped car's turn rate is paid for at, as if it were moving: 0, no pivoting. It was
// 3, which let a parked taxi spin at 1.15 rad/s. Kept as a tune for the tools; not on the panel.
const TURN_FLOOR_V = 0;
// The swing the turn may never exceed whatever the circles say, in rad/s — a backstop against a tiny
// circle at speed, not a tuning knob. And the walls' own turn (`WALL_TURN`) is faster than it.
const TURN_MAX = 4;
// How hard the swing chases the stick (rad/s per radian of error), and the swing's own inertia: the
// time constant its rate takes to build and to die, in seconds.
const TURN_GAIN = 8;
const YAW_LAG = 0.11;
// Speed a full-rate turn scrubs off above cruise, in u/s².
const TURN_SCRUB = 7;
// The heading magnet: a push this close to a street's direction is that direction, in radians.
const ASSIST = (16 * Math.PI) / 180;
// ...and free driving's default, in degrees: wider, because in the ¾ view the street magnet and road
// keeping work together, and with the tilt corrected out the streets are a clean 90° apart on the
// stick, so ±22° still leaves 46° of free heading between two streets.
const ASSIST_FREE = 22;
// ...and how fast a hands-off heading that close settles onto it, per second.
const SETTLE = 3;
// How far up the taxi rides on a pavement, and how fast it climbs, per second.
const KERB_H = 0.35;
const KERB_RATE = 12;
// The body: a circle this wide in radius, in units. The taxi is 2 across and ~4 long as drawn; at
// 1.1 the nose stops a few tenths short of a wall it meets square on, and the flanks clear it.
const BODY_R = 1.1;
// How round the seams of the field are, in units (the `k` of a polynomial smooth min/max): where a
// bridge leaves the bank, where the ring road meets the coast, between a building box and the river.
const WALL_SMOOTH = 2;
// Buildings whose footprints come within this of each other share one box, in units: an alley
// narrower than the car is a notch to catch on, not a way through.
const MERGE_GAP = 3;
// Turn steering (`turnSteer`): a full sideways push asks for this much
// heading off the nose, in radians — times TURN_GAIN it is past every rate cap, so a full push is a
// full-rate turn and a half push about half of one.
const REL_SPAN = 0.6;
// The stick's full travel, in its CSS px (game/joystick.js, KNOB_TRAVEL).
const REL_TRAVEL = 34;
// Speed kept per second of sliding along a wall: 1 is ice.
const WALL_KEEP = 1;
// A wall met at a slant turns the nose along itself, this fast in rad/s — faster than the stick can
// turn it back in (`TURN_MAX`), so a push held into a wall settles a few degrees off it and slides
// at nearly full speed instead of grinding.
const WALL_TURN = 7;
// How a contact spends speed. Projecting the velocity onto the wall would keep `cos` of the angle —
// and a nose still pointing in pays it again on every frame until it has swung round, which is the
// grinding halt over again (at 45°: ~0.35 of the speed left by the time the nose is along the wall).
// So a hit within this cosine of the wall's own direction (60°) keeps all of its speed, redirected
// along the wall, and only a squarer one gives it up, down to nothing head-on.
const WALL_GLANCE = 0.5;

/**
 * Every number above as one live object, which is what `update` reads — so the Drive panel
 * (game/drivetune.js) can move any of them mid-run. These are the defaults; a fresh copy goes to
 * each instance unless the caller hands one in. `cruise` is the traffic model's own `SPEED` and
 * `loco` null means "whatever main.js's `locoSpeed` says" (the game's `boostCruise`). Angles in
 * the panel's units: `assistDeg` in degrees.
 */
// Tyler's values off the Drive panel (2026-11-25), where they differ from the constants above —
// which keep the measured first cut, and what the comments beside them describe:
// - `loco` 24.2, a fixed top speed rather than following the game's own Loco top (22.1);
// - `turnTight` 3.6 and `turnTop` 6.5: the circle opens from 3.6 units at town speed to 6.5 flat
//   out, 3.7 rad/s at 24.2 u/s — just under `TURN_MAX`, so the circle and not the backstop holds it;
// - `turnGain` 30 and `yawLag` 0.01, a nose that is where the stick says almost at once;
// - `relSpan` 1.6 and `steerCurve` 3 (Turn steering only), a soft centre to a full push;
// - the street magnet off (`assistDeg` 0, `settle` 0, measured on the ground), lane assist doing
//   the holding instead;
// - `wallTurn` 2.5, gentler than the stick's own turn, and `gasAccel` 16.5;
// - `brake` 27, harder than the first cut's 24;
// - cruise and Loco rather than the gas pedal (`gasPedal` 0 — the second set of values went back);
// - reverse at 8 u/s with no hold (`reverseDelay` 0): stopped with the brake held, it backs at once.
export const FREE_TUNING = Object.freeze({
  cruise: SPEED, loco: 24.2, accel: ACCEL, brake: 27, coast: COAST,
  latGrip: LAT_GRIP, turnTight: 3.6, turnTop: 6.5, turnFloorV: TURN_FLOOR_V,
  turnGain: 30, yawLag: 0.01, turnScrub: TURN_SCRUB,
  relSpan: 1.6, steerCurve: 3, assistDeg: 0, settle: 0,
  wallTurn: 2.5, wallKeep: WALL_KEEP, bodyR: BODY_R, wallSmooth: WALL_SMOOTH, kerbH: KERB_H,
  // Switches, as 0/1 so the panel's store keeps them with the numbers. `turnSteer`: the stick turns
  // the car (left is the car's left) rather than pointing it where the stick points on screen.
  // `invertSteer`: the stick's sideways push is mirrored, in either style (Tyler, 2026-11-25: "can
  // we try inverting the yoke? It feels like sometimes I'm pushing the opposite direction").
  turnSteer: 0, invertSteer: 0,
  // `gasPedal`: no cruise. Loco's pedal is the gas (to `loco`, at `gasAccel`), the brake is the
  // brake, and hands off the car rolls to a stop at `roll` (Tyler, 2026-11-25: "get rid of the auto
  // cruise... just have a simple gas brake... where you're fully in control of the car"). Off, it
  // is the cruise-and-Loco model: hands off holds `cruise`, Loco is a boost on top.
  gasPedal: 0, gasAccel: 16.5, roll: ROLL,
  // Brake-to-reverse (`REVERSE_*`): the speed, the pull-away, and the hold before it engages.
  reverseSpeed: 8, reverseAccel: REVERSE_ACCEL, reverseDelay: 0,
  // The drift (`DRIFT_*`): 0/1 for whether a brake tap starts one, the grip while sliding, how much
  // faster the nose may swing, and the slowest it starts at.
  drift: 1, driftGrip: DRIFT_GRIP, driftTurn: DRIFT_TURN, driftMinV: DRIFT_MIN_V,
  // The ¾ view's stick: how much of the camera's tilt a push undoes — see `screenToGround`. 0 puts
  // the streets on the stick's diagonals; 1 is the push read exactly as drawn (the first cut).
  stickCorrect: 0,
  // ...and where the street magnet's `assistDeg` is measured: 1 on the stick (`stickMagnet`), the
  // same width of thumb for every street; 0 on the ground, the first cut.
  magnetOnStick: 0,
  // Lane assist (`laneAssist`): how strongly it holds the lane, 0..1; how far ahead it aims, in
  // seconds of travel; the most it may bend the heading, degrees; how far off a lane it still
  // reaches, units; and the window round a street's direction it works in, degrees.
  laneAssist: 0.8, laneLook: 0.9, keepMax: 15, keepReach: 6.5, laneWindow: 25,
  // ...and how hard it steers for its aim with the stick let go, rad/s per radian.
  laneRate: 2.5,
});

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Distance from (x, z) to segment a→b, and how far along it the nearest point is (0..1).
 */
function toSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  return { dist: Math.hypot(x - (ax + dx * t), z - (az + dz * t)), t };
}

/** Polynomial smooth minimum: `min(a, b)` with the crease rounded over a width of `k`. */
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a, b, k) => -smin(-a, -b, k);

/** Signed distance from (x, z) to an axis-aligned box: negative inside. */
function boxDistance(x, z, b) {
  const qx = Math.abs(x - b.cx) - b.hx;
  const qz = Math.abs(z - b.cz) - b.hz;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
}

/**
 * One box per cluster of buildings, off a height field from `buildHeightField` (game/sightline.js).
 * Cells taller than `minH` are flood-filled into footprints, each footprint becomes its bounding box,
 * and boxes within `gap` of each other merge — so an L-shaped building is one box, two buildings with
 * a car-width alley between them are one box, and no wall has a cell's staircase on it.
 *
 * @returns `[{ cx, cz, hx, hz }]`, centre and half-extents
 */
export function buildingBoxes(field, { minH = 1.2, gap = MERGE_GAP } = {}) {
  if (!field) return [];
  const { nx, nz, cell, heights, x0, z0 } = field;
  const seen = new Uint8Array(nx * nz);
  let boxes = [];
  const stack = [];
  for (let start = 0; start < nx * nz; start++) {
    if (seen[start] || heights[start] <= minH) continue;
    let i0 = Infinity; let i1 = -Infinity; let j0 = Infinity; let j1 = -Infinity;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      const ci = Math.floor(c / nz);
      const cj = c % nz;
      if (ci < i0) i0 = ci; if (ci > i1) i1 = ci;
      if (cj < j0) j0 = cj; if (cj > j1) j1 = cj;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const n = ni * nz + nj;
        if (seen[n] || heights[n] <= minH) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    boxes.push({ x0: x0 + i0 * cell, x1: x0 + (i1 + 1) * cell, z0: z0 + j0 * cell, z1: z0 + (j1 + 1) * cell });
  }
  // Merge until nothing is within `gap` of anything else. A merge can bring a third box into range,
  // hence whole passes until one merges nothing. Each pass grows a box in place and keeps scanning
  // from it, rather than restarting the scan after every merge — that version was O(n³) over the
  // raster's footprints and held the boot up.
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < boxes.length; a++) {
      const A = boxes[a];
      for (let b = boxes.length - 1; b > a; b--) {
        const B = boxes[b];
        const dx = Math.max(A.x0 - B.x1, B.x0 - A.x1, 0);
        const dz = Math.max(A.z0 - B.z1, B.z0 - A.z1, 0);
        if (dx * dx + dz * dz >= gap * gap) continue;
        A.x0 = Math.min(A.x0, B.x0); A.x1 = Math.max(A.x1, B.x1);
        A.z0 = Math.min(A.z0, B.z0); A.z1 = Math.max(A.z1, B.z1);
        boxes[b] = boxes[boxes.length - 1];
        boxes.pop();
        merged = true;
      }
    }
  }
  boxes = boxes.map((b) => ({ cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, hx: (b.x1 - b.x0) / 2, hz: (b.z1 - b.z0) / 2 }));
  return boxes;
}

/**
 * Where the taxi can be, as a signed distance field: `distance(x, z)` is how far (x, z) is from the
 * nearest thing it cannot drive into, negative inside one. Free space is the road corridors (which is
 * what carries it over a bridge) unioned with the open ground — inside the ring road and off the
 * river — less the building boxes. Unions are a smooth max and differences a smooth min, both over
 * `smooth()`, so every corner where two of those meet is rounded and nothing has a crease to catch
 * on. `onRoad(x, z)` is the corridors alone (the kerb lift), and `inside(x, z)` is `distance >= 0`.
 *
 * @param boxes   `[{ cx, cz, hx, hz }]` — `buildingBoxes`
 * @param smooth  () => the seams' rounding, in units
 */
export function createCollider(net = cityNetwork(), boxes = [], smooth = () => WALL_SMOOTH) {
  const segs = net.edges.map((e) => {
    const a = net.nodeById.get(e.a);
    const b = net.nodeById.get(e.b);
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: e.halfWidth };
  });
  const x0 = lineX(0);
  const x1 = lineX(GRID_I);
  const z0 = lineZ(0);
  const z1 = lineZ(GRID_J);
  /** Positive inside a road corridor: how far in from its edge. */
  const road = (x, z) => {
    let best = -Infinity;
    for (const s of segs) {
      const d = s.half - toSegment(x, z, s.ax, s.az, s.bx, s.bz).dist;
      if (d > best) best = d;
    }
    return best;
  };
  function distance(x, z) {
    const k = smooth();
    let ground = Math.min(x - x0, x1 - x, z - z0, z1 - z);
    const banks = riverBanks();
    if (banks) ground = smin(ground, Math.max(banks.z0 - z, z - banks.z1), k);
    let built = Infinity;
    for (const b of boxes) {
      const d = boxDistance(x, z, b);
      if (d < built) built = d;
    }
    if (built < Infinity) ground = smin(ground, built, k);
    return smax(road(x, z), ground, k);
  }
  /** The field's outward normal at (x, z), by central differences. */
  function normal(x, z) {
    const e = 0.05;
    const gx = distance(x + e, z) - distance(x - e, z);
    const gz = distance(x, z + e) - distance(x, z - e);
    const l = Math.hypot(gx, gz);
    return l > 1e-9 ? { x: gx / l, z: gz / l } : null;
  }
  return {
    distance,
    normal,
    onRoad: (x, z) => road(x, z) >= 0,
    inside: (x, z) => distance(x, z) >= 0,
    boxes,
  };
}

/**
 * The old name, for the tools: the corridors and the ground, with `solid` boxes. Kept so a probe that
 * only wants "is this drivable" does not have to know about the field.
 */
export const roadCorridors = (net = cityNetwork(), boxes = []) => createCollider(net, boxes);

/**
 * A ground direction for a screen direction: solve `s = wx·a + wz·b` for the two world axes as the
 * camera draws them. Returns a unit `{ x, z }`, or null for a degenerate projection.
 *
 * `correct` is how much of the camera's tilt to undo, 0..1. At 1 the push is read exactly as the
 * screen draws it. Below that the two axes are inverted as if the camera's vertical squash were
 * partly (at 0, wholly) taken out first — so at 0 the four streets sit on the stick's own diagonals,
 * 45° off each axis, with an even 1° of heading per 1° of thumb all the way round. At 1 the snap
 * window for a street that is drawn 28.6° off horizontal covers thumbs from 16.8° to 44.5°, so the
 * natural 45° push for it lands just outside, and the heading moves 1.83° per thumb degree near
 * horizontal against 0.55° near vertical (Tyler, 2026-11-25, "the steering controls and three-quarter
 * view are still not quite right"). The squash is solved from the two axes themselves — the factor on
 * screen y that makes them perpendicular — so nothing here knows the camera's angle.
 */
export function screenToGround(sx, sy, toScreen, correct = 1) {
  const { a, b } = stickBasis(toScreen, correct);
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;
  const wx = (sx * b.y - sy * b.x) / det;
  const wz = (a.x * sy - a.y * sx) / det;
  const l = Math.hypot(wx, wz);
  return l > 1e-9 ? { x: wx / l, z: wz / l } : null;
}

/**
 * The camera's vertical squash, from the two ground axes as drawn: the factor on screen y that
 * makes them square again. Two ways to ask, because each goes blind in one of the two views. The ¾
 * diagonal draws the axes mirror images of each other, so their *lengths* already agree and only
 * their angle carries the squash; a view turned square to the streets (the square ¾ debug view this
 * was written for, since removed) draws them along screen x and y, so they are already perpendicular
 * and only their lengths carry it. Whichever is better posed wins.
 */
export function viewSquash(toScreen) {
  const a = toScreen(1, 0);
  const b = toScreen(0, 1);
  const perp = a.x * b.x;
  const len = a.x * a.x - b.x * b.x;
  const s2 = Math.abs(perp) >= Math.abs(len)
    ? -(a.y * b.y) / perp
    : (b.y * b.y - a.y * a.y) / len;
  return Number.isFinite(s2) && s2 > 0 ? Math.sqrt(s2) : null;
}

/** The two world ground axes as the stick reads them: as drawn, less `correct` of the tilt. */
function stickBasis(toScreen, correct = 1) {
  const a = { ...toScreen(1, 0) };
  const b = { ...toScreen(0, 1) };
  const squash = viewSquash(toScreen);
  if (correct < 1 && squash != null) {
    const scale = (1 + (squash - 1) * Math.max(0, correct)) / squash;
    a.y *= scale;
    b.y *= scale;
  }
  return { a, b };
}

/**
 * The street a push snaps to, judged on the stick: the street axis whose stick direction (under
 * `correct`) is within `assist` of the push's own angle, or null. Measured here rather than on the
 * ground, every street gets the same width of thumb, centred on where the stick reads it — on the
 * ground the same ±16° covered ~28° of thumb at `correct` 1, lopsided round the street. At
 * `correct` 0 the two agree exactly, so this only changes anything between.
 */
export function stickMagnet(sx, sy, toScreen, correct = 1, assist = ASSIST) {
  const { a, b } = stickBasis(toScreen, correct);
  const thumb = Math.atan2(sy, sx);
  let best = null;
  let bestOff = assist;
  for (let q = 0; q < 4; q++) {
    const yaw = wrap(q * (Math.PI / 2));
    const wx = Math.cos(yaw);
    const wz = -Math.sin(yaw);
    const off = Math.abs(wrap(Math.atan2(wx * a.y + wz * b.y, wx * a.x + wz * b.x) - thumb));
    if (off <= bestOff) { bestOff = off; best = yaw; }
  }
  return best;
}

/** Pull a heading onto the nearest street axis if it is within `ASSIST` of one. */
export function magnet(yaw, assist = ASSIST) {
  const quarter = Math.PI / 2;
  const axis = Math.round(yaw / quarter) * quarter;
  return Math.abs(wrap(yaw - axis)) <= assist ? axis : yaw;
}

/**
 * @param taxi      the traffic model's taxi
 * @param stick     () => `{ dx, dy, len }` in CSS px while the stick is pushed past its dead zone, else null
 * @param toScreen  `(dx, dz) => { x, y }`, a world ground vector in screen pixels
 * @param live      () => boolean — the player has the wheel (not a scripted trip, a menu, a wreck)
 * @param assist    the heading magnet; false drives raw
 * @param boxes     the buildings, `[{ cx, cz, hx, hz }]` — `buildingBoxes` off main.js's height field
 * @param locoSpeed () => the top speed with Loco held
 * @param locoHeld  () => boolean — Loco's button is down. Not `taxi.boost`, which is `isEngaged`
 *                  and stays on through the boost's one-second tail (game/boost.js, BOOST_COOLDOWN):
 *                  that tail is for the rules (a crash still counts as a boosted one), not the speed
 *                  rather than naming a heading on screen
 * @param tune      the live numbers, a `FREE_TUNING` shape (default: a fresh copy of it)
 */
export function createFreeDrive({ taxi, stick, toScreen, live, assist = true, net = cityNetwork(),
  boxes = [], locoSpeed = () => FREE_LOCO_SPEED, locoHeld = () => taxi.boost,
  tune = { ...FREE_TUNING } }) {
  const roads = createCollider(net, boxes, () => tune.wallSmooth);
  const lanes = net.lanes.filter((l) => l.path).map((lane) => {
    const p0 = lane.path.at(0);
    const p1 = lane.path.at(lane.length);
    const d = net.dirOfLane(lane);
    const node = net.nodeById.get(lane.to);
    const l = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    return { lane, d, i: node.gi, j: node.gj, ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z,
      tx: (p1.x - p0.x) / l, tz: (p1.z - p0.z) / l };
  });
  let active = false;
  let x = 0;
  let z = 0;
  let yaw = 0;
  // Sideways speed, + to the taxi's left: what the tyres have not yet taken back. And the swing.
  let slip = 0;
  let spin = 0;
  // Where a staged taxi was standing on the frame it was let go, or null. See `begin`.
  let unstagedAt = null;
  let wasStaged = false;
  // How long the brake has been held on a stopped (or reversing) car, in seconds. See `update`.
  let reverseClock = 0;
  // The drift: on or not, the seconds the stick has not asked for a turn, and the brake's last
  // press — when it went down, and whether it was down last frame. See `update`.
  let drifting = false;
  let unwind = 0;
  let brakeDownAt = -1;
  let brakeWas = false;
  let clock = 0;
  // What the last frame decided, for the debug overlay (game/drivedebug.js): the push, its heading
  // read exactly as drawn and with the tilt correction, the street it snapped to, the lane road
  // keeping pulled toward and by how much, and the heading it finally steered for. Headings are yaw.
  const debug = { push: null, exact: null, corrected: null, snapped: null, keep: null, target: null,
    turnMode: false, assistRad: ASSIST };

  /**
   * Lane assist: a car roughly lined up with a street is drawn into the lane running that way, the
   * way a car's lane-keeping does — hands off, it holds the lane and will not wander onto a kerb or
   * into a wall; with the stick, it is a subtle pull the stick can overpower (Tyler, 2026-11-25:
   * "like there is a subtle magnet that's pulling the car into the lane (so if you don't steer, it
   * won't run up onto a curb or hit a wall)").
   *
   * It aims at the lane's centre `laneLook` seconds of travel ahead — the bend is the angle to that
   * point — so it closes the gap over the same *time* at any speed. The first cut bent the heading
   * by a fixed `roadKeep` radians per unit off centre, which at Loco closed a gap in a tenth of a
   * second, far faster than the nose can swing, and weaved; and it only ran on a heading the street
   * magnet had already snapped exactly onto the street, so with the magnet at 0° it never ran.
   *
   * It works within `laneWindow` of a street's direction and fades out across it: full on the
   * street, nothing at the window's edge, so a deliberate turn passes through it. `laneAssist`
   * scales the whole pull, 0 (off) to 1 (the heading is the aim point's). Only for a lane within
   * `keepReach` of the car, measured square to it, and never more than `keepMax` of bend.
   */
  function laneAssist(heading, speed, fade = true) {
    if (!(tune.laneAssist > 0)) return heading;
    const quarter = Math.PI / 2;
    const axis = Math.round(heading / quarter) * quarter;
    const off = Math.abs(wrap(heading - axis));
    const window = (tune.laneWindow * Math.PI) / 180;
    if (off >= window) return heading;
    const fx = Math.cos(axis);
    const fz = -Math.sin(axis);
    let best = null;
    for (const c of lanes) {
      if (fx * c.tx + fz * c.tz < 0.95) continue;
      // Square to the lane's line (left of travel is +), and how far past either end of it — through
      // a junction box the lane carrying on is still the one to keep to.
      const lat = (x - c.ax) * c.tz - (z - c.az) * c.tx;
      const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
      const along = (x - c.ax) * c.tx + (z - c.az) * c.tz;
      const past = Math.max(0, -along, along - len);
      if (Math.abs(lat) > tune.keepReach || past > tune.keepReach) continue;
      const score = Math.abs(lat) + past;
      if (!best || score < best.score) best = { lat, score, c };
    }
    if (!best) return heading;
    const cap = (tune.keepMax * Math.PI) / 180;
    // The aim point: on the lane's centre, this far ahead, never nearer than a car and a half. Left of
    // the centre is a turn to the right, which is -yaw.
    const ahead = Math.max(5, Math.abs(speed) * tune.laneLook);
    const aim = axis - Math.max(-cap, Math.min(cap, Math.atan2(best.lat, ahead)));
    // The fade is for a stick turning out of the lane on purpose; hands off there is no purpose to
    // let through, and fading on the car's own heading only weakened the pull back while the nose
    // was swinging across — 0.9 units of overshoot from a three-unit start at Loco.
    const share = Math.min(1, tune.laneAssist) * (fade ? 1 - off / window : 1);
    const out = wrap(heading + wrap(aim - heading) * share);
    debug.keep = { ax: best.c.ax, az: best.c.az, bx: best.c.bx, bz: best.c.bz, lat: best.lat,
      bend: wrap(out - heading), share };
    return out;
  }

  /** The lane the city should think the taxi is on: nearest, among those running its way. */
  function project() {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    let best = null;
    let bestScore = Infinity;
    for (const c of lanes) {
      const along = fx * c.tx + fz * c.tz;
      if (along < 0.25) continue;
      const hit = toSegment(x, z, c.ax, c.az, c.bx, c.bz);
      // A lane running the taxi's way beats a nearer one it is merely crossing.
      const score = hit.dist + (1 - along) * 6;
      if (score < bestScore) { bestScore = score; best = { c, t: hit.t }; }
    }
    if (!best) return;
    taxi.lane = best.c.lane;
    taxi.s = best.t * best.c.lane.length;
    taxi.d = best.c.d;
    taxi.i = best.c.i;
    taxi.j = best.c.j;
  }

  function begin() {
    active = true;
    x = taxi.x;
    z = taxi.z;
    yaw = taxi.yaw;
    // **A car just let go of a staged trip is not where its `x`/`z` say.** `releaseCar` puts it on
    // a lane by `lane`/`s` and leaves the pose for the traffic model's next update to derive — and
    // if this frame takes the car first, that update never comes. Skipping the opening is exactly
    // that: the skip releases the taxi from inside the garage, the wipe lifts, and free driving
    // picked it up at its staged spot 6.75 units back in the bay, behind a door `finish` had just
    // shut — a taxi that "never leaves the garage" (Tyler, 2026-11-25). Played through, the roll-out
    // drives the staged car out of the door first, which is why only the skip showed it. So: still
    // standing where it was released, it takes the pose of the lane it was released onto.
    if (unstagedAt && taxi.lane?.path && taxi.x === unstagedAt.x && taxi.z === unstagedAt.z) {
      const p = taxi.lane.path.at(taxi.s);
      const t = taxi.lane.path.tangentAt(taxi.s);
      x = p.x;
      z = p.z;
      yaw = Math.atan2(-t.z, t.x);
      taxi.x = x;
      taxi.z = z;
      taxi.yaw = yaw;
    }
    unstagedAt = null;
    slip = 0;
    spin = 0;
    taxi.free = true;
  }

  function end() {
    active = false;
    if (!taxi.free) return;
    project();
    taxi.free = false;
    taxi.kerbLift = 0;
  }

  function update(dt) {
    // Before the gate below: a release usually lands on a frame the player does not have the wheel.
    if (wasStaged && !taxi.staged) unstagedAt = { x: taxi.x, z: taxi.z };
    wasStaged = Boolean(taxi.staged);
    if (!live() || taxi.crashed || taxi.staged) { if (active) end(); return; }
    if (!active) begin();
    // Everything the rails' moves and offsets left on the car: a free taxi wears none of them.
    taxi.state = 'drive';
    taxi.turn = null;
    taxi.uturn = null;
    taxi.drift = null;
    taxi.lateral = 0;
    taxi.nudge = 0;
    taxi.pass = 0;
    taxi.passing = false;
    taxi.passOffset = 0;
    taxi.passSlope = 0;
    taxi.steer = 0;
    taxi.route = [];
    taxi.parked = false;

    // --- Speed along the nose. `taxi.v` is shared with the collision detector, which scrubs it.
    let v = taxi.v;
    const top = tune.loco ?? locoSpeed();
    const assistRad = (tune.assistDeg * Math.PI) / 180;
    // Reverse: the brake held on a stopped car starts a clock, and once it runs out the brake backs
    // the car up instead. Letting go of the brake ends it — the car rolls to a stop, or the gas
    // pulls it forward, braking out of the reverse first. A stall is no bar: backing out of what it
    // hit is the point. A stun is.
    const canReverse = taxi.braking && !(taxi.stun > 0) && tune.reverseSpeed > 0;
    const stoppedOrBacking = v < 0 || Math.abs(v) < STOPPED_V;
    if (canReverse && stoppedOrBacking) reverseClock += dt;
    else reverseClock = 0;
    // Stopped first, then the clock: with `reverseDelay` 0 (Tyler's) a clock that has not started
    // still reads 0 >= 0, and the brake at speed slowed the car at `reverseAccel` (6) instead of
    // `brake` (27) — 22 u/s took 3.7s to stop rather than 0.8.
    const reversing = canReverse && stoppedOrBacking && reverseClock >= tune.reverseDelay;
    if (reversing) taxi.stalled = false;
    const held = !reversing && (taxi.braking || taxi.stalled || taxi.stun > 0);
    const gas = Boolean(tune.gasPedal);
    const want = reversing ? -tune.reverseSpeed : held ? 0 : locoHeld() ? top : gas ? 0 : tune.cruise;
    if (reversing) {
      v = v > want ? Math.max(want, v - tune.reverseAccel * dt) : Math.min(want, v + tune.brake * dt);
    } else if (v < 0) {
      // Out of reverse: by the brake's rate when the gas is down, else rolling to a stop.
      v = Math.min(Math.max(want, 0), v + (want > 0 ? tune.brake : Math.max(tune.roll, 1)) * dt);
    } else if (v < want) v = Math.min(want, v + (gas ? tune.gasAccel : tune.accel) * dt);
    else v = Math.max(want, v - (held ? tune.brake : gas ? tune.roll : tune.coast) * dt);
    const backing = v < -1e-3;

    // --- Heading: the swing the stick asks for, capped by what the tyres can turn at this speed,
    // and reached through the swing's own inertia.
    const raw = stick();
    // Mirrored left to right when inverted. A heading on screen mirrors about the vertical; a turn
    // swaps left for right.
    const push = raw && tune.invertSteer ? { ...raw, dx: -raw.dx } : raw;
    let target = null;
    let stickJudged = false;
    debug.push = push;
    debug.exact = null;
    debug.corrected = null;
    debug.snapped = null;
    debug.keep = null;
    const turnMode = Boolean(tune.turnSteer);
    if (push && turnMode) {
      const raw = Math.max(-1, Math.min(1, push.dx / REL_TRAVEL));
      // `steerCurve` above 1 softens the middle of the stick and keeps the full push; below 1 sharpens it.
      const k = Math.sign(raw) * Math.abs(raw) ** tune.steerCurve;
      // Right on the stick is a turn to the right, which is -yaw.
      // Backing up, it steers as a car's wheel does in reverse: right swings the tail right, which
      // turns the nose left.
      if (Math.abs(k) > 0.05) target = wrap(yaw - (backing ? -k : k) * tune.relSpan);
    } else if (push) {
      const g = screenToGround(push.dx, push.dy, toScreen, tune.stickCorrect);
      if (g) target = Math.atan2(-g.z, g.x);
      // Backing up, the stick aims the tail: push where you want to back toward, and the nose
      // swings to point the other way. The magnet below works on either, the axes being symmetric.
      if (g && backing) target = wrap(target + Math.PI);
      const e = screenToGround(push.dx, push.dy, toScreen, 1);
      debug.exact = e ? Math.atan2(-e.z, e.x) : null;
      debug.corrected = target;
      if (g && assist && tune.magnetOnStick) {
        const snap = stickMagnet(push.dx, push.dy, toScreen, tune.stickCorrect, assistRad);
        if (snap != null) target = backing ? wrap(snap + Math.PI) : snap;
        stickJudged = true;
      }
    }
    // The two turning circles (`TURN_TIGHT`, `TURN_TOP`): the circle at this speed, and the swing
    // that drives it.
    // --- The drift: started by a tap of the brake while the stick asks for a turn at speed.
    clock += dt;
    const asking = (target != null && Math.abs(wrap(target - yaw)) > ASK_OFF) || Math.abs(spin) > ASK_SPIN;
    if (taxi.braking && !brakeWas) {
      brakeDownAt = clock;
      // A second press ends a drift — braking is braking.
      drifting = false;
    }
    if (!taxi.braking && brakeWas && tune.drift && clock - brakeDownAt <= DRIFT_TAP
      && v >= tune.driftMinV && asking && !taxi.stun) {
      drifting = true;
      unwind = 0;
    }
    brakeWas = Boolean(taxi.braking);
    if (drifting) {
      unwind = asking ? 0 : unwind + dt;
      if (unwind > DRIFT_UNWIND || v < DRIFT_END_V || backing) drifting = false;
    }
    const speed = Math.max(Math.abs(v), tune.turnFloorV);
    const circle = Math.max(tune.turnTight, tune.turnTop * (speed / Math.max(top, 1e-3)) ** 2);
    // (The turn rate is the speed's size, so a reversing car steers too — and a stopped one still not.)
    const rateCap = Math.min(TURN_MAX, speed / circle) * (drifting ? tune.driftTurn : 1);
    let wantSpin = 0;
    if (target != null) {
      if (assist && !turnMode && !stickJudged) target = magnet(target, assistRad);
      if (debug.corrected != null && target !== debug.corrected) debug.snapped = target;
      // Not backing up: lane assist steers toward the lane running the way the car is *going*.
      if (assist && !backing && !drifting) target = laneAssist(target, v);
      wantSpin = Math.max(-rateCap, Math.min(rateCap, wrap(target - yaw) * tune.turnGain));
    } else if (assist) {
      // Hands off: lane assist steers it into the lane at `laneRate`, or, off any lane, the street
      // magnet settles the heading onto a street at its own rate. Not at the stick's
      // `turnGain`: against the swing's own lag (`yawLag` 0.11s) a gain of 8 is a damping ratio of
      // ~0.55, and the first cut overshot its aim by 11° — which carried the nose out of the lane
      // window, let go of it, and ran the car diagonally onto the far kerb. 2.5 is ~0.95.
      const settleTo = magnet(yaw, assistRad);
      if (settleTo !== yaw) debug.snapped = settleTo;
      const lane = backing || drifting ? yaw : laneAssist(yaw, v, false);
      // Where there is a lane to hold, lane assist does the settling: the magnet pulling for the
      // street's exact direction fought it to a standstill (with `settle` 3 against 2.5 the nose sat
      // 5° off the street and took four seconds to close a lane's width).
      target = debug.keep ? lane : settleTo;
      wantSpin = Math.max(-rateCap, Math.min(rateCap,
        debug.keep ? wrap(lane - yaw) * tune.laneRate : wrap(settleTo - yaw) * tune.settle));
    }
    debug.target = target;
    debug.reverse = backing;
    debug.reverseClock = reverseClock;
    debug.turnMode = turnMode;
    debug.assistRad = assistRad;
    spin += (wantSpin - spin) * Math.min(1, dt / tune.yawLag);
    const turned = spin * dt;
    yaw = wrap(yaw + turned);
    // Turning the nose leaves the velocity where it was: what was forward is now partly sideways.
    // (Left is +yaw; a swing to the left leaves the car sliding to its right.)
    const c = Math.cos(turned);
    const sn = Math.sin(turned);
    [v, slip] = [v * c + slip * sn, slip * c - v * sn];
    // The tyres take the sideways part back, as fast as they grip and no faster.
    slip -= Math.sign(slip) * Math.min(Math.abs(slip), (drifting ? tune.driftGrip : tune.latGrip) * dt);
    if (drifting) v = Math.max(0, v - DRIFT_SCRUB * dt);
    // A hard turn above cruise costs speed.
    if (v > tune.cruise) v = Math.max(tune.cruise, v - tune.turnScrub * (spin / rateCap) ** 2 * dt);

    // --- Move, then push the body back out of anything it went into. Sub-stepped so a tuned-up
    // speed cannot tunnel through a thin strip of river.
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    // The taxi's left on the ground: (-sin yaw, -cos yaw).
    const lx = -Math.sin(yaw);
    const lz = -Math.cos(yaw);
    let wx = fx * v + lx * slip;
    let wz = fz * v + lz * slip;
    const R = tune.bodyR;
    const px = x;
    const pz = z;
    const speed0 = Math.hypot(wx, wz);
    const steps = Math.max(1, Math.ceil((speed0 * dt) / (R * 0.5)));
    let touched = null;
    for (let k = 0; k < steps; k++) {
      x += (wx * dt) / steps;
      z += (wz * dt) / steps;
      // A few passes: a push out of one wall can land in the rounded seam of the next.
      for (let pass = 0; pass < 4; pass++) {
        const d = roads.distance(x, z);
        if (d >= R) break;
        const n = roads.normal(x, z);
        if (!n) break;
        x += n.x * (R - d);
        z += n.z * (R - d);
        // Only what is going *into* the wall goes; what runs along it is kept whole.
        const into = wx * n.x + wz * n.z;
        if (into < 0) { wx -= into * n.x; wz -= into * n.z; }
        touched = n;
      }
    }
    const step = Math.hypot(x - px, z - pz);
    if (touched) {
      drifting = false;
      // Sliding: the tuned share of the speed per second (1 is ice), carried on the nose rather than
      // left as slip for the tyres to scrub — and the nose swings to follow the wall, picking
      // whichever way along it is nearer the way the car was pointing.
      const along = speed0 > 1e-6 ? Math.hypot(wx, wz) / speed0 : 0;
      const speed = speed0 * Math.min(1, along / WALL_GLANCE) * Math.pow(tune.wallKeep, dt);
      // Backing up, it slides tail first: the tangent nearer the tail, and the tail swung onto it.
      const dir = v < 0 ? -1 : 1;
      let tx = -touched.z;
      let tz = touched.x;
      if ((tx * fx + tz * fz) * dir < 0) { tx = -tx; tz = -tz; }
      const off = wrap(Math.atan2(-tz, tx) - (dir < 0 ? yaw + Math.PI : yaw));
      // The swing scales with how much of the motion ran along the wall: all of it at a glance,
      // none head-on — or a square hit would stop the car and then turn it along the wall and
      // drive it off, whichever way the rounding picked, with the stick still pushing straight in.
      const swing = tune.wallTurn * Math.min(1, along / WALL_GLANCE) * dt;
      yaw = wrap(yaw + Math.max(-swing, Math.min(swing, off)));
      v = speed * dir;
      slip = 0;
    }
    // Up the kerb onto anything that is not road.
    const lift = roads.onRoad(x, z) ? 0 : tune.kerbH;
    taxi.kerbLift += (lift - (taxi.kerbLift ?? 0)) * Math.min(1, KERB_RATE * dt);

    taxi.x = x;
    taxi.z = z;
    taxi.yaw = yaw;
    taxi.v = v;
    // Against the traffic model's cruise, not the tuned one: the engine note and the body roll read it.
    // Its size: backing up is not a negative engine note.
    taxi.speedFactor = Math.abs(v) / SPEED;
    // For the rubber and the screech (main.js `layRubber`): sliding sideways, and drifting.
    taxi.freeSlip = slip;
    taxi.freeDrift = drifting;
    debug.slip = slip;
    debug.drifting = drifting;
    taxi.travelled += step;
    project();
  }

  return {
    update,
    active: () => active,
    /** Put the body somewhere by hand (the tools). */
    place(nx, nz, nyaw) { x = nx; z = nz; yaw = nyaw; slip = 0; spin = 0; },
    /** The live numbers (`FREE_TUNING` shape): write to them and the next frame drives on them. */
    tune,
    drivable: roads.inside,
    /** The field itself (`distance`, `normal`), for the tools. */
    collider: roads,
    /** The last frame's steering decisions, for the debug overlay. */
    debug,
    /** The tools' view onto the stick: as `toScreen` draws it, through whichever camera steers. */
    toScreen,
  };
}
