import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID_I, GRID_J, lineX, lineZ, riverBanks, rightOf } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  carGeometry, setClosedLanes, isLaneClosed, stageCar, releaseCar, STOP_SETBACK, CAR_LEN, CAR_W,
  CABIN_X, CABIN_TOP, SPAWN_CLEARANCE, ROAD_Y, stopDistance,
} from '../sim/traffic.js';
import { findRoute, planOrigin, estimateSeconds, laneCost } from './route.js';
import { BILLBOARD, VIEW_UP } from './camera.js';
import { sightlineClear } from './sightline.js';
import { ARRIVE_RADIUS, blockDistance } from './fares.js';
import { propMaterial, unlitMaterial, cloneProp, bakeColor, setFinish, FINISH, BODY_EULER_ORDER } from '../util/geo.js';
import { color } from '../palette.js';
import { wheelAnchors, wheelGeometry, SILL_Y, CHASSIS_LIFT } from '../geometry/wheels.js';
import { createTargetRing, RING_Y } from '../geometry/targetring.js';
import { createRaceFlag } from '../geometry/raceflag.js';
import { BOOST_START_FRACTION } from './boost.js';
import { markOccluder } from './ssao.js';
import { createHydraulics, LIFT_MIN } from './hydraulics.js';

// The street race. A violet street racer with a wing on it and light under it is out in the city
// for the whole run, a standing offer. Tap it and the screen cuts to black
// and opens on the two of them side by side, window to window; the camera goes to look at the
// finish a few blocks away and comes back, and it is three, two, one. Get there first and it pays;
// get there second and it costs.
//
// **Taken on, never imposed.** Losing costs cash, and the robbery's rule is that an imposed event
// cannot cost the run, so the race is a tap like every other choice in the game, and ignoring the
// racer is free.
//
// **Around until it has raced, offered when it can be taken** (Tyler: "keep the racer around all the
// time... essentially make it a persistent event players can trigger"). It turns up after a 2nd to
// 4th drop-off (DROPS_BETWEEN), cruises the city as ordinary traffic until a race is run, then drives
// off and comes back as many drop-offs later. A race declined or called off keeps it in town, resting
// REST_TIME before it offers again. It is
// `available` — its "…" tag up, pointing from the screen edge when the car is off it, and the tap
// answered — while the taxi is within NEAR_BLOCKS of it with an empty cab and nothing owning the run
// (`interrupted`: a getaway, a chase, the run ending). Too far, or a rider aboard, and the tag goes
// until that changes. It used to turn up for OFFER_TIME (30s), tail the taxi, then drive off and not
// come back for 100-160s, so whether there was a race to be had was down to timing.
//
// **The start is a cut** (`stage`, behind main.js's wipe). The first two builds *drove* to the start
// — the taxi to a queue behind the parked rival, then the rival round the block to stop beside a
// pulled-up taxi — and both read as waiting: a median of 5s of nothing between the tap and the
// race, and up to 13. Behind the black both cars are put on the nearest stretch of street with room
// for them, one each way: the streets have one lane each way, so "beside you, in the other lane" is
// the oncoming lane, and the rival faces its own way. The two set off in opposite directions — two
// routes to one corner, by construction — and the finish is chosen so the two routes take about as
// long (`chooseFinish`). The board is held from the tap to the line, as for a getaway.
//
// **The rival is a car in traffic** (`enterGuest` in sim/traffic.js), the fire engine's arrangement:
// it is routed to the finish by the same router the taxi is, queues, and can be bumped. What makes it
// a racer is a share of a chasing cop's kit (`car.chase`): a lifted cruise ceiling, the cop's
// overtake (`racePass`) where a cop would have the car in front pull over, and the licence to cross a
// red on a provably empty junction. There is no
// rubber band. A rival that visibly slowed down to let you catch it, or found speed from nowhere when
// you got ahead, would take the win away from the player along with the loss — so it drives one way
// all race, and what the player has over it is Loco Mode and a route of their own choosing.

// When the racer turns up: after a random 2nd to 4th drop-off of the run, and again the same
// number of drop-offs after each race it runs (Tyler: "intro the racer randomly between 2nd and 4th
// dropoff... intro them again at the same interval after a race"). Counted in deliveries rather
// than seconds, so it arrives once the player has the hang of the fare loop, and a player cannot
// sit and farm it: the next race is earned by driving fares. In between it stays, a standing offer.
const DROPS_BETWEEN = [2, 4];
// From the drop-off that brings it to it turning up, once nothing upstages it (`blocked`): the
// drop-off's own money and pop get the screen first.
const ARRIVE_WAIT = 4;
const SOON_WAIT = 4;            // ?race=soon
const RETRY_WAIT = 4;           // nothing qualified this time

// How near the taxi has to be for the racer to offer, in blocks (`blockDistance`, the junctions
// each is heading for): "within a few blocks" (Tyler). Three on a 5×6 island is most of a quarter
// of it, so a racer out of reach is never more than a short drive from being in it.
const NEAR_BLOCKS = 3;
// After a race (won, lost or called off) before it offers again: long enough that the next one is
// not the reflex tap straight after the money lands.
const REST_TIME = 20;
// The tap target: a quad in the screen plane over the car (see the hit-box trap in CLAUDE.md) —
// generous, a car's length or so either side, but no longer reaching up-screen to the top of the
// roof flag it was first sized for (9 tall), which went when the racer stopped flying one.
const HIT_W = 8;
const HIT_H = 6;
// From the cut to the look at the finish: the two of them side by side, close up, long enough to
// take in who is racing whom before the camera leaves — and to read "Round the flag and back.",
// which goes when the camera does. 1.6 was over before the line had been read (Tyler: "hold
// messages longer like the instructions").
export const FACEOFF = 2.6;
// Nothing else within this of either car's start, so the cut does not land one inside another car.
const START_CLEAR = 9;
// The camera's look at the finish is main.js's (`countIn`); this is how long the start waits for it
// before counting anyway — a swipe mid-pan drops the peek's callback, and the tools have no camera.
const REVEAL_MAX = 6;
export const COUNTDOWN = 3;     // three, two, one
// Seconds per number: "slow the countdown a touch" (Tyler) from the 1s it was.
export const COUNT_STEP = 1.25;
// The count waits on the player (Tyler: "have the racer type out a speech bubble that says ready?
// And then tapping that is what triggers the countdown"): after the look at the finish the racer
// asks "Ready?" and the tap on it is the start. Untapped, it nags once at READY_NAG and counts in
// on its own at READY_MAX — the taxi is shut in by `locked` meanwhile, so a player who has put the
// phone down would otherwise be stuck there for good, with every fare's clock held.
const READY_NAG = 6;
const READY_MAX = 15;
const RACE_MAX = 75;            // nobody home by now — the race is called off and nothing changes hands
// The finish, choreographed (Tyler: "1. Winner returns 2. Winner stays in place 3. Cut to loser;
// place them 1 block away 4. Loser drives to finish, pulls up next to winner (skid to stop) 5. Show
// 'You won' or 'You lost' text 6. Show money"). Seconds the winner gets to pull up before the cut —
// enough to see it stop, short of waiting on it.
const WINNER_HOLD = 1.0;
// How long the cut may wait on main.js's wipe before landing the arrival itself (the tools have none).
const ARRIVAL_CUT_MAX = 1.5;
// The loser's running start, off the far end of the block behind: a car rolling in rather than one
// pulling away from a standstill a block out, which is a different and slower shot.
const ARRIVAL_ROLL = 10;
// How far up its lane the winner has to stand for the loser to be let in behind it: past the 6.8
// units the junction's box check keeps clear of a landing (`exitLaneFull`, sim/traffic.js).
const ARRIVAL_CLEAR = 7.5;
// Where on that block it is put: a quarter of the way along, so it has room to brake for the corner.
const ARRIVAL_FROM = 0.25;
// A loser not stopped by now (wedged at the corner, the player steering off) is called in anyway.
const DRIVE_IN_MAX = 8;
// The racer's pace on the drive-in: quick, but short of race pace. At RIVAL_CHASE it came through
// the corner at 21.7 and needed 6.7 units to stop on a lane that gives it 6 — on the brake the
// frame it got there and still a car's length past the taxi's window. At 0.4 it comes in at 13.8
// and stops level (measured over the tools' races: within 0.4 of the taxi's window, as the taxi
// does coming in on its own pedal).
const ARRIVAL_CHASE = 0.4;
// "You won" / "You lost" on screen before the money moves: held, not flashed (it was 1.1).
const RESULT_HOLD = 2.2;

// The hydraulics (game/hydraulics.js; Tyler: "give the racer some hydraulics to bounce their car
// during scenes"). The scenes are the phases where the racer stands for the camera: offering at a
// light, the faceoff, the look at the finish, the count — and the finale when it has won. A
// lowrider in a car built like a tuner, which is a mash-up, and a cartoon one is allowed it.
const POSE_PHASES = new Set(['offer', 'faceoff', 'reveal', 'ready', 'countdown']);
// Only standing still: a body bouncing on its rams at speed reads as a broken car.
const POSE_STILL = 0.5;
// The pump fires on a kick in the bass over this (the underglow's `pulse`, 0..1), and no sooner than
// PUMP_GAP after the last — ~150 bpm at most, so a busy drum track does not set it juddering.
const BEAT_PUMP = 0.7;
const PUMP_GAP = 0.4;
// With the music off, a pump every PUMP_GAP + PUMP_QUIET seconds instead.
const PUMP_QUIET = 1;
// The dance: up, side to side, up, nose.
const PUMP_STEPS = ['pump', 'left', 'right', 'pump', 'nose'];
// Won: this many front hops, this far apart. Lost: slammed down on its rams, nose down, sulking.
const WIN_HOPS = 3;
const HOP_GAP = 0.75;
const SULK_PITCH = -0.08;
// The rear axle, car-local x (geometry/wheels.js puts the axles at ±0.3 of the length).
const REAR_AXLE = -CAR_LEN * 0.3;
// Where on its lane a car may be put for the start: the middle of the block. Short of its own hold
// line, so it is handed to the traffic model before it has to see the signal (CLAUDE.md, on cars
// released inside their stop line); and far enough in that the other car, level with it on the
// other lane, is short of *its* hold line too — the two lanes are one street run both ways.
const PULL_BACK = STOP_SETBACK + CAR_LEN / 2;
const PULL_FRONT = STOP_SETBACK + 0.5;

// Stakes. Shown on the rival's bubble before anything is decided. A median fare is $20, so a win is
// two of them and a loss a fare and a quarter. **Lopsided on purpose**: declining is free, so an even
// bet is one a sensible player never takes, and a race nobody accepts is content nobody sees. The
// lean is what makes it a gamble a confident driver should take, not a coin flip.
export const WIN_PAY = 40;
export const LOSE_COST = 25;

/**
 * The tank the taxi is guaranteed at the green, as a fraction of a full one: what a run starts with.
 *
 * The race is decided by Loco Mode — the rival cruises well over an unboosted taxi, and an unboosted
 * taxi lost every race measured — so a player who accepted on an empty tank would lose before the
 * flag dropped, and learn nothing from it except that races are rigged. Topped *up to* this, never
 * down: a fuller tank is still an edge (see RIVAL_CHASE for how much).
 */
export const TANK_FLOOR = BOOST_START_FRACTION;

/**
 * The rival's share of a chasing cop's kit while racing (see CHASE_SPEED in sim/traffic.js) — twice
 * a whole cop's, because a cop is the city's *slowest* answer to a boosting taxi and this has to be
 * a race. A ceiling of ~35 u/s, Loco Mode's overdrive top, that it reaches only on the longest
 * straights. It also rolls all-way stops and holds the junction it is driving into, the way the
 * boosting taxi and a chasing patrol do (`car.racer` in sim/traffic.js); without those it lost all
 * 32 races it ran against Loco Mode whatever this was set to.
 *
 * Measured with `tools/race.mjs` over 24 races, a player holding Loco Mode from the green until
 * the tank is dry. There and back off the drag start, with the racer routed apart from the taxi
 * (`apart`) and no right off the line (`planRacer`): 1/4 tank 54%, the 1/3 floor 58%, a full tank
 * 100%, and never touching the pill wins none. 1.1 gave 42/46/100. The race is twice as long as a
 * one-way one, so the floor tank runs dry on the way out and the racer's pace matters for the whole
 * return; one way, 1.6 had the floor at 58%. It was 2.0 for the window-to-window start, opposite ways
 * round, and 1.3 for the queue before that, with the rival a car length ahead.
 * That bot never misses a turn or brushes a car, so a person wins less often than it does — about
 * even is the aim, which the lopsided stakes then pay for.
 */
export const RIVAL_CHASE = 1.0;

// Where the racer turns up, off the taxi: on screen on a phone, which at play zoom is about 56 units
// across (7.7px a unit over 430px). Out to 46 it was first seen off the edge of the frame — the
// first browser pass of the tap had to pan to find it.
const SPOT_NEAR = 12;
const SPOT_FAR = 28;
const SPOT_IDEAL = 20;

// How far the finish is from the start, in blocks, leaning to the far end of the range (see
// `chooseFinish`) — across the island rather than round the corner, with the river to cross on most.
// The ring road is out (it is in the fog bank), which caps what an island this size can offer.
const FINISH_MIN = 4;
const FINISH_MAX = 8;

const FADE_TIME = 0.8;          // the fire engine's dissolve
const EXIT_REACH = 8;
const LEAVE_MAX = 30;

// ...and the one over the finish: clear of a truck's roof (the cars drive under it), and half as
// big again as the rival's first one did so it reads from the far side of a phone screen.
const FINISH_FLAG_Y = 4.5;
const FINISH_FLAG_SCALE = 1.5;
const ACTIVE = new Set(['cut', 'faceoff', 'reveal', 'ready', 'countdown', 'racing', 'finale']);
// The stretch nobody can back out of: the cut to the start until the green.
const LOCKED = new Set(['cut', 'faceoff', 'reveal', 'ready', 'countdown']);

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// The underglow pulses to the music (Tyler: "animate his under car light to pulse to the music").
// It rests at GLOW_REST of full and flares to full on each kick: the bass on the Music bus
// (`sfx.bass`, 0..1 on the analyser's dB scale) against its own running average over `BEAT_AVG`,
// so a loud song and a quiet one both pulse, and a flat line (no music, or muted) rests. A rise of
// `KICK_RISE` over the average is a full flare, and it dies away over `KICK_FALL`. Measured offline
// on the four in-game songs (the same 1024-point FFT and dB scale, decoded with ffmpeg): at 0.15 it
// flares 2.2-2.9 times a second, about once a beat; the first guess of 0.08 flared 3-4.6 times and
// sat above 80% for 35-43% of the song, which reads as flicker rather than a pulse.
// How far the beat moves it. Opacity alone (0.65 to 1 of 0.9) was "barely tell" on a phone, so a
// flare now does three things at once: opacity from GLOW_REST to full, the pad grows by
// GLOW_SWELL, and the colour runs hot by GLOW_HOT (additive, so over 1 it whitens toward the core).
const GLOW_REST = 0.2;
// 0.6 at first; Tyler: "shrink the glow just a touch", so 0.4 with the reach below.
const GLOW_SWELL = 0.4;
const GLOW_HOT = 1.5;
// With no music at all — muted, or between songs — there is no beat to rest between, so it holds
// at GLOW_IDLE of a flare instead of sitting at the dim rest. Silent is a bass level under SILENT
// on the analyser's 0..1 dB scale (music sits around 0.5).
const GLOW_IDLE = 0.6;
const SILENT = 0.05;
const BEAT_AVG = 0.35;
const KICK_RISE = 0.15;
const KICK_FALL = 0.15;

// The racer's line: the router's own costs, with every lane of the taxi's best route SHARE_COST
// times dearer. Dear rather than shut, so where the city offers only one sensible way (a bridge, a
// river bank) the two still share it rather than the racer taking a lap to stay apart.
const SHARE_COST = 2.5;
const apart = (shared) => (lane) => laneCost(lane) * (shared.has(lane.id) ? SHARE_COST : 1);

export const createPulse = () => ({ avg: 0, pulse: 0 });

/** One frame of the underglow's beat follower: `level` in, `p.pulse` (0..1) out. Pure, for the probe. */
export function pulseStep(p, level, dt) {
  p.avg += (level - p.avg) * (1 - Math.exp(-dt / BEAT_AVG));
  const kick = clamp01((level - p.avg) / KICK_RISE);
  p.pulse = Math.max(kick, p.pulse * Math.exp(-dt / KICK_FALL));
  return p.pulse;
}

// The ordinary car's body, which the racer's dress is measured off: a deck 0.8 tall centred on
// `0.78 + CHASSIS_LIFT` (`carGeometry`), and a cabin `CAR_LEN / 2` long set back by CABIN_X.
const DECK_TOP = 0.78 + CHASSIS_LIFT + 0.4;
const CABIN_FRONT = CABIN_X + CAR_LEN / 4;
const CABIN_BACK = CABIN_X - CAR_LEN / 4;
// The bodywork's edges are rounded (`BODY_ROUND`), so dress laid flat on a deck stops this far
// short of its ends, where the deck has already started to fall away.
const EDGE_IN = 0.14;

// The spoiler. Standing *proud* of the roofline: tucked under it, as it first was, the blade sat
// against the back of the cabin from this camera and read as part of it — Tyler asked for "a little
// spoiler" on a car that already had one. End plates make it a wing rather than a shelf.
const WING_X = -CAR_LEN / 2 + 0.28;
const WING_Y = CABIN_TOP + 0.12;
const WING_SPAN = CAR_W * 1.04;

// The racing stripe, nose to tail over the deck and the roof.
const STRIPE_W = 0.42;
const STRIPE_T = 0.03;          // half of it buried, so its underside never shares a plane with paint

// The underglow: a pad of light on the road under the car, solid under the body and fading to
// nothing GLOW_REACH outside it. Sized at play zoom (1 unit ≈ 7.7px): the body hides the middle,
// so what reads is the fringe, and 0.65 of it is ~5px all round — a crisp halo (0.8 was a touch
// too much, Tyler). Rounded rather than
// boxed: a superellipse (`GLOW_ROUND`) traced in GLOW_SEGMENTS, because the first cut's rectangle
// read as hard diagonals at the corners (Tyler: "really angular"). The ramp out is a straight one:
// a 1.1-unit reach eased through four rings on a squared curve was tried and read as blurry
// (Tyler: "I like the old less blurry lights better").
const GLOW_REACH = 0.65;
const GLOW_INSET = 0.15;
const GLOW_Y = 0.05;
const GLOW_ROUND = 3;
const GLOW_SEGMENTS = 40;
const GLOW_RINGS = 1;

/** The rival's body: an ordinary car's, in its own paint, with a wing on the boot. */
function rivalBodyGeometry() {
  const wing = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return setFinish(bakeColor(g, color('racerWing')), FINISH.PAINT);
  };
  const strutH = WING_Y - DECK_TOP;
  const parts = [
    carGeometry({ wheels: false }),
    // The blade, raked a touch by being deeper than it is thick.
    wing(0.5, 0.08, WING_SPAN, WING_X, WING_Y, 0),
    // End plates at the tips.
    ...[1, -1].map((side) => wing(0.6, 0.34, 0.06, WING_X, WING_Y - 0.08, side * (WING_SPAN / 2 - 0.03))),
    // Two struts down onto the boot, their feet buried in it.
    ...[1, -1].map((side) => wing(0.1, strutH + 0.05, 0.1, WING_X, DECK_TOP + strutH / 2 - 0.025, side * CAR_W * 0.28)),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The white stripe down the middle: bonnet, roof and boot. Its own geometry because the body's paint
 * is a multiply over white (`carGeometry`) — merged into the body, the stripe would come out violet.
 */
function stripeGeometry() {
  const strip = (x0, x1, y) => {
    const g = new THREE.BoxGeometry(x1 - x0, STRIPE_T, STRIPE_W);
    g.translate((x0 + x1) / 2, y, 0);
    return setFinish(bakeColor(g, color('racerStripe')), FINISH.PAINT);
  };
  const parts = [
    strip(CABIN_FRONT, CAR_LEN / 2 - EDGE_IN, DECK_TOP),
    strip(CABIN_BACK + EDGE_IN, CABIN_FRONT - EDGE_IN, CABIN_TOP),
    strip(-CAR_LEN / 2 + EDGE_IN, CABIN_BACK, DECK_TOP),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The underglow's pad: a rounded core under the body at full strength, and a ring around it fading
 * to transparent across GLOW_REACH. Alpha rides a four-component colour
 * attribute; every triangle is wound to face up, and `tools/probe.mjs` checks it does (see the
 * winding traps in CLAUDE.md — on an unlit material a reversed triangle does not draw at all).
 */
export function underglowGeometry() {
  const hx = CAR_LEN / 2 - GLOW_INSET;
  const hz = CAR_W / 2 - GLOW_INSET;
  // A superellipse of exponent GLOW_ROUND through the body's corners' neighbourhood, grown by `r`.
  const ring = (r, alpha) => Array.from({ length: GLOW_SEGMENTS }, (_, k) => {
    const a = (k / GLOW_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const ex = 2 / GLOW_ROUND;
    return [
      Math.sign(c) * Math.abs(c) ** ex * (hx + r),
      Math.sign(sn) * Math.abs(sn) ** ex * (hz + r),
      alpha,
    ];
  });
  const pos = [];
  const col = [];
  const tri = (a, b, c) => {
    // Face up (+Y): a triangle is up-facing when (b − a) × (c − a) has a positive y, which for
    // points in the ground plane is (bz − az)(cx − ax) − (bx − ax)(cz − az).
    const y = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
    const [p, q, r] = y > 0 ? [a, b, c] : [a, c, b];
    for (const v of [p, q, r]) {
      pos.push(v[0], GLOW_Y, v[1]);
      col.push(1, 1, 1, v[2]);
    }
  };
  const rings = [];
  for (let n = 0; n <= GLOW_RINGS; n++) {
    const t = n / GLOW_RINGS;
    rings.push(ring(t * GLOW_REACH, 1 - t));
  }
  const centre = [0, 0, 1];
  const core = rings[0];
  for (let k = 0; k < GLOW_SEGMENTS; k++) tri(centre, core[k], core[(k + 1) % GLOW_SEGMENTS]);
  for (let n = 0; n < GLOW_RINGS; n++) {
    const A = rings[n];
    const B = rings[n + 1];
    for (let k = 0; k < GLOW_SEGMENTS; k++) {
      const m = (k + 1) % GLOW_SEGMENTS;
      tri(A[k], B[k], B[m]);
      tri(A[k], B[m], A[m]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}

/**
 * The rival's mesh. Same arrangement as the fire engine and the patrol cruiser: the group stays in
 * the scene for the whole run and only `shell` is switched, so nothing here moves the scene's light
 * count (see the hidden-light trap in CLAUDE.md — there is no light in it today, and this keeps it
 * that way if one is ever added).
 */
function createRivalMesh() {
  const group = new THREE.Group();
  group.name = 'race-rival';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = rivalBodyGeometry();
  // The hydraulics (game/hydraulics.js): `lift` pitches the whole car about its rear axle for a
  // hop, and `rig` carries the body on its rams over wheels that stay where they are. The glow
  // stays out of both, on the road.
  const lift = new THREE.Group();
  shell.add(lift);
  const rig = new THREE.Group();
  lift.add(rig);
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  // The body is baked white under the paint (see `carGeometry`), and the wing baked dark, so one
  // multiply paints the car and leaves the wing and the glass dark.
  body.material.color.set(color('racerBody'));
  body.castShadow = true;
  body.receiveShadow = true;
  rig.add(body);

  const stripeGeo = stripeGeometry();
  const stripe = new THREE.Mesh(stripeGeo, propMaterial({ gloss: { geometry: stripeGeo, floor: SILL_Y } }));
  stripe.receiveShadow = true;
  rig.add(stripe);

  // Additive, so it brightens whatever road it lands on rather than painting over it, and it reads
  // at night as light and by day as a tint. Never writes depth and is never in a depth pass.
  const glow = new THREE.Mesh(underglowGeometry(), unlitMaterial({
    color: color('racerGlow'),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  glow.renderOrder = 1;
  shell.add(glow);

  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  // All four are their own meshes rather than the rear pair baked into the body as on every other
  // car: a body that bounces on its rams has to leave its wheels behind on the road.
  const allWheels = wheelAnchors(CAR_LEN, CAR_W).map((anchor) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(anchor.x, anchor.y, anchor.z);
    wheel.castShadow = true;
    wheel.userData.front = anchor.front;
    lift.add(wheel);
    return wheel;
  });
  const wheels = allWheels.filter((w) => w.userData.front);

  // Dissolved in and out rather than blended — the cruiser's and the engine's `alphaHash`.
  const faders = [body.material, stripe.material, wheelMat];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;
  return { group, shell, lift, rig, body, wheels, glow, faders, occluders: [body, stripe, ...allWheels] };
}

/**
 * @param rng      its own stream: when, where, and which corner is the finish
 * @param scene    where the rival and the finish are drawn
 * @param traffic  the sim — `enterGuest`, `retireGuest`, `taxi`
 * @param routeTo  main.js's router, `(target) => boolean` — the one that keeps `pendingTarget` and the
 *                 route band honest (see `createBurgerRun` for why it is injected)
 * @param blocked  `() => boolean` — true while no racer may turn up; one that is on is called off
 * @param canStart `() => boolean` — is the taxi free: an empty cab with nowhere it is going
 * @param delivered `() => number` — the run's drop-offs so far, which time the racer's visits
 * @param seen     `(car, keep) => boolean` — is the racer on screen? `keep` asks with some give, for
 *                 a tag that is already up
 * @param onEvent  `(type, detail) => void` — everything the player sees off the car: the bubble, the
 *                 count, the money. This module knows a race happened, not what a run's cash is.
 * @param soon     `?race=soon`
 * @param hydraulics false for `?hydraulics=classic`: the body sits still on its wheels
 * @param readyGate false for `?raceready=classic`: the count starts when the camera is back
 */
export function createRace({
  rng, scene, traffic, routeTo, blocked = () => false, interrupted = () => false, canStart = () => true,
  seen = () => false, delivered = () => 0, onEvent = () => {}, soon = false, bass = () => 0,
  hydraulics = true, readyGate = true,
}) {
  const taxi = traffic.taxi;
  // Everything the player sees off the car goes through here, so the pumps hear it first.
  const tell = onEvent;
  onEvent = (type, detail) => {
    pumpOn(type, detail);
    tell(type, detail);
  };
  let rivalChase = RIVAL_CHASE;

  const rival = createRivalMesh();
  scene.add(rival.group);
  markOccluder(rival.group);

  // The tap target, from the moment the racer turns up until the flag drops. On a group that
  // follows the car rather than on the car's own group, so it stays square to the screen while the
  // body pitches and rolls. It used to carry a chequered flag on the roof too; Tyler had it taken
  // off ("hide the race flag"), and the only flag in a race is now the finish's.
  const offer = new THREE.Group();
  offer.name = 'race-offer';
  const hit = new THREE.Mesh(
    new THREE.PlaneGeometry(HIT_W, HIT_H),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
  );
  hit.quaternion.copy(BILLBOARD);
  hit.position.copy(VIEW_UP).multiplyScalar(HIT_H / 2 - 1.5);
  offer.add(hit);
  offer.userData.pickable = 'racer';
  offer.visible = false;
  scene.add(offer);

  // The finish: the waypoint ring on the junction, and a flag planted on its corner.
  const finishRing = createTargetRing(color('waypoint'));
  finishRing.setWaypoint(true);
  finishRing.group.visible = false;
  scene.add(finishRing.group);
  // The finish flag flies over the ring rather than standing beside it: planted on a pavement
  // corner it was inside whatever the block had built there — measured on the first browser pass,
  // a gas station's kiosk swallowed it whole and the finish was a ring on the road and nothing
  // else. Up here, under this camera, nothing a block builds can hide it, and the cars drive under.
  const finishFlag = createRaceFlag({ pole: 1.2 });
  finishFlag.group.scale.setScalar(FINISH_FLAG_SCALE);
  finishFlag.group.visible = false;
  scene.add(finishFlag.group);

  const glowBeat = createPulse();
  const glowColor = new THREE.Color(color('racerGlow'));

  // The hydraulics' director: when the rams fire. Only in the scenes, never on the move.
  const hyd = hydraulics ? createHydraulics() : null;
  const pumps = { next: 0, beatWas: 0, step: 0, hops: 0, hopAt: 0 };
  function pumpOn(type, detail) {
    if (!hyd) return;
    if (type === 'asked' || type === 'ready' || type === 'ready-nag') hyd.kick('hop');
    else if (type === 'accepted' || type === 'count') hyd.kick('bigPump');
    // Squat on the launch: the tail goes down as the power goes on.
    else if (type === 'go') { hyd.setRest(0); hyd.kick('tail'); }
    else if (type === 'decided') {
      if (detail.winner === 'taxi') hyd.setRest(LIFT_MIN, SULK_PITCH);
      else { pumps.hops = WIN_HOPS; pumps.hopAt = state.t; }
    }
  }
  /** One frame of the pumps: the beat-driven dance while the racer stands in a scene, the hops. */
  function pumpFrame(dt) {
    const car = state.car;
    if (!hyd) return;
    if (!car || car.crashed || !rival.shell.visible) { hyd.reset(); pumps.hops = 0; return; }
    if (state.phase !== 'finale') hyd.setRest(0);
    const racerWon = state.phase === 'finale' && state.winner !== 'taxi';
    const posing = POSE_PHASES.has(state.phase) || racerWon;
    if (posing && Math.abs(car.v) < POSE_STILL && pumps.hops === 0) {
      // On the bass the underglow is already following (`glowBeat`), or on a slow clock in silence.
      const silent = glowBeat.avg < SILENT;
      const onBeat = !silent && glowBeat.pulse > BEAT_PUMP && pumps.beatWas <= BEAT_PUMP;
      if (state.t >= pumps.next && (onBeat || (silent && state.t >= pumps.next + PUMP_QUIET))) {
        hyd.kick(PUMP_STEPS[pumps.step++ % PUMP_STEPS.length]);
        pumps.next = state.t + PUMP_GAP;
      }
    }
    pumps.beatWas = glowBeat.pulse;
    if (pumps.hops > 0 && hyd.state.hop === 0 && state.t >= pumps.hopAt) {
      hyd.kick('hop');
      pumps.hops -= 1;
      pumps.hopAt = state.t + HOP_GAP;
    }
    hyd.update(dt);
    const h = hyd.state;
    // The hop pitches about the rear axle, which stays on the road: rotating about the car's origin
    // would sink the tail into it by `REAR_AXLE · sin`.
    rival.lift.rotation.z = h.hop;
    rival.lift.position.set(REAR_AXLE * (1 - Math.cos(h.hop)), -REAR_AXLE * Math.sin(h.hop), 0);
    rival.rig.position.y = h.lift;
    rival.rig.rotation.set(h.roll, 0, h.pitch);
  }

  const state = {
    // 'waiting' — nothing on; 'offer' — a racer is tailing the taxi, tappable; 'cut' —
    // tapped, the screen going to black (`stage` lands the start under it); 'faceoff' — side by
    // side, close up; 'reveal' — the camera off looking at the finish; 'countdown'; 'racing';
    // 'leaving' — it is over (or nobody took it) and the rival is driving off.
    phase: 'waiting',
    phaseT: 0,
    t: 0,
    cooldown: soon ? SOON_WAIT : ARRIVE_WAIT,
    // The run's delivery count it turns up at (see DROPS_BETWEEN).
    dueAt: soon ? 0 : rng.int(DROPS_BETWEEN[0], DROPS_BETWEEN[1]),
    car: null,
    /** The two lanes the start was put on, shut to newcomers until the flag drops. */
    startLanes: null,
    /** ...and for the finish, a junction. Object identity is what the route band keys off. */
    finish: null,
    exit: null,
    fade: 0,
    fading: 0,
    /** The last whole second the countdown announced, so each is said once. */
    count: 0,
    // What happened, for the tools.
    offers: 0,
    // Has the player tapped the racer once, and been asked (`ask`)?
    asked: false,
    // Is the racer offering right now (see NEAR_BLOCKS) — its tag up and the tap answered?
    available: false,
    // Seconds before it offers again, after a race.
    rest: 0,
    races: 0,
    wins: 0,
    losses: 0,
    voids: 0,
    lastResult: null,
    taxiTime: null,
    rivalTime: null,
    // There and back: `finish` is the corner to round, `home` the junction at the start line, and
    // each car's flag says whether it has rounded the corner yet.
    home: null,
    taxiBack: false,
    rivalBack: false,
    // 'taxi' or 'rival' once the first one is home ('finale'), until the loser is.
    winner: null,
    // The finale's steps: 'hold' (the winner pulling up), 'cut' (main.js's wipe), 'drive-in' (the
    // loser, a block out, coming to stop beside it), 'result' (the word, then the money).
    step: null,
    stepT: 0,
    // Where the drive-in goes: `stopS` on `lane`, level with the winner, and the junction the loser
    // is routed at (beyond the stop, so the route runs past it).
    arrival: null,
    // The taxi on the race's brake (the winner pulling up, the loser skidding in) — main.js ORs this
    // into the pedal, since `parked` stops a car dead.
    brakeTaxi: false,
  };

  function setPhase(phase) {
    state.phase = phase;
    state.phaseT = 0;
  }

  // --- Choosing where ---------------------------------------------------------

  /** Is this z on or beside the river? Nobody parks on a bridge, and a finish there is a lift bridge's. */
  function overWater(z) {
    const banks = riverBanks();
    return Boolean(banks) && z > banks.z0 - 2 && z < banks.z1 + 2;
  }

  /** Every lane the racer could turn up on this frame, with where on it. */
  function spots() {
    const net = cityNetwork();
    const out = [];
    for (const lane of net.lanes) {
      if (lane.degenerate || isLaneClosed(lane.id)) continue;
      const a = net.nodeById.get(lane.from);
      const b = net.nodeById.get(lane.to);
      if (!a || !b) continue;
      // Not the ring road: its corners are curves and its outer kerb is the edge of the island.
      const ring = (n) => n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
      if (ring(a) && ring(b)) continue;
      // Mid-block: clear of both junctions, so the car that dissolves in is not born in a box or
      // past a hold line (CLAUDE.md, on cars handed to the traffic model inside their stop line).
      const s = lane.length / 2;
      if (s < STOP_SETBACK + CAR_LEN / 2) continue;
      const p = lane.path.at(s);
      if (overWater(p.z)) continue;
      const d = Math.hypot(p.x - taxi.x, p.z - taxi.z);
      if (d < SPOT_NEAR || d > SPOT_FAR) continue;
      if (!sightlineClear(p.x, 2.2, p.z)) continue;
      out.push({ lane, s, x: p.x, z: p.z, d, to: { i: b.gi, j: b.gj }, dir: net.dirOfLane(lane) });
    }
    return out;
  }

  /**
   * A corner FINISH_MIN..FINISH_MAX blocks off that both cars can be routed to, from where each
   * stands and the way each is facing (`taxiFrom`, `rivalFrom`, as `planOrigin` reads them).
   *
   * The two set off level and the same way (`stage`), so the racer is routed *apart* from the
   * taxi's best line (`apart`): on one shared route, whoever won the drag off the start won the
   * race, because the one behind has no way past. Measured on `tools/race.mjs` (24 races): a taxi
   * on a quarter tank of Loco won 96% that way, against 58% on the old start. The corner is then
   * the one that keeps the two lines evenest by the router's own estimate of the drive
   * (`estimateSeconds`, the fare clocks' arithmetic), which can see the river's three bridges.
   */
  function chooseFinish(taxiFrom, rivalFrom) {
    const net = cityNetwork();
    const options = [];
    // Never on the ring road: its corners are the island's, out in the fog bank, and a finish line
    // nobody can see is a race decided off screen.
    for (let i = 1; i < GRID_I; i++) {
      for (let j = 1; j < GRID_J; j++) {
        if (!net.nodeById.has(`${i},${j}`)) continue;
        const d = Math.min(blockDistance(taxiFrom, { i, j }), blockDistance(rivalFrom, { i, j }));
        if (d < FINISH_MIN || d > FINISH_MAX) continue;
        const x = lineX(i);
        const z = lineZ(j);
        if (overWater(z)) continue;
        if (!sightlineClear(x, 0.5, z)) continue;
        const taxiRoute = findRoute(taxiFrom, { i, j });
        const rivalRoute = findRoute(rivalFrom, { i, j }, apart(routeLanes(taxiFrom, taxiRoute)));
        if (!taxiRoute?.length || !rivalRoute?.length) continue;
        const gap = Math.abs(estimateSeconds(taxiRoute, taxiFrom.d) - estimateSeconds(rivalRoute, rivalFrom.d));
        options.push({ i, j, d, gap });
      }
    }
    if (!options.length) return null;
    // Leaning long: the further of what qualifies, so a race is a drive rather than a sprint; and
    // of those, the evenest few.
    const far = Math.max(...options.map((o) => o.d));
    const pool = options.filter((o) => o.d >= far - 1).sort((a, b) => a.gap - b.gap).slice(0, 3);
    const { i, j } = rng.pick(pool);
    return { i, j };
  }

  /** The lanes a route drives, from `from` — what the racer's line keeps off (`apart`). */
  function routeLanes(from, route) {
    const net = cityNetwork();
    const ids = new Set();
    let { i, j } = from;
    for (const d of route ?? []) {
      const lane = net.laneOutByGrid(d, i, j);
      if (!lane) break;
      ids.add(lane.id);
      const to = net.nodeById.get(lane.to);
      i = to.gi;
      j = to.gj;
    }
    return ids;
  }

  /** The lane running the other way along the same street, if there is one to stop in. */
  function oppositeOf(lane) {
    const net = cityNetwork();
    const back = net.lanes.find((l) => l.from === lane.to && l.to === lane.from);
    return back && !back.degenerate ? back : null;
  }

  /** Could a start go on this lane, with the rival level with the taxi on the other one? */
  function pullable(lane) {
    if (!lane || lane.degenerate || isLaneClosed(lane.id)) return false;
    const net = cityNetwork();
    const a = net.nodeById.get(lane.from);
    const b = net.nodeById.get(lane.to);
    if (!a || !b) return false;
    const ring = (n) => n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
    if (ring(a) && ring(b)) return false;
    if (lane.length - PULL_FRONT < PULL_BACK) return false;
    const back = oppositeOf(lane);
    return Boolean(back) && !isLaneClosed(back.id);
  }

  /**
   * Bring the racer on, a couple of blocks off and on screen, so its first appearance is seen. After
   * that it stays (`rest`); this runs again only if it is lost (a wreck). Answers whether one came.
   */
  function summon() {
    const all = spots();
    if (!all.length) return false;
    const pool = all.sort((a, b) => Math.abs(a.d - SPOT_IDEAL) - Math.abs(b.d - SPOT_IDEAL)).slice(0, 5);
    const at = rng.pick(pool);
    const car = traffic.enterGuest({ x: at.x, z: at.z }, { isTruck: false });
    if (!car) return false;
    traffic.wearSkin(car, skin, rival.group);
    car.guestWreck = wreck;
    car.route = [];
    car.chase = 0;
    car.racer = false;
    state.car = car;
    state.finish = null;
    state.shared = null;
    state.startLanes = null;
    rival.group.position.set(car.x, 0, car.z);
    rival.shell.visible = true;
    offer.visible = true;
    state.fade = 0;
    state.fading = 1;
    state.offers += 1;
    state.asked = false;
    state.available = false;
    state.rest = 0;
    setPhase('offer');
    onEvent('arrived', { car });
    return true;
  }


  /** Take the offer down: out of reach, a rider aboard, or the car gone. */
  function offerOff(car) {
    if (!state.available) return;
    state.available = false;
    state.asked = false;
    onEvent('unavailable', { car });
  }

  /**
   * The first tap on the racer: it says what it wants. Until then it only shows a "…" — Tyler: "can
   * we just show a … above the racer then on tap the 'wanna race'?" — so a car tailing the taxi
   * is not one more line of text on a busy screen, and the question is put to someone who asked.
   * Answers whether it asked; the second tap is `accept`.
   */
  function ask() {
    if (state.phase !== 'offer' || !state.car || state.asked || !state.available) return false;
    state.asked = true;
    onEvent('asked', { car: state.car, win: WIN_PAY, lose: LOSE_COST });
    return true;
  }

  /**
   * Anything but the "Wanna race?" card tapped once it has asked: "Next time, then." (Tyler: "if you
   * tap anywhere other than on 'wanna race?' have it say 'Next time, then'"). Nothing changes
   * hands; the racer stays in town and offers again after REST_TIME.
   */
  function decline() {
    if (state.phase !== 'offer' || !state.asked) return false;
    state.asked = false;
    state.available = false;
    state.rest = REST_TIME;
    onEvent('declined', { car: state.car });
    return true;
  }

  /** Back on the line: a route given to the parked taxi from the second tap to the green is dropped. */
  function holdTaxi() {
    taxi.route = [];
    taxi.pendingTarget = null;
    taxi.parked = true;
  }

  /**
   * The second tap on the racer. Answers whether the race is on: the screen is about to cut (main.js runs
   * the wipe and calls `stage` under the black), and the taxi drops whatever it was heading for —
   * an empty cab's only errand is a rider, and the board is about to be held.
   */
  function accept() {
    if (state.phase !== 'offer' || !state.car || interrupted()) return false;
    taxi.route = [];
    taxi.pendingTarget = null;
    setPhase('cut');
    onEvent('accepted', { car: state.car });
    return true;
  }

  /**
   * Where the start goes: the nearest stretch of street to the taxi with room for both cars, one
   * each way, and nothing else standing on it. Not over the river, not behind a building, never on
   * the ring road.
   */
  function chooseStart(sideOnly = true) {
    const net = cityNetwork();
    let best = null;
    for (const lane of net.lanes) {
      if (!pullable(lane)) continue;
      // A side street if there is one: the L train's deck stands over the north-south arterial,
      // and the first browser pass put the faceoff underneath it, half hidden; and an arterial's
      // median opens the two cars a lane and a half apart, which is not window to window.
      if (sideOnly && lane.klass === 'arterial') continue;
      const s = Math.max(PULL_BACK, Math.min(lane.length - PULL_FRONT, lane.length / 2));
      const p = lane.path.at(s);
      const back = oppositeOf(lane);
      const sb = Math.max(PULL_FRONT, Math.min(back.length - PULL_BACK, back.length - s));
      const q = back.path.at(sb);
      if (overWater(p.z) || overWater(q.z)) continue;
      if (!sightlineClear(p.x, 2.2, p.z) || !sightlineClear(q.x, 2.2, q.z)) continue;
      const d = Math.hypot(p.x - taxi.x, p.z - taxi.z);
      if (best && d >= best.d) continue;
      // And nothing on its way down the oncoming lane, which the racer sets off along the wrong way.
      const crowded = traffic.cars.some((c) => c !== taxi && c !== state.car && !c.crashed
        && (Math.hypot(c.x - p.x, c.z - p.z) < START_CLEAR || Math.hypot(c.x - q.x, c.z - q.z) < START_CLEAR
          || (c.lane === back && c.s < sb)));
      if (crowded) continue;
      // And a finish line to come home to, at one end of this street or the other (`chooseHome`).
      const home = chooseHome(lane);
      if (!home) continue;
      best = { lane, s, back, sb, d, home };
    }
    return best ?? (sideOnly ? chooseStart(false) : null);
  }

  /** Put `car` on `lane` at `s`, stood still — under the black, where nobody sees it move. */
  function place(car, lane, s) {
    const net = cityNetwork();
    const p = lane.path.at(s);
    const t = lane.path.tangentAt(s);
    stageCar(car, p.x, p.z, Math.atan2(-t.z, t.x));
    const to = net.nodeById.get(lane.to);
    return releaseCar(car, net.dirOfLane(lane), to.gi, to.gj, lane.length - s);
  }

  /**
   * The cut: both cars put side by side under the black, facing the same way, the finish picked,
   * and the faceoff begins. main.js calls it from the wipe; the tools call it straight.
   *
   * Every street is one lane each way, so the racer stands in the *oncoming* lane, level with the
   * taxi (Tyler: "can they take off facing the same direction?"). To the traffic model it is on
   * the taxi's own lane at the taxi's own arc length, with the cop overtake's offset already full
   * (`dragStart` in sim/traffic.js), and the drag off the line decides which of the two gets the
   * lane. They used to face opposite ways on the street's two lanes, which made every start one car
   * pointed at the finish and the other with a U-turn's worth of corners to make first.
   */
  function stage() {
    if (state.phase !== 'cut') return false;
    const car = state.car;
    const start = car && !car.crashed ? chooseStart() : null;
    if (!start || !place(taxi, start.lane, start.s) || !place(car, start.lane, start.s)) {
      finish('void');
      return false;
    }
    // The taxi holds the line on `parked`, which outranks Loco Mode, so a thumb on the pill cannot
    // jump the start; the rival on the fire engine's stop.
    taxi.parked = true;
    taxi.route = [];
    taxi.pendingTarget = null;
    car.v = 0;
    car.route = [];
    car.chase = 0;
    car.racer = false;
    car.roadblock = Infinity;
    // Out in the oncoming lane from the first frame: the traffic model swings it from here.
    car.dragStart = true;
    car.pass = 1;
    car.passing = true;
    car.passTarget = taxi;
    car.passFrom = car.travelled;
    // Nothing more joins either lane while they stand there, and an oncoming left does not wait on
    // a car that is not coming (`leftYieldBlocked` in sim/traffic.js).
    state.startLanes = [start.lane.id, start.back.id];
    setClosedLanes(state.startLanes, 'race');
    taxi.holdsLine = true;
    car.holdsLine = true;
    const goal = chooseFinish(planOrigin(taxi), planOrigin(car));
    if (!goal) { finish('void'); return false; }
    state.finish = goal;
    state.home = start.home;
    state.taxiBack = false;
    state.rivalBack = false;
    state.winner = null;
    // Both legs of the taxi's best line, so the racer keeps off it on the way back too.
    const out = findRoute(planOrigin(taxi), goal) ?? [];
    const turned = { ...goal, d: out[out.length - 1] ?? planOrigin(taxi).d };
    state.shared = new Set([...routeLanes(planOrigin(taxi), out),
      ...routeLanes(turned, findRoute(turned, state.home))]);
    setPhase('faceoff');
    // Framed on where the racer is drawn, over on the other lane, not on its arc length.
    const q = start.back.path.at(start.sb);
    onEvent('staged', { car, x: (taxi.x + q.x) / 2, z: (taxi.z + q.z) / 2 });
    return true;
  }

  /**
   * The junction the race comes home to: one end of the start's own street, so the line they cross
   * at the end is the street they set off from. Whichever end can be seen, the one ahead first.
   */
  function chooseHome(lane) {
    const net = cityNetwork();
    for (const id of [lane.to, lane.from]) {
      const n = net.nodeById.get(id);
      if (!n) continue;
      const ring = n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
      if (ring || overWater(lineZ(n.gj)) || !sightlineClear(lineX(n.gi), 0.5, lineZ(n.gj))) continue;
      return { i: n.gi, j: n.gj };
    }
    return null;
  }

  const taxiGoal = () => (state.taxiBack ? state.home : state.finish);

  /**
   * Where the finish is staged: a street with the winner parked on one lane, mid-block, and the
   * oncoming lane clear for the loser to come down from the block behind and stop window to window
   * with it. The nearest one to where the winner crossed the line, by the same rules as the start.
   * The loser is put on the lane *into* the far junction, so it has a corner and a block to come
   * down — the shot Tyler asked for — rather than a third of a block from a standstill.
   */
  function chooseArrival(winnerCar, loserCar, dir = null) {
    const net = cityNetwork();
    const ring = (n) => n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
    let best = null;
    for (const lane of net.lanes) {
      if (!pullable(lane) || lane.klass === 'arterial') continue;
      if (dir != null && net.dirOfLane(lane) !== dir) continue;
      const back = oppositeOf(lane);
      // The loser comes up the winner's own street from the block behind it, the way they raced.
      const x = net.nodeById.get(lane.from);
      const behind = x?.inbound.find((l) => !l.degenerate && net.dirOfLane(l) === net.dirOfLane(lane));
      if (!behind || isLaneClosed(behind.id) || ring(net.nodeById.get(behind.from))) continue;
      // Forward on the lane rather than mid-block: the loser has to be let through the junction
      // behind, and the box check (`exitLaneFull`, sim/traffic.js) refuses a landing within 1.5
      // following gaps (6.8) of anything on the exit lane. Mid-block on a 12-unit lane is 6, which
      // held the loser at the far hold line, 18 units short, in every race measured — and so does
      // the front of a 10.67-unit lane (6.77), hence the floor.
      const s = Math.max(PULL_BACK, lane.length - PULL_FRONT);
      if (s < ARRIVAL_CLEAR) continue;
      const p = lane.path.at(s);
      const sb = Math.max(PULL_FRONT, Math.min(back.length - PULL_BACK, back.length - s));
      const q = back.path.at(sb);
      const from = behind.length * ARRIVAL_FROM;
      const r = behind.path.at(from);
      if (overWater(p.z) || overWater(q.z) || overWater(r.z)) continue;
      const d = Math.hypot(p.x - winnerCar.x, p.z - winnerCar.z);
      if (best && d >= best.d) continue;
      if (!sightlineClear(p.x, 2.2, p.z) || !sightlineClear(q.x, 2.2, q.z)) continue;
      const crowded = traffic.cars.some((c) => c !== winnerCar && c !== loserCar && !c.crashed
        && (c.lane === lane || c.lane === back || c.lane === behind
          || Math.hypot(c.x - p.x, c.z - p.z) < START_CLEAR || Math.hypot(c.x - r.x, c.z - r.z) < START_CLEAR));
      if (crowded) continue;
      const to = net.nodeById.get(lane.to);
      best = { lane, s, back, sb, behind, from, d, goal: { i: to.gi, j: to.gj } };
    }
    return best ?? (dir != null ? chooseArrival(winnerCar, loserCar) : null);
  }

  /**
   * The cut to the loser (main.js's wipe, or straight from the tools): the winner parked mid-block,
   * the loser a block out and rolling, routed down the other lane to stop level with it. Answers
   * whether there was a street for it; without one the result simply follows.
   */
  function stageArrival() {
    if (state.phase !== 'finale' || state.step !== 'cut') return false;
    const car = state.car;
    const taxiWon = state.winner === 'taxi';
    const winnerCar = taxiWon ? taxi : car;
    const loserCar = taxiWon ? car : taxi;
    const spot = car && !car.crashed ? chooseArrival(winnerCar, loserCar, state.homeDir) : null;
    if (!spot || !place(winnerCar, spot.lane, spot.s) || !place(loserCar, spot.behind, spot.from)) {
      result();
      return false;
    }
    hideFinish();
    // The winner stays put: the taxi on `parked`, which stops it where it stands (it is already
    // still, under the black), the racer on its chosen stop.
    taxi.route = [];
    taxi.pendingTarget = null;
    car.route = [];
    // Both facing the way they raced (Tyler: "make sure both cars face the same direction...
    // Direction they were racing"), side by side as at the start: the street is one lane each way,
    // so the racer is the one out in the oncoming lane, on the cop pass's offset (`racePass`), held
    // out there by `parkedOut` until the result is in. The taxi stays in its own lane either way.
    car.dragStart = false;
    car.racePass = true;
    car.passing = true;
    car.pass = 1;
    car.passTarget = taxi;
    car.passFrom = car.travelled;
    car.parkedOut = true;
    if (taxiWon) {
      taxi.parked = true;
      car.roadblock = 0;
      car.braking = false;
    } else {
      car.roadblock = Infinity;
      taxi.parked = false;
    }
    state.brakeTaxi = false;
    winnerCar.v = 0;
    loserCar.v = ARRIVAL_ROLL;
    // Nothing more joins the three lanes while it plays out.
    setClosedLanes([spot.lane.id, spot.back.id, spot.behind.id], 'race');
    state.arrival = { lane: spot.lane, stopS: spot.s, goal: spot.goal, braking: false };
    if (taxiWon) { car.chase = ARRIVAL_CHASE; planRacer(car, spot.goal); }
    else routeTo(spot.goal);
    state.step = 'drive-in';
    state.stepT = 0;
    onEvent('arrival', { car, loser: loserCar, winner: winnerCar });
    return true;
  }

  /** Step 5: the word. The money is `finish`, RESULT_HOLD later. */
  function result() {
    state.step = 'result';
    state.stepT = 0;
    onEvent('decided', { car: state.car, winner: state.winner, loser: state.winner === 'taxi' ? state.car : taxi });
  }

  /** The finale's frame: the winner pulling up, the cut, the loser's drive-in, the result. */
  function updateFinale(dt, car) {
    state.stepT += dt;
    const taxiWon = state.winner === 'taxi';
    if (state.step === 'hold') {
      // The winner pulls up where it crossed: the taxi on the race's brake, the racer on its stop.
      if (taxiWon) state.brakeTaxi = true;
      else car.roadblock = Infinity;
      if (state.stepT >= WINNER_HOLD) {
        state.step = 'cut';
        state.stepT = 0;
        onEvent('arrival-cut', { car, winner: state.winner });
      }
    } else if (state.step === 'cut') {
      if (state.stepT >= ARRIVAL_CUT_MAX) stageArrival();
    } else if (state.step === 'drive-in') {
      const loserCar = taxiWon ? car : taxi;
      const a = state.arrival;
      // Steered off by the player (a tap on another street) or out of time: straight to the word.
      const steered = !taxiWon && taxi.pendingTarget !== a.goal;
      if (steered || state.stepT > DRIVE_IN_MAX) { result(); return; }
      // Step 4: the skid. On the hard brake from the point that stops it level with the winner —
      // the fire engine's `tryStop`, with the taxi's pedal for the taxi, and the same distance.
      if (!a.braking && loserCar.lane === a.lane && loserCar.state === 'drive'
          && loserCar.s + stopDistance(loserCar.v) >= a.stopS) {
        a.braking = true;
        if (taxiWon) car.roadblock = Infinity;
        else state.brakeTaxi = true;
        onEvent('skid', { car: loserCar });
      }
      if (a.braking && loserCar.v < 0.05) {
        if (!taxiWon) { state.brakeTaxi = false; taxi.route = []; taxi.pendingTarget = null; taxi.parked = true; }
        result();
      }
    } else if (state.step === 'result' && state.stepT >= RESULT_HOLD) {
      finish(taxiWon ? 'won' : 'lost');
    }
  }

  /**
   * A route for the racer. While it is still out in the oncoming lane off the start (`dragStart`
   * in sim/traffic.js), a right at the next junction would cross the taxi's nose, so that exit is
   * off the table — unless it is the only way there.
   */
  function planRacer(car, goal, base = laneCost) {
    const from = planOrigin(car);
    const right = car.dragStart ? cityNetwork().laneOutByGrid(rightOf(from.d), from.i, from.j) : null;
    const route = (right && findRoute(from, goal, (lane) => (lane === right ? Infinity : base(lane))))
      || findRoute(from, goal, base);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  function steerToFinish(car) {
    if (car.route?.length) return;
    planRacer(car, state.rivalBack ? state.home : state.finish, state.shared ? apart(state.shared) : laneCost);
  }

  /** The faceoff is over: show the finish, and wait for the camera's look at it (`countIn`). */
  function lineUp() {
    const goal = state.finish;
    showFinish();
    setPhase('reveal');
    onEvent('lined-up', { car: state.car, finish: goal, x: lineX(goal.i), z: lineZ(goal.j) });
  }

  /** Start the count — called when the camera is back from the finish, or by `REVEAL_MAX`. */
  /** The look at the finish is done: "Ready?" (or straight to the count, `?raceready=classic`). */
  function countIn() {
    if (state.phase !== 'reveal') return;
    if (!readyGate) { startCount(); return; }
    setPhase('ready');
    state.nagged = false;
    onEvent('ready', { car: state.car });
  }

  /** The tap on "Ready?": three, two, one. */
  function ready() {
    if (state.phase !== 'ready') return false;
    onEvent('readied', { car: state.car });
    startCount();
    return true;
  }

  function startCount() {
    state.count = COUNTDOWN + 1;
    setPhase('countdown');
  }

  function go() {
    const car = state.car;
    setPhase('racing');
    state.races += 1;
    state.taxiTime = null;
    state.rivalTime = null;
    // Both lanes open again at the green, the oncoming one too though the racer is still out in it:
    // kept shut, a car already turning into it stood in the junction for good, and the racer turning
    // left across that junction waited on it for good (measured headless, 1 race in 24). What comes
    // the other way brakes for the racer instead, as it does for a cop (sim/traffic.js).
    setClosedLanes([], 'race');
    taxi.holdsLine = false;
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.chase = rivalChase;
    car.racer = true;
    car.route = [];
    offer.visible = false;
    steerToFinish(car);
    routeTo(state.finish);
    onEvent('go', { car });
  }

  function finish(result) {
    const car = state.car;
    state.lastResult = result;
    if (result === 'won') state.wins += 1;
    else if (result === 'lost') state.losses += 1;
    else state.voids += 1;
    hideFinish();
    onEvent(result, { car, finish: state.finish });
    // The taxi is nobody's now: no route, no target, the board back on. Only if it is still ours —
    // a race that ended because something else took the wheel leaves that something alone.
    if (state.finish && (taxi.pendingTarget === state.finish || taxi.pendingTarget === state.home
        || taxi.pendingTarget === state.arrival?.goal)) {
      taxi.route = [];
      taxi.pendingTarget = null;
    }
    taxi.parked = false;
    state.brakeTaxi = false;
    state.step = null;
    state.arrival = null;
    // Let the racer go from beside the taxi: it finishes the pass (`racePass`) as it pulls away.
    if (car) car.parkedOut = false;
    // A race run, it drives off and comes back DROPS_BETWEEN drop-offs on (`retire`). One called
    // off or declined stays where it is, still offering.
    if (car && !car.crashed && result !== 'won' && result !== 'lost') rest();
    else leave();
  }

  /**
   * The race came to nothing (declined, called off) and the racer goes back to being traffic,
   * offering again after REST_TIME. The
   * finale's money flies to wherever it has got to (main.js), so it does not need to stay put.
   */
  function rest() {
    const car = state.car;
    setClosedLanes([], 'race');
    taxi.holdsLine = false;
    hideFinish();
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.chase = 0;
    car.racer = false;
    car.route = [];
    state.finish = null;
    state.shared = null;
    state.startLanes = null;
    state.asked = false;
    state.available = false;
    state.rest = REST_TIME;
    offer.visible = true;
    setPhase('offer');
  }

  /** Drive off — whether the race was run or the offer lapsed — and dissolve once out of the way. */
  function leave() {
    setClosedLanes([], 'race');
    taxi.holdsLine = false;
    offer.visible = false;
    hideFinish();
    const car = state.car;
    setPhase('leaving');
    if (!car) return;
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.chase = 0;
    car.racer = false;
    car.route = [];
    const exit = { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    state.exit = exit;
    planRacer(car, exit);
  }

  function retire() {
    if (state.car) traffic.retireGuest(state.car);
    state.car = null;
    state.startLanes = null;
    state.finish = null;
    state.shared = null;
    rival.shell.visible = false;
    offer.visible = false;
    hideFinish();
    setClosedLanes([], 'race');
    setPhase('waiting');
    // Gone (a race run, or a wreck): back after another DROPS_BETWEEN drop-offs.
    state.cooldown = soon ? SOON_WAIT * 3 : ARRIVE_WAIT;
    state.dueAt = soon ? 0 : delivered() + rng.int(DROPS_BETWEEN[0], DROPS_BETWEEN[1]);
  }

  function showFinish(at = state.finish) {
    const { i, j } = at;
    finishRing.group.position.set(lineX(i), ROAD_Y + RING_Y, lineZ(j));
    finishRing.appear();
    finishFlag.group.position.set(lineX(i), FINISH_FLAG_Y, lineZ(j));
    finishFlag.group.visible = true;
  }

  function hideFinish() {
    if (finishRing.group.visible) finishRing.vanish();
    finishFlag.group.visible = false;
  }

  const near = (car, target, reach) => Math.hypot(car.x - lineX(target.i), car.z - lineZ(target.j)) < reach;

  // --- Drawing the rival ------------------------------------------------------

  function skin(pos, quat, car) {
    rival.group.position.copy(pos);
    rival.group.quaternion.copy(quat);
    for (const wheel of rival.wheels) wheel.rotation.y = car.wheelAngle;
  }

  /** The rival's body for the wreck effects, if the taxi ever writes it off. */
  function wreck() {
    rival.group.updateMatrixWorld(true);
    const shell = rival.shell.clone(true);
    shell.traverse((o) => {
      if (o.isMesh) {
        o.material = cloneProp(o.material);
        o.material.alphaHash = false;
        o.material.opacity = 1;
      }
    });
    shell.visible = true;
    rival.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    rival.shell.visible = false;
    return shell;
  }

  // --- Frame ------------------------------------------------------------------

  function update(dt) {
    state.t += dt;
    state.phaseT += dt;
    const car = state.car;

    // The taxi wrote it off — the run is ending. Leave the scene as it stands.
    if (car?.crashed) {
      state.car = null;
      offer.visible = false;
    }

    switch (state.phase) {
      case 'waiting':
        if (!blocked() && delivered() >= state.dueAt) {
          state.cooldown -= dt;
          if (state.cooldown <= 0 && !summon()) state.cooldown = RETRY_WAIT;
        }
        break;
      case 'offer': {
        if (!car || car.crashed) { offerOff(car); leave(); break; }
        state.rest = Math.max(0, state.rest - dt);
        // A block of give once it is up, so a taxi driving along the edge of the reach does not
        // flick the tag (and its horn) on and off.
        const near = blockDistance(taxi, car) <= NEAR_BLOCKS + (state.available ? 1 : 0);
        // Out of reach it still offers where the player can see it: pan across the city onto the
        // car and its "…" is there (Tyler: "show the … on the car if the user pans around and sees
        // it. Only show it at edge screen when taxi is 3 blocks near"). So the edge pointer, which
        // only a tag for an off-screen car draws, only ever happens in reach.
        const inView = !near && seen(car, state.available);
        const available = state.rest === 0 && (near || inView) && canStart() && !interrupted();
        if (available && !state.available) {
          state.available = true;
          onEvent('available', { car, near });
        } else if (!available) {
          offerOff(car);
        }
        break;
      }
      case 'cut':
        // Waiting on the black (`stage`). The tools and a page with no wipe call it at once; this
        // is only a backstop for a wipe that never lands.
        if (!car || state.phaseT > 3) finish('void');
        break;
      case 'faceoff':
      case 'reveal': {
        if (!car) { finish('void'); break; }
        // Taken on is taken on (Tyler: "Dont allow declining after you've tapped on 'wanna race'"):
        // main.js ignores taps from the second tap to the green (`locked`), and anything else that
        // routes the taxi meanwhile is undone rather than calling the race off.
        if (taxi.route.length > 0) holdTaxi();
        if (interrupted()) { finish('void'); break; }
        if (state.phase === 'faceoff') {
          if (state.phaseT > FACEOFF) lineUp();
        } else if (state.phaseT > REVEAL_MAX) {
          countIn();
        }
        break;
      }
      case 'ready': {
        if (!car) { finish('void'); break; }
        if (taxi.route.length > 0) holdTaxi();
        if (interrupted()) { finish('void'); break; }
        if (!state.nagged && state.phaseT > READY_NAG) {
          state.nagged = true;
          onEvent('ready-nag', { car });
        }
        if (state.phaseT > READY_MAX) startCount();
        break;
      }
      case 'countdown': {
        if (!car) { finish('void'); break; }
        if (taxi.route.length > 0) holdTaxi();
        const left = Math.ceil(COUNTDOWN - state.phaseT / COUNT_STEP);
        if (left < state.count && left > 0) {
          state.count = left;
          onEvent('count', { n: left });
        }
        if (state.phaseT >= COUNTDOWN * COUNT_STEP) go();
        break;
      }
      case 'finale':
        if (!car) { finish('void'); break; }
        updateFinale(dt, car);
        break;
      case 'racing': {
        if (!car) { finish('void'); break; }
        // There and back: round the flag, and the flag moves home to the start line (the taxi's
        // marker — the racer's own leg is on its ghost route).
        if (!state.taxiBack && near(taxi, state.finish, ARRIVE_RADIUS)) {
          state.taxiBack = true;
          showFinish(state.home);
          routeTo(state.home);
          onEvent('rounded', { car, home: state.home });
        }
        if (!state.rivalBack && near(car, state.finish, ARRIVE_RADIUS)) {
          state.rivalBack = true;
          car.route = [];
        }
        // The taxi's own route can run out short of the corner (a missed turn, a re-plan the
        // player dragged into a lap); put it back on its goal rather than let it cruise. Not once
        // it has won: home and dry, it is the player's again.
        const goal = taxiGoal();
        if (taxi.pendingTarget === goal && !taxi.route.length && !near(taxi, goal, ARRIVE_RADIUS)) {
          routeTo(goal);
        }
        steerToFinish(car);
        const taxiHome = state.taxiBack && near(taxi, state.home, ARRIVE_RADIUS);
        const rivalHome = state.rivalBack && near(car, state.home, ARRIVE_RADIUS);
        // The first one home has won, and the finale plays out the rest (`updateFinale`). The taxi
        // wins a dead heat: it is the one the player is watching cross the line.
        if (taxiHome || rivalHome) {
          state.winner = taxiHome ? 'taxi' : 'rival';
          // The way it was racing when it crossed, which the finish faces (`chooseArrival`).
          const w = taxiHome ? taxi : car;
          state.homeDir = w.state === 'turn' ? w.dOut : w.d;
          if (taxiHome) state.taxiTime = state.phaseT; else state.rivalTime = state.phaseT;
          setPhase('finale');
          state.step = 'hold';
          state.stepT = 0;
          onEvent('home', { car, winner: state.winner });
        } else if (state.phaseT > RACE_MAX) {
          finish('void');
        }
        break;
      }
      case 'leaving':
        if (!car) { retire(); break; }
        {
          const ex = state.exit;
          const home = ex && near(car, ex, EXIT_REACH);
          const away = Math.hypot(car.x - taxi.x, car.z - taxi.z) > SPAWN_CLEARANCE;
          if (state.fading >= 0 && (home || state.phaseT > LEAVE_MAX || (away && state.phaseT > 4))) {
            state.fading = -1;
          }
          if (!car.route?.length && state.fading >= 0 && ex) {
            const route = findRoute(planOrigin(car), ex);
            if (route?.length) { car.route = route; car.routeConsumed = false; }
          }
          if (state.fading < 0 && state.fade <= 0) retire();
        }
        break;
      default:
        break;
    }

    // The rival: dissolve.
    if (state.fading) {
      state.fade = clamp01(state.fade + state.fading * dt / FADE_TIME);
      if (state.fade === 1 && state.fading > 0) state.fading = 0;
    }
    for (const material of rival.faders) material.opacity = state.fade;
    if (rival.shell.visible) pulseStep(glowBeat, bass(), dt);
    pumpFrame(dt);
    {
      const beat = glowBeat.avg < SILENT ? GLOW_IDLE : glowBeat.pulse;
      rival.glow.material.opacity = state.fade * (GLOW_REST + (1 - GLOW_REST) * beat);
      rival.glow.scale.set(1 + GLOW_SWELL * beat, 1, 1 + GLOW_SWELL * beat);
      rival.glow.material.color.copy(glowColor).multiplyScalar(1 + GLOW_HOT * beat);
    }

    // The tap target rides with the car.
    if (offer.visible && state.car) offer.position.set(state.car.x, 0, state.car.z);
    if (finishFlag.group.visible) {
      finishFlag.cloth.rotation.y = Math.sin(state.t * 5.5 + 1) * 0.25;
      finishFlag.group.position.y = FINISH_FLAG_Y + Math.sin(state.t * 2.4) * 0.25;
    }
    if (finishRing.group.visible) finishRing.update(state.t);
  }

  return {
    state,
    update,
    /** Start one now, if the taxi is free and anywhere qualifies — for the tools. */
    summon,
    /** The tap on the racer — see `accept`. */
    ask,
    accept,
    /** Land the start under the black — see `stage`. */
    stage,
    /** Land the finish's cut to the loser under the black — see `stageArrival`. */
    stageArrival,
    /** Is the race holding the taxi's brake (the winner pulling up, the loser skidding in)? */
    brakesTaxi: () => state.brakeTaxi,
    /** The racer's tap target, while it is offering. */
    pickables: () => (offer.visible && state.phase === 'offer' && state.available ? [offer] : []),
    /** Is the racer offering, its tag up and waiting on a tap? */
    offering: () => state.phase === 'offer' && state.available,
    /** Is the board held? From the tap to the line, as for a getaway. */
    holdsBoard: () => ACTIVE.has(state.phase),
    /** From the second tap to the green: taps on the map are ignored (no backing out). */
    locked: () => LOCKED.has(state.phase),
    /** A tap anywhere but the "Wanna race?" card, once it has asked. */
    decline,
    /** Is the taxi taken for a race? The depot and the drive-through refuse it. */
    busy: () => ACTIVE.has(state.phase),
    /** Is anything of a race on, from the tap to the line? */
    active: () => ACTIVE.has(state.phase),
    /** Side by side and the finish shown (main.js, once the camera is back): "Ready?", then the count. */
    countIn,
    /** The tap on the racer's "Ready?": start the count. */
    ready,
    /** Is the start waiting on the camera's look at the finish? */
    revealing: () => state.phase === 'reveal',
    rival,
    /** Every solid part of the rival, for the AO prepass. */
    occluders: rival.occluders,
    /** Where the bubble pins: the rival's roof, or null with no rival on the road. */
    rivalAt: () => (state.car ? { x: state.car.x, z: state.car.z } : null),
    /** Called off a run ending, so a race cannot outlive it. */
    abandon: () => {
      if (state.phase === 'waiting' || state.phase === 'leaving') return;
      taxi.parked = false;
      leave();
    },
    /** For `tools/race.mjs`'s sweep. */
    setRivalChase: (v) => { rivalChase = v; },
    finishRing,
    settle: () => finishRing.settle(),
  };
}
