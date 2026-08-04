import * as THREE from 'three';

// One-shot flame burst out the tailpipe when Loco Mode fires up. Same instanced-plus-alpha-
// attribute recipe as sparks.js and dust.js — different tuning so the burst reads as *hot*: hot
// orange, additive blending so it brightens whatever's behind it, no gravity (flame doesn't fall),
// a short life so it's a bark rather than a plume, and a fast size ramp so each mote grows a
// touch and then snuffs out instead of drifting.
//
// Two firing shapes share the pool: burst() shoots a cone backwards along a heading (Loco Mode
// tailpipe), blast() shoots outward from a point (crash fireball). Per-slot life/size lets both
// coexist in one InstancedMesh.

export const FLAMES_DEFAULTS = {
  maxFlames: 128,

  // Tailpipe burst.
  life: 0.76,
  lifeJitterMin: 0.7,
  lifeJitterMax: 1.1,
  startSize: 0.36,
  endSize: 1.10,
  burstSpeedMin: 5.0,
  burstSpeedMax: 9.0,
  burstSideSpread: 1.4,
  burstUpMin: 0.4,
  burstUpMax: 1.4,
  burstDrag: 4.2,

  // Crash fireball — bigger, longer, thrown outward.
  blastLife: 1.15,
  blastLifeJitterMin: 0.7,
  blastLifeJitterMax: 1.15,
  blastStartSize: 0.7,
  blastEndSize: 2.4,
  blastOutMin: 2.0,
  blastOutMax: 6.5,
  blastUpMin: 1.5,
  blastUpMax: 5.0,
  blastSpawnJitterXZ: 0.5,
  blastSpawnHeightMin: 0.6,
  blastSpawnHeightMax: 1.6,
  blastDrag: 2.6,

  color: '#FF8A2A',
};

export function createFlames(scene, rng, opts = {}) {
  const cfg = { ...FLAMES_DEFAULTS, ...opts };

  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(cfg.maxFlames);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // Additive so the flame *lights up* the road behind it rather than sitting on it as an opaque
  // blob — a taillight-orange decal would just read as another sticker.
  const material = new THREE.MeshBasicMaterial({
    color: cfg.color,
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

  const mesh = new THREE.InstancedMesh(geometry, material, cfg.maxFlames);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 6;     // above sparks and smoke — the flame is the brightest thing on screen
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(cfg.maxFlames);
  // Per-slot initial life and size range so tailpipe puffs and crash fireballs can share the same
  // pool with different tunings — otherwise a longer-lived blast would divide by the wrong LIFE
  // and start life with a negative t.
  const life0 = new Float32Array(cfg.maxFlames);
  const size0 = new Float32Array(cfg.maxFlames);
  const size1 = new Float32Array(cfg.maxFlames);
  const dragK = new Float32Array(cfg.maxFlames);
  const px = new Float32Array(cfg.maxFlames);
  const py = new Float32Array(cfg.maxFlames);
  const pz = new Float32Array(cfg.maxFlames);
  const vx = new Float32Array(cfg.maxFlames);
  const vy = new Float32Array(cfg.maxFlames);
  const vz = new Float32Array(cfg.maxFlames);
  const spin = new Float32Array(cfg.maxFlames);
  const tilt = new Float32Array(cfg.maxFlames);
  const wide = new Float32Array(cfg.maxFlames);

  const dummy = new THREE.Object3D();

  for (let slot = 0; slot < cfg.maxFlames; slot++) {
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
      next = (next + 1) % cfg.maxFlames;

      // Speed is heavy along -forward with a small side splay, so the cone opens up behind the
      // bumper instead of firing a single hard stripe.
      const back = rng.range(cfg.burstSpeedMin, cfg.burstSpeedMax);
      const side = rng.jitter(cfg.burstSideSpread);
      const up = rng.range(cfg.burstUpMin, cfg.burstUpMax);

      life[slot] = cfg.life * rng.range(cfg.lifeJitterMin, cfg.lifeJitterMax);
      life0[slot] = life[slot];
      size0[slot] = cfg.startSize;
      size1[slot] = cfg.endSize;
      dragK[slot] = cfg.burstDrag;
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
      next = (next + 1) % cfg.maxFlames;

      const angle = rng.range(0, Math.PI * 2);
      const out = rng.range(cfg.blastOutMin, cfg.blastOutMax);
      const up = rng.range(cfg.blastUpMin, cfg.blastUpMax);

      life[slot] = cfg.blastLife * rng.range(cfg.blastLifeJitterMin, cfg.blastLifeJitterMax);
      life0[slot] = life[slot];
      size0[slot] = cfg.blastStartSize;
      size1[slot] = cfg.blastEndSize;
      dragK[slot] = cfg.blastDrag;
      px[slot] = x + rng.jitter(cfg.blastSpawnJitterXZ);
      py[slot] = cfg.blastSpawnHeightMin + rng.range(0, cfg.blastSpawnHeightMax - cfg.blastSpawnHeightMin);
      pz[slot] = z + rng.jitter(cfg.blastSpawnJitterXZ);
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
    for (let slot = 0; slot < cfg.maxFlames; slot++) {
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

  function reset() {
    for (let slot = 0; slot < cfg.maxFlames; slot++) {
      life[slot] = 0;
      alphas[slot] = 0;
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { mesh, burst, blast, update, reset, cfg };
}
