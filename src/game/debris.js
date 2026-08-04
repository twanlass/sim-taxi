import * as THREE from 'three';
import { color } from '../palette.js';

// Vehicle wreckage. Individual meshes rather than instances — there are only ~10 pieces per crash
// and each one carries its own material for the per-piece opacity fade, so the instancing cost
// wouldn't pay off. Shapes mirror what taxi.js merges into the shell (body, cabin, sign, four
// wheels, two trim stripes) so the burst reads as *this taxi* flying apart, not as generic
// rubble. A crash wrecks two cars, so main.js keeps two pools: the taxi's, and one repainted at
// burst time in the colour of the car it hit.
//
// Ballistic physics: initial radial-plus-up velocity, gravity, one damped ground bounce, spin
// under an exponentially damped angular velocity. Lifetimes are short — the wreck focus and the
// smoke plume carry the rest of the beat — with a per-piece opacity fade in the last second so
// nothing pops out.

const GRAVITY = 24;
const LIFE = 3.4;
const FADE_TAIL = 1.0;

// Small shrapnel — cheap boxes and tets, tuned to fly farther and spin harder than the big
// chunks. Twenty extra motes on top of the recognisable body parts turns the burst from
// "the taxi came apart" into "the taxi came *apart*".
const SHRAPNEL_COUNT = 20;
const SHRAPNEL_SPEED_MIN = 6;
const SHRAPNEL_SPEED_MAX = 13;
const SHRAPNEL_UP_MIN = 6;
const SHRAPNEL_UP_MAX = 12;

/**
 * One mesh with its own physics state slot. `paint` marks the pieces that carry the car's colour
 * rather than glass or rubber — those are what a tinted burst recolours.
 */
function makePiece(scene, geometry, baseMaterial, pieces, paint = false) {
  const material = baseMaterial.clone();
  material.transparent = true;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.visible = false;
  scene.add(mesh);
  const piece = {
    mesh,
    material,
    paint,
    life: 0,
    vx: 0, vy: 0, vz: 0,
    wx: 0, wy: 0, wz: 0,
  };
  pieces.push(piece);
  return piece;
}

export function createDebris(scene, rng) {
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
  for (let i = 0; i < 2; i++) {
    makePiece(scene, new THREE.BoxGeometry(1.4, 0.55, 1.3), bodyMat, pieces, true);
  }

  // Cabin lid, in glass colour.
  makePiece(scene, new THREE.BoxGeometry(1.5, 0.55, 1.4), cabinMat, pieces);

  // Roof sign — same proportions as the intact one, so it reads as the sign specifically.
  makePiece(scene, new THREE.BoxGeometry(0.75, 0.34, 0.4), signMat, pieces, true);

  // Four wheels. Cylinder rotated onto its side so the flat face shows the tyre disc.
  for (let i = 0; i < 4; i++) {
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    makePiece(scene, wheelGeo, wheelMat, pieces);
  }

  // Trim strips off the flanks.
  for (let i = 0; i < 2; i++) {
    makePiece(scene, new THREE.BoxGeometry(0.6, 0.2, 0.08), trimMat, pieces, true);
  }

  // Shrapnel: twenty small chunks alternating between the body colour and dark trim/rubber, in
  // three shapes (little cubes, thin plates, faceted tets) so the burst reads as jagged debris
  // rather than a repeat of the same speck. Marked with `shrapnel = true` so the burst step
  // knows to launch them harder and higher than the recognisable body parts.
  const shrapnelMats = [bodyMat, trimMat, wheelMat, signMat];
  const shrapnelPaint = [true, true, false, true];   // parallel to shrapnelMats — rubber isn't paint
  for (let i = 0; i < SHRAPNEL_COUNT; i++) {
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
    makePiece(scene, geo, mat, pieces, shrapnelPaint[i % shrapnelMats.length]).shrapnel = true;
  }

  /**
   * Fire the whole set outward from (x, z). Idempotent — a second call re-shoots the same pool,
   * which is why the taxi and the car it hits each get a pool of their own rather than sharing.
   *
   * `tint` repaints the bodywork pieces (glass, rubber and the cabin lid keep their own colours),
   * so an ambient car's wreckage comes apart in that car's paint instead of in taxi yellow.
   */
  function burst(x, z, tint = null) {
    for (const p of pieces) {
      if (tint && p.paint) p.material.color.set(tint);
      p.mesh.visible = true;
      p.life = LIFE * rng.range(0.85, 1.2);
      p.mesh.position.set(
        x + rng.jitter(0.35),
        0.9 + rng.range(0, 0.5),
        z + rng.jitter(0.35),
      );
      const angle = rng.range(0, Math.PI * 2);
      const speed = p.shrapnel
        ? rng.range(SHRAPNEL_SPEED_MIN, SHRAPNEL_SPEED_MAX)
        : rng.range(4, 9);
      p.vx = Math.cos(angle) * speed;
      p.vy = p.shrapnel
        ? rng.range(SHRAPNEL_UP_MIN, SHRAPNEL_UP_MAX)
        : rng.range(4.5, 8.5);
      p.vz = Math.sin(angle) * speed;
      const spin = p.shrapnel ? 18 : 9;
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
      p.vy -= GRAVITY * dt;

      // Ground bounce. One meaningful rebound then it settles — a per-piece resting height keeps
      // small pieces from Z-fighting with each other at exactly the same y. Shrapnel bounces
      // livelier than the big chunks so the tail of the burst still has motion in it.
      if (p.mesh.position.y < 0.15) {
        p.mesh.position.y = 0.15;
        const restitution = p.shrapnel ? 0.6 : 0.35;
        const friction = p.shrapnel ? 0.85 : 0.65;
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
      const damp = Math.exp(-0.6 * dt);
      p.wx *= damp;
      p.wy *= damp;
      p.wz *= damp;

      // Fade only in the final tail so most of the flight is at full opacity.
      if (p.life < FADE_TAIL) {
        p.material.opacity = Math.max(0, p.life / FADE_TAIL);
      }

      if (p.life <= 0) {
        p.mesh.visible = false;
        p.material.opacity = 1;
      }
    }
  }

  return { burst, update };
}
