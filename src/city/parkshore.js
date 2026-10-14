import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { coastNorth, harborBasin } from './grid.js';
import { KERB_H, FADE_RINGS } from './ground.js';
import { northParkBounds, PARK_FADE, NORTH_THIN } from './northpark.js';
import { parkShore, seawallX } from './harborplan.js';

// The park shore (`?parkshore=classic` keeps the seawall curling west under the park's corner).
//
// Tyler, 2026-10-14, circling where the harbor's rocks stopped at the north park: "Let's continue
// the rocky edge along the park to make this transition smoother". The seawall and its rocks now
// run straight on north beside the park (harborplan.js `islandHalf`, harbor.js builds them), and
// this is the strip of ground between the park's east edge and that wall: the park's own kerb
// platform, pavement band and lawn carried on to the water, and fading out north with the park.
//
// No rng: it is the park's ground in the park's colours, and drawing from a stream for nothing
// would only make it a stream to keep stable.

// Heights, as northpark.js names them (CLAUDE.md: two flat surfaces at one height shimmer).
const LAWN_Y = KERB_H + 0.01;
// The park's pavement along the ring road, carried on (northpark.js `WALK`).
const WALK = 1.8;

/** A flat world-space (x, z) polygon at height y, facing up. */
function flat(points, y, colour) {
  // Shape-space y is world -z under the rotateX(-PI/2) below; anticlockwise there faces up.
  const pts = points.map(([x, z]) => new THREE.Vector2(x, -z));
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return bakeColor(geo, colour);
}

/** The same polygon as a kerb block from the ground up to `h`. */
function slab(points, h, colour) {
  const pts = points.map(([x, z]) => new THREE.Vector2(x, -z));
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return bakeColor(geo, colour);
}

/**
 * The strip between the park's east edge and the seawall over z in [z0, z1], as an outline: the
 * park's edge, then the wall itself. The wall wobbles and can come in a hair past the park's edge
 * (it is `kerbX + 3.6` give or take 1.65, the park's edge `kerbX + 2`), so it is held off it.
 */
function strip(x1, z0, z1) {
  const kerbX = harborBasin().kerbX;
  const pts = [[x1, z1], [x1, z0]];
  const n = Math.max(1, Math.ceil((z1 - z0) / 1.5));
  for (let k = 0; k <= n; k++) {
    const z = z0 + ((z1 - z0) * k) / n;
    pts.push([Math.max(x1 + 0.05, seawallX(kerbX, z)), z]);
  }
  return pts;
}

/** The strip and its fade, or null without a park shore. */
export function createParkShore() {
  if (!parkShore()) return null;
  const b = northParkBounds();
  const zN = coastNorth();
  const parts = [
    slab(strip(b.x1, zN, b.z1), KERB_H, PALETTE.kerb),
    flat(strip(b.x1, b.z1 - WALK, b.z1), LAWN_Y, PALETTE.sidewalk),
    flat(strip(b.x1, zN, b.z1 - WALK), LAWN_Y, PALETTE.park),
  ];
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'park-shore';
  // The lawn as `city/grass.js` scatters tufts over it, on the park's terms (city/northpark.js):
  // thinning north the way the park's do, and out over the last few units before the fade.
  const kerbX = harborBasin().kerbX;
  const z1 = b.z1 - WALK;
  const grass = {
    bounds: { x0: b.x1, x1: Math.max(...strip(b.x1, zN, z1).map(([x]) => x)), z0: zN, z1 },
    inside: (x, z) => z > zN + 0.05 && z < z1 - 0.05 && x > b.x1 + 0.05 && x < seawallX(kerbX, z) - 0.3,
    density: (x, z) => {
      const north = (b.z1 - z) / (b.z1 - b.z0);
      return Math.max(0, 1 - NORTH_THIN * north) * Math.min(1, Math.max(0, (z - zN) / 8));
    },
  };
  return { mesh, fade: northFade(b.x1, zN), grass };
}

/**
 * The strip's lawn carried on north over the park's own feather (`PARK_FADE`), on the same curve,
 * so the park and the strip fade out as one lawn. Alpha in a 4-component vertex colour, as
 * northpark.js `lawnFade` does it.
 */
function northFade(x1, zN) {
  const col = new THREE.Color(PALETTE.park);
  const alphaAt = (t) => 1 - t * t * (3 - 2 * t);
  const x2 = Math.max(x1 + 0.05, seawallX(harborBasin().kerbX, zN));
  const pos = [];
  const cols = [];
  for (let r = 0; r < FADE_RINGS; r++) {
    const za = zN - (PARK_FADE * r) / FADE_RINGS;
    const zb = zN - (PARK_FADE * (r + 1)) / FADE_RINGS;
    const A = [x1, za, alphaAt(r / FADE_RINGS)]; const B = [x2, za, alphaAt(r / FADE_RINGS)];
    const C = [x2, zb, alphaAt((r + 1) / FADE_RINGS)]; const D = [x1, zb, alphaAt((r + 1) / FADE_RINGS)];
    for (const [a, c1, c2] of [[A, B, C], [A, C, D]]) {
      // Turned to face up from its own winding: y of (c1 - a) x (c2 - a) in the x-z plane.
      const ny = (c1[1] - a[1]) * (c2[0] - a[0]) - (c1[0] - a[0]) * (c2[1] - a[1]);
      for (const [x, z, al] of ny >= 0 ? [a, c1, c2] : [a, c2, c1]) {
        pos.push(x, LAWN_Y, z);
        cols.push(col.r, col.g, col.b, al);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 4));
  geo.computeVertexNormals();
  const material = propMaterial();
  material.transparent = true;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.renderOrder = -1;
  mesh.name = 'park-shore-fade';
  return mesh;
}
