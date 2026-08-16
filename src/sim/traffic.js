import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { KERB_H } from '../city/ground.js';
import {
  WHEEL_R, CHASSIS_LIFT, wheelAnchors, wheelGeometry, wheelGeometries,
} from '../geometry/wheels.js';
import {
  brakeLightGeometry, turnSignalGeometry, brakeLightMaterial, turnSignalMaterial,
} from '../geometry/lights.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import {
  GRID, HALF_ROAD, LANE, isXAxis, dirSign, dirYaw, leftOf, rightOf, opposite,
  ringAxisAt, isUnsignalised, lineCoord,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';

// Re-exported for callers that still ask the *grid* about a junction. The sim itself no longer
// decides anything with either: whether a junction carries a light is `node.signal !== null`, which
// is the only form that can see a closure leaving nothing to arbitrate.
export { ringAxisAt, isUnsignalised };
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

// Exported because the road network needs it to compute green-wave offsets, and `city/` is not
// allowed to import from `sim/`. It keeps its own copy as `SIGNAL_DEFAULTS.cruise` in
// city/roadnet.js and `tools/roadnet.mjs` asserts the two are equal — a silent drift between them
// would detune every signal offset in the city with nothing to show for it.
export const SPEED = 8.5;

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
export const WHEELIE_DUR = 0.55;

/**
 * The kickoff wheelie as a pitch offset, given seconds since it fired. Rise is an ease-out sine to
 * the peak by t=0.28 of the duration; the fall is shaped so it settles back to zero without
 * overshooting into a nose-dip.
 *
 * Hand-shaped rather than run through the pitch spring, which is calibrated for tiny suspension
 * travel: a 17° pop through it would either be swallowed by the damping or need a wildly
 * out-of-scale impulse. Exported so the police car plants its nose the same way when it locks on.
 */
export function locoWheelie(elapsed) {
  const t = elapsed / WHEELIE_DUR;
  if (t < 0 || t >= 1) return 0;
  const shape = t < 0.28
    ? Math.sin((t / 0.28) * (Math.PI / 2))
    : (1 - (t - 0.28) / 0.72) ** 1.6;
  return WHEELIE_PEAK * shape;
}

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
export const STOP_SETBACK = 3.4;

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
//
// `block` names one further direction that is denied even though its axis reads green. It is only
// ever the direction opposite the taxi, and only when the taxi's route calls for a left turn:
// a green axis lets oncoming traffic through, and a left turn has to yield to it, so a boosting
// taxi turning left stopped dead at a junction it supposedly owned. Holding the oncoming lane for
// the beat it takes to cross is the same courtesy the cross streets already extend.
let priorityJunction = null;   // { i, j, axis, block }

export function setPriorityJunction(next) {
  priorityJunction = next;
}

// --- Roadworks ----------------------------------------------------------------
//
// Lanes ambient traffic declines to turn into, published by src/game/roadwork.js when it closes a
// street off. Pushed in from game/ the same way the corridor is, because sim/ must not import from
// game/.
//
// **This is a soft closure and it has to be.** The hard one already exists — grid.js's
// `setClosedSegments`, which a park district uses — but that is read *once*, at bake time, by
// `roadNetFromGrid`: it deletes the edge, merges the two blocks it separated into one face and
// re-derives every signal phase around it. Re-baking mid-run would leave every `car.lane` and
// `car.turn` in the cars array pointing into a graph that no longer exists, and the ground is one
// merged mesh built at startup with no road in it to remove. So the network stays exactly as it
// was and two lane ids are simply unpopular.
//
// **The player's taxi never consults this.** A routed car takes its turn from its route, which is
// planned by game/route.js over the untouched network — so the taxi drives through a closure while
// every ambient car goes round, which is the whole point of the feature.
//
// The taxi's router is told about the same lanes separately, and told the opposite thing: see
// `setRoadworkLanes` in game/route.js, which prices them *below* an ordinary street so a fare
// actually leads the player through. This set forbids, that one tempts.
//
// This used to add "so no fare's clock moves", which is no longer quite true and was never true
// for the reason given. `chainSeconds` does plan over the discounted weights — but
// `estimateSeconds` bills a route in blocks and turns, never in lane cost, so the discount can only
// move a clock by changing which route is picked, bounded at one leg either way.
let closedLanes = new Set();

export function setClosedLanes(ids) {
  closedLanes = new Set(ids);
}

/**
 * Is this lane currently closed? Exported for tools/probe.mjs, which has to be able to see that a
 * zone *reopened* its street on the way out — a closure left behind after the barricades have gone
 * is invisible from every other angle and would just look like traffic avoiding a road forever.
 */
export const isLaneClosed = (id) => closedLanes.has(id);

// --- The ramp -----------------------------------------------------------------
//
// A barricade is a ramp, and hitting one launches the taxi. The arc is *rendered only*: car.s,
// car.lane, the turn decision, following distance and the collision test all carry on exactly as
// if the car were on the tarmac, which is what stops a stunt being able to break the sim.
//
// **Paced by distance, not by time** — the same lesson the Loco weave and the front-wheel ease
// both record. A half-second hop covers 4.25 units at cruise and 11.5 in overdrive, and 11.5 is
// nearly a whole 12-unit lane: the taxi would still be in the air at `holdS`, where it decides
// its next turn. A fixed 6-unit arc lands in the same place at any speed, and freezes if the car
// stops.
// 5.5 rather than the original 6.0 because the barricade moved: pushing BARRIER_S out to 2.1 to
// get the ramp's toe out of the junction box lands the taxi at 2.1 + 6.0 = 8.1 on a 12-unit lane
// whose hold line is at 8.6, and half a unit is not enough slack to be sure of. At 5.5 it touches
// down at 7.6 with a clear unit in hand. The two numbers are a chain — probe.mjs asserts the margin
// rather than just the outcome, so moving either one alone fails loudly.
export const HOP_LEN = 5.5;
// Height is free of that chain — it is the *span* that has to land before the hold line, and the
// apex costs nothing but air. 1.55 was under half a car length and about 12px at play zoom, which
// at a 3/4 camera is a lift rather than a jump: the taxi's own shadow never separated from it far
// enough to say the wheels had left the road. 2.75 is most of a car length and about 21px, and the
// shadow gap is what sells it.
const HOP_HEIGHT = 2.75;
const HOP_PITCH = 0.34;     // nose up off the ramp, level at the apex, nose down into the landing

// Touchdown. Two decaying hops, plus a nose-down impulse into the pitch spring so the suspension
// visibly takes the hit — the spring is underdamped (ζ ≈ 0.4, see the rocking block in the frame
// loop) and rocks back out of it on its own, which is the whole reason the kick is an impulse
// rather than a second hand-animated curve.
//
// **Paced by a clock, unlike the arc above it**, and the difference is not an inconsistency. The
// hop is distance-paced because it has to come down before the hold line, so where it ends is the
// whole constraint. A bounce ends wherever it likes: nothing downstream reads it, it moves the
// rendered group and nothing else. What it models is a spring settling, and a spring settles in
// seconds — paced over 3.4 units instead, it ran 0.4s at cruise and 0.15s in overdrive, which is
// nine frames for two rebounds and lands somewhere between a flicker and nothing at all.
export const BOUNCE_DUR = 0.42;
const BOUNCE_HEIGHT = 0.55;
const BOUNCE_PITCH = 1.25;    // rad/s into pitchV. ω ≈ 7.75, so this dips the nose about 9°

/**
 * Height of the landing bounce, `t` seconds after touchdown. Zero outside the bounce.
 *
 * `|sin|` over two periods is two rebounds; the linear decay takes the second to a third of the
 * first, so it reads as the tail of a landing rather than as a second jump. The decay was squared
 * to begin with, which sounds like the same shape and is not: the first hump peaks a quarter of the
 * way in, where a squared decay has already taken 44% off it, so the visible rebound came out at
 * 0.22 units against the 0.4 the constant claimed. Exported so tools/probe.mjs can assert the curve
 * itself — measuring it off the rendered taxi means measuring the speed bob and the pitch lift too,
 * and at overdrive those are three times the size of the thing being measured.
 */
export function landingBounce(t) {
  const u = t / BOUNCE_DUR;
  if (u < 0 || u >= 1) return 0;
  return BOUNCE_HEIGHT * Math.abs(Math.sin(Math.PI * 2 * u)) * (1 - u);
}

/** Launch `car` off a ramp. Idempotent while already airborne — a second barricade doesn't stack. */
export function launchHop(car) {
  if (car.hopFrom != null) return;
  car.hopFrom = car.travelled;
}

// --- Panic --------------------------------------------------------------------
//
// Where the police car actually is on its road, published by src/sim/police.js each frame while a
// run is live. Corridor already tells us which axis/line the siren is running on, but not *where*
// along it — and the frantic reaction below is a proximity effect, not a per-road one, so it needs
// the s coordinate too. Cleared on stop.
let policePresence = null;   // { axis: 'x' | 'z', line: number, s: number, dir: 1 | -1 }

export function setPolicePresence(next) {
  policePresence = next;
}

/** The road a live siren is on, for the things outside the sim that have to stay off it. */
export const policeRoad = () => policePresence;

// Cars on the police car's own road react as it approaches: swerve outward toward the kerb,
// wobble in yaw, dip the throttle. The siren straddles the centreline at ~2× traffic speed, so
// both same-direction and oncoming lanes get rushed past — the reaction has to work for both.
const PANIC_RANGE = 26;        // world units at which the reaction begins to fade in
const PANIC_LATERAL = 0.9;     // outward push in world units at full panic (kerb sits ~1.15 out)
const PANIC_WOBBLE = 0.16;     // yaw jitter amplitude (radians) at full panic
const PANIC_BRAKE = 0.35;      // fraction of cruise speed shed at full panic

// --- Yielding to the siren ------------------------------------------------------
//
// Panic is a reaction; this is a manoeuvre. It only applies to a car in the cruiser's *own* lane
// — same road, same direction of travel — with the siren coming up behind it, because that is the
// only geometry the cruiser cannot resolve on its own. Oncoming traffic already clears: the two
// lane centres are 2·LANE = 4 apart and the bodies are 1.7 wide, so there is a clear 2.3 units
// between them. Same-lane traffic has *zero* separation by construction — the cruiser drives the
// identical lane coordinate at 19 (corridor) or 26 (chase) against an 8.5 u/s ambient car, so
// before this it simply passed through every car it caught up with.
//
// The fix is two-sided, and it has to be: the pull-over alone is not enough to clear a 1.7-wide
// body out of a 1.7-wide car's path.
//   • The car pulls over by PULLOVER_LATERAL and rides up onto the kerb — outer wheels up, so the
//     body leans *toward the road* and lifts by part of KERB_H.
//   • The cruiser dodges toward the road centreline by DODGE_LATERAL (see police.js), which it
//     can afford because the corridor has already stopped everything that would be coming the
//     other way.
// Lane centre is 2 off the centreline and the kerb face is at 4, so the car's outer edge goes
// from 2.85 to 4.35 — a third of the body over the kerb — while the cruiser drops to 0.9 off the
// centreline. That is 2.6 between the two centres against 1.7 of summed half-widths: 0.9 units of
// daylight, which is enough to read as a squeeze rather than a clip.
const PULLOVER_RANGE = 34;        // how far back the siren is felt. ~1.8s of warning at chase speed
const PULLOVER_CLEAR = 7;         // how far past the car the siren gets before the car lets go
const PULLOVER_LATERAL = 1.5;     // pull-over at full yield; 1.15 is where the kerb face starts
const PULLOVER_BRAKE = 0.5;       // fraction of cruise shed on top of the panic dip
const PULLOVER_MOUNT = 0.6;       // fraction of KERB_H the body rides up on the kerb
const PULLOVER_ROLL = 0.11;       // radians of lean toward the road, outer wheels up
// Eased rather than distance-paced, which is a deliberate departure from the weave and the pass.
// Both of those freeze a stopped car on purpose; this one must not, because a queue stopped at a
// red in the cruiser's lane is exactly the case that used to get driven through. Rise is quicker
// than release so the car dives for the kerb and drifts back out.
const PULLOVER_RISE = 5;
const PULLOVER_FALL = 2.2;

// --- Scatter ------------------------------------------------------------------
//
// Loco Mode's premise is that the city yields: the junction ahead flips to the taxi's axis and
// cross traffic balks. The one thing that never yielded was the car directly in front, and that
// is what actually takes the mode's speed away. Measured over 12 minutes of continuous boosting
// at the default density, the taxi spent 9% of its frames queued at BOOST_GAP behind an 8.5 u/s
// ambient car — a 55% speed cut with the button still held — rising to 25% at ?cars=40. Signals
// accounted for 0.0%; the priority hold was already doing its job.
//
// The taxi cannot go round. The lane is 4 wide against a 2.31 collision envelope, which is the
// whole reason the centreline overtake was abandoned (see sim/collisions.js). So the traffic
// moves instead: a car with the boosting taxi on its bumper floors it, and takes the next turn
// it can rather than staying on the taxi's road. The first buys the ~1s to the junction with no
// speed drop, the second is what actually clears the lane.
//
// Trucks never scatter. A 5.6-unit box flooring it to 2.0x cruise and skittering off at the next
// junction reads as weightless — the panic flee is a car-sized reaction. A truck ahead is simply
// an obstacle Loco Mode has to pass or follow, same as it treats the truck's speed everywhere
// else (TRUCK_SPEED, TRUCK_CORNER_SPEED above).
const SCATTER_RANGE = 40;      // how far back the taxi is felt — two blocks, ~2s at boost speed
const SCATTER_SPEED = 2.0;     // multiplier on cruise while fleeing. Just under the taxi's 2.2, so
                               // it still closes and the flee reads as *not quite enough*.
const SCATTER_STRAIGHT_W = 0.04;  // what the "carry straight on" turn weight collapses to

// --- Passing ------------------------------------------------------------------
//
// Loco Mode's one remaining brake is the car directly in front. Scatter moves it, but a lane is
// 4 wide against a 2.31-unit collision envelope, so the taxi cannot go round *inside* the lane.
// It goes round outside it: a full lane change into the **oncoming** lane, past, and back.
//
// This was tried once and abandoned, and the reason is worth being precise about, because it is
// the thing that makes this version work. The old overtake pulled out to the road *centreline*,
// which is the single worst place on the road — LANE (2) from a same-direction leader and 2 from
// oncoming, both inside the 2.31 envelope, so every car it drew level with was a crash whichever
// way that car was pointing. Committing the *whole* lane instead puts 2·LANE (4) between the taxi
// and the car it is passing, which is clear, and 0 between it and anything coming the other way,
// which is the entire point. The centreline is now somewhere the taxi passes *through* rather
// than sits: the change takes PASS_FADE units of road and never settles part-way.
//
// Nothing new is needed to make it dangerous. `sim/collisions.js` tests the taxi against every
// car in world space and is armed for exactly as long as `car.boost` is true, and `car.x/z`
// already carry the lateral offset — so oncoming traffic, and a leader that turns across the
// taxi mid-pass, are both live hazards the moment the taxi is out there.
//
// Sizing: from the lane centre to the oncoming lane centre is 2·LANE. The manoeuvre is the two
// lane changes plus the time alongside — from BOOST_GAP behind to MIN_GAP ahead is 9.8 units of
// relative displacement, about a second at the 10.2 u/s a boosting taxi closes on cruising
// traffic — so roughly 2 · PASS_FADE + 18 ≈ 32 units of road. A block is 20 (a 12-unit lane and
// an 8-unit junction), so a pass **cannot** finish inside one lane: it always spans a junction.
// That is why it is offered only where the route carries straight on, and why the offer
// disappears — and the taxi tucks back in — the moment the next junction is a turn.
const PASS_LATERAL = 2 * LANE;   // 4 units: our lane centre to the oncoming lane centre
/**
 * Units of road for the full lane change.
 *
 * It was 7, ramped **linearly** — and a linear ramp is why the manoeuvre read as angular. The
 * offset is a function of distance and the yaw is its slope, so a constant slope means the car
 * snaps to a 30° crab on one frame, translates in a dead-straight diagonal, and snaps back to
 * square on another. Two corners and a ruled line: the shape of a lane change drawn with a
 * set square, not driven.
 *
 * The offset is smoothstepped now — `e(t) = t²(3 − 2t)`, so the *slope* starts and ends at zero and
 * the yaw eases in and out of the crab instead of stepping into it. That costs road, because
 * smoothstep's peak slope is 1.5× the linear one over the same distance: at 7 units the car would
 * angle 41° at the midpoint, which is more extreme than what it replaced, not less. 10 puts the
 * peak back at atan(1.5 · 4/10) ≈ 31°, within a degree of the old constant, and buys the easing at
 * the ends with three units of road at each rather than with a steeper middle.
 */
const PASS_FADE = 7;
/** Smoothstep and its derivative, for the offset and the yaw that comes off its slope. */
const passEase = (t) => t * t * (3 - 2 * t);
const passEaseSlope = (t) => 6 * t * (1 - t);
/**
 * How hard the body leans into a lane change, in radians at ambient cruise, scaled by speed the
 * same way the corner lean is.
 *
 * Deliberately a fraction of the 0.3 a corner gets: this is a lane change, not a hairpin. What
 * makes it read is not the size but the *sign flipping* — `passEase`'s second derivative is
 * `6 − 12t`, positive over the first half of the change and negative over the second, so the body
 * rolls one way as the car is thrown out of its lane and the other as it settles into the new one.
 * A rock over and back per change, and a mirrored one on the way home, which the old
 * constant-slope translation could not express at all.
 *
 * 0.09 first, which was too polite to read at the speed the manoeuvre happens.
 */
const PASS_BANK = 0.14;
const PASS_BANK_EASE = 2.5;      // units of road for the roll to reach its target — suspension, not a hinge
/**
 * How much crab angle counts as breaking traction, for the rubber laid during a lane change.
 *
 * 0.2 rad is a third of the peak, which covers the middle ~80% of the change: the marks start once
 * the car is genuinely sliding across and stop as it squares up, rather than bracketing the whole
 * manoeuvre with two faint dots. Exported because `main.js` and the passing lab both own effect
 * pools and both have to ask the same question.
 */
export const PASS_RUBBER_SLOPE = 0.2;
/**
 * Is this car sliding across the road hard enough to leave rubber?
 *
 * A function rather than a constant because the rule had two call sites — `main.js` and the lab —
 * and only one of them was reachable from a test. `main.js` cannot be imported headlessly (it boots
 * the game), so its copy of the condition was verified by reading it, which is the same standard
 * that let the mid-junction following hole sit in this file for as long as it did. Exported, both
 * callers ask the same question and `tools/lab.mjs` asserts the answer.
 */
export const laysPassRubber = (car) => Boolean(car.boost)
  && Math.abs(car.passSlope) > PASS_RUBBER_SLOPE;

/**
 * Is the car in front actually in front of *this* car — i.e. in the lane it is occupying?
 *
 * The lane bookkeeping always says yes: a car mid-overtake is still nominally on its own lane at
 * its own arc length, with the car it is drawing level with recorded as its leader. What decides
 * the question in the world is the lateral offset, and this is the one place that difference has
 * teeth.
 *
 * It was `car.passing` — the *commitment* — and the gap between the two is where a nasty freeze
 * lived. Commitment can lapse while the taxi is still bodily out in the other lane: a pass reaching
 * the edge of the map loses its borrowed lane and drops `room`, and the frame that happens the
 * leader brake returns, finds a car 1.9 units "ahead" against a 4.5-unit tailgate, and pins the
 * budget at zero — which snaps `car.v` to 0. Measured: **20.9 u/s to a standstill in a single
 * frame**, side by side with the car it was overtaking, and then a long sit while the leader drove
 * off. Asking about the offset instead means the brake comes back when the taxi is back in the
 * lane, which is the only moment it means anything.
 *
 * Half a lane, because that is where the body stops overlapping the lane it came out of.
 */
const seesLeader = (car) => !car.passing && car.passOffset < LANE;
// Where the taxi pulls out, and the number the whole manoeuvre is sized by. Closing to a body
// length past the leader is (PASS_TRIGGER + 5) units of relative displacement, and at the ~10 u/s
// a boosting taxi gains on cruising traffic that is 1.83 units of road for every unit of it. At
// 20 — the gap where a leader first starts costing the taxi speed, and the obvious place to go —
// the pass wants 46 units of road against the 32 one straight junction buys, so it ran out of
// straightaway and tucked back in behind the very car it pulled out for half the time. Measured
// across 30 runs at ?cars=22: 20 units completed 6 passes of 12, 14 completed 6 of 8, and 10
// completes 8 of 9. Pulling out later costs some frequency (4.6/min -> 2.6) and buys a manoeuvre
// that actually fits the city.
const PASS_TRIGGER = 10;
const PASS_SUSTAIN = 32;         // keeps it committed once out; matches LOOKAHEAD, declared later
// Clear oncoming road the taxi wants before it will borrow the other lane. Exposure is the
// manoeuvre plus the tuck-in, about 1.2s, and a car coming the other way closes at 18.7 + 8.5 =
// 27.2 u/s — so 33 units, rounded. Sweeping it is flat from 25 up (23% of passes wrecked at 25,
// 22% at 35, 21% at 45) and each extra unit costs frequency, so this sits at the knee.
const PASS_SIGHT = 35;
//
// Scatter was expected to need tuning for any of this to work — a car fleeing at SCATTER_SPEED
// (2.0x cruise, 17 u/s) against the taxi's 18.7 closes at 1.7 u/s, which is no pass at all. It
// does not, and the reason is worth writing down so nobody spends the afternoon again. Suppressing
// the flee while the taxi is committed measures as an exact no-op at both ends of the density ramp
// — same passes, same completions, ground speed 19.14 against 19.19 u/s *without* it. PASS_TRIGGER
// is why: a car still only 10 units ahead is by construction a car scatter has already failed to
// move, because one it moved would have opened the gap past the trigger and never been passed at
// all. The cars the taxi goes round are the ones stuck behind something, and telling them to floor
// it does nothing. Sizing the manoeuvre to the road is what made passing possible; the flee was
// never the obstacle.
//
// (Worth knowing if that is ever revisited: suppressing only the same-lane `mark` is *always* a
// no-op, whatever else is true, because on a straight route the "exit lane" is the taxi's own lane
// past the junction and `markExit` re-marks every car the first call skipped.)

/**
 * How rattled a car should be right now: 1 next to the siren, 0 outside PANIC_RANGE, and only
 * ever non-zero for cars on the very road the police is running down. A junction is on two roads,
 * so a car pointed across the siren's road still counts.
 */
function panicTargetFor(car) {
  if (!policePresence || car.isTaxi || car.crashed) return 0;
  const carAxis = isXAxis(car.d) ? 'x' : 'z';
  if (carAxis !== policePresence.axis) return 0;
  const carLine = carAxis === 'x' ? car.j : car.i;
  if (carLine !== policePresence.line) return 0;
  // `policePresence.s` is a world coordinate on the siren's axis — the cruiser is not on a lane —
  // so the car's own `s`, now an arc length, has to be put back into those terms to compare.
  const dist = Math.abs(along(car.d, car.lane.path.at(car.s)) - policePresence.s);
  if (dist >= PANIC_RANGE) return 0;
  return 1 - dist / PANIC_RANGE;
}

/**
 * Is the siren in this car's lane, behind it and closing? 1 once it is on top of the car, ramping
 * in over PULLOVER_RANGE of approach and released once it is PULLOVER_CLEAR past.
 *
 * Same road *and same direction of travel* is what makes this the cruiser's own lane: right-hand
 * traffic puts both on the same side of the centreline, at the same offset, so the two occupy the
 * same strip of tarmac. A car pointed the other way is in the opposing lane and is left to panic.
 */
function pulloverTargetFor(car) {
  if (!policePresence || car.isTaxi || car.crashed) return 0;
  // Not while actually turning. Held sideways off a Bézier the car would cut the near corner's
  // pavement on a right and swing wide into the far lane on a left, and a mid-arc offset reads as
  // the car popping off its own line — the same reason the panic shove sits out a turn. Releasing
  // it here rather than at render time is what makes it a release: the offset eases away over the
  // front of the arc instead of disappearing on the frame the car commits. Straight-through is
  // not a turn (see `dOut !== d`) and keeps the offset.
  if (car.state === 'turn' && car.dOut !== car.d) return 0;
  const carAxis = isXAxis(car.d) ? 'x' : 'z';
  if (carAxis !== policePresence.axis) return 0;
  if ((carAxis === 'x' ? car.j : car.i) !== policePresence.line) return 0;
  if (dirSign(car.d) !== policePresence.dir) return 0;
  // Signed gap along the direction both are travelling: negative while the siren is still behind.
  const rel = policePresence.dir * (policePresence.s - along(car.d, car.lane.path.at(car.s)));
  if (rel > PULLOVER_CLEAR || rel < -PULLOVER_RANGE) return 0;
  return rel >= 0 ? 1 : 1 + rel / PULLOVER_RANGE;
}

/**
 * Should this car hold its line at the junction it is entering, rather than turn across it?
 *
 * Keyed on where the *siren* will be, not on how hard this car is pulling over, because the two
 * cars this has to stop are different cars. One is in the cruiser's own lane and turning off it;
 * the other is the oncoming car turning left across the corridor, which never pulls over at all
 * because it is a whole lane clear of the cruiser right up until the moment it swings into it.
 * Both are on the siren's road, and both are dangerous for the same window — the second or so the
 * cruiser needs to reach the box.
 *
 * A turn takes about a second at cruise, so the look-ahead is a second of siren: 26 units at the
 * corridor's 19 u/s, a shade under at a chase's 26.
 */
const SIREN_BOX_LOOK = 26;

function sirenHoldsTurn(car) {
  if (!policePresence || car.isTaxi) return false;
  const carAxis = isXAxis(car.d) ? 'x' : 'z';
  if (carAxis !== policePresence.axis) return false;
  if ((carAxis === 'x' ? car.j : car.i) !== policePresence.line) return false;
  // The junction this car is arriving at, in the siren's own coordinate, and how far the siren
  // still has to run to reach it. Negative means the cruiser is already past and there is
  // nothing left to wait for.
  const box = lineCoord(carAxis === 'x' ? car.i : car.j);
  const togo = policePresence.dir * (box - policePresence.s);
  return togo > 0 && togo < SIREN_BOX_LOOK;
}

/**
 * Distance from `s` to the nearest ambient car ahead in the siren's own lane, or Infinity.
 *
 * Called from police.js, which has no view of a cars array of its own — hence the parameter
 * rather than a module-level registry: the probe stands up several independent traffic instances
 * in one process, and a singleton would hand the cruiser whichever one was built last.
 *
 * The taxi is excluded on purpose: a chase closes on it deliberately and pulls up at CHASE_ARRIVE,
 * and a cruiser that swerved round its own quarry on the way in would undo the whole beat.
 */
export function sirenLaneAhead(cars, { axis, line, dir, s }) {
  let nearest = Infinity;
  for (const car of cars) {
    if (car.isTaxi || car.crashed) continue;
    if ((isXAxis(car.d) ? 'x' : 'z') !== axis) continue;
    if ((axis === 'x' ? car.j : car.i) !== line) continue;
    if (dirSign(car.d) !== dir) continue;
    const gap = dir * (along(car.d, car.lane.path.at(car.s)) - s);
    if (gap > 0 && gap < nearest) nearest = gap;
  }
  return nearest;
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
/** A street's axis, folded back to the grid's 'x' / 'z'. Only the adapter below needs this. */
const streetAxis = (node, index) => ((node.streets[index]?.axis ?? 0) < 0.1 ? 'x' : 'z');

/**
 * Signal state at an intersection, in the grid's shape.
 *
 * The phase plan itself now lives in the network — see `bakeSignals` — where a phase is a *street*
 * rather than an axis, so a three-way or a diagonal junction has one. This wrapper folds that back
 * to `{ axis, yellow, remaining }` for the callers that still speak grid: the probe, the signal
 * metrics tool, and `displayPhase`. The sim itself no longer goes through it; see `approachSignal`.
 *
 * Two things genuinely change here rather than being re-expressed, both argued in docs/roadnet.md:
 * a junction whose coordinated street a park closure cut in half now measures its green wave along
 * the chain that still exists, and a junction left with only a straight-through carries no signal
 * at all instead of cycling one nobody can use.
 */
export function lightPhase(i, j, t, ignorePriority = false) {
  if (!ignorePriority && priorityJunction && priorityJunction.i === i && priorityJunction.j === j) {
    return { axis: priorityJunction.axis, yellow: false, remaining: Infinity };
  }

  // A siren outranks everything, including the ring — otherwise a corridor crossing the ring
  // would leave a gap in the middle of the green path it is supposed to be clearing.
  if (corridorCovers(i, j)) return { axis: corridor.axis, yellow: false, remaining: Infinity };

  const net = cityNetwork();
  const node = net.nodeByGrid(i, j);

  // Unsignalised — the ring, or a junction with nothing to arbitrate. No phase to report: the
  // priority street simply runs.
  if (!node.signal) {
    return { axis: streetAxis(node, node.priorityStreet), yellow: false, remaining: Infinity };
  }

  const phase = net.phaseAt(node, t);
  return { axis: streetAxis(node, phase.index), yellow: phase.yellow, remaining: phase.remaining };
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

/**
 * The same thing for one approach, which is what a stop bar actually shows. Skips the boost hold
 * and keeps the corridor, exactly as `displayPhase` does and for the reasons above it.
 */
function displaySignal(lane, t) {
  const net = cityNetwork();
  const node = net.nodeById.get(lane.to);
  if (corridorCovers(node.gi, node.gj)) {
    const mine = isXAxis(net.dirOfLane(lane)) ? 'x' : 'z';
    return { open: corridor.axis === mine, yellow: false };
  }
  return net.laneSignal(lane, t);
}

/**
 * What the signal is doing for the approach this car is on.
 *
 * The same four layers `lightPhase` always resolved, in the same order — boosting-taxi hold, police
 * corridor, then the junction's own plan — but asked of the car's *lane* rather than of an axis.
 * That is the change that matters: `phase.axis === (isXAxis(d) ? 'x' : 'z')` is the one comparison
 * in the sim that cannot survive a road at 45 degrees, and it is gone.
 *
 * The two override layers are still grid-shaped because the things that set them are: the corridor
 * is an `{axis, line}` pair and the priority junction an `(i, j)`. Both become network-shaped when
 * police.js is ported.
 *
 * `signalised` is kept distinct from `open` because a red and no-light-at-all mean different things
 * to the caller — wait for green, versus yield on a gap.
 *
 * `street` is which street is *currently moving*, and it has to come out of the same resolution as
 * `open` rather than be looked up separately. While a boost hold or a siren is overriding the
 * junction, the street that holds the green is the one the override names, not the one the phase
 * plan would have picked — and a car that asks the plan instead can end up scanning its own street
 * for a gap, finding itself in it, and never being cleared to move.
 */
function approachSignal(car, t) {
  const mine = isXAxis(car.d) ? 'x' : 'z';
  const node = cityNetwork().nodeById.get(car.lane.to);
  /** The street running along a grid axis at this node, for the two grid-shaped overrides. */
  const streetOnAxis = (axis) => node.streets.findIndex((st) => (st.axis < 0.1 ? 'x' : 'z') === axis);

  if (priorityJunction && priorityJunction.i === car.i && priorityJunction.j === car.j) {
    // `block` denies one approach that would otherwise read green — see setPriorityJunction.
    const open = priorityJunction.block !== car.d && priorityJunction.axis === mine;
    return {
      signalised: true, open, yellow: false, remaining: Infinity,
      street: streetOnAxis(priorityJunction.axis),
    };
  }
  if (corridorCovers(car.i, car.j)) {
    return {
      signalised: true, open: corridor.axis === mine, yellow: false, remaining: Infinity,
      street: streetOnAxis(corridor.axis),
    };
  }
  return cityNetwork().laneSignal(car.lane, t);
}

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
function taxiClearsYellow(car, sig, distToLine) {
  // `sig.yellow` is already "yellow, and it is my approach's phase" — the axis comparison this
  // used to make is exactly what the lane-shaped answer removes.
  if (!car.isTaxi || !sig.yellow) return false;
  const clearDist = Math.max(0, distToLine) + STOP_SETBACK + HALF_ROAD * 2;
  // A near-stopped taxi still commits: without this floor a car that just crept up to the line
  // would refuse to move even with the whole yellow left to use.
  const v = Math.max(car.v, SPEED * 0.7);
  return clearDist / v <= sig.remaining + cityNetwork().signal.yellow * 0.5;
}

// --- Cars -------------------------------------------------------------------

export const CAR_LEN = 3.4;
export const CAR_W = 1.7;
const MIN_GAP = CAR_LEN + 1.9;   // centre-to-centre, car following car

// Box trucks share an ordinary car's collision envelope on purpose — sim/collisions.js is keyed
// off CAR_LEN/CAR_W regardless of which vehicle it's testing, and that stays a simplification: it
// only matters while the taxi is boosting, and Loco Mode's own tuned numbers (BOOST_GAP below)
// already assume a CAR_LEN leader. Ordinary following distance can't get away with the same
// shortcut — MIN_GAP alone queued a car 0.8 units behind a truck's rear bumper instead of the
// intended 1.9, close enough to read as clipped into the box rather than merely tight. `followGap`
// below is what every non-boost following and landing check now goes through instead.
export const TRUCK_LEN = 5.6;
export const TRUCK_W = 2.0;
// How often a spawned ambient car is a truck instead. Zero by default — see the `truckChance`
// parameter on spawnCars/createTraffic below — so every existing scripted scenario in tools/ stays
// exactly as deterministic as it was. main.js opts the real game in with this value: about one
// truck for every dozen cars, enough to notice, rare enough that it never reads as "the traffic got
// trucks", which is the brief.
export const TRUCK_CHANCE = 1 / 12;
// Noticeably slower than a car's cruise — first cut was 0.85 and still read as too close to car
// speed, so this one is a real gap rather than a nudge. Corners are cut back by the same 0.7 ratio
// CORNER_SPEED already is from SPEED: a heavier vehicle doesn't hurry in a straight line any more
// than round a bend.
const TRUCK_SPEED = SPEED * 0.65;           // ~5.5 u/s
const TRUCK_CORNER_SPEED = TRUCK_SPEED * 0.7;
// Right turns get their own, slower target on top of that. Swinging a long box round a tight
// corner is the one shape that visibly wants a beat longer than a car takes — real trucks take
// them wide and cautious — where a left sweeps the far diagonal and doesn't read as hesitant at
// TRUCK_CORNER_SPEED. Not applied to boost's own right-turn discount (`cruise * 0.75` below):
// nothing here is ever a boosting car, since only the taxi boosts and the taxi's own isTruck is
// always forced false.
const TRUCK_RIGHT_TURN_SPEED = TRUCK_CORNER_SPEED * 0.6;
// The pitch spring below (search "Rocking") drives the nose-dip/lift on every accel and brake
// event. A truck gets half the excursion for the same Δv — the weight is on the box, not the cab,
// so the driver's-eye view pitches less — and damps harder, so what dip there is settles rather
// than keeps bouncing. "Feels heavier" is these two numbers, nothing else.
const TRUCK_PITCH_SCALE = 0.5;
const TRUCK_PITCH_DAMPING_MULT = 1.8;

// Clear road kept between bumpers, independent of either vehicle's length. MIN_GAP is this same
// number with two car half-lengths already folded in, for the plain car-following-car case every
// following/landing check used to assume unconditionally.
const BUMPER_GAP = MIN_GAP - CAR_LEN;
const vehicleHalfLen = (car) => (car?.isTruck ? TRUCK_LEN : CAR_LEN) / 2;
/**
 * Centre-to-centre gap `follower` must keep behind `leader` — the pairwise version of MIN_GAP,
 * correct whichever of the two (or both, or neither) is a truck. `leader` may be undefined (no one
 * ahead), in which case it falls back to a car-sized assumption same as MIN_GAP always did.
 */
const followGap = (follower, leader) => vehicleHalfLen(follower) + vehicleHalfLen(leader) + BUMPER_GAP;

// What a boosting taxi keeps instead. It stays in its lane now, so a leader it doesn't see is a
// leader it rear-ends — but queueing at the ambient distance would read as the maniac politely
// joining the back. 4.5 centre-to-centre puts the near collision circles (offset ±0.95 along the
// body) 2.6 apart against an envelope of 2.31: close enough to look like tailgating, still 0.29
// clear of a crash, and `step` is clamped to `allowed` so it cannot overshoot into that margin.
//
// Not run through followGap: it's tuned against the taxi's own collision envelope in
// collisions.js, which stays CAR_LEN-sized for every target on purpose (see the note above
// TRUCK_LEN) — widening the tailgate for a truck while the hitbox that matters stayed car-sized
// would just be a taxi that hangs back further from a target it can still clip at the old range.
const BOOST_GAP = MIN_GAP * 0.85;
/**
 * How far clear of the car it just passed the taxi must be before it may cut back in.
 *
 * The commitment used to end the moment the taxi's *lane position* went past the leader's, and a
 * lane position is a centre point: level, not clear. So the taxi began its tuck-in a metre and a
 * half ahead of a car it was still bodily alongside, cut across its nose over the next
 * `PASS_FADE` units, and the two came within **2.01** units — inside the 2.31 collision envelope,
 * on every seed, because the geometry that produces it has nothing random in it. It is the "still
 * behind it when tucking in" column of the PASS_TRIGGER table, promoted to the usual outcome by a
 * taxi that now closes properly instead of hanging back.
 *
 * A car length and a half puts the whole body past before the wheel comes back.
 */
const PASS_CLEAR = CAR_LEN * 1.5;
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

/**
 * A car's own cruise ceiling: its class's speed, lifted by the flee, dipped by the panic, and
 * dipped again as it pulls over for a siren — the last two multiplying out to 0.33 of cruise, a
 * 2.8 u/s crawl at the kerb.
 *
 * Shared by the drive branch and the mid-turn one because it was written out longhand in the first
 * and simply omitted from the second, and the omission is visible from across the map: a car
 * fleeing the boosting taxi ran at 2.0× cruise down a lane and dropped to a flat 8.5 the instant it
 * entered a junction, giving it a 17 ↔ 8.5 sawtooth with a period of one block — and every car
 * behind it, the taxi included, braking in time with it. One expression, written once, is what
 * stops the same omission happening to the next factor somebody adds — as it just did to the
 * pull-over, which was added to the drive branch alone.
 */
const cruiseCapFor = (car) => (car.isTruck ? TRUCK_SPEED : SPEED)
  * (1 + (SCATTER_SPEED - 1) * car.scatter)
  * (1 - PANIC_BRAKE * car.panic)
  * (1 - PULLOVER_BRAKE * car.pullover);

// Overdrive — the band above BOOST_SPEED, and the one part of the mode that has to be *driven*
// for rather than pressed for. Holding the button still buys 18.7 u/s in 7.3 units, well under a
// block; that is BOOST_ACCEL doing exactly what the note above says it should. Past that the taxi
// runs out of puff and the last 4.25 u/s arrive at OVERDRIVE_ACCEL instead:
// (22.95² − 18.7²) / (2 · 2.2) = 40 units of unbroken straight road, which is two blocks on the
// nose. So the top end exists only at the far end of a full straightaway with nothing in the way —
// a leader inside LOOKAHEAD, a red the mode isn't holding, or a corner all cost it.
//
// A corner takes it back: the turn branch clamps to BOOST_SPEED and BRAKE is 11, so a left sheds
// the whole band in 0.4s. Going straight on through a junction keeps it, and has to — 40 units of
// run-up crosses one junction and starts on a second, so capping the straight-through at
// BOOST_SPEED would make the band unreachable rather than merely hard to reach.
//
// 2.7 rather than something rounder because sim/police.js chases at 26 and has to stay faster than
// the quarry on its best day; 22.95 leaves the cruiser 3 u/s to close with.
const OVERDRIVE_SPEED = 2.7;  // multiplier on top speed — 22.95 u/s, 67mph
const OVERDRIVE_ACCEL = 2.2;  // units/s^2 through the band — 40 units of straight to use it all

/**
 * The scale every speed readout in the project is quoted in: the shipped overdrive top, 22.95
 * u/s, is 67mph. "18.7 units per second" says nothing about how fast a car looks, and two copies
 * of the conversion is how the lab's readout and the tweak panel's would come to disagree.
 *
 * Anchored to the *shipped* top rather than to `overdriveTop()`, and it has to be: it is a fixed
 * scale between the sim's unit and a real one, so moving the ceiling in the panel must move the
 * mph reading with it. A conversion derived from the live tuning would pin the top at 67mph
 * whatever it was set to, which is the one number the panel exists to change.
 */
export const MPH_PER_UNIT = 67 / (SPEED * OVERDRIVE_SPEED);

/**
 * The Loco Mode ramp, as live tuning rather than six frozen constants — the ⚙️ panel's Loco
 * section drives this, so the shape of the mode can be felt from the driving seat instead of
 * being edited, rebuilt and re-driven. The constants above are still where the numbers *live*;
 * this is the copy of them the panel is allowed to move.
 *
 * Read through `loco.*` at every use site rather than captured into a local at module load: a
 * captured copy is a slider that appears to work and changes nothing until the page is reloaded,
 * which is the one failure mode a tuning panel must not have. That is also why `BOOST_CRUISE` is
 * no longer a const — it is `boostCruise()`, derived on the call.
 *
 * `brake` is here despite belonging to *every* car rather than to the boosting taxi: it owns the
 * coast-down after the button is let go, which is a phase of the ramp, and there is no separate
 * taxi brake to expose. The panel labels it as global. It is also what `LOOKAHEAD` (32) is derived
 * against, so a much softer brake — or a much higher overdrive top — can outrun the horizon the
 * following rule can see. A tuning panel is allowed to drive off the end of a derivation; that is
 * simply where the rear-ends come from when it does.
 */
export const LOCO_DEFAULTS = Object.freeze({
  kick: BOOST_KICK,
  speed: BOOST_SPEED,
  accel: BOOST_ACCEL,
  overdriveSpeed: OVERDRIVE_SPEED,
  overdriveAccel: OVERDRIVE_ACCEL,
  brake: BRAKE,
});
const loco = { ...LOCO_DEFAULTS };

/** The live tuning, copied out — callers get a snapshot, never the object the sim reads. */
export const locoTuning = () => ({ ...loco });

/**
 * Move one or more knobs. Anything non-finite or non-positive is ignored rather than allowed to
 * poison the sim (a `NaN` in `car.v` is unrecoverable and silent), and the one ordering that has
 * to hold is enforced here: an overdrive ceiling *below* the boost cap is not a slower mode, it is
 * a mode with no band at all — `boostAccel` never reaches its taper and the whole ramp runs on
 * `accel` to a ceiling the panel isn't showing. Clamped rather than refused, so dragging either
 * slider past the other still does something legible.
 */
export function setLocoTuning(patch = {}) {
  for (const key of Object.keys(LOCO_DEFAULTS)) {
    const value = Number(patch[key]);
    if (Number.isFinite(value) && value > 0) loco[key] = value;
  }
  loco.overdriveSpeed = Math.max(loco.overdriveSpeed, loco.speed);
  return locoTuning();
}

/** Back to shipped. The panel's Reset, and how a tool undoes a scenario's overrides. */
export const resetLocoTuning = () => setLocoTuning(LOCO_DEFAULTS);

// The speed the camera's follow lead reads as "flat out" — 18.7 u/s. The *boost* ceiling rather
// than the overdrive one on purpose: as the block above says, the band past it takes 40 units of
// unbroken straight to reach, so scaling the framing by the overdrive top would open the frame
// fully only on the rare long run and leave it short through the ordinary boosted corner-to-corner.
export const boostCruise = () => SPEED * loco.speed;

/** The mode's ceiling — what a clear straightaway is worth, and nothing else reaches. */
export const overdriveTop = () => SPEED * loco.overdriveSpeed;

/**
 * What every car actually sheds speed at. `BRAKE` above stays the shipped number the comments
 * throughout this file quote; this is the one the physics reads, so the panel can move it.
 */
const brake = () => loco.brake;

/**
 * The top of the scatter lerp: a car fleeing the boosting taxi is pushed toward the taxi's own
 * punch, because a ceiling a car cannot climb to is not a ceiling (see the two `accel` sites).
 * Deliberately the same number as the boost punch rather than a copy of it — the flee is sized
 * against what it is fleeing, so raising the punch in the panel raises the scatter with it.
 */
const scatterAccel = () => loco.accel;

/**
 * Acceleration available to a car at full boost, which is not one number: full punch up to the
 * boost ceiling, then the overdrive taper. See the tuning block above for where 2.2 and the
 * 40 units of run-up it implies come from.
 */
const boostAccel = (v) => (v < boostCruise() ? loco.accel : loco.overdriveAccel);

/**
 * The ramp on a clear straight road, sampled — the ideal curve, which is exactly what the ⚙️
 * panel's preview draws and what docs/traffic.md's numbers describe. Nothing in the sim calls it:
 * it lives here so that the curve on screen and the physics the sim will actually run come from
 * one set of numbers, instead of a chart drifting away from the thing it claims to be a chart of.
 *
 * The press is at distance 0 from cruise, the release at `holdFor` units. Everything the city does
 * to the ramp — a leader inside LOOKAHEAD, a red the mode isn't holding, a corner — is absent by
 * construction; this is the ceiling those things spend, not a prediction of any real run.
 */
export function locoRamp({ holdFor = null, dt = 0.002 } = {}) {
  const top = overdriveTop();
  const kicked = Math.max(SPEED, SPEED * loco.kick);
  // Bail-outs, not tuning. A band acceleration near zero never reaches the top and a brake near
  // zero never comes back down from it, and the panel has to draw *something* rather than hang
  // inside a slider's own input event. MAX_S/MAX_T give up on the climb and coast home, which
  // still draws the honest curve; MAX_STEPS is the backstop under both.
  const MAX_S = 900, MAX_T = 60, MAX_STEPS = 60000;

  /**
   * One pass. `stride` null means "measure only" — the first pass finds how far the whole
   * manoeuvre runs so the second can sample it at a constant fraction of its own length, which
   * is what keeps the punch's shape at any acceleration without returning ten thousand points
   * for a slow one.
   */
  const run = (stride, hold) => {
    const out = stride ? [{ s: 0, t: 0, v: SPEED }, { s: 0, t: 0, v: kicked }] : null;
    let v = kicked, s = 0, t = 0, released = false, next = stride;
    let climbed = null;                       // distance at which the top was first reached
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (climbed === null && v >= top - 1e-4) climbed = s;
      const holdTo = hold ?? (climbed === null ? Infinity : climbed + Math.max(6, climbed * 0.12));
      if (!released && (s >= holdTo || s > MAX_S || t > MAX_T)) {
        released = true;
        if (out) out.push({ s, t, v, release: true });
      }
      if (released && v <= SPEED + 1e-6) break;
      v = released
        ? Math.max(SPEED, v - loco.brake * dt)
        : Math.min(top, v + boostAccel(v) * dt);
      s += v * dt;
      t += dt;
      if (out && s >= next) { out.push({ s, t, v }); next += stride; }
    }
    // A tail of cruise, so the curve visibly lands rather than stopping at the moment it arrives.
    const tail = Math.max(4, s * 0.06);
    if (out) {
      out.push({ s, t, v, settled: true });
      out.push({ s: s + tail, t: t + tail / SPEED, v: SPEED });
      return out;
    }
    return s + tail;
  };

  return run((holdFor === null ? run(null, null) : run(null, holdFor)) / 400, holdFor);
}

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

// Shared by truckCabGeometry() and truckBoxGeometry() so the two pieces — drawn from separate
// InstancedMeshes, see the note by TRUCK_LEN/TRUCK_W and createTraffic below — line up on one
// chassis line without either function guessing the other's numbers.
const TRUCK_BASE_Y = 0.78 + CHASSIS_LIFT;     // top of the chassis a car's body would ride at
const TRUCK_CAB_LEN = TRUCK_LEN * 0.3;
const TRUCK_CAB_X = TRUCK_LEN / 2 - TRUCK_CAB_LEN / 2 - 0.1; // 0.1 nose gap
const TRUCK_CAB_Y = TRUCK_BASE_Y + 0.4 + 0.55;
const TRUCK_BOX_LEN = TRUCK_LEN * 0.58;
const TRUCK_BOX_X = -(TRUCK_LEN / 2) + TRUCK_BOX_LEN / 2 + 0.15; // 0.15 tail gap

/**
 * A box truck's chassis and cab. Built at TRUCK_LEN/TRUCK_W rather than CAR_LEN/CAR_W — see the
 * note by those constants for why that is allowed to be a different number from every vehicle's
 * shared physics footprint.
 *
 * Only the chassis is left white for the instance tint, painted from PALETTE.carBody exactly like
 * an ordinary car's body — one fleet livery per vehicle. The cab sits on top of it baked dark,
 * same colour as the windshield glass, which is the other half of "looks like the cars in that
 * sense": a car's greenhouse is always dark regardless of its body colour, and a truck's cab reads
 * as the same kind of part rather than as more of the chassis livery. The cargo box is a further,
 * separate mesh: see truckBoxGeometry().
 */
function truckCabGeometry() {
  const parts = [];
  const white = new THREE.Color(1, 1, 1);
  const cabDark = color('carGlass');

  const chassis = new THREE.BoxGeometry(TRUCK_LEN, 0.8, TRUCK_W);
  chassis.translate(0, TRUCK_BASE_Y, 0);
  parts.push(bakeColor(chassis, white));

  const cab = new THREE.BoxGeometry(TRUCK_CAB_LEN, 1.1, TRUCK_W * 0.84);
  cab.translate(TRUCK_CAB_X, TRUCK_CAB_Y, 0);
  parts.push(bakeColor(cab, cabDark));

  const windshield = new THREE.BoxGeometry(0.12, 0.7, TRUCK_W * 0.7);
  windshield.translate(TRUCK_CAB_X + TRUCK_CAB_LEN / 2 - 0.05, TRUCK_CAB_Y, 0);
  parts.push(bakeColor(windshield, cabDark));

  parts.push(...wheelGeometries(TRUCK_LEN, TRUCK_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * A box truck's cargo box — set back from the cab and taller than it, a real box truck's roofline
 * sitting above the cab's for exactly this reason.
 *
 * Its own InstancedMesh rather than a part of truckCabGeometry(), and the only vehicle part in the
 * game baked at an absolute colour instead of white: PALETTE.truckBox goes straight onto the mesh
 * and nothing ever calls setColorAt on it, so there is no instance colour to multiply it against.
 * One InstancedMesh only ever draws one tint per instance, so a cab that varies with PALETTE.carBody
 * and a box that never does are two meshes by construction, not by choice.
 */
function truckBoxGeometry() {
  const box = new THREE.BoxGeometry(TRUCK_BOX_LEN, 2.0, TRUCK_W);
  box.translate(TRUCK_BOX_X, TRUCK_BASE_Y + 0.4 + 1.0, 0);
  return bakeColor(box, color('truckBox'));
}

// --- Brake lights and turn signals -----------------------------------------------------------
//
// The geometry and materials (LIGHT_D/H/W, brakeLightGeometry(), brakeLightMaterial() and their
// turn-signal counterparts) live in geometry/lights.js, shared with the taxi's own lights
// (geometry/taxi.js) — see the note there for why a car's paint tint can't just be repurposed for
// this. What is here is the *state*: reading a car's braking and signalling levels off its physics
// each frame, and the InstancedMesh machinery that fleet of ambient vehicles needs and the taxi
// (an ordinary Group with ordinary Meshes) does not.
//
// A car's own pod is scaled by an eased 0..1 *level* rather than snapped between "there" and
// `ZERO_MATRIX` — the same collapse-to-nothing trick `wreckShell()` uses to retire an instance, just
// with the scale itself eased instead of stepped. There is no per-instance opacity to animate
// (`instanceColor` is RGB paint, full stop, and a real fade would need a custom per-instance
// attribute plus an `onBeforeCompile` patch), so scale is the one lever available — but at this
// camera's play zoom (1 unit ≈ 7.7px) a pod is only a handful of pixels across, where a shrinking
// box and a dimming light are close to indistinguishable. Easing the level rather than the boolean
// that drives it is also what kills flicker: a one-frame blip in the underlying signal (braking is
// read off noisy per-frame accel) no longer has time to visibly register before the target flips
// back.

// "Braking" is read off the same longitudinal accel the pitch spring already computes (search
// "Rocking" below) — losing speed for any real reason (a red, a leader, a corner) dips the nose
// and lights the lamp together, for free. BRAKE_ACCEL is well under BRAKE (11 u/s^2) so the light
// comes on with the first press rather than only under full deceleration; BRAKE_STOP_V keeps it lit
// on a car held dead still — queued at a line, accel reads a clean zero there — rather than letting
// it wink out the instant the car actually stops.
const BRAKE_ACCEL = 1.5;
const BRAKE_STOP_V = 0.2;

// The brake level's ease rates, in 1/s — an exponential approach, so "time to reach it" is the
// usual 3/rate for ~95%. Rise is quick, close to a real lamp's own on-switch; fall is deliberately
// much slower, both to read as a dramatic lingering glow rather than a lamp and to absorb a
// one-frame gap in the underlying accel signal, which is exactly what was flickering before.
const BRAKE_LIGHT_RISE = 20;    // ~0.15s to full
const BRAKE_LIGHT_FALL = 4;     // ~0.75s to dark

// Real turn signals flash at roughly 60-120 times a minute (1-2 Hz); 1.1 sits toward the slow end
// of that band on purpose — fast enough to read as blinking, slow enough that each phase holds long
// enough to actually register. TURN_SIGNAL_DUTY skews the cycle toward "on": a plain 50/50 square
// wave spends as long dark as lit, and at this size the dark half was reading as the light being
// broken rather than blinking. Unlike the brake level below, a signal's on/off is not eased — it is
// meant to read as a single blinker flashing, not a fade, so the level jumps straight to its target.
const TURN_SIGNAL_HZ = 1.1;
const TURN_SIGNAL_DUTY = 0.6;

/** Coordinate along the travel axis for a point. */
const along = (d, p) => (isXAxis(d) ? p.x : p.z);

/**
 * Yaw that points a +X-facing model along a heading, the tangent form of `dirYaw`.
 *
 * A lane hands back a tangent rather than one of four directions, which is the whole point — a
 * diagonal or a curve has a heading and no `d`. On the grid the two agree exactly: heading +Z is
 * tangent (0, 1), and atan2(-1, 0) is the -PI/2 `dirYaw` hard-codes.
 */
const yawOf = (t) => Math.atan2(-t.z, t.x);

/**
 * The turn out of `lane` that leaves in grid direction `d`, or null if there isn't one.
 *
 * The bridge between a route — still a list of grid directions — and the network's turns. It goes
 * when routes are lists of lanes.
 */
function exitToward(net, lane, d) {
  for (const id of lane.exits) {
    const turn = net.turnById.get(id);
    if (net.dirOfLane(net.laneById.get(turn.outLane)) === d) return turn;
  }
  return null;
}

/**
 * Refresh the grid-shaped fields other modules still read off a car.
 *
 * `car.lane` and `car.s` are the truth; `car.i`, `car.j` and `car.d` are a view of it, kept so
 * `game/routeline.js`, `game/fares.js`, `sim/police.js` and the probe keep working while the
 * network port moves through the codebase one file at a time. They go when nothing reads them.
 */
function syncGrid(car) {
  const net = cityNetwork();
  const to = net.nodeById.get(car.lane.to);
  car.i = to.gi;
  car.j = to.gj;
  car.d = net.dirOfLane(car.lane);
}

/**
 * How far ahead a car can be constrained by a leader, in world units.
 *
 * Not a tuning knob — it is derived. A car brakes toward `sqrt(2 * BRAKE * allowed)`, so a leader
 * stops mattering once that exceeds the car's top speed: at the overdrive top (22.95 u/s) that is
 * 23.9 units of clear road, plus BOOST_GAP, so 28.4. Beyond it the leader is invisible to the
 * physics whether or not it is visible to the bookkeeping. It was 26, derived the same way against
 * the 18.7 ceiling that used to be the top — that horizon is 2.4 units short of what a taxi in
 * overdrive needs, and a leader appearing inside its own stopping distance is a rear-end rather
 * than a lift. 32 leaves margin and is exactly two lanes plus the junction between them
 * (12 + 8 + 12). Ambient traffic is unaffected: at cruise a leader stops constraining beyond 3.3
 * units of clear road, so the extra reach only ever finds cars that were already invisible to it.
 *
 * The old model never needed this: `laneKey` was one *infinite* lane spanning the city, so a car
 * saw every leader in its row for free — including, as it happens, cars three blocks away it was
 * about to turn away from. Per-edge lanes end that, so the distance has to be walked.
 */
const LOOKAHEAD = 32;

/**
 * Draw `count` more cars onto the network, appending to `into`.
 *
 * `into` and `accept` exist so the same draw can mint a car mid-run as well as fill an empty city
 * at startup: the clash check already tests against whatever is in the array, so passing the live
 * one is all "don't spawn on top of existing traffic" needs. With the defaults the loop is
 * bit-for-bit the original, which is what keeps every seeded measurement in the suite comparable.
 *
 * @param accept optional (spot) -> boolean, a further filter on where a car may appear.
 * @param truckChance probability a spawned car is a box truck rather than an ordinary car.
 *                     Defaults to 0 — every scripted scenario in tools/ calls this (via
 *                     createTraffic) without passing it, and that has to keep drawing exactly the
 *                     stream it always has. main.js is the one caller that opts in, with
 *                     TRUCK_CHANCE.
 */
function spawnCars(rng, count, into = [], accept = null, truckChance = 0) {
  const net = cityNetwork();
  const cars = into;
  const want = cars.length + count;
  const attempts = count * 12;

  for (let n = 0; n < attempts && cars.length < want; n++) {
    const d = rng.int(0, 3);
    const line = rng.int(0, GRID);   // the road the car drives along
    const seg = rng.int(0, GRID - 1); // which gap between intersections

    // Target intersection is whichever end of the segment the car is heading for.
    const targetIndex = dirSign(d) > 0 ? seg + 1 : seg;
    const i = isXAxis(d) ? targetIndex : line;
    const j = isXAxis(d) ? line : targetIndex;

    // No lane means no road: that stretch was built over by a park district. Checked before any
    // further draw, exactly where the old `isSegmentClosed` guard sat, so a seed still produces
    // the same traffic.
    const lane = net.laneByGrid(d, i, j);
    if (!lane || lane.degenerate) continue;

    // `s` is now arc length along the lane rather than a world coordinate on an axis. The draw is
    // kept identical — one `rng.range` over the same span — and mirrored for the two negative
    // directions, where the old world coordinate ran backwards along the lane. Spawn positions
    // therefore land exactly where they used to, which is what keeps every seeded measurement in
    // the suite comparable across this change.
    const t = rng.range(0.5, lane.length - 0.5);
    const s = dirSign(d) > 0 ? t : lane.length - t;

    // This car's own isTruck isn't rolled until after the clash/accept checks below, so a possible
    // truck is assumed on this side of the pairing — conservative, but only when truckChance > 0:
    // at 0 (every scripted scenario in tools/) `followGap({isTruck: false}, c)` collapses back to
    // exactly MIN_GAP, so nothing there draws a different spawn position than it always has.
    const clash = cars.some((c) => c.lane === lane
      && Math.abs(c.s - s) < followGap({ isTruck: truckChance > 0 }, c) + 1);
    if (clash) continue;
    if (accept && !accept({ d, i, j, s, lane })) continue;

    // Rolled once per car, after everything that decides *whether* it spawns here — so a car that
    // fails the clash or accept check and retries elsewhere doesn't burn a truck roll on a spot it
    // never actually took.
    const isTruck = rng.range(0, 1) < truckChance;

    cars.push({
      d, i, j, s, lane,
      // The turn being executed while `state === 'turn'`, straight off the network. Replaces the
      // `dIn -> dOut` pair the arc used to be rebuilt from every time.
      turn: null,
      state: 'drive',
      turnT: 0,
      turnLen: 1,
      entry: null, control: null, exit: null, hold: null, leadIn: 0, dOut: d,
      isTruck,
      // Same index, same array, whether this is a car or a truck's cab — see PALETTE.truckBox for
      // the one part of a truck that doesn't read this.
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
      // 0..1 brightness for the brake and turn-signal light pods. brakeLevel is eased (see
      // BRAKE_LIGHT_RISE/FALL) — off frame one along with prevV/v agreeing there is no accel yet.
      // The turn-signal levels are not eased; they jump straight to their blink target.
      brakeLevel: 0,
      turnLeftLevel: 0,
      turnRightLevel: 0,
      boost: false,
      // True only during the taxi's post-release cooldown tail (see BOOST_COOLDOWN in
      // game/boost.js) — `boost` stays true through it so collision/police/red-light rules keep
      // applying, this is what tells the speed math the hold itself has already ended.
      boostEasing: false,
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
      // Overtaking. `pass` is 0 in lane and 1 out in the oncoming lane, paced by distance like
      // the weave; `passing` is whether the taxi is currently committed, which is what suppresses
      // the leader brake and the scatter that would otherwise outrun it. Ambient cars never pass.
      pass: 0,
      passing: false,
      passTarget: null,   // the car currently being overtaken, latched for the whole manoeuvre
      // What `pass` is turned into: the smoothstepped offset the body is drawn at, the slope of
      // that offset (which *is* the tangent of the steering angle, since it is per unit of road),
      // and the roll that comes off its curvature. Derived every frame from `pass`; kept on the car
      // because the render pass, the rubber and the lab's readout all read them.
      passOffset: 0,
      passSlope: 0,
      passBank: 0,
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
      // Impact state, set by src/sim/collisions.js on both cars in a crash and never cleared —
      // every loop below skips a crashed car, so it leaves the lane grid for good and its shell
      // is handed to the wreck effects while the run-end banner comes up.
      crashed: false,
      // Frantic reaction to a nearby police siren. Eased toward panicTargetFor() each frame and
      // applied at render as an outward shove, a yaw wobble, and a mild speed dip.
      panic: 0,
      // Getting out of the siren's way, for the cars actually in its lane — see PULLOVER_* above.
      // Drives the pull-over, the kerb mount and a harder brake than panic asks for.
      pullover: 0,
      pulloverSlope: 0,   // d(offset)/d(road) while pulling over, the tangent of the steering angle
      // Getting out of the boosting taxi's way. Eased toward 1 while the taxi is behind this car
      // in its own lane; drives a higher speed cap and a turn-off-at-the-next-junction bias.
      scatter: 0,
    });
  }

  return cars;
}

/**
 * Put a car on the lane approaching (i, j) travelling `d`, `back` units short of the junction.
 *
 * Exported for the probe, which stages contrived situations — a leader eighteen units ahead of a
 * boosting taxi, a car mid-approach to a specific junction. `back` may exceed one lane, in which
 * case it walks backwards along the straight-through chain; the old `laneKey` allowed that for
 * free by being one infinite lane per row, and the tests were written against it.
 */
export function placeCar(car, d, i, j, back) {
  const net = cityNetwork();
  let lane = net.laneByGrid(d, i, j);
  let remaining = back;
  while (lane && remaining > lane.length) {
    const prev = net.laneByGrid(d, ...gridOf(net, lane.from));
    const turn = prev && net.turnById.get(prev.exits[0]);
    if (!prev || !turn || turn.hand !== 'straight') break;
    // One lane back along the chain, plus the junction between the two.
    const across = lane.length + turn.length;
    // Between the two is *inside* a junction box, which no lane position can express — the old
    // infinite row could. Stop at the near end of this lane rather than overshoot.
    if (remaining < across) break;
    remaining -= across;
    lane = prev;
  }
  if (!lane) return false;
  car.lane = lane;
  car.s = Math.max(0, lane.length - Math.min(remaining, lane.length));
  car.turn = null;
  car.state = 'drive';
  car.turnT = 0;
  syncGrid(car);
  car.dOut = car.d;
  return true;
}

const gridOf = (net, nodeId) => {
  const node = net.nodeById.get(nodeId);
  return [node.gi, node.gj];
};

/**
 * How much straight road runs back from junction (i, j) along approach `d`, junctions included.
 *
 * The probe stages cars a fixed distance short of a junction, and a junction one block from the
 * map edge simply does not have thirty units behind it. Under the old infinite `laneKey` row that
 * went unnoticed — the car was placed off the map and drove in. A lane cannot express that, which
 * is the model being right, so the room has to be asked for rather than assumed.
 */
export function approachRoom(d, i, j) {
  const net = cityNetwork();
  let lane = net.laneByGrid(d, i, j);
  let room = 0;
  while (lane) {
    room += lane.length;
    const prev = net.laneByGrid(d, ...gridOf(net, lane.from));
    const turn = prev && net.turnById.get(prev.exits[0]);
    if (!prev || !turn || turn.hand !== 'straight') break;
    room += turn.length;
    lane = prev;
  }
  return room;
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

/**
 * @param count     vehicles to open with, taxi included
 * @param maxCars   vehicles the instanced meshes are sized for, taxi included. Density ramps over
 *                  a run (`difficulty.carCount`), and an InstancedMesh cannot be resized after
 *                  construction — so the pool is allocated for the ceiling up front and `count`
 *                  only decides how much of it is drawn. Costs one matrix and one colour per
 *                  unused slot, which is nothing next to rebuilding the mesh mid-run.
 * @param truckChance  see spawnCars — defaults to 0 so every existing caller is unaffected; main.js
 *                     passes TRUCK_CHANCE for the real game.
 */
export function createTraffic(rng, scene, count = 24, maxCars = count, truckChance = 0) {
  const net = cityNetwork();
  const cars = spawnCars(rng, count, [], null, truckChance);
  const MAX_CARS = Math.max(count, maxCars);

  // The player's taxi is an ordinary car in this same array — that is what subjects it to
  // following distance, signals and intersection reservations exactly like everyone else. It is
  // simply drawn as its own mesh instead of an instance, so it can be raycast and highlighted.
  //
  // Which one is the taxi is now a pick, not always index 0: whichever of this draw's cars is
  // heading for an intersection closest to the middle of the grid (GRID=5 has no single centre, so
  // "closest" naturally lands in the 2×2 block at (2,2)-(3,3) — downtown, per layout.js's own
  // density falloff). A run used to open with the taxi anywhere on the map, including a corner,
  // which put the tutorial's first fare (biased to spawn near the taxi — see fares.js
  // `spawnBias`) anywhere too.
  //
  // Picked from the cars this draw already produced rather than drawn fresh with a centring
  // filter, so this closure's `rng` stays byte-for-byte what it was: nothing that reads from it
  // afterwards — the mid-run growth in `setCarCount`, any car's own turn choices during `update` —
  // consumes a different number of random values than it used to. `tools/probe.mjs`'s staged
  // two-car boost scenarios lean on that: they destructure `[taxi, other] = traffic.cars` and
  // reposition both by hand, so a shifted stream changed which random draw the *other* car got —
  // and with it, the scripted scenario's outcome — even though neither car's final position came
  // from the draw at all.
  let taxiIndex = 0;
  let centreDist = Infinity;
  for (let k = 0; k < cars.length; k++) {
    const dist = Math.abs(cars[k].i - GRID / 2) + Math.abs(cars[k].j - GRID / 2);
    if (dist < centreDist) { centreDist = dist; taxiIndex = k; }
  }
  if (taxiIndex !== 0) [cars[0], cars[taxiIndex]] = [cars[taxiIndex], cars[0]];
  const taxi = cars[0];
  taxi.isTaxi = true;
  // Whichever car this draw happened to be, it is never a truck once it's the taxi — the taxi
  // always renders through createTaxiMesh() regardless, but isTruck now also steers cruise speed
  // and pitch damping below, and the player's own car has to run at car physics whatever colour
  // its unused truck roll came up.
  taxi.isTruck = false;

  const {
    group: taxiGroup, setOccupied: setTaxiOccupied,
    setHighlight: setTaxiHighlight, setSteer: setTaxiSteer, setLights: setTaxiLights,
  } = createTaxiMesh();
  scene.add(taxiGroup);

  // Trucks get their own index space, into their own pair of instanced meshes below — an
  // InstancedMesh draws one geometry for every instance, so a visibly bigger vehicle can't share
  // the car body's buffer no matter how rare it is. `ambient` therefore stays car-only, and an
  // `instanceIndex` only means anything alongside the array it was handed out from: the same index
  // addresses a car in `mesh` and a truck in `truckMesh`. game/carghosts.js reads both arrays for
  // its boost-mode outlines and keeps a pool per class for exactly that reason — it used to read
  // `instanceIndex` straight into the car meshes with no type check, which is why trucks went
  // without an outline at all until it grew one.
  const ambient = cars.filter((c) => !c.isTaxi && !c.isTruck);
  const trucks = cars.filter((c) => !c.isTaxi && c.isTruck);
  ambient.forEach((car, index) => { car.instanceIndex = index; });
  trucks.forEach((car, index) => { car.instanceIndex = index; });

  // Sized for the ceiling, drawn to the current count. `mesh.count` is what three renders, so an
  // unfilled slot costs a matrix in the buffer and nothing on screen. Both the car and the truck
  // meshes are sized for every ambient slot even though only a fraction of them will ever be
  // trucks — cheap insurance against the buffer running out mid-run, for the same "nothing next to
  // rebuilding the mesh" reason MAX_CARS itself is sized for the ceiling rather than the opener.
  const MAX_AMBIENT = Math.max(0, MAX_CARS - 1);

  /**
   * Take a vehicle mesh out of frustum culling, and say why.
   *
   * Three computes an InstancedMesh's bounding sphere **once**, lazily, on the first frame the
   * renderer culls it, from whatever the instance matrices held at that moment — and never again.
   * These meshes then drive off across the city under it. `game/carghosts.js` already turns culling
   * off for exactly this reason; the traffic meshes never did, and the trucks are where it showed:
   *
   *   - A run that opens with no trucks (27% of them: 11 ambient vehicles at TRUCK_CHANCE) latches
   *     an *empty* sphere off `count = 0`, radius −1, pinned to the world origin. Every truck for
   *     the rest of that run is drawn only while the middle of the map is in shot.
   *   - A run that opens with one truck latches a 3.1-unit bubble around wherever that truck stood
   *     at warmup, and loses it as soon as it drives out of it. Measured on a phone-shaped
   *     viewport: a truck visibly on screen was culled away in 27% of sampled frames.
   *   - The cab and the box are separate meshes with separate spheres — the box's is smaller and
   *     set back — so the box can fail the test on a frame the cab passes. That is the reported
   *     bug: a cab and two wheels driving down the street with no cargo box on the back.
   *
   * The shadow pass culls against the *sun's* frustum, which covers the whole city (game/scene.js),
   * so a stale sphere still inside the city keeps the shadow drawing at the instances' real
   * positions — an invisible truck towing a truck-shaped shadow.
   *
   * Culling these off is free: the scene is about ten draw calls, and every one of these meshes
   * spans the whole city once its instances spread out, so the test it skips is one it would pass.
   */
  const neverCull = (instanced) => {
    instanced.frustumCulled = false;
    return instanced;
  };

  const mesh = neverCull(new THREE.InstancedMesh(carGeometry(), propMaterial(), MAX_AMBIENT));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.name = 'cars';
  mesh.count = ambient.length;

  // The steered front wheels, as their own instanced mesh: two per ambient car, each carrying the
  // car's transform with a yaw of its own applied on top. They can't ride in the body geometry
  // because every instance of that shares one matrix, and these two have to turn independently
  // of it.
  const FRONT = wheelAnchors(CAR_LEN, CAR_W).filter((a) => a.front);
  const wheelMesh = neverCull(new THREE.InstancedMesh(
    wheelGeometry(), propMaterial(), MAX_AMBIENT * FRONT.length,
  ));
  wheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wheelMesh.castShadow = true;
  wheelMesh.name = 'carWheels';
  wheelMesh.count = ambient.length * FRONT.length;

  // The truck cab and its front wheels, as their own pair of instanced meshes — same shape as the
  // car pair above, just built from truckCabGeometry() at TRUCK_LEN/TRUCK_W and painted from the
  // same PALETTE.carBody a car is (see paintTruck below).
  const truckMesh = neverCull(
    new THREE.InstancedMesh(truckCabGeometry(), propMaterial(), MAX_AMBIENT),
  );
  truckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckMesh.castShadow = true;
  truckMesh.name = 'trucks';
  truckMesh.count = trucks.length;

  const TRUCK_FRONT = wheelAnchors(TRUCK_LEN, TRUCK_W).filter((a) => a.front);
  const truckWheelMesh = neverCull(new THREE.InstancedMesh(
    wheelGeometry(), propMaterial(), MAX_AMBIENT * TRUCK_FRONT.length,
  ));
  truckWheelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckWheelMesh.castShadow = true;
  truckWheelMesh.name = 'truckWheels';
  truckWheelMesh.count = trucks.length * TRUCK_FRONT.length;

  // The cargo box, a third instanced mesh sharing every truck's index space and transform but
  // never painted — see truckBoxGeometry() for why one InstancedMesh cannot hold both a tinted
  // cab and a fixed-colour box. `setColorAt` is never called on it, so `instanceColor` stays null
  // and the material draws the geometry's own baked PALETTE.truckBox untouched.
  const truckBoxMesh = neverCull(
    new THREE.InstancedMesh(truckBoxGeometry(), propMaterial(), MAX_AMBIENT),
  );
  truckBoxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckBoxMesh.castShadow = true;
  truckBoxMesh.name = 'truckBoxes';
  truckBoxMesh.count = trucks.length;

  // Brake lights and turn signals: three more instanced meshes per vehicle class, none of them
  // painted — see the note by lightPod() above for why on/off is a matrix write (present or
  // ZERO_MATRIX) rather than a colour change. No shadow: a couple of pixels of lamp casts nothing
  // worth the pass.
  const brakeMesh = neverCull(
    new THREE.InstancedMesh(brakeLightGeometry(CAR_LEN, CAR_W), brakeLightMaterial(), MAX_AMBIENT),
  );
  brakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  brakeMesh.name = 'carBrakeLights';
  brakeMesh.count = ambient.length;

  const turnLeftMesh = neverCull(new THREE.InstancedMesh(
    turnSignalGeometry(CAR_LEN, CAR_W, -1), turnSignalMaterial(), MAX_AMBIENT,
  ));
  turnLeftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  turnLeftMesh.name = 'carTurnSignalsLeft';
  turnLeftMesh.count = ambient.length;

  const turnRightMesh = neverCull(new THREE.InstancedMesh(
    turnSignalGeometry(CAR_LEN, CAR_W, 1), turnSignalMaterial(), MAX_AMBIENT,
  ));
  turnRightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  turnRightMesh.name = 'carTurnSignalsRight';
  turnRightMesh.count = ambient.length;

  const truckBrakeMesh = neverCull(new THREE.InstancedMesh(
    brakeLightGeometry(TRUCK_LEN, TRUCK_W), brakeLightMaterial(), MAX_AMBIENT,
  ));
  truckBrakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckBrakeMesh.name = 'truckBrakeLights';
  truckBrakeMesh.count = trucks.length;

  const truckTurnLeftMesh = neverCull(new THREE.InstancedMesh(
    turnSignalGeometry(TRUCK_LEN, TRUCK_W, -1), turnSignalMaterial(), MAX_AMBIENT,
  ));
  truckTurnLeftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckTurnLeftMesh.name = 'truckTurnSignalsLeft';
  truckTurnLeftMesh.count = trucks.length;

  const truckTurnRightMesh = neverCull(new THREE.InstancedMesh(
    turnSignalGeometry(TRUCK_LEN, TRUCK_W, 1), turnSignalMaterial(), MAX_AMBIENT,
  ));
  truckTurnRightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  truckTurnRightMesh.name = 'truckTurnSignalsRight';
  truckTurnRightMesh.count = trucks.length;

  const tint = new THREE.Color();
  const paint = (car, index) => {
    tint.set(PALETTE.carBody[car.colorIndex]);
    mesh.setColorAt(index, tint);
    // Tinted with the body it belongs to, not left neutral. The tyre is baked dark and the
    // instance colour multiplies on top, so a front wheel that skipped this would sit a shade
    // off its own rear wheel on every car in the city.
    for (let w = 0; w < FRONT.length; w++) wheelMesh.setColorAt(index * FRONT.length + w, tint);
  };
  // Same PALETTE.carBody as an ordinary car, and the same index — a truck's cab wears whatever
  // livery its colorIndex would have painted a car in. Only the cab and its wheels: the cargo box
  // (truckBoxMesh) is never touched here, see the note where that mesh is constructed above.
  const paintTruck = (car, index) => {
    tint.set(PALETTE.carBody[car.colorIndex]);
    truckMesh.setColorAt(index, tint);
    for (let w = 0; w < TRUCK_FRONT.length; w++) {
      truckWheelMesh.setColorAt(index * TRUCK_FRONT.length + w, tint);
    }
  };
  ambient.forEach(paint);
  trucks.forEach(paintTruck);

  // How far from the taxi a mid-run arrival has to appear.
  //
  // Half the map's 100-unit span. The honest position: on a desktop the whole city is in frame at
  // once, so there is no such thing as spawning off-camera and this cannot pretend otherwise —
  // what it can do is put the new car where the player is not looking, which is anywhere but the
  // junction they are driving through. On a narrow viewport, where the camera actually follows the
  // taxi, the same distance does keep it out of shot.
  const SPAWN_CLEARANCE = 50;

  /**
   * Grow the ambient traffic toward `n` total vehicles, taxi included.
   *
   * **It only ever grows.** Difficulty ramps one way, and removing a car would mean deleting one
   * out of the middle of the instance buffer while the player watches — every index after it
   * shifts, and the car itself vanishes from a road it was visibly driving down.
   *
   * Adds at most one car per call and gives up quietly when the draw can't find a legal spot, so
   * a saturated network just tries again on the next frame rather than looping.
   */
  function setCarCount(n) {
    const want = Math.max(cars.length, Math.min(MAX_CARS, Math.round(n)));
    if (cars.length >= want) return;

    const before = cars.length;
    spawnCars(rng, 1, cars, ({ lane, s }) => {
      // A closed lane has no traffic *because* nothing turns into it, and a car materialising
      // inside one would be the one vehicle in the city that had to drive out through a barricade.
      if (closedLanes.has(lane.id)) return false;
      const at = lane.path.at(s);
      return Math.hypot(at.x - taxi.x, at.z - taxi.z) >= SPAWN_CLEARANCE;
    });
    if (cars.length === before) return;

    const car = cars[cars.length - 1];
    if (car.isTruck) {
      car.instanceIndex = trucks.length;
      trucks.push(car);
      paintTruck(car, car.instanceIndex);
      if (truckMesh.instanceColor) truckMesh.instanceColor.needsUpdate = true;
      if (truckWheelMesh.instanceColor) truckWheelMesh.instanceColor.needsUpdate = true;
      truckMesh.count = trucks.length;
      truckWheelMesh.count = trucks.length * TRUCK_FRONT.length;
      truckBoxMesh.count = trucks.length;
      truckBrakeMesh.count = trucks.length;
      truckTurnLeftMesh.count = trucks.length;
      truckTurnRightMesh.count = trucks.length;
    } else {
      car.instanceIndex = ambient.length;
      ambient.push(car);
      paint(car, car.instanceIndex);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (wheelMesh.instanceColor) wheelMesh.instanceColor.needsUpdate = true;
      mesh.count = ambient.length;
      wheelMesh.count = ambient.length * FRONT.length;
      brakeMesh.count = ambient.length;
      turnLeftMesh.count = ambient.length;
      turnRightMesh.count = ambient.length;
    }
  }
  // With ?cars=1 there are no ambient vehicles at all, so setColorAt is never called and
  // instanceColor is still null.
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  if (wheelMesh.instanceColor) wheelMesh.instanceColor.needsUpdate = true;
  if (truckMesh.instanceColor) truckMesh.instanceColor.needsUpdate = true;
  if (truckWheelMesh.instanceColor) truckWheelMesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  scene.add(wheelMesh);
  scene.add(truckMesh);
  scene.add(truckWheelMesh);
  scene.add(truckBoxMesh);
  scene.add(brakeMesh);
  scene.add(turnLeftMesh);
  scene.add(turnRightMesh);
  scene.add(truckBrakeMesh);
  scene.add(truckTurnLeftMesh);
  scene.add(truckTurnRightMesh);

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
  // Measured back from where the lane ends, which is the junction boundary. The old form measured
  // from the junction *centre* and subtracted HALF_ROAD to get here.
  const BAR_SETBACK = 2.05;

  const barGeo = bakeColor(new THREE.PlaneGeometry(0.7, 3.6), new THREE.Color(1, 1, 1));
  barGeo.rotateX(-Math.PI / 2);

  // One bar per signalised approach. `node.inbound` *is* "traffic can arrive this way" — a lane
  // exists only where a road does — so the map-edge and closed-segment guards the grid loop needed
  // are not ported, they are simply gone. A junction the network left unsignalised has no bars,
  // which is the visible half of that difference.
  const bars = [];
  for (const node of net.nodes) {
    if (!node.signal) continue;
    for (const lane of node.inbound) {
      if (lane.degenerate) continue;
      const at = Math.max(0, lane.length - BAR_SETBACK);
      const point = lane.path.at(at);
      bars.push({ lane, x: point.x, z: point.z, yaw: yawOf(lane.path.tangentAt(at)) });
    }
  }

  const barMesh = new THREE.InstancedMesh(barGeo, propMaterial(), bars.length);
  barMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  barMesh.name = 'stopBars';
  const barDummy = new THREE.Object3D();
  bars.forEach((bar, index) => {
    barDummy.position.set(bar.x, 0.05, bar.z);
    barDummy.rotation.set(0, bar.yaw, 0);
    barDummy.updateMatrix();
    barMesh.setMatrixAt(index, barDummy.matrix);
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
  const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
  const headColor = new THREE.Color();
  // A light pod that is "off" this frame is written this matrix instead of the body's — same
  // trick as ZERO_SCALE above, just precomputed once since every hidden pod collapses to the same
  // thing regardless of where its car actually is.
  const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

  /**
   * Take a wrecked car off the road and hand its bodywork to the game layer, which shrinks and
   * fades it into the explosion — see game/vanish.js. Called for both cars in a crash.
   *
   * The taxi owns its own group — steered wheels and all — so that comes straight back. An ambient
   * car is spread across two InstancedMeshes (body, plus one instance per steered front wheel),
   * neither of which has anywhere to put a per-instance opacity: `instanceColor` is RGB only, so
   * fading one would mean a custom attribute plus an onBeforeCompile patch for something that
   * happens once per run. It is copied out into a standalone group wearing one tinted,
   * transparent-able material instead, and every instance behind it collapses to zero scale.
   */
  function wreckShell(car) {
    car.crashed = true;
    if (car.isTaxi) return taxiGroup;

    // A truck reads its body and wheels from its own mesh pair — everything below is identical to
    // an ordinary car's wreck, just aimed at whichever pair this car actually lives in. Both wear
    // PALETTE.carBody at this car's own colorIndex; a truck's cargo box is a second, separately
    // coloured mesh added below only for a truck.
    const bodyInst = car.isTruck ? truckMesh : mesh;
    const wheelInst = car.isTruck ? truckWheelMesh : wheelMesh;
    const front = car.isTruck ? TRUCK_FRONT : FRONT;

    // One material across body and wheels, so the fade takes the whole copy down together.
    // Baked vertex colours multiply by material.color exactly as they did by instanceColor, so
    // the copy comes out the same car in the same paint.
    const material = propMaterial();
    material.color.set(PALETTE.carBody[car.colorIndex]);

    const shell = new THREE.Group();
    bodyInst.getMatrixAt(car.instanceIndex, matrix);
    matrix.decompose(shell.position, shell.quaternion, shell.scale);

    const body = new THREE.Mesh(bodyInst.geometry, material);
    body.castShadow = true;
    shell.add(body);

    // The front wheels hang off the body matrix as separate instances — see writeAmbient. Copied
    // here at the lock the impact caught them at, since a wreck isn't steering any more.
    for (const anchor of front) {
      const wheel = new THREE.Mesh(wheelInst.geometry, material);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.rotation.y = car.wheelAngle;
      wheel.castShadow = true;
      shell.add(wheel);
    }

    // The cargo box: its own mesh, its own fixed-colour material — never tinted by colorIndex, on
    // the road or in the wreck. game/vanish.js collects every distinct material under the shell
    // into a Set, so a second material here fades in step with the cab's without extra wiring.
    if (car.isTruck) {
      const boxMaterial = propMaterial();
      boxMaterial.color.set(PALETTE.truckBox);
      const box = new THREE.Mesh(truckBoxMesh.geometry, boxMaterial);
      box.castShadow = true;
      shell.add(box);
    }
    scene.add(shell);

    // Collapse everything the copy replaces — body instance and both wheel instances.
    matrix.compose(pos.set(car.x, ROAD_Y, car.z), quat.identity(), ZERO_SCALE);
    bodyInst.setMatrixAt(car.instanceIndex, matrix);
    for (let w = 0; w < front.length; w++) {
      wheelInst.setMatrixAt(car.instanceIndex * front.length + w, matrix);
    }
    bodyInst.instanceMatrix.needsUpdate = true;
    wheelInst.instanceMatrix.needsUpdate = true;
    // The lights too — a crashed car stops reaching writeAmbient() (the main loop skips anything
    // `crashed`), so whatever it last wrote would otherwise sit there forever. A brake light lit at
    // the moment of impact is exactly the frame this fires on.
    const brakeInst = car.isTruck ? truckBrakeMesh : brakeMesh;
    const turnLeftInst = car.isTruck ? truckTurnLeftMesh : turnLeftMesh;
    const turnRightInst = car.isTruck ? truckTurnRightMesh : turnRightMesh;
    brakeInst.setMatrixAt(car.instanceIndex, ZERO_MATRIX);
    turnLeftInst.setMatrixAt(car.instanceIndex, ZERO_MATRIX);
    turnRightInst.setMatrixAt(car.instanceIndex, ZERO_MATRIX);
    brakeInst.instanceMatrix.needsUpdate = true;
    turnLeftInst.instanceMatrix.needsUpdate = true;
    turnRightInst.instanceMatrix.needsUpdate = true;
    if (car.isTruck) {
      truckBoxMesh.setMatrixAt(car.instanceIndex, matrix);
      truckBoxMesh.instanceMatrix.needsUpdate = true;
    }
    return shell;
  }

  const wheelMatrix = new THREE.Matrix4();
  const wheelLocal = new THREE.Matrix4();
  const wheelQuat = new THREE.Quaternion();
  const wheelPos = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const lightMatrix = new THREE.Matrix4();
  const lightScale = new THREE.Vector3();

  /**
   * Write one ambient car's body matrix, the two front wheels hanging off it, and its brake/turn
   * lights. The wheels are composed *through* the body matrix rather than in world space, so they
   * inherit the bob, the corner lean and the pitch rock for free and stay bolted to the arches
   * through all three. The lights need no such composition — their pods are baked at a fixed offset
   * into their own geometry (see lightPod()) — but they do need their own scale, so each is `pos`
   * and `quat` (still holding this car's own transform, set by the caller just before this runs)
   * recomposed at that light's own eased level rather than `scl`'s fixed (1, 1, 1).
   */
  function writeAmbient(car) {
    const bodyInst = car.isTruck ? truckMesh : mesh;
    const wheelInst = car.isTruck ? truckWheelMesh : wheelMesh;
    const front = car.isTruck ? TRUCK_FRONT : FRONT;
    bodyInst.setMatrixAt(car.instanceIndex, matrix);
    // The cargo box rides the identical transform — its offset from the cab is baked into its own
    // geometry (see truckBoxGeometry()), not carried as a separate local matrix.
    if (car.isTruck) truckBoxMesh.setMatrixAt(car.instanceIndex, matrix);
    wheelQuat.setFromAxisAngle(UP, car.wheelAngle);
    for (let w = 0; w < front.length; w++) {
      const anchor = front[w];
      wheelPos.set(anchor.x, anchor.y, anchor.z);
      wheelLocal.compose(wheelPos, wheelQuat, scl);
      wheelMatrix.multiplyMatrices(matrix, wheelLocal);
      wheelInst.setMatrixAt(car.instanceIndex * front.length + w, wheelMatrix);
    }

    // brakeLevel/turnLeftLevel/turnRightLevel are 0..1 set once per frame, above ("Rocking" for the
    // eased brake level, the turn-signal block right after it for the un-eased blink levels) — this
    // just renders them. A level of exactly 0 collapses the pod the same way ZERO_MATRIX used to.
    const brakeInst = car.isTruck ? truckBrakeMesh : brakeMesh;
    const turnLeftInst = car.isTruck ? truckTurnLeftMesh : turnLeftMesh;
    const turnRightInst = car.isTruck ? truckTurnRightMesh : turnRightMesh;
    lightMatrix.compose(pos, quat, lightScale.setScalar(car.brakeLevel));
    brakeInst.setMatrixAt(car.instanceIndex, lightMatrix);
    lightMatrix.compose(pos, quat, lightScale.setScalar(car.turnLeftLevel));
    turnLeftInst.setMatrixAt(car.instanceIndex, lightMatrix);
    lightMatrix.compose(pos, quat, lightScale.setScalar(car.turnRightLevel));
    turnRightInst.setMatrixAt(car.instanceIndex, lightMatrix);
  }

  /**
   * May a car joining the ring pull out? Only if nothing on the ring is bearing down on the
   * junction — the ring never stops, so the gap has to be a real one.
   */
  /**
   * Is every approach on `street` far enough from the junction to pull out in front of?
   *
   * Both yielding rules are this question with a different clearance. Asking it per *street* is
   * what removes the last place the sim assumed a junction is two axes with two approaches each:
   * `[0, 2]` / `[1, 3]` becomes "the inbound lanes belonging to that street", which a three-way or
   * a five-way answers just as readily.
   */
  // Note: a car can appear in its own scan, and is deliberately left there. During a yellow on its
  // own approach the moving street *is* this car's, so it finds itself at zero gap and refuses —
  // which is exactly what the pre-port form did, because `movingDirs` included the car's own
  // direction too. Skipping self here would grant right-on-red during one's own yellow, which is a
  // behaviour change and not this port's to make.
  function streetIsClear(car, street, clearance, approaching) {
    const node = net.nodeById.get(car.lane.to);
    for (const lane of node.inbound) {
      if (lane.phase !== street) continue;
      for (const other of approaching.get(lane.id) ?? []) {
        // How much lane the other car has left before the junction — which is all `s` now means.
        const gap = other.lane.length - other.s;
        if (gap >= 0 && gap < clearance) return false;
      }
    }
    return true;
  }

  /**
   * Is the cross traffic that currently holds the green far enough away to turn right on red?
   *
   * Takes the resolved signal rather than re-asking the network, so the answer respects the boost
   * hold and the siren corridor. Asking `laneSignal` directly here meant that while Loco Mode held
   * a junction, a car denied by that hold scanned the phase plan's green street — which could be
   * its own — found itself sitting at the line with zero gap, and was never granted a turn it used
   * to be granted.
   */
  function rightOnRedClear(car, sig, approaching) {
    return streetIsClear(car, sig.street, RIGHT_ON_RED_YIELD, approaching);
  }

  /** The ring never stops, so a car joining it has to find a real gap. */
  function ringGapClear(car, approaching) {
    const node = net.nodeById.get(car.lane.to);
    return streetIsClear(car, node.priorityStreet, RING_YIELD, approaching);
  }

  function update(dt) {
    stats.time += dt;
    const t = stats.time;

    // Set before any car evaluates a signal this frame. Ring junctions get an override too —
    // the ring-vs-cross branches below check `priorityCovers` and route the boosting taxi through
    // `canProceed`, which then yields the crossing ring traffic to the taxi's axis. A crashed
    // taxi is off the lane grid: releasing its priority hold lets signals run.
    const taxiActive = !taxi.crashed;
    const taxiTurningLeft = taxi.route?.length > 0 && taxi.route[0] === leftOf(taxi.d);
    setPriorityJunction(taxiActive && taxi.boost
      ? {
        i: taxi.i,
        j: taxi.j,
        axis: isXAxis(taxi.d) ? 'x' : 'z',
        block: taxiTurningLeft ? opposite(taxi.d) : null,
      }
      : null);

    if (taxiActive && taxi.boost && !taxi.wasBoosting) {
      taxi.v = Math.max(taxi.v, SPEED * loco.kick);
    }
    taxi.wasBoosting = taxi.boost;

    // Weave inside the lane while boosting — the "he is driving like a maniac" tell, now that the
    // taxi holds its own lane instead of straddling the centreline.
    //
    // Both the wave's argument and its envelope are paced by *distance travelled*, not by elapsed
    // time, and neither advances unless the car is running straight. The centreline version this
    // replaced learned that the hard way twice: a time-paced offset slid the car sideways while it
    // sat still at a red, and a ramp that ran through a corner pushed it off its own Bézier arc
    // partway round. Freezing the phase mid-turn also means the corner ends on the offset it
    // started on, with no jump back onto the wave on the way out.
    if (taxiActive) {
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
    // Lane id -> members, each at its arc length along that lane. `s` runs the same way on every
    // lane, so there is no travel-direction sign to carry around any more.
    const lanes = new Map();
    const approaching = new Map(); // inbound lane id -> cars on it, for the yielding rules
    // Intersections with a car stuck mid-turn, waiting for room to land. Cross traffic must not
    // be released into one of these or it drives straight through the stranded car.
    const heldAt = new Set();

    for (const car of cars) {
      if (car.state === 'turn' && car.turnT >= 0.95) heldAt.add(`${car.i},${car.j}`);
    }

    for (const car of cars) {
      // A crashed car is not in traffic at all. A *boosting* taxi used to be skipped here too, on
      // the grounds that it had left its lane; now that it only weaves within it, it belongs in
      // the bookkeeping like anyone else. That cuts both ways and both matter: it sees the car it
      // is closing on, and traffic behind it sees it when the car in front makes it brake — an
      // ambient car rear-ending the taxi ended the run through no fault of the player.
      if (car.crashed) continue;

      let lane = car.lane;
      let laneS = car.s;

      if (car.state === 'drive') {
        // Keyed by the lane, which already says both which junction is being approached and from
        // where — the two halves of the old `${i},${j},${d}` key.
        if (!approaching.has(car.lane.id)) approaching.set(car.lane.id, []);
        approaching.get(car.lane.id).push(car);
      } else if (car.turnT < 0.6) {
        // First half of the turn: still queued behind in the lane it came from, nose past the line
        // and into the junction — hence a position beyond the lane's own end.
        laneS = car.lane.length + car.turnT * 5;
      } else {
        // Second half: hand the car over to the lane it is about to land in, still short of that
        // lane's start. Without this it is invisible to that lane's traffic for the rest of the
        // turn, and then materialises on top of whatever drove into the gap.
        lane = net.laneById.get(car.turn.outLane);
        laneS = -(1 - car.turnT) * 5;
      }

      if (!lanes.has(lane.id)) lanes.set(lane.id, []);
      lanes.get(lane.id).push({ car, laneS });
    }

    // Furthest along first, so each lane's list reads front to back.
    for (const members of lanes.values()) members.sort((a, b) => b.laneS - a.laneS);

    /** The turn that carries straight on out of a lane, if there is one. Exits are sorted. */
    const straightOn = (lane) => {
      const first = lane.exits.length ? net.turnById.get(lane.exits[0]) : null;
      return first && first.hand === 'straight' ? first : null;
    };

    /**
     * Every vehicle ahead of `s` on `lane`, out to `range`, carrying straight on through junctions.
     * Nearest first.
     *
     * This is the forward view the old `laneKey` gave for free by being one *infinite* lane per
     * row: a car saw the queue on the far side of a junction because that queue was in the same
     * list. Per-edge lanes end that, so the chain has to be walked — and both things that needed
     * the view need it walked the same way, car-following and the Loco Mode scatter alike.
     *
     * "Straight on" is the faithful continuation rather than an approximation of one: the old row
     * *was* the straight-through chain, and a car that turned off left the row and stopped being
     * seen by everyone behind it.
     */
    const ahead = (lane, s, range) => {
      const out = [];
      let base = -s;
      let cur = lane;
      // Three lanes and the two junctions between them span 52 units, comfortably past the
      // longest range asked of it (SCATTER_RANGE, 40).
      for (let hop = 0; hop <= 2; hop++) {
        for (const m of lanes.get(cur.id) ?? []) {
          const gap = base + m.laneS;
          if (gap > 0 && gap <= range) out.push({ car: m.car, gap });
        }
        const turn = straightOn(cur);
        if (!turn) break;
        base += cur.length + turn.length;
        if (base > range) break;
        cur = net.laneById.get(turn.outLane);
      }
      return out.sort((p, q) => p.gap - q.gap);
    };

    // Distance to the vehicle ahead, per car. A distance rather than the leader's position: with
    // the leader now possibly on a different lane, its coordinate is not comparable to this car's.
    const leaderDist = new Map();
    // And who it actually is, which the overtake needs: a car being passed must not turn across
    // the taxi while it is alongside — see `passTarget` below.
    const leaderOf = new Map();
    for (const [laneId, members] of lanes) {
      for (let k = 1; k < members.length; k++) {
        const behind = members[k];
        const ahead = members[k - 1];
        const gap = ahead.laneS - behind.laneS;
        // Only measure real lane geometry. A turning car's lane position is a synthetic stand-in
        // used for queueing, so including it here reports overlaps that don't exist on screen.
        if (behind.car.state === 'drive' && ahead.car.state === 'drive' && gap < stats.minGap) {
          stats.minGap = gap;
        }
        leaderDist.set(behind.car, gap);
        leaderOf.set(behind.car, ahead.car);
      }
      // The car at the front of a lane has to look past the junction for its leader.
      //
      // Asked of a *turning* car too, which it wasn't: the walk starts from the lane the car is
      // listed under rather than from `car.lane`, because those are the same thing only while the
      // car is driving. A car mid-turn appears in its entry lane's list at a position past that
      // lane's end for the first part of the arc and is handed to its exit lane's list at a
      // negative one for the rest, and `car.lane` stays pointed at the entry lane throughout — so
      // walking from `car.lane` with a laneS belonging to the exit lane measures from the wrong
      // end of the junction. `laneId` is what the position means, so it is what the walk uses.
      // For a driving car the two are identical and this is the call it always made.
      const front = members[0];
      const next = ahead(net.laneById.get(laneId), front.laneS, LOOKAHEAD)[0];
      if (next) { leaderDist.set(front.car, next.gap); leaderOf.set(front.car, next.car); }
    }

    // --- The two entry tests that aren't the signal.
    //
    // Both are asked twice: once on approach, to fold into `allowed` so a refusal is *braked
    // into*, and again at the line, on the turn actually chosen. They live here rather than
    // inline at the line so the two askings cannot drift apart — an approach that slows for a
    // reason the arrival doesn't share is a car that stops for nothing.

    /**
     * Is the lane this car would land in too full to enter? Don't-block-the-box: without it a car
     * finishing a turn is teleported to the exit point regardless of what is already sitting there.
     *
     * Extra margin on top of the following distance, because the exit lane can back up during the
     * second or so the turn takes and holding mid-intersection is far more disruptive than simply
     * waiting at the line. That margin is priced in time, not distance: a boosting taxi crosses in
     * 0.35–0.7s rather than ~1.2s, so it has half as long to be overtaken by events and only needs
     * the plain following distance. Charging it the full 1.5× was the single biggest cause of a
     * dead stop under a green with the button held — 9.7% of boosted frames at ?cars=40.
     */
    const exitLaneFull = (car, exitLane) => {
      return (lanes.get(exitLane.id) ?? []).some(({ car: other, laneS }) => {
        if (other === car || other.state !== 'drive') return false;
        const clearance = followGap(car, other) * (car.boost ? 1 : 1.5);
        // The car lands at the exit lane's start, so `laneS` *is* the signed clearance. It is
        // needed on both sides: a car approaching from behind the landing point gets landed on
        // just as hard as one already sitting in front of it.
        return Math.abs(laneS) < clearance;
      });
    };

    /** Left turns yield to oncoming traffic close to the same intersection. */
    const leftYieldBlocked = (car) => {
      if (car.boost && priorityCovers(car.i, car.j)) {
        // The oncoming lane is already being held at its own line by the priority hold (see
        // `block` on priorityJunction), so measuring the distance to it would mean waiting for a
        // car that is waiting for us — a deadlock that read on screen as the brakes coming on
        // under a green. Only a vehicle already inside the junction can still be turned into.
        return cars.some((other) => other !== car && other.state === 'turn'
          && other.i === car.i && other.j === car.j && !other.crashed
          && other.d === opposite(car.d));
      }
      const facing = net.laneByGrid(opposite(car.d), car.i, car.j);
      const oncoming = (facing && approaching.get(facing.id)) ?? [];
      return oncoming.some((other) => {
        const otherDist = other.lane.length - other.s;
        return otherDist >= 0 && otherDist < YIELD_RANGE;
      });
    };

    /**
     * Loco Mode's premise is that **nothing stops the taxi**. The signal already yields to it —
     * that is the priority hold — but three things could still bring it to a dead halt at a line
     * it supposedly owned: a car stranded mid-turn in the box, a full exit lane, and an oncoming
     * car on a left. Those are the ambient rules for sharing a junction politely, and a car being
     * driven like this is not sharing it.
     *
     * So it barges through, and the consequence is the point: `sim/collisions.js` is armed for
     * exactly as long as this is true, so entering a junction that has something in it is a
     * *wreck*, not a wait. That is what makes the mode risky rather than merely fast — the reason
     * to lift off the button is that you can see what you are about to hit, not that the sim will
     * quietly stop you.
     *
     * `car.boost` rather than `fullPower`, so it stays true through the cooldown tail alongside
     * every other boost-only hazard rule. Letting go does not buy a car that starts yielding
     * again any more than it buys one that stops being crashable.
     */
    const bargesThrough = (car) => car.boost;

    /**
     * Everything that can refuse this car at the line *other* than the signal, asked while it is
     * still far enough out to stop for the answer.
     *
     * The signal was always read on approach — that is what lets a car slow for a red rather than
     * arrive at it. The other three refusals were only ever asked on arrival, and the only way to
     * obey one there is to stop where you stand: the car is pinned to the hold line with its speed
     * untouched. Ambient traffic gets away with that because it arrives at cruise and the block
     * usually clears in a frame or two. A boosting taxi arrives at 18.7 u/s and does not: it froze
     * on the spot with the engine still at full, no nose dip, the wheels still turning and the Loco
     * weave still sliding it sideways, then snapped back to top speed the instant the box cleared.
     * That is the "gas being cut" stutter, and the multi-second version of it is the taxi looking
     * stuck at an intersection it supposedly owns.
     *
     * Asked only about a turn the car is actually committed to. A routed car — the taxi — knows its
     * next exit, so its answer is exact. An unrouted one has not rolled its dice yet, so it slows
     * only when *every* exit is blocked and no roll can save it; anything narrower would have cars
     * braking for a turn they were never going to take.
     */
    const entryRefused = (car) => {
      if (bargesThrough(car)) return false;
      // A car stranded mid-turn: cross traffic released into the junction drives through it.
      if (heldAt.has(`${car.i},${car.j}`)) return true;

      const routed = car.route?.length ? exitToward(net, car.lane, car.route[0]) : null;
      if (routed) {
        if (routed.hand === 'left' && leftYieldBlocked(car)) return true;
        return exitLaneFull(car, net.laneById.get(routed.outLane));
      }
      // A junction with no legal exit at all holds forever, so `every` over an empty list
      // answering "refused" is the right answer rather than an edge case to special-case.
      return car.lane.exits.every((id) => exitLaneFull(
        car, net.laneById.get(net.turnById.get(id).outLane),
      ));
    };

    // --- Passing: the boosting taxi goes round, on the wrong side of the road.
    //
    // The offer stands only where a pass can physically finish — see PASS_* above. The player
    // takes it by *keeping the button down*, which is the whole control: holding through a car in
    // front means "go around it", and letting go means "tuck in behind". No new control on a HUD
    // that has deliberately few, and the button becomes a decision at the one moment it currently
    // makes none.
    //
    // Keyed on the button actually being held rather than on `car.boost`, which is the one place
    // in the file that wants the narrower flag: every other boost-only rule stays armed through
    // the cooldown tail because those are *hazards*, and hazards should outlive the release. This
    // is an input. Letting go has to steer the car back.
    if (taxiActive) {
      const gap = leaderDist.get(taxi);
      const locoHeld = taxi.boost && !taxi.boostEasing;
      // A pass needs somewhere to go and somewhere to finish: an oncoming lane to borrow, and a
      // route that carries straight on rather than turning out of the manoeuvre half way through.
      // `route[0]` advances as each junction is consumed, so this goes false by itself on the far
      // side of the junction the pass crossed, and the tuck-in starts with a lane still to do it.
      // Somewhere to go and somewhere to finish: an oncoming lane to borrow, and a route that
      // carries straight on through the junction ahead rather than turning out of the manoeuvre
      // half way through. `route[0]` is consumed as each junction is crossed, so this goes false
      // by itself on the far side of the one the pass spanned — and the tuck-in gets a whole
      // lane to happen in, against the PASS_FADE it needs.
      //
      // One junction, not two. Two was tried, on the grounds that a pass wants more road than one
      // buys, and it is worse than either: a taxi with exactly two fails the test after crossing
      // the first and abandons the pass mid-manoeuvre — 3 of every 4, measured. Sizing the
      // manoeuvre to the road with PASS_TRIGGER is what fixed it instead.
      const room = taxi.route?.[0] === taxi.d
        && Boolean(net.laneByGrid(opposite(taxi.d), taxi.i, taxi.j));
      // Hysteresis: pull out when the leader starts costing speed, stay out until it is properly
      // behind. Without the second number the taxi flutters in and out around the trigger.
      const near = gap !== undefined && gap < (taxi.passing ? PASS_SUSTAIN : PASS_TRIGGER);
      // Only re-decided on a lane. Every pass spans a junction by construction — 32 units of
      // manoeuvre against a 12-unit lane — so re-deciding mid-crossing would drop the commitment
      // in the middle of exactly the manoeuvre it exists to hold, and hand the leader brake and
      // the scatter back at the worst possible moment. There is nothing to decide there anyway:
      // the offset is frozen through a junction, so the taxi comes out the far side on the side
      // of the road it went in on, and the next lane re-asks the question with `route[0]` already
      // advanced to the step beyond.
      // Never pull out around a car that is already crossing a junction. Its arc sweeps the
      // oncoming lane the taxi is about to borrow, and by then the guard below cannot help — a
      // car in `turn` has already chosen, and the turn decision does not run again. This is the
      // half of the problem the guard could not reach, and the larger half: latching the target
      // and refusing its left turn on its own fixed 1 wreck in 10, because the leader had
      // committed before the taxi did.
      //
      // **Except a straight-through crossing**, which is not the thing this gate is about.
      // `car.state === 'turn'` covers every junction transition including going straight on, and
      // the danger being guarded is a car turning *across* the borrowed lane — 6 of the 10 measured
      // mid-pass wrecks were the leader turning left, and every one of the other 4 was a car in the
      // middle of a real turn. A leader whose committed movement is `hand === 'straight'` sweeps
      // nothing: it is going down the same road the taxi is, in the lane the taxi is leaving. This
      // is the trap the whole codebase warns about — `state === 'turn'` is not "is turning" — and
      // reading it as one cost the pass every junction the leader happened to be inside. On a road
      // with a junction every 20 units that is 40% of the time, and it is exactly the 40% in which
      // the taxi is tailgating hard enough to want to pull out.
      const leader = leaderOf.get(taxi);
      const passable = leader !== undefined
        && (leader.state === 'drive' || leader.turn?.hand === 'straight');

      // Is the borrowed lane actually empty? World space rather than the lane graph, because a
      // pass always spans a junction — "the oncoming lane" is two lanes and which one matters
      // changes half way through, so a heading test and a side test are less machinery than the
      // chain walk that would find them.
      //
      // Asked only at the moment of pulling out. Once committed the taxi is committed, so a car
      // that emerges into the oncoming lane mid-pass still costs the run — that is the risk worth
      // keeping, because it is the one the player could not have read. Being thrown into a car
      // that was in plain sight is not: without this the taxi pulled out with oncoming traffic as
      // little as 3 units away, already inside the collision envelope.
      const oncomingClear = () => {
        const sign = dirSign(taxi.d);
        const facing = opposite(taxi.d);
        for (const other of cars) {
          if (other === taxi || other.crashed || other.d !== facing) continue;
          const along = isXAxis(taxi.d) ? (other.x - taxi.x) * sign : (other.z - taxi.z) * sign;
          if (along < 0 || along > PASS_SIGHT) continue;
          // On this road rather than a parallel one. Measured against the far lane's centre plus
          // a body, *not* HALF_ROAD: opposing lane centres are exactly 2·LANE apart, which is
          // exactly HALF_ROAD, so a bound of HALF_ROAD sits precisely on the car being looked
          // for and the weave alone was enough to push it out of sight. The next road over is
          // PITCH (20) away, so there is a lot of daylight before this catches the wrong car.
          const side = Math.abs(isXAxis(taxi.d) ? other.z - taxi.z : other.x - taxi.x);
          if (side <= PASS_LATERAL + CAR_W) return false;
        }
        return true;
      };

      // Still bodily alongside the car it pulled out for? Then the manoeuvre is not over, whatever
      // the lane arithmetic says. `leaderDist` stops reporting that car the instant the taxi's
      // *centre* goes past its centre, which drops `near`, which drops the commitment — and the
      // taxi then cut back across the nose of a car it was level with. Measured against the latched
      // target in world space instead, and held until it is `PASS_CLEAR` behind, which is the only
      // definition of "past it" a body has.
      const alongside = () => {
        const mark = taxi.passTarget;
        if (!mark || mark.crashed) return false;
        const sign = dirSign(taxi.d);
        const rel = isXAxis(taxi.d) ? (mark.x - taxi.x) * sign : (mark.z - taxi.z) * sign;
        return rel > -PASS_CLEAR;
      };

      if (taxi.state === 'drive') {
        const was = taxi.passing;
        taxi.passing = locoHeld
          && ((taxi.passing && alongside())
            || (room && near && (taxi.passing || (passable && oncomingClear()))));
        // Latched on the frame the taxi pulls out and held for the whole manoeuvre, rather than
        // re-read per frame: half way through a pass the taxi is *ahead* of this car in lane
        // coordinates, so `leaderOf` has already moved on to whatever is in front of them both.
        if (taxi.passing && !was) taxi.passTarget = leader ?? null;
        if (!taxi.passing) taxi.passTarget = null;
      }

      // Paced by distance, because a time-paced offset slides a stopped car sideways.
      //
      // Frozen through a *corner*, because a lane change running through one would peel the car off
      // its own Bézier arc — but **not** through a straight-through crossing, which is the trap
      // again: `state === 'turn'` covers every junction transition, and freezing on all of them
      // meant that since every pass spans a junction by construction, most passes stopped dead
      // half way across the road. Measured at the default gap, the taxi parked at `pass` 0.66 —
      // `z = −0.9`, near enough exactly the centreline, which docs/traffic.md calls the single
      // worst place on the road — and drove the whole 8 units of the junction like that before
      // resuming. That is most of what "the passing motion feels very angular" was: not the ramp's
      // shape but a hole punched in the middle of it.
      //
      // A straight-through crossing has no arc to peel off. Its path is a straight line and its
      // yaw is constant, so the offset composes with it exactly as it does on a lane.
      const crossingStraight = taxi.state === 'turn' && taxi.turn?.hand === 'straight';
      const ds = (taxi.state === 'drive' || crossingStraight) ? taxi.v * dt : 0;
      const delta = (taxi.passing ? 1 : 0) - taxi.pass;
      const step = Math.sign(delta) * Math.min(Math.abs(delta), ds / PASS_FADE);
      taxi.pass += step;

      // `pass` stays the linear 0..1 *progress* through the change — it is what every gate, test
      // and readout reads, and "how far through the manoeuvre" is a more useful thing for them to
      // ask than a position. The shape lives in what comes off it.
      //
      // The offset is smoothstepped. The yaw is the offset's slope — the same trick the weave uses,
      // and the reason there is nothing to ease here: because the offset is a function of *distance*
      // rather than of time, its slope is exactly the tangent of the steering angle at any speed. So
      // easing the offset eases the steering for free, and a smoothstep's slope starting and ending
      // at zero is precisely what stops the car snapping into and out of its crab angle.
      //
      // `rate` is d(pass)/d(road), which is ±1/PASS_FADE while ramping and 0 otherwise. Taking it
      // from the actual step rather than assuming the constant is what keeps the last, clamped
      // frame of a change honest instead of reporting a full-speed slope for a sliver of movement.
      const rate = ds > 0.0001 ? step / ds : 0;
      taxi.passOffset = passEase(taxi.pass) * PASS_LATERAL;
      taxi.passSlope = passEaseSlope(taxi.pass) * PASS_LATERAL * rate;

      // Body roll, from the curvature of that same offset. `passEase`'s second derivative is
      // `6 − 12t`, so this is +1 at the start of a change and −1 at the end whichever way the ramp
      // is running: thrown one way out of the lane, settling the other way into it, and mirrored on
      // the way back. Eased over PASS_BANK_EASE units of road rather than applied raw, because the
      // lateral input really does step and a body that stepped with it would be hinged, not sprung.
      const bankTarget = rate === 0 ? 0 : 1 - 2 * taxi.pass;
      taxi.passBank += (bankTarget - taxi.passBank) * Math.min(1, ds / PASS_BANK_EASE);
    }

    // --- Who is in the boosting taxi's way?
    //
    // Both the lane it is driving and the lane it is about to land in: a queue sitting on the
    // exit point is what turns the don't-block-the-box check below into a dead stop at a green
    // line, which is the second-biggest thing that took Loco Mode's speed away.
    const fleeing = new Set();
    if (taxiActive && taxi.boost) {
      const mark = (lane, fromS) => {
        for (const { car } of ahead(lane, fromS, SCATTER_RANGE)) {
          // Trucks are exempt — too big to skitter. See the scatter tuning block up top.
          if (!car.isTaxi && !car.isTruck) fleeing.add(car);
        }
      };

      // The exit lane is measured from behind its start by the same clearance the box check wants,
      // so the cars that would fail that check are exactly the ones told to move.
      const markExit = (lane) => mark(lane, -MIN_GAP * 1.5);

      // Nothing scatters while the taxi is passing. Scatter's premise is "the car in front is in
      // my way", and a taxi that has committed to going round it has answered that a different
      // way. Left on it defeats the pass outright: a fleeing car runs at SCATTER_SPEED (2.0x
      // cruise, 17 u/s) against the taxi's 18.7, so the ~15 units of relative displacement a pass
      // needs would take nine seconds, against the one a straightaway is worth.
      //
      // *Both* marks, which is not obvious and was got wrong first. Suppressing only the
      // same-lane one measured as an exact no-op — same passes, same completions, to the frame —
      // because on a straight route the "exit lane" *is* the taxi's own lane past the junction,
      // so `markExit` re-marked every car the first call had just been stopped from marking.
      // Skipping both is worth 2.6 -> 3.4 passes/min at ?cars=22.
      //
      // Suppressing here rather than lowering SCATTER_SPEED is what keeps the flee at full
      // strength everywhere it is still the right answer: every car the taxi is *not* going
      // round, which is nearly all of them.
      if (taxi.state === 'drive') {
        mark(taxi.lane, taxi.s);
        // Only once the junction is close enough to matter — otherwise every car on every road
        // the route touches is fleeing a taxi two blocks away.
        if (taxi.lane.length - taxi.s <= SCATTER_RANGE) {
          const turn = exitToward(net, taxi.lane, taxi.route?.length ? taxi.route[0] : taxi.d);
          if (turn) markExit(net.laneById.get(turn.outLane));
        }
      } else if (taxi.state !== 'drive') {
        markExit(net.laneById.get(taxi.turn.outLane));
      }
    }

    for (const car of cars) {
      // Snaps on, lets go slowly. The flee has to start on the frame the taxi arrives behind, but
      // dropping it the instant the taxi turns off would visibly deflate the car mid-block.
      const target = fleeing.has(car) ? 1 : 0;
      car.scatter += (target - car.scatter) * Math.min(1, dt * (target > car.scatter ? 12 : 1.2));
    }

    stats.moving = 0;
    stats.waiting = 0;

    for (const car of cars) {
      if (car.crashed) continue;

      // Ease panic toward its target on every car every frame, so it decays smoothly whether the
      // car is driving, turning, or otherwise skipped by the physics branch below.
      const panicTarget = panicTargetFor(car);
      car.panic += (panicTarget - car.panic) * Math.min(1, dt * 6);

      // The pull-over, ditto — and its slope, which is what points the nose and the front wheels
      // into the manoeuvre. Taken over the step the car actually drove, so the angle is the one it
      // is really describing; a car shuffling over from a standstill has no slope and keeps its
      // wheels straight, which is exactly what a stopped car does.
      const pulloverTarget = pulloverTargetFor(car);
      const before = car.pullover;
      car.pullover += (pulloverTarget - car.pullover)
        * Math.min(1, dt * (pulloverTarget > car.pullover ? PULLOVER_RISE : PULLOVER_FALL));
      const pulloverStep = (car.pullover - before) * -PULLOVER_LATERAL;
      const pulloverDs = car.state === 'drive' ? car.v * dt : 0;
      car.pulloverSlope = pulloverDs > 0.0001 ? pulloverStep / pulloverDs : 0;

      // `car.boost` alone drives every boost-only *rule* (weave, tailgate gap, priority junction,
      // red-light running) all the way through the cooldown tail — that's what keeps the risk
      // alive after the button comes up. Actual boost *speed* is narrower: it drops the instant
      // the hold ends, so the taxi coasts back down under ordinary braking instead of holding
      // boost speed for the whole cooldown window — and the overdrive band goes with it, so the
      // top end is only ever held while the button is. That coast-down is also where the nose-dip
      // comes from — the pitch spring downstream reads the resulting deceleration off car.v
      // directly, and from the overdrive top it is a longer, deeper one.
      const fullPower = car.boost && !car.boostEasing;

      if (car.state === 'drive') {
        // A lane ends exactly at the junction boundary — that is where `buildLanes` trimmed it —
        // so the stop line is the lane's own length, pulled back by the crosswalk clearance. No
        // travel-direction sign: `s` counts forward along the lane whichever way it points.
        const holdS = car.lane.length - STOP_SETBACK;
        const distToLine = holdS - car.s;

        // --- How much road is this car actually allowed to use before it must be stopped?
        //
        // Two numbers, because the constraints are two different kinds of thing.
        //
        // `allowed` is the **positional budget**: road this car may consume this frame. Everything
        // contributes to it, the car in front included, and it is what stops anything driving
        // through anything else.
        //
        // `stopRoom` is the clear road to the nearest thing that is genuinely **standing still** —
        // a stop line, a refused entry, a kerb hold. It is what the speed target is computed from,
        // because `sqrt(2·BRAKE·room)` is the speed you can still *stop* inside `room`, and that is
        // only the right question about something that will still be there when you arrive.
        let allowed = Infinity;
        let stopRoom = Infinity;

        // The signal ahead, read now rather than on arrival — this is what lets it slow early.
        // A corridor or a boosting-taxi priority hold both temporarily signalise the junction, so
        // the taxi's approach reads green and cross traffic yields to it; `approachSignal` resolves
        // that before it asks the network.
        const sig = approachSignal(car, t);
        if (!sig.open && !taxiClearsYellow(car, sig, distToLine)) {
          allowed = Math.min(allowed, Math.max(0, distToLine));
          stopRoom = Math.min(stopRoom, Math.max(0, distToLine));
        }

        // The car ahead. A boosting taxi used to ignore this entirely — it was out on the
        // centreline and went round. In its own lane it has to see the leader or it drives into
        // the back of it, so it tailgates at BOOST_GAP instead: still visibly impatient, still
        // clear of the collision envelope, and it takes the gap the instant the leader turns off.
        // Not while committed to a pass: the taxi is going *round* this car, so measuring its
        // bumper is measuring the wrong lane. It comes straight back the moment the commitment
        // lapses, which is what makes letting go of the button a real abort — the taxi drops back
        // behind the car it was passing under ordinary braking instead of sitting alongside it
        // matching speed forever.
        //
        // **A moving leader is not a wall.** `sqrt(2·BRAKE·room)` is the speed you can still stop
        // from inside `room`, and against a car that is itself driving away that is the wrong
        // question — it prices in braking to a standstill for something that will not be there. The
        // cost was not subtle: the docs say the boosting taxi tailgates at `BOOST_GAP` (4.5 units),
        // and it did not. Behind a car fleeing at `SCATTER_SPEED` (17 u/s) the stopping rule
        // settles it **17.6 units** back, which is outside `PASS_TRIGGER`, so the overtake was
        // never even offered on an open road; and because the cap moves with the gap, the taxi
        // spent every lane braking and every junction accelerating — a sawtooth with a period of
        // one block, which is what "the taxi stutters on the approach" looks like from the outside.
        //
        // The fix is the leader's own speed plus what can be shed over the clear road between them:
        // you may out-run the car in front by exactly as much as you can give back before reaching
        // it. A *stopped* leader has `v = 0` and the expression collapses to the old rule exactly,
        // so queueing at a red — which everything else here is tuned around — is untouched.
        //
        let leadCap = Infinity;
        const ahead = seesLeader(car) ? leaderDist.get(car) : undefined;
        if (ahead !== undefined) {
          const leader = leaderOf.get(car);
          const gap = car.boost ? BOOST_GAP : followGap(car, leader);
          const room = Math.max(0, ahead - gap);
          allowed = Math.min(allowed, room);
          leadCap = (leader?.v ?? 0) + Math.sqrt(2 * brake() * room);
        }

        // The rest of the entry test, on the same terms as the signal: read on approach so the
        // car brakes for it. Only worth asking once the line is inside braking range — outside it
        // `allowed = distToLine` is a ceiling above the speed the car is already doing, so the
        // answer cannot change anything and the scan is pure cost.
        if (distToLine <= (car.v * car.v) / (2 * brake()) + 2 && entryRefused(car)) {
          allowed = Math.min(allowed, Math.max(0, distToLine));
          stopRoom = Math.min(stopRoom, Math.max(0, distToLine));
        }

        if (car.parked) {
          if (car.route.length) car.parked = false;
          else { allowed = 0; stopRoom = 0; }   // eases to a halt rather than stopping dead
        }

        // Fastest speed still stoppable inside `allowed`, approached under real accel limits.
        // A panicking car — one currently reacting to the siren — dips off the throttle. The
        // deeper reaction is visual (the swerve and the wobble at render time); this just keeps
        // it from serenely holding cruise while jerking around the road.
        // A car fleeing the boosting taxi lifts its ceiling and finds some urgency to go with it:
        // at ACCEL it would need 24 units to reach the scatter speed and the junction is 20 away,
        // so without the extra push the higher cap would never actually be reached.
        // A car in the siren's own lane sheds more again as it pulls over — see `cruiseCapFor`,
        // which is where all three factors live now.
        const cruiseCap = cruiseCapFor(car);
        // The ceiling at full boost is the *overdrive* top, not the BOOST_SPEED one — but the
        // acceleration tapers above BOOST_SPEED, so the band past 18.7 is only ever reached by a
        // car that has had 40 units of straight road and a clear `allowed` to spend it on.
        const topSpeed = fullPower ? overdriveTop() : cruiseCap;
        const accel = fullPower
          ? boostAccel(car.v)
          : ACCEL + (scatterAccel() - ACCEL) * car.scatter;
        const desired = Math.min(
          topSpeed, leadCap, Math.sqrt(2 * brake() * Math.max(0, stopRoom)),
        );
        car.v = desired > car.v
          ? Math.min(desired, car.v + accel * dt)
          : Math.max(desired, car.v - brake() * dt);

        let step = Math.min(car.v * dt, Math.max(0, allowed));
        // Braking only asymptotes toward the line; snap the last sliver so arrival happens. Keyed
        // on `stopRoom` rather than `allowed`, because "you have arrived, stop" is a statement
        // about a *line*. Against the car in front it was the freeze: a budget of zero behind a
        // leader still doing 16 u/s set `car.v = 0` outright, and the leader then drove away from a
        // car that had gone from 20.9 to nothing in one frame. Following is the speed cap's job and
        // it converges on its own; the budget's job here is only to stop the step overshooting.
        if (stopRoom < 0.05) { step = Math.max(0, allowed); car.v = 0; }

        // No `distToLine > 0` guard: with the hold line set back from the junction, a car can
        // spawn already beyond it, and requiring it to still be approaching meant the decision
        // never fired and the car drove off the map forever.
        if (distToLine - step <= 0) {
          // About to reach the stop line — decide whether to enter the intersection.
          // A corridor or a boosting-taxi priority hold temporarily signalises the ring, so the
          // siren's or the taxi's green path is unbroken.
          // Re-read on arrival. `signalised` is the branch, not `ringAxisAt`: a junction the
          // network left without a light — the ring, or one a closure reduced to a straight-through
          // — is yield-controlled, and asking `ringAxisAt` instead would hold cars at a junction
          // that has no phase for them to wait for.
          const arrive = approachSignal(car, t);

          let green;
          let viaRightOnRed = false;
          if (!arrive.signalised) {
            // No signal here. The priority street runs; anyone joining waits for a real gap.
            green = arrive.open || ringGapClear(car, approaching);
          } else {
            const held = heldAt.has(`${car.i},${car.j}`) && !bargesThrough(car);
            green = (arrive.open || taxiClearsYellow(car, arrive, distToLine)) && !held;

            // Right on red. Permitted only as a right turn, only with a gap in the traffic that
            // currently holds the green, and never into a junction an emergency vehicle is
            // clearing or one already blocked by a stranded car.
            const rightTurn = exitToward(net, car.lane, rightOf(car.d));
            if (!green && !held && !corridorCovers(car.i, car.j)
                && rightTurn && !closedLanes.has(rightTurn.outLane)
                && rightOnRedClear(car, arrive, approaching)) {
              viaRightOnRed = true;
            }
          }

          let chosen = null;

          if (viaRightOnRed) {
            // The only legal move is the right turn. A routed car takes it if its plan agrees;
            // otherwise it waits for the green like anyone else.
            const turn = exitToward(net, car.lane, rightOf(car.d));
            if (turn && (!car.route?.length || car.route[0] === rightOf(car.d))) {
              chosen = turn;
              if (car.route?.length) car.routeConsumed = true;
            }
          } else if (green) {
            // Already in straight/right/left order — the order the weighted roll below walks, and
            // the one `legalExits` used to return.
            const options = car.lane.exits.map((id) => net.turnById.get(id));
            const routed = car.route?.length
              ? options.find((o) => net.dirOfLane(net.laneById.get(o.outLane)) === car.route[0])
              : null;

            // A routed car (the player's taxi) takes the next turn its route calls for; everyone
            // else rolls the weighted straight/right/left dice. This single branch is the entire
            // difference between ambient traffic and a directed vehicle — everything below it
            // (yielding, don't-block-the-box, signals, following distance) applies identically,
            // so the taxi cannot cheat its way to a destination.
            if (routed) {
              chosen = routed;
              car.routeConsumed = true;
            } else {
              // A routed car whose next step is not a legal exit has desynced from its plan.
              // Silently falling through to a random turn would let it wander while still holding
              // a stale route, so drop the route and count it — this should never fire.
              if (car.route?.length) {
                stats.routeDesync += 1;
                car.route.length = 0;
              }
              // Weight straight/right/left, then fall back to whatever is legal here. The hand
              // comes off the turn rather than out of direction arithmetic, which is what lets a
              // three-way — where one approach can have two distinct lefts — weight them both.
              const weighted = options.map((turn) => {
                const kind = turn.hand === 'straight' ? 0 : turn.hand === 'left' ? 2 : 1;
                // Fleeing the boosting taxi: carrying straight on keeps this car in the taxi's
                // lane for another whole block, so it barely rolls that option. Still a weight
                // rather than a filter — at a T-junction straight may be the only legal exit.
                let w = kind === 0 && car.scatter > 0.5 ? SCATTER_STRAIGHT_W : TURN_WEIGHTS[kind];
                // A siren about to come through this junction: hold your line and let it past
                // rather than turn across its nose. Exactly the courtesy the no-left-across-a-pass
                // rule below extends to the taxi, for exactly the same reason — the sim cannot
                // resolve two cars in one square metre, and this is a manoeuvre the *cruiser*
                // cannot avoid, since it neither queues nor brakes for anybody.
                //
                // It is also the only part of the reaction that can reach a car mid-junction. The
                // pull-over offset is released for the length of a real turn (pulloverTargetFor),
                // so a car that commits to one is back on the lane centre with the cruiser coming
                // through; and an oncoming left-turner never had the offset at all. Between them
                // that was 115 of the last 188 interpenetrating frames over 67 corridor runs. Not
                // turning is the only fix that does not bend a car off its own arc.
                if (kind !== 0 && sirenHoldsTurn(car)) w = SCATTER_STRAIGHT_W;
                // A road closed for roadworks, for the same reason and with a stronger version of
                // the same guarantee. With any open exit present `total` is positive, `roll` is
                // strictly greater than zero, and a zero-weight option can never win the walk
                // below — so this reads as a hard ban. With *every* exit closed `total` is zero,
                // `roll` is zero, and the first iteration's `roll -= 0` satisfies `roll <= 0`:
                // the car takes `options[0]` and drives on. That degenerate case is what makes a
                // weight the right shape here. A filter would empty the list, and a car with no
                // exit holds at the line forever with the whole lane queued behind it.
                return { turn, w: closedLanes.has(turn.outLane) ? 0 : w };
              });
              const total = weighted.reduce((sum, o) => sum + o.w, 0);
              let roll = rng.next() * total;
              for (const option of weighted) {
                roll -= option.w;
                if (roll <= 0) { chosen = option.turn; break; }
              }
              chosen ??= options[0];
            }

            // A car being overtaken does not turn left across the car overtaking it. Same
            // courtesy `priorityJunction.block` already extends to oncoming traffic while the
            // taxi turns left, extended for the same reason: the sim has no way to resolve two
            // cars that occupy the same square metre, so the one manoeuvre neither of them can
            // avoid is the one that has to not happen.
            //
            // This is not softening the mode. A pass wants ~27 units of road and a lane is 12, so
            // the taxi is *always* still alongside when the leader reaches its junction — which
            // is exactly when the left-turn dice are rolled. That made a left across the taxi the
            // single most common way a pass ended: 6 of the 10 mid-pass wrecks measured over 28
            // overtakes, with every one of the other 4 also a car in the middle of a turn. It was
            // not a risk the player could read and dodge, it was the default outcome. What is
            // left is: oncoming traffic, cross traffic at a junction being run, and a car turning
            // out of the oncoming lane — all of which are in front of the player and avoidable.
            if (car === taxi.passTarget && chosen?.hand === 'left') chosen = null;

            // The same two tests the approach above already asked, now on the turn actually
            // chosen — a dice roll can land on an exit the "every exit blocked" form let through.
            if (!bargesThrough(car)) {
              if (chosen?.hand === 'left' && leftYieldBlocked(car)) chosen = null;
              if (chosen && exitLaneFull(car, net.laneById.get(chosen.outLane))) chosen = null;
            }
          }

          if (!chosen) {
            // Held at the line after all — the routed turn was never taken, so the route must not
            // advance. It will be reconsidered next frame.
            car.routeConsumed = false;
            car.s = holdS - 0.02; // hold at the line, clear of the crosswalk
            // Pinning `s` stops the car; it does not stop the *car*. Everything downstream reads
            // `v` — the wheels, the body bob, the pitch spring's nose dip, the Loco weave, which
            // paces itself off `v · dt` and would otherwise keep sliding a stationary taxi
            // sideways. Left untouched, `v` said 18.7 u/s while the car sat still, and the release
            // then handed that speed straight back with no acceleration in between: the frame-scale
            // version of that is the stutter, the second-scale version is the taxi looking stuck.
            //
            // Bled off at BRAKE rather than zeroed for the same reason the approach test above
            // exists: a block that appears in the last few frames before the line can still be
            // arrived at fast, and a one-frame refusal must not cost the whole tank of speed. From
            // the overdrive top that is ~1.9s to a standstill, and a single refused frame costs
            // 0.18 u/s.
            car.v = Math.max(0, car.v - brake() * dt);
            car.speedFactor = car.v / SPEED;
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
          else if (arrive.signalised && !arrive.open
              && !taxiClearsYellow(car, arrive, distToLine)) stats.violations += 1;

          // Straight off the network: the arc's ends are the two lanes' own endpoints and its
          // control point is where their tangents cross. `turnControl`'s "same axis falls back to
          // the midpoint" special case is that intersection being parallel, so one rule now covers
          // a right turn, a left, a straight-through and a sweep across a diagonal.
          const exitLane = net.laneById.get(chosen.outLane);
          car.turn = chosen;
          car.entry = car.lane.path.at(car.lane.length);
          car.exit = exitLane.path.at(0);
          car.control = chosen.control;
          car.dOut = net.dirOfLane(exitLane);
          car.turnT = 0;

          // The hold line is now behind the junction boundary, so crossing it is a straight
          // run-up followed by the arc. Keeping the arc itself anchored at the boundary is what
          // preserves crisp corners — starting the curve from the hold line instead would turn
          // every corner into a long lazy sweep.
          car.hold = car.lane.path.at(holdS);
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

        car.s += step;
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
        const straightOn = car.turn.hand === 'straight';
        // `cruiseCapFor`, not a bare SPEED — the same ceiling the drive branch uses, which is what
        // stops a car changing its mind about how fast it is going every time it crosses a road.
        // A car fleeing the boosting taxi runs at `SCATTER_SPEED` (2.0× cruise) on a lane and used
        // to drop to a flat 8.5 the moment it entered a junction, then spend the next lane climbing
        // back — a 17 ↔ 8.5 sawtooth with a period of exactly one block. That is what the taxi
        // behind it was faithfully braking for, and it is what "the taxi stutters on the approach"
        // turned out to be: the taxi was steady, the car in front was not.
        const cruise = fullPower ? boostCruise() : cruiseCapFor(car);
        // Going straight on is part of the straightaway, so it keeps the overdrive band and keeps
        // building through it; a junction crossed in a straight line is 8 units of the 40 the band
        // needs. Only a real turn is capped at `cruise`, which is what makes a corner cost the top
        // end rather than merely interrupt it.
        const straightTop = fullPower ? overdriveTop() : cruise;
        // Crazy mode doesn't lift for left-turns or straights — it goes round them at full pelt,
        // and the lean plus the rubber on the road sell it instead of a speed drop. Right turns
        // are the exception: with right-hand traffic they cut across the near corner (chord ≈
        // HALF_ROAD − LANE per leg) instead of the far diagonal a left turn sweeps, so at full
        // boost the whole arc completes in ~0.35s vs a left's ~0.7s and reads as *sped up*. A
        // softer target on rights (0.75× cruise) keeps the no-brakes feel while giving the tight
        // arc back its visual weight.
        const isRight = car.turn.hand === 'right';
        const boostTurn = fullPower
          ? (isRight ? cruise * 0.75 : cruise)
          : car.isTruck
            ? (isRight ? TRUCK_RIGHT_TURN_SPEED : TRUCK_CORNER_SPEED)
            : CORNER_SPEED;
        const cornerTarget = straightOn ? straightTop : boostTurn;

        // Don't close on the car in front while crossing a junction.
        //
        // This branch had no following term at all, and for ambient traffic it never showed: a car
        // crosses at cruise and its `cornerTarget` *is* cruise, so it cannot gain on anyone in
        // here. A boosting taxi can. It enters the junction slow — because it has been tailgating
        // at `BOOST_GAP` on the approach — and then floors it to the overdrive top across the 8
        // units of junction with the brake simply absent, closing three units on a car it can see
        // the whole way. Staged on the lab's straight road (docs/lab.md), that was **43 of 160**
        // approaches ending as a rear-end at a dead stop with `pass` still 0.00: the taxi never got
        // to pull out, because it hit the car during the crossing before the straight it would have
        // passed on began. It is visible in `tools/probe.mjs`'s own overtake scenario too, where
        // the taxi drives clean through its leader — that scenario just doesn't run collisions.
        //
        // Exactly the drive branch's rule, and *exactly* matters: any difference between the two
        // is a speed target that jumps at the junction boundary, which the car then chases with
        // real acceleration — the taxi accelerating across every junction and braking down every
        // lane, four times a block. The first version of this cap applied only inside
        // `PASS_TRIGGER` and produced precisely that.
        //
        // Because the cap is the leader's own speed plus what can be shed in the clear road, it can
        // never demand a stop behind a moving car, so it stays a speed target and never becomes a
        // hold. That is what keeps `bargesThrough`'s guarantee intact: nothing stops the taxi
        // inside a junction.
        let target = cornerTarget;
        const lead = seesLeader(car) ? leaderOf.get(car) : undefined;
        const leadGap = lead === undefined ? undefined : leaderDist.get(car);
        if (leadGap !== undefined) {
          const room = Math.max(0, leadGap - (car.boost ? BOOST_GAP : followGap(car, lead)));
          target = Math.min(target, lead.v + Math.sqrt(2 * brake() * room));
        }

        // Same acceleration as the drive branch, scatter push included: a ceiling a car cannot
        // climb to is not a ceiling. At plain ACCEL a fleeing car needs 24 units to reach
        // SCATTER_SPEED and a junction is 8, so without this the cruise cap above would raise the
        // roof and the car would still cross at the speed it entered.
        const accel = fullPower ? boostAccel(car.v) : ACCEL + (scatterAccel() - ACCEL) * car.scatter;
        car.v = car.v > target
          ? Math.max(target, car.v - brake() * dt)
          : Math.min(target, car.v + accel * dt);
        car.turnT += (car.v * dt) / car.turnLen;
        car.travelled += car.v * dt;
        car.speedFactor = car.v / SPEED;
        if (car.turnT < 1) stats.distance += SPEED * dt;

        if (car.turnT >= 1) {
          // Re-check the landing spot. Clearance was verified on entry, but the arc takes over
          // a second to traverse and the exit lane can back up in that time — completing
          // regardless is a teleport straight into the car in front.
          const exitLane = net.laneById.get(car.turn.outLane);
          const blocked = (lanes.get(exitLane.id) ?? []).some(({ car: other, laneS }) => {
            if (other === car || other.state !== 'drive') return false;
            return laneS > -0.1 && laneS < followGap(car, other);
          });

          if (blocked && !bargesThrough(car)) {
            // Hold just short of completion; the phantom lane entry keeps followers queued.
            // Not for a boosting taxi: stopping *inside* a junction is the one hold that would
            // strand it across live traffic, and it is landing on the car either way — better
            // that it lands on it at speed and the collision detector calls it.
            car.turnT = 0.999;
            stats.waiting += 1;
            continue;
          }

          car.lane = exitLane;
          car.s = 0;                 // the exit point is where the landing lane begins
          car.turn = null;
          syncGrid(car);
          car.state = 'drive';
          car.turnT = 0;
        }
        stats.moving += 1;
      }
    }

    // --- Resolve render transforms.
    for (let index = 0; index < cars.length; index++) {
      const car = cars[index];

      // A crashed car's shell belongs to the wreck effects now — `wreckShell()` handed the game
      // layer either the taxi group or a standalone copy of this instance to shrink and fade, and
      // collapsed the instance itself. Composing a transform here would resurrect it.
      if (car.crashed) continue;

      if (car.state === 'drive') {
        const p = car.lane.path.at(car.s);
        car.x = p.x;
        car.z = p.z;
        car.yaw = yawOf(car.lane.path.tangentAt(car.s));
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
      // The weave and the overtake are the same kind of thing — a lane-relative offset the
      // simulation does not know about — so they compose here rather than fighting over one
      // field. Keeping them apart matters: the weave's yaw is eased toward its target every
      // frame, and folding a 4-unit lane change into that eased value would have the ease drag
      // the car back out of the pass.
      const lateral = car.lateral + car.passOffset;
      if (Math.abs(lateral) > 0.001) {
        car.x -= Math.sin(car.yaw) * lateral;
        car.z -= Math.cos(car.yaw) * lateral;
      }
      // The pull-over rides in here rather than with the panic shove below, because unlike the
      // wobble it *is* a steering input: the nose and the front wheels should both point at the
      // kerb the car is diving for.
      const steer = car.steer + (car.passSlope ? Math.atan(car.passSlope) : 0)
        + (car.pulloverSlope ? Math.atan(car.pulloverSlope) : 0);
      if (steer) car.yaw += steer;

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

      // The pull-over, on the same basis. Two things differ from the shove above.
      //
      // **It does not add to the panic shove, it replaces it** — the subtraction below leaves the
      // larger of the two, never the sum. Stacked they reach 2.4 units off the lane centre, which
      // puts a body edge 5.17 from the road centreline, past the 4.85 where the building façades
      // start (blockBounds plus the 0.85 lot inset). Taking the max caps the excursion at 4.34,
      // measured over 199 corridor runs, and costs nothing visually because the pull-over is the
      // bigger of the two wherever both are running.
      //
      // **It carries no state gate of its own.** A real turn is excluded at the *target* (see
      // pulloverTargetFor), which lets the offset ease out across the front of the arc instead of
      // vanishing on the frame the car commits to it — and going straight through a junction keeps
      // the whole offset. That second part is the difference between a car moving over and a car
      // flickering: a straight-through is `state === 'turn'` too (see `dOut !== d`), so gating on
      // 'drive' the way the panic shove does snapped every yielding car back to the lane centre
      // for the eight units of each junction box, 212 of the 353 interpenetrating frames left
      // after the pull-over first landed.
      if (car.pullover > 0.001) {
        const already = car.state === 'drive' ? PANIC_LATERAL * car.panic : 0;
        const push = Math.max(0, PULLOVER_LATERAL * car.pullover - already);
        car.x += Math.sin(car.yaw) * push;
        car.z += Math.cos(car.yaw) * push;
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
          const turnDir = car.turn.hand === 'right' ? 1 : car.turn.hand === 'left' ? -1 : 0;
          const lean = 0.3 * Math.min(2.2, Math.max(0.7, car.v / SPEED));
          roll = -turnDir * lean * Math.sin(Math.PI * Math.min(1, along01));
        }
      }

      // And the lane change leans too — but the *other way* from the corner above it, and that is a
      // deliberate call rather than a sign slip, so it is worth pinning down before someone
      // "fixes" it.
      //
      // A corner leans **outward**, away from the turn centre, because that is where weight
      // transfer actually throws a body; leaning inward there reads as a motorbike. A lane change
      // is negated against that: the car dips onto the edge it is heading *for*, so pulling out to
      // overtake drops the driver's side and tucking back in drops the passenger's. Physically it
      // is the wrong way round, and it was chosen after looking at both — a lane change is over in
      // half a second, and an outward lean spends that half second tipping *away* from the
      // direction the eye is being asked to follow.
      //
      // Positive roll is a lean to the car's right — the top tips toward +Z, which is `right` at
      // any yaw — so the negation is the whole of the difference. Added to the corner roll rather
      // than replacing it, since they are two things happening to one suspension, though in
      // practice they never overlap: a pass is only offered where the route carries straight on,
      // and a straight-through crossing has `turnDir` 0. Measured over eight cities at ?cars=22, a
      // pass is displaced through a real corner for exactly 0 frames.
      //
      // Speed-scaled on the corner lean's own clamp, because a lane change at cruise and one at
      // the overdrive top are not the same event.
      if (car.passBank) {
        roll -= car.passBank * PASS_BANK * Math.min(2.2, Math.max(0.7, car.v / SPEED));
      }

      // Up on the kerb. The outer wheels are the ones that climb it, so the body leans *toward*
      // the road — the same sign as the lean into a right-hand corner, and away from the kerb the
      // car is parked against. Only part of KERB_H because only part of the body is up there.
      // Summed with the two above rather than replacing them: they are three different things
      // happening to one suspension, and only the taxi ever has more than one of them at once.
      const mount = KERB_H * PULLOVER_MOUNT * car.pullover;
      if (car.pullover > 0.001) roll -= PULLOVER_ROLL * car.pullover;

      // Rocking. Pitch is a spring-damper driven by longitudinal acceleration: braking dips the
      // nose forward, easing off the brake lifts it, and the underdamping (ζ ≈ 0.4) makes both
      // events end on a small bounce so it reads as suspension travel. Impulse to pitchV works
      // out as K·SCALE·Δv, independent of dt — a one-frame velocity jump (boost kick, stop-line
      // snap) delivers the same rock at any frame rate.
      //
      // A truck gets a smaller impulse (TRUCK_PITCH_SCALE) and more damping — heavier, so the same
      // Δv moves the nose less, and what motion there is dies out instead of rocking back through
      // another cycle. See the note by TRUCK_SPEED for where the two constants are defined.
      const accel = dt > 1e-6 ? (car.v - car.prevV) / dt : 0;
      car.prevV = car.v;
      // Brake lights read the same signal the pitch dip does — see BRAKE_ACCEL above — plus a
      // near-standstill floor so a car queued at a line stays lit instead of going dark the instant
      // accel settles back to zero. Eased rather than snapped straight to the target — see
      // BRAKE_LIGHT_RISE/FALL — which is what keeps a one-frame gap in `accel` from reading as a
      // flicker: the level doesn't have time to fall before the target is true again.
      const brakeTarget = accel < -BRAKE_ACCEL || car.v < BRAKE_STOP_V ? 1 : 0;
      car.brakeLevel += (brakeTarget - car.brakeLevel)
        * Math.min(1, dt * (brakeTarget > car.brakeLevel ? BRAKE_LIGHT_RISE : BRAKE_LIGHT_FALL));

      // Turn signals: on for TURN_SIGNAL_DUTY of every cycle rather than a plain 50/50 square wave
      // (see the note by TURN_SIGNAL_DUTY). `car.phase` — already the idle bob's per-car offset —
      // desyncs a queue of blinkers from flashing in lockstep. A real turn is `dOut !== d` (see the
      // note near the top of this file); `hand` says which way, and both only exist while
      // `state === 'turn'` — the arc across the junction, which is the one window a real driver's
      // indicator would still be ticking in. No easing here, unlike the brake level above — a
      // signal is meant to read as a single blinker flashing, so the level jumps straight to target.
      const turning = car.state === 'turn' && car.turn && car.turn.hand !== 'straight';
      const cyclePos = (((stats.time + car.phase) * TURN_SIGNAL_HZ) % 1 + 1) % 1;
      const wantsBlink = turning && cyclePos < TURN_SIGNAL_DUTY;
      car.turnLeftLevel = wantsBlink && car.turn.hand === 'left' ? 1 : 0;
      car.turnRightLevel = wantsBlink && car.turn.hand === 'right' ? 1 : 0;

      const pitchScale = car.isTruck ? TRUCK_PITCH_SCALE : 1;
      const targetPitch = Math.max(-0.13, Math.min(0.13, accel * 0.014 * pitchScale));
      const pitchDamping = car.isTruck ? 6 * TRUCK_PITCH_DAMPING_MULT : 6;
      car.pitchV += ((targetPitch - car.pitch) * 60 - car.pitchV * pitchDamping) * dt;
      car.pitch += car.pitchV * dt;

      // Loco Mode kickoff: a short, one-shot wheelie added on top of the pitch spring — see
      // locoWheelie() for why it is shaped by hand rather than run through the spring. Clearing
      // the timer at the end keeps the pitch bookkeeping out of a weird state.
      let wheelieBoost = 0;
      if (car.wheelieT !== undefined && car.wheelieT !== null) {
        car.wheelieT += dt;
        if (car.wheelieT >= WHEELIE_DUR) car.wheelieT = null;
        else wheelieBoost = locoWheelie(car.wheelieT);
      }
      // Off a roadworks ramp. Read off distance travelled rather than a clock — see HOP_LEN —
      // so the arc is the same shape at cruise and in overdrive, and a taxi that stops halfway up
      // a barricade hangs there instead of continuing its arc on the spot.
      let airY = 0;
      let airPitch = 0;
      if (car.hopFrom != null) {
        const u = (car.travelled - car.hopFrom) / HOP_LEN;
        if (u >= 1) {
          car.hopFrom = null;
          // Touchdown, and the only frame that can see it — see the note in game/roadwork.js about
          // reading this flag. Hand the landing to the bounce and load the suspension.
          car.bounceT = 0;
          car.pitchV -= BOUNCE_PITCH;
        } else {
          airY = HOP_HEIGHT * Math.sin(Math.PI * u);
          // Nose up as it leaves the ramp, level at the apex, nose down into the landing. Positive
          // is nose-up here, the same sense as locoWheelie.
          airPitch = HOP_PITCH * Math.cos(Math.PI * u);
        }
      } else if (car.bounceT != null) {
        // A separate field from `hopFrom` on purpose: everything that asks "is the taxi airborne"
        // — the barricade's landing event, the roadworks pack-up, the probe's hop assertions — is
        // asking about the *arc*, and a bounce that answered yes would move all of them.
        car.bounceT += dt;
        if (car.bounceT >= BOUNCE_DUR) car.bounceT = null;
        else airY = landingBounce(car.bounceT);
      }

      const shownPitch = car.pitch + wheelieBoost + airPitch;

      // Roll and pitch both pivot on the car's origin at road level, so tilting drives one edge
      // underground. Lifting by the sagitta of each keeps the low edge on the tarmac and reads as
      // suspension travel rather than clipping.
      const lift = Math.abs(Math.sin(roll)) * (CAR_W / 2)
        + Math.abs(Math.sin(shownPitch)) * (CAR_LEN / 2);

      if (car.isTaxi) {
        // `mount` is always 0 here — pulloverTargetFor skips the taxi — but it costs nothing to keep
        // the two position lines saying the same thing.
        taxiGroup.position.set(car.x, ROAD_Y + bob + lift + airY + mount, car.z);
        // 'YXZ' — not the default — for the same reason the ambient euler below says so. See the
        // note there: with the default order the roll is applied about the *world* X axis, which
        // only doubles as the car's own axis when it happens to be driving east.
        taxiGroup.rotation.set(roll, car.yaw, shownPitch, BODY_EULER_ORDER);
        setTaxiSteer(car.wheelAngle);
        setTaxiLights(car.brakeLevel, car.turnLeftLevel, car.turnRightLevel);
        continue;
      }

      pos.set(car.x, ROAD_Y + bob + lift + mount, car.z);
      // The order is load-bearing and the default is wrong here. Three composes 'XYZ' as
      // Rx·Ry·Rz, so the roll lands *outside* the yaw and turns about the world X axis — which is
      // the car's own long axis only when the car is driving east. Head north or south and the
      // same number renders as pitch and the lean disappears; head west and it leans the wrong
      // way. 'YXZ' is Ry·Rx·Rz: yaw first, so the roll turns about the body, and the lean is the
      // same at every heading. (The two orders agree exactly at yaw 0, which is why the passing
      // lab — a road running due east — could never have caught this.)
      quat.setFromEuler(euler.set(roll, car.yaw, car.pitch, BODY_EULER_ORDER));
      matrix.compose(pos, quat, scl);
      writeAmbient(car);
    }
    mesh.instanceMatrix.needsUpdate = true;
    wheelMesh.instanceMatrix.needsUpdate = true;
    truckMesh.instanceMatrix.needsUpdate = true;
    truckWheelMesh.instanceMatrix.needsUpdate = true;
    truckBoxMesh.instanceMatrix.needsUpdate = true;
    brakeMesh.instanceMatrix.needsUpdate = true;
    turnLeftMesh.instanceMatrix.needsUpdate = true;
    turnRightMesh.instanceMatrix.needsUpdate = true;
    truckBrakeMesh.instanceMatrix.needsUpdate = true;
    truckTurnLeftMesh.instanceMatrix.needsUpdate = true;
    truckTurnRightMesh.instanceMatrix.needsUpdate = true;

    // --- Stop bar colours, one per approach.
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      const sig = displaySignal(bar.lane, t);
      headColor.set(sig.open
        ? PALETTE.lightGreen
        : sig.yellow ? PALETTE.lightYellow : PALETTE.lightRed);
      barMesh.setColorAt(index, headColor);
    }
    if (barMesh.instanceColor) barMesh.instanceColor.needsUpdate = true;
  }

  /** Fixed-step warm-up so screenshots show settled traffic, deterministically. */
  function warmup(seconds, step = 1 / 60) {
    for (let elapsed = 0; elapsed < seconds; elapsed += step) update(step);
  }

  return {
    cars, taxi, taxiGroup, setTaxiOccupied, setTaxiHighlight, setCarCount, mesh,
    wheelMesh, barMesh, update, warmup,
    wreckShell, stats,
    lightPhase, displayPhase,
    // The instanced cars, index-aligned with `mesh`, and how `wheelMesh` is indexed off them
    // (`instanceIndex * wheelsPerCar + w`). Anything reading those matrices back needs both —
    // game/carghosts.js does. Passed out rather than derived, because `wheelMesh.count /
    // mesh.count` divides by zero under `?cars=1`, where there are no ambient cars at all.
    ambient, wheelsPerCar: FRONT.length,
    // Trucks, passed out the same shape so main.js can occlude them and wire up their AO
    // prepass — but not folded into `ambient`/`wheelsPerCar` above, since those are index-aligned
    // with the *car* meshes and game/carghosts.js reads them as such.
    truckMesh, truckWheelMesh, truckBoxMesh, trucks, truckWheelsPerCar: TRUCK_FRONT.length,
  };
}
