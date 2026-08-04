import * as THREE from 'three';
import { color } from '../palette.js';

// Taxi wreckage. Individual meshes rather than instances — there are only ~10 pieces per crash
// and each one carries its own material for the per-piece opacity fade, so the instancing cost
// wouldn't pay off. Shapes mirror what taxi.js merges into the shell (body, cabin, sign, four
// wheels, two trim stripes) so the burst reads as *this taxi* flying apart, not as generic
// rubble.
//
// Ballistic physics: initial radial-plus-up velocity, gravity, one damped ground bounce, spin
// under an exponentially damped angular velocity. Lifetimes are short — the wreck focus and the
// smoke plume carry the rest of the beat — with a per-piece opacity fade in the last second so
// nothing pops out.
//
// Every tunable lives in DEBRIS_DEFAULTS so the playground can override at construction.
// Overrides that change pool composition (chunkCount, shrapnelCount, wheelCount, trimCount) only
// take effect at create time — live edits to those need a rebuild.

export const DEBRIS_DEFAULTS = {
  gravity: 24,
  life: 3.4,
  lifeJitterMin: 0.85,
  lifeJitterMax: 1.2,
  fadeTail: 1.0,

  chunkCount: 2,
  wheelCount: 4,
  trimCount: 2,

  // Big-chunk launch tuning.
  bigSpeedMin: 4,
  bigSpeedMax: 9,
  bigUpMin: 4.5,
  bigUpMax: 8.5,
  bigSpin: 9,

  // Small shrapnel — cheap boxes and tets, tuned to fly farther and spin harder than the big
  // chunks. Twenty extra motes on top of the recognisable body parts turns the burst from
  // "the taxi came apart" into "the taxi came *apart*".
  shrapnelCount: 20,
  shrapnelSpeedMin: 6,
  shrapnelSpeedMax: 13,
  shrapnelUpMin: 6,
  shrapnelUpMax: 12,
  shrapnelSpin: 18,

  // Where each piece starts, relative to the wreck spot.
  spawnJitterXZ: 0.35,
  spawnHeightMin: 0.9,
  spawnHeightMax: 1.4,

  // Ground bounce — one meaningful rebound then it settles.
  groundY: 0.15,
  bigRestitution: 0.35,
  bigFriction: 0.65,
  shrapnelRestitution: 0.6,
  shrapnelFriction: 0.85,
  spinDamp: 0.6,

  // Piece geometry sizes.
  bodySize: [1.4, 0.55, 1.3],
  cabinSize: [1.5, 0.55, 1.4],
  signSize: [0.75, 0.34, 0.4],
  wheelRadius: 0.34,
  wheelWidth: 0.26,
  trimSize: [0.6, 0.2, 0.08],
};

/** One mesh with its own physics state slot. */
function makePiece(scene, geometry, baseMaterial, pieces) {
  const material = baseMaterial.clone();
  material.transparent = true;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.visible = false;
  scene.add(mesh);
  pieces.push({
    mesh,
    material,
    life: 0,
    vx: 0, vy: 0, vz: 0,
    wx: 0, wy: 0, wz: 0,
  });
}

export function createDebris(scene, rng, opts = {}) {
  const cfg = { ...DEBRIS_DEFAULTS, ...opts };
  const pieces = [];

  const bodyMat = new THREE.MeshLambertMaterial({ color: color('taxiBody'), flatShading: true });
  const cabinMat = new THREE.MeshLambertMaterial({ color: color('carGlass'), flatShading: true });
  const signMat = new THREE.MeshLambertMaterial({ color: color('taxiSign'), flatShading: true });
  const trimMat = new THREE.MeshLambertMaterial({ color: color('taxiTrim'), flatShading: true });
  const wheelMat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.16, 0.16, 0.18),
    flatShading: true,
  });

  // Two body chunks, big and yellow — the parts a viewer's eye will land on first.
  for (let i = 0; i < cfg.chunkCount; i++) {
    makePiece(scene, new THREE.BoxGeometry(...cfg.bodySize), bodyMat, pieces);
  }

  // Cabin lid, in glass colour.
  makePiece(scene, new THREE.BoxGeometry(...cfg.cabinSize), cabinMat, pieces);

  // Roof sign — same proportions as the intact one, so it reads as the sign specifically.
  makePiece(scene, new THREE.BoxGeometry(...cfg.signSize), signMat, pieces);

  // Four wheels. Cylinder rotated onto its side so the flat face shows the tyre disc.
  for (let i = 0; i < cfg.wheelCount; i++) {
    const wheelGeo = new THREE.CylinderGeometry(cfg.wheelRadius, cfg.wheelRadius, cfg.wheelWidth, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    makePiece(scene, wheelGeo, wheelMat, pieces);
  }

  // Trim strips off the flanks.
  for (let i = 0; i < cfg.trimCount; i++) {
    makePiece(scene, new THREE.BoxGeometry(...cfg.trimSize), trimMat, pieces);
  }

  // Shrapnel: small chunks alternating between the body colour and dark trim/rubber, in
  // three shapes (little cubes, thin plates, faceted tets) so the burst reads as jagged debris
  // rather than a repeat of the same speck. Marked with `shrapnel = true` so the burst step
  // knows to launch them harder and higher than the recognisable body parts.
  const shrapnelMats = [bodyMat, trimMat, wheelMat, signMat];
  for (let i = 0; i < cfg.shrapnelCount; i++) {
    const mat = shrapnelMats[i % shrapnelMats.length];
    let geo;
    const shape = i % 3;
    if (shape === 0) {
      const s = 0.14 + (i % 4) * 0.05;
      geo = new THREE.BoxGeometry(s, s, s);
    } else if (shape === 1) {
      geo = new THREE.BoxGeometry(0.28, 0.06, 0.18);
    } else {
      geo = new THREE.TetrahedronGeometry(0.18);
    }
    makePiece(scene, geo, mat, pieces);
    pieces[pieces.length - 1].shrapnel = true;
  }

  /** Fire the whole set outward from (x, z). Idempotent — a second call re-shoots the same pool. */
  function burst(x, z) {
    for (const p of pieces) {
      p.mesh.visible = true;
      p.life = cfg.life * rng.range(cfg.lifeJitterMin, cfg.lifeJitterMax);
      p.mesh.position.set(
        x + rng.jitter(cfg.spawnJitterXZ),
        cfg.spawnHeightMin + rng.range(0, cfg.spawnHeightMax - cfg.spawnHeightMin),
        z + rng.jitter(cfg.spawnJitterXZ),
      );
      const angle = rng.range(0, Math.PI * 2);
      const speed = p.shrapnel
        ? rng.range(cfg.shrapnelSpeedMin, cfg.shrapnelSpeedMax)
        : rng.range(cfg.bigSpeedMin, cfg.bigSpeedMax);
      p.vx = Math.cos(angle) * speed;
      p.vy = p.shrapnel
        ? rng.range(cfg.shrapnelUpMin, cfg.shrapnelUpMax)
        : rng.range(cfg.bigUpMin, cfg.bigUpMax);
      p.vz = Math.sin(angle) * speed;
      const spin = p.shrapnel ? cfg.shrapnelSpin : cfg.bigSpin;
      p.wx = rng.range(-spin, spin);
      p.wy = rng.range(-spin, spin);
      p.wz = rng.range(-spin, spin);
      p.mesh.rotation.set(
        rng.range(0, Math.PI * 2),
        rng.range(0, Math.PI * 2),
        rng.range(0, Math.PI * 2),
      );
      p.material.opacity = 1;
    }
  }

  function update(dt) {
    for (const p of pieces) {
      if (p.life <= 0) continue;
      p.life -= dt;

      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= cfg.gravity * dt;

      // Ground bounce. One meaningful rebound then it settles — a per-piece resting height keeps
      // small pieces from Z-fighting with each other at exactly the same y. Shrapnel bounces
      // livelier than the big chunks so the tail of the burst still has motion in it.
      if (p.mesh.position.y < cfg.groundY) {
        p.mesh.position.y = cfg.groundY;
        const restitution = p.shrapnel ? cfg.shrapnelRestitution : cfg.bigRestitution;
        const friction = p.shrapnel ? cfg.shrapnelFriction : cfg.bigFriction;
        p.vy = -p.vy * restitution;
        p.vx *= friction;
        p.vz *= friction;
        p.wx *= 0.75;
        p.wy *= 0.75;
        p.wz *= 0.75;
      }

      p.mesh.rotation.x += p.wx * dt;
      p.mesh.rotation.y += p.wy * dt;
      p.mesh.rotation.z += p.wz * dt;

      // Air-damp the spin, otherwise every piece keeps tumbling at full speed even after
      // hitting the ground and reads as spring-loaded rather than heavy.
      const damp = Math.exp(-cfg.spinDamp * dt);
      p.wx *= damp;
      p.wy *= damp;
      p.wz *= damp;

      // Fade only in the final tail so most of the flight is at full opacity.
      if (p.life < cfg.fadeTail) {
        p.material.opacity = Math.max(0, p.life / cfg.fadeTail);
      }

      if (p.life <= 0) {
        p.mesh.visible = false;
        p.material.opacity = 1;
      }
    }
  }

  function reset() {
    for (const p of pieces) {
      p.life = 0;
      p.mesh.visible = false;
      p.material.opacity = 1;
    }
  }

  return { burst, update, reset, cfg, pieces };
}
