import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { GULL_STAND } from '../geometry/boat.js';

// The gulls that work a trash barge: a few standing on the heap and the wheelhouse roof, a few
// wheeling over it, and every so often one dropping in or lifting off.
//
// **They live in the barge's own frame.** The flock is a child of the hull mesh, so a bird riding
// the heap needs no bookkeeping to stay on it, the circle the others fly is centred on a boat that
// is moving, and the barge's material — handed in, not copied — carries the coast fade to every
// feather for free. Coordinates in here are the hull's: bow toward +Z, the waterline at y = 0.
//
// **The bridges are the one hard constraint.** A bird on a perch fits under every span
// (`PERCH_CEIL + GULL_STAND` is under the flat soffit; the probe asserts it), and a bird at
// `FLY_HIGH` is over the top of a truck on the arch crest. Anything between would go through a deck,
// and two rules keep birds out of it:
//
// - **Take-off and landing are a schedule.** A gull only changes between perch and circle when the
//   boat says no span is over the hull for the length of the move (`clear`); one that comes due
//   under a bridge simply waits.
// - **The circle hops the bridges.** It is flown low, `FLY_LOW`, close over the heap where the
//   flock reads as belonging to the barge — the first cut flew it at `FLY_HIGH` the whole time and
//   the birds hung so far up-screen that they read as gulls over the far bank. Each bird climbs to
//   `FLY_HIGH` as *it* nears a span (`lift`, measured at the bird, not the boat) and drops back
//   once past, which is what a gull does over a bridge anyway.

/** Flight altitude over a bridge, above the water. Clears the arch crest (1.9 over the road, 3.9
 *  over the water) with a truck on it — 2.6 more — by more than a wingtip on the downstroke. */
export const FLY_HIGH = 7.4;
/** ...and the ordinary circle, a band so the flock is not one flat ring: under 3 over the road. */
export const FLY_LOW = [3.8, 4.9];
/** How far short of a span's edge a bird starts climbing for it, world units. */
export const LIFT_RAMP = 6;
/** How long a take-off or a landing takes, seconds. Boats.js sizes the bridge margin off it. */
export const MOVE_SECONDS = 1.7;
/** How far past the hull's ends a bird can be while it is below circling height mid-move. */
export const MOVE_REACH = 2;
/** The circle they fly: long along the hull, narrow across it — the water is 9.2 wide and the bank
 *  beyond it is buildings, which this altitude does not clear. */
const ORBIT_ALONG = [3.5, 6.5];
const ORBIT_ACROSS = [1.6, 3.2];
// Seconds on a perch, and in the air, before the bird thinks about changing.
const PERCH_TIME = [3, 9];
const FLY_TIME = [4, 11];

// --- The bird ------------------------------------------------------------------
//
// Sized up from life the way the taxi is: a real gull is under a metre across, which at play zoom
// is six pixels and reads as dust. This one spans 1.4 and is drawn in three pieces so the wings can
// flap — a body, and a wing each side pivoting at the shoulder.

const SHOULDER = new THREE.Vector3(0.08, 0.24, 0.02);
/**
 * A flying gull is drawn half as big again as a standing one. At play zoom the bird spans about
 * eight pixels and in the air it has nothing round it to say what it is, so it read as a white
 * speck; on the heap the barge does that job and the bird has a clearance to keep
 * (`GULL_STAND`), so it stays life-size there and grows as it takes off.
 */
export const FLY_SCALE = 1.5;
const WING_LEN = 0.62;

function box(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

let shared = null;
/** The body and the two wings, built once and shared by every gull on the river. */
function gullGeometry() {
  if (shared) return shared;
  const body = mergeGeometries([
    // Legs, so a bird on a perch stands rather than lies.
    box(0.03, 0.12, 0.03, -0.05, 0.06, 0.02, PALETTE.rigging),
    box(0.03, 0.12, 0.03, 0.05, 0.06, 0.02, PALETTE.rigging),
    box(0.2, 0.15, 0.5, 0, 0.18, 0, PALETTE.gullBody),
    box(0.13, 0.12, 0.15, 0, 0.27, 0.27, PALETTE.gullBody),
    box(0.04, 0.03, 0.1, 0, 0.26, 0.38, PALETTE.gullWing),
    box(0.14, 0.04, 0.16, 0, 0.21, -0.32, PALETTE.gullWing),
  ]);
  const wing = (side) => mergeGeometries([
    box(WING_LEN - 0.16, 0.025, 0.24, side * (WING_LEN - 0.16) / 2, 0, 0, PALETTE.gullWing),
    box(0.16, 0.025, 0.16, side * (WING_LEN - 0.08), 0, -0.03, PALETTE.rigging),
  ]);
  shared = { body, left: wing(-1), right: wing(1) };
  return shared;
}

/** The tallest point of a standing gull, for the probe: it has to be under `GULL_STAND`. */
export function gullHeight() {
  const g = gullGeometry();
  g.body.computeBoundingBox();
  return g.body.boundingBox.max.y;
}

function makeBird(material) {
  const g = gullGeometry();
  const root = new THREE.Group();
  const body = new THREE.Mesh(g.body, material);
  body.castShadow = true;
  root.add(body);
  const wings = [];
  for (const [geo, side] of [[g.left, -1], [g.right, 1]]) {
    const w = new THREE.Mesh(geo, material);
    w.position.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z);
    w.castShadow = true;
    root.add(w);
    wings.push({ mesh: w, side });
  }
  return { root, wings };
}

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * A flock for one barge. `perches` are the hull-frame standing points the barge geometry exported
 * (`userData.perches`); `material` is the barge's own.
 */
export function createGullFlock(rng, perches, material, count = 5) {
  const group = new THREE.Group();
  group.name = 'gulls';
  const taken = new Set();

  const freePerch = () => {
    const open = perches.map((_, k) => k).filter((k) => !taken.has(k));
    return open.length ? rng.pick(open) : null;
  };

  // The circle at angle `a`, climbing to `FLY_HIGH` by `lift(z)` — 0 in open water, 1 within a
  // span's footprint. The bob rides the low altitude only, so it cannot dip a bird into a deck.
  let lift = () => 0;
  const orbitAt = (b, a) => {
    const z = b.cz + Math.cos(a) * b.along;
    const low = b.alt + Math.sin(a * 2 + b.phase) * 0.3;
    const up = lift(z);
    return new THREE.Vector3(Math.sin(a) * b.across, low + (FLY_HIGH - low) * up, z);
  };

  const birds = [];
  for (let k = 0; k < count; k++) {
    const bird = makeBird(material);
    const b = {
      ...bird,
      state: 'fly',
      perch: null,
      timer: 0,
      t: 0,
      from: new THREE.Vector3(),
      a: rng.range(0, Math.PI * 2),
      spin: rng.chance(0.5) ? 1 : -1,
      along: rng.range(ORBIT_ALONG[0], ORBIT_ALONG[1]),
      across: rng.range(ORBIT_ACROSS[0], ORBIT_ACROSS[1]),
      cz: rng.jitter(1.5),
      alt: rng.range(FLY_LOW[0], FLY_LOW[1]),
      phase: rng.range(0, Math.PI * 2),
      flap: rng.range(0, Math.PI * 2),
      prev: new THREE.Vector3(),
      yaw: 0,
    };
    // Half of them start on the heap, the rest in the air — a barge that sails in with every bird
    // circling and none landed reads as a swarm rather than as a flock that lives there.
    const k0 = k % 2 === 0 ? freePerch() : null;
    if (k0 !== null) {
      b.state = 'perch';
      b.perch = k0;
      taken.add(k0);
      b.yaw = rng.range(0, Math.PI * 2);
    }
    b.timer = b.state === 'perch'
      ? rng.range(PERCH_TIME[0], PERCH_TIME[1])
      : rng.range(FLY_TIME[0], FLY_TIME[1]);
    group.add(b.root);
    birds.push(b);
  }

  const perchPos = (k) => new THREE.Vector3(perches[k].x, perches[k].y, perches[k].z);

  /**
   * `clear` is whether a bird may change altitude right now — the boat's answer to "is there a
   * bridge over any of the hull within `MOVE_SECONDS` of travel". Dropping it just postpones.
   * `liftAt(z)` is how far up toward `FLY_HIGH` a bird at hull-frame `z` has to be.
   */
  function update(dt, clear = true, liftAt = null) {
    if (liftAt) lift = liftAt;
    for (const b of birds) {
      b.timer -= dt;
      // The circle keeps turning whatever the bird is doing, so a landing aims at a point that is
      // still moving and a take-off joins the circle where it has got to rather than where it was.
      const rate = (b.spin * 1.6) / Math.max(b.along, b.across);
      b.a += rate * dt;

      let pos;
      if (b.state === 'perch') {
        pos = perchPos(b.perch);
        if (b.timer <= 0 && clear) {
          b.state = 'up';
          b.t = 0;
          b.from.copy(pos);
          taken.delete(b.perch);
          b.perch = null;
        }
      } else if (b.state === 'fly') {
        pos = orbitAt(b, b.a);
        if (b.timer <= 0 && clear) {
          const k = freePerch();
          if (k !== null) {
            b.state = 'down';
            b.t = 0;
            b.perch = k;
            taken.add(k);
            b.from.copy(pos);
          } else {
            b.timer = rng.range(FLY_TIME[0], FLY_TIME[1]);
          }
        }
      } else {
        b.t = Math.min(1, b.t + dt / MOVE_SECONDS);
        // Up: straight up off the perch first, then out onto the circle. Down: in over the perch
        // first, then straight down onto it. Either way the low part of the move happens over the
        // hull — the climb is 80% done before the bird leaves the perch's column, and the descent
        // starts with 90% of the way in already covered — which is what lets `clear` be a question
        // about the hull alone, with `MOVE_REACH` of slack.
        if (b.state === 'up') {
          const target = orbitAt(b, b.a);
          const lift = smooth(Math.min(1, b.t / 0.55));
          const out = smooth(Math.max(0, (b.t - 0.4) / 0.6));
          pos = new THREE.Vector3().lerpVectors(b.from, target, out);
          pos.y = b.from.y + (target.y - b.from.y) * lift;
        } else {
          const target = perchPos(b.perch);
          const over = smooth(Math.min(1, b.t * 1.6));
          const drop = smooth(Math.max(0, (b.t - 0.5) / 0.5));
          pos = new THREE.Vector3().lerpVectors(b.from, target, over);
          pos.y = b.from.y + (target.y - b.from.y) * drop;
        }
        if (b.t >= 1) {
          if (b.state === 'up') {
            b.state = 'fly';
            b.timer = rng.range(FLY_TIME[0], FLY_TIME[1]);
          } else {
            b.state = 'perch';
            b.timer = rng.range(PERCH_TIME[0], PERCH_TIME[1]);
            // Turn to face somewhere, as a bird that has just landed does.
            b.yaw += rng.jitter(1.2);
          }
        }
      }

      // Heading off the frame's own motion, so a bird always faces where it is going. A perched
      // bird keeps the heading it landed with.
      const vx = pos.x - b.prev.x;
      const vz = pos.z - b.prev.z;
      let roll = 0;
      if (b.state !== 'perch' && dt > 0 && vx * vx + vz * vz > 1e-8) {
        const yaw = Math.atan2(vx, vz);
        let turn = yaw - b.yaw;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        b.yaw = yaw;
        roll = THREE.MathUtils.clamp(-turn / dt * 0.25, -0.6, 0.6);
      }
      b.prev.copy(pos);
      b.root.position.copy(pos);
      b.root.rotation.set(0, b.yaw, roll, BODY_EULER_ORDER);
      const air = b.state === 'perch' ? 0 : b.state === 'fly' ? 1
        : smooth(b.state === 'up' ? b.t : 1 - b.t);
      b.root.scale.setScalar(1 + (FLY_SCALE - 1) * air);

      // Wings: folded on a perch, beating on the way up, gliding with the odd beat in the circle.
      const flying = b.state !== 'perch';
      b.flap += dt * (b.state === 'up' ? 16 : 11);
      const gliding = b.state === 'fly' && Math.sin(b.flap * 0.17 + b.phase) > -0.2;
      const beat = flying ? (gliding ? 0.12 : 0.15 + Math.sin(b.flap) * 0.65) : 0;
      // A folded wing is swung back along the body rather than shrunk in place, which would leave
      // a stub sticking out of each side.
      for (const w of b.wings) {
        w.mesh.scale.x = flying ? 1 : 0.6;
        w.mesh.rotation.set(0, flying ? 0 : w.side * 1.45, w.side * beat);
      }
    }
  }

  // Placed before the first frame, so a shot that renders without ticking has its birds out.
  update(0, false);

  return {
    group,
    birds,
    update,
    /** Is any bird mid-move? Probe use: the boat must only have let it start in the clear. */
    moving: () => birds.some((b) => b.state === 'up' || b.state === 'down'),
  };
}
