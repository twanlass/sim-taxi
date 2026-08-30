import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import {
  ROAD_W, isXAxis, dirSign, lineX, lineZ, laneOffsetCoord, entryPoint, exitPoint, turnControl,
  nextIntersection, riverBanks,
} from '../city/grid.js';
import { deckHeightAt } from '../city/river.js';
import { DECK_SEGMENTS } from '../geometry/bridge.js';

/**
 * Draws the taxi's planned route as a band of paint laid down the lane it will drive.
 *
 * Without it the player has no way to tell whether their tap registered or which way the taxi
 * intends to go — the car just keeps driving and you find out at the next junction. Flight Control
 * makes the drawn path the entire interface, and the same reasoning applies here.
 *
 * It was a 2px hairline down the road *centreline* first, and that was wrong twice over. A route
 * on the centreline sits between the two lanes, so it never says which side of the road the taxi
 * is on — and the line was filleted against the taxi's own position, so the corner radius at the
 * next junction shrank as the car closed on it and the path visibly re-shaped every few metres.
 *
 * Now it follows the same lane centreline and the same junction arcs the car itself drives, at
 * lane width. Nothing ahead of the car depends on where the car is, so the band only ever gets
 * *shorter* from behind — it never re-shapes.
 *
 * A soft pulse of brightness rolls along the band toward the destination, so a glance tells you
 * which way the taxi is about to go without reading the road layout — a stationary wash of colour
 * reads as "a route exists", not "this is the direction of it". It rides the same `vDist`/`uLength`
 * fade already computed for the head and tail, so it never brightens past either end of the band.
 *
 * **The band is painted in the clock it is spending** (`setColor`, driven from `main.js` off the
 * fare the taxi is currently sent at). It was the taxi's own yellow for a long time, on the
 * grounds that the band belongs to the car rather than to the road — but the car is not the news.
 * A route only ever exists because a fare is draining somewhere at the end of it, and the band is
 * the longest, most visible object on the screen: it runs across half the city on a road the eye
 * is already following. Carrying the urgency there means the answer to "how much trouble am I in"
 * is on the way to the answer for "where am I going", instead of on a 29px crystal the player has
 * to look away to read. `PALETTE.routeLine` is still the fallback for a route with no fare behind
 * it — the recovery re-route, and a route drawn by hand from the debug panel.
 */

// The taxi drives one lane, so the band covers one lane: ROAD_W is both lanes.
//
// Not the full 4 units, though. A right turn's lane-to-lane arc has a radius of HALF_ROAD − LANE =
// 2, so at half-width 2 the inside edge of the band collapses to a point at every right turn and
// folds over itself — a translucent band folded on itself paints a visibly darker wedge. 0.85 of a
// lane leaves 0.3 units of inner radius, and reads as "in the lane" rather than "the whole lane".
const WIDTH = (ROAD_W / 2) * 0.85;
const HALF_WIDTH = WIDTH / 2;

// Both ends fade rather than stopping at an edge. A hard end at the taxi reads as a second object
// butted against the car; a hard end at the destination reads as a wall across the road.
//
// The head end holds off entirely first. The band is what the taxi is about to drive over, not
// something it is dragging, and paint emerging from under the bumper reads as the latter — so
// nothing is drawn for the first HEAD_GAP units. The taxi's nose is (CAR_LEN / 2) * TAXI_SCALE ≈
// 2.0 units ahead of its centre, which the path measures from, so 4 leaves a clear couple of units
// of bare road in front of the car before the fade even starts.
// Exported because `game/pathdrag.js` refuses a grab inside it: nothing is drawn here, and a band
// you cannot see is not one the player can have meant to take hold of.
export const HEAD_GAP = 4;
const FADE_HEAD = 6;
const FADE_TAIL = 10;

// Above the road paint (MARK_Y = 0.02) and below the cars (ROAD_Y = 0.04). Unlike the fare rings
// this is depth-tested, so traffic drives *over* the band instead of the band painting across
// every car it passes under — at 2px that didn't matter, at lane width it does.
const Y = 0.03;
// Exported because the drop-off's filled circle matches it: the band and the disc are the same
// statement ("this is the job") in two places, and they have to sit at the same weight over the
// road or one of them reads as louder than the other.
export const ROUTE_OPACITY = 0.38;

/**
 * How the band combines with the road under it. `additive` is the default: the road is dark and a
 * flat `normal` wash over it flattens the markings and kerbs the band crosses, where adding light
 * keeps them showing through. The rest stay switchable because which one reads best is a judgement
 * call about the whole frame — the ⚙️ panel switches between them live.
 *
 * The shader writes premultiplied colour, so `screen` and `additive` are alpha-weighted rather
 * than blowing out at full strength. `multiply` is the exception and shapes its own output: it
 * needs `mix(white, colour, alpha)` against a `dst * src` blend, since premultiplied black at low
 * alpha would just paint a hole.
 */
export const ROUTE_BLENDS = {
  normal: { blending: THREE.NormalBlending },
  additive: { blending: THREE.AdditiveBlending },
  screen: {
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcColorFactor,
  },
  multiply: {
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  },
};
export const ROUTE_BLEND_DEFAULT = 'additive';

// Junction arcs are sampled, straights are not — the fade is computed per fragment from a
// distance-along-the-path varying, so a 20-unit straight needs no interior vertices at all.
//
// **That stopped being true over the river, and the exception is worth stating rather than
// discovering.** The claim above holds while the only per-vertex data is `aDist`, which is linear
// along a straight and therefore interpolates exactly. Y is not: an arched deck is a `sin^2` hump,
// and a quad with vertices only at its two ends is a flat chord under it. Worse, the ends are the
// *exact* places the arch is zero — a junction arm is trimmed to the crossing road's half-width, so
// a bridge lane starts at `riverBanks().z0` and ends at `.z1`, and `deckHeightAt` returns 0.0 at
// both. The band is depth-tested on purpose (see `Y` below), so the chord did not merely look flat,
// it was swallowed by the deck and the route vanished mid-river.
//
// So straights are still not sampled, except across the channel, where `densifyOverWater` splits
// them. See it for why the split planes are fixed in the world.
const TURN_STEPS = 10;
const MAX_STEPS = 32;      // routed junctions; the longest route across a 5×5 is well under this
// Interior points a river crossing adds: the plane at each end is already a path point.
const DECK_STEPS = DECK_SEGMENTS - 1;
// Sized so that *every* step could be a crossing. Working out how many crossings a route can
// actually contain is the kind of cleverness that is right until the map changes, and the whole
// array is 47 KB at the generous size. Overrunning it is silent — writes past the end of a
// `Float32Array` are dropped, so the symptom is the far end of long routes going missing with
// nothing logged.
const MAX_POINTS = MAX_STEPS * (TURN_STEPS + DECK_STEPS + 1) + TURN_STEPS + 4;

const along = (d, p) => (isXAxis(d) ? p.x : p.z);

/** Point on the lane for direction d past junction (i, j), at travel-axis coordinate s. */
function lanePoint(d, i, j, s) {
  const lane = laneOffsetCoord(d, i, j);
  return isXAxis(d) ? { x: s, z: lane } : { x: lane, z: s };
}

const bezier = (a, c, b, t) => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  };
};

/**
 * Split any segment that crosses the channel at the deck's own facet boundaries.
 *
 * Without this the band has no vertices between the two abutments and cannot ride the arch at all
 * — see the note beside `TURN_STEPS`. The height itself is applied later, per vertex, in the
 * emitter; all this does is make sure there are vertices for it to be applied to.
 *
 * **The split planes are fixed in the world**, at fractions of the bank-to-bank span, and that is
 * load-bearing rather than incidental. The file's whole contract is that nothing ahead of the car
 * re-shapes as the car advances (see the header), so a subdivision measured as "every two units
 * from the head of the path" would slide the mid-span facets a little every frame and the hump
 * would crawl. Pinned to the banks, the points are the same points on every frame of the crossing
 * and the segment behind the car simply gets shorter.
 *
 * `DECK_SEGMENTS` rather than a count of its own: the deck is lofted in ten, and a ribbon whose
 * facet boundaries fall between the deck's own beats against it as the camera moves.
 *
 * Segments that do not reach the water are returned untouched, which is nearly all of them — and
 * the drawbridge, being flat, gets subdivided into ten collinear pieces and looks exactly as it did.
 * That is deliberate: a rule that asked "is this span arched" would have to be re-asked the day a
 * flat span is arched or an arched one flattened, and ten redundant points cost nothing.
 */
function densifyOverWater(pts) {
  const banks = riverBanks();
  if (!banks || pts.length < 2) return pts;
  const span = banks.z1 - banks.z0;

  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const dz = b.z - a.z;
    // Only a run *along* z can cross the channel. A bank road runs along x at a constant z outside
    // the banks, so it never trips this, and no other segment can be over the water: every
    // crossing without a bridge is a closed segment the router will not plan through.
    if (Math.abs(dz) > 1e-6) {
      const step = dz > 0 ? 1 : -1;
      const first = dz > 0 ? 1 : DECK_STEPS;
      for (let n = first; n >= 1 && n <= DECK_STEPS; n += step) {
        const z = banks.z0 + (span * n) / DECK_SEGMENTS;
        const t = (z - a.z) / dz;
        // Strictly between, so a plane landing on an existing point does not duplicate it.
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        out.push({ x: a.x + (b.x - a.x) * t, z });
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * The lane centreline the taxi will actually drive, from where it is now to its destination.
 *
 * Exported for `tools/probe.mjs`: "does the drawn path stay in the lane" and "does the part ahead
 * of the car stay put as the car advances" are both plain assertions on this array.
 */
export function routePath(car, route) {
  const pts = [];
  const push = (p) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) return;
    pts.push({ x: p.x, z: p.z });
  };
  // Straight-run points only: never step backwards along the direction of travel. A car can sit
  // fractionally past the entry point of the junction it is heading for (the same case that has
  // no `distToLine > 0` guard on the stop decision), and pushing the entry point then would kink
  // the band back through the car.
  const pushAhead = (p, d) => {
    const last = pts[pts.length - 1];
    if (last && (along(d, p) - along(d, last)) * dirSign(d) < 0.01) return;
    push(p);
  };

  let i = car.i;
  let j = car.j;
  let d = car.d;

  if (car.state === 'turn' && car.entry && car.control && car.exit) {
    // Mid-junction: pick the arc up where the car is on it. `car.i/j` still name the junction it
    // is turning *at*, and its routed step is already consumed, so the remaining route applies
    // from the junction after this one.
    //
    // `car.turnT` is a fraction of `car.turnLen`, which is the hold line's straight run-up
    // (`car.leadIn`, the crosswalk clearance `STOP_SETBACK` sits back from the junction boundary)
    // *plus* the arc — not a fraction of the arc alone. The render transform below in traffic.js
    // splits on that; this used to skip straight to `bezier(..., car.turnT)`, which treated the
    // run-up as already-curved distance and jumped the drawn band forward by a whole `STOP_SETBACK`
    // (~3.4 units) the instant a car committed to a turn. Invisible on the old static band, it
    // showed up as a pop once the pulse animation rode on top of it.
    const travelled = Math.min(car.turnT, 1) * car.turnLen;
    if (travelled < car.leadIn) {
      const t = travelled / car.leadIn;
      push({
        x: car.hold.x + (car.entry.x - car.hold.x) * t,
        z: car.hold.z + (car.entry.z - car.hold.z) * t,
      });
      push(car.entry);
      for (let s = 0; s <= TURN_STEPS; s++) push(bezier(car.entry, car.control, car.exit, s / TURN_STEPS));
    } else {
      const t0 = (travelled - car.leadIn) / (car.turnLen - car.leadIn);
      for (let s = 0; s <= TURN_STEPS; s++) {
        const t = t0 + (1 - t0) * (s / TURN_STEPS);
        push(bezier(car.entry, car.control, car.exit, t));
      }
    }
    const after = nextIntersection(car.dOut, i, j);
    if (!after) return pts;
    d = car.dOut;
    i = after.i;
    j = after.j;
  } else {
    // The lane point, not `car.x/car.z`: the taxi weaves inside its lane in Loco Mode, and the
    // band belongs to the lane rather than to that manoeuvre.
    // Straight off the lane the car is on. `car.s` is arc length along that lane now, not a
    // world coordinate, so it can only be resolved by the lane that owns it.
    push(car.lane.path.at(car.s));
  }

  const steps = route ?? [];
  for (let k = 0; k < steps.length && k < MAX_STEPS; k++) {
    const dOut = steps[k];
    const entry = entryPoint(d, i, j);
    const exit = exitPoint(dOut, i, j);

    pushAhead(entry, d);
    if (dOut === d) {
      push(exit);
    } else {
      // The same quadratic the car drives: control point where the two lane centrelines cross,
      // so the band leaves and rejoins each lane exactly tangent to it.
      const control = turnControl(d, dOut, i, j);
      for (let s = 1; s <= TURN_STEPS; s++) push(bezier(entry, control, exit, s / TURN_STEPS));
    }

    const next = nextIntersection(dOut, i, j);
    if (!next) return densifyOverWater(pts);
    d = dOut;
    i = next.i;
    j = next.j;
  }

  // The destination. Stop in the middle of the junction, still in lane — that is where the taxi
  // comes to rest, and running the band out to the far side would point past the pin.
  pushAhead(entryPoint(d, i, j), d);
  pushAhead(lanePoint(d, i, j, isXAxis(d) ? lineX(i) : lineZ(j)), d);
  return densifyOverWater(pts);
}

/**
 * Nearest point on `path` to a world (x, z), as `{ dist, along, x, z, total }`.
 *
 * `along` is arc length from the head of the path, which is the same scale the shader's `vDist`
 * fade and its grab glow are measured in — so one call answers both "did the finger land on the
 * band" and "where on the band did it land", and the highlight can be centred on the exact point
 * that was touched rather than on the nearest vertex.
 *
 * Exported for `game/pathdrag.js` and asserted in `tools/probe.mjs`: a hit test that is generous
 * by a metre in the wrong direction is a gesture that fires when the player meant to pan.
 */
export function nearestOnPath(path, x, z) {
  let best = null;
  let acc = 0;
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k];
    const b = path[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const seg = Math.sqrt(len2);
    const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const px = a.x + t * dx;
    const pz = a.z + t * dz;
    const dist = Math.hypot(x - px, z - pz);
    if (!best || dist < best.dist) best = { dist, along: acc + t * seg, x: px, z: pz };
    acc += seg;
  }
  if (!best) return null;
  best.total = acc;
  return best;
}

/**
 * The point a given arc length along `path`, and the path's total length — the inverse of
 * `nearestOnPath`'s `along`. Shot mode's only use for it is staging a grab that has no finger
 * behind it; `fraction` is where along the band to put one.
 */
export function pointAlongPath(path, fraction) {
  let total = 0;
  for (let k = 1; k < path.length; k++) {
    total += Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
  }
  const want = total * fraction;
  let acc = 0;
  for (let k = 1; k < path.length; k++) {
    const seg = Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z);
    if (acc + seg >= want && seg > 1e-9) {
      const t = (want - acc) / seg;
      return {
        x: path[k - 1].x + (path[k].x - path[k - 1].x) * t,
        z: path[k - 1].z + (path[k].z - path[k - 1].z) * t,
        along: want,
        total,
      };
    }
    acc += seg;
  }
  const last = path[path.length - 1];
  return { x: last.x, z: last.z, along: total, total };
}

/**
 * Half-width offset at each path point, along the mitre of its two adjacent segments, so the
 * band keeps a constant width around a bend instead of gapping on the outside of every join.
 */
function mitreOffsets(path, halfWidth) {
  const dirs = [];
  for (let k = 0; k < path.length - 1; k++) {
    const dx = path[k + 1].x - path[k].x;
    const dz = path[k + 1].z - path[k].z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / len, z: dz / len });
  }
  if (!dirs.length) dirs.push({ x: 1, z: 0 });

  const offsets = [];
  for (let k = 0; k < path.length; k++) {
    const into = dirs[Math.min(Math.max(k - 1, 0), dirs.length - 1)];
    const outOf = dirs[Math.min(k, dirs.length - 1)];

    const nx = -outOf.z;                 // normal of the outgoing segment
    const nz = outOf.x;

    let tx = into.x + outOf.x;
    let tz = into.z + outOf.z;
    const tLen = Math.hypot(tx, tz);
    if (tLen < 1e-4) {                   // doubled back on itself; there is no meaningful mitre
      offsets.push({ x: nx * halfWidth, z: nz * halfWidth });
      continue;
    }
    tx /= tLen;
    tz /= tLen;

    const mx = -tz;
    const mz = tx;
    const denom = mx * nx + mz * nz;
    // A near-zero denominator is an almost-reversed join, where the true mitre runs to infinity.
    // Fall back to a butt join rather than firing a spike across the map.
    const scale = Math.abs(denom) > 0.25 ? halfWidth / denom : halfWidth;
    offsets.push({ x: mx * scale, z: mz * scale });
  }

  return offsets;
}

// The pulse rolls from the car toward the destination — the direction of travel — one crest every
// PULSE_PERIOD units, at PULSE_SPEED units per second. PULSE_SHARPNESS narrows the crest: 1 is a
// full sine wave (no dark trough between crests at this spacing), higher values pinch it into a
// soft travelling glow with real road between crests. PULSE_BOOST caps how much brighter the crest
// gets over the plain band — kept well under the chevrons' old 0.9 so the motion reads as ambient
// rather than as a marker in its own right.
const PULSE_PERIOD = 10;
const PULSE_SPEED = 3;
const PULSE_SHARPNESS = 4;
const PULSE_BOOST = 0.5;

// A freshly routed band sweeps in from the car rather than appearing whole — the same reasoning
// as the pulse: a static object popping into existence reads as "the UI updated", not "the taxi is
// headed there now". A fixed *speed* rather than a fixed duration is what makes it read as one
// consistent motion regardless of the route: a fare next door and one across the map both sweep at
// the same pace, so the far one just keeps going a little longer rather than visibly rushing to
// catch up. No easing on top of it — the head fade already hides the first few units of the sweep,
// so the constant rate is all that's ever visible, and it stays that one rate the whole way out.
const ROLLOUT_SPEED = 110;

// --- The grab flourish ------------------------------------------------------
//
// A finger landing on the band has to be answered *on the band*, and answered before anything has
// moved — the player is being told "this is a handle" at the moment they have not yet pulled it.
// So the whole response is a lift of what is already there rather than a new object: the paint
// brightens, thickens slightly, and blooms under the finger.
//
// Three parts, and each is doing a different job:
//
// - `GRAB_LIFT` brightens the *whole* band. This is the part that says the object you grabbed is
//   the route, all of it, and not the stretch of tarmac you happen to be touching.
// - `GRAB_FOCUS` blooms on top of that at the finger. This is the part that says *where*, and it
//   is what makes the band feel pinned there rather than merely switched on.
// - `GRAB_WIDEN` thickens the paint. Brightness alone reads as a state change; a band that also
//   swells reads as something taking weight.
//
// The bloom is a Gaussian rather than a disc, `GRAB_GLOW` units either side. About 11 because it
// wants to be a couple of car lengths of road — wide enough to survive the band bending under it
// at a junction, narrow enough that it is plainly a point on the route and not the route itself.
const GRAB_LIFT = 0.30;
const GRAB_FOCUS = 0.50;
const GRAB_GLOW = 11;
const GRAB_WIDEN = 0.30;
// How far the bloom pushes toward white. Measured down from 0.45: at that value the core went
// fully white over an additive blend and the band lost its colour exactly where the player was
// looking — that colour is the fare's clock (see `setColor`), and washing it out at the point of
// contact is the one place it must not go. 0.30 is a hot version of whatever hue the band is
// wearing rather than a white; it was measured against the taxi yellow the band used to be, and
// it survived the move to the urgency scale because it is a lift rather than a colour of its own.
const GRAB_WHITEN = 0.30;

// Snaps on and settles off. A grab has to feel instant or it reads as lag on the one gesture whose
// whole promise is that the path answers your finger; letting go is not news in the same way, so
// the band eases back rather than dropping.
const GRAB_RISE = 0.06;
const GRAB_FALL = 0.18;

export function createRouteLine(scene) {
  // Two triangles per segment of the path.
  const positions = new Float32Array(MAX_POINTS * 6 * 3);
  const dists = new Float32Array(MAX_POINTS * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));

  // The fade is per-fragment off a distance-along-the-path varying rather than per-vertex alpha:
  // vertex alpha would need the path re-tessellated at both fade boundaries every frame (and
  // `instanceColor`-style, a 4-component colour attribute takes a different code path anyway),
  // whereas one float per vertex interpolates the length of a 20-unit straight for free.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(PALETTE.routeLine) },
      uOpacity: { value: ROUTE_OPACITY },
      uLength: { value: 1 },
      uHeadGap: { value: HEAD_GAP },
      uFadeHead: { value: FADE_HEAD },
      uFadeTail: { value: FADE_TAIL },
      uMultiply: { value: 0 },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uGrab: { value: 0 },
      uGrabDist: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aDist;
      varying float vDist;
      void main() {
        vDist = aDist;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // `colorspace_fragment` is not optional: a ShaderMaterial gets none of the built-in chunks,
    // and without it `uColor` renders linear — visibly darker than every MeshBasicMaterial marker
    // beside it, and out of step with the disc this band runs into, which is an ordinary
    // MeshBasicMaterial in the same hue. It runs *before* the premultiply, because premultiplied
    // colour is not in a colour space any more and converting it is wrong by however much alpha
    // isn't 1.
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uLength;
      uniform float uHeadGap;
      uniform float uFadeHead;
      uniform float uFadeTail;
      uniform float uMultiply;
      uniform float uTime;
      uniform float uReveal;
      uniform float uGrab;
      uniform float uGrabDist;
      varying float vDist;
      const float PULSE_PERIOD = ${PULSE_PERIOD.toFixed(4)};
      const float PULSE_SPEED = ${PULSE_SPEED.toFixed(4)};
      const float PULSE_SHARPNESS = ${PULSE_SHARPNESS.toFixed(4)};
      const float PULSE_BOOST = ${PULSE_BOOST.toFixed(4)};
      const float GRAB_LIFT = ${GRAB_LIFT.toFixed(4)};
      const float GRAB_FOCUS = ${GRAB_FOCUS.toFixed(4)};
      const float GRAB_GLOW = ${GRAB_GLOW.toFixed(4)};
      const float GRAB_WHITEN = ${GRAB_WHITEN.toFixed(4)};
      const float TAU = 6.2831853;
      void main() {
        float head = smoothstep(uHeadGap, uHeadGap + uFadeHead, vDist);
        float tail = smoothstep(0.0, uFadeTail, uLength - vDist);
        // The rollout sweep: a second, animated tail-style edge that grows from the car out to the
        // destination when a route is freshly picked, using the same fade width as the real tail so
        // the leading edge of the sweep looks exactly like the trailing edge it will settle into.
        // Once uReveal passes uLength this is 1 everywhere and has no effect on the steady state.
        float reveal = smoothstep(0.0, uFadeTail, uReveal - vDist);

        // The grab: a lift over the whole band plus a bloom under the finger. Inside the same
        // head/tail envelope as everything else, so a highlight can no more spill past the ends of
        // the route than the pulse can.
        float focus = exp(-pow((vDist - uGrabDist) / GRAB_GLOW, 2.0));
        float held = uGrab * (GRAB_LIFT + GRAB_FOCUS * focus);

        float envelope = uOpacity * (1.0 + held) * head * tail * reveal;

        // Position relative to the *destination* end, not the car end. vDist is measured from the
        // car, so it (and uLength) both shrink every frame the taxi drives — using it directly
        // would make the pulse appear to roll faster or slower with the taxi's own speed. The
        // destination end of the path doesn't move, so anchoring the phase there decouples the
        // animation from the taxi entirely; only uTime drives it.
        float travel = vDist - uLength;

        // A raised cosine rather than a hard-edged band: a soft crest that rises and falls reads as
        // a pulse of motion, where a sharp line reads as a marker sitting still and blinking.
        float theta = TAU * fract((travel - uTime * PULSE_SPEED) / PULSE_PERIOD);
        float pulse = pow(max(0.0, 0.5 + 0.5 * cos(theta)), PULSE_SHARPNESS);
        // The pulse only brightens the band, never darkens it or exceeds full alpha, and fades out
        // with the same head/tail envelope as the band itself so none rolls past its ends.
        float boost = pulse * envelope * PULSE_BOOST;

        // Clamped: the lift and the pulse crest can both be on the same fragment, and together they
        // run past 1. Premultiplying an alpha over 1 paints a colour brighter than the paint.
        float a = min(1.0, envelope + boost);
        vec3 rgb = mix(uColor, vec3(1.0), min(1.0, boost + uGrab * focus * GRAB_WHITEN));
        gl_FragColor = vec4(rgb, a);
        #include <colorspace_fragment>
        gl_FragColor = uMultiply > 0.5
          ? vec4(mix(vec3(1.0), gl_FragColor.rgb, a), 1.0)
          : vec4(gl_FragColor.rgb * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
  });

  let blendName = ROUTE_BLEND_DEFAULT;

  /**
   * Paint the band. Called every frame the band is drawn, so the common path is a `Color.copy`
   * onto the uniform's own instance — never a swap, since three uploads the object it was handed
   * at compile time.
   */
  function setColor(value) {
    material.uniforms.uColor.value.set(value);
  }

  /** Switch how the band combines with the road. Unknown names fall back to `normal`. */
  function setBlend(name) {
    blendName = ROUTE_BLENDS[name] ? name : ROUTE_BLEND_DEFAULT;
    const mode = ROUTE_BLENDS[blendName];
    // Reset every factor first: three only reads blendSrc/blendDst under CustomBlending, but a
    // leftover pair would apply again the moment another custom mode is picked.
    material.blending = mode.blending;
    material.blendSrc = mode.blendSrc ?? THREE.SrcAlphaFactor;
    material.blendDst = mode.blendDst ?? THREE.OneMinusSrcAlphaFactor;
    material.uniforms.uMultiply.value = blendName === 'multiply' ? 1 : 0;
    material.needsUpdate = true;
  }
  setBlend(ROUTE_BLEND_DEFAULT);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 4;   // under the fare rings (7-9)
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  // Identity of the route currently sweeping in, so a route that is merely being redrawn this
  // frame (the common case — every frame, as the car advances) doesn't replay the rollout, while
  // a genuinely new one (the player tapped a fare, or a pickup redirected to the drop-off) does.
  // `pendingTarget` is a fresh object every time `routeTo()` runs and stable between those calls,
  // so identity is all this needs — no route contents to compare.
  let revealTarget = null;
  let revealElapsed = 0;

  // How hard the band is being held, and where. `grabWant` is the instruction (0 or 1) and `grab`
  // is what is drawn — eased, so nothing about the flourish steps.
  let grabWant = 0;
  let grab = 0;
  let grabAt = 0;

  /**
   * Take hold of the band, or let go of it.
   *
   * @param held true while a finger is down on it
   * @param at   arc length from the head of the path, from `nearestOnPath`. Left where it was when
   *             omitted, so releasing fades the bloom out where it stood rather than sliding it to
   *             the head of the band on the way.
   */
  function setGrab(held, at = null) {
    grabWant = held ? 1 : 0;
    if (at !== null) grabAt = at;
  }

  function update(car, route, dt = 0) {
    material.uniforms.uTime.value += dt;

    // Exponential-ish approach on a per-frame fraction rather than a tween with a start time: the
    // grab has no fixed duration — it lasts as long as the finger does.
    const rate = grabWant > grab ? GRAB_RISE : GRAB_FALL;
    grab += (grabWant - grab) * Math.min(1, dt / rate);
    material.uniforms.uGrab.value = grab;
    material.uniforms.uGrabDist.value = grabAt;

    if (car.pendingTarget !== revealTarget) {
      revealTarget = car.pendingTarget;
      revealElapsed = 0;
    }
    // Always folded in, including the frame a new target starts on — a shot mode frame is a
    // single call with dt=999 standing in for "let it settle", and that dt has to count even
    // though this is also the frame the target just changed on, or the sweep never advances.
    revealElapsed += dt;

    const path = routePath(car, route);
    if (path.length < 2) { mesh.visible = false; return; }

    // Arc length at each point, so the shader can fade against real distance rather than against
    // vertex index — an eight-step arc and a 20-unit straight are one vertex step apart either way.
    const s = [0];
    for (let k = 1; k < path.length; k++) {
      s.push(s[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z));
    }
    const total = s[s.length - 1];
    if (total < 0.01) { mesh.visible = false; return; }

    // A one-block hop (PITCH is 20) is barely longer than the gap and the two fades put together.
    // Scale all three down in proportion rather than letting them overlap into a band that never
    // reaches full opacity anywhere — or, worse, one the head gap swallows whole.
    const squeeze = Math.min(1, (total * 0.9) / (HEAD_GAP + FADE_HEAD + FADE_TAIL));
    material.uniforms.uLength.value = total;
    material.uniforms.uHeadGap.value = HEAD_GAP * squeeze;
    material.uniforms.uFadeHead.value = FADE_HEAD * squeeze;
    material.uniforms.uFadeTail.value = FADE_TAIL * squeeze;

    // Sweeps out past the far end (by the tail's own fade width) rather than stopping exactly at
    // `total`, so the reveal edge fully clears the destination and leaves no soft seam sitting
    // partway down the band once the animation settles.
    const cap = total + FADE_TAIL * squeeze;
    material.uniforms.uReveal.value = Math.min(cap, ROLLOUT_SPEED * revealElapsed);

    // Offset each point along its mitre rather than offsetting each segment independently.
    // Independent segments leave a wedge of empty road on the outside of every join — invisible
    // at 90° corners because the corner was the notch, but obvious across a ten-step arc.
    // Thickens under a grab. Rebuilt every frame anyway, so this costs nothing beyond the multiply
    // — and the mitre keeps the swell even around a bend, which a fixed offset would not.
    const offsets = mitreOffsets(path, HALF_WIDTH * (1 + GRAB_WIDEN * grab));

    let v = 0;
    let n = 0;
    // **The band rides the bridge decks.** `Y` is a height above the *road*, and three of the
    // city's spans arch 1.1 units above it — a band laid flat cut straight through the hump and
    // came out the other side, which is the one place in the city where the paint stops being on
    // the tarmac it is describing.
    //
    // Sampled at the offset vertex rather than at the centreline, so both edges of the band sit on
    // the deck: the two are up to a metre apart across, and a deck that pitched in x would tilt
    // the band if only the middle were measured. `deckHeightAt` is zero everywhere but a span, so
    // this costs a rectangle test per vertex on a route that never goes near the river.
    const push = (p, o, dist) => {
      const x = p.x + o.x;
      const z = p.z + o.z;
      positions[v++] = x;
      positions[v++] = Y + deckHeightAt(x, z).y;
      positions[v++] = z;
      dists[n++] = dist;
    };

    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const oa = offsets[k];
      const ob = offsets[k + 1];
      const neg = (o) => ({ x: -o.x, z: -o.z });

      push(a, oa, s[k]);      push(b, ob, s[k + 1]);      push(b, neg(ob), s[k + 1]);
      push(a, oa, s[k]);      push(b, neg(ob), s[k + 1]); push(a, neg(oa), s[k]);
    }

    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aDist.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh.visible = n > 0;
  }

  return {
    mesh,
    update,
    setBlend,
    setColor,
    /** What the band is painted right now, for tools with no GL context to read it back from. */
    color: () => material.uniforms.uColor.value,
    setGrab,
    blend: () => blendName,
    hide: () => { mesh.visible = false; },
  };
}
