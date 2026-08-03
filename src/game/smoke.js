import * as THREE from 'three';

// A slow-rising smoke plume, for use at the taxi wreck. Same instanced-plus-alpha-attribute
// pattern as dust.js and sparks.js — different tuning: darker, larger, slower, longer-lived, and
// with a mild upward pull so the plume actually reads as smoke rather than a puff of dust.

const MAX_PUFFS = 90;
const LIFE = 3.6;
const START_ALPHA = 0.78;
const START_SIZE = 0.6;
const END_SIZE = 3.8;
const RISE = 1.4;              // constant upward velocity added each frame

export function createSmoke(scene, rng) {
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(MAX_PUFFS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshLambertMaterial({
    // Dark neutral grey — smoke reads darker than dust against the pale sky and lighter than the
    // asphalt when it drifts across the road. Faceted so it matches the rest of the low-poly city
    // instead of looking like a soft imported sprite.
    color: '#3A3A40',
    flatShading: true,
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

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_PUFFS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 5;      // above sparks, so the plume reads as *in front of* the flash
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_PUFFS);
  const px = new Float32Array(MAX_PUFFS);
  const py = new Float32Array(MAX_PUFFS);
  const pz = new Float32Array(MAX_PUFFS);
  const vx = new Float32Array(MAX_PUFFS);
  const vy = new Float32Array(MAX_PUFFS);
  const vz = new Float32Array(MAX_PUFFS);
  const spin = new Float32Array(MAX_PUFFS);
  const tilt = new Float32Array(MAX_PUFFS);
  const wide = new Float32Array(MAX_PUFFS);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < MAX_PUFFS; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /** Puff up from (x, z), spread outward, drift upward. */
  function burst(x, z, count = 22) {
    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % MAX_PUFFS;

      life[slot] = LIFE * rng.range(0.85, 1.15);
      px[slot] = x + rng.jitter(0.6);
      py[slot] = 0.5 + rng.range(0, 0.8);
      pz[slot] = z + rng.jitter(0.6);
      const angle = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.4, 1.6);
      vx[slot] = Math.cos(angle) * speed;
      vy[slot] = rng.range(1.0, 2.4);
      vz[slot] = Math.sin(angle) * speed;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-0.8, 0.8);
      wide[slot] = rng.range(0.85, 1.25);
      alphas[slot] = START_ALPHA;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_PUFFS; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / LIFE;

      px[slot] += vx[slot] * dt;
      py[slot] += (vy[slot] + RISE) * dt;
      pz[slot] += vz[slot] * dt;
      // Bleeds outward velocity so the plume drifts up more than it spreads sideways as it ages.
      vx[slot] *= 1 - 0.6 * dt;
      vz[slot] *= 1 - 0.6 * dt;
      spin[slot] += tilt[slot] * dt;

      const size = START_SIZE + (END_SIZE - START_SIZE) * t;
      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.3, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      // Ease out with a slight in-first bump so the plume looks like it's *thickening* before it
      // dissipates, rather than fading linearly from spawn.
      const shape = t < 0.15 ? t / 0.15 : (1 - t) ** 1.3;
      alphas[slot] = shape * START_ALPHA;

      if (life[slot] <= 0) {
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

  return { mesh, burst, update };
}
