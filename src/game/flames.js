import * as THREE from 'three';

// One-shot flame burst out the tailpipe when Loco Mode fires up. Same instanced-plus-alpha-
// attribute recipe as sparks.js and dust.js — different tuning so the burst reads as *hot*: hot
// orange, additive blending so it brightens whatever's behind it, no gravity (flame doesn't fall),
// a short life so it's a bark rather than a plume, and a fast size ramp so each mote grows a
// touch and then snuffs out instead of drifting.

const MAX_FLAMES = 128;
const LIFE = 0.76;
const START_SIZE = 0.36;
const END_SIZE = 1.10;

// Crash fireball tuning — bigger, longer, and thrown outward from the wreck rather than back
// along a heading. Additive orange over the smoke plume reads as a real detonation instead of
// exhaust.
const BLAST_LIFE = 1.15;
const BLAST_START_SIZE = 0.7;
const BLAST_END_SIZE = 2.4;

export function createFlames(scene, rng) {
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(MAX_FLAMES);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // Additive so the flame *lights up* the road behind it rather than sitting on it as an opaque
  // blob — a taillight-orange decal would just read as another sticker.
  const material = new THREE.MeshBasicMaterial({
    color: '#FF8A2A',
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_FLAMES);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 6;     // above sparks and smoke — the flame is the brightest thing on screen
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_FLAMES);
  // Per-slot initial life and size range so tailpipe puffs and crash fireballs can share the same
  // pool with different tunings — otherwise a longer-lived blast would divide by the wrong LIFE
  // and start life with a negative t.
  const life0 = new Float32Array(MAX_FLAMES);
  const size0 = new Float32Array(MAX_FLAMES);
  const size1 = new Float32Array(MAX_FLAMES);
  const dragK = new Float32Array(MAX_FLAMES);
  const px = new Float32Array(MAX_FLAMES);
  const py = new Float32Array(MAX_FLAMES);
  const pz = new Float32Array(MAX_FLAMES);
  const vx = new Float32Array(MAX_FLAMES);
  const vy = new Float32Array(MAX_FLAMES);
  const vz = new Float32Array(MAX_FLAMES);
  const spin = new Float32Array(MAX_FLAMES);
  const tilt = new Float32Array(MAX_FLAMES);
  const wide = new Float32Array(MAX_FLAMES);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < MAX_FLAMES; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /**
   * Fire a jet of flame backwards from (x, y, z) along the car's heading. The caller passes the
   * tailpipe world position; we shoot each mote *further* back along -yaw so the jet trails away
   * from the bumper rather than pooling under it.
   */
  function burst(x, y, z, yaw, count = 16) {
    // Backward direction, matching the convention used for dust and skids.
    const bx = -Math.cos(yaw);
    const bz = Math.sin(yaw);
    // Sideways (used to spread the jet slightly).
    const sx = Math.sin(yaw);
    const sz = Math.cos(yaw);

    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % MAX_FLAMES;

      // Speed is heavy along -forward with a small side splay, so the cone opens up behind the
      // bumper instead of firing a single hard stripe.
      const back = rng.range(5.0, 9.0);
      const side = rng.jitter(1.4);
      const up = rng.range(0.4, 1.4);

      life[slot] = LIFE * rng.range(0.7, 1.1);
      life0[slot] = life[slot];
      size0[slot] = START_SIZE;
      size1[slot] = END_SIZE;
      dragK[slot] = 4.2;
      px[slot] = x + rng.jitter(0.12);
      py[slot] = y + rng.jitter(0.08);
      pz[slot] = z + rng.jitter(0.12);
      vx[slot] = bx * back + sx * side;
      vy[slot] = up;
      vz[slot] = bz * back + sz * side;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-2.5, 2.5);
      wide[slot] = rng.range(0.75, 1.25);
      alphas[slot] = 1;
    }
  }

  /**
   * Crash fireball: an omnidirectional puff of fire from (x, z), lofting up rather than firing
   * along a heading. Bigger and slower than the tailpipe burst, coloured by the same additive
   * material so it brightens the smoke plume from the inside.
   */
  function blast(x, z, count = 36) {
    for (let k = 0; k < count; k++) {
      const slot = next;
      next = (next + 1) % MAX_FLAMES;

      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(2.0, 6.5);
      const up = rng.range(1.5, 5.0);

      life[slot] = BLAST_LIFE * rng.range(0.7, 1.15);
      life0[slot] = life[slot];
      size0[slot] = BLAST_START_SIZE;
      size1[slot] = BLAST_END_SIZE;
      dragK[slot] = 2.6;
      px[slot] = x + rng.jitter(0.5);
      py[slot] = 0.6 + rng.range(0, 1.0);
      pz[slot] = z + rng.jitter(0.5);
      vx[slot] = Math.cos(angle) * out;
      vy[slot] = up;
      vz[slot] = Math.sin(angle) * out;
      spin[slot] = rng.range(0, Math.PI * 2);
      tilt[slot] = rng.range(-2.0, 2.0);
      wide[slot] = rng.range(0.9, 1.5);
      alphas[slot] = 1;
    }
  }

  function update(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_FLAMES; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / life0[slot];   // 0 fresh, 1 spent

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      // Air braking — the jet slows quickly so each mote decelerates into a puff rather than
      // continuing off at launch speed. Frame-rate independent decay.
      const drag = Math.exp(-dragK[slot] * dt);
      vx[slot] *= drag;
      vz[slot] *= drag;
      spin[slot] += tilt[slot] * dt;

      // Grows fast at spawn, then holds — a shrinking flame reads as *dying* which is fine at
      // the tail of the life, and the alpha ramp already fades it out.
      const size = size0[slot] + (size1[slot] - size0[slot]) * Math.min(1, t * 2.2);
      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.3, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      // Snaps up to full at spawn, eases out steeply — flames don't linger, they whoosh and go.
      alphas[slot] = (t < 0.12 ? t / 0.12 : (1 - t) ** 1.6);

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

  return { mesh, burst, blast, update };
}
