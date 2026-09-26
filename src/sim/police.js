import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import {
  DIR, GRID_I, GRID_J, HALF_SPAN_X, HALF_SPAN_Z, PITCH, dirSign, isXAxis, laneOffX, laneOffZ,
  legalExits, lineX, lineZ,
  entryPoint, exitPoint, turnControl,
  isSegmentClosed, nextIntersection, opposite,
} from '../city/grid.js';
import { sirenOn } from '../geometry/lights.js';
import { deckHeightAt } from '../city/river.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  setPriorityCorridor, setPolicePresence, setPoliceRoads, locoWheelie, isLaneClosed,
  sirenLaneAhead, WHEELIE_DUR, ROAD_Y, STOP_SETBACK, COP_CRUISE,
  wheelAnchors, wheelGeometries, wheelGeometry, steerToward, CHASSIS_LIFT,
} from './traffic.js';

// A police car running a priority corridor across the city: every signal on its road goes green,
// every crossing road goes red, and the traffic model reacts on its own because the override lives
// inside lightPhase.
//
// It drives its lane like any other car — right-hand traffic, one lane offset off the centreline in
// the direction of travel. Speed is still 19 (about twice traffic), so it catches up to
// same-direction traffic on the corridor road within a block or two.
//
// There is still no collision *response* — nothing here can be crashed into, and nothing here
// queues — but the lane is no longer shared silently. What used to happen was that the cruiser
// drove through whatever it caught: the corridor holds every downstream light green, so the
// argument went that ambient cars in the lane are already moving by the time it arrives, and at
// 19 against 8.5 that is simply not enough. Now the traffic gets out of the way and the cruiser
// moves over to meet it — see PULLOVER_* in traffic.js for the car's half and DODGE_* below for the
// cruiser's. Between them the two bodies clear each other by about 0.9 units.

const SPEED = 19;
const RUN_MARGIN = 26;          // how far off-map it starts and ends

// --- The jog ----------------------------------------------------------------
//
// A corridor run used to be one straight line from one edge of the map to the other, which is the
// whole of what a rail is: eight seconds with no decision anywhere in them, and the cruiser reads
// as a tram more than as a car. So most runs now take a **one-block sidestep** — two corners
// somewhere in the middle, a short leg across, and back onto the heading it started on, a road
// over from where it was pointed.
//
// Deliberately no more than that, and deliberately planned before the run starts rather than
// decided at each junction. Nothing here has collision response or queueing; what keeps that from
// showing is the corridor holding the road *ahead* green and the lane clearing itself
// (PULLOVER_* in traffic.js). Both of those need a road named in advance to work on, and a corner
// is the one moment the road being cleared changes — so the two roads a jog uses are checked end
// to end at `start()`, the same test the straight line already had to pass. Routing junction by
// junction is the chase's job, and the chase is allowed to look reckless because it is supposed to.
const JOG_CHANCE = 0.6;
// Chords the corner arc is measured in. Enough of them is not about the arc's *length* — eight
// chords are already inside a millimetre of that — it is about pacing the car along it.
//
// A quadratic Bezier's parameter is not its arc length. Both halves of this one are as long as the
// junction is deep, but the entry leg carries the lane offset as well (`reach + laneOff` against
// `reach`), so |B'| runs from 17.3 down to 8 across an arterial corner: driving `t` at a constant
// rate takes the cruiser into the junction half as fast again as its own 19 and out of it at two
// thirds. The chords carry a cumulative length and `t` is looked up against a distance instead, so
// what is left is the |B'| variation *within* one chord — ~3% at 24 of them.
const ARC_CHORDS = 24;
// Half-width of the finite difference `arcScale` measures the dodge's cost over. Small against the
// arc, large against a float.
const ARC_PROBE = 0.05;

/** Quadratic Bezier through the same three points every ambient car turns on. */
const bezierAt = (a, b, c, t) => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    z: u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  };
};
/** ...and its tangent, which is the heading: exactly dIn at t = 0 and exactly dOut at t = 1. */
const bezierTangent = (a, b, c, t) => {
  const u = 1 - t;
  return {
    x: 2 * (u * (b.x - a.x) + t * (c.x - b.x)),
    z: 2 * (u * (b.z - a.z) + t * (c.z - b.z)),
  };
};

// --- Squeezing past its own lane ---------------------------------------------
//
// The cruiser's half of the pull-over. Ambient traffic in its lane dives for the kerb (PULLOVER_* in
// traffic.js); this is the cruiser meeting it half way, because 1.5 units of pull-over against two
// 1.7-wide bodies still leaves them overlapping. Toward the road centreline, never across it —
// 1.1 off a lane offset of 2 leaves the cruiser 0.9 from the centreline and wholly on its own
// side, which matters even with the corridor holding the other way stopped, because the corridor
// only covers junctions and not the cars already mid-block on the far side.
// Toward the centreline, so the cruiser and the car diving for the kerb open a gap between them
// from both sides. It is a distance from the lane centre, which is what keeps it safe on a divided
// arterial: the cruiser ends up 2.6 from the yielding car's centre whatever the road's width. The
// ceiling is the median — `laneOff − MEDIAN_W/2 − CAR_W/2` is 1.28 on an arterial, so 1.1 keeps the
// flank off the kerb with 0.18 to spare. Widen the median and this has to come down with it; the
// probe asserts no vehicle but a passing taxi is ever over one.
const DODGE_LATERAL = 1.1;
const DODGE_LOOK = 24;          // how far ahead it starts moving over — ~1s at chase speed
const DODGE_EASE = 3.5;         // per second; ~0.3s to commit, so the swerve reads as a swerve

// --- Lock-on, and the hand-off to traffic ---------------------------------------
//
// The corridor run is scenery: it drives a line across town and never once acknowledges the
// player. Boost within a block of it and it comes after you — but it no longer ends the run on
// sight. It **gives chase as a car in traffic**, the same kind of car a bank robbery puts on the
// street (see "Cop cars in ambient traffic" in docs/traffic.md), and the player can outrun it.
//
// That is two phases, and the split is the point:
//
//   1. **The lock-on** (`chase()`, `driveChase`) — a beat on the rail. The throttle kick, the
//      wheelie, and the hard U-turn if the taxi is behind it: the moment the siren stops being
//      scenery and starts being about you. It also routes greedily toward the taxi at each junction
//      it reaches, so a lock-on that has to wait a block for somewhere to hand off is still heading
//      the right way.
//   2. **The hand-off** (`handOff`) — at the first lane it can join safely, the rail is abandoned
//      and the cruiser becomes an ordinary cop in `traffic.policeCars`: it queues, stops at reds,
//      can be rammed, overtakes and brake-checks, exactly like a robbery's cops. Only the *look*
//      stays the cruiser's — its mesh rides on the traffic car (`car.skin` in sim/traffic.js), so
//      the car on screen does not change model under the player's eye. Where it drives, and when it
//      catches you or gives up, is game/pursuit.js.
//
// The rail chase used to run all the way to an arrest at 37 u/s — three over the boosting taxi's
// overdrive top on purpose, because a bust you could escape was a chase that could not end. That
// ordering is now deliberately the other way round: a cop cruises at COP_CRUISE (21.7), a shade
// under a boosting taxi, which is the whole of what makes the pill the answer to being spotted.
//
// The lock-on runs at that speed too, so neither end of the hand-off is a step in speed.
export const LOCK_SPEED = COP_CRUISE;
const CHASE_ACCEL = 43;         // winds back up out of the U-turn in ~0.4s
const LOCK_SETTLE = 12;         // u/s² shed off the kick once it has been seen
// Rail position is exact and its corners are square. The drawn car eases toward it at this rate,
// which is what turns each 90° snap into an arc: the steady-state lag is v/rate ≈ 1.8 units at
// lock-on speed, so the cruiser cuts corners on about a lane radius instead of hinging on the spot.
const CHASE_SMOOTH = 12;
// How closely the drawn car has to sit on its lane before it may hand off: the lane centre is
// where the traffic car will be drawn on the next frame, so anything left of the ease is a visible
// sideways jump. 0.25 units is two pixels at play zoom; the heading gets the same allowance.
const HANDOFF_SNAP = 0.25;
const HANDOFF_YAW = 0.06;
// Road between the traffic car and its own hold line on the frame it joins, beyond STOP_SETBACK.
// A car handed to the traffic model inside its stop line runs the light (see CLAUDE.md), so it has
// to join short of it. It does not have to join far enough back to *stop*, which is the obvious
// margin and was the first one tried: at 21.7 u/s that is 13.4 units, more than a whole lane, and
// three units left a window of a quarter second per block that the wheelie alone could miss. The
// junction it is driving at is green for it anyway — the corridor is held down the lane it joins
// on until it is off it (`graceLane`) — so half a unit is enough to make the arrival a decision.
const HANDOFF_LINE = 0.5;
// Clear lane the joining car needs, ahead and behind, centre to centre. A body length and a bit
// either way: nothing else in this model tests two traffic cars against each other, so a cop
// placed inside another car stays inside it.
const HANDOFF_AHEAD = 7;
const HANDOFF_BEHIND = 6;
const YAW_EASE = 0.12;          // seconds for the nose to catch up with the direction of travel
// U-turn on lock-on. Left-hand swing (yaw always increases — see dirYaw), crossing the full road
// width from its lane to the opposing one while the nose comes round.
const UTURN_DUR = 0.45;
const UTURN_SPEED = 5;          // it has to scrub off nearly all of 19 to swing this tight
// Brake into the swing, power out of it, rather than holding one speed all the way through. Costs
// nothing in path terms and buys the whole handbrake-turn read, because both ends go through the
// pitch spring: nose dives, car pivots, tail squats, it leaves.
const UTURN_BRAKE = 45;
const UTURN_BEHIND = 6;         // only if the taxi is at least this far back; a near-level target
                                // is caught faster by carrying on to the junction ahead

// --- How it carries itself --------------------------------------------------
//
// The routing above is only half of "aggressive". A car that tracks a perfect line at a constant
// speed reads as a machine no matter how fast it is going; what sells Loco Mode on the taxi is the
// body — it squats when it plants the throttle, dives when it stands on the brakes, and leans out
// of every corner. The cruiser now does all three, off the same shapes (`locoWheelie`, and the
// pitch spring's constants below match the taxi's), so the two cars are recognisably driven the
// same way.
const CHASE_KICK = 1.32;        // instant surge on lock-on, the cruiser's BOOST_KICK
// The fastest the lock-on is ever drawn moving: the kick, before it settles. Exported so the
// probe's teleport check is measured against the car's real top rather than a copy of it.
export const LOCK_TOP = Math.max(LOCK_SPEED, SPEED * CHASE_KICK);
// Pitch spring: same constants as the taxi's, and the same reason for them — an underdamped
// spring driven by longitudinal acceleration ends both the dive and the squat on a small bounce,
// which is what reads as suspension travel rather than as the model being rotated.
const PITCH_GAIN = 0.014;
const PITCH_LIMIT = 0.13;
// Roll comes off yaw rate × speed — lateral acceleration, near enough. The taxi derives it from
// which way the Bézier goes, which this car has no equivalent of; going through the motion means
// the weave leans it as well as the corners do, and at the right proportion for free. Gain is set
// so a corner at chase speed lands on ~0.30 rad, matching the lean the taxi holds through one.
const ROLL_GAIN = 0.0026;
const ROLL_LIMIT = 0.34;
const ROLL_EASE = 0.09;         // seconds; the body takes a beat to load up, it doesn't snap over

const smoothstep = (t) => t * t * (3 - 2 * t);

// Boosting inside this radius while the police car is on a run sets it after you — reckless driving
// in front of a cop. One block in world units (PITCH = 20 in src/city/grid.js): the taxi and the
// siren have to be sharing a junction for it to fire, so it reads as being caught in the act
// rather than spotted from a street over. It used to end the run on the spot; now it starts a
// chase the player can outrun (game/pursuit.js). The name stayed because the arming rules below
// are still about the moment a cop can take an interest in you.
export const POLICE_BUST_RANGE = 20;

// How far inside the map edge the cruiser has to be before that radius means anything.
//
// The bust radius is a whole block and FADE_BAND below is 18, so a cruiser arriving on the map was
// **lethal before it was drawn**: for a taxi `e` units in from the edge the bust fired with the
// cruiser at `(e - 2) / 18` opacity — 0.44 half a block in, and a flat **zero** for anything on
// the ring road itself, in either lane, lamps included. Measured over 238 corridor runs, the old
// check was armed while the body was still fading for 28.6% of the frames it could reach the slab
// at all, and while the body was completely invisible for 2.9%. On the ring that was every bust.
//
// One PITCH is the inset at which that opacity reaches 1, so this is the bust radius rather than a
// tuned guess: arm where the cruiser is fully drawn and has had a block of visible approach
// (~0.95s at SPEED, ~0.5s if the taxi is closing on it in Loco Mode).
//
// The light bar does **not** wait for this — see `state.lit`. It runs for the whole of a visible
// run, so the siren is the announcement and this inset is the grace period behind it: about two
// seconds of a cop plainly coming at you (38 units from the first frame the body draws to the
// arming line, at SPEED) before it can take the run off you. The rule the player learns is
// *lights on means a cop is here*, and the beat they get is the difference between seeing one and
// being caught by it.
export const BUST_ARM_INSET = PITCH;

// The strobe rate and `sirenOn` itself moved to geometry/lights.js, which is where the siren bar's
// geometry and materials live. It stopped being the cruiser's own the moment a second kind of
// police car existed: the bank robbery puts cop cars into ambient traffic wearing an instanced bar
// off that module (see `sirenBarAnchors` there, and sim/traffic.js), and two clocks would have the
// two blinking out of step on the same street. `game/sirenglow.js` reads it from there as well.

// The car used to appear and vanish at full opacity out past the edge of the asphalt, against
// bare background — a hard pop at both ends of every run. It now dissolves across this band,
// reaching fully invisible before it hits the turnaround, so the disappearance never lands on a
// single frame.
const FADE_BAND = 18;

// `state.s` is a world coordinate **along the corridor's own axis** — an x while the rail runs
// along X, a z while it runs along Z — so every bound on it is per-axis now that the map is not
// square. Written once here rather than at the five sites that read it: an `s` measured against
// the wrong axis puts the cruiser's turnaround, its fade and its arming line 10 units out, and
// none of the three announces itself.
const halfSpanAlong = (axis) => (axis === 'x' ? HALF_SPAN_X : HALF_SPAN_Z);
/** The line index a corridor on this axis may take: an x-running road sits on a j line. */
const topLineOn = (axis) => (axis === 'x' ? GRID_J : GRID_I);
/** ...and how many junctions it passes on the way, which is the *other* axis's count. */
const junctionsAlong = (axis) => (axis === 'x' ? GRID_I : GRID_J);

/** 1 while over the city, easing to 0 as the car runs off the slab. */
function edgeFade(s, axis) {
  const beyond = Math.abs(s) - halfSpanAlong(axis);
  if (beyond <= 0) return 1;
  return Math.max(0, 1 - beyond / FADE_BAND);
}

// Body dimensions, used three ways: policeGeometry() builds to them, the tilt lift measures the
// sagitta against them, and the wheels come out of traffic.js against them — which reproduces the
// four the cruiser used to place by hand (±0.3·LEN along, ±(WIDTH/2 − 0.02) across) while keeping
// the steering geometry identical in kind to every other car on the road.
const CAR_LEN = 3.6;
const CAR_W = 1.8;
const WHEELBASE = CAR_LEN * 0.6;

function policeGeometry() {
  const parts = [];

  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(body, color('policeBody')));

  const roof = new THREE.BoxGeometry(1.9, 0.62, 1.6);
  roof.translate(-0.2, 1.46 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(roof, color('policeRoof')));

  const stripe = new THREE.BoxGeometry(3.62, 0.3, 1.82);
  stripe.translate(0, 0.62 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(stripe, color('policeRoof')));

  // Rear pair only; the fronts steer, so they hang off the group as their own meshes.
  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The steered front pair, added to `group` and handed back so the fade can reach their material.
 *
 * The cruiser only earned these once it started chasing. On a corridor run it drives one straight
 * line end to end and is faded out before the turnaround, so its heading never changed while it
 * was on screen and the same rule would have rendered a flat 0° forever. A chase corners, weaves
 * and U-turns.
 */
function steeredWheels(group) {
  const material = propMaterial();
  const wheels = wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeometry(), material);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
      return wheel;
    });
  return { wheels, material };
}

function lightBar(shell, carrier) {
  const make = (hex, z) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.26, 0.5),
      unlitMaterial({ color: new THREE.Color(hex) }),
    );
    mesh.position.set(-0.2, 1.9 + CHASSIS_LIFT, z);
    shell.add(mesh);
    return mesh;
  };

  // Actual lights, not just glowing boxes. The bar alone is a couple of pixels; what sells a
  // siren is the colour washing across the tarmac and the fronts of nearby buildings as it goes
  // past. No shadows — these are cheap fill, and shadow-casting point lights are not.
  //
  // Hung on `carrier` rather than on the shell, and that is a **performance** decision, not a
  // cosmetic one — see the shell's own comment in `createPolice`. Three counts the lights in the
  // scene by walking the *visible* graph, so a lamp under a hidden parent is not merely dark, it
  // is absent: `numPointLights` drops to zero and every lit program in the city is rebuilt.
  const lamp = (hex, z) => {
    const light = new THREE.PointLight(new THREE.Color(hex), 0, 34, 1.7);
    light.position.set(-0.2, 2.1 + CHASSIS_LIFT, z);
    carrier.add(light);
    return light;
  };

  return {
    red: make(PALETTE.lightRed, -0.42),
    blue: make(PALETTE.sirenBlue, 0.42),
    redLamp: lamp(PALETTE.lightRed, -0.42),
    blueLamp: lamp(PALETTE.sirenBlue, 0.42),
  };
}

/**
 * @param cars  the traffic array, so the cruiser can see what is in its lane and move over for it.
 *              Optional: the probe stands police cars up in empty scenes, and a cruiser with
 *              nobody to squeeze past simply never dodges.
 * @param enlist  `traffic.enterPoliceAt`, which is how a locked-on cruiser joins traffic. Optional
 *              for the same reason `cars` is: without it a lock-on stays on the rail, heading for
 *              the taxi, and never hands off — which is all a scene with no traffic can ask of it.
 */
export function createPolice(rng, scene, cars = [], { enlist = null } = {}) {
  const group = new THREE.Group();
  /**
   * Everything the cruiser *draws*, one level in from the group that carries it.
   *
   * The car is off screen for most of a run and used to be hidden by `group.visible = false`,
   * which is the obvious way to do it and cost a stall every time the cop turned up. Three
   * collects the scene's lights with `traverseVisible`, so hiding the group took the two siren
   * lamps out of the count with it: `numPointLights` went 0 → 2 on the spawn frame, and the light
   * count is part of a material's program cache key, so **every lit material in the city relinked
   * its shader** — 22 programs on the frame the cruiser appeared and the rest on the frame it
   * left. Measured on a run at `tools/links.mjs`: 35 program links after boot, all of them the
   * static city's own materials, gone once the lamps stopped disappearing.
   *
   * So the group stays visible for the whole run and only this shell is switched. The lamps sit on
   * the group, outside it, dark at `intensity = 0` between runs — a light that is counted and
   * contributes nothing, which is exactly the trade that keeps the program set still.
   */
  const shell = new THREE.Group();
  group.add(shell);
  const body = new THREE.Mesh(policeGeometry(), propMaterial());
  body.receiveShadow = true;
  shell.add(body);
  const lights = lightBar(shell, group);
  const front = steeredWheels(shell);
  shell.visible = false;
  // Set once, at construction, rather than only where the body is posed: the corridor run writes
  // `group.rotation.y` on its own (railHeading, below) without going through a full `set`, so an
  // order left on the default there would be waiting for the first frame the chase rolled the car.
  group.rotation.order = BODY_EULER_ORDER;
  scene.add(group);

  // Every material this car owns. `propMaterial()` hands back a fresh instance per call, so
  // making these transparent affects the police car alone and not the merged prop meshes.
  // The wheels are in the list for the same reason the lamps are: leaving them opaque would fade
  // the cruiser out and leave two tyres hanging over the tarmac.
  const skin = [body.material, lights.red.material, lights.blue.material, front.material];
  for (const material of skin) material.transparent = true;

  const state = {
    active: false,
    // Live *and* far enough in to be dangerous — see BUST_ARM_INSET. main.js reads this rather
    // than `active` for the bust.
    armed: false,
    // The light bar, which is a separate question from the bust and deliberately earlier: it runs
    // for the whole of a run, from the frame the cruiser spawns off the edge of the slab. The
    // lamps still scale by `fade`, so nothing shines out of a car that has not drawn yet — but the
    // siren is up and closing for a couple of seconds before `armed` follows it. `game/sirenglow.js`
    // reads this too, so the off-screen wash and the bar are the same announcement.
    lit: false,
    fade: 0,             // the edge dissolve, published so the probe can assert against it
    axis: 'x',
    line: 0,
    dir: 1,
    s: 0,
    // The sidestep. `plan` holds the corners still to come on this run — each one a junction and
    // the direction to leave it on — and `corner` is the arc being driven, null on a straight.
    // Both are cleared by a chase: routing then belongs to turnAt(), which is a different problem.
    plan: [],
    corner: null,
    turns: 0,            // corners taken, published so the probe can assert a run actually jogs
    cooldown: rng.range(5, 12),
    // Seconds between corridor runs, as a range to draw from. Pushed in by main.js off the
    // difficulty curve — `sim/` must not import from `game/`, so the pressure arrives here the
    // same way `traffic.taxi.boost` does, rather than being read.
    //
    // The *opening* cooldown above is deliberately not on the curve: it is the beat before the
    // first siren of a run, and a run starts at the bottom of the ramp by definition.
    cooldownRange: [16, 30],
    runs: 0,
    flash: 0,
    // --- chase
    chasing: false,      // the lock-on: still on the rail, coming about and looking for a lane
    quarry: null,        // the car it locked onto, read live so a moving target still works
    // The traffic car the cruiser became at the hand-off, or null. While it is set the rail is
    // idle and the cruiser's mesh is drawn wherever the traffic model puts that car. Cleared when
    // the car leaves the road (game/pursuit.js retires it) or is wrecked.
    cop: null,
    // The lane it joined on, while the corridor is still being held down it — see `handOff`.
    graceLane: null,
    v: SPEED,
    elapsed: 0,
    uturn: null,         // 0..1 while swinging round, null otherwise
    uturnYaw0: 0,
    dodge: 0,            // world units moved toward the centreline to pass a yielding car
    dodgeRate: 0,        // units/s of that, which is what tilts the nose into the swerve
    // Front-wheel lock, and the pose it is differenced from. Same rule as every other car, run
    // over the *drawn* position rather than the rail: the rail turns its corners square, and the
    // arc the player sees is the eased one.
    wheelAngle: 0,
    prevYaw: 0,
    prevX: 0,
    prevZ: 0,
    yaw: 0,              // eased heading while chasing; the corridor run takes railYaw() directly
    yawRate: 0,          // rad/s, read for the roll and by main.js to decide when it is laying rubber
    travelled: 0,        // distance driven since lock-on; paces the rubber and the dust
    // Body. Only ever non-zero during a chase — the corridor run is a car driving in a straight
    // line and has nothing to lean into.
    pitch: 0,
    pitchV: 0,
    prevV: SPEED,
    roll: 0,
    wheelieT: null,
  };

  /**
   * Is the lane leaving (i, j) in direction `d` dug up? A roadworks zone closes both lanes of one
   * segment for as long as it stands, and the cruiser has no more business driving through the
   * cones and the hole than an ambient car does.
   *
   * Soft closure, so it is a lane id rather than grid geometry — see the roadworks notes in
   * traffic.js for why the network is never re-baked mid-run.
   */
  const exitDug = (d, i, j) => {
    const lane = cityNetwork().laneOutByGrid(d, i, j);
    return Boolean(lane) && isLaneClosed(lane.id);
  };

  /**
   * A park district builds over the road that used to run between its two blocks, and a roadworks
   * zone digs a hole in one. The police car drives a whole line end to end, so a corridor down a
   * line with either on it sends the cruiser straight through the trees or the barricades.
   *
   * Both are checked here because both are permanent for the length of a run: a park closure is
   * baked into the network, and a zone stands for the best part of a minute — far longer than the
   * ~8s a corridor takes to cross the map. What this cannot catch is a zone rising *during* a run
   * already under way, which is why roadwork.js declines to place one on a live siren's road.
   */
  /** One segment out of (i, j) along d: on the map, not built over by a park, not dug up. */
  const hopClear = (d, i, j) => Boolean(nextIntersection(d, i, j))
    && !isSegmentClosed(i, j, d) && !exitDug(d, i, j);

  /** ...and every segment from (i, j) along d to the edge of the map. */
  const runClear = (d, i, j) => {
    let at = { i, j };
    for (let next = nextIntersection(d, at.i, at.j); next; next = nextIntersection(d, at.i, at.j)) {
      if (!hopClear(d, at.i, at.j)) return false;
      at = next;
    }
    return true;
  };

  /**
   * The two corners of a one-block sidestep, or null if there is nowhere to put one.
   *
   * Both are at the same junction index along the run: turn off at `k`, cross the one block to the
   * neighbouring road, turn straight back onto the original heading. So the run still enters at one
   * edge of the map and leaves by the opposite one — the only thing that moves is which road it
   * spends its second half on.
   *
   * `k` keeps a block of straight either side. At the ends of the range the first corner is either
   * off the slab or on the last junction of the map, and a run that turns as it arrives or as it
   * leaves reads as a spawn pointed crooked rather than as a car taking a detour.
   *
   * Everything the jog will drive is checked here, once, against the same two closures
   * `lineIsClear` tests — a park district and a roadworks zone (which is also how the drawbridge
   * announces itself: it shuts its two lanes through the same set). It has to be up front. The
   * corridor is what clears the road ahead of a car with no collision response at all, and a
   * corner it discovers mid-run is a corner with a green it has not paid for.
   */
  const planJog = (axis, line, dir) => {
    const count = junctionsAlong(axis);
    const lo = 1;
    const hi = count - 1;
    if (hi < lo) return null;
    const hands = rng.chance(0.5) ? [1, -1] : [-1, 1];
    const first = rng.int(lo, hi);
    for (let n = 0; n <= hi - lo; n++) {
      const k = lo + ((first - lo + n) % (hi - lo + 1));
      for (const hand of hands) {
        const toLine = line + hand;
        if (toLine < 0 || toLine > topLineOn(axis)) continue;
        // `line` names a j while the run is along X and an i while it is along Z, so the road it
        // steps across is the *other* axis's, and the junction it steps from is (k, line) read the
        // same way round.
        const cross = axis === 'x'
          ? (hand > 0 ? DIR.PZ : DIR.NZ)
          : (hand > 0 ? DIR.PX : DIR.NX);
        const back = axis === 'x'
          ? (dir > 0 ? DIR.PX : DIR.NX)
          : (dir > 0 ? DIR.PZ : DIR.NZ);
        const at = (l, m) => (axis === 'x' ? { i: m, j: l } : { i: l, j: m });
        const off = at(line, k);
        const on = at(toLine, k);
        if (!hopClear(cross, off.i, off.j)) continue;
        if (!runClear(back, on.i, on.j)) continue;
        return [{ ...off, dOut: cross }, { ...on, dOut: back }];
      }
    }
    return null;
  };

  const lineIsClear = (axis, line) => {
    for (let k = 0; k < junctionsAlong(axis); k++) {
      const closed = axis === 'x' ? isSegmentClosed(k, line, 0) : isSegmentClosed(line, k, 1);
      if (closed) return false;
      const d = axis === 'x' ? DIR.PX : DIR.PZ;
      if (axis === 'x' ? exitDug(d, k, line) : exitDug(d, line, k)) return false;
    }
    return true;
  };

  /**
   * Publish every road this run will use: the leg it is on, then whatever the plan has left.
   *
   * Not the same list as the priority corridor, which is one road because it is one set of lights
   * and holding two would stop the cross traffic on a road the cruiser has not reached. This one
   * is read by the systems that *close* a road — roadworks and the drawbridge — and they have to
   * know about a corner before it is taken, not as it is.
   */
  function publishRoads() {
    setPoliceRoads([
      { axis: state.axis, line: state.line },
      ...state.plan.map(({ i, j, dOut }) => (isXAxis(dOut)
        ? { axis: 'x', line: j }
        : { axis: 'z', line: i })),
    ]);
  }

  function start() {
    let axis = null;
    let line = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tryAxis = rng.chance(0.5) ? 'x' : 'z';
      const tryLine = rng.int(0, topLineOn(tryAxis));
      if (lineIsClear(tryAxis, tryLine)) { axis = tryAxis; line = tryLine; break; }
    }
    if (axis === null) { state.cooldown = 6; return; }   // nothing clear right now; try later

    state.axis = axis;
    state.line = line;
    state.dir = rng.chance(0.5) ? 1 : -1;
    const half = halfSpanAlong(axis);
    state.s = state.dir > 0 ? -half - RUN_MARGIN : half + RUN_MARGIN;
    state.dodge = 0;
    state.dodgeRate = 0;
    state.corner = null;
    // Drawn whether or not the jog is wanted, so switching JOG_CHANCE moves how often a run bends
    // and not which roads every later run picks.
    const jogging = rng.chance(JOG_CHANCE);
    state.plan = (jogging && planJog(axis, line, state.dir)) || [];
    if (state.plan.length) state.plan[0].at = cornerStart(state.plan[0]);
    state.active = true;
    state.lit = true;      // siren from the spawn frame; the bust waits for BUST_ARM_INSET
    state.runs += 1;
    shell.visible = true;
    place();   // otherwise it is drawn at last run's position for one frame
    // A new run starts somewhere else entirely, facing somewhere else. Re-baseline the steering
    // difference against that pose so the jump across the map isn't read as a manoeuvre, and
    // start the run with the wheels straight.
    state.wheelAngle = 0;
    front.wheels.forEach((wheel) => { wheel.rotation.y = 0; });
    state.prevYaw = group.rotation.y;
    state.prevX = group.position.x;
    state.prevZ = group.position.z;
    setPriorityCorridor({ axis: state.axis, line: state.line });
    publishRoads();
  }

  /**
   * Where the rail puts the car this frame. Right-hand traffic: the lane sits one lane offset off
   * the road centreline, on the right of travel — read off the corridor's own road rather than
   * taken as LANE, so the cruiser lines up with ambient cars on a divided arterial too (matches
   * laneOffsetCoord() in grid.js). `sign` folds the two axes' opposite conventions into
   * one, so the weave and the U-turn's road crossing are written once.
   *
   * Mid-U-turn the lane term sweeps from −1 to +1 of itself, which is exactly the two lanes of
   * the road: it ends up in the opposing lane, facing back the way it came.
   */
  function railPoint() {
    const c = state.axis === 'x' ? lineZ(state.line) : lineX(state.line);
    const sign = state.axis === 'x' ? state.dir : -state.dir;
    const lane = state.uturn === null ? 1 : smoothstep(state.uturn) * 2 - 1;
    // The dodge comes off the lane term rather than being added to the weave, so it is measured
    // from the lane centre and cannot compound with a weave already leaning that way. Suppressed
    // mid-U-turn, where the lane term is sweeping across the whole road and "toward the
    // centreline" is not a fixed direction.
    const dodge = state.uturn === null ? state.dodge : 0;
    const off = state.axis === 'x' ? laneOffX(state.line) : laneOffZ(state.line);
    const perp = c + sign * (off * lane - dodge);
    return state.axis === 'x' ? { x: state.s, z: perp } : { x: perp, z: state.s };
  }

  const railYaw = () => (state.axis === 'x'
    ? (state.dir > 0 ? 0 : Math.PI)
    : (state.dir > 0 ? -Math.PI / 2 : Math.PI / 2));

  /**
   * Where the nose points on the corridor run: down the rail, plus whatever the dodge is adding
   * sideways. Composed out of the velocity rather than added to `railYaw` as an offset, because
   * the sign of "toward the centreline" flips with both the axis and the direction and getting it
   * from atan2 costs nothing. With no dodge running it reduces exactly to railYaw().
   *
   * The chase does not come through here — it takes its heading from the eased drawn position,
   * which already contains the dodge because the dodge is in the rail.
   */
  function railHeading() {
    if (state.uturn !== null || Math.abs(state.dodgeRate) < 1e-6) return railYaw();
    const sign = state.axis === 'x' ? state.dir : -state.dir;
    const fwd = state.dir * SPEED;
    const perp = -sign * state.dodgeRate;     // + dodge moves toward the centreline
    const vx = state.axis === 'x' ? fwd : perp;
    const vz = state.axis === 'x' ? perp : fwd;
    return Math.atan2(-vz, vx);               // forward for yaw θ is (cos θ, −sin θ)
  }

  /**
   * Move over for a car in its own lane, or drift back to the lane centre once past it. Sized and
   * argued at DODGE_LATERAL; the other half of the manoeuvre is the yielding car's, in traffic.js.
   */
  function stepDodge(dt) {
    const ahead = sirenLaneAhead(cars, {
      axis: state.axis, line: state.line, dir: state.dir, s: state.s,
    });
    // Not mid-corner, for the same reason as mid-U-turn: the manoeuvre is a *lane* offset, and
    // inside a junction box there is no lane to be beside. What is suppressed is it *growing* —
    // the offset already on the car keeps being applied and keeps decaying, so the arc is joined
    // with no step at either end. Coming off it on the approach instead was tried and is worse:
    // straightening up 12 units out leaves the cruiser square in its lane for the last half second
    // before a junction, which is exactly where the queue it was squeezing past is standing. Same
    // seeds and same draws, one constant apart: 27 frames inside a driving body against 14.
    // Nor through a lock-on, which is on its way to becoming a car in a lane: the hand-off waits
    // for the cruiser to be back on the lane centre, and a dodge still growing would hold it off.
    // Cars in its lane are still pulling over for it meanwhile (the presence is still published).
    const want = state.uturn === null && state.corner === null && !state.chasing
      && ahead < DODGE_LOOK ? DODGE_LATERAL : 0;
    const prev = state.dodge;
    state.dodge += (want - state.dodge) * Math.min(1, dt * DODGE_EASE);
    state.dodgeRate = dt > 1e-6 ? (state.dodge - prev) / dt : 0;
  }

  /**
   * Write a pose to the mesh. Split out of `place()` because the corner arc needs the same
   * treatment and gets its position from somewhere else entirely.
   *
   * The height is the bridge. The corridor runs a whole line end to end and **every** road running
   * along Z crosses the river, so without this the cruiser drives through an arched deck on any run
   * that picks one — and declining the crossing lines is not an option when they all cross.
   */
  function poseAt(x, z, yaw) {
    group.position.set(x, ROAD_Y + deckHeightAt(x, z).y, z);
    group.rotation.y = yaw;
  }

  function place() {
    const p = railPoint();
    poseAt(p.x, p.z, railHeading());
  }

  // --- The jog's corners ------------------------------------------------------
  //
  // A corridor corner is driven, not snapped. The chase turns its rail square and lets
  // CHASE_SMOOTH bend the drawn car round it, which works because a chase is meant to look like a
  // car being thrown at a corner; at corridor speed the same trick leaves the cruiser cutting
  // across the junction on a lag it never recovers. So the two corners of a jog are the exact
  // quadratic Bezier every ambient car turns on — entryPoint to exitPoint about turnControl — and
  // the arc joins the two straights with no discontinuity in either position or heading, because
  // its ends *are* the two lane centrelines the rail already sits on.

  /** Where on the current leg the corner at this junction begins: its entry into the box. */
  const cornerStart = ({ i, j }) => {
    const e = entryPoint(railDir(), i, j);
    return state.axis === 'x' ? e.x : e.z;
  };

  /**
   * A point on the arc, dodge and all — which is to say the point the car is actually drawn at.
   *
   * The dodge means one thing everywhere, which is what lets it survive a corner that has no axis
   * of its own: right-hand traffic puts the centreline on the driver's left, and left of a heading
   * is (-sin yaw, -cos yaw). On a straight that reduces exactly to the `- dodge` term in
   * railPoint(), so the offset is continuous into the arc and out of it.
   */
  function arcPoint(arc, t) {
    const p = bezierAt(arc.e, arc.c, arc.x, t);
    const v = bezierTangent(arc.e, arc.c, arc.x, t);
    const yaw = Math.atan2(-v.z, v.x);
    return { x: p.x - Math.sin(yaw) * state.dodge, z: p.z - Math.cos(yaw) * state.dodge, yaw };
  }

  /**
   * How much further the drawn car travels than the arc underneath it, here.
   *
   * An offset curve is not the same length as the curve it is offset from — it is `1 - w·k` of it,
   * for an offset `w` and a curvature `k`. That is a rounding error on a straight and is not one
   * here: a **right** turn's arc is 3.25 units long, its two Bezier legs being `reach - laneOff`
   * apart where a left turn's are `reach + laneOff`, so 0.9 of dodge still on the car is an
   * appreciable fraction of the radius it is turning on. Paced off the arc, the cruiser covered
   * 0.54 units in a frame — 32 units/s of ground, against the 0.32 and 19 the rail can produce.
   *
   * Taken as a finite difference rather than as a curvature, because the offset point is already
   * written and its derivative is not.
   */
  function arcScale(arc, driven) {
    if (state.dodge < 1e-6) return 1;
    const lo = Math.max(0, driven - ARC_PROBE);
    const hi = Math.min(arc.len, driven + ARC_PROBE);
    if (hi - lo < 1e-6) return 1;
    const a = arcPoint(arc, arcT(arc, lo));
    const b = arcPoint(arc, arcT(arc, hi));
    return Math.hypot(b.x - a.x, b.z - a.z) / (hi - lo);
  }

  function poseOnArc() {
    const p = arcPoint(state.corner, state.corner.t);
    poseAt(p.x, p.z, p.yaw);
  }

  /**
   * Drive `dist` further round the corner, and back onto the rail if that runs out of arc.
   *
   * The leftover is carried through rather than dropped: at 19 units/s a discarded remainder costs
   * up to a third of a unit of travel at every corner, which is the same book-keeping the chase
   * does at turnAt().
   */
  /** The curve parameter `dist` units along the arc, off the chord table `beginTurn` built. */
  const arcT = ({ cum }, dist) => {
    let n = 1;
    while (n < ARC_CHORDS && cum[n] < dist) n += 1;
    const span = cum[n] - cum[n - 1];
    return (n - 1 + (span > 1e-9 ? (dist - cum[n - 1]) / span : 0)) / ARC_CHORDS;
  };

  function advanceCorner(dist) {
    const arc = state.corner;
    // `dist` is ground the car covers; what advances is the arc underneath it.
    const rail = dist / arcScale(arc, arc.driven);
    const remain = arc.len - arc.driven;
    if (rail < remain) {
      arc.driven += rail;
      arc.t = arcT(arc, arc.driven);
      poseOnArc();
      return;
    }
    state.corner = null;
    state.s = arc.out + state.dir * (rail - remain);
    place();
  }

  /**
   * Start the corner at (i, j) leaving on `dOut`, carrying `over` units of this frame's step into
   * it.
   *
   * The rail commits to the new leg **here**, at the mouth of the junction, rather than at the far
   * end of the arc. Both of the things that keep the cruiser from driving through anybody are
   * published off that leg — the corridor turns the lights on the road it is entering, and
   * `setPolicePresence` is what the cars on it read to pull over — and neither is worth anything
   * arriving half a second after the car does.
   */
  function beginTurn({ i, j, dOut }, over) {
    const dIn = railDir();
    const e = entryPoint(dIn, i, j);
    const c = turnControl(dIn, dOut, i, j);
    const x = exitPoint(dOut, i, j);
    const cum = [0];
    let prev = e;
    for (let n = 1; n <= ARC_CHORDS; n++) {
      const q = bezierAt(e, c, x, n / ARC_CHORDS);
      cum.push(cum[n - 1] + Math.hypot(q.x - prev.x, q.z - prev.z));
      prev = q;
    }
    state.corner = {
      e, c, x, cum, len: cum[ARC_CHORDS], out: isXAxis(dOut) ? x.x : x.z, driven: 0, t: 0,
    };
    state.axis = isXAxis(dOut) ? 'x' : 'z';
    state.dir = dirSign(dOut);
    state.line = isXAxis(dOut) ? j : i;
    state.turns += 1;
    setPriorityCorridor({ axis: state.axis, line: state.line });
    publishRoads();
    advanceCorner(over);
    // The next corner is measured along the leg this one just committed to, so it cannot be
    // worked out until the commit above has happened.
    if (state.plan.length) state.plan[0].at = cornerStart(state.plan[0]);
  }

  function stop() {
    state.corner = null;
    state.plan.length = 0;
    state.chasing = false;
    state.quarry = null;
    state.cop = null;
    state.graceLane = null;
    lights.redLamp.intensity = 0;
    lights.blueLamp.intensity = 0;
    state.active = false;
    state.armed = false;
    state.lit = false;
    shell.visible = false;
    setPriorityCorridor(null);
    setPolicePresence(null);
    setPoliceRoads([]);
    state.cooldown = rng.range(state.cooldownRange[0], state.cooldownRange[1]);
  }

  // --- Chase ----------------------------------------------------------------

  // Where the car is actually drawn, easing toward the rail. See CHASE_SMOOTH.
  const drawn = { x: 0, z: 0 };

  const railDir = () => (state.axis === 'x'
    ? (state.dir > 0 ? DIR.PX : DIR.NX)
    : (state.dir > 0 ? DIR.PZ : DIR.NZ));

  /** Coordinates of the quarry split into "along this rail" and "across it". */
  function quarryOnRail() {
    const q = state.quarry;
    return state.axis === 'x'
      ? { along: q.x, across: q.z - lineZ(state.line) }
      : { along: q.z, across: q.x - lineX(state.line) };
  }

  /** The junction it is heading toward along its own axis, clamped onto the grid. */
  function junctionAhead() {
    const u = (state.s + halfSpanAlong(state.axis)) / PITCH;
    const raw = state.dir > 0 ? Math.ceil(u - 1e-4) : Math.floor(u + 1e-4);
    const k = Math.max(0, Math.min(junctionsAlong(state.axis), raw));
    return state.axis === 'x' ? { i: k, j: state.line } : { i: state.line, j: k };
  }

  /**
   * Pick the exit at (i, j) and snap the rail onto it. Greedy Manhattan, scored on where each
   * road *goes* — the distance from the far end of the segment to the quarry — rather than on
   * which way the bonnet ends up pointing, so it commits to a road that closes the gap instead of
   * turning toward a target it cannot reach that way. `legalExits` already drops U-turns, park
   * closures and the map edge, so the routing inherits the park fix for free.
   *
   * Roadworks are not in `legalExits` and cannot be — that closure is soft, lives in a lane id set
   * and changes mid-run — so they are filtered here, in a first pass. Only a first pass: a chase
   * that finds every exit dug up drives through the cones rather than turning back, because a
   * cruiser that gave up on the bust to respect a traffic cone is a worse outcome than a cruiser
   * that ignores one.
   *
   * Straight carries a small bonus. Without it two equal-cost exits alternate at every junction
   * and the chase visibly dithers down a road it should just be driving down.
   */
  function turnAt(i, j) {
    const dIn = railDir();
    const all = legalExits(dIn, i, j);
    const clear = all.filter((d) => !exitDug(d, i, j));
    const exits = clear.length ? clear : all;
    let best = opposite(dIn);     // dead end (every exit closed): back the way it came
    let bestScore = Infinity;
    for (const d of exits) {
      const n = nextIntersection(d, i, j);
      if (!n) continue;
      const score = Math.hypot(lineX(n.i) - state.quarry.x, lineZ(n.j) - state.quarry.z)
        - (d === dIn ? 0.6 : 0);
      if (score < bestScore) { bestScore = score; best = d; }
    }

    state.axis = isXAxis(best) ? 'x' : 'z';
    state.dir = dirSign(best);
    state.line = isXAxis(best) ? j : i;
    state.s = isXAxis(best) ? lineX(i) : lineZ(j);
    setPriorityCorridor({ axis: state.axis, line: state.line });
    publishRoads();
  }

  /**
   * Give up the corridor run and come after this car. Called from main.js when the taxi boosts
   * within a block of an armed run. This is the lock-on; `handOff` below is where it ends.
   */
  function chase(quarry) {
    if (!state.active || state.chasing || state.cop) return;
    // Whatever the run was going to do with itself stops mattering the moment it has a quarry.
    // Dropping a corner mid-arc is safe because the rail underneath it is already the outgoing
    // leg — the chase picks that leg up and eases the drawn car onto it, which is what it does at
    // every corner of its own anyway.
    state.corner = null;
    state.plan.length = 0;
    state.chasing = true;
    state.quarry = quarry;
    state.elapsed = 0;
    state.travelled = 0;
    state.yawRate = 0;
    state.pitch = 0;
    state.pitchV = 0;
    state.roll = 0;
    drawn.x = group.position.x;
    drawn.z = group.position.z;
    state.yaw = group.rotation.y;

    // It plants the throttle the instant it decides — the cruiser's version of BOOST_KICK. The
    // step in v goes through the pitch spring as a one-frame acceleration spike, so the squat is
    // the same impulse the taxi gets off the line, and the wheelie rides on top of it.
    state.v = SPEED * CHASE_KICK;
    state.prevV = SPEED;
    state.wheelieT = 0;

    // Quarry already behind it: swing round on the spot rather than driving on to the next
    // junction and taking three sides of a block to come back. This is the beat that sells the
    // lock-on, so it is worth the special case.
    if (state.dir * (quarryOnRail().along - state.s) < -UTURN_BEHIND) {
      // Taken off the drawn nose rather than railYaw(), so the sweep starts from where the car is
      // actually pointing. On a straight the two agree to within the dodge's tilt; coming out of a
      // jog corner they need not, and the sweep is assigned raw.
      state.uturnYaw0 = group.rotation.y;
      state.uturn = 0;
      state.dir = -state.dir;
    }
    setPriorityCorridor({ axis: state.axis, line: state.line });
    publishRoads();
  }

  /**
   * Join traffic here, if here will do. Answers whether it did.
   *
   * Every clause is a way the frame it happens on could show. The rail and the lane have to agree
   * on where the car is (the drawn car caught up with its ease, nose on the rail's heading, no U-turn
   * or wheelie mid-flight, no dodge left on it — the traffic car is drawn on its lane centre with a
   * level body from the next frame on). The lane has to take it (open, and the car short of its
   * hold line by HANDOFF_LINE, because a car released past its line runs the light). And nobody
   * else can already be there (HANDOFF_AHEAD/BEHIND), including a car turning into the lane —
   * traffic cars are never tested against each other, so a cop dropped inside one stays inside it.
   *
   * The corridor is **not** dropped here. It is held down the lane the cop joined on until the cop
   * is off it (`graceLane`), so the junction the rail was promised stays green for the car that
   * inherits the promise, and the lights go back to their cycle only once nobody is relying on them.
   */
  function handOff(dt) {
    if (!enlist || state.uturn !== null || state.wheelieT !== null) return false;
    if (Math.abs(state.roll) > 0.06 || Math.abs(state.dodge) > 0.15) return false;
    // Sideways only. Along the road the drawn car always trails the rail — the ease settles at
    // v / CHASE_SMOOTH, 1.8 units at lock-on speed — so the car joins where it is *drawn*, and the
    // rail's own `s` is a couple of units ahead of anything on screen.
    const p = railPoint();
    const across = state.axis === 'x' ? p.z - drawn.z : p.x - drawn.x;
    if (Math.abs(across) > HANDOFF_SNAP) return false;
    const want = railYaw();
    if (Math.abs(Math.atan2(Math.sin(want - state.yaw), Math.cos(want - state.yaw))) > HANDOFF_YAW) {
      return false;
    }
    const d = railDir();
    const { i, j } = junctionAhead();
    const lane = cityNetwork().laneByGrid(d, i, j);
    if (!lane || lane.degenerate || isLaneClosed(lane.id)) return false;
    const end = lane.path.at(lane.length);
    // ...less one frame of travel, because the traffic model moves the car again this frame, after
    // this: joined where it is drawn, it would cover two frames' worth of road on the frame it
    // joined (0.72 units, measured) and read as a skip.
    const at = state.axis === 'x' ? drawn.x : drawn.z;
    const back = state.dir * ((state.axis === 'x' ? end.x : end.z) - at) + state.v * dt;
    if (back > lane.length - 0.5 || back < STOP_SETBACK + HANDOFF_LINE) return false;
    const s = lane.length - back;
    for (const car of cars) {
      if (car.crashed || car.staged) continue;
      if (car.lane === lane && car.s > s - HANDOFF_BEHIND && car.s < s + HANDOFF_AHEAD) return false;
      if (car.state === 'turn' && car.turn?.outLane === lane.id && s < HANDOFF_AHEAD) return false;
    }

    const cop = enlist({ d, i, j, back, v: state.v });
    if (!cop) return false;
    // Whose cop this is. A robbery's stand-down walks every car in `policeCars`, and this one is
    // game/pursuit.js's to retire, not the robbery's.
    cop.patrol = true;
    state.chasing = false;
    state.armed = false;
    state.lit = true;
    state.cop = cop;
    state.graceLane = lane;
    state.yawRate = 0;
    state.pitch = 0;
    state.pitchV = 0;
    state.roll = 0;
    for (const material of skin) material.opacity = 1;
    // From here the cruiser is drawn wherever the traffic model puts this car — see `car.skin` in
    // sim/traffic.js. The front wheels come with it: the traffic model steers them already.
    cop.skin = (pos, quat, car) => {
      group.position.copy(pos);
      group.quaternion.copy(quat);
      front.wheels.forEach((wheel) => { wheel.rotation.y = car.wheelAngle; });
    };
    // Nothing on the rail to be out of the way of any more: the cop clears its own lane now, with
    // the same scatter a robbery's cops use. And a road the rail no longer drives is not a road
    // roadworks or the drawbridge need to hold off for.
    setPolicePresence(null);
    setPoliceRoads([]);
    return true;
  }

  function driveChase(dt) {
    state.elapsed += dt;

    if (state.uturn !== null) {
      state.uturn = Math.min(1, state.uturn + dt / UTURN_DUR);
      // Hard on the brakes into the swing, hard on the throttle out of it.
      state.v = state.uturn < 0.5
        ? Math.max(UTURN_SPEED, state.v - UTURN_BRAKE * dt)
        : Math.min(LOCK_SPEED, state.v + CHASE_ACCEL * dt);
      if (state.uturn >= 1) state.uturn = null;
    } else {
      // The kick is a step *above* cop cruise, so it can be seen; it bleeds back down to it rather
      // than holding, because the traffic car it hands off to cannot go any faster.
      state.v = state.v > LOCK_SPEED
        ? Math.max(LOCK_SPEED, state.v - LOCK_SETTLE * dt)
        : Math.min(LOCK_SPEED, state.v + CHASE_ACCEL * dt);
    }

    const target = junctionAhead();
    const c = state.axis === 'x' ? lineX(target.i) : lineZ(target.j);
    state.s += state.dir * state.v * dt;
    if (state.dir > 0 ? state.s >= c : state.s <= c) {
      // Carry the overshoot through the corner. Dropping it stalls the car by up to a frame of
      // travel (0.43 units at chase speed) at every junction.
      const over = Math.abs(state.s - c);
      turnAt(target.i, target.j);
      state.s += state.dir * over;
    }

    // No Loco Mode weave, which the rail chase used to drive: the car this hands off to drives its
    // lane centre, and a weave still running on the frame it joins is a sideways jump.

    // Ease the drawn car toward the rail: this is what arcs the square corners, and it damps the
    // U-turn's lane flip into a swing instead of a jump.
    const p = railPoint();
    const k = 1 - Math.exp(-dt * CHASE_SMOOTH);
    let stepX = (p.x - drawn.x) * k;
    let stepZ = (p.z - drawn.z) * k;
    // Cap the ease at a speed a car could plausibly be doing. The rail turns corners square, so
    // the frame it snaps the drawn car is chasing a target that jumped ~4.5 units sideways: it
    // covered 0.83 in one frame, 50 units/s, and the apex of every corner read as a skip. Bound
    // it and the same corner comes out as a slightly wider arc taken flat out.
    const step = Math.hypot(stepX, stepZ);
    const cap = LOCK_TOP * 1.2 * dt;
    if (step > cap) { stepX *= cap / step; stepZ *= cap / step; }
    drawn.x += stepX;
    drawn.z += stepZ;
    state.travelled += Math.abs(state.v) * dt;

    const wasYaw = state.yaw;
    if (state.uturn !== null) {
      // Left-hand swing. dirYaw runs anticlockwise-positive, so a left turn is always +yaw and a
      // U-turn is +π from wherever it started — no shortest-arc case to get wrong.
      state.yaw = state.uturnYaw0 + Math.PI * smoothstep(state.uturn);
    } else {
      // Heading comes from the rail, not from the smoothed step. Reading it off the actual motion
      // was the obvious thing and it was wrong: for the frame after a corner snap the rail can sit
      // *behind* the drawn car, the step points back down the road, and the nose flicks through
      // 160° (22°/frame, on seeds where the chase turns onto a road it has already overrun).
      const want = railYaw();
      // Eased, so the 90° the rail turns instantly becomes a nose coming round over ~0.35s while
      // the body swings through the apex on its own smoothing. Assigned raw, the car pivoted.
      const shortest = Math.atan2(Math.sin(want - state.yaw), Math.cos(want - state.yaw));
      state.yaw += shortest * Math.min(1, dt / YAW_EASE);
    }
    const turned = Math.atan2(Math.sin(state.yaw - wasYaw), Math.cos(state.yaw - wasYaw));
    state.yawRate = dt > 1e-6 ? turned / dt : 0;
    bodyStep(dt);
  }

  /** Roll, pitch and the tilt lift, applied to the mesh, off the drawn position of the lock-on. */
  function bodyStep(dt) {
    // Lean *outward*, away from the turn centre, because that is what weight transfer does —
    // leaning inward reads as a motorbike. Eased so the body loads up over a beat instead of
    // snapping over the moment the nose starts to move.
    const wantRoll = Math.max(-ROLL_LIMIT, Math.min(ROLL_LIMIT,
      state.yawRate * state.v * ROLL_GAIN));
    state.roll += (wantRoll - state.roll) * Math.min(1, dt / ROLL_EASE);

    // Pitch spring, driven by longitudinal acceleration. The kick on lock-on, the dive into the
    // U-turn and the stand-on-the-brakes arrival all arrive here as Δv and come out as the body
    // rocking on its suspension.
    const accel = dt > 1e-6 ? (state.v - state.prevV) / dt : 0;
    state.prevV = state.v;
    const targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, accel * PITCH_GAIN));
    state.pitchV += ((targetPitch - state.pitch) * 60 - state.pitchV * 6) * dt;
    state.pitch += state.pitchV * dt;

    let shownPitch = state.pitch;
    if (state.wheelieT !== null) {
      state.wheelieT += dt;
      if (state.wheelieT >= WHEELIE_DUR) state.wheelieT = null;
      else shownPitch += locoWheelie(state.wheelieT);
    }

    // Both tilts pivot on the car's origin at road level, so either one on its own drives an edge
    // under the tarmac. Lifting by the sagitta of each keeps the low corner on the road — same
    // correction the ambient cars get, with this body's dimensions.
    // The chase's own pass over a bridge, sampled at nose and tail for the reason the ambient
    // cars are (see the pose step in sim/traffic.js): a rigid body pitched to the tangent under its
    // own origin floats at the crest and buries its nose at the foot.
    const ahead = CAR_LEN / 2;
    const nose = deckHeightAt(drawn.x + Math.cos(state.yaw) * ahead, drawn.z - Math.sin(state.yaw) * ahead);
    const tail = deckHeightAt(drawn.x - Math.cos(state.yaw) * ahead, drawn.z + Math.sin(state.yaw) * ahead);
    const deckY = (nose.y + tail.y) / 2;
    shownPitch += Math.atan2(nose.y - tail.y, 2 * ahead);

    const lift = Math.abs(Math.sin(state.roll)) * (CAR_W / 2)
      + Math.abs(Math.sin(shownPitch)) * (CAR_LEN / 2);
    group.position.set(drawn.x, ROAD_Y + lift + deckY, drawn.z);
    // 'YXZ', not the default — see the note by the ambient euler in sim/traffic.js. The default
    // 'XYZ' rolls about the world X axis, so a cruiser chasing north or south would show no lean
    // at all and one heading west would lean into its corners instead of out of them.
    group.rotation.set(state.roll, state.yaw, shownPitch, BODY_EULER_ORDER);
  }

  function siren(fade) {
    // Dark only between runs. The bar announces the cruiser rather than gating it: it comes up as
    // the car spawns, a good two seconds before the bust arms (see BUST_ARM_INSET), and stays up
    // until the run ends. `fade` carries the near-edge frames on its own, so the announcement
    // arrives exactly as the body does.
    if (!state.lit) {
      lights.red.visible = false;
      lights.blue.visible = false;
      lights.redLamp.intensity = 0;
      lights.blueLamp.intensity = 0;
      return;
    }

    const hunting = state.chasing || state.cop?.chase > 0;
    const on = sirenOn(state.flash, hunting);
    lights.red.visible = on;
    lights.blue.visible = !on;
    // Never fully dark on either side — a hard on/off strobe reads as flicker rather than a
    // siren, so the off colour keeps a low glow.
    const peak = hunting ? 130 : 90;
    lights.redLamp.intensity = (on ? peak : 14) * fade;
    lights.blueLamp.intensity = (on ? 14 : peak) * fade;
  }

  function update(dt) {
    state.flash += dt;

    // In traffic. The rail is idle and the traffic model drives the car (and poses the mesh, through
    // `cop.skin`); what is left here is the corridor's grace, the bar, and noticing the car is gone.
    if (state.cop) {
      const cop = state.cop;
      // Off the road — retired by game/pursuit.js once it has driven off — or wrecked. A wreck's
      // shell is the traffic model's to draw (its effects take it from the instance), so the
      // cruiser's own mesh goes with it rather than standing over the fire.
      if (!cop.police || cop.crashed) {
        cop.skin = null;
        stop();
        return;
      }
      if (state.graceLane && (cop.lane !== state.graceLane || cop.state !== 'drive')) {
        setPriorityCorridor(null);
        state.graceLane = null;
      }
      // Never armed again: whether this car has caught you is game/pursuit.js's question now, and
      // it is a different one from "did you boost in front of it".
      state.armed = false;
      state.lit = cop.siren;
      state.fade = 1;
      siren(1);
      return;
    }

    if (!state.active) {
      state.cooldown -= dt;
      if (state.cooldown <= 0) start();
      return;
    }

    // Both branches want this: it feeds the rail. A lock-on only ever lets it decay (see stepDodge).
    stepDodge(dt);

    if (state.chasing) {
      driveChase(dt);
      if (handOff(dt)) {
        siren(1);
        return;
      }
    } else if (state.corner) {
      advanceCorner(SPEED * dt);
    } else {
      state.s += state.dir * SPEED * dt;
      const turn = state.plan[0];
      if (turn && state.dir * (state.s - turn.at) >= 0) {
        state.plan.shift();
        beginTurn(turn, Math.abs(state.s - turn.at));
      } else {
        const half = halfSpanAlong(state.axis);
        const past = state.dir > 0
          ? state.s > half + RUN_MARGIN
          : state.s < -half - RUN_MARGIN;
        if (past) { stop(); return; }
        place();
      }
    }

    // A lock-on is already past the moment it was armed for, and it can be routed anywhere on the
    // map — including back out through the outer band — so it stays armed rather than re-testing
    // `s` and disarming mid-pursuit. It goes dark only once it has handed off (above).
    state.armed = state.chasing
      || Math.abs(state.s) <= halfSpanAlong(state.axis) - BUST_ARM_INSET;

    // --- Front wheels, off the pose that was just written.
    //
    // Taken here rather than inside either branch so the corridor run and the chase go through
    // one path: the corridor run is dead straight and comes out at a flat 0°, and everything the
    // chase does — the eased 90° at a junction, the weave, the U-turn — falls out of the same
    // difference. Distance is measured on the drawn position, which is the arc the player sees;
    // `state.s` is the rail's, and the rail turns its corners square.
    const ds = Math.hypot(group.position.x - state.prevX, group.position.z - state.prevZ);
    state.wheelAngle = steerToward(
      state.wheelAngle, group.rotation.y, state.prevYaw, ds, WHEELBASE,
    );
    state.prevYaw = group.rotation.y;
    state.prevX = group.position.x;
    state.prevZ = group.position.z;
    front.wheels.forEach((wheel) => { wheel.rotation.y = state.wheelAngle; });

    // Ambient traffic on this road reads the siren's `s` from here and reacts around it. Set
    // every frame rather than on start so cars ahead brake and swerve as the car catches up,
    // rather than reacting only to a snapshot from when the run began.
    setPolicePresence({ axis: state.axis, line: state.line, s: state.s, dir: state.dir });

    // The lamps fade with the bodywork. Leaving them at full strength would keep washing colour
    // across the tarmac from a car that is no longer there.
    const fade = edgeFade(state.s, state.axis);
    state.fade = fade;
    for (const material of skin) material.opacity = fade;
    siren(fade);
  }

  /**
   * How often the corridor runs, as `[min, max]` seconds between them.
   *
   * Takes effect from the *next* draw rather than cutting the current wait short: shortening a
   * cooldown that is already counting down would fire a siren the moment a delivery lands, which
   * reads as the game punishing the drop-off.
   */
  const setCooldownRange = ([min, max]) => { state.cooldownRange = [min, max]; };

  return {
    state,
    update,
    chase,
    group,
    setCooldownRange,
    /** Both halves of the light bar, for `main.js` to put in the bloom. See game/bloom.js. */
    emissiveMeshes: [lights.red, lights.blue],
  };
}
