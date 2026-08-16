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
// It runs whether or not the taxi is currently boosting — see update()'s `want`. A warning that
// only appeared once the collision test was already armed would only ever confirm a decision
// already made; showing it beforehand is what lets the player see the hidden car and choose not to
// press the button at all.
//
// Why only the nearest dozen: not to keep the screen clean — a rim paints nothing at all on a
// vehicle standing in the open (see GHOST_RADIUS) — but because tracing every car in the city is
// fill and stencil traffic spent on vehicles too far away to be the player's problem. The radius
// is a warning horizon, and the cap is a rail under it, not a filter.
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
 * How near a car has to be to earn a ghost, in world units — 2.1 × PITCH, so it reaches past the
 * junction the taxi is committed to and covers the one after it.
 *
 * **This was 1.5 × PITCH — 30 — and 30 is a braking distance, not a warning.** The number the
 * player actually needs is a *time*: long enough to read a hidden car and lift off the button
 * before the junction, not long enough to watch the crash arrive. The old radius did not buy it.
 * Measured by driving 150 boost crashes headlessly, taking the vehicle the taxi went on to hit,
 * and asking what its outline was doing on the frames before the impact — with occlusion resolved
 * against the city's own building and tree geometry, not guessed:
 *
 *   - 1.5s out — 17 of the 123 crash partners still on the road were hidden behind something, and
 *     **4 of those 17 wore no outline at all**, the rest averaging 0.41 alpha. They were sitting
 *     at 29-30 units, right on the old line, so the effect had least to say at the exact moment
 *     the player could still act on it.
 *   - 2.0s out — 19 hidden, 6 of them unoutlined, mean alpha 0.34.
 *   - 1.0s out and closer, everything is lit at full opacity. That is the report this came from:
 *     the outline does arrive, it just arrives once the taxi is already committed.
 *
 * At 42 the same 150 crashes give **0 of 17 unoutlined at 1.5s** (mean alpha 0.41 → 0.55) and 3 of
 * 19 at 2.0s (0.34 → 0.42). The fully-lit distance — RADIUS − FADE_BAND = 36, which is the figure
 * the warning is really measured at — is 1.9s at Loco Mode's 18.7 u/s and 1.6s at the top of the
 * overdrive band, against the old 1.3s / 1.05s. The band still costs warning; that is the price of
 * the band, but it now costs it from a figure that had some to spare. Past 42 the returns go flat:
 * 46 buys about one more of those three and starts putting pressure back on the cap.
 *
 * The old note here said 40 would put "half a dozen more cars in range" and make MAX_GHOSTS the
 * real filter. Both halves were wrong, and it is worth writing down why, because the same argument
 * will come back: 30 holds **3.4** vehicles on a frame, not the 6.5 that note assumed, and 42
 * holds 6.1 — so the cap only bit at all because it was set just above a number that was already
 * too low (it is 12 now; see below). And "busy" is the wrong worry entirely. A rim only rasterises
 * where something in the depth buffer is *in front of* it, so a vehicle standing in the open costs
 * fill and paints **nothing**. What the player sees is only the hidden ones, and there are barely
 * more of those: measured against the city's own buildings and trees, 0.77 hidden vehicles per
 * frame at 30 against 1.28 at 42 — half an extra outline on screen, for two thirds more warning.
 *
 * Measured from vehicle centre for both classes, deliberately unchanged for the longer truck: half
 * a truck is 2.8 against a car's 1.7, so its tail crosses the line about a unit later than its
 * centre says. A per-class radius would be a second number to keep in step with PITCH for barely
 * a tenth of a second of warning, on the one vehicle whose size already makes it easiest to see.
 */
export const GHOST_RADIUS = 42;

/**
 * The hard cap, shared across cars and trucks. Set deliberately *above* the 6.1 vehicles that
 * radius holds on average, so it acts as a rail against a clump — a queue at a red — rather than
 * as the real filter.
 *
 * It was 8 against a radius of 30, which was already only a rail by luck; at 42 it would have
 * become the filter, and the thing it evicted would have been the vehicle that mattered. Eviction
 * drops the farthest, and *farthest* is not *safest* — the whole point of the widened radius is
 * the car two junctions out. Measured: at radius 42 with a cap of 8, a genuinely hidden vehicle
 * was dropped by the cap on 5.5% of frames; at 12 that is 0.0%, and stays there out to a radius
 * of 46. The cost of the four extra slots is four matrices per pool, drawing nothing until they
 * are claimed.
 *
 * One cap over both classes rather than one each: the cap exists to bound how much of the frame
 * this may paint, and that ceiling is about the player's screen, not about which buffer a vehicle
 * happens to be drawn from. Each *pool* is nevertheless sized for the full cap, since a lane
 * carrying three trucks and five cars is legal at 1/12 and a pool that ran out of slots would drop
 * the nearest vehicle on a technicality; the spare slots cost a matrix each and draw nothing.
 */
export const MAX_GHOSTS = 12;

/** Seconds to fade the whole set in at run start, or out when the taxi crashes. */
const GHOST_FADE = 0.35;

/**
 * The outer band of the radius, in world units, over which a single ghost fades in. This is what
 * makes a plain-radius rule feel deliberate instead of binary — and what hides the cap's eviction.
 *
 * Stays 6 units as the radius grew, rather than scaling with it: what it is hiding is a pop, and a
 * pop is hidden by *time*, not by a fraction of the radius. 6 units is a third of a second at Loco
 * Mode's 18.7 u/s either way. Widening it in step with the radius would only have pushed the
 * fully-lit distance — the figure the warning is actually measured at, RADIUS − FADE_BAND — back
 * out again, which is the number GHOST_RADIUS was raised to move.
 */
export const FADE_BAND = 6;

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
    // Not gated on `taxi.boost`. The collision test is only armed while boosting, but the whole
    // point of a warning is to inform the decision to press the button, not just to accompany it —
    // a player who never sees the hidden car until they're already committed gets no benefit from
    // the outline. `crashed` still cuts it: a wrecked taxi has nothing left to warn.
    const want = !taxi.crashed ? 1 : 0;
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
