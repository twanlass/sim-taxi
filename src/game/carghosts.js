import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../palette.js';
import {
  CAR_GHOST_MASK_ORDER, CAR_GHOST_RIM_ORDER, inflatedGeometry, ghostMaskMaterial, ghostRimMaterial,
} from '../geometry/ghostoutline.js';

// Ghost outlines for the ambient traffic nearest the taxi — the instanced variant of the
// per-mesh outline the taxi wears (geometry/ghostoutline.js, which owns the stencil recipe both
// paths share).
//
// Why it exists: sim/collisions.js is armed *only* while boosting, and in Loco Mode the taxi runs
// at 2.2× through junctions it has flipped green. The one moment a car hidden behind a tower
// matters is the one moment the player cannot see it. The taxi's own outline says where the player
// is; this says what they are about to drive into.
//
// Why only the nearest few: outlining all two dozen ambient cars turns the skyline into a
// wireframe and says nothing more than "this city has traffic". A capped radius says "these ones,
// now", which is the only thing worth interrupting the view for.
//
// **Box trucks wear it too**, which they did not at first. A truck lives in its own instance space
// (sim/traffic.js keeps `trucks` out of `ambient` because an InstancedMesh draws one geometry for
// every instance, so a 5.6-unit vehicle cannot share the car body's buffer), and the pool used to
// read `car.instanceIndex` straight into the car meshes with no type check — so the only way to
// include a truck was to trace it from whichever *car* happened to hold the same index. It was
// left out instead. That gap pointed the wrong way: a truck is the biggest thing on the road, the
// one obstacle that most fills a lane, and at TRUCK_SPEED it is also the one most likely to be
// sitting in a junction the taxi is arriving at. The pool is now one per vehicle class — see
// createPool — and selection runs across both arrays against one shared cap.
//
// Nothing here drives a car or recomputes a transform. traffic.js has composed every ambient
// matrix by the time this runs, so the pool copies those matrices straight back out — the same
// read-back wreckShell() does. That is what keeps the bob, the corner lean, the pitch rock, the
// wheelie, the Loco weave and the panic wobble exactly in step with the car being traced; a
// recomposition here would duplicate five separate pieces of maths and drift the day a sixth
// lands.

/**
 * How near a car has to be to earn a ghost, in world units — 1.5 × PITCH, so it covers the
 * junction the taxi is committed to plus the one behind it, and stops short of the junction after
 * next. At Loco Mode's 18.7 u/s a car crossing that next junction appears about 1.6s before the
 * taxi reaches it, which is still enough time to lift off the button — 1.3s at the top of the
 * overdrive band, which is the price of the band and not a reason to widen the radius: a straight
 * run of two blocks is also the case where the warning has least to say.
 *
 * Not SCATTER_RANGE's 40, tempting as reuse is: at 40 about half a dozen more cars fall in range
 * and MAX_GHOSTS would be doing all the filtering, which would make the radius a fiction. This is
 * the first number to turn down if the effect ever reads busy.
 *
 * Measured from vehicle centre for both classes, deliberately unchanged for the longer truck: half
 * a truck is 2.8 against a car's 1.7, so its tail crosses the line about a unit later than its
 * centre says. A per-class radius would be a second number to keep in step with PITCH for barely
 * a tenth of a second of warning, on the one vehicle whose size already makes it easiest to see.
 */
export const GHOST_RADIUS = 30;

/**
 * The hard cap, shared across cars and trucks. Set deliberately *above* the ~6.5 vehicles that
 * radius holds on average, so it acts as a rail against a clump — a queue at a red — rather than
 * as the real filter. Eviction always drops the farthest vehicle, which the distance fade has
 * already made the faintest, so the cap can only ever remove something that was near-transparent.
 *
 * One cap over both classes rather than one each: the cap exists to bound how much of the frame
 * this may paint, and that ceiling is about the player's screen, not about which buffer a vehicle
 * happens to be drawn from. Each *pool* is nevertheless sized for the full cap, since a lane
 * carrying three trucks and five cars is legal at 1/12 and a pool that ran out of slots would drop
 * the nearest vehicle on a technicality; the spare slots cost a matrix each and draw nothing.
 */
export const MAX_GHOSTS = 8;

/** Seconds to fade the whole set in or out with the boost. */
const GHOST_FADE = 0.35;

/**
 * The outer band of the radius, in world units, over which a single ghost fades in. This is what
 * makes a plain-radius rule feel deliberate instead of binary — and what hides the cap's eviction.
 */
const FADE_BAND = 6;

/**
 * Peak opacity, against the taxi's 0.85. Deliberately well under: with both on screen the player's
 * own outline has to stay the loudest thing in the frame.
 */
export const GHOST_OPACITY = 0.62;

// Rim thickness. NOT the taxi's 0.3 — that is applied before TAXI_SCALE = 1.18 on the taxi group,
// so the taxi's rim renders at ≈0.354 units. Ambient cars carry no group scale, so 0.35 is what
// matches the taxi's ≈2.7px trace at play zoom. Trucks take the same 0.35 rather than a thicker
// rim scaled to the vehicle: the line is a signal to the player, and a signal reads at one weight.
const RIM = 0.35;

/** Pool meshes are pure paint — the picker must see straight through them. */
const noRaycast = () => {};

const smoothstep = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * One vehicle class's pool: a mask per opaque instanced mesh the class draws, plus a single rim.
 *
 * @param scene      the scene to hang the pool in
 * @param name       mesh-name prefix, so a scene dump says which class a pooled mesh belongs to
 * @param body       the instanced mesh whose matrix *is* the vehicle's transform; the rim rides it
 * @param parts      every opaque instanced mesh the class draws, `body` included, each with how
 *                   many instances it holds per vehicle (`instanceIndex * per + p`) and a `label`
 *                   for its pooled mesh's name — a scene dump has to say which part it is looking
 *                   at, since three of them share one geometry-less name otherwise
 * @param rimSource  the geometry to inflate into the rim hull
 */
function createPool(scene, {
  name, body, parts, rimSource,
}) {
  const meshes = [];

  // --- Pass 1, the masks.
  //
  // EVERY opaque part of the traced vehicle, and this is the part that is easy to get wrong. The
  // rim's rule is "draw where something sits in front of the hull", so any opaque part of the
  // traced vehicle left out of the mask *is* something in front of the hull. Skipping the taxi's
  // front wheels painted a yellow streak along the rocker panel of a fully visible car
  // (docs/rendering.md records how long that took to find); the steered wheels are a second
  // InstancedMesh for the same reason the taxi's are separate meshes, and a truck's cargo box is a
  // third — a box left out would have stamped nothing and let the cab's own rim paint across it.
  //
  // All of them share traffic's own geometries rather than cloning them — a mask has to match the
  // silhouette exactly or slivers of rim leak inside it. Nothing here may call setAttribute on
  // them: they are live on InstancedMeshes with a different instance count.
  const masks = parts.map(({ source, per, label }) => {
    const pooled = new THREE.InstancedMesh(source.geometry, ghostMaskMaterial(), MAX_GHOSTS * per);
    pooled.name = `${name}${label}Mask`;
    pooled.renderOrder = CAR_GHOST_MASK_ORDER;
    meshes.push(pooled);
    return { pooled, source, per };
  });

  // --- Pass 2, the rim. One hull for the whole vehicle.
  //
  // The taxi wears rims on its wheels too, because its outline is a find-my-car signal that has to
  // be complete. This one is a don't-hit-that signal, and the body box is the whole message. The
  // measurement, so nobody has to re-derive it: a front wheel reaches x 1.66, |z| 0.96 against the
  // body rim hull's x 2.0, |z| 1.26 — it is inside the body's outline on every axis but a ~0.4-unit
  // sliver under the front valance, about 3px at play zoom against a rim that is itself 2.3px wide.
  // A wheel rim tier would cost a fourth draw call, a second inflated geometry and a second patched
  // material for that.
  const rimGeometry = inflatedGeometry(rimSource, RIM);

  // Per-instance alpha. `instanceColor` is RGB only, so the fade rides a custom attribute and a
  // small shader patch multiplies it in at the end — the same trick as game/dust.js. It carries two
  // things at once: the boost envelope, and each ghost's own distance fade, so a car crossing the
  // radius edge dissolves instead of blinking. Safe to setAttribute on this one and only this one:
  // it is a private clone, not a geometry traffic is drawing.
  const alphas = new Float32Array(MAX_GHOSTS);
  rimGeometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // White, so `instanceColor` is the only thing tinting the rim — three multiplies the two.
  const rimMaterial = ghostRimMaterial({ tint: 0xFFFFFF, opacity: 1 });
  rimMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const rim = new THREE.InstancedMesh(rimGeometry, rimMaterial, MAX_GHOSTS);
  rim.name = `${name}Rim`;
  rim.renderOrder = CAR_GHOST_RIM_ORDER;
  meshes.push(rim);

  for (const pooled of meshes) {
    // Three computes an InstancedMesh's bounding sphere once and caches it forever. Every slot
    // starts collapsed at the origin, so that cached sphere would be a point at world centre and
    // the pool would vanish the moment the origin left frame. Worse, if the mask and rim ever
    // culled *differently* the result is rim-without-mask — a filled ghost instead of an outline.
    // Turning culling off on all of them ties them together; a handful of objects, so it costs
    // nothing.
    pooled.frustumCulled = false;
    pooled.raycast = noRaycast;
    // Deliberately no castShadow, unlike the traffic meshes these borrow their geometry from —
    // inheriting it would drop phantom car shadows around the taxi.
    pooled.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pooled.count = 0;
    scene.add(pooled);
  }

  // Seed every slot's colour so `instanceColor` exists before the first compile — three decides
  // whether to emit the per-instance colour path from whether this attribute is null at that point,
  // and a pool that only tinted a slot once a car came near would compile without it.
  const tint = new THREE.Color(0xFFFFFF);
  for (let slot = 0; slot < MAX_GHOSTS; slot++) rim.setColorAt(slot, tint);
  rim.instanceColor.needsUpdate = true;

  const matrix = new THREE.Matrix4();
  let filled = 0;

  return {
    meshes,
    masks,
    rim,
    alphas,

    /** Take the next free slot and trace `car` into it, at `alpha`. */
    trace(car, alpha) {
      const slot = filled++;
      for (const { pooled, source, per } of masks) {
        for (let p = 0; p < per; p++) {
          source.getMatrixAt(car.instanceIndex * per + p, matrix);
          pooled.setMatrixAt(slot * per + p, matrix);
        }
      }
      // Read back separately rather than reusing the loop's last matrix: `body` is one of `parts`,
      // but which one, and whether anything follows it, is the caller's business.
      body.getMatrixAt(car.instanceIndex, matrix);
      rim.setMatrixAt(slot, matrix);   // the rim geometry is pre-inflated in object space
      // A truck's cab wears PALETTE.carBody at its own colorIndex exactly as a car's body does, so
      // one paint list addresses both. Its cargo box does not — that is baked at a fixed
      // PALETTE.truckBox — but the outline is the vehicle's, not the panel's, and one vehicle gets
      // one line in one colour.
      tint.set(PALETTE.carBodyGhost[car.colorIndex]);
      rim.setColorAt(slot, tint);
      alphas[slot] = alpha;
    },

    /** Publish this frame's slots and hand back how many were claimed. */
    commit() {
      // Counts, not zero-scaled spare slots: three's instanced path early-outs on count 0, so the
      // slots nobody claimed cost no vertex work at all rather than a degenerate triangle each.
      for (const { pooled, per } of masks) pooled.count = filled * per;
      rim.count = filled;
      for (const pooled of meshes) pooled.instanceMatrix.needsUpdate = true;
      rim.instanceColor.needsUpdate = true;
      rimGeometry.attributes.aAlpha.needsUpdate = true;
      const traced = filled;
      filled = 0;
      return traced;
    },

    /** Retire the pool outright — see the note at the strength floor in update(). */
    clear() {
      filled = 0;
      for (const pooled of meshes) pooled.count = 0;
    },
  };
}

/**
 * @param scene    the scene to hang the pool in
 * @param traffic  what createTraffic() returned — read-only here
 */
export function createCarGhosts(scene, traffic) {
  const {
    mesh, wheelMesh, ambient, wheelsPerCar, taxi,
    truckMesh, truckWheelMesh, truckBoxMesh, trucks, truckWheelsPerCar,
  } = traffic;

  const carPool = createPool(scene, {
    name: 'carGhost',
    body: mesh,
    parts: [
      { source: mesh, per: 1, label: 'Body' },
      { source: wheelMesh, per: wheelsPerCar, label: 'Wheel' },
    ],
    rimSource: mesh.geometry,
  });

  // The truck's rim traces cab and cargo box as ONE hull, merged before inflation rather than a
  // hull each. Two hulls would have been the obvious build — the cab and the box are already two
  // meshes — and it is wrong twice over. The rim blends, so wherever two hulls overlap the fragment
  // is drawn twice and comes out at 0.86 instead of 0.62, and inflating the two separately puts
  // them 0.7 units into each other at the chassis line: measured, a doubled band down the flank
  // from y 1.65 to 2.95, about 10px at play zoom, which reads as a lit stripe rather than an
  // outline. Merged first, the chassis and box still only *touch* at y 1.5 — one affine scale
  // preserves that — so the whole vehicle traces at one opacity.
  //
  // What the merge costs: inflatedGeometry scales about the bounding box, so every offset is
  // proportional to the part's distance from the centre and only the outer silhouette gets the full
  // 0.35. Measured on the hull it builds — nose +0.35, tail +0.35 off the chassis, box roof +0.35,
  // flank +0.35, but the **cab roof only +0.17** (≈1.3px against 2.7px), since it sits well inside
  // a bounding box the box roof defines. That is the one soft edge, it faces the cargo box rather
  // than open sky, and a truck's silhouette is legible from the box alone.
  const truckHull = mergeGeometries([truckMesh.geometry, truckBoxMesh.geometry], false);
  const truckPool = createPool(scene, {
    name: 'truckGhost',
    body: truckMesh,
    parts: [
      { source: truckMesh, per: 1, label: 'Cab' },
      // The cargo box rides the cab's transform exactly (its offset is baked into its geometry),
      // but it is read back from its own mesh all the same — the same read-back rule as everything
      // else here, so a day traffic.js gives the box a life of its own cannot desync the mask.
      { source: truckBoxMesh, per: 1, label: 'Box' },
      { source: truckWheelMesh, per: truckWheelsPerCar, label: 'Wheel' },
    ],
    rimSource: truckHull,
  });
  // Scaffolding: inflatedGeometry works on a clone, and nothing draws the merge itself. The car's
  // rimSource is traffic's live car geometry, which is why disposal is the caller's call and not
  // createPool's.
  truckHull.dispose();

  const pools = [carPool, truckPool];

  // Nearest-N working set, across both classes. Preallocated and refilled in place: a build-and-sort
  // per frame would allocate through a loop that already runs at 60Hz for nothing — N is 8 against
  // two dozen vehicles, so insertion wins outright.
  const near = Array.from({ length: MAX_GHOSTS }, () => ({ car: null, dist: 0, pool: null }));
  let found = 0;

  const state = {
    strength: 0, active: 0, cars: 0, trucks: 0,
  };

  function consider(car, dist, pool) {
    if (found === MAX_GHOSTS && dist >= near[MAX_GHOSTS - 1].dist) return;
    let at = Math.min(found, MAX_GHOSTS - 1);
    while (at > 0 && near[at - 1].dist > dist) {
      near[at].car = near[at - 1].car;
      near[at].dist = near[at - 1].dist;
      near[at].pool = near[at - 1].pool;
      at--;
    }
    near[at].car = car;
    near[at].dist = dist;
    near[at].pool = pool;
    if (found < MAX_GHOSTS) found++;
  }

  function scan(vehicles, pool) {
    const limit = GHOST_RADIUS * GHOST_RADIUS;
    for (const car of vehicles) {
      if (car.crashed) continue;
      const dx = car.x - taxi.x;
      const dz = car.z - taxi.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > limit) continue;
      consider(car, Math.sqrt(d2), pool);
    }
  }

  /**
   * Must run AFTER traffic.update() — it reads the matrices that composed this frame. A frame
   * behind, at 18.7 u/s, is 0.31 units ≈ 2.4px of rim sliding off its own car (0.38 units ≈ 2.9px
   * at the top of overdrive), which reads as the outline being broken rather than as lag.
   */
  function update(dt) {
    // `taxi.boost` stays true through BOOST_COOLDOWN, which is right: the collision test is armed
    // through the tail too, so the warning should outlast the button. `crashed` is belt-and-braces
    // — collisions.js clears `boost` on impact — but it costs one condition and says the intent.
    const want = (taxi.boost && !taxi.crashed) ? 1 : 0;
    const step = dt / GHOST_FADE;
    state.strength += Math.sign(want - state.strength)
      * Math.min(Math.abs(want - state.strength), step);

    // Off means *gone*, not transparent. A mask writes no colour at all, so fading its rim to zero
    // leaves it stamping the stencil every frame regardless — and a stamp that outlives the effect
    // goes on hollowing out whatever rim draws after it. Dropping the counts is also the only way
    // the pool costs nothing while the player isn't boosting, which is most of a run.
    if (state.strength <= 0.002) {
      state.strength = 0;
      state.active = 0;
      state.cars = 0;
      state.trucks = 0;
      for (const pool of pools) pool.clear();
      return;
    }

    found = 0;
    scan(ambient, carPool);
    scan(trucks, truckPool);

    const fade = smoothstep(state.strength) * GHOST_OPACITY;
    for (let slot = 0; slot < found; slot++) {
      const { car, dist, pool } = near[slot];
      pool.trace(car, fade * smoothstep((GHOST_RADIUS - dist) / FADE_BAND));
    }

    state.cars = carPool.commit();
    state.trucks = truckPool.commit();
    state.active = found;
  }

  return {
    update,
    state,
    // Named the way the probe and any future readout want them: the car pool's three meshes under
    // the names they have always had, the truck pool's four alongside.
    bodyMask: carPool.masks[0].pooled,
    wheelMask: carPool.masks[1].pooled,
    bodyRim: carPool.rim,
    alphas: carPool.alphas,
    truckCabMask: truckPool.masks[0].pooled,
    truckBoxMask: truckPool.masks[1].pooled,
    truckWheelMask: truckPool.masks[2].pooled,
    truckRim: truckPool.rim,
    truckAlphas: truckPool.alphas,
  };
}
