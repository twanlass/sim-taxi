import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID_I, GRID_J, lineX, lineZ, riverBanks } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  carGeometry, setClosedLanes, isLaneClosed, stageCar, releaseCar, STOP_SETBACK, CAR_LEN, CAR_W,
  CABIN_X, CABIN_TOP, SPAWN_CLEARANCE, ROAD_Y,
} from '../sim/traffic.js';
import { findRoute, planOrigin, estimateSeconds } from './route.js';
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

// The street race. A violet street racer with a wing on it and light under it turns
// up near the empty cab and tails it, calling out the stakes. Tap it and the screen cuts to black
// and opens on the two of them side by side, window to window; the camera goes to look at the
// finish a few blocks away and comes back, and it is three, two, one. Get there first and it pays;
// get there second and it costs.
//
// **Taken on, never imposed.** Losing costs cash, and the robbery's rule is that an imposed event
// cannot cost the run, so the race is a tap like every other choice in the game, and ignoring the
// racer is free: it gives up after OFFER_TIME and drives off.
//
// **Tappable for as long as it is on screen.** The first build parked the racer at a kerb and only
// answered a tap once it got there, and dropped the offer the moment anything else held the run (the
// first drop-off's tutorial tip among them) — so in play a tap usually landed on a car that was not
// offering anything (Tyler: "after I drop off the very first passenger, if I tap on the purple racer,
// nothing happens"). Now the tap target is up from the frame it appears, it follows
// the taxi around rather than waiting somewhere it can be lost (`tail`), and only something that owns
// the run outright (`interrupted`: a getaway, a chase, the run ending) takes it away.
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
// a racer is a share of a chasing cop's kit (`car.chase`): a lifted cruise ceiling, the car in front
// pulling out of its way, and the licence to cross a red on a provably empty junction. There is no
// rubber band. A rival that visibly slowed down to let you catch it, or found speed from nowhere when
// you got ahead, would take the win away from the player along with the loss — so it drives one way
// all race, and what the player has over it is Loco Mode and a route of their own choosing.

// When a racer turns up. Off the run's own clock and only while nothing upstages it (`blocked`),
// like the fire and the roadworks: it is something to take or leave, not pressure.
const FIRST_WAIT = [45, 75];
const REPEAT_WAIT = [100, 160];
const SOON_WAIT = 4;            // ?race=soon
const RETRY_WAIT = 4;           // nothing qualified this time

const OFFER_TIME = 30;          // a racer nobody taps gives up and drives off
// How hard it tails the taxi: a little over traffic, so a cab on its way somewhere does not leave it
// behind, and well short of race pace, so it reads as following rather than chasing.
const TAIL_CHASE = 0.5;
// The tap target: a quad in the screen plane over the car (see the hit-box trap in CLAUDE.md) —
// generous, a car's length or so either side, but no longer reaching up-screen to the top of the
// roof flag it was first sized for (9 tall), which went when the racer stopped flying one.
const HIT_W = 8;
const HIT_H = 6;
// From the cut to the look at the finish: the two of them side by side, close up, long enough to
// take in who is racing whom before the camera leaves.
export const FACEOFF = 1.6;
// Nothing else within this of either car's start, so the cut does not land one inside another car.
const START_CLEAR = 9;
// The camera's look at the finish is main.js's (`countIn`); this is how long the start waits for it
// before counting anyway — a swipe mid-pan drops the peek's callback, and the tools have no camera.
const REVEAL_MAX = 6;
export const COUNTDOWN = 3;     // seconds of three, two, one
const RACE_MAX = 75;            // nobody home by now — the race is called off and nothing changes hands
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
 * the tank is dry: 1/4 tank, the 1/3 floor and a full tank each win 58% (the same 14 of 24), and
 * never touching the pill wins none. Off the earlier pulled-up starts it was 50/58/58 and
 * 63/67/71; at 1.3 the floor won 83%, at 1.8 75%. It was 1.3 when the start was a queue with the rival a car length ahead; window to window,
 * with the two routes evened out, the taxi lost that lead and the kick off the line is all its own.
 * That bot never misses a turn or brushes a car, so a person wins less often than it does — about
 * even is the aim, which the lopsided stakes then pay for.
 */
export const RIVAL_CHASE = 2.0;

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
const ACTIVE = new Set(['cut', 'faceoff', 'reveal', 'countdown', 'racing']);

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
const GLOW_SWELL = 0.6;
const GLOW_HOT = 1.5;
// With no music at all — muted, or between songs — there is no beat to rest between, so it holds
// at GLOW_IDLE of a flare instead of sitting at the dim rest. Silent is a bass level under SILENT
// on the analyser's 0..1 dB scale (music sits around 0.5).
const GLOW_IDLE = 0.6;
const SILENT = 0.05;
const BEAT_AVG = 0.35;
const KICK_RISE = 0.15;
const KICK_FALL = 0.15;

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
// so what reads is the fringe, and 0.8 of it is ~6px all round — a crisp halo. Rounded rather than
// boxed: a superellipse (`GLOW_ROUND`) traced in GLOW_SEGMENTS, because the first cut's rectangle
// read as hard diagonals at the corners (Tyler: "really angular"). The ramp out is a straight one:
// a 1.1-unit reach eased through four rings on a squared curve was tried and read as blurry
// (Tyler: "I like the old less blurry lights better").
const GLOW_REACH = 0.8;
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
    carGeometry(),
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
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  // The body is baked white under the paint (see `carGeometry`), and the wing baked dark, so one
  // multiply paints the car and leaves the wing and the glass dark.
  body.material.color.set(color('racerBody'));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const stripeGeo = stripeGeometry();
  const stripe = new THREE.Mesh(stripeGeo, propMaterial({ gloss: { geometry: stripeGeo, floor: SILL_Y } }));
  stripe.receiveShadow = true;
  shell.add(stripe);

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
  const wheels = wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  // Dissolved in and out rather than blended — the cruiser's and the engine's `alphaHash`.
  const faders = [body.material, stripe.material, wheelMat];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;
  return { group, shell, body, wheels, glow, faders, occluders: [body, stripe, ...wheels] };
}

/**
 * @param rng      its own stream: when, where, and which corner is the finish
 * @param scene    where the rival and the finish are drawn
 * @param traffic  the sim — `enterGuest`, `retireGuest`, `taxi`
 * @param routeTo  main.js's router, `(target) => boolean` — the one that keeps `pendingTarget` and the
 *                 route band honest (see `createBurgerRun` for why it is injected)
 * @param blocked  `() => boolean` — true while no racer may turn up; one that is on is called off
 * @param canStart `() => boolean` — is the taxi free: an empty cab with nowhere it is going
 * @param onEvent  `(type, detail) => void` — everything the player sees off the car: the bubble, the
 *                 count, the money. This module knows a race happened, not what a run's cash is.
 * @param soon     `?race=soon`
 */
export function createRace({
  rng, scene, traffic, routeTo, blocked = () => false, interrupted = () => false, canStart = () => true,
  onEvent = () => {}, soon = false, bass = () => 0,
}) {
  const taxi = traffic.taxi;
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

  const state = {
    // 'waiting' — nothing on; 'offer' — a racer is tailing the taxi, tappable; 'cut' —
    // tapped, the screen going to black (`stage` lands the start under it); 'faceoff' — side by
    // side, close up; 'reveal' — the camera off looking at the finish; 'countdown'; 'racing';
    // 'leaving' — it is over (or nobody took it) and the rival is driving off.
    phase: 'waiting',
    phaseT: 0,
    t: 0,
    cooldown: soon ? SOON_WAIT : rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
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
    races: 0,
    wins: 0,
    losses: 0,
    voids: 0,
    lastResult: null,
    taxiTime: null,
    rivalTime: null,
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
   * The two set off in opposite directions, so for any corner one of them is pointing the right way
   * and the other has a turn or two to make first — on a grid, one of the two junctions they are
   * heading for is always a block nearer. Picked by the router's own estimate of the drive
   * (`estimateSeconds`, the fare clocks' arithmetic) so that gap is as small as the city allows,
   * rather than by blocks, which cannot see the river's three bridges.
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
        const rivalRoute = findRoute(rivalFrom, { i, j });
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
   * Bring a racer on, a couple of blocks off, to tail the taxi. Answers whether one
   * came. Only for an empty cab (`canStart`) — the tap is refused with a rider aboard, so a racer
   * then would be an offer nobody could take.
   */
  function summon() {
    if (!canStart()) return false;
    const all = spots();
    if (!all.length) return false;
    const pool = all.sort((a, b) => Math.abs(a.d - SPOT_IDEAL) - Math.abs(b.d - SPOT_IDEAL)).slice(0, 5);
    const at = rng.pick(pool);
    const car = traffic.enterGuest({ x: at.x, z: at.z }, { isTruck: false });
    if (!car) return false;
    car.skin = skin;
    car.guestWreck = wreck;
    car.route = [];
    car.chase = TAIL_CHASE;
    car.racer = false;
    state.car = car;
    state.finish = null;
    state.startLanes = null;
    rival.group.position.set(car.x, 0, car.z);
    rival.shell.visible = true;
    offer.visible = true;
    state.fade = 0;
    state.fading = 1;
    state.offers += 1;
    setPhase('offer');
    onEvent('challenge', { car, win: WIN_PAY, lose: LOSE_COST });
    return true;
  }

  /**
   * Follow the taxi: routed to the junction it is heading for, re-planned only when that route runs
   * out — never per frame (CLAUDE.md, on re-planning stalling a car).
   */
  function tail(car) {
    if (car.route?.length) return;
    const from = planOrigin(car);
    const to = { i: taxi.i, j: taxi.j };
    if (from.i === to.i && from.j === to.j) return;
    const route = findRoute(from, to);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  /**
   * The tap on the racer. Answers whether the race is on: the screen is about to cut (main.js runs
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
      const crowded = traffic.cars.some((c) => c !== taxi && c !== state.car && !c.crashed
        && (Math.hypot(c.x - p.x, c.z - p.z) < START_CLEAR || Math.hypot(c.x - q.x, c.z - q.z) < START_CLEAR));
      if (crowded) continue;
      best = { lane, s, back, sb, d };
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
   * The cut: both cars put side by side under the black, the finish picked from where each is
   * pointing, and the faceoff begins. main.js calls it from the wipe; the tools call it straight.
   */
  function stage() {
    if (state.phase !== 'cut') return false;
    const car = state.car;
    const start = car && !car.crashed ? chooseStart() : null;
    if (!start || !place(taxi, start.lane, start.s) || !place(car, start.back, start.sb)) {
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
    // Nothing more joins either lane while they stand there, and an oncoming left does not wait on
    // a car that is not coming (`leftYieldBlocked` in sim/traffic.js).
    state.startLanes = [start.lane.id, start.back.id];
    setClosedLanes(state.startLanes, 'race');
    taxi.holdsLine = true;
    car.holdsLine = true;
    const goal = chooseFinish(planOrigin(taxi), planOrigin(car));
    if (!goal) { finish('void'); return false; }
    state.finish = goal;
    setPhase('faceoff');
    onEvent('staged', { car, x: (taxi.x + car.x) / 2, z: (taxi.z + car.z) / 2 });
    return true;
  }

  function steerToFinish(car) {
    if (car.route?.length) return;
    const route = findRoute(planOrigin(car), state.finish);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  /** The faceoff is over: show the finish, and wait for the camera's look at it (`countIn`). */
  function lineUp() {
    const goal = state.finish;
    showFinish();
    setPhase('reveal');
    onEvent('lined-up', { car: state.car, finish: goal, x: lineX(goal.i), z: lineZ(goal.j) });
  }

  /** Start the count — called when the camera is back from the finish, or by `REVEAL_MAX`. */
  function countIn() {
    if (state.phase !== 'reveal') return;
    state.count = COUNTDOWN + 1;
    setPhase('countdown');
  }

  function go() {
    const car = state.car;
    setPhase('racing');
    state.races += 1;
    state.taxiTime = null;
    state.rivalTime = null;
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
    if (state.finish && taxi.pendingTarget === state.finish) {
      taxi.route = [];
      taxi.pendingTarget = null;
    }
    taxi.parked = false;
    leave();
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
    const route = findRoute(planOrigin(car), exit);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  function retire() {
    if (state.car) traffic.retireGuest(state.car);
    state.car = null;
    state.startLanes = null;
    state.finish = null;
    rival.shell.visible = false;
    offer.visible = false;
    hideFinish();
    setClosedLanes([], 'race');
    setPhase('waiting');
    state.cooldown = soon ? SOON_WAIT * 3 : rng.range(REPEAT_WAIT[0], REPEAT_WAIT[1]);
  }

  function showFinish() {
    const { i, j } = state.finish;
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
        if (!blocked()) {
          state.cooldown -= dt;
          if (state.cooldown <= 0 && !summon()) state.cooldown = RETRY_WAIT;
        }
        break;
      case 'offer': {
        if (!car) { retire(); break; }
        if (interrupted() || state.phaseT > OFFER_TIME) {
          onEvent('lapsed', { car });
          leave();
          break;
        }
        tail(car);
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
        // The player said no after all: a tap on a street gives the taxi a route, and a route on a
        // parked taxi un-parks it (sim/traffic.js). Called off, and nothing changes hands.
        if (taxi.route.length > 0) { finish('declined'); break; }
        if (interrupted()) { finish('void'); break; }
        if (state.phase === 'faceoff') {
          if (state.phaseT > FACEOFF) lineUp();
        } else if (state.phaseT > REVEAL_MAX) {
          countIn();
        }
        break;
      }
      case 'countdown': {
        if (!car) { finish('void'); break; }
        if (taxi.route.length > 0) { finish('declined'); break; }
        const left = Math.ceil(COUNTDOWN - state.phaseT);
        if (left < state.count && left > 0) {
          state.count = left;
          onEvent('count', { n: left });
        }
        if (state.phaseT >= COUNTDOWN) go();
        break;
      }
      case 'racing': {
        if (!car) { finish('void'); break; }
        // The taxi's own route can run out short of the corner (a missed turn, a re-plan the
        // player dragged into a lap); put it back on the finish rather than let it cruise.
        if (taxi.pendingTarget === state.finish && !taxi.route.length && !near(taxi, state.finish, ARRIVE_RADIUS)) {
          routeTo(state.finish);
        }
        steerToFinish(car);
        const taxiHome = near(taxi, state.finish, ARRIVE_RADIUS);
        const rivalHome = near(car, state.finish, ARRIVE_RADIUS);
        // The taxi wins a dead heat: it is the one the player is watching cross the line.
        if (taxiHome) { state.taxiTime = state.phaseT; finish('won'); break; }
        if (rivalHome) { state.rivalTime = state.phaseT; finish('lost'); break; }
        if (state.phaseT > RACE_MAX) finish('void');
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
    accept,
    /** Land the start under the black — see `stage`. */
    stage,
    /** The racer's tap target, while it is offering. */
    pickables: () => (offer.visible && state.phase === 'offer' ? [offer] : []),
    /** Is a racer tailing the taxi, waiting on a tap? */
    offering: () => state.phase === 'offer',
    /** Is the board held? From the tap to the line, as for a getaway. */
    holdsBoard: () => ACTIVE.has(state.phase),
    /** Is the taxi taken for a race? The depot and the drive-through refuse it. */
    busy: () => ACTIVE.has(state.phase),
    /** Is anything of a race on, from the tap to the line? */
    active: () => ACTIVE.has(state.phase),
    /** Side by side and the finish shown: count down now (main.js, once the camera is back). */
    countIn,
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
