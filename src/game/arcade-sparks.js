import * as THREE from 'three';
import { PALETTE } from '../palette.js';

// Spark burst for arcade-mode car contact.
//
// Same shape as dust.js: one InstancedMesh, one draw call, ring buffer of slots, per-instance alpha
// patched in with the standard `instanceColor is RGB only` shader tweak. A spark differs from a
// puff in that it's a small hot chip that arcs up and settles rather than a soft cloud that
// spreads — so no squash, tighter start size, shorter life, and a warm colour rather than white.
//
// Named arcade-sparks so the file coexists with src/game/sparks.js (main's collision-wreck spark
// system from PR #27) — same shape, different tuning and firing rules.

const MAX_SPARKS = 48;
const LIFE = 0.55;
const START_ALPHA = 1.0;
const START_SIZE = 0.28;
const END_SIZE = 0.08;
const GRAVITY = 7.5;         // stronger than dust's 0.6 — sparks fall visibly in half a second

export function createArcadeSparks(scene) {
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);
  const alphas = new Float32Array(MAX_SPARKS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshBasicMaterial({
    // Warm chip colour. Sits between the taxi body and the traffic-light yellow so it reads as
    // metal-on-metal rather than as either the car or a signal.
    color: new THREE.Color(PALETTE.lightYellow),
    transparent: true,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_SPARKS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 4;              // above dust, below cars
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_SPARKS);
  const px = new Float32Array(MAX_SPARKS);
  const py = new Float32Array(MAX_SPARKS);
  const pz = new Float32Array(MAX_SPARKS);
  const vx = new Float32Array(MAX_SPARKS);
  const vy = new Float32Array(MAX_SPARKS);
  const vz = new Float32Array(MAX_SPARKS);

  const dummy = new THREE.Object3D();
  for (let slot = 0; slot < MAX_SPARKS; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /**
   * Burst `count` sparks out of (x, z) in a rough hemisphere around the contact normal (nx, nz).
   * The normal is the direction from the hit car toward the taxi — sparks fly the *other* way,
   * following where the impacted metal actually went.
   */
  function burst(x, z, nx, nz, count = 6) {
    const len = Math.hypot(nx, nz) || 1;
    const bx = -nx / len;
    const bz = -nz / len;
    for (let i = 0; i < count; i++) {
      const slot = next;
      next = (next + 1) % MAX_SPARKS;
      life[slot] = LIFE;
      px[slot] = x;
      py[slot] = 0.9;                                                  // hood height
      pz[slot] = z;
      // Cone around the impact normal: bias along it, jitter around it, plus an upward kick.
      const spread = (Math.random() * 2 - 1) * 1.4;
      const speed = 3.5 + Math.random() * 2.8;
      const tx = bx + -bz * spread;                                    // perpendicular in XZ
      const tz = bz +  bx * spread;
      const norm = Math.hypot(tx, tz) || 1;
      vx[slot] = (tx / norm) * speed;
      vz[slot] = (tz / norm) * speed;
      vy[slot] = 2.4 + Math.random() * 2.0;
    }
  }

  function update(dt) {
    for (let slot = 0; slot < MAX_SPARKS; slot++) {
      if (life[slot] <= 0) continue;
      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / LIFE;

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      vy[slot] -= GRAVITY * dt;

      const size = START_SIZE + (END_SIZE - START_SIZE) * t;
      dummy.position.set(px[slot], Math.max(py[slot], 0.06), pz[slot]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      alphas[slot] = Math.max(0, 1 - t) * START_ALPHA;

      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        alphas[slot] = 0;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { mesh, burst, update };
}
