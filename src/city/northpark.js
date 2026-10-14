import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import {
  GRID_I, lineX, lineZ, halfRoadX, halfRoadZ, isArterialZ, LTRAIN_NS, NORTH_PARK, NORTH_PARK_DEPTH,
} from './grid.js';
import { KERB_H, EDGE_FADE, FADE_RINGS } from './ground.js';
import { treeParts } from './props.js';
import { patchLakeWater, getWaterStyle } from './riverwater.js';

// The big park along the city's north edge (`?northpark=classic` leaves the old apron).
//
// Tyler, 2026-10-13, after the island: "north edge: a big park (think Central Park). From game view
// will just look like map ends there at a park". So past the north ring road the asphalt gives way
// to a stone wall, a lawn with a lake and a loop of paths in it, and then trees — thickening to the
// north into a wood that the lawn fades out behind, so the map ends in green rather than on a line.
//
// Scenery only, the harbor's terms: nothing routes into it, no fare stands in it, and it is outside
// the ring road, so no street, block or junction moves. Its own rng stream.

// How far north of the ring road's kerb the solid lawn runs (owned by grid.js, which moves the map's
// north edge with it), and then the fade beyond it.
const DEPTH = NORTH_PARK_DEPTH;
const FADE = EDGE_FADE * 1.4;
// The pavement along the ring road, and the wall at its back.
const WALK = 1.8;
const WALL_H = 0.55;
const WALL_T = 0.45;
const GATE_W = 3.2;
// Paths: a loop round the lake and spurs from the gates to it.
const PATH_W = 1.3;
// What a tree keeps clear of: the paths, the lake's shore, the wall, the L's columns.
const TREE_CLEAR_PATH = 1.9;
const TREE_CLEAR_LAKE = 2.4;
const TREE_CLEAR_RAIL = 4;
const TREE_PITCH = 4.4;

// Heights, named off each other (CLAUDE.md: two flat surfaces at one height shimmer).
const TOP_Y = KERB_H;               // the platform
const LAWN_Y = TOP_Y + 0.01;        // lawn and pavement
const PATH_Y = LAWN_Y + 0.01;       // paths on the lawn
const BANK_Y = LAWN_Y + 0.012;      // the lake's shore band
const WATER_Y = LAWN_Y + 0.008;     // and its water, inside the band

/** Where the park is: the solid lawn's rectangle, with the ring road's kerb along its south side. */
export function northParkBounds() {
  const kN = lineZ(0) - halfRoadX(0);
  return {
    x0: lineX(0) - halfRoadZ(0) - 2,
    x1: lineX(GRID_I) + halfRoadZ(GRID_I) + 2,
    z0: kN - DEPTH,
    z1: kN,
    wall: kN - WALK - WALL_T / 2,
  };
}

/** The x of the L's line when it runs north over the park, or null. */
function railX() {
  if (!LTRAIN_NS) return null;
  for (let i = 1; i < GRID_I; i++) if (isArterialZ(i)) return lineX(i);
  return null;
}

export function createNorthPark(rng) {
  if (!NORTH_PARK) return null;
  const b = northParkBounds();
  const parts = [];
  const rail = railX();

  // --- The ground. A platform at kerb height, so its south face is the kerb the ring road runs
  // along; the pavement and the lawn on top of it.
  {
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    const slab = new THREE.BoxGeometry(w, TOP_Y, d);
    slab.translate((b.x0 + b.x1) / 2, TOP_Y / 2, (b.z0 + b.z1) / 2);
    parts.push(bakeColor(slab, PALETTE.kerb));
    parts.push(flat(b.x0, b.x1, b.z1 - WALK, b.z1, LAWN_Y, PALETTE.sidewalk));
    parts.push(flat(b.x0, b.x1, b.z0, b.z1 - WALK, LAWN_Y, PALETTE.park));
  }

  // --- The lake, in the middle of the lawn and nudged by the seed. An ellipse bent by two lobes,
  // the duck pond's recipe at reservoir size.
  const lake = {
    x: (b.x0 + b.x1) / 2 + rng.range(-14, 14),
    z: b.z0 + DEPTH * 0.52 + rng.range(-3, 3),
    rx: rng.range(13, 17),
    rz: rng.range(6.5, 8.5),
    l2: rng.range(0.06, 0.12), p2: rng.range(0, Math.PI * 2),
    l3: rng.range(0.03, 0.07), p3: rng.range(0, Math.PI * 2),
  };
  // Not under the L: slide it clear of the line on whichever side has more room.
  if (rail !== null && Math.abs(lake.x - rail) < lake.rx + TREE_CLEAR_RAIL) {
    lake.x = rail + Math.sign(lake.x - rail || 1) * (lake.rx + TREE_CLEAR_RAIL + 1);
    lake.x = THREE.MathUtils.clamp(lake.x, b.x0 + lake.rx + 6, b.x1 - lake.rx - 6);
  }
  const lakeR = (a, grow = 0) => {
    const k = 1 + lake.l2 * Math.sin(2 * a + lake.p2) + lake.l3 * Math.sin(3 * a + lake.p3);
    return { x: (lake.rx + grow) * k, z: (lake.rz + grow) * k };
  };
  const lakeAt = (a, grow = 0) => {
    const r = lakeR(a, grow);
    return { x: lake.x + Math.cos(a) * r.x, z: lake.z + Math.sin(a) * r.z };
  };
  /** How far outside the lake's shore (x, z) is, roughly, in units: negative inside. */
  const lakeDistance = (x, z) => {
    const a = Math.atan2((z - lake.z) / lake.rz, (x - lake.x) / lake.rx);
    const edge = lakeAt(a);
    const out = Math.hypot(x - lake.x, z - lake.z) - Math.hypot(edge.x - lake.x, edge.z - lake.z);
    return out;
  };
  parts.push(ring(lakeAt, 0, 1.1, BANK_Y, PALETTE.pondBank));
  const water = disc(lakeAt, WATER_Y, PALETTE.pondWater);

  // --- Paths: the loop round the lake, a little way out from its shore, and a spur from each gate
  // in the wall to the nearest point on it.
  const loop = [];
  for (let k = 0; k <= 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const wob = 1.2 * Math.sin(5 * a + lake.p2);
    loop.push(lakeAt(a, 5.5 + wob));
  }
  parts.push(ribbon(loop, PATH_W, PATH_Y, PALETTE.parkPath));
  const paths = [loop];
  const gates = [];
  const gateCount = 4;
  for (let g = 0; g < gateCount; g++) {
    const x = b.x0 + (b.x1 - b.x0) * ((g + 0.5) / gateCount) + rng.range(-5, 5);
    if (rail !== null && Math.abs(x - rail) < GATE_W + 2) continue;
    gates.push(x);
    // From the gap in the wall, north and bending toward the loop's nearest point.
    let best = loop[0];
    for (const p of loop) {
      if (Math.hypot(p.x - x, p.z - b.wall) < Math.hypot(best.x - x, best.z - b.wall)) best = p;
    }
    const start = { x, z: b.z1 - WALK };
    const mid = { x: x + (best.x - x) * 0.3 + rng.range(-2, 2), z: (start.z + best.z) / 2 };
    const spur = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16;
      // A quadratic through the midpoint: one easy bend, the way park paths run.
      const u = 1 - t;
      spur.push({
        x: u * u * start.x + 2 * u * t * mid.x + t * t * best.x,
        z: u * u * start.z + 2 * u * t * mid.z + t * t * best.z,
      });
    }
    parts.push(ribbon(spur, PATH_W, PATH_Y, PALETTE.parkPath));
    paths.push(spur);
  }

  // --- The wall along the pavement, broken at each gate, with a pier either side of every gap.
  {
    const stone = PALETTE.parkWall;
    const cuts = [...gates].sort((p, q) => p - q);
    let from = b.x0;
    const run = (x0, x1) => {
      if (x1 - x0 < 0.5) return;
      const g = new THREE.BoxGeometry(x1 - x0, WALL_H, WALL_T);
      g.translate((x0 + x1) / 2, LAWN_Y + WALL_H / 2, b.wall);
      parts.push(bakeColor(g, stone));
      const cap = new THREE.BoxGeometry(x1 - x0, 0.1, WALL_T + 0.14);
      cap.translate((x0 + x1) / 2, LAWN_Y + WALL_H + 0.05, b.wall);
      parts.push(bakeColor(cap, PALETTE.parkWallCap));
    };
    const pier = (x) => {
      const g = new THREE.BoxGeometry(0.8, WALL_H + 0.45, 0.8);
      g.translate(x, LAWN_Y + (WALL_H + 0.45) / 2, b.wall);
      parts.push(bakeColor(g, stone));
    };
    // The L's columns stand on the lawn, so the wall breaks round the line too.
    if (rail !== null) cuts.push(rail);
    cuts.sort((p, q) => p - q);
    for (const x of cuts) {
      const half = x === rail ? 1.4 : GATE_W / 2;
      run(from, x - half);
      if (x !== rail) { pier(x - half - 0.4); pier(x + half + 0.4); }
      from = x + half;
    }
    run(from, b.x1);
  }

  // --- Trees. A jittered grid over the lawn, kept off the paths, the lake and the line, and
  // thinned to open meadows near the city and closing up into a wood toward the fade. The camera
  // looks north-west, so nothing planted here can hide anything in the city: it is all up-screen.
  const crowns = [];
  const pathDistance = (x, z) => {
    let best = Infinity;
    for (const path of paths) {
      for (let k = 1; k < path.length; k++) best = Math.min(best, segDistance(x, z, path[k - 1], path[k]));
    }
    return best;
  };
  for (let z = b.z0 + 2; z < b.wall - 2.2; z += TREE_PITCH) {
    for (let x = b.x0 + 1.5; x < b.x1 - 1.5; x += TREE_PITCH) {
      const tx = x + rng.range(-1.6, 1.6);
      const tz = z + rng.range(-1.6, 1.6);
      // 0 at the wall, 1 at the far edge.
      const north = (b.z1 - tz) / DEPTH;
      const keep = 0.18 + 0.8 * north * north;
      const roll = rng.next();
      if (roll > keep) continue;
      if (tz > b.wall - 2 || tz < b.z0 + 1) continue;
      if (rail !== null && Math.abs(tx - rail) < TREE_CLEAR_RAIL) continue;
      if (lakeDistance(tx, tz) < TREE_CLEAR_LAKE) continue;
      if (pathDistance(tx, tz) < TREE_CLEAR_PATH) continue;
      parts.push(...treeParts(tx, tz, rng, { low: 4.2, high: 6.8, crowns }));
    }
  }

  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial({ smooth: true }));
  parts.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'north-park';

  // The river's surface, on the duck pond's compose (`patchLakeWater`, city/riverwater.js). Every
  // body of water wears it — `tools/probe.mjs` checks — except under `?water=classic`.
  const waterMat = propMaterial({ ao: false });
  if (getWaterStyle() !== 'classic') patchLakeWater(waterMat, lake);
  const waterMesh = new THREE.Mesh(water, waterMat);
  waterMesh.receiveShadow = true;
  waterMesh.name = 'north-park-lake';

  return { mesh, water: waterMesh, fade: lawnFade(b), crowns, bounds: b, lake };
}

// --- Builders ----------------------------------------------------------------------------------

/** A flat rectangle at `y`, facing up. */
function flat(x0, x1, z0, z1, y, colour) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return bakeColor(g, colour);
}

/**
 * Triangles from a list of (x, z) corner triples at height `y`, each wound to face up whatever
 * order it was handed in: the normal is computed from the winding and the triangle flipped if it
 * points down (CLAUDE.md: hand-written triangles have their winding asserted, not eyeballed).
 */
function upTriangles(tris, y, colour) {
  const pos = [];
  for (const [a, b, c] of tris) {
    // y of (b - a) × (c - a), with x-z as the plane: positive faces up.
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const order = ny >= 0 ? [a, b, c] : [a, c, b];
    for (const p of order) pos.push(p.x, y, p.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return bakeColor(g, colour);
}

/** A strip `w` wide down a polyline. */
function ribbon(pts, w, y, colour) {
  const left = [];
  const right = [];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[Math.max(0, k - 1)];
    const q = pts[Math.min(pts.length - 1, k + 1)];
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = -(q.z - p.z) / len;
    const nz = (q.x - p.x) / len;
    left.push({ x: pts[k].x + nx * w / 2, z: pts[k].z + nz * w / 2 });
    right.push({ x: pts[k].x - nx * w / 2, z: pts[k].z - nz * w / 2 });
  }
  const tris = [];
  for (let k = 1; k < pts.length; k++) {
    tris.push([left[k - 1], right[k - 1], right[k]], [left[k - 1], right[k], left[k]]);
  }
  return upTriangles(tris, y, colour);
}

/** The band from a closed outline `at(a, 0)` out to `at(a, w)`. */
function ring(at, inner, w, y, colour) {
  const n = 64;
  const tris = [];
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const p0 = at(a0, inner - 0.6);
    const p1 = at(a1, inner - 0.6);
    const q0 = at(a0, inner + w);
    const q1 = at(a1, inner + w);
    tris.push([p0, q0, q1], [p0, q1, p1]);
  }
  return upTriangles(tris, y, colour);
}

/** The closed outline `at(a, 0)` filled from its centre. */
function disc(at, y, colour) {
  const n = 64;
  const ring0 = Array.from({ length: n }, (_, k) => at((k / n) * Math.PI * 2, 0));
  const cx = ring0.reduce((s, p) => s + p.x, 0) / n;
  const cz = ring0.reduce((s, p) => s + p.z, 0) / n;
  const tris = [];
  for (let k = 0; k < n; k++) tris.push([{ x: cx, z: cz }, ring0[k], ring0[(k + 1) % n]]);
  return upTriangles(tris, y, colour);
}

function segDistance(x, z, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}

/**
 * The lawn's own feather off its west, north and east edges: rings of grass stepping outward, alpha
 * 1 to 0 on a smoothstep, the way the asphalt's skirt fades (ground.js `asphaltFade`). Corners go
 * round on a fan so the skirt has no notch. Not along the south: that edge is the kerb.
 */
function lawnFade(b) {
  const col = new THREE.Color(PALETTE.park);
  const pos = [];
  const cols = [];
  const alphaAt = (t) => 1 - t * t * (3 - 2 * t);
  // The outline, west edge going north, the north edge going east, the east edge going south, with
  // each point's outward direction.
  const outline = [];
  const corner = (cx, cz, a0, a1) => {
    for (let k = 0; k <= 8; k++) {
      const a = a0 + (a1 - a0) * (k / 8);
      outline.push({ x: cx, z: cz, nx: Math.cos(a), nz: Math.sin(a) });
    }
  };
  outline.push({ x: b.x0, z: b.z1, nx: -1, nz: 0 });
  corner(b.x0, b.z0, Math.PI, Math.PI * 1.5);
  corner(b.x1, b.z0, Math.PI * 1.5, Math.PI * 2);
  outline.push({ x: b.x1, z: b.z1, nx: 1, nz: 0 });
  const tris = [];
  for (let ring = 0; ring < FADE_RINGS; ring++) {
    for (let k = 1; k < outline.length; k++) {
      const p = outline[k - 1];
      const q = outline[k];
      const at = (o, r) => ({
        x: o.x + o.nx * FADE * (r / FADE_RINGS),
        z: o.z + o.nz * FADE * (r / FADE_RINGS),
        a: alphaAt(r / FADE_RINGS),
      });
      tris.push([at(p, ring), at(q, ring), at(q, ring + 1)], [at(p, ring), at(q, ring + 1), at(p, ring + 1)]);
    }
  }
  for (const [a, c1, c2] of tris) {
    const ny = (c1.z - a.z) * (c2.x - a.x) - (c1.x - a.x) * (c2.z - a.z);
    if (Math.abs(ny) < 1e-9) continue;   // the corner fans' first ring is a point
    for (const p of ny > 0 ? [a, c1, c2] : [a, c2, c1]) {
      pos.push(p.x, LAWN_Y, p.z);
      cols.push(col.r, col.g, col.b, p.a);
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
  mesh.name = 'north-park-fade';
  return mesh;
}

/** For the probe: the winding helper's verdict on a triangle, as the sign of its normal's y. */
export const _upTriangles = upTriangles;
