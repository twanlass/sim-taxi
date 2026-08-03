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

const GRAVITY = 24;
const LIFE = 3.4;
const FADE_TAIL = 1.0;

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
    makePiece(scene, new THREE.BoxGeometry(1.4, 0.55, 1.3), bodyMat, pieces);
  }

  // Cabin lid, in glass colour.
  makePiece(scene, new THREE.BoxGeometry(1.5, 0.55, 1.4), cabinMat, pieces);

  // Roof sign — same proportions as the intact one, so it reads as the sign specifically.
  makePiece(scene, new THREE.BoxGeometry(0.75, 0.34, 0.4), signMat, pieces);

  // Four wheels. Cylinder rotated onto its side so the flat face shows the tyre disc.
  for (let i = 0; i < 4; i++) {
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    makePiece(scene, wheelGeo, wheelMat, pieces);
  }

  // Trim strips off the flanks.
  for (let i = 0; i < 2; i++) {
    makePiece(scene, new THREE.BoxGeometry(0.6, 0.2, 0.08), trimMat, pieces);
  }

  /** Fire the whole set outward from (x, z). Idempotent — a second call re-shoots the same pool. */
  function burst(x, z) {
    for (const p of pieces) {
      p.mesh.visible = true;
      p.life = LIFE * rng.range(0.85, 1.2);
      p.mesh.position.set(
        x + rng.jitter(0.35),
        0.9 + rng.range(0, 0.5),
        z + rng.jitter(0.35),
      );
      const angle = rng.range(0, Math.PI * 2);
      const speed = rng.range(4, 9);
      p.vx = Math.cos(angle) * speed;
      p.vy = rng.range(4.5, 8.5);
      p.vz = Math.sin(angle) * speed;
      p.wx = rng.range(-9, 9);
      p.wy = rng.range(-9, 9);
      p.wz = rng.range(-9, 9);
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
      // small pieces from Z-fighting with each other at exactly the same y.
      if (p.mesh.position.y < 0.15) {
        p.mesh.position.y = 0.15;
        p.vy = -p.vy * 0.35;
        p.vx *= 0.65;
        p.vz *= 0.65;
        p.wx *= 0.55;
        p.wy *= 0.55;
        p.wz *= 0.55;
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
