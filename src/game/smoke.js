import * as THREE from 'three';

// A slow-rising smoke plume, for use at the taxi wreck. Same instanced-plus-alpha-attribute
// pattern as dust.js and sparks.js — different tuning: darker, larger, slower, longer-lived, and
// with a mild upward pull so the plume actually reads as smoke rather than a puff of dust.

export const SMOKE_DEFAULTS = {
  maxPuffs: 160,
  life: 4.4,
  lifeJitterMin: 0.85,
  lifeJitterMax: 1.2,
  startAlpha: 0.82,
  startSize: 0.8,
  endSize: 5.6,
  rise: 1.6,                       // constant upward velocity added each frame

  spawnJitterXZ: 1.1,
  spawnHeightMin: 0.5,
  spawnHeightMax: 1.7,
  speedMin: 0.6,
  speedMax: 2.6,
  upMin: 1.4,
  upMax: 3.4,
  drag: 0.6,
  color: '#3A3A40',
};

export function createSmoke(scene, rng, opts = {}) {
  const cfg = { ...SMOKE_DEFAULTS, ...opts };

  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(cfg.maxPuffs);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshLambertMaterial({
    // Dark neutral grey — smoke reads darker than dust against the pale sky and lighter than the
    // asphalt when it drifts across the road. Faceted so it matches the rest of the low-poly city
    // instead of looking like a soft imported sprite.
    color: cfg.color,
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

  const mesh = new THREE.InstancedMesh(geometry, material, cfg.maxPuffs);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 5;      // above sparks, so the plume reads as *in front of* the flash
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(cfg.maxPuffs);
  const px = new Float32Array(cfg.maxPuffs);
  const py = new Float32Array(cfg.maxPuffs);
  const pz = new Float32Array(cfg.maxPuffs);
  const vx = new Float32Array(cfg.maxPuffs);
  const vy = new Float32Array(cfg.maxPuffs);
  const vz = new Float32Array(cfg.maxPuffs);
  const spin = new Float32Array(cfg.maxPuffs);
  const tilt = new Float32Array(cfg.maxPuffs);
  const wide = new Float32Array(cfg.maxPuffs);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < cfg.maxPuffs; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /** Puff up from (x, z), spread outward, drift upward. */
  function burst(x, z, count = 56) {
    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % cfg.maxPuffs;

      life[slot] = cfg.life * rng.range(cfg.lifeJitterMin, cfg.lifeJitterMax);
      px[slot] = x + rng.jitter(cfg.spawnJitterXZ);
      py[slot] = cfg.spawnHeightMin + rng.range(0, cfg.spawnHeightMax - cfg.spawnHeightMin);
      pz[slot] = z + rng.jitter(cfg.spawnJitterXZ);
      const angle = rng.range(0, Math.PI * 2);
      const speed = rng.range(cfg.speedMin, cfg.speedMax);
      vx[slot] = Math.cos(angle) * speed;
      vy[slot] = rng.range(cfg.upMin, cfg.upMax);
      vz[slot] = Math.sin(angle) * speed;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-1.0, 1.0);
      wide[slot] = rng.range(0.9, 1.35);
      alphas[slot] = cfg.startAlpha;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < cfg.maxPuffs; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / cfg.life;

      px[slot] += vx[slot] * dt;
      py[slot] += (vy[slot] + cfg.rise) * dt;
      pz[slot] += vz[slot] * dt;
      // Bleeds outward velocity so the plume drifts up more than it spreads sideways as it ages.
      vx[slot] *= 1 - cfg.drag * dt;
      vz[slot] *= 1 - cfg.drag * dt;
      spin[slot] += tilt[slot] * dt;

      const size = cfg.startSize + (cfg.endSize - cfg.startSize) * t;
      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.3, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      // Ease out with a slight in-first bump so the plume looks like it's *thickening* before it
      // dissipates, rather than fading linearly from spawn.
      const shape = t < 0.15 ? t / 0.15 : (1 - t) ** 1.3;
      alphas[slot] = shape * cfg.startAlpha;

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

  function reset() {
    for (let slot = 0; slot < cfg.maxPuffs; slot++) {
      life[slot] = 0;
      alphas[slot] = 0;
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { mesh, burst, update, reset, cfg };
}
