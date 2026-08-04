import * as THREE from 'three';

// One-shot spark bursts, spawned at collision points. Same shape as dust.js — one InstancedMesh,
// a ring buffer of slots, per-instance alpha via a custom attribute plus a shader patch (instance
// colour is RGB only, so this is the only way to vary opacity across a single mesh).
//
// The mark is small hot cubes rather than round puffs so a collision reads differently from the
// speed dust behind the boosting taxi — sharp facets, ballistic arcs, gravity pulling them down.

export const SPARKS_DEFAULTS = {
  maxSparks: 192,
  life: 0.85,
  lifeJitterMin: 0.75,
  lifeJitterMax: 1.15,
  startSize: 0.18,
  gravity: 14,

  spawnJitterXZ: 0.2,
  spawnHeight: 0.9,
  speedMin: 3.5,
  speedMax: 7.5,
  upMin: 2.5,
  upMax: 5.5,

  // Bounce off the tarmac. Higher restitution than the settled look sparks used to have —
  // the crash wants motes still hopping when the smoke thickens, not a rain of dead specks.
  groundY: 0.04,
  restitution: 0.55,
  friction: 0.78,

  color: '#FFDE6B',
};

export function createSparks(scene, rng, opts = {}) {
  const cfg = { ...SPARKS_DEFAULTS, ...opts };

  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const alphas = new Float32Array(cfg.maxSparks);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshBasicMaterial({
    color: cfg.color,
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

  const mesh = new THREE.InstancedMesh(geometry, material, cfg.maxSparks);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 4;      // above dust and rubber
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(cfg.maxSparks);
  const px = new Float32Array(cfg.maxSparks);
  const py = new Float32Array(cfg.maxSparks);
  const pz = new Float32Array(cfg.maxSparks);
  const vx = new Float32Array(cfg.maxSparks);
  const vy = new Float32Array(cfg.maxSparks);
  const vz = new Float32Array(cfg.maxSparks);
  const spin = new Float32Array(cfg.maxSparks);
  const tilt = new Float32Array(cfg.maxSparks);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < cfg.maxSparks; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /** Explode a shower of sparks outward and upward from (x, z). */
  function burst(x, z, count = 14) {
    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % cfg.maxSparks;
      const angle = rng.range(0, Math.PI * 2);
      const speed = rng.range(cfg.speedMin, cfg.speedMax);

      life[slot] = cfg.life * rng.range(cfg.lifeJitterMin, cfg.lifeJitterMax);
      px[slot] = x + rng.jitter(cfg.spawnJitterXZ);
      py[slot] = cfg.spawnHeight;
      pz[slot] = z + rng.jitter(cfg.spawnJitterXZ);
      vx[slot] = Math.cos(angle) * speed;
      vy[slot] = rng.range(cfg.upMin, cfg.upMax);
      vz[slot] = Math.sin(angle) * speed;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-4, 4);
      alphas[slot] = 1;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < cfg.maxSparks; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / cfg.life;

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      vy[slot] -= cfg.gravity * dt;
      spin[slot] += tilt[slot] * dt;

      if (py[slot] < cfg.groundY) {
        py[slot] = cfg.groundY;
        vy[slot] = -vy[slot] * cfg.restitution;
        vx[slot] *= cfg.friction;
        vz[slot] *= cfg.friction;
      }

      const size = cfg.startSize * (1 - t * 0.4);
      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.15, spin[slot], 0);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      alphas[slot] = Math.max(0, 1 - t) ** 1.4;

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
    for (let slot = 0; slot < cfg.maxSparks; slot++) {
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
