import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { waterHeightAt } from '../city/river.js';
import { PALETTE } from '../palette.js';

// The foam behind a boat. One `InstancedMesh` of flattened motes lying on the water, shared by
// every hull on the river — the dust/flames recipe (`game/dust.js`) with the tuning a wake wants.
//
// **Why this is not the triangle it replaces.** The old wake was one flat cone welded to the stern,
// which meant the foam travelled *with* the boat: a shape towed along at exactly hull speed, so the
// one thing it existed to say — that this thing is moving — was the one thing its own motion
// contradicted. Foam is left behind. Every mote here is spawned into the world at the stern and
// then stays where the water is, so what the eye reads is the hull pulling away from its own
// trail, and a wake that keeps lying there for a couple of seconds after the boat has gone.
//
// The other half is that a wake has *structure* a single triangle cannot carry: two arms opening
// astern, a churn boiling out of the stern between them, and a tail that comes apart rather than
// ending on a straight line drawn across open water.

// The pool, and it is sized against the worst river rather than the usual one.
//
// A boat spends `2 + 1/CHURN_EVERY` motes every `SPAWN_STEP` units travelled, so the rate is
// `2.5 · speed / 0.5` a second and what is alive at once is that times `LIFE`: 41 for a tug at 3.4,
// 31 for a barge at 2.6. The hulls on the water at once are the thing that multiplies it — a barge
// crosses `SLAB_X + 52` = 176 units at 2.6, which is 68 seconds, against a `BARGE_WAIT` floor of 16
// — so five barges is the ceiling the spawner can actually reach, and with the one tug that is 196.
// At 256 there are 60 slots of headroom; below about 200 the ring buffer starts recycling a mote
// out from under a wake that is still on screen, which is the failure the dust pool has twice been
// grown to avoid.
const MAX_FOAM = 256;

// How long a mote lasts. Measured as a *length* rather than picked: at 3.4 u/s this trails a tug by
// 8.2 units against the old triangle's 5.2, and the alpha curve below spends the last third of it
// under 0.06 — so what reads is about six units of foam that comes apart at the end instead of
// stopping on a line.
const LIFE = 2.4;

// One spawn every this many units *travelled*, which is what makes the trail a fact about the
// distance covered rather than about the frame rate — and, the part that matters here, is why a tug
// clamped at `HOLD_OFF` in front of a shut leaf lays nothing at all. The old wake needed an
// explicit "how far did it actually move this frame" term multiplied into its opacity to avoid a
// boat standing still with a full wake behind it; a distance-keyed emitter gets that for free.
const SPAWN_STEP = 0.5;
// ...and a churn mote every other one of those. The arms are the shape; the churn is only there to
// fill the throat between them, and at every step it packed the first two units solid white.
const CHURN_EVERY = 2;

// How fast the arms open, as a fraction of the boat's own speed.
//
// This is the Kelvin angle: a displacement hull's wake opens at a half-angle of `asin(1/3)` =
// 19.47° whatever the speed, so a mote leaving the stern at `tan(19.47°) = 0.354` of hull speed
// sideways traces exactly that V. It matters that it scales with speed rather than being a fixed
// lateral rate — the tug and the barge then throw the *same shape* at different lengths, which is
// what makes the barge read as heavy rather than as a tug with a slower wake.
const KELVIN = 0.354;

// Where an arm starts, off the boat's centreline. Just inboard of the hull's own `BEAM / 2` = 1.1,
// so the foam comes off the hull rather than running beside it — and far enough out that the two
// arms are two things. At 0.85 they are 1.7 apart against motes that grow to 1.15, so the pair
// closed into a single column before it had opened and the V went missing at every framing.
const ARM_OFF = 1.0;

// Mote sizes, as diameters: at play zoom 1 unit is 7.7px, so an arm mote goes from 3px to 8px.
const ARM_SIZE = [0.38, 1.05];
// The churn starts bigger and ends bigger — it is the water the propeller is actually turning over,
// and it is what has to cover the gap between the two arms before they have opened.
const CHURN_SIZE = [0.6, 1.45];
// Flattened hard. `dust.js` squashes a puff to 0.55 so it spreads over the road; foam is *on* a
// surface rather than rising off one, so at 0.16 the biggest mote stands 0.09 above the water and
// reads as a patch rather than as a lump of spray.
const FLAT = 0.16;

// Clear of the water for the reason every painted mark in this city clears the road it lies on —
// two coplanar surfaces is a shimmer, not a touch.
const FOAM_LIFT = 0.02;

// Alpha at the stern, before the fade.
//
// Lower than the 0.45 the old triangle carried (0.5 opacity × 0.9 vertex alpha), because motes
// **overlap** and a triangle does not. Astern of the boil an arm mote has grown to 1.15 against a
// 0.5 spacing, so two or three of them cover any given patch of water and the pair stacks to
// `1 - (1 - a)^2` = 0.6 at 0.36. Picking the triangle's number here put a solid white stripe down
// the middle of the channel.
const HEAD_ALPHA = 0.36;

// The stern boil's own push. Water thrown backwards by the screw, dying against the river in about
// half a second — so the churn slides a little way astern as it appears and then stops, which is
// what separates it from the arms either side of it. Arms get none of this: the V is only a V
// because its motes stay put on the water.
const CHURN_DRIFT = 1.2;
const DRIFT_K = 2.4;

// How much a mote's own life is jittered off `LIFE`, so the tail comes apart rather than every mote
// in a step going out together. The floor is load-bearing rather than cosmetic: `prime` lays a
// whole trail at once and has to know the shortest life any of them can draw, or the oldest end of
// a photographed wake is spawned already dead.
const SPAN_JITTER = [0.8, 1.15];

/**
 * The pool.
 *
 * `edges` is the water's own two banks (`waterEdges`), and it is not decoration: the channel is
 * 7.87 units across on the narrow build and a boat's lane already reaches 1.6 off the middle, so
 * there is barely a unit of open water outboard of a hull. Arms left to open on the Kelvin angle
 * alone are over the embankment inside a second and a half, and foam lying on a stone walkway is
 * about as wrong as this effect can go. They are clamped at the bank instead — which is also what
 * the wake of a boat in a narrow channel actually does: it opens until it reaches the sides and
 * then runs back along them.
 *
 * `fade` is the hull's own coast fade, passed in rather than re-derived. A mote never moves in x,
 * so its distance off the coast is fixed at spawn and this is sampled once per mote rather than per
 * frame — foam past the island's rim has to dissolve on exactly the band the ground under it does.
 */
export function createWake(parent, rng, edges, fade) {
  // Detail 0, twenty faces, same as every other mote in the game — flattened this hard the facets
  // read as chop on the surface rather than as a sphere.
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(MAX_FOAM);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // Unlit, and that is a decision rather than a saving: foam is bright at every hour, and a lit one
  // would go the colour of whatever the sun is doing — see the note on `PALETTE.wake`. Through
  // `unlitMaterial`, which turns the haze off with it, because a wake has no business reporting a
  // colour between its own and the sky's just for being at the far end of the map.
  const material = unlitMaterial({
    color: PALETTE.wake,
    transparent: true,
    // Foam on water has no business hiding what is behind it, and the water it lies on is itself a
    // transparent surface at `renderOrder` -2 — so this sorts after it and writes nothing.
    depthWrite: false,
  });

  // Per-mote alpha needs its own attribute: `instanceColor` is RGB only, and a 4-component colour
  // attribute takes a different code path in three. Three lines, the same patch dust and flames use.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_FOAM);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.name = 'boat-wake';
  mesh.renderOrder = -1;      // after the water at -2, before everything on the land
  // The trap this whole project has paid for once already: three computes an `InstancedMesh`'s
  // bounding sphere on the first frame it culls it, from the matrices as they stood *then*, and
  // never again. A pool that opens empty latches a radius of -1 at the origin and the wake never
  // draws.
  mesh.frustumCulled = false;
  parent.add(mesh);

  // A mote's whole state, evaluated from its age rather than integrated frame by frame.
  //
  // The analytic form is what `prime` below is built on: a shot ticks the world once, so the only
  // way to photograph a wake is to lay a finished one down in a single call — and with a closed
  // form "spawn this mote two seconds old" is one argument rather than a replay loop.
  const age = new Float32Array(MAX_FOAM);
  const span = new Float32Array(MAX_FOAM);
  const x0 = new Float32Array(MAX_FOAM);
  const z0 = new Float32Array(MAX_FOAM);
  const zRate = new Float32Array(MAX_FOAM);   // lateral speed, signed by which side it came off
  const zLim = new Float32Array(MAX_FOAM);    // the bank it may not cross, in world z
  const drift = new Float32Array(MAX_FOAM);   // sternward push, u/s at spawn, decaying
  const from = new Float32Array(MAX_FOAM);
  const to = new Float32Array(MAX_FOAM);
  const wide = new Float32Array(MAX_FOAM);
  const spin = new Float32Array(MAX_FOAM);
  const dim = new Float32Array(MAX_FOAM);     // the coast fade where this mote was laid

  const dummy = new THREE.Object3D();
  for (let slot = 0; slot < MAX_FOAM; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;
  let laid = 0;      // motes ever spawned, which is what says whether the emitter fired at all

  /** How far out a mote off this side may drift before it is over the embankment. */
  const bankFor = (side, half) => (side > 0 ? edges.z1 - half : edges.z0 + half);

  /**
   * Lay one mote. `side` is -1, +1 for an arm and 0 for the churn; `born` is how old it already is,
   * which is 0 for anything the running game spawns and a real age for `prime`.
   */
  function lay(x, z, dir, speed, side, born = 0) {
    const slot = next;
    next = (next + 1) % MAX_FOAM;
    laid += 1;

    const arm = side !== 0;
    // The spread is jittered per mote so the two arms come out ragged rather than as a pair of
    // ruled lines — at a single rate every mote in an arm sits exactly on the same ray and the
    // whole thing reads as drawn geometry again, which is the thing this is getting away from.
    const rate = arm ? side * KELVIN * speed * rng.range(0.75, 1.3) : rng.jitter(0.12);

    span[slot] = LIFE * rng.range(SPAN_JITTER[0], SPAN_JITTER[1]);
    age[slot] = born;
    x0[slot] = x;
    z0[slot] = z + (arm ? side * ARM_OFF : rng.jitter(0.3));
    zRate[slot] = rate;
    drift[slot] = arm ? 0 : -dir * CHURN_DRIFT * rng.range(0.7, 1.2);
    from[slot] = (arm ? ARM_SIZE[0] : CHURN_SIZE[0]) * rng.range(0.85, 1.15);
    to[slot] = (arm ? ARM_SIZE[1] : CHURN_SIZE[1]) * rng.range(0.85, 1.15);
    // Rolled **after** the size it is going to grow to, not off the nominal one. A mote is jittered
    // up to 15% wider than the constant says, so a bank held back by the constant is a bank the
    // biggest motes hang a tenth of a unit over — which is small, and is exactly the size of thing
    // that reads as foam on the pavement at the close framings this effect is judged at.
    zLim[slot] = bankFor(rate >= 0 ? 1 : -1, to[slot] / 2);
    wide[slot] = rng.range(0.8, 1.35);
    spin[slot] = rng.range(0, Math.PI * 2);
    dim[slot] = fade(x);
    return slot;
  }

  /** Everything one step of travel spends: an arm each side, and a churn on every other step. */
  function step(boat, count) {
    // Off the stern, which is where a wake starts and is not the same point on a 4.4-unit tug as on
    // an 8.6-unit barge — hung off the origin instead, a barge's foam appears four units inside its
    // own hull.
    const sx = boat.x - boat.dir * boat.len / 2;
    lay(sx, boat.z, boat.dir, boat.speed, -1);
    lay(sx, boat.z, boat.dir, boat.speed, 1);
    if (count % CHURN_EVERY === 0) lay(sx, boat.z, boat.dir, boat.speed, 0);
  }

  /**
   * Spend `moved` units of a boat's travel on foam.
   *
   * The leftover distance and the step count live on the boat, under one field this module owns, so
   * that a boat which barely moves this frame carries the remainder into the next one instead of
   * either spawning nothing or spawning a full step for a hundredth of a unit.
   */
  function follow(boat, moved) {
    const foam = boat.foam ?? (boat.foam = { carry: 0, count: 0 });
    foam.carry += moved;
    // Bounded, so a long frame (a tab coming back to the front) cannot dump the whole pool in one
    // go. Six steps is three units of river, well past anything a real frame covers at 3.4 u/s.
    for (let n = 0; n < 6 && foam.carry >= SPAWN_STEP; n++) {
      foam.carry -= SPAWN_STEP;
      step(boat, foam.count++);
    }
    if (foam.carry > SPAWN_STEP) foam.carry = 0;
  }

  /**
   * Lay a finished wake behind a boat in one call, for shot mode.
   *
   * The trap this is here for is written down twice in CLAUDE.md: a shot ticks the sim **once** and
   * freezes, so anything that fills up over time is photographed on its first frame. A pool that
   * opens empty is the purest form of it — the boat would be in the picture with nothing behind it,
   * which is precisely the "I think we're still missing boat water trails" the old triangle earned
   * by not drawing at all.
   *
   * Every mote is spawned already the age it would have been, from the position the boat was at
   * when it would have been spawned, so what this lays down is the same wake the running game does
   * and not a posed one. It ends on `update(0)` for the other half of the same trap: nothing has
   * ticked yet, so without it every mote is at the scale 0 the pool was built with — a wake laid
   * down correctly and photographed invisible.
   */
  function prime(boat) {
    const steps = Math.floor((LIFE * SPAN_JITTER[0] * boat.speed) / SPAWN_STEP);
    const foam = boat.foam ?? (boat.foam = { carry: 0, count: 0 });
    // Oldest first, so the ring buffer holds them in the order it would have filled them.
    for (let k = 0; k <= steps; k++) {
      const back = (steps - k) * SPAWN_STEP;
      const sx = boat.x - boat.dir * (back + boat.len / 2);
      const born = back / boat.speed;
      lay(sx, boat.z, boat.dir, boat.speed, -1, born);
      lay(sx, boat.z, boat.dir, boat.speed, 1, born);
      if (k % CHURN_EVERY === 0) lay(sx, boat.z, boat.dir, boat.speed, 0, born);
    }
    foam.carry = 0;
    foam.count = steps + 1;
    update(0);
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_FOAM; slot++) {
      if (age[slot] >= span[slot]) continue;
      touched = true;

      age[slot] += dt;
      const a = age[slot];
      const t = Math.min(1, a / span[slot]);

      // Sideways at a constant rate until it meets the bank, then along it. The clamp is the whole
      // reason this is not just `z0 + rate * a`: see the note on `edges` above.
      let z = z0[slot] + zRate[slot] * a;
      z = zRate[slot] >= 0 ? Math.min(z, zLim[slot]) : Math.max(z, zLim[slot]);
      // The churn's own push astern, dying exponentially: `∫ v·e^(-kt)` in closed form.
      const x = drift[slot] === 0
        ? x0[slot]
        : x0[slot] + (drift[slot] * (1 - Math.exp(-DRIFT_K * a))) / DRIFT_K;

      const size = from[slot] + (to[slot] - from[slot]) * t;
      // Read at the x the mote is at rather than the one it was laid at, and that is not a nicety:
      // the channel shoals up through each mouth, so a foot of drift out there is a couple of
      // centimetres of height — enough to sink the boil below the river it is meant to be lying on.
      // Sitting the mote on its own half-thickness rather than centring it on the surface is the
      // other half; the water writes no depth, so nothing would have clipped the buried part.
      dummy.position.set(x, waterHeightAt(x) + FOAM_LIFT + size * FLAT * 0.5, z);
      // Spun about the vertical only. A mote lying on water has no business tumbling, and the spin
      // is here to stop twenty faceted clones sharing a silhouette rather than to animate anything.
      dummy.rotation.set(0, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size * FLAT, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      // Full at the stern and gone well before the tail — the exponent is what stops the trail
      // ending on a visible line, which is the same thing the old triangle's vertex alpha was for.
      alphas[slot] = HEAD_ALPHA * (1 - t) ** 1.6 * dim[slot];

      if (a >= span[slot]) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        alphas[slot] = 0;
      }
    }
    if (touched) {
      mesh.instanceMatrix.needsUpdate = true;
      geometry.attributes.aAlpha.needsUpdate = true;
    }
  }

  /** Live motes, for the probe — a wake nobody can count is a wake nobody can check. */
  function live() {
    let n = 0;
    for (let slot = 0; slot < MAX_FOAM; slot++) if (age[slot] < span[slot]) n += 1;
    return n;
  }

  /**
   * Where each live mote is and how big it is drawn, read back out of the instance matrix rather
   * than off the state arrays — so a mote that is in the right place and scaled to nothing (the
   * settle trap) reads as what it is instead of passing on the arithmetic that never reached the
   * buffer.
   */
  function motes() {
    const out = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let slot = 0; slot < MAX_FOAM; slot++) {
      if (age[slot] >= span[slot]) continue;
      mesh.getMatrixAt(slot, m);
      m.decompose(p, q, s);
      out.push({ x: p.x, y: p.y, z: p.z, size: s.z, alpha: alphas[slot] });
    }
    return out;
  }

  return { mesh, follow, prime, update, live, motes, laid: () => laid, size: MAX_FOAM };
}

export { MAX_FOAM, LIFE as FOAM_LIFE, SPAWN_STEP as FOAM_STEP, ARM_SIZE };
