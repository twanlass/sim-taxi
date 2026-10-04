import * as THREE from 'three';
import { color } from '../palette.js';

// Water thrown off the taxi's tyres on a wet road — the squall's answer to the boost's dust
// (game/dust.js), and laid by `wetTyres` in main.js off the same two rear contact patches.
//
// Two kinds of particle out of one pool, because spray is two things at two sizes. The **mist** is
// what reads at play zoom: soft pale puffs that come off the tyre, swell and drop back, the same
// squashed icosahedron the dust is so it lights with the same facets. The **droplets** are what make
// it water rather than steam — a handful of small bright beads per stamp, thrown higher and pulled
// down hard, so the plume has an arc to it. Mist alone read as a white dust trail on a grey road.
//
// Unlike the dust it is not gated on the boost: a car on a wet street throws water at any speed
// worth the name. Speed sets how much, not whether (`wetTyres`).

// Sized against the Loco top of 34 u/s: a stamp per tyre every SPRAY_STEP (0.55, main.js) is 124
// stamps a second at up to 2 mist + 4 drops each, living ~0.6s — ~440 alive at the very worst.
const MAX = 512;
// Mist: thrown up and back, slowed by its own air, swelling as it goes.
const MIST_LIFE = 0.7;
const MIST_ALPHA = 0.42;
const MIST_FROM = 0.35;
const MIST_TO = 2.4;
const MIST_GRAVITY = 3.5;
const MIST_DRAG = 2.2;
// Droplets: small, opaque-ish, ballistic. A droplet is drawn at a fixed size — a growing bead reads
// as a puff — and fades only over the last third of its life.
const DROP_LIFE = 0.5;
const DROP_ALPHA = 0.85;
const DROP_SIZE = 0.3;
const DROP_GRAVITY = 15;
const SQUASH = 0.6;

export const SPRAY_ROAD_Y = 0.25;

export function createSpray(scene, rng) {
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);
  const alphas = new Float32Array(MAX);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshLambertMaterial({
    color: color('waterSpray'),
    // Lifted off the light it is lit by: water in the air catches the sky from every side, and
    // under the rain cell's shade a plain Lambert white came out the grey-brown of the dust.
    emissive: color('waterSprayGlow'),
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });
  // The dust's alpha patch, verbatim — which is also why the cache key can be the dust's own:
  // the same source compiles to the same program (see the customProgramCacheKey trap in CLAUDE.md).
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 3;      // with the dust: above the rubber, below the cars
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX);
  const span = new Float32Array(MAX);
  const px = new Float32Array(MAX);
  const py = new Float32Array(MAX);
  const pz = new Float32Array(MAX);
  const vx = new Float32Array(MAX);
  const vy = new Float32Array(MAX);
  const vz = new Float32Array(MAX);
  const spin = new Float32Array(MAX);
  const drop = new Uint8Array(MAX);     // 1 a droplet, 0 mist
  const grow = new Float32Array(MAX);
  const floor = new Float32Array(MAX);  // the surface it came off, so it can land rather than sink

  const dummy = new THREE.Object3D();
  for (let slot = 0; slot < MAX; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  function take() {
    const slot = next;
    next = (next + 1) % MAX;
    spin[slot] = rng.range(0, Math.PI * 2);
    return slot;
  }

  /**
   * One stamp of spray off a tyre at (x, z), for a car heading `yaw` at `speed` u/s. `amount` is
   * 0..1 — how wet the road is times how fast the car is going — and scales the count and the throw
   * together, so a crawl through a puddle is a dribble and the Loco top is a rooster tail. `side` is
   * −1/+1 for which tyre, so the plume fans *outward* off each one rather than crossing behind the car.
   */
  function add(x, z, yaw, speed, amount, side = 0, y = SPRAY_ROAD_Y) {
    if (amount <= 0) return;
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    const rx = Math.sin(yaw), rz = Math.cos(yaw);
    // A fraction of the car's own velocity, kept — the water leaves the tread moving with the car —
    // so the plume trails off the wheel instead of stopping dead in the air where it was thrown.
    const keep = speed * 0.35;

    const mists = amount > 0.5 ? 2 : 1;
    for (let n = 0; n < mists; n++) {
      const slot = take();
      drop[slot] = 0;
      span[slot] = life[slot] = MIST_LIFE * rng.range(0.8, 1.2);
      px[slot] = x + rng.jitter(0.2);
      py[slot] = y;
      pz[slot] = z + rng.jitter(0.2);
      const back = rng.range(0.8, 2.0) * (0.6 + amount);
      const out = side * rng.range(0.2, 1.0) + rng.jitter(0.4);
      vx[slot] = fx * (keep - back) + rx * out;
      vz[slot] = fz * (keep - back) + rz * out;
      vy[slot] = rng.range(1.4, 2.6) * (0.6 + 0.6 * amount);
      grow[slot] = rng.range(0.8, 1.2) * (0.7 + 0.5 * amount);
      floor[slot] = y;
      alphas[slot] = MIST_ALPHA;
    }

    const drops = Math.round(1 + 3 * amount);
    for (let n = 0; n < drops; n++) {
      const slot = take();
      drop[slot] = 1;
      span[slot] = life[slot] = DROP_LIFE * rng.range(0.7, 1.2);
      px[slot] = x + rng.jitter(0.15);
      py[slot] = y + 0.1;
      pz[slot] = z + rng.jitter(0.15);
      const back = rng.range(1.0, 3.0) * (0.5 + amount);
      const out = side * rng.range(0.3, 1.6) + rng.jitter(0.5);
      vx[slot] = fx * (keep - back) + rx * out;
      vz[slot] = fz * (keep - back) + rz * out;
      vy[slot] = rng.range(3.0, 5.5) * (0.6 + 0.5 * amount);
      grow[slot] = rng.range(0.7, 1.3);
      floor[slot] = y;
      alphas[slot] = DROP_ALPHA;
    }
  }

  function update(dt) {
    for (let slot = 0; slot < MAX; slot++) {
      if (life[slot] <= 0) continue;
      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / span[slot];

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      if (drop[slot]) {
        vy[slot] -= DROP_GRAVITY * dt;
      } else {
        vy[slot] -= MIST_GRAVITY * dt;
        const k = Math.exp(-MIST_DRAG * dt);
        vx[slot] *= k;
        vz[slot] *= k;
      }
      // Water lands; it does not sink through the road. A droplet that reaches the surface is done.
      if (py[slot] < floor[slot]) {
        py[slot] = floor[slot];
        vy[slot] = 0;
        if (drop[slot]) life[slot] = 0;
      }

      dummy.position.set(px[slot], py[slot], pz[slot]);
      if (drop[slot]) {
        const s = DROP_SIZE * grow[slot];
        dummy.rotation.set(0, spin[slot], 0);
        dummy.scale.set(s, s, s);
        alphas[slot] = DROP_ALPHA * Math.min(1, (1 - t) * 3);
      } else {
        const s = (MIST_FROM + (MIST_TO - MIST_FROM) * Math.sqrt(t)) * grow[slot];
        dummy.rotation.set(0, spin[slot], 0);
        dummy.scale.set(s * 1.15, s * SQUASH, s);
        alphas[slot] = MIST_ALPHA * (1 - t) ** 1.4;
      }
      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        alphas[slot] = 0;
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  function live() {
    let n = 0;
    for (let slot = 0; slot < MAX; slot++) if (life[slot] > 0) n += 1;
    return n;
  }

  return { mesh, add, update, live };
}
