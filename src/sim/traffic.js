import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { KERB_H } from '../city/ground.js';
import {
  WHEEL_R, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries,
} from '../geometry/wheels.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import {
  GRID, PITCH, HALF_ROAD, LANE, lineCoord, isXAxis, dirSign, dirYaw, leftOf, rightOf, opposite,
  laneOffsetCoord, entryPoint, exitPoint, turnControl, nextIntersection, legalExits, isSegmentClosed,
  ringAxisAt, isUnsignalised,
} from '../city/grid.js';

export { ringAxisAt, isUnsignalised };   // re-exported: callers of the sim ask it about junctions
// Wheels and ride height live in geometry/wheels.js — see the note there on why they are not in
// this file. Passed straight through so callers have one import for "a vehicle".
export { WHEEL_R, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries };

// --- Signals ----------------------------------------------------------------

// Signal timing.
//
// The original scheme was `phaseOffset = ((i + j) % 4) * (CYCLE / 4)` on a 16.2s cycle, which
// measured out as: four distinct timings across all 36 junctions, half the city flipping within
// the same half-second, and green-on-arrival at exactly 50% — i.e. pure chance, no coordination
// whatsoever. It waved along the *diagonal*, which looks synchronised while helping no road.
//
// Three things replace it:
//   - offsets derived from travel time, so a platoon meets consecutive greens (a real green wave)
//   - a longer cycle, so the city stops blinking and proportionally less time is lost to yellow
//   - arterials, which take a larger share of green and give the map a fast/slow grain to learn
//
// Cycle length stays common across the city on purpose: shared cycle length is the precondition
// for coordination. Variety comes from splits and offsets instead.

const SPEED = 8.5;

// Loco Mode weave. The boosting taxi used to pull a full LANE out onto the road centreline to
// overtake, and that is what made the mode a lottery rather than a skill: on the centreline it
// sits 2 units from a same-direction leader and 2 from oncoming traffic, while the collision
// envelope in sim/collisions.js is 2.31 wide — so *every* car it drew level with was a crash,
// whichever way that car was pointing. It now holds its lane and weaves inside it, and the
// crashes that remain are the ones the player can actually see coming: cross traffic at a
// junction it is running, and cars turning into its path.
//
// Room budget: the lane centre sits LANE (2) from the road centreline and 2 from the kerb, so
// with half a car body (0.85) taken off there is ~1.1 units of play either side. Two waves of
// different wavelength peak at 0.40 + 0.12 = 0.52 — half the room, and because the periods do
// not divide they never settle into a metronome.
const SWERVE_AMP = 0.40;      // world units, the long wave
const SWERVE_WAVE = 18;       // units of road per cycle — about 1 Hz at boost speed (18.7 u/s)
const SWERVE_AMP2 = 0.12;     // shorter wave laid on top, to break up the rhythm
const SWERVE_WAVE2 = 9.5;
const SWERVE_PHASE2 = 1.7;    // offset so the two waves don't start out in step
// Units of road over which the weave fades in and out with the boost. Paced by distance, like
// the weave itself, so releasing the button at a red doesn't drift the parked car straight.
const SWERVE_FADE = 7;
export const LOCO_WEAVE_FADE = SWERVE_FADE;

/**
 * The Loco Mode weave, as a function of distance driven straight (`u`, world units). Returns the
 * lane-relative offset and its slope — the slope *is* the tangent of the steering angle, since the
 * offset is a function of distance rather than of time, so there is nothing to divide by v.
 *
 * Exported because the police car drives the same weave when it locks onto the taxi
 * (`sim/police.js`). One definition, so the two maniacs in the city are demonstrably the same
 * kind of maniac and the room budget above only has to be reasoned about once.
 */
export function locoWeave(u) {
  const k1 = (Math.PI * 2) / SWERVE_WAVE;
  const k2 = (Math.PI * 2) / SWERVE_WAVE2;
  return {
    lateral: SWERVE_AMP * Math.sin(k1 * u) + SWERVE_AMP2 * Math.sin(k2 * u + SWERVE_PHASE2),
    slope: SWERVE_AMP * k1 * Math.cos(k1 * u) + SWERVE_AMP2 * k2 * Math.cos(k2 * u + SWERVE_PHASE2),
  };
}

// Wheelie profile for the Loco Mode kickoff — see the pitch-composition block below where the
// shape is applied. Peak is about 17°: enough to read as the nose jumping off the line, short of
// the point where the underside of the car would clip through the road on a long ramp-up.
const WHEELIE_PEAK = 0.30;
const WHEELIE_DUR = 0.55;

const SIGNAL = {
  // 16s, not the 28s first tried. A sweep of cycle length against throughput came back monotonic
  // — 14s gave 3.80 units/s per car, 28s gave 2.36 — because with sparse, randomly-turning
  // traffic a long cycle costs every car waiting time and the wave can only repay some of it.
  // The calm comes from spreading the offsets, not from slowing the cycle down.
  cycle: 16,
  yellow: 1.6,
  arterialShare: 0.64,          // green share for an arterial where it meets a side street
  arterialX: new Set(),         // j values: roads running along X
  arterialZ: new Set(),         // i values: roads running along Z
  dirX: new Map(),              // j -> +1 / -1, the coordinated direction of travel
  dirZ: new Map(),
};

export function configureSignals(config) {
  Object.assign(SIGNAL, config);
}

export const signalCycle = () => SIGNAL.cycle;

/**
 * Road hierarchy of the edge you get by leaving (i, j) in direction d.
 *
 * 'ring'     — outermost road, unsignalised except at the four corners
 * 'arterial' — one of the two main streets: 64% green share, offsets timed for the wave
 * 'side'     — everything else
 *
 * `withWave` matters only for arterials: an arterial's offsets are computed with a
 * coordinated travel direction; traversing it that way meets consecutive greens, the other
 * way meets consecutive reds. For a side street the concept doesn't apply.
 */
export function edgeClass(i, j, d) {
  const axisIsX = isXAxis(d);
  const line = axisIsX ? j : i;
  const onOuter = line === 0 || line === GRID;
  if (onOuter) return { kind: 'ring', withWave: true };

  const arterialSet = axisIsX ? SIGNAL.arterialX : SIGNAL.arterialZ;
  if (arterialSet.has(line)) {
    const coordinated = (axisIsX ? SIGNAL.dirX : SIGNAL.dirZ).get(line) ?? 1;
    return { kind: 'arterial', withWave: dirSign(d) === Math.sign(coordinated) };
  }
  return { kind: 'side', withWave: false };
}

/** Seconds a platoon takes to cover one block at cruising speed — the basis of every offset. */
const blockTime = () => PITCH / SPEED;

/** How much clear road a joining car needs before pulling out in front of ring traffic. */
const RING_YIELD = 24;

/**
 * Clearance a car needs before turning right on a red.
 *
 * Shorter than the ring's, because the conflict is smaller: a right turn merges into the near
 * lane of the cross street rather than crossing it. The landing itself is still governed by the
 * usual don't-block-the-box check further down.
 */
const RIGHT_ON_RED_YIELD = 15;

/**
 * How far back from the junction boundary a car actually holds.
 *
 * Cars used to stop with their *centre* on the boundary, putting the nose 1.7 units inside the
 * junction and squarely across the crosswalk. The outer crosswalk bar sits 5.65 from the junction
 * centre, so the centre has to hold at ~7.35 for the nose to clear it.
 */
const STOP_SETBACK = 3.4;

// --- Priority corridor ------------------------------------------------------
//
// An emergency vehicle holds every signal along its road green and every crossing road red. It is
// applied here, inside lightPhase, rather than anywhere near the vehicles: `canProceed` is the one
// place any car asks "may I enter?", so overriding the phase makes the whole city react correctly
// — corridor traffic flows, cross traffic stops — without touching the car logic at all.
let corridor = null;   // { axis: 'x' | 'z', line: number }

export function setPriorityCorridor(next) {
  corridor = next;
}

export const getPriorityCorridor = () => corridor;

// A single junction held green for one axis. Used by the boosting taxi: rather than running the
// red — which would drive it through cross traffic that has a legitimate green, and this game has
// no collision resolution at all — the junction ahead simply yields. Same outcome for the player,
// nothing overlaps.
let priorityJunction = null;

export function setPriorityJunction(next) {
  priorityJunction = next;
}

// --- Panic --------------------------------------------------------------------
//
// Where the police car actually is on its road, published by src/sim/police.js each frame while a
// run is live. Corridor already tells us which axis/line the siren is running on, but not *where*
// along it — and the frantic reaction below is a proximity effect, not a per-road one, so it needs
// the s coordinate too. Cleared on stop.
let policePresence = null;   // { axis: 'x' | 'z', line: number, s: number }

export function setPolicePresence(next) {
  policePresence = next;
}

// Cars on the police car's own road react as it approaches: swerve outward toward the kerb,
// wobble in yaw, dip the throttle. The siren straddles the centreline at ~2× traffic speed, so
// both same-direction and oncoming lanes get rushed past — the reaction has to work for both.
const PANIC_RANGE = 26;        // world units at which the reaction begins to fade in
const PANIC_LATERAL = 0.9;     // outward push in world units at full panic (kerb sits ~1.15 out)
const PANIC_WOBBLE = 0.16;     // yaw jitter amplitude (radians) at full panic
const PANIC_BRAKE = 0.35;      // fraction of cruise speed shed at full panic

/**
 * How rattled a car should be right now: 1 next to the siren, 0 outside PANIC_RANGE, and only
 * ever non-zero for cars on the very road the police is running down. A junction is on two roads,
 * so a car pointed across the siren's road still counts.
 */
function panicTargetFor(car) {
  if (!policePresence || car.isTaxi || car.stunned || car.crashed) return 0;
  const carAxis = isXAxis(car.d) ? 'x' : 'z';
  if (carAxis !== policePresence.axis) return 0;
  const carLine = carAxis === 'x' ? car.j : car.i;
  if (carLine !== policePresence.line) return 0;
  const dist = Math.abs(car.s - policePresence.s);
  if (dist >= PANIC_RANGE) return 0;
  return 1 - dist / PANIC_RANGE;
}

/** Whether a live corridor passes through this junction. */
export const corridorCovers = (i, j) =>
  Boolean(corridor) && (corridor.axis === 'x' ? j === corridor.line : i === corridor.line);

/** Whether the boosting taxi's priority junction is this one. */
const priorityCovers = (i, j) =>
  Boolean(priorityJunction) && priorityJunction.i === i && priorityJunction.j === j;

/**
 * Signal state at an intersection. `axis` is the axis currently permitted to move; yellow is
 * treated as stop, which keeps the rule "may I enter?" a single boolean everywhere else.
 *
 * `ignorePriority` skips the boosting taxi's hold — see `displayPhase` for why the lamps want the
 * un-overridden answer.
 */
export function lightPhase(i, j, t, ignorePriority = false) {
  if (!ignorePriority && priorityJunction && priorityJunction.i === i && priorityJunction.j === j) {
    return { axis: priorityJunction.axis, yellow: false, remaining: Infinity };
  }

  // A siren outranks everything, including the ring — otherwise a corridor crossing the ring
  // would leave a gap in the middle of the green path it is supposed to be clearing.
  if (corridorCovers(i, j)) return { axis: corridor.axis, yellow: false, remaining: Infinity };

  // Otherwise, unsignalised ring junctions have no phase to report: the ring simply has priority.
  const ring = ringAxisAt(i, j);
  if (ring) return { axis: ring, yellow: false, remaining: Infinity };

  const { cycle, yellow, arterialShare } = SIGNAL;
  const xArterial = SIGNAL.arterialX.has(j);
  const zArterial = SIGNAL.arterialZ.has(i);

  // Split: an arterial crossing a side street takes the larger share. Arterial-meets-arterial and
  // side-meets-side both fall back to an even split.
  let xShare = 0.5;
  if (xArterial && !zArterial) xShare = arterialShare;
  else if (zArterial && !xArterial) xShare = 1 - arterialShare;

  const totalGreen = cycle - 2 * yellow;
  const greenX = totalGreen * xShare;
  const greenZ = totalGreen - greenX;

  // Offset: shift this junction's green earlier by the time a platoon takes to reach it, so the
  // wave travels with the traffic. Each junction coordinates with whichever road through it
  // matters more; a junction of two side streets defaults to coordinating along X.
  const alongX = xArterial || !zArterial;
  const step = blockTime();

  let offset;
  if (alongX) {
    const blocks = (SIGNAL.dirX.get(j) ?? 1) > 0 ? i : GRID - i;
    offset = -blocks * step;
  } else {
    const blocks = (SIGNAL.dirZ.get(i) ?? 1) > 0 ? j : GRID - j;
    // The Z green starts partway through the cycle, so the wave has to line up with that instead.
    offset = greenX + yellow - blocks * step;
  }

  const local = (((t + offset) % cycle) + cycle) % cycle;
  if (local < greenX) return { axis: 'x', yellow: false, remaining: greenX - local };
  if (local < greenX + yellow) return { axis: 'x', yellow: true, remaining: greenX + yellow - local };
  if (local < greenX + yellow + greenZ) {
    return { axis: 'z', yellow: false, remaining: greenX + yellow + greenZ - local };
  }
  return { axis: 'z', yellow: true, remaining: cycle - local };
}

/**
 * What the signal heads should *show*. Same as `lightPhase` except the boosting taxi's priority
 * hold is invisible: the lamps keep running their real cycle while Loco Mode barges through.
 *
 * The hold is a simulation-only courtesy — cross traffic yields so the taxi never has to be
 * resolved out of a collision it can't be resolved out of — but wiring it to the lamps meant every
 * junction visibly flipped green a beat before the taxi got there. That reads as the city politely
 * opening up, which is the opposite of the intended feel: Loco Mode should look like running every
 * red in the grid. The cross traffic that yields under a green of its own now reads as drivers
 * balking at a maniac rather than as obedience.
 *
 * The police corridor is deliberately *not* excepted — emergency preemption really does turn the
 * lights, and seeing the green path open ahead of the siren is the point of it.
 */
export const displayPhase = (i, j, t) => lightPhase(i, j, t, true);

const canProceed = (d, i, j, t) => {
  const phase = lightPhase(i, j, t);
  return phase.axis === (isXAxis(d) ? 'x' : 'z') && !phase.yellow;
};

/**
 * The taxi runs yellows. A yellow on the taxi's axis stops being a hard "no": it becomes
 * "yes if we can still clear the junction before it goes red." That is what a real driver
 * does when they have already committed, and it is why running a yellow does not feel like
 * running a red — cross traffic still has their own yellow buffer before they start moving.
 *
 * Ambient traffic keeps stopping on yellow, so the streets don't turn into a demolition derby.
 * "Clear" here means the front of the car is past the far edge of the junction; that is the
 * point past which cross traffic on their fresh green no longer has to weave. Half a yellow
 * length of slack on top, because the taxi is aggressive by design and cross cars have to
 * launch from standing anyway.
 */
function taxiClearsYellow(car, distToLine, t) {
  if (!car.isTaxi) return false;
  const phase = lightPhase(car.i, car.j, t);
  if (!phase.yellow || phase.axis !== (isXAxis(car.d) ? 'x' : 'z')) return false;
  const clearDist = Math.max(0, distToLine) + STOP_SETBACK + HALF_ROAD * 2;
  // A near-stopped taxi still commits: without this floor a car that just crept up to the line
  // would refuse to move even with the whole yellow left to use.
  const v = Math.max(car.v, SPEED * 0.7);
  return clearDist / v <= phase.remaining + SIGNAL.yellow * 0.5;
}

// --- Cars -------------------------------------------------------------------

export const CAR_LEN = 3.4;
export const CAR_W = 1.7;
const MIN_GAP = CAR_LEN + 1.9;   // centre-to-centre
// What a boosting taxi keeps instead. It stays in its lane now, so a leader it doesn't see is a
// leader it rear-ends — but queueing at the ambient distance would read as the maniac politely
// joining the back. 4.5 centre-to-centre puts the near collision circles (offset ±0.95 along the
// body) 2.6 apart against an envelope of 2.31: close enough to look like tailgating, still 0.29
// clear of a crash, and `step` is clamped to `allowed` so it cannot overshoot into that margin.
const BOOST_GAP = MIN_GAP * 0.85;
const YIELD_RANGE = 15;          // how far ahead oncoming traffic blocks a left turn
const TURN_WEIGHTS = [0.62, 0.24, 0.14]; // straight, right, left

// Cars used to teleport between full speed and stopped. These give them mass: they ease away
// from a green and, more importantly, *anticipate* — a car reads the signal ahead and sheds speed
// over the approach instead of arriving at 8.5 and stopping dead on the line.
const ACCEL = 6;              // units/s^2 pulling away

// Boost tuning. The first pass only raised the speed *cap*, which barely registered: at 6 u/s^2 a
// car needs 24 units to reach 17 u/s, and junctions are 20 apart, so it never actually got there.
// Punch comes from the acceleration, not the ceiling.
const BOOST_SPEED = 2.2;      // multiplier on top speed
const BOOST_ACCEL = 24;       // reaches full boost speed in well under a block
const BOOST_KICK = 1.25;      // instant surge on activation, so the press has a feel
const BRAKE = 11;             // units/s^2 shedding speed; ~3.3 units to stop from cruise
const CORNER_SPEED = SPEED * 0.7;

// Vehicles previously rode at KERB_H + 0.05, floating 0.4 above the tarmac — invisible without
// wheels, glaring with them. They now sit just clear of the road markings.
export const ROAD_Y = 0.04;

// Front-wheel steering. The angle is read back from the path the car actually described this
// frame — atan(WHEELBASE · dψ/ds) is the Ackermann angle that produces the curvature it is
// driving — rather than from the turn decision. One rule then covers the junction arc, the Loco
// Mode weave, and the straight in between, and nothing has to be kept in step with the turn
// state machine.
//
// Measured over 240s of traffic, on the raw angle: a right turn holds 38.7° all the way round the
// arc, a left 15.0°, the boost weave sits at 7° (p90), and going straight on through a junction is
// a flat 0. Right beats left by more than 2:1 because right-hand traffic cuts the near corner
// while a left sweeps the far diagonal — the tighter arc genuinely wants more lock, so the spread
// is the model being right rather than something to flatten out.
//
// The gain is for legibility, not physics. Even on the doubled wheel, 15° of a 10px tread moves
// the outline by about a pixel. 1.6× puts a right turn on the clamp (~34°, about where a real
// front wheel stops) and a left at 24°, and everything below the clamp keeps its relative size —
// a weave still reads as a flick and a corner as full lock.
//
// Unwinding is the ease and nothing else: measured, a car is down to 6.8° one unit out of the
// junction and under 3° by three, which is a driver straightening up as the car does.
const WHEELBASE = CAR_LEN * 0.6;   // hub to hub — the anchors sit at ±0.3·CAR_LEN
const STEER_GAIN = 1.6;
export const STEER_MAX = 0.6;      // ~34°, about where a real front wheel stops
const STEER_EASE = 1.2;            // units of road to reach the target, not seconds — see below

/**
 * Step a front-wheel angle toward the lock the path implies, and hand it back.
 *
 * Exported because the police cruiser runs the same rule from `sim/police.js`. It is not in the
 * `cars` array — it has no lane, no turn state and no collision coupling — so the only thing the
 * two vehicles can share is this, and sharing it is what stops the cruiser's wheels drifting out
 * of step with everyone else's the next time the gain is touched.
 *
 * Both yaws come in raw and the difference is taken the short way round, so a caller sweeping
 * through ±π (the cruiser's U-turn) needs no special case. Nothing happens on a stationary
 * vehicle: the wheels keep the lock they stopped with, and the divide is never reached.
 */
export function steerToward(angle, yaw, prevYaw, ds, wheelbase = WHEELBASE) {
  if (!(ds > 1e-4)) return angle;
  const dYaw = ((yaw - prevYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const target = Math.max(-STEER_MAX, Math.min(STEER_MAX,
    Math.atan((wheelbase * dYaw) / ds) * STEER_GAIN));
  return angle + (target - angle) * Math.min(1, ds / STEER_EASE);
}
function carGeometry() {
  // Body is left white so the per-instance colour tints it; the glass is dark enough that the
  // same multiply leaves it dark whatever colour the car is.
  const parts = [];

  // Body sits clear of the wheels so they actually show below the sill.
  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(body, new THREE.Color(1, 1, 1)));

  const cabin = new THREE.BoxGeometry(CAR_LEN * 0.5, 0.6, CAR_W * 0.86);
  cabin.translate(-0.2, 1.45 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(cabin, color('carGlass')));

  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Coordinate along the travel axis for a point. */
const along = (d, p) => (isXAxis(d) ? p.x : p.z);

function spawnCars(rng, count) {
  const cars = [];
  const attempts = count * 12;

  for (let n = 0; n < attempts && cars.length < count; n++) {
    const d = rng.int(0, 3);
    const line = rng.int(0, GRID);   // the road the car drives along
    const seg = rng.int(0, GRID - 1); // which gap between intersections

    // That stretch of road may have been built over by a park district.
    if (isXAxis(d) ? isSegmentClosed(seg, line, 0) : isSegmentClosed(line, seg, 1)) continue;

    const lo = lineCoord(seg) + HALF_ROAD;
    const hi = lineCoord(seg + 1) - HALF_ROAD;
    const s = rng.range(lo + 0.5, hi - 0.5);

    // Target intersection is whichever end of the segment the car is heading for.
    const targetIndex = dirSign(d) > 0 ? seg + 1 : seg;
    const i = isXAxis(d) ? targetIndex : line;
    const j = isXAxis(d) ? line : targetIndex;

    const laneKey = isXAxis(d) ? `x|${d}|${j}` : `z|${d}|${i}`;
    const clash = cars.some((c) => c.laneKey === laneKey && Math.abs(c.s - s) < MIN_GAP + 1);
    if (clash) continue;

    cars.push({
      d, i, j, s, laneKey,
      state: 'drive',
      turnT: 0,
      turnLen: 1,
      entry: null, control: null, exit: null, hold: null, leadIn: 0, dOut: d,
      colorIndex: rng.int(0, PALETTE.carBody.length - 1),
      // Drives the idle bob. Per-car phase so a queue doesn't bounce in lockstep.
      travelled: 0,
      phase: rng.range(0, Math.PI * 2),
      speedFactor: 0,
      v: SPEED,     // already rolling, so the city doesn't lurch into motion on frame one
      prevV: SPEED, // paired with car.v so accel = Δv/dt on frame one is a clean zero, not a spike
      // Longitudinal-accel rocking. Spring-damped, so both a stop and a pull-away end on a bounce.
      pitch: 0,
      pitchV: 0,
      boost: false,
      wasBoosting: false,
      lateral: 0,      // world-unit offset from the lane centre; + is toward the road centreline
      steer: 0,        // yaw offset while sliding across, so the car points where it is going
      // Front-wheel angle, and the two values it is differenced from. Seeded straight, and paired
      // so that dψ/ds is measured over exactly the step the car took.
      wheelAngle: 0,
      prevSteerYaw: dirYaw(d),
      prevTravelled: 0,
      swerve: 0,       // 0..1 envelope on the Loco Mode weave, faded in and out with the boost
      swervePhase: 0,  // distance driven straight, the weave's argument — see SWERVE_* above
      // Ambient cars leave `route` empty and fall through to random turns. The taxi's route is
      // filled in by the game layer; see the turn decision below.
      route: [],
      routeConsumed: false,
      // A taxi with a fare aboard waits at the kerb until the player says where to. Releasing on
      // "has a route" rather than on an explicit call means every caller — the game, the probe,
      // the auto-play soak — releases it just by giving the car somewhere to go.
      parked: false,
      isTaxi: false,
      instanceIndex: -1,
      x: 0, z: 0, yaw: dirYaw(d),
      // Impact state. `stunned` is a small drift-physics packet set by src/sim/collisions.js;
      // while it's non-null the car is off the lane grid and the usual driving/turning logic is
      // skipped. `collisionCooldown` blocks a re-collision for a beat after recovery. `crashed`
      // is set on the taxi only, permanently — every loop below skips it so the wreck sits still
      // while the run-end banner comes up.
      stunned: null,
      collisionCooldown: 0,
      crashed: false,
      // Frantic reaction to a nearby police siren. Eased toward panicTargetFor() each frame and
      // applied at render as an outward shove, a yaw wobble, and a mild speed dip.
      panic: 0,
    });
  }

  return cars;
}

const laneKeyFor = (d, i, j) => (isXAxis(d) ? `x|${d}|${j}` : `z|${d}|${i}`);

/**
 * Put a stunned car back onto the lane grid so normal driving logic can pick it up next frame.
 * Snaps position to the nearest lane centre along the car's travel axis and points it at the
 * next intersection in that direction. A car mid-turn adopts its exit direction, which is what
 * it was heading for anyway; the route (if any) survives, but a routed step that's no longer a
 * legal exit will be dropped by the normal turn logic and counted as a desync.
 */
function recoverFromStun(car) {
  const d = car.state === 'turn' ? car.dOut : car.d;
  const sign = dirSign(d);

  if (isXAxis(d)) {
    let bestJ = 0;
    let bestErr = Infinity;
    for (let j = 0; j <= GRID; j++) {
      const err = Math.abs(car.z - (lineCoord(j) + sign * LANE));
      if (err < bestErr) { bestErr = err; bestJ = j; }
    }
    let targetI = null;
    if (sign > 0) {
      for (let i = 0; i <= GRID; i++) if (lineCoord(i) > car.x + 0.5) { targetI = i; break; }
      if (targetI === null) targetI = GRID;
    } else {
      for (let i = GRID; i >= 0; i--) if (lineCoord(i) < car.x - 0.5) { targetI = i; break; }
      if (targetI === null) targetI = 0;
    }
    car.i = targetI;
    car.j = bestJ;
    car.z = lineCoord(bestJ) + sign * LANE;
    car.s = car.x;
    car.laneKey = `x|${d}|${bestJ}`;
  } else {
    let bestI = 0;
    let bestErr = Infinity;
    for (let i = 0; i <= GRID; i++) {
      const err = Math.abs(car.x - (lineCoord(i) - sign * LANE));
      if (err < bestErr) { bestErr = err; bestI = i; }
    }
    let targetJ = null;
    if (sign > 0) {
      for (let j = 0; j <= GRID; j++) if (lineCoord(j) > car.z + 0.5) { targetJ = j; break; }
      if (targetJ === null) targetJ = GRID;
    } else {
      for (let j = GRID; j >= 0; j--) if (lineCoord(j) < car.z - 0.5) { targetJ = j; break; }
      if (targetJ === null) targetJ = 0;
    }
    car.i = bestI;
    car.j = targetJ;
    car.x = lineCoord(bestI) - sign * LANE;
    car.s = car.z;
    car.laneKey = `z|${d}|${bestI}`;
  }

  car.d = d;
  car.dOut = d;
  car.yaw = dirYaw(d);
  car.state = 'drive';
  car.turnT = 0;
  car.v = 0;
  car.prevV = 0;
  car.lateral = 0;
  car.steer = 0;
  // Drop the weave envelope too, so a car put back on its lane centre is actually on it and the
  // weave fades back in from there rather than resuming at whatever offset it was spun out on.
  car.swerve = 0;
  car.collisionCooldown = car.stunned?.postCooldown ?? 0.8;
  car.stunned = null;
}

function bezier(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    z: mt * mt * p0.z + 2 * mt * t * p1.z + t * t * p2.z,
  };
}

/** Shortest-path angular interpolation, so a car turning past ±π doesn't spin the long way. */
function lerpAngle(a, b, t) {
  const delta = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + delta * t;
}

export function createTraffic(rng, scene, count = 24) {
  const cars = spawnCars(rng, count);

  // The player's taxi is an ordinary car in this same array — that is what subjects it to
  // following distance, signals and intersection reservations exactly like everyone else. It is
  // simply drawn as its own mesh instead of an instance, so it can be raycast and highlighted.
  const taxi = cars[0];
  taxi.isTaxi = true;
  const {
    group: taxiGroup, setFareColor: setTaxiFareColor, setSteer: setTaxiSteer,
  } = createTaxiMesh();
  scene.add(taxiGroup);

  const ambient = cars.filter((c) => !c.isTaxi);
  ambient.forEach((car, index) => { car.instanceIndex = index; });

  const mesh = new THREE.InstancedMesh(carGeometry(), propMaterial(), ambient.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.name = 'cars';

  // The steered front wheels, as their own instanced mesh: two per ambient car, each carrying the
  // car's transform with a yaw of its own applied on top. They can't ride in the body geometry
  // because every instance of that shares one matrix, and these two have to turn independently
  // of it.
  const FRONT = wheelAnchors(CAR_LEN, CAR_W).filter((a) => a.front);
  const wheelMesh = new THREE.InstancedMesh(
    wheelGeometry(), propMaterial(), ambient.length * FRONT.length,
  );
  wheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wheelMesh.castShadow = true;
  wheelMesh.name = 'carWheels';

  const tint = new THREE.Color();
  ambient.forEach((car, index) => {
    tint.set(PALETTE.carBody[car.colorIndex]);
    mesh.setColorAt(index, tint);
    // Tinted with the body it belongs to, not left neutral. The tyre is baked dark and the
    // instance colour multiplies on top, so a front wheel that skipped this would sit a shade
    // off its own rear wheel on every car in the city.
    for (let w = 0; w < FRONT.length; w++) wheelMesh.setColorAt(index * FRONT.length + w, tint);
  });
  // With ?cars=1 there are no ambient vehicles at all, so setColorAt is never called and
  // instanceColor is still null.
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (wheelMesh.instanceColor) wheelMesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  scene.add(wheelMesh);

  // --- Stop bars ------------------------------------------------------------
  //
  // The signal lives on the road, not on a pole. Corner-mounted heads were unreadable from this
  // camera: one head served two opposing approaches, it sat nearer the block corner than the road
  // it governed, and nothing about it said which direction it applied to. A bar painted across
  // the lane you are driving, at the point you would stop, removes both ambiguities — there is
  // exactly one bar for your approach and it is directly in front of you.
  //
  // Placed just outside the crosswalk, so a car holding at the line sits behind the bar rather
  // than on top of it.
  const BAR_DISTANCE = HALF_ROAD + 2.05;

  const barGeo = bakeColor(new THREE.PlaneGeometry(0.7, 3.6), new THREE.Color(1, 1, 1));
  barGeo.rotateX(-Math.PI / 2);

  const bars = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (isUnsignalised(i, j)) continue;         // ring junctions are yield-controlled
      for (let d = 0; d < 4; d++) {
        // Only worth a bar if traffic can actually arrive on this approach.
        if (!nextIntersection(opposite(d), i, j)) continue;
        if (isSegmentClosed(i, j, opposite(d))) continue;

        const lane = laneOffsetCoord(d, i, j);
        const back = -dirSign(d) * BAR_DISTANCE;
        bars.push({
          i,
          j,
          d,
          x: isXAxis(d) ? lineCoord(i) + back : lane,
          z: isXAxis(d) ? lane : lineCoord(j) + back,
          turned: !isXAxis(d),
        });
      }
    }
  }

  const barMesh = new THREE.InstancedMesh(barGeo, propMaterial(), bars.length);
  barMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  barMesh.name = 'stopBars';
  const dummy = new THREE.Object3D();
  bars.forEach((bar, index) => {
    dummy.position.set(bar.x, 0.05, bar.z);
    dummy.rotation.set(0, bar.turned ? Math.PI / 2 : 0, 0);
    dummy.updateMatrix();
    barMesh.setMatrixAt(index, dummy.matrix);
  });
  barMesh.instanceMatrix.needsUpdate = true;
  scene.add(barMesh);

  // `distance` is the honest throughput measure. Counting how many cars are moving at one
  // instant is far too noisy to tune signal timing against — it swings with whatever the
  // phase happens to be at the moment you sample it.
  const stats = {
    time: 0, violations: 0, minGap: Infinity, moving: 0, waiting: 0,
    distance: 0, routeDesync: 0, rightOnRed: 0,
  };

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();
  const headColor = new THREE.Color();

  const wheelMatrix = new THREE.Matrix4();
  const wheelLocal = new THREE.Matrix4();
  const wheelQuat = new THREE.Quaternion();
  const wheelPos = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /**
   * Write one ambient car's body matrix and the two front wheels hanging off it. The wheels are
   * composed *through* the body matrix rather than in world space, so they inherit the bob, the
   * corner lean and the pitch rock for free and stay bolted to the arches through all three.
   */
  function writeAmbient(car) {
    mesh.setMatrixAt(car.instanceIndex, matrix);
    wheelQuat.setFromAxisAngle(UP, car.wheelAngle);
    for (let w = 0; w < FRONT.length; w++) {
      const anchor = FRONT[w];
      wheelPos.set(anchor.x, anchor.y, anchor.z);
      wheelLocal.compose(wheelPos, wheelQuat, scl);
      wheelMatrix.multiplyMatrices(matrix, wheelLocal);
      wheelMesh.setMatrixAt(car.instanceIndex * FRONT.length + w, wheelMatrix);
    }
  }

  /**
   * May a car joining the ring pull out? Only if nothing on the ring is bearing down on the
   * junction — the ring never stops, so the gap has to be a real one.
   */
  /** Is the cross traffic that currently holds the green far enough away to turn right on red? */
  function rightOnRedClear(car, t, approaching) {
    const phase = lightPhase(car.i, car.j, t);
    const movingDirs = phase.axis === 'x' ? [0, 2] : [1, 3];
    for (const d of movingDirs) {
      for (const other of approaching.get(`${car.i},${car.j},${d}`) ?? []) {
        const stop = along(other.d, entryPoint(other.d, other.i, other.j));
        const gap = (stop - other.s) * dirSign(other.d);
        if (gap >= 0 && gap < RIGHT_ON_RED_YIELD) return false;
      }
    }
    return true;
  }

  function ringGapClear(car, ring, approaching) {
    const dirs = ring === 'x' ? [0, 2] : [1, 3];
    for (const d of dirs) {
      for (const other of approaching.get(`${car.i},${car.j},${d}`) ?? []) {
        const stop = along(other.d, entryPoint(other.d, other.i, other.j));
        const gap = (stop - other.s) * dirSign(other.d);
        if (gap >= 0 && gap < RING_YIELD) return false;
      }
    }
    return true;
  }

  function update(dt) {
    stats.time += dt;
    const t = stats.time;

    // Set before any car evaluates a signal this frame. Ring junctions get an override too —
    // the ring-vs-cross branches below check `priorityCovers` and route the boosting taxi through
    // `canProceed`, which then yields the crossing ring traffic to the taxi's axis. A stunned or
    // crashed taxi is off the lane grid: releasing its priority hold lets signals run.
    const taxiActive = !taxi.crashed;
    setPriorityJunction(taxiActive && taxi.boost && !taxi.stunned
      ? { i: taxi.i, j: taxi.j, axis: isXAxis(taxi.d) ? 'x' : 'z' }
      : null);

    if (taxiActive && taxi.boost && !taxi.wasBoosting && !taxi.stunned) {
      taxi.v = Math.max(taxi.v, SPEED * BOOST_KICK);
    }
    taxi.wasBoosting = taxi.boost;

    // Weave inside the lane while boosting — the "he is driving like a maniac" tell, now that the
    // taxi holds its own lane instead of straddling the centreline. Skipped while it is stunned:
    // the drift physics owns its position for the moment.
    //
    // Both the wave's argument and its envelope are paced by *distance travelled*, not by elapsed
    // time, and neither advances unless the car is running straight. The centreline version this
    // replaced learned that the hard way twice: a time-paced offset slid the car sideways while it
    // sat still at a red, and a ramp that ran through a corner pushed it off its own Bézier arc
    // partway round. Freezing the phase mid-turn also means the corner ends on the offset it
    // started on, with no jump back onto the wave on the way out.
    if (taxiActive && !taxi.stunned) {
      if (taxi.state === 'drive') {
        const ds = taxi.v * dt;
        taxi.swervePhase += ds;
        const delta = (taxi.boost ? 1 : 0) - taxi.swerve;
        taxi.swerve += Math.sign(delta) * Math.min(Math.abs(delta), ds / SWERVE_FADE);
      }

      const wave = locoWeave(taxi.swervePhase);
      taxi.lateral = taxi.swerve * wave.lateral;

      // Point where it is sliding. Without a yaw offset the car crabs — translating sideways
      // across the road while still aimed straight down it — and that is what read as broken
      // about the old overtake, not the offset itself. Because the offset is a function of
      // distance, its slope *is* the tangent of the steering angle at any speed, so there is
      // nothing to divide by v here: atan(0.40·k1 + 0.12·k2) ≈ 12° at the peak, against the 13°
      // the old lane change held. Mid-corner the yaw belongs to the arc, so the weave's share of
      // it eases out; the 0.1s ease is only so the wheel straightens instead of snapping.
      const slope = taxi.state === 'drive' ? taxi.swerve * wave.slope : 0;
      taxi.steer += (Math.atan(slope) - taxi.steer) * Math.min(1, dt / 0.1);
    }

    // --- Index cars by lane so each one can see the vehicle immediately ahead.
    // A car mid-turn keeps a presence in its entry lane for the first part of the turn,
    // otherwise following cars pile into the intersection behind it.
    const lanes = new Map();
    const approaching = new Map(); // for left-turn yielding
    // Intersections with a car stuck mid-turn, waiting for room to land. Cross traffic must not
    // be released into one of these or it drives straight through the stranded car.
    const heldAt = new Set();

    for (const car of cars) {
      if (car.state === 'turn' && car.turnT >= 0.95) heldAt.add(`${car.i},${car.j}`);
    }

    for (const car of cars) {
      let key = null;
      let laneS = 0;
      let laneDir = car.d;

      // A stunned car is off the grid entirely — followers just have to see it as an obstacle at
      // render time. A crashed taxi is not in traffic at all. A *boosting* taxi used to be
      // skipped here too, on the grounds that it had left its lane; now that it only weaves
      // within it, it belongs in the bookkeeping like anyone else. That cuts both ways and both
      // matter: it sees the car it is closing on, and traffic behind it sees it when the car in
      // front makes it brake — an ambient car rear-ending the taxi ended the run through no fault
      // of the player.
      if (car.stunned || car.crashed) continue;

      if (car.state === 'drive') {
        key = car.laneKey;
        laneS = car.s;
        const arrivalKey = `${car.i},${car.j},${car.d}`;
        if (!approaching.has(arrivalKey)) approaching.set(arrivalKey, []);
        approaching.get(arrivalKey).push(car);
      } else if (car.turnT < 0.6) {
        // First half of the turn: still queued behind in the lane it came from.
        key = laneKeyFor(car.d, car.i, car.j);
        laneS = along(car.d, car.entry) + dirSign(car.d) * car.turnT * 5;
      } else {
        // Second half: hand the car over to the lane it is about to land in. Without this it
        // is invisible to that lane's traffic for the rest of the turn, and then materialises
        // on top of whatever drove into the gap.
        laneDir = car.dOut;
        key = laneKeyFor(car.dOut, car.i, car.j);
        laneS = along(car.dOut, car.exit) - dirSign(car.dOut) * (1 - car.turnT) * 5;
      }

      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push({ car, laneS, laneDir });
    }

    // Nearest car ahead, per lane.
    const leaderGap = new Map();
    for (const [, members] of lanes) {
      // Every member of a lane shares its travel direction; use the recorded lane direction
      // rather than car.d, which still holds the entry direction for a turning car.
      const sign = dirSign(members[0].laneDir);
      members.sort((a, b) => (b.laneS - a.laneS) * sign);
      for (let k = 1; k < members.length; k++) {
        const behind = members[k];
        const ahead = members[k - 1];
        const gap = (ahead.laneS - behind.laneS) * sign;
        // Only measure real lane geometry. A turning car's lane position is a synthetic stand-in
        // used for queueing, so including it here reports overlaps that don't exist on screen.
        if (behind.car.state === 'drive' && ahead.car.state === 'drive' && gap < stats.minGap) {
          stats.minGap = gap;
        }
        leaderGap.set(behind.car, ahead.laneS);
      }
    }

    stats.moving = 0;
    stats.waiting = 0;

    for (const car of cars) {
      if (car.crashed) continue;
      if (car.collisionCooldown > 0) car.collisionCooldown = Math.max(0, car.collisionCooldown - dt);

      // Ease panic toward its target on every car every frame, so it decays smoothly whether the
      // car is driving, turning, or otherwise skipped by the physics branch below.
      const panicTarget = panicTargetFor(car);
      car.panic += (panicTarget - car.panic) * Math.min(1, dt * 6);

      if (car.stunned) {
        // Drift under the impact kick, wobble in yaw, sit at v=0 so exit-speedFactor logic doesn't
        // spike. Damping settles both linear and angular so the car isn't still sliding when the
        // timer runs out and recovery snaps it back to a lane centre.
        const s = car.stunned;
        s.timeLeft -= dt;
        car.x += s.vx * dt;
        car.z += s.vz * dt;
        car.yaw += s.yawRate * dt;
        const damp = Math.exp(-4 * dt);
        s.vx *= damp;
        s.vz *= damp;
        s.yawRate *= damp * 0.85;
        car.v = 0;
        car.speedFactor = 0;
        if (s.timeLeft <= 0) recoverFromStun(car);
        continue;
      }

      if (car.state === 'drive') {
        const sign = dirSign(car.d);
        const stopS = along(car.d, entryPoint(car.d, car.i, car.j));
        const holdS = stopS - sign * STOP_SETBACK;
        const distToLine = (holdS - car.s) * sign;

        // --- How much road is this car actually allowed to use before it must be stopped?
        let allowed = Infinity;

        // The signal ahead, read now rather than on arrival — this is what lets it slow early.
        // A corridor or a boosting-taxi priority hold both temporarily signalise the ring, so the
        // taxi's axis reads as green and cross ring traffic yields to it.
        const ringAxis = corridorCovers(car.i, car.j) || priorityCovers(car.i, car.j)
          ? null : ringAxisAt(car.i, car.j);
        const onRingNow = ringAxis !== null && (isXAxis(car.d) ? 'x' : 'z') === ringAxis;
        const open = ringAxis !== null
          ? onRingNow
          : canProceed(car.d, car.i, car.j, t) || taxiClearsYellow(car, distToLine, t);
        if (!open) allowed = Math.min(allowed, Math.max(0, distToLine));

        // The car ahead. A boosting taxi used to ignore this entirely — it was out on the
        // centreline and went round. In its own lane it has to see the leader or it drives into
        // the back of it, so it tailgates at BOOST_GAP instead: still visibly impatient, still
        // clear of the collision envelope, and it takes the gap the instant the leader turns off.
        const aheadS = leaderGap.get(car);
        if (aheadS !== undefined) {
          const gap = car.boost ? BOOST_GAP : MIN_GAP;
          allowed = Math.min(allowed, Math.max(0, (aheadS - car.s) * sign - gap));
        }

        if (car.parked) {
          if (car.route.length) car.parked = false;
          else allowed = 0;   // eases to a halt rather than stopping dead
        }

        // Fastest speed still stoppable inside `allowed`, approached under real accel limits.
        // A panicking car — one currently reacting to the siren — dips off the throttle. The
        // deeper reaction is visual (the swerve and the wobble at render time); this just keeps
        // it from serenely holding cruise while jerking around the road.
        const cruiseCap = SPEED * (1 - PANIC_BRAKE * car.panic);
        const topSpeed = car.boost ? SPEED * BOOST_SPEED : cruiseCap;
        const accel = car.boost ? BOOST_ACCEL : ACCEL;
        const desired = Math.min(topSpeed, Math.sqrt(2 * BRAKE * Math.max(0, allowed)));
        car.v = desired > car.v
          ? Math.min(desired, car.v + accel * dt)
          : Math.max(desired, car.v - BRAKE * dt);

        let step = Math.min(car.v * dt, Math.max(0, allowed));
        // Braking only asymptotes toward the line; snap the last sliver so arrival happens.
        if (allowed < 0.05) { step = Math.max(0, allowed); car.v = 0; }

        // No `distToLine > 0` guard: with the hold line set back from the junction, a car can
        // spawn already beyond it, and requiring it to still be approaching meant the decision
        // never fired and the car drove off the map forever.
        if (distToLine - step <= 0) {
          // About to reach the stop line — decide whether to enter the intersection.
          // A corridor or a boosting-taxi priority hold temporarily signalises the ring, so the
          // siren's or the taxi's green path is unbroken.
          const ring = corridorCovers(car.i, car.j) || priorityCovers(car.i, car.j)
            ? null : ringAxisAt(car.i, car.j);
          const onRing = ring !== null && (isXAxis(car.d) ? 'x' : 'z') === ring;

          let green;
          let viaRightOnRed = false;
          if (ring !== null) {
            // No signal here. Ring traffic runs; anyone joining waits for a real gap.
            green = onRing || ringGapClear(car, ring, approaching);
          } else {
            const held = heldAt.has(`${car.i},${car.j}`);
            green = (canProceed(car.d, car.i, car.j, t) || taxiClearsYellow(car, distToLine, t))
              && !held;

            // Right on red. Permitted only as a right turn, only with a gap in the traffic that
            // currently holds the green, and never into a junction an emergency vehicle is
            // clearing or one already blocked by a stranded car.
            if (!green && !held && !corridorCovers(car.i, car.j)
                && legalExits(car.d, car.i, car.j).includes(rightOf(car.d))
                && rightOnRedClear(car, t, approaching)) {
              viaRightOnRed = true;
            }
          }

          let dOut = null;

          if (viaRightOnRed) {
            // The only legal move is the right turn. A routed car takes it if its plan agrees;
            // otherwise it waits for the green like anyone else.
            const turn = rightOf(car.d);
            if (!car.route?.length || car.route[0] === turn) {
              dOut = turn;
              if (car.route?.length) car.routeConsumed = true;
            }
          } else if (green) {
            const options = legalExits(car.d, car.i, car.j);

            // A routed car (the player's taxi) takes the next turn its route calls for; everyone
            // else rolls the weighted straight/right/left dice. This single branch is the entire
            // difference between ambient traffic and a directed vehicle — everything below it
            // (yielding, don't-block-the-box, signals, following distance) applies identically,
            // so the taxi cannot cheat its way to a destination.
            if (car.route?.length && options.includes(car.route[0])) {
              dOut = car.route[0];
              car.routeConsumed = true;
            } else {
              // A routed car whose next step is not a legal exit has desynced from its plan.
              // Silently falling through to a random turn would let it wander while still holding
              // a stale route, so drop the route and count it — this should never fire.
              if (car.route?.length) {
                stats.routeDesync += 1;
                car.route.length = 0;
              }
              // Weight straight/right/left, then fall back to whatever is legal here.
              const weighted = [];
              options.forEach((d) => {
                const kind = d === car.d ? 0 : d === leftOf(car.d) ? 2 : 1;
                weighted.push({ d, w: TURN_WEIGHTS[kind] });
              });
              const total = weighted.reduce((sum, o) => sum + o.w, 0);
              let roll = rng.next() * total;
              for (const option of weighted) {
                roll -= option.w;
                if (roll <= 0) { dOut = option.d; break; }
              }
              dOut ??= options[0];
            }

            // Left turns yield to oncoming traffic close to the same intersection.
            if (dOut === leftOf(car.d)) {
              const oncoming = approaching.get(`${car.i},${car.j},${opposite(car.d)}`) ?? [];
              const blocked = oncoming.some((other) => {
                const otherStop = along(other.d, entryPoint(other.d, other.i, other.j));
                const otherDist = (otherStop - other.s) * dirSign(other.d);
                return otherDist >= 0 && otherDist < YIELD_RANGE;
              });
              if (blocked) dOut = null;
            }

            // Don't block the box: refuse to enter unless there's room to land in the exit lane.
            // Without this, a car finishing a turn is teleported to the exit point regardless of
            // what's already sitting there, which is how cars ended up overlapping.
            if (dOut !== null) {
              const exitKey = laneKeyFor(dOut, car.i, car.j);
              const exitS = along(dOut, exitPoint(dOut, car.i, car.j));
              const exitSign = dirSign(dOut);
              const occupied = (lanes.get(exitKey) ?? []).some(({ car: other, laneS }) => {
                if (other === car || other.state !== 'drive') return false;
                // Clearance is needed on both sides: a car approaching from behind the exit
                // point gets landed on just as hard as one already sitting in front of it.
                // Extra margin on top of the following distance: the exit lane can still back
                // up during the second or so the turn takes, and holding mid-intersection is
                // far more disruptive than simply waiting at the line.
                const ahead = (laneS - exitS) * exitSign;
                return Math.abs(ahead) < MIN_GAP * 1.5;
              });
              if (occupied) dOut = null;
            }
          }

          if (dOut === null) {
            // Held at the line after all — the routed turn was never taken, so the route must not
            // advance. It will be reconsidered next frame.
            car.routeConsumed = false;
            car.s = holdS - sign * 0.02; // hold at the line, clear of the crosswalk
            stats.waiting += 1;
            continue;
          }

          // The turn is now committed, so it is safe to consume the routed step.
          if (car.routeConsumed) {
            car.route.shift();
            car.routeConsumed = false;
          }

          // Structurally impossible given the gate above, but asserted so a future change to
          // the turn logic can't quietly start running red lights. Ring junctions are exempt —
          // they have no phase to obey.
          if (viaRightOnRed) stats.rightOnRed += 1;
          else if (ring === null && !canProceed(car.d, car.i, car.j, t)
              && !taxiClearsYellow(car, distToLine, t)) stats.violations += 1;

          car.entry = entryPoint(car.d, car.i, car.j);
          car.exit = exitPoint(dOut, car.i, car.j);
          car.control = turnControl(car.d, dOut, car.i, car.j);
          car.dOut = dOut;
          car.turnT = 0;

          // The hold line is now behind the junction boundary, so crossing it is a straight
          // run-up followed by the arc. Keeping the arc itself anchored at the boundary is what
          // preserves crisp corners — starting the curve from the hold line instead would turn
          // every corner into a long lazy sweep.
          const lane = laneOffsetCoord(car.d, car.i, car.j);
          car.hold = isXAxis(car.d) ? { x: holdS, z: lane } : { x: lane, z: holdS };
          car.leadIn = STOP_SETBACK;
          car.turnLen = car.leadIn + Math.max(
            0.1,
            Math.hypot(car.control.x - car.entry.x, car.control.z - car.entry.z)
            + Math.hypot(car.exit.x - car.control.x, car.exit.z - car.control.z),
          );
          car.state = 'turn';
          stats.moving += 1;
          continue;
        }

        car.s += sign * step;
        car.travelled += step;
        car.speedFactor = car.v / SPEED;
        stats.distance += step;
        if (step > 0.0001) stats.moving += 1; else stats.waiting += 1;
      } else {
        // --- Mid-turn: follow the arc through the intersection.
        // Corners are taken slower, and the car has to spend real time getting back up to speed
        // on the way out.
        // Crossing a junction is not the same as cornering. Every junction transition runs through
        // this state, including going straight on, and clamping all of them to a corner speed made
        // cars sag at every block — the boosting taxi especially, which would hit top speed on the
        // straight and then shed a third of it to cross an empty junction in a straight line.
        const straightOn = car.dOut === car.d;
        const cruise = car.boost ? SPEED * BOOST_SPEED : SPEED;
        // Crazy mode doesn't lift for left-turns or straights — it goes round them at full pelt,
        // and the lean plus the rubber on the road sell it instead of a speed drop. Right turns
        // are the exception: with right-hand traffic they cut across the near corner (chord ≈
        // HALF_ROAD − LANE per leg) instead of the far diagonal a left turn sweeps, so at full
        // boost the whole arc completes in ~0.35s vs a left's ~0.7s and reads as *sped up*. A
        // softer target on rights (0.75× cruise) keeps the no-brakes feel while giving the tight
        // arc back its visual weight.
        const isRight = !straightOn && car.dOut === rightOf(car.d);
        const boostTurn = car.boost ? (isRight ? cruise * 0.75 : cruise) : CORNER_SPEED;
        const cornerTarget = straightOn ? cruise : boostTurn;
        car.v = car.v > cornerTarget
          ? Math.max(cornerTarget, car.v - BRAKE * dt)
          : Math.min(cornerTarget, car.v + (car.boost ? BOOST_ACCEL : ACCEL) * dt);
        car.turnT += (car.v * dt) / car.turnLen;
        car.travelled += car.v * dt;
        car.speedFactor = car.v / SPEED;
        if (car.turnT < 1) stats.distance += SPEED * dt;

        if (car.turnT >= 1) {
          // Re-check the landing spot. Clearance was verified on entry, but the arc takes over
          // a second to traverse and the exit lane can back up in that time — completing
          // regardless is a teleport straight into the car in front.
          const exitS = along(car.dOut, car.exit);
          const exitSign = dirSign(car.dOut);
          const exitKey = laneKeyFor(car.dOut, car.i, car.j);
          const blocked = (lanes.get(exitKey) ?? []).some(({ car: other, laneS }) => {
            if (other === car || other.state !== 'drive') return false;
            const ahead = (laneS - exitS) * exitSign;
            return ahead > -0.1 && ahead < MIN_GAP;
          });

          if (blocked) {
            // Hold just short of completion; the phantom lane entry keeps followers queued.
            car.turnT = 0.999;
            stats.waiting += 1;
            continue;
          }

          const next = nextIntersection(car.dOut, car.i, car.j);
          car.d = car.dOut;
          car.i = next.i;
          car.j = next.j;
          car.s = along(car.d, car.exit);
          car.laneKey = laneKeyFor(car.d, car.i, car.j);
          car.state = 'drive';
          car.turnT = 0;
        }
        stats.moving += 1;
      }
    }

    // --- Resolve render transforms.
    for (let index = 0; index < cars.length; index++) {
      const car = cars[index];

      // A crashed taxi's mesh was hidden by the collision handler; nothing to compose.
      if (car.crashed) continue;

      if (car.stunned) {
        // Position and yaw were stepped by the stun physics; write them straight into the mesh
        // with a slight lift so the car reads as jolted rather than sunken into the tarmac.
        const lift = 0.06;
        // The wheels keep whatever angle the impact caught them at — a slewing wreck isn't
        // steering. Re-baselining the difference here is what stops the yaw the drift physics
        // piled up from arriving as one huge steering input on the frame the car recovers.
        car.prevSteerYaw = car.yaw;
        car.prevTravelled = car.travelled;
        if (car.isTaxi) {
          taxiGroup.position.set(car.x, ROAD_Y + lift, car.z);
          taxiGroup.rotation.set(0, car.yaw, 0);
        } else {
          pos.set(car.x, ROAD_Y + lift, car.z);
          quat.setFromEuler(euler.set(0, car.yaw, 0, 'YXZ'));
          matrix.compose(pos, quat, scl);
          writeAmbient(car);
        }
        continue;
      }

      if (car.state === 'drive') {
        const lane = laneOffsetCoord(car.d, car.i, car.j);
        car.x = isXAxis(car.d) ? car.s : lane;
        car.z = isXAxis(car.d) ? lane : car.s;
        car.yaw = dirYaw(car.d);
      } else {
        const travelled = Math.min(car.turnT, 1) * car.turnLen;
        if (travelled < car.leadIn) {
          // Straight run-up from the hold line to the junction boundary.
          const t = travelled / car.leadIn;
          car.x = car.hold.x + (car.entry.x - car.hold.x) * t;
          car.z = car.hold.z + (car.entry.z - car.hold.z) * t;
          car.yaw = dirYaw(car.d);
        } else {
          const t = (travelled - car.leadIn) / (car.turnLen - car.leadIn);
          const p = bezier(car.entry, car.control, car.exit, t);
          car.x = p.x;
          car.z = p.z;
          car.yaw = lerpAngle(dirYaw(car.d), dirYaw(car.dOut), t);
        }
      }

      // Weave offset, in world units, + toward the road centreline. Applied at render only: the
      // simulation keeps the car on its lane coordinate, so following distances, stop lines and
      // turn arcs are all measured against the lane the car is nominally in — which is what makes
      // it safe to move the body around inside that lane at all.
      //
      // Order matters — the offset is perpendicular to the *lane*, so it has to be taken off the
      // unsteered heading before the steering angle is added on top.
      if (Math.abs(car.lateral) > 0.001) {
        car.x -= Math.sin(car.yaw) * car.lateral;
        car.z -= Math.cos(car.yaw) * car.lateral;
      }
      if (car.steer) car.yaw += car.steer;

      // --- Front wheels point where the car is going.
      //
      // Differenced against the heading the *lane* gave it — after the weave, which is a genuine
      // steering input, and deliberately before the panic wobble below, which is not. The wobble
      // is a shimmy through the body at PANIC_WOBBLE·5.5 ≈ 0.9 rad per unit of road; run through
      // this it would slam the wheels lock to lock several times a second.
      //
      // Paced by distance, like the weave and for the same reason: a car held at a red keeps the
      // lock it rolled up to the line with instead of straightening under a time-based ease, and
      // one stopped mid-turn — waiting for room to land — holds its wheels round the corner. That
      // is also what makes the divide safe, since a stationary car never reaches it.
      const ds = car.travelled - car.prevTravelled;
      car.prevTravelled = car.travelled;
      car.wheelAngle = steerToward(car.wheelAngle, car.yaw, car.prevSteerYaw, ds);
      car.prevSteerYaw = car.yaw;

      // Panic offset: shove kerb-ward and jitter the yaw when the siren is close. The taxi is
      // skipped in panicTargetFor(), so this only ever fires on ambient traffic. Skipped mid-turn
      // — a sideways nudge on the Bézier arc reads as the car popping off its own line rather
      // than as a swerve. (car.right = (sin(yaw), cos(yaw)); the taxi's weave uses the same
      // basis with the sign flipped.)
      if (car.panic > 0.001 && car.state === 'drive') {
        const push = PANIC_LATERAL * car.panic;
        car.x += Math.sin(car.yaw) * push;
        car.z += Math.cos(car.yaw) * push;
        // Fast wobble driven by travelled distance so a stopped car doesn't shimmy. Phase offset
        // per car so a queue rattles out of sync rather than all one way.
        const wobble = Math.sin(car.travelled * 5.5 + car.phase) * PANIC_WOBBLE * car.panic;
        car.yaw += wobble;
      }

      // A little vertical bob, scaled by how fast the car is actually going, so stopped traffic
      // sits still instead of idling like a boat.
      const bob = Math.sin(car.travelled * 2.4 + car.phase) * 0.045 * car.speedFactor;

      // Body roll through a corner. Leans *outward* — away from the turn centre — because that
      // is what weight transfer does, and leaning inward reads as a motorbike.
      let roll = 0;
      if (car.state === 'turn') {
        const along01 = (Math.min(car.turnT, 1) * car.turnLen - car.leadIn)
          / Math.max(1e-6, car.turnLen - car.leadIn);
        if (along01 > 0) {
          const turnDir = car.dOut === rightOf(car.d) ? 1 : car.dOut === leftOf(car.d) ? -1 : 0;
          const lean = 0.3 * Math.min(2.2, Math.max(0.7, car.v / SPEED));
          roll = -turnDir * lean * Math.sin(Math.PI * Math.min(1, along01));
        }
      }

      // Rocking. Pitch is a spring-damper driven by longitudinal acceleration: braking dips the
      // nose forward, easing off the brake lifts it, and the underdamping (ζ ≈ 0.4) makes both
      // events end on a small bounce so it reads as suspension travel. Impulse to pitchV works
      // out as K·SCALE·Δv, independent of dt — a one-frame velocity jump (boost kick, stop-line
      // snap) delivers the same rock at any frame rate.
      const accel = dt > 1e-6 ? (car.v - car.prevV) / dt : 0;
      car.prevV = car.v;
      const targetPitch = Math.max(-0.13, Math.min(0.13, accel * 0.014));
      car.pitchV += ((targetPitch - car.pitch) * 60 - car.pitchV * 6) * dt;
      car.pitch += car.pitchV * dt;

      // Loco Mode kickoff: a short, one-shot wheelie added on top of the pitch spring. Handled
      // outside the spring on purpose — the spring is calibrated for tiny suspension travel, so a
      // 15° pop through it would either be swallowed by damping or need a wildly out-of-scale
      // impulse. A hand-shaped bump ramps up fast, holds a beat, drops with a small settle, and
      // never leaves the pitch bookkeeping in a weird state when it ends.
      let wheelieBoost = 0;
      if (car.wheelieT !== undefined && car.wheelieT !== null) {
        car.wheelieT += dt;
        const dur = WHEELIE_DUR;
        if (car.wheelieT >= dur) {
          car.wheelieT = null;
        } else {
          const t = car.wheelieT / dur;
          // Rise: ease-out sine to 1 by t=0.28. Fall: smoothstep back to 0 with a small
          // bounce back to zero so it doesn't overshoot into a nose-dip.
          const shape = t < 0.28
            ? Math.sin((t / 0.28) * (Math.PI / 2))
            : (1 - (t - 0.28) / 0.72) ** 1.6;
          wheelieBoost = WHEELIE_PEAK * shape;
        }
      }
      const shownPitch = car.pitch + wheelieBoost;

      // Roll and pitch both pivot on the car's origin at road level, so tilting drives one edge
      // underground. Lifting by the sagitta of each keeps the low edge on the tarmac and reads as
      // suspension travel rather than clipping.
      const lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
        + Math.abs(Math.sin(shownPitch)) * (CAR_LEN / 2);

      if (car.isTaxi) {
        taxiGroup.position.set(car.x, ROAD_Y + bob + lift, car.z);
        taxiGroup.rotation.set(roll, car.yaw, shownPitch);
        setTaxiSteer(car.wheelAngle);
        continue;
      }

      pos.set(car.x, ROAD_Y + bob + lift, car.z);
      quat.setFromEuler(euler.set(roll, car.yaw, car.pitch, 'YXZ'));
      matrix.compose(pos, quat, scl);
      writeAmbient(car);
    }
    mesh.instanceMatrix.needsUpdate = true;
    wheelMesh.instanceMatrix.needsUpdate = true;

    // --- Stop bar colours, one per approach.
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      const phase = displayPhase(bar.i, bar.j, t);
      const mine = phase.axis === (isXAxis(bar.d) ? 'x' : 'z');
      headColor.set(mine
        ? (phase.yellow ? PALETTE.lightYellow : PALETTE.lightGreen)
        : PALETTE.lightRed);
      barMesh.setColorAt(index, headColor);
    }
    if (barMesh.instanceColor) barMesh.instanceColor.needsUpdate = true;
  }

  /** Fixed-step warm-up so screenshots show settled traffic, deterministically. */
  function warmup(seconds, step = 1 / 60) {
    for (let elapsed = 0; elapsed < seconds; elapsed += step) update(step);
  }

  return {
    cars, taxi, taxiGroup, setTaxiFareColor, mesh, wheelMesh, barMesh, update, warmup, stats,
    lightPhase, displayPhase,
  };
}
