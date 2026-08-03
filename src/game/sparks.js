import * as THREE from 'three';

// One-shot spark bursts, spawned at collision points. Same shape as dust.js — one InstancedMesh,
// a ring buffer of slots, per-instance alpha via a custom attribute plus a shader patch (instance
// colour is RGB only, so this is the only way to vary opacity across a single mesh).
//
// The mark is small hot cubes rather than round puffs so a collision reads differently from the
// speed dust behind the boosting taxi — sharp facets, ballistic arcs, gravity pulling them down.

const MAX_SPARKS = 96;
const LIFE = 0.55;
const START_SIZE = 0.16;
const GRAVITY = 14;

export function createSparks(scene, rng) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const alphas = new Float32Array(MAX_SPARKS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshBasicMaterial({
    color: '#FFDE6B',
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
  mesh.renderOrder = 4;      // above dust and rubber
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_SPARKS);
  const px = new Float32Array(MAX_SPARKS);
  const py = new Float32Array(MAX_SPARKS);
  const pz = new Float32Array(MAX_SPARKS);
  const vx = new Float32Array(MAX_SPARKS);
  const vy = new Float32Array(MAX_SPARKS);
  const vz = new Float32Array(MAX_SPARKS);
  const spin = new Float32Array(MAX_SPARKS);
  const tilt = new Float32Array(MAX_SPARKS);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < MAX_SPARKS; slot++) {
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
      next = (next + 1) % MAX_SPARKS;
      const angle = rng.range(0, Math.PI * 2);
      const speed = rng.range(3.5, 7.5);

      life[slot] = LIFE * rng.range(0.75, 1.15);
      px[slot] = x + rng.jitter(0.2);
      py[slot] = 0.9;
      pz[slot] = z + rng.jitter(0.2);
      vx[slot] = Math.cos(angle) * speed;
      vy[slot] = rng.range(2.5, 5.5);
      vz[slot] = Math.sin(angle) * speed;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-4, 4);
      alphas[slot] = 1;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_SPARKS; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / LIFE;

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      vy[slot] -= GRAVITY * dt;
      spin[slot] += tilt[slot] * dt;

      // Bounce once off the tarmac, then flatten out. Kills the "raining into the floor" look
      // without needing a proper collision test.
      if (py[slot] < 0.04) {
        py[slot] = 0.04;
        vy[slot] = -vy[slot] * 0.25;
        vx[slot] *= 0.55;
        vz[slot] *= 0.55;
      }

      const size = START_SIZE * (1 - t * 0.4);
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

  return { mesh, burst, update };
}
