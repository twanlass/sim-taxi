import * as THREE from 'three';
import { birdBodyGeometry, BIRD_LEN } from '../geometry/bird.js';
import { POND_WATER_Y } from '../city/pond.js';
import { bodyQuaternion, birdTint } from './birds.js';

// The birds on the pond. They paddle from one end of it to the other, sit for a while, tip forward
// to dabble, and never leave — which is the whole difference between these and the flock in
// birds.js. That one has a life: it potters, gets startled, climbs out and comes back. This is
// three or four bodies drifting on forty pixels of water, and anything more elaborate would be
// spent on something the player sees out of the corner of their eye while driving.
//
// **The model is the flock's own bird**, unscaled and otherwise untouched. A duck built from
// scratch would be a second bird geometry to keep in step for a silhouette ten pixels long, and at
// that size a duck and a pigeon differ in exactly one thing — that one of them is sitting in water.
// The waterline does the work: the body rides low enough that its belly is under the surface, and
// the legs, which are the part that says "this bird is *standing*", are hidden by the water itself.
//
// It lives in `game/` beside the flock and the flyover rather than in `sim/`, on the same rule:
// `sim/` is the cars, the signals and the things the player can hit. It reads `city/pond.js` for
// where the water is, which is the direction the dependency rule allows.
//
// **One draw call.** Bodies only — no wings, no instanced wing pair. A folded wing on the flock is
// swept back until it disappears into the bird's own outline (see `FOLD_SWEEP` in birds.js), so a
// duck that never opens its wings is a duck whose wings were never visible.

// How many. Set against the size of the water rather than picked, because a pond is only three or
// four birds across: a fixed count fills a small one shoulder to shoulder and leaves a big one
// looking abandoned.
//
// **They are not scaled down to fit.** A first pass shrank them a fifth to buy swimming room and it
// is the wrong trade twice over — the flock's birds are standing on the lawn two seconds away at
// full size, and a duck is already losing a third of its body to the waterline, so what was left
// read as a floating pebble. The room comes out of the pond instead, which is why `POND_R_LOW` is
// what it is.
const DUCK_MIN = 2;
const DUCK_MAX = 4;
/** Ducks per unit of swimming radius — 2 birds on a tight pond, 3 or 4 on a roomy one. */
const DUCK_DENSITY = 2.2;
/** How many of them wear the flock's pale morph, against the 0.2 of a flock — see `birdTint`. */
const DUCK_PALE = 0.55;

// How high the body's origin floats above the surface. The torso is 0.29 tall about that origin, so
// this puts the waterline a third of the way up it — a bird sitting *in* the surface rather than on
// it, which is the pose. Half of it under was the first attempt and what showed above the water was
// a head on a lump: a duck's whole silhouette is its back, and the back has to be out.
//
// The feet hang 0.40 below the origin, so they are 0.31 under. The water is opaque, so "under the
// surface" is all it takes to hide them — but only if the sightline out of a foot crosses that
// surface while it is still *over the pond*. The camera looks down at 33°, so the ray gains 1.54
// units of ground for every unit of height: 0.31 of submerged leg needs 0.48 of water beyond the
// duck on the camera side. That is the second half of `SHORE` below, and the whole reason a duck is
// held off its own shoreline at all.
const FLOAT = 0.09;

// The bob, and how fast. Slow and small: this is a pond, not a swell — the whole read is that the
// bird is being carried by something rather than standing on it.
const BOB = 0.022;
const BOB_RATE = [0.7, 1.15];
// A little roll on the same clock, a quarter turn out of phase, so a duck rocks rather than lifts.
const ROCK = 0.05;

const PADDLE = [0.20, 0.38];     // units/s — a third of the flock's walking pace
const TURN = 1.1;                // rad/s
const WANDER = 1.6;              // how far the next spot may be from the last
const DWELL = [1.6, 6.0];        // s sitting still before choosing another

// The dabble: nose down, tail up, and back. A duck's version of the flock's peck, slower and
// deeper — this is a bird tipping to feed rather than one pecking at gravel.
const DABBLE_RATE = 0.28;        // expected dabbles per second of sitting
const DABBLE_TIME = 1.5;
const DABBLE_DIP = 0.95;         // radians, nose down

// How far a duck stays off the water's edge: half a bird, so neither end overhangs the bank, plus
// the water the sightline above needs in order to swallow its legs.
const SHORE = BIRD_LEN * 0.5 + 0.48;

// How far apart two of them try to settle. A duck is drawn about a unit long and nothing here
// collides, so two that pick the same corner of a small pond spend six seconds of dwell occupying
// the same pixels and read as one bird. Enforced on the *target* rather than on the position: a
// pair that cross paths mid-paddle is a pond with ducks on it, and a pair parked on top of each
// other is a bug.
const APART = 1.1;
const APART_TRIES = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Signed shortest way round from an angle to another. */
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** World forward for a heading — the convention `dirYaw` sets: yaw 0 points down +X. */
const heading = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/**
 * The ducks on a city's pond.
 *
 * @param pond  the plan from `city/pond.js`, or null on a city with no water — in which case this
 *              returns a stub, the way `createBirds` does for a city with no park. Nothing here
 *              matters to the game, so a missing pond is a quiet no-op rather than a guard every
 *              caller has to write.
 */
export function createDucks(scene, rng, pond) {
  const group = new THREE.Group();
  group.name = 'ducks';

  // The disc a duck's centre may be in. `pond.water` is the radius the water is guaranteed to
  // cover — the outline at its tightest, less the shore band — so this holds however the pond's
  // wobble came out, without anyone here evaluating it.
  const swim = pond ? pond.water - SHORE : 0;
  if (!pond || swim <= 0.15) {
    // `pond` is handed straight back rather than nulled: a pond too small to float anything is not
    // the same thing as a city with no pond, and shot mode aims at the water either way.
    return { group, ducks: [], mesh: null, material: null, pond, update: () => {} };
  }

  scene.add(group);

  const count = clamp(Math.round(swim * DUCK_DENSITY), DUCK_MIN, DUCK_MAX);

  // Deliberately not `propMaterial()`, for the reason the flock's isn't either: that recipe carries
  // the screen-space AO lookup, and a mesh that receives occlusion without being in the depth
  // prepass wears the occlusion of whatever stands behind it. With AO off the two are the same
  // material anyway — and unlike the flock this one needs no transparency, since a duck never fades.
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.InstancedMesh(birdBodyGeometry(), material, count);
  // A moving InstancedMesh must not be frustum-culled: Three computes its bounding sphere once,
  // from the matrices as they stood on the first culled frame, and never again. These move over a
  // couple of units rather than across the map, so the failure would be subtler than the trucks'
  // and no less real — see the trap list in CLAUDE.md.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // The flock's own plumage draw, so a duck is one of the same birds — the morphs are muted on
  // purpose and the argument for that is in `birdTint`: a bird must never be a saturated pixel of
  // colour, because that is the description of a fare marker.
  //
  // **Mostly pale, though, and that is the water's doing.** Those morphs were balanced against the
  // lawn at luma 134, where the base bird's 118 is a dark shape on a light ground. A pond is 101,
  // so the same bird is 17 luma from what it is sitting on and reads as a lump of the water. The
  // pale morph lands at 177–206, which is the same value break the flock has on grass, the other
  // way up. It is also simply what a municipal pond has on it.
  for (let i = 0; i < count; i++) mesh.setColorAt(i, birdTint(rng, { pale: DUCK_PALE }));
  mesh.instanceColor.needsUpdate = true;

  /**
   * A spot on the open water, in world coordinates, clear of the ducks already floating there.
   * `sqrt` on the radial draw spreads them by *area*: without it a uniform draw crowds every bird
   * into the middle of the pond and leaves the water round the edge empty.
   */
  function spot() {
    let at = { x: pond.x, z: pond.z };
    for (let attempt = 0; attempt < APART_TRIES; attempt++) {
      const angle = rng.range(0, Math.PI * 2);
      const reach = swim * Math.sqrt(rng.next());
      at = { x: pond.x + Math.cos(angle) * reach, z: pond.z + Math.sin(angle) * reach };
      if (ducks.every((other) => Math.hypot(at.x - other.x, at.z - other.z) > APART)) break;
    }
    return at;
  }

  /**
   * The next place to paddle to: near the last one, pulled back onto the water if it wandered off
   * the edge, and re-drawn a few times if it landed on another bird's spot.
   *
   * The retry is bounded and the last draw is taken as it comes — on the tightest pond the disc is
   * barely two `APART`s across, so a loop that insisted would be a loop that never ended.
   */
  function newTarget(duck) {
    let tx = duck.x;
    let tz = duck.z;
    for (let attempt = 0; attempt < APART_TRIES; attempt++) {
      tx = duck.x + rng.jitter(WANDER);
      tz = duck.z + rng.jitter(WANDER);
      const d = Math.hypot(tx - pond.x, tz - pond.z);
      if (d > swim) {
        const s = swim / d;
        tx = pond.x + (tx - pond.x) * s;
        tz = pond.z + (tz - pond.z) * s;
      }
      if (ducks.every((other) => other === duck
        || Math.hypot(tx - other.tx, tz - other.tz) > APART)) break;
    }
    duck.tx = tx;
    duck.tz = tz;
  }

  const ducks = [];
  for (let i = 0; i < count; i++) {
    const at = spot();
    const duck = {
      x: at.x, z: at.z, y: POND_WATER_Y + FLOAT,
      yaw: rng.range(0, Math.PI * 2), pitch: 0, roll: 0,
      speed: rng.range(PADDLE[0], PADDLE[1]),
      phase: rng.range(0, Math.PI * 2),
      bobRate: rng.range(BOB_RATE[0], BOB_RATE[1]),
      dwell: rng.range(0, DWELL[1]),
      dabble: 0,
      tx: at.x, tz: at.z,
    };
    newTarget(duck);
    ducks.push(duck);
  }

  const MAT = new THREE.Matrix4();
  const QUAT = new THREE.Quaternion();
  const POS = new THREE.Vector3();
  const SCALE = new THREE.Vector3(1, 1, 1);

  function pose() {
    for (let i = 0; i < ducks.length; i++) {
      const duck = ducks[i];
      MAT.compose(
        POS.set(duck.x, duck.y, duck.z),
        // `BODY_EULER_ORDER`, via the flock's own helper — the default 'XYZ' puts the roll outside
        // the yaw and rolls about the *world* X axis, so a duck facing north would render its rock
        // as pitch. See the note on it in util/geo.js.
        bodyQuaternion(duck.roll, duck.yaw, duck.pitch, QUAT),
        SCALE,
      );
      mesh.setMatrixAt(i, MAT);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  let t = 0;

  function update(dt) {
    t += dt;

    for (const duck of ducks) {
      if (duck.dwell > 0) {
        duck.dwell -= dt;
        if (duck.dabble > 0) duck.dabble -= dt;
        else if (duck.dwell > DABBLE_TIME && rng.chance(DABBLE_RATE * dt)) duck.dabble = DABBLE_TIME;
      } else {
        const dx = duck.tx - duck.x;
        const dz = duck.tz - duck.z;
        if (Math.hypot(dx, dz) < 0.1) {
          duck.dwell = rng.range(DWELL[0], DWELL[1]);
          newTarget(duck);            // chosen now, paddled to when the sit runs out
        } else {
          // A bird on water turns before it moves — there is nothing to push against sideways —
          // so the heading is chased at a rate rather than snapped, and the body always points
          // where it is going.
          const want = Math.atan2(-dz, dx);
          duck.yaw += clamp(wrapAngle(want - duck.yaw), -TURN * dt, TURN * dt);
          const f = heading(duck.yaw);
          duck.x += f.x * duck.speed * dt;
          duck.z += f.z * duck.speed * dt;
        }
      }

      const swell = t * duck.bobRate + duck.phase;
      duck.y = POND_WATER_Y + FLOAT + BOB * Math.sin(swell);
      duck.roll = ROCK * Math.sin(swell + Math.PI / 2);
      // One dip and back up over DABBLE_TIME, so it lands on zero at both ends and never snaps —
      // the flock's peck, at half the rate and a third again as deep.
      duck.pitch = duck.dabble > 0
        ? -DABBLE_DIP * Math.sin(Math.PI * (1 - duck.dabble / DABBLE_TIME))
        : 0;
    }

    pose();
  }

  // Posed at construction, not on the first frame. Shot mode ticks the world once and freezes, so
  // anything that opens at a default pose stays there — see the entrance-animation trap in
  // CLAUDE.md. These start where they float, so a screenshot of the park has ducks on the pond.
  pose();

  return { group, ducks, mesh, material, pond, update };
}
