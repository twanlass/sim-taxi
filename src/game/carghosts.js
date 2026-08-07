import * as THREE from 'three';
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
 * taxi reaches it, which is still enough time to lift off the button.
 *
 * Not SCATTER_RANGE's 40, tempting as reuse is: at 40 about half a dozen more cars fall in range
 * and MAX_GHOSTS would be doing all the filtering, which would make the radius a fiction. This is
 * the first number to turn down if the effect ever reads busy.
 */
export const GHOST_RADIUS = 30;

/**
 * The hard cap. Set deliberately *above* the ~6.5 cars that radius holds on average, so it acts as
 * a rail against a clump — a queue at a red — rather than as the real filter. Eviction always drops
 * the farthest car, which the distance fade has already made the faintest, so the cap can only ever
 * remove something that was near-transparent.
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
// matches the taxi's ≈2.7px trace at play zoom.
const RIM = 0.35;

/** Pool meshes are pure paint — the picker must see straight through them. */
const noRaycast = () => {};

const smoothstep = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * @param scene    the scene to hang the pool in
 * @param traffic  what createTraffic() returned — read-only here
 */
export function createCarGhosts(scene, traffic) {
  const { mesh, wheelMesh, ambient, wheelsPerCar, taxi } = traffic;

  // --- Pass 1, the masks.
  //
  // BOTH the body and the steered front wheels, and this is the part that is easy to get wrong.
  // The rim's rule is "draw where something sits in front of the hull", so any opaque part of the
  // traced car left out of the mask *is* something in front of the hull. Skipping the taxi's front
  // wheels painted a yellow streak along the rocker panel of a fully visible car (docs/rendering.md
  // records how long that took to find); the ambient wheels are a second InstancedMesh for the same
  // reason the taxi's are separate meshes, so they need the same treatment.
  //
  // Both share traffic's own geometries rather than cloning them — the mask has to match the
  // silhouette exactly or slivers of rim leak inside it. Nothing here may call setAttribute on
  // them: they are live on InstancedMeshes with a different instance count.
  const bodyMask = new THREE.InstancedMesh(mesh.geometry, ghostMaskMaterial(), MAX_GHOSTS);
  bodyMask.name = 'carGhostBodyMask';
  bodyMask.renderOrder = CAR_GHOST_MASK_ORDER;

  const wheelMask = new THREE.InstancedMesh(
    wheelMesh.geometry, ghostMaskMaterial(), MAX_GHOSTS * wheelsPerCar,
  );
  wheelMask.name = 'carGhostWheelMask';
  wheelMask.renderOrder = CAR_GHOST_MASK_ORDER;

  // --- Pass 2, the rim. Body only.
  //
  // The taxi wears rims on its wheels too, because its outline is a find-my-car signal that has to
  // be complete. This one is a don't-hit-that signal, and the body box is the whole message. The
  // measurement, so nobody has to re-derive it: a front wheel reaches x 1.66, |z| 0.96 against the
  // body rim hull's x 2.0, |z| 1.26 — it is inside the body's outline on every axis but a ~0.4-unit
  // sliver under the front valance, about 3px at play zoom against a rim that is itself 2.3px wide.
  // A wheel rim tier would cost a fourth draw call, a second inflated geometry and a second patched
  // material for that.
  const rimGeometry = inflatedGeometry(mesh.geometry, RIM);

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

  const bodyRim = new THREE.InstancedMesh(rimGeometry, rimMaterial, MAX_GHOSTS);
  bodyRim.name = 'carGhostRim';
  bodyRim.renderOrder = CAR_GHOST_RIM_ORDER;

  const meshes = [bodyMask, wheelMask, bodyRim];
  for (const pooled of meshes) {
    // Three computes an InstancedMesh's bounding sphere once and caches it forever. Every slot
    // starts collapsed at the origin, so that cached sphere would be a point at world centre and
    // the pool would vanish the moment the origin left frame. Worse, if the mask and rim ever
    // culled *differently* the result is rim-without-mask — a filled ghost instead of an outline.
    // Turning culling off on all three ties them together; three objects, so it costs nothing.
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
  for (let slot = 0; slot < MAX_GHOSTS; slot++) bodyRim.setColorAt(slot, tint);
  bodyRim.instanceColor.needsUpdate = true;

  // Nearest-N working set. Preallocated and refilled in place: a build-and-sort per frame would
  // allocate through a loop that already runs at 60Hz for nothing — N is 8 against two dozen cars,
  // so insertion wins outright.
  const near = Array.from({ length: MAX_GHOSTS }, () => ({ car: null, dist: 0 }));
  let found = 0;

  const matrix = new THREE.Matrix4();
  const state = { strength: 0, active: 0 };

  function consider(car, dist) {
    if (found === MAX_GHOSTS && dist >= near[MAX_GHOSTS - 1].dist) return;
    let at = Math.min(found, MAX_GHOSTS - 1);
    while (at > 0 && near[at - 1].dist > dist) {
      near[at].car = near[at - 1].car;
      near[at].dist = near[at - 1].dist;
      at--;
    }
    near[at].car = car;
    near[at].dist = dist;
    if (found < MAX_GHOSTS) found++;
  }

  /**
   * Must run AFTER traffic.update() — it reads the matrices that composed this frame. A frame
   * behind, at 18.7 u/s, is 0.31 units ≈ 2.4px of rim sliding off its own car, which reads as the
   * outline being broken rather than as lag.
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
      for (const pooled of meshes) pooled.count = 0;
      return;
    }

    found = 0;
    const limit = GHOST_RADIUS * GHOST_RADIUS;
    for (const car of ambient) {
      if (car.crashed) continue;
      const dx = car.x - taxi.x;
      const dz = car.z - taxi.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > limit) continue;
      consider(car, Math.sqrt(d2));
    }

    const fade = smoothstep(state.strength) * GHOST_OPACITY;
    for (let slot = 0; slot < found; slot++) {
      const { car, dist } = near[slot];

      mesh.getMatrixAt(car.instanceIndex, matrix);
      bodyMask.setMatrixAt(slot, matrix);
      bodyRim.setMatrixAt(slot, matrix);   // the rim geometry is pre-inflated in object space
      for (let w = 0; w < wheelsPerCar; w++) {
        wheelMesh.getMatrixAt(car.instanceIndex * wheelsPerCar + w, matrix);
        wheelMask.setMatrixAt(slot * wheelsPerCar + w, matrix);
      }

      tint.set(PALETTE.carBodyGhost[car.colorIndex]);
      bodyRim.setColorAt(slot, tint);
      alphas[slot] = fade * smoothstep((GHOST_RADIUS - dist) / FADE_BAND);
    }

    // Counts, not zero-scaled spare slots: three's instanced path early-outs on count 0, so the
    // slots nobody claimed cost no vertex work at all rather than a degenerate triangle each.
    state.active = found;
    bodyMask.count = found;
    bodyRim.count = found;
    wheelMask.count = found * wheelsPerCar;

    for (const pooled of meshes) pooled.instanceMatrix.needsUpdate = true;
    bodyRim.instanceColor.needsUpdate = true;
    rimGeometry.attributes.aAlpha.needsUpdate = true;
  }

  return { update, state, bodyMask, wheelMask, bodyRim, alphas };
}
