import * as THREE from 'three';
import { BODY_EULER_ORDER } from '../util/geo.js';
import { KERB_H, PARK_EDGE } from '../city/ground.js';
import { birdBodyGeometry, birdWingGeometry, BIRD_STAND_Y, WING_ROOT } from '../geometry/bird.js';

// A flock living in the city's parks. It potters about on the grass, takes off — often because the
// taxi came past — climbs out and fades into the distance, then comes back in from somewhere else
// a while later and lands. Pure scenery: nothing routes around it, nothing collides with it,
// nothing can be tapped on it, and neither the fare loop nor the difficulty curve knows it exists.
// The model is in geometry/bird.js; this is the life.
//
// **A city runs more than one of these.** `main.js` builds two, each on its own seed offset, and
// hands each an `avoid` callback so they claim different lawns — a 5×5 city has two to five green
// areas and one flock left all but one empty. Nothing here is shared between them: two flocks are
// two independent lives that happen to keep out of each other's park, which is also why a second
// one costs nothing to reason about. See `pickArea`.
//
// It lives in `game/` beside the flyover, the dust and the flames rather than in `sim/` beside the
// traffic, for the same reason the aeroplane does: `sim/` is the cars, the signals and the things
// the player can hit, and this is an effect. It reads `city/` for the parks and for the height of
// the grass, which is the direction the dependency rule allows.
//
// **The whole flock is three draw calls**, not three per bird: one InstancedMesh for the bodies and
// one per wing side. A wing beat is a rotation about the shoulder, and a rotation about a fixed
// point in the body's own frame is expressible in an instance matrix — so the articulation costs
// nothing that a static instanced prop wouldn't.

const FLOCK = [6, 10];

// The grass, and where a bird's origin has to sit for its feet to be on it. `city/ground.js` paints
// a park surface 0.01 above the kerb it is inset into.
const PARK_Y = KERB_H + 0.01;
const STAND_Y = PARK_Y + BIRD_STAND_Y;

// How high the highest bird may be for the flock to still cast shadows — see `pose()` for why it
// stops. Exported so tools/probe.mjs asserts against the same number rather than one that reads
// like it.
export const SHADOW_CEILING = PARK_Y + 0.9;

// How far inside a park's own bounds a bird may walk. The green starts `PARK_EDGE` in from the
// block bounds — the kerb plus the walk that rings it — and a bird is 1.3 units long, so this is
// that edge plus most of a bird, which keeps the whole thing on grass rather than half of it over
// the pavement. Derived rather than written down: it was the bare 0.15 of kerb until the parks
// grew a walk, and a hard-coded 1.2 would have put the flock on the paving the day they did.
const PARK_INSET = PARK_EDGE + 1.05;

// --- The rhythm ------------------------------------------------------------------
// The same brief the flyover has: often enough that a run gets several, rare enough that each one
// is a thing you notice. Deliberately not on the difficulty curve — nothing about this is pressure.
const GROUND_STAY = [26, 52];    // s of pottering before they leave of their own accord
const AWAY_WAIT = [11, 22];      // s out of sight between visits
// How long after landing before the taxi can startle them. Without it the flock is unplayable as
// scenery: a park sits one block off two streets, so the taxi passes within the startle range
// several times a minute and the birds would spend the run in the air. This is what keeps a
// take-off the *answer* to a car going past rather than the default state.
export const SETTLE_MIN = 11;
// A road centreline is 6 units from a bird a couple of units inside the park, so this fires on a
// taxi in the near lane and not on one a street over.
export const STARTLE_RANGE = 8;

// --- Walking ---------------------------------------------------------------------
const WALK_SPEED = [0.32, 0.68];
const WALK_TURN = 3.4;           // rad/s — a bird pivots on the spot far faster than it walks
const WANDER = 3.6;              // how far the next target may be from the last
const PAUSE = [0.5, 2.4];        // s standing at a target before choosing the next
const STEP_RATE = 16;            // radians of gait per unit walked, i.e. about 1.3 steps/second
const BOB = 0.03;                // the up-down of the gait
const WADDLE = 0.12;             // yaw wobble, and
const LIST = 0.11;               // roll, both on the gait
// The peck: a fast dip of the whole body, which takes the tail up as the bill goes down. Only ever
// while stopped — a bird that pecks mid-stride reads as one that tripped.
const PECK_RATE = 1.1;           // expected pecks per second of standing about
const PECK_TIME = 0.42;
const PECK_DIP = 0.8;            // radians, nose down

// --- Flight ----------------------------------------------------------------------
const CRUISE = 9.2;              // units/s level — about the ambient traffic's speed
const LAND_SPEED = 0.9;
const ACCEL = 7.5;
// The leap. A bird does not roll down a runway: it throws itself upward on the first two beats and
// converts that into forward speed afterwards, and getting this wrong is what makes a take-off
// read as a model being slid along an invisible ramp.
const LEAP_VY = 4.6;
const LEAP_TIME = 0.55;
const CLIMB = 2.8;               // units/s once the leap is spent
const ALT = [17, 23];            // the ceiling they climb toward; see the fade note below
const STAGGER = 0.45;            // s of spread across the flock's launches
const SPREAD = 0.34;             // radians of spread across their headings
const FLARE_DIST = 4;            // where the approach starts braking onto the spot
const FLARE_PITCH = 0.55;        // nose-up at touchdown

const PITCH_GAIN = 0.16;         // radians of pitch per unit/s of climb or descent
const ROLL_AMP = 0.2;
const ROLL_RATE = 1.15;

const FLAP_RATE = [12, 20];      // rad/s cruising, and on the leap
const FLAP_AMP = 0.95;
// Wings don't beat at a constant amplitude — the beat swells and eases as a bird trades height for
// distance. One slow envelope per bird, phase-offset, so a flock never beats in unison.
const FLAP_SWELL = 0.62;
// The folded pose: swept back along the body and drooped onto the flank, which is where a wing
// sits on a bird that is walking.
//
// A real bird folds at the wrist and halves its wing; this one is a rigid panel, so the only way
// to get it out of the silhouette is to lay it *along* the body. 1.18 rad was the first attempt —
// 68°, which still left 22° of wing sticking out past the tail on both sides, and a standing bird
// read as one that had hurt itself. At 1.45 the tip lands at x −0.60 against a tail that ends at
// −0.63, so the wing disappears into the bird's own outline and the walking silhouette is the body.
// (Both in the model's own units, before `BIRD_SCALE` — it moves them together, so an angle picked
// against those two numbers stays right at any size.)
const FOLD_SWEEP = 1.45;
// Dropped far enough to sit beside the back rather than on top of it, which is what keeps the two
// wings from meeting in a flat line down the spine.
const FOLD_DROOP = -0.25;

// --- Fades -----------------------------------------------------------------------
// Distance from where they took off, solid to gone. They are still climbing when they reach the
// far end — the ceiling above is a cap they rarely get to — so the fade is what ends a departure,
// not the altitude. Deliberately over a long band: a flock that winks out reads as a bug, and a
// flock that shrinks and softens over 25 units reads as one that got away.
const FADE_OUT = [17, 42];
// And the return, measured the same way from the park they are heading for. `RETURN_DIST` is where
// a leg begins, which is past the end of the fade — so they are already invisible when they are
// placed, and the first thing the player can see is a smudge that resolves into birds.
const RETURN_DIST = 62;
const FADE_IN = [40, 62];        // solid at 40 units out, gone at 62

/** World forward for a heading — the convention `dirYaw` sets: yaw 0 points down +X. */
const heading = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/** Signed shortest way round from `a` to `b`. */
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 0 at `zero`, 1 at `one`, either way round. */
const ramp = (v, one, zero) => clamp((v - zero) / (one - zero), 0, 1);

const POSE_EULER = new THREE.Euler();

/**
 * The rotation a bird's body wears, from the three angles every body in the project is posed with.
 *
 * `BODY_EULER_ORDER`, not the default — see the note on it in util/geo.js. Three composes 'XYZ' as
 * Rx·Ry·Rz, which puts the roll outside the yaw and turns it about the *world* X axis: a bird
 * flying east would bank correctly and one flying north would render the same number as pitch and
 * not bank at all. Exported so `tools/probe.mjs` can assert the lean off the call site rather than
 * off a string.
 */
export function bodyQuaternion(roll, yaw, pitch, out) {
  return out.setFromEuler(POSE_EULER.set(roll, yaw, pitch, BODY_EULER_ORDER));
}

// --- Plumage ---------------------------------------------------------------------
// The morphs of a feral flock, as multipliers over the baked vertex colours (see the note beside
// `tints` in createBirds). Weights are cumulative rolls in `birdTint`: about half the flock keeps
// the classic grey, and the rest split between pale, blue-grey and green-sheen birds — the mix a
// real pigeon flock wears, and enough of the grey majority that the coloured birds read as
// variation rather than as a different species.
//
// The pale morph lifts the whole bird: the body (#6E7688, luma 118) comes out at 177–206 —
// clearly lighter than the grass at 134 where the base bird is darker than it — and the head patch
// clips toward white, which is fine on a top surface that was already the bird's one highlight.
// It stops short of a pure-white scalar because the base keeps its slight blue lean under any grey
// multiplier, and that lean is what separates a pale bird from the unclaimed-passenger marker's
// true white.
//
// The two hue morphs bend the base's own blue-grey rather than painting a colour on: channel
// ratios stay within ±16%, so the result is greyed the way iridescence at a distance is, and
// nowhere near the saturation the urgency scale owns. Measured against the base body: the blue
// morph lands near rgb(93, 115, 158) and the green near rgb(97, 127, 125) — a teal lean, kept off
// the park's yellow-green (#6F9A5A) so a green bird still separates from the lawn under it.
const PALE_LIFT = [1.5, 1.75];
const BLUE_TINT = [0.85, 0.97, 1.16];
const GREEN_TINT = [0.88, 1.08, 0.92];

/** One bird's plumage: a colour multiplier shared by its body and both wings. */
export function birdTint(rng) {
  const roll = rng.next();
  if (roll < 0.2) return new THREE.Color().setScalar(rng.range(PALE_LIFT[0], PALE_LIFT[1]));
  // The hue morphs keep the grey jitter's light/dark spread on top of the hue, narrowed a touch —
  // a dark bird is fine, a dark *and* strongly tinted one starts to read as painted.
  const shade = rng.range(0.9, 1.08);
  if (roll < 0.36) return new THREE.Color(...BLUE_TINT).multiplyScalar(shade);
  if (roll < 0.5) return new THREE.Color(...GREEN_TINT).multiplyScalar(shade);
  // The common bird: the pure grey jitter the whole flock used to draw from.
  return new THREE.Color().setScalar(rng.range(0.86, 1.12));
}

/** Every green area a flock could live in: the merged districts first, then the pocket parks. */
export function parkAreas(layout) {
  const areas = [];
  for (const district of layout.districts ?? []) areas.push(district.bounds);
  for (const block of layout) {
    if (block.type !== 'park') continue;
    if (block.districtId !== null && block.districtId !== undefined) continue;
    areas.push(block.bounds);
  }
  return areas.filter((a) => a.x1 - a.x0 > PARK_INSET * 2.5 && a.z1 - a.z0 > PARK_INSET * 2.5);
}

/**
 * One flock, settled in a park and left to get on with it.
 *
 * @param avoid  called with this flock's own `state`, returning the areas other flocks are using —
 *               see `pickArea`. A callback rather than a list because the other flocks move too,
 *               and it is handed our own `state` so a caller holding all of them can drop *this*
 *               one from the list by identity, without the two ends having to agree on an index.
 *               The default makes a lone flock behave exactly as it did before there were two.
 */
export function createBirds(scene, rng, layout, { avoid = () => [] } = {}) {
  const group = new THREE.Group();
  group.name = 'birds';
  scene.add(group);

  const areas = parkAreas(layout);
  const state = {
    mode: 'none',                // 'ground' | 'up' | 'gone' | 'in'
    area: null,
    fade: 0,
    flights: 0,
    landings: 0,
    settled: 0,                  // s since the last bird touched down
    stay: 0,                     // s until they leave of their own accord
    wait: 0,                     // s of being away left to run
    alt: ALT[0],
    launch: { x: 0, z: 0 },
    t: 0,
  };

  // A city with no park at all is a seed the layout generator has never actually produced — both
  // districts would have to fail their 60 placement attempts *and* every one of the 25 blocks would
  // have to miss its pocket-park roll. Returning a stub rather than throwing keeps that from being
  // the one thing that takes a run down, since nothing here matters to the game.
  if (!areas.length) {
    return {
      group, state, birds: [], meshes: [], material: null,
      update: () => {}, takeOff: () => {}, settle: () => {}, centre: () => ({ x: 0, z: 0 }),
    };
  }

  const count = rng.int(FLOCK[0], FLOCK[1]);

  // One material for all three meshes, so the fade is a single opacity write.
  //
  // Deliberately **not** `propMaterial()`, for the reason the aeroplane isn't either: that recipe
  // carries the screen-space AO lookup, and a mesh that receives occlusion without being in the
  // depth prepass wears the occlusion of whatever stands behind it (see the occluder rule in
  // docs/rendering.md). These are in front of trees and buildings for most of their lives. They
  // cannot go into the prepass either — they are transparent, for the two fades. With AO off the
  // two materials are the same material anyway.
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    transparent: true,
  });

  const body = new THREE.InstancedMesh(birdBodyGeometry(), material, count);
  const wings = [-1, 1].map((side) => {
    const mesh = new THREE.InstancedMesh(birdWingGeometry(side), material, count);
    mesh.userData.side = side;
    return mesh;
  });
  const meshes = [body, ...wings];

  // Per-bird variety: a multiplier on top of the baked vertex colours, so every part of a bird —
  // flank, head, bill — moves together and one bird is a recoloured version of the same bird.
  // Drawn once and shared by all three meshes, or a bird would wear one shade on its body and
  // another on each wing.
  //
  // This started as a pure grey jitter; the flock now mixes in feral-pigeon morphs — some birds
  // near-white, some blue-grey, some with a green sheen. The hues stay muted and greyed on
  // purpose: the palette note on `birdBody` explains why a bird must never be a saturated pixel
  // of colour (that is the description of a fare marker), and the pale morph stops short of pure
  // white because white *is* the unclaimed-passenger marker. See `birdTint`.
  //
  // `instanceColor` is RGB only, which is exactly what this needs. Per-instance *alpha* would want
  // a custom attribute and an `onBeforeCompile` patch — and the fades are flock-wide anyway, so
  // one opacity on the shared material covers them.
  const tints = [];
  for (let i = 0; i < count; i++) tints.push(birdTint(rng));

  for (const mesh of meshes) {
    // A moving InstancedMesh must not be frustum-culled. Three computes its bounding sphere once,
    // on the first frame the renderer culls it, from the instance matrices as they stood *then* —
    // and never again. The ambient traffic learned this the hard way (see the trap list in
    // CLAUDE.md); a flock that spends its life crossing the map would latch a sphere around one
    // park and vanish the moment it left.
    mesh.frustumCulled = false;
    // Shadows are switched per frame — see `pose()`. `receiveShadow` is unconditional: a bird
    // walking under a tree ought to go into its shade, and that costs nothing to leave on.
    mesh.receiveShadow = true;
    group.add(mesh);

    for (let i = 0; i < count; i++) mesh.setColorAt(i, tints[i]);
    mesh.instanceColor.needsUpdate = true;
  }

  const birds = [];
  for (let i = 0; i < count; i++) {
    birds.push({
      x: 0, y: STAND_Y, z: 0,
      yaw: 0, roll: 0, pitch: 0, wobble: 0,
      flap: FOLD_DROOP, sweep: FOLD_SWEEP, flapPhase: rng.range(0, Math.PI * 2),
      phase: rng.range(0, Math.PI * 2),
      walk: rng.range(WALK_SPEED[0], WALK_SPEED[1]),
      tx: 0, tz: 0, dwell: 0, stepPhase: rng.range(0, Math.PI * 2), peck: 0, moving: false,
      // Flight
      speed: 0, vy: 0, airT: 0, delay: 0, yawWant: 0,
      // The return leg: a straight line from an entry point to a landing spot.
      ex: 0, ez: 0, lx: 0, lz: 0, u: 1, pathLen: 1, down: true,
    });
  }

  const inside = (area) => ({
    x0: area.x0 + PARK_INSET, x1: area.x1 - PARK_INSET,
    z0: area.z0 + PARK_INSET, z1: area.z1 - PARK_INSET,
  });

  function spotIn(area) {
    const b = inside(area);
    return { x: rng.range(b.x0, b.x1), z: rng.range(b.z0, b.z1) };
  }

  /**
   * A lawn to put down on: one no other flock has claimed, and — when asked — not the one we just
   * left. Both are wants rather than rules, and **which one gives way first is the whole of this
   * function**: keeping off another flock's green outranks getting a change of scene.
   *
   * Half the cities the generator makes have exactly two green areas big enough for a flock, which
   * with two flocks means the pair fills the map. Ask those two wants in the other order and every
   * return leg in such a city has to land on the other flock's lawn to satisfy the change of scene
   * — 4,700 frames of the two piled onto one green in a ten-minute probe run, which was the first
   * version of this. Giving up the move instead costs a flock nothing a player can see: it comes
   * back to the park it left, having been away and out of sight for twenty seconds.
   *
   * The last fallback is a city with one park, or none free — neither of which the layout generator
   * has produced — and it lands somewhere rather than leaving a flock circling.
   */
  function pickArea(notThis = null) {
    const taken = avoid(state);
    const free = areas.filter((a) => !taken.includes(a));
    const fresh = free.filter((a) => a !== notThis);
    if (fresh.length) return rng.pick(fresh);
    if (free.length) return rng.pick(free);
    const moved = areas.filter((a) => a !== notThis);
    return rng.pick(moved.length ? moved : areas);
  }

  function newTarget(bird) {
    const b = inside(state.area);
    bird.tx = clamp(bird.x + rng.jitter(WANDER), b.x0, b.x1);
    bird.tz = clamp(bird.z + rng.jitter(WANDER), b.z0, b.z1);
  }

  function centre() {
    let x = 0;
    let z = 0;
    for (const bird of birds) { x += bird.x; z += bird.z; }
    return { x: x / birds.length, z: z / birds.length };
  }

  // --- Poses -----------------------------------------------------------------------

  const MAT = new THREE.Matrix4();
  const WING_MAT = new THREE.Matrix4();
  const QUAT = new THREE.Quaternion();
  const WING_QUAT = new THREE.Quaternion();
  const POS = new THREE.Vector3();
  const WING_POS = new THREE.Vector3();
  const SCALE = new THREE.Vector3(1, 1, 1);
  const WING_EULER = new THREE.Euler();

  function pose() {
    let highest = -Infinity;

    for (let i = 0; i < birds.length; i++) {
      const bird = birds[i];
      highest = Math.max(highest, bird.y);

      MAT.compose(
        POS.set(bird.x, bird.y, bird.z),
        bodyQuaternion(bird.roll, bird.yaw + bird.wobble, bird.pitch, QUAT),
        SCALE,
      );
      body.setMatrixAt(i, MAT);

      for (const wing of wings) {
        const side = wing.userData.side;
        // Rotating about +X takes +Z toward -Y, so the right wing (+Z) has to take the *negative*
        // of the flap angle to come up and the left the positive. Same story for the sweep about
        // Y. Getting either sign wrong leaves every formula self-consistent and the bird beating
        // one wing up while the other goes down, so `tools/probe.mjs` asserts both tips rise
        // together rather than trusting this paragraph.
        WING_MAT.compose(
          WING_POS.set(WING_ROOT.x, WING_ROOT.y, side * WING_ROOT.z),
          WING_QUAT.setFromEuler(WING_EULER.set(-side * bird.flap, -side * bird.sweep, 0, 'YXZ')),
          SCALE,
        );
        wing.setMatrixAt(i, WING_MAT.premultiply(MAT));
      }
    }

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      // Shadows only while the whole flock is on the deck, which is also the only time it is fully
      // opaque. Two reasons, and either would be enough on its own: the shadow pass ignores a
      // material's opacity, so a faded-out flock would keep throwing hard shadows across the city
      // long after it stopped being drawn; and the sun sits 28.5° up, so a shadow cast from any
      // real altitude lands two units away per unit of height and reads as a smudge crossing a
      // street with nothing above it — the aeroplane's problem, in miniature. 0.9 units is where
      // the offset reaches a bird's own length, and a flock is a fifth of a second past its leap
      // by then with the eye on the birds rather than the grass.
      mesh.castShadow = highest < SHADOW_CEILING;
    }

    material.opacity = state.fade;
  }

  // --- Walking about ---------------------------------------------------------------

  function walk(bird, dt) {
    if (bird.dwell > 0) {
      bird.dwell -= dt;
      bird.moving = false;
      if (bird.peck > 0) bird.peck -= dt;
      else if (bird.dwell > PECK_TIME && rng.chance(PECK_RATE * dt)) bird.peck = PECK_TIME;
    } else {
      const dx = bird.tx - bird.x;
      const dz = bird.tz - bird.z;
      if (Math.hypot(dx, dz) < 0.12) {
        bird.dwell = rng.range(PAUSE[0], PAUSE[1]);
        newTarget(bird);            // chosen now, walked to when the pause runs out
        bird.moving = false;
      } else {
        const want = Math.atan2(-dz, dx);
        bird.yaw += clamp(wrapAngle(want - bird.yaw), -WALK_TURN * dt, WALK_TURN * dt);
        const step = bird.walk * dt;
        const f = heading(bird.yaw);
        bird.x += f.x * step;
        bird.z += f.z * step;
        bird.stepPhase += step * STEP_RATE;
        bird.moving = true;
      }
    }

    bird.y = STAND_Y + (bird.moving ? BOB * Math.abs(Math.sin(bird.stepPhase)) : 0);
    bird.roll = bird.moving ? LIST * Math.sin(bird.stepPhase) : 0;
    bird.wobble = bird.moving ? WADDLE * Math.sin(bird.stepPhase * 0.5) : 0;
    // One dip and back up over PECK_TIME, so it lands on zero at both ends and never snaps.
    bird.pitch = bird.peck > 0 ? -PECK_DIP * Math.sin(Math.PI * (1 - bird.peck / PECK_TIME)) : 0;
    bird.flap = FOLD_DROOP;
    bird.sweep = FOLD_SWEEP;
  }

  /** Wing beat and body roll, shared by both airborne legs. */
  function fly(bird, dt, rate) {
    bird.flapPhase += rate * dt;
    const swell = 1 - FLAP_SWELL * 0.5 * (1 - Math.sin(state.t * 0.7 + bird.phase));
    bird.flap = FLAP_AMP * swell * Math.sin(bird.flapPhase);
    bird.sweep = 0;
    bird.roll = ROLL_AMP * Math.sin(state.t * ROLL_RATE + bird.phase);
    bird.wobble = 0;
    bird.peck = 0;
  }

  // --- Leaving ---------------------------------------------------------------------

  /**
   * Send the flock up. Public so shot mode can stage a take-off rather than wait one out — the
   * same reason `flyover.launch()` is.
   *
   * @param away  a heading to leave on, or null for a random one
   */
  function takeOff(away = null) {
    if (state.mode !== 'ground') settle();
    const yaw = away ?? rng.range(0, Math.PI * 2);
    state.launch = centre();
    state.alt = rng.range(ALT[0], ALT[1]);
    state.mode = 'up';
    state.flights += 1;
    for (const bird of birds) {
      bird.yawWant = yaw + rng.jitter(SPREAD);
      bird.delay = rng.range(0, STAGGER);
      bird.speed = 0;
      bird.vy = 0;
      bird.airT = 0;
      bird.down = false;
    }
  }

  function updateUp(dt) {
    for (const bird of birds) {
      if (bird.delay > 0) {
        bird.delay -= dt;
        walk(bird, dt);             // still on the grass, still stepping about
        continue;
      }
      bird.airT += dt;
      const leaping = bird.airT < LEAP_TIME;
      // The leap decays across its own window rather than cutting to the climb rate, so the nose
      // comes down through the transition instead of snapping level.
      bird.vy = leaping
        ? LEAP_VY * (1 - 0.4 * (bird.airT / LEAP_TIME))
        : CLIMB;
      bird.y = Math.min(bird.y + bird.vy * dt, PARK_Y + state.alt);
      bird.speed = Math.min(CRUISE, bird.speed + ACCEL * dt);
      bird.yaw += clamp(wrapAngle(bird.yawWant - bird.yaw), -WALK_TURN * dt, WALK_TURN * dt);

      const f = heading(bird.yaw);
      bird.x += f.x * bird.speed * dt;
      bird.z += f.z * bird.speed * dt;

      fly(bird, dt, leaping ? FLAP_RATE[1] : FLAP_RATE[0]);
      bird.pitch = clamp(bird.vy * PITCH_GAIN, -0.5, 0.85);
    }

    const c = centre();
    state.fade = ramp(Math.hypot(c.x - state.launch.x, c.z - state.launch.z), FADE_OUT[0], FADE_OUT[1]);
    if (state.fade <= 0) {
      state.mode = 'gone';
      state.wait = rng.range(AWAY_WAIT[0], AWAY_WAIT[1]);
      group.visible = false;
    }
  }

  // --- Coming back -----------------------------------------------------------------

  function beginReturn() {
    // Usually a different park. The flock is the same flock either way — what moves is where it
    // decided to spend the afternoon, and a city whose birds only ever use one lawn is a city with
    // one lawn worth looking at.
    //
    // And *always* a different one if another flock moved onto our green while we were away: two
    // flocks stacked on one lawn is the single arrangement the pair exists to avoid, and coming
    // home to it would undo the separation a whole run had been keeping.
    const occupied = avoid(state).includes(state.area);
    if (areas.length > 1 && (occupied || rng.chance(0.6))) state.area = pickArea(state.area);
    const area = state.area;
    const cx = (area.x0 + area.x1) / 2;
    const cz = (area.z0 + area.z1) / 2;
    const approach = rng.range(0, Math.PI * 2);
    const f = heading(approach);
    state.alt = rng.range(ALT[0], ALT[1]);
    state.mode = 'in';
    state.fade = 0;
    group.visible = true;

    for (const bird of birds) {
      const spot = spotIn(area);
      // Spread across the line of approach, so the flock arrives as a loose skein rather than a
      // column — and so the path lengths differ, which is what staggers the touchdowns.
      const across = rng.jitter(7);
      bird.ex = cx + f.x * RETURN_DIST - f.z * across;
      bird.ez = cz + f.z * RETURN_DIST + f.x * across;
      bird.lx = spot.x;
      bird.lz = spot.z;
      bird.pathLen = Math.max(1, Math.hypot(bird.lx - bird.ex, bird.lz - bird.ez));
      bird.x = bird.ex;
      bird.z = bird.ez;
      // The same expression `updateIn` evaluates at u = 0, so the first frame of the leg doesn't
      // step the flock by a stand height. Invisible either way at this distance, and a placement
      // that disagrees with the path it starts is the kind of thing that stops being invisible
      // the moment somebody shortens the fade.
      bird.y = STAND_Y + state.alt;
      bird.yaw = Math.atan2(-(bird.lz - bird.ez), bird.lx - bird.ex);
      bird.speed = CRUISE * rng.range(0.88, 1.06);
      bird.u = 0;
      bird.down = false;
    }
  }

  function updateIn(dt) {
    let allDown = true;

    for (const bird of birds) {
      if (bird.down) { walk(bird, dt); continue; }
      allDown = false;

      const remaining = bird.pathLen * (1 - bird.u);
      const flare = clamp(remaining / FLARE_DIST, 0, 1);
      const speed = LAND_SPEED + (bird.speed - LAND_SPEED) * flare;
      bird.u = Math.min(1, bird.u + (speed * dt) / bird.pathLen);

      bird.x = bird.ex + (bird.lx - bird.ex) * bird.u;
      bird.z = bird.ez + (bird.lz - bird.ez) * bird.u;
      const wasY = bird.y;
      // Descend early and flatten late — the shape of an approach, rather than a straight glide
      // that would have to stop dead at the grass.
      bird.y = STAND_Y + state.alt * (1 - bird.u) ** 1.5;
      bird.vy = dt > 0 ? (bird.y - wasY) / dt : 0;

      // Beating harder as it slows: a bird holds itself up on its wings once there is no speed
      // left to do it, which is the whole look of a landing.
      fly(bird, dt, FLAP_RATE[0] + (FLAP_RATE[1] - FLAP_RATE[0]) * (1 - flare));
      bird.pitch = clamp(bird.vy * PITCH_GAIN, -0.6, 0.3) + FLARE_PITCH * (1 - flare);

      if (bird.u >= 1) {
        bird.down = true;
        bird.y = STAND_Y;
        bird.pitch = 0;
        bird.roll = 0;
        bird.dwell = rng.range(PAUSE[0], PAUSE[1]);
        bird.stepPhase = 0;
        newTarget(bird);
      }
    }

    const c = centre();
    const area = state.area;
    const dist = Math.hypot(c.x - (area.x0 + area.x1) / 2, c.z - (area.z0 + area.z1) / 2);
    state.fade = ramp(dist, FADE_IN[0], FADE_IN[1]);

    if (allDown) {
      state.mode = 'ground';
      state.settled = 0;
      state.stay = rng.range(GROUND_STAY[0], GROUND_STAY[1]);
      state.landings += 1;
      state.fade = 1;
    }
  }

  // --- On the grass ----------------------------------------------------------------

  function updateGround(dt, taxi) {
    state.settled += dt;
    state.stay -= dt;
    for (const bird of birds) walk(bird, dt);
    state.fade = 1;

    if (state.settled < SETTLE_MIN) return;

    // A car coming past is the reason a flock goes up, and making that the *player's* car is what
    // ties an ambient effect to the game without it costing the game anything. They leave away
    // from it, which is the only part of a startle that has to look deliberate.
    if (taxi) {
      for (const bird of birds) {
        if (Math.hypot(bird.x - taxi.x, bird.z - taxi.z) < STARTLE_RANGE) {
          const c = centre();
          takeOff(Math.atan2(-(c.z - taxi.z), c.x - taxi.x) + rng.jitter(0.5));
          return;
        }
      }
    }

    if (state.stay <= 0) takeOff();
  }

  /** Put the flock down in a park, walking, as if it had just landed. */
  function settle(area = null) {
    state.area = area ?? pickArea();
    state.mode = 'ground';
    state.settled = 0;
    state.stay = rng.range(GROUND_STAY[0], GROUND_STAY[1]);
    state.fade = 1;
    group.visible = true;
    for (const bird of birds) {
      const spot = spotIn(state.area);
      bird.x = spot.x;
      bird.z = spot.z;
      bird.y = STAND_Y;
      bird.yaw = rng.range(0, Math.PI * 2);
      bird.roll = 0;
      bird.pitch = 0;
      bird.wobble = 0;
      bird.dwell = rng.range(0, PAUSE[1]);
      bird.peck = 0;
      bird.down = true;
      bird.u = 1;
      newTarget(bird);
    }
    pose();
  }

  function update(dt, taxi = null) {
    if (state.mode === 'gone') {
      state.wait -= dt;
      if (state.wait <= 0) beginReturn();
      return;
    }

    state.t += dt;
    if (state.mode === 'ground') updateGround(dt, taxi);
    else if (state.mode === 'up') updateUp(dt);
    else updateIn(dt);

    // `updateUp` can end the departure on this very frame, at which point the flock is not drawn
    // and its matrices are of no interest — but posing anyway costs a few dozen matrix composes
    // and keeps the instance buffers agreeing with the state they were left in.
    pose();
  }

  settle();

  return { group, state, birds, meshes, material, update, takeOff, settle, centre };
}
