import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { KERB_H } from '../city/ground.js';
import { nextIntersection } from '../city/grid.js';
import { intersectionCentre } from './fares.js';

/**
 * Draws the taxi's planned route along the road centrelines.
 *
 * Without it the player has no way to tell whether their tap registered or which way the taxi
 * intends to go — the car just keeps driving and you find out at the next junction. Flight Control
 * makes the drawn path the entire interface, and the same reasoning applies here.
 *
 * Drawn as a flat ribbon rather than a THREE.Line: `linewidth` is ignored by every WebGL renderer,
 * so a Line is always one pixel wide and reads as a hairline over a busy road.
 */
// Width is specified in *pixels* and converted to world units per frame. A fixed world width
// looks completely different depending on window size, and this is a UI element — it should be
// the same weight on every screen.
const WIDTH_PX = 2;
const MAX_POINTS = 32;

export function createRouteLine(scene, getWorldPerPixel = () => 0.13) {
  // Two triangles per segment.
  const positions = new Float32Array(MAX_POINTS * 6 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.routeLine),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,        // the road is busy; the route has to stay readable over traffic
      side: THREE.DoubleSide,
    }),
  );
  mesh.renderOrder = 6;   // under the taxi's selection ring, which is renderOrder 8
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  function update(car, route) {
    // A car mid-turn has already consumed its routed step, but car.i/car.j still name the
    // intersection it is turning *at*. Walking the remaining route from there applies each
    // direction one junction too early, and the drawn path visibly re-shapes on every turn.
    let i = car.i;
    let j = car.j;
    if (car.state === 'turn') {
      const after = nextIntersection(car.dOut, car.i, car.j);
      if (after) { i = after.i; j = after.j; }
    }

    const pts = [{ x: car.x, z: car.z }, intersectionCentre(i, j)];
    for (const dir of route ?? []) {
      const next = nextIntersection(dir, i, j);
      if (!next) break;
      i = next.i;
      j = next.j;
      pts.push(intersectionCentre(i, j));
      if (pts.length >= MAX_POINTS) break;
    }

    const halfWidth = (WIDTH_PX * getWorldPerPixel()) / 2;
    const y = KERB_H + 0.14;
    let v = 0;
    const push = (x, z) => { positions[v++] = x; positions[v++] = y; positions[v++] = z; };

    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.001) continue;

      // Perpendicular in the ground plane.
      const nx = (-dz / len) * halfWidth;
      const nz = (dx / len) * halfWidth;

      push(a.x + nx, a.z + nz); push(b.x + nx, b.z + nz); push(b.x - nx, b.z - nz);
      push(a.x + nx, a.z + nz); push(b.x - nx, b.z - nz); push(a.x - nx, a.z - nz);
    }

    geometry.setDrawRange(0, v / 3);
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh.visible = v > 0;
  }

  return { mesh, update, hide: () => { mesh.visible = false; } };
}
