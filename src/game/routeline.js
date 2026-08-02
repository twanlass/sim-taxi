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

// Corners are rounded rather than mitred to a point. The route is a driving line, and a car
// cannot take a 90° corner as a 90° corner — a square turn reads as a wire diagram laid over the
// city instead of a path something is about to drive.
//
// Radius is a little over half a lane: wide enough to read as an arc at play zoom, tight enough
// that the line still visibly belongs to the junction it turns at rather than cutting the block.
const CORNER_RADIUS = 5;
const CORNER_STEPS = 8;

// Each corner expands into CORNER_STEPS + 1 points, plus the two endpoints.
const MAX_PATH = MAX_POINTS * (CORNER_STEPS + 1) + 2;

/**
 * Replace every interior corner with a quadratic Bézier fillet, using the corner itself as the
 * control point. The curve is tangent to both legs, so the rounded path leaves and rejoins the
 * road centreline pointing exactly the way the original polyline did.
 */
function roundCorners(pts) {
  if (pts.length < 3) return pts;

  const out = [pts[0]];

  for (let k = 1; k < pts.length - 1; k++) {
    const prev = pts[k - 1];
    const here = pts[k];
    const next = pts[k + 1];

    const inX = here.x - prev.x;
    const inZ = here.z - prev.z;
    const outX = next.x - here.x;
    const outZ = next.z - here.z;
    const inLen = Math.hypot(inX, inZ);
    const outLen = Math.hypot(outX, outZ);
    if (inLen < 0.001 || outLen < 0.001) continue;

    // Going straight on. Rounding a zero-angle corner just emits a run of duplicate points.
    const turn = (inX * outZ - inZ * outX) / (inLen * outLen);
    if (Math.abs(turn) < 0.001) { out.push(here); continue; }

    // Never eat more than half of either leg, or fillets at consecutive junctions overlap and the
    // line starts cutting across blocks.
    const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    const from = { x: here.x - (inX / inLen) * r, z: here.z - (inZ / inLen) * r };
    const to = { x: here.x + (outX / outLen) * r, z: here.z + (outZ / outLen) * r };

    out.push(from);
    for (let s = 1; s < CORNER_STEPS; s++) {
      const t = s / CORNER_STEPS;
      const u = 1 - t;
      out.push({
        x: u * u * from.x + 2 * u * t * here.x + t * t * to.x,
        z: u * u * from.z + 2 * u * t * here.z + t * t * to.z,
      });
    }
    out.push(to);
  }

  out.push(pts[pts.length - 1]);
  return out.length > MAX_PATH ? out.slice(0, MAX_PATH) : out;
}

/**
 * Half-width offset at each path point, along the mitre of its two adjacent segments, so the
 * ribbon keeps a constant width around a bend instead of gapping on the outside of every join.
 */
function mitreOffsets(path, halfWidth) {
  const dirs = [];
  for (let k = 0; k < path.length - 1; k++) {
    const dx = path[k + 1].x - path[k].x;
    const dz = path[k + 1].z - path[k].z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / len, z: dz / len });
  }
  if (!dirs.length) dirs.push({ x: 1, z: 0 });

  const offsets = [];
  for (let k = 0; k < path.length; k++) {
    const into = dirs[Math.min(Math.max(k - 1, 0), dirs.length - 1)];
    const outOf = dirs[Math.min(k, dirs.length - 1)];

    const nx = -outOf.z;                 // normal of the outgoing segment
    const nz = outOf.x;

    let tx = into.x + outOf.x;
    let tz = into.z + outOf.z;
    const tLen = Math.hypot(tx, tz);
    if (tLen < 1e-4) {                   // doubled back on itself; there is no meaningful mitre
      offsets.push({ x: nx * halfWidth, z: nz * halfWidth });
      continue;
    }
    tx /= tLen;
    tz /= tLen;

    const mx = -tz;
    const mz = tx;
    const denom = mx * nx + mz * nz;
    // A near-zero denominator is an almost-reversed join, where the true mitre runs to infinity.
    // Fall back to a butt join rather than firing a spike across the map.
    const scale = Math.abs(denom) > 0.25 ? halfWidth / denom : halfWidth;
    offsets.push({ x: mx * scale, z: mz * scale });
  }

  return offsets;
}

export function createRouteLine(scene, getWorldPerPixel = () => 0.13) {
  // Two triangles per segment of the *densified* path.
  const positions = new Float32Array(MAX_PATH * 6 * 3);
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

    const path = roundCorners(pts);

    const halfWidth = (WIDTH_PX * getWorldPerPixel()) / 2;
    const y = KERB_H + 0.14;
    let v = 0;
    const push = (x, z) => { positions[v++] = x; positions[v++] = y; positions[v++] = z; };

    // Offset each point along its mitre rather than offsetting each segment independently.
    // Independent segments leave a wedge of empty road on the outside of every join — invisible
    // at 90° corners because the corner was the notch, but obvious across an eight-step arc.
    const offsets = mitreOffsets(path, halfWidth);

    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const oa = offsets[k];
      const ob = offsets[k + 1];

      push(a.x + oa.x, a.z + oa.z); push(b.x + ob.x, b.z + ob.z); push(b.x - ob.x, b.z - ob.z);
      push(a.x + oa.x, a.z + oa.z); push(b.x - ob.x, b.z - ob.z); push(a.x - oa.x, a.z - oa.z);
    }

    geometry.setDrawRange(0, v / 3);
    geometry.attributes.position.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh.visible = v > 0;
  }

  return { mesh, update, hide: () => { mesh.visible = false; } };
}
