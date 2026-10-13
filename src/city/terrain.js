import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColors, bakeColor, propMaterial, jitterVertices } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { riverBanks } from './grid.js';
import { treeParts } from './props.js';
import { KERB_H } from './ground.js';
import {
  ISLAND, SEA_Y, pad, padDistance, landHeight, coastDistance, beachiness, mountainLift,
} from './coast.js';
import { patchOceanWater } from './riverwater.js';
import { railPath, railDistance, RAIL_CUT_FLOOR, RAIL_DECK_TOP, PORTAL_GROUND, PORTAL_DEPTH, CUT_HALF, CUT_SLOPE } from './railpath.js';

// The island's ground outside the city, and the ocean round it (`city/coast.js` says what shape
// both are and why). Two meshes on one grid: the terrain draws every cell that has land above the
// sea in it, the ocean every cell with sea, and where they overlap the terrain simply stands out of
// the water — the shoreline is their intersection, not a line either of them draws.

// The grid: fine near the city, where the coast and the mountain's lower slopes are in view at play
// zoom, and coarse past that out to a horizon the fog has long since swallowed. 2.5 units is about
// 19px a cell at play zoom, which is low-poly rather than smooth.
const FINE = 2.5;
const FINE_WEST = 80;
const FINE_EAST = 70;
const FINE_SOUTH = 70;
const FINE_NORTH = 150;
// The coarse rings, as distances out from the fine box. The last is far enough that no zoom and no
// pan can see past it (the frustum is 300 units tall at the widest zoom).
const COARSE = [8, 20, 45, 90, 180, 360, 720, 1400];

// The ocean sits a hair under the river's strip, which lies over it for the last few units of each
// mouth while the river fades out (`islandWaterMesh` in river.js). Two surfaces at one height
// would shimmer; three centimetres is invisible from up here and clears it.
const OCEAN_DROP = 0.03;
// Deep enough that the seabed is lost: the ocean's shader is opaque blue below this.
const DEPTH_CAP = 14;

/** Grid lines along one axis: the fine run, every line in `exact`, and the coarse rings either side. */
function gridLines(from, to, exact) {
  const out = [...exact];
  for (let v = from; v < to; v += FINE) out.push(v);
  out.push(to);
  for (const r of COARSE) out.push(from - r, to + r);
  return [...new Set(out.map((v) => +v.toFixed(5)))].sort((a, b) => a - b);
}

/**
 * Shake a vertex off the grid by a hash of where it is — never of its index, which would tear the
 * surface apart where neighbouring cells meet (CLAUDE.md). Nothing within a unit and a half of the
 * pad moves, so the terrain still meets the walk on its edge.
 */
function jitter(x, z, cell, p) {
  if (padDistance(x, z, p) < 1.5 || cell > FINE * 1.5) return [x, z];
  const h1 = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  const h2 = Math.sin(x * 39.3468 + z * 11.135) * 24634.6345;
  const a = (h1 - Math.floor(h1)) - 0.5;
  const b = (h2 - Math.floor(h2)) - 0.5;
  return [x + a * cell * 0.45, z + b * cell * 0.45];
}

/**
 * The colour a facet of land wears, from its height, its slope and where it is: sand on a beach,
 * bare rock on a cliff, grass on the verge going to forest up the mountain, rock above that and
 * snow on top.
 */
function landColour(x, z, y, up, beach, lift) {
  const g = coastDistance(x, z);
  if (y < SEA_Y + 0.35) return beach > 0.5 ? 'sandWet' : 'cliff';
  if (beach > 0.5 && y < SEA_Y + 1.6 && g < 9) return 'sand';
  // Snow line and tree line, each wandering a little with position so neither is a contour.
  const wobble = 4 * Math.sin(x * 0.21 + z * 0.13) + 2 * Math.sin(x * 0.57 - z * 0.31);
  if (y > 44 + wobble) return up < 0.55 ? 'mountainRock' : 'snow';
  if (up < 0.62) return lift > 3 ? 'mountainRock' : 'cliff';
  if (y > 30 + wobble) return 'mountainRock';
  if (lift > 3.5) return 'forest';
  return Math.sin(x * 0.11) * Math.sin(z * 0.13) > 0.35 ? 'vergeDry' : 'verge';
}

/**
 * The island outside the city: `{ terrain, ocean }`, or null on the classic slab.
 */
export function createTerrain(rng) {
  if (!ISLAND) return null;
  const p = pad();
  const banks = riverBanks();
  const xs = gridLines(p.x0 - FINE_WEST, p.x1 + FINE_EAST, [p.x0, p.x1]);
  const zs = gridLines(p.z0 - FINE_NORTH, p.z1 + FINE_SOUTH,
    [p.z0, p.z1, ...(banks ? [banks.z0, banks.z1] : [])]);

  // Heights on the grid, once: each vertex is shared by up to six triangles across two meshes.
  const nx = xs.length;
  const nz = zs.length;
  const vx = new Float32Array(nx * nz);
  const vz = new Float32Array(nx * nz);
  const vy = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const cell = Math.max(xs[Math.min(i + 1, nx - 1)] - xs[Math.max(i - 1, 0)],
        zs[Math.min(j + 1, nz - 1)] - zs[Math.max(j - 1, 0)]) / 2;
      const [x, z] = jitter(xs[i], zs[j], cell, p);
      const k = i * nz + j;
      vx[k] = x;
      vz[k] = z;
      vy[k] = padDistance(x, z, p) < 0 ? 0 : landHeight(x, z, p);
    }
  }

  // --- The land.
  const pos = [];
  const col = [];
  const tints = new Map();
  const tint = (name, x, z) => {
    // A few shades of each, picked by a hash of the facet's position, so a slope reads as facets.
    const shade = Math.floor((Math.sin(x * 7.13 + z * 3.71) * 0.5 + 0.5) * 4);
    const key = `${name}${shade}`;
    if (!tints.has(key)) tints.set(key, new THREE.Color(jitterColor(PALETTE[name], rng, { l: 0.035 })));
    return tints.get(key);
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tri = (ka, kb, kc) => {
    a.set(vx[ka], vy[ka], vz[ka]);
    b.set(vx[kb], vy[kb], vz[kb]);
    c.set(vx[kc], vy[kc], vz[kc]);
    // Faces up, from the winding — asserted rather than trusted (CLAUDE.md, the roadworks ramp).
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.y < 0) { const t = b.clone(); b.copy(c); c.copy(t); n.negate(); }
    n.normalize();
    const cx = (a.x + b.x + c.x) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const colour = tint(landColour(cx, cz, cy, n.y, beachiness(cx, cz), mountainLift(cx, cz, p)), cx, cz);
    for (const v of [a, b, c]) {
      pos.push(v.x, v.y, v.z);
      col.push(colour.r, colour.g, colour.b);
    }
  };

  // --- The sea, on the same lines.
  const sea = [];
  const depth = [];
  const seaVertex = (k) => {
    sea.push(vx[k], SEA_Y - OCEAN_DROP, vz[k]);
    depth.push(Math.min(DEPTH_CAP, Math.max(0, SEA_Y - vy[k])));
  };

  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < nz - 1; j++) {
      const cxm = (xs[i] + xs[i + 1]) / 2;
      const czm = (zs[j] + zs[j + 1]) / 2;
      // The pad is the city's: paved, opaque, and with the river's own channel through it.
      if (padDistance(cxm, czm, p) < 0) continue;
      const k00 = i * nz + j;
      const k10 = (i + 1) * nz + j;
      const k01 = i * nz + j + 1;
      const k11 = (i + 1) * nz + j + 1;
      const ys = [vy[k00], vy[k10], vy[k01], vy[k11]];
      const hi = Math.max(...ys);
      const lo = Math.min(...ys);
      // Alternate the diagonal, so the facets do not all lean one way.
      const flip = (i + j) % 2 === 0;
      const quads = flip ? [[k00, k01, k11], [k00, k11, k10]] : [[k00, k01, k10], [k10, k01, k11]];
      if (hi > SEA_Y - 0.6) for (const q of quads) tri(...q);
      if (lo < SEA_Y + 0.6) {
        // Wound to face up: (x, z) → (x, z+) → (x+, z+), as every water sheet here is.
        for (const q of flip ? [[k00, k01, k11], [k00, k11, k10]] : [[k00, k01, k10], [k10, k01, k11]]) {
          for (const k of q) seaVertex(k);
        }
      }
    }
  }

  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  const terrain = new THREE.Mesh(bakeColors(terrainGeo, new Float32Array(col)), propMaterial());
  terrain.receiveShadow = true;
  terrain.name = 'terrain';

  const oceanGeo = new THREE.BufferGeometry();
  oceanGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sea), 3));
  // Every triangle of the sea's grid has to face up, and the grid's two diagonals are taken in
  // different orders above — so check each one and swap any that came out the other way.
  const sp = oceanGeo.attributes.position.array;
  for (let t = 0; t < sp.length; t += 9) {
    const ux = sp[t + 3] - sp[t];
    const uz = sp[t + 5] - sp[t + 2];
    const wx = sp[t + 6] - sp[t];
    const wz = sp[t + 8] - sp[t + 2];
    // y of (u × w): positive faces up.
    if (uz * wx - ux * wz < 0) {
      for (let q = 0; q < 3; q++) {
        const tmp = sp[t + 3 + q]; sp[t + 3 + q] = sp[t + 6 + q]; sp[t + 6 + q] = tmp;
      }
      const v = t / 3;
      const tmp = depth[v + 1]; depth[v + 1] = depth[v + 2]; depth[v + 2] = tmp;
    }
  }
  const oceanBaked = bakeColor(oceanGeo, PALETTE.oceanDeep);
  oceanBaked.setAttribute('seaDepth', new THREE.BufferAttribute(new Float32Array(depth), 1));
  const ocean = new THREE.Mesh(oceanBaked, patchOceanWater(propMaterial({ ao: false })));
  ocean.receiveShadow = true;
  ocean.name = 'ocean';

  const { flora, crowns } = createFlora(rng, p);
  const portals = createPortals();
  if (portals) flora.add(portals);
  return { terrain, ocean, flora, crowns };
}

// --- Trees and rocks -------------------------------------------------------------------------

// Sampled on a jittered lattice this far apart, each sample planting or not by where it lands.
const FLORA_STEP = 4.2;
// The verge right beside the near walks stays open: a tree down-screen of the ring road stands
// between the camera and the traffic on it (6 units is a 5.6-unit crown plus its lean on screen).
const NEAR_CLEAR = 7;
const FAR_CLEAR = 2.5;
// Pines thin out above this and stop at the tree line, which the colours put at about 30.
const PINE_TOP = 27;
// Clear of the L's centreline by this much: its deck's half-width and a crown's radius.
const RAIL_CLEAR = 4.5;
const PORTAL_CLEAR = 12;

function hashAt(x, z, k) {
  const s = Math.sin(x * (12.9898 + k) + z * (78.233 - k * 3.1)) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The island's planting: broadleaves dotted over the verge, a pine forest up the mountain's lower
 * slopes, and rocks along the cliffs and out in the shallows. Every tree goes through `treeParts`
 * (CLAUDE.md: never hand-roll one), translated up to the ground it stands on — `treeParts` plants
 * at kerb height. Placement is hashed rather than drawn, so the island's trees stay put whatever
 * else draws on `rng`; only each tree's own shape spends draws.
 */
function createFlora(rng, p) {
  const parts = [];
  const crowns = [];
  const rocks = [];
  const rail = railPath();
  const x0 = p.x0 - 70;
  const x1 = p.x1 + 60;
  const z0 = p.z0 - 110;
  const z1 = p.z1 + 50;
  for (let gx = x0; gx < x1; gx += FLORA_STEP) {
    for (let gz = z0; gz < z1; gz += FLORA_STEP) {
      const x = gx + (hashAt(gx, gz, 1) - 0.5) * FLORA_STEP * 0.9;
      const z = gz + (hashAt(gx, gz, 2) - 0.5) * FLORA_STEP * 0.9;
      const out = padDistance(x, z, p);
      // The near sides are +x and +z (CLAUDE.md, the camera's diagonal).
      const clear = (x > p.x1 || z > p.z1) ? NEAR_CLEAR : FAR_CLEAR;
      if (out < clear) continue;
      // Nothing grows on the L's line: under the viaduct, or in its cutting.
      if (rail && railDistance(rail, x, z) < RAIL_CLEAR) continue;
      // Nor in front of a portal, where it would stand between the camera and the tunnel mouth.
      if (rail && rail.portals.some((port) => Math.hypot(x - port.x, z - port.z) < PORTAL_CLEAR)) continue;
      const g = coastDistance(x, z, p);
      const y = landHeight(x, z, p);
      const lift = mountainLift(x, z, p);
      const roll = hashAt(gx, gz, 3);

      if (g > 3 && y > SEA_Y + 1) {
        const pine = lift > 2.5;
        if (pine) {
          if (y > PINE_TOP + 4 * Math.sin(x * 0.21 + z * 0.13)) continue;
          // Thick low down, thinning to scattered trees under the rock.
          const keep = 0.75 - 0.5 * smoothstepJs(12, PINE_TOP, y);
          if (roll > keep) continue;
        } else {
          // The verge: clumps rather than an even scatter, by a slow wobble.
          const clump = Math.sin(x * 0.17 + 0.6) * Math.sin(z * 0.14 + 1.9);
          if (roll > (clump > 0.2 ? 0.55 : 0.08)) continue;
        }
        const tree = pine
          ? treeParts(x, z, rng, { species: 'pine', low: 3.2, high: 5.4 })
          : treeParts(x, z, rng, { low: 3.0, high: 4.8, crowns });
        // A tree on a slope stands on its lowest root, not its highest.
        const foot = Math.min(y, landHeight(x + 0.6, z, p), landHeight(x - 0.6, z, p),
          landHeight(x, z + 0.6, p), landHeight(x, z - 0.6, p)) - KERB_H - 0.05;
        for (const geo of tree) parts.push(geo.translate(0, foot, 0));
        if (!pine) for (let c = crowns.length - 1; c >= 0 && crowns[c].tx === x && crowns[c].tz === z; c--) crowns[c].y += foot;
        continue;
      }

      // Rocks: on a cliff coast at the waterline, and the odd one standing out in the shallows.
      const beach = beachiness(x, z);
      const atCliff = g > -2.5 && g < 2.5 && beach < 0.4 && roll < 0.55;
      const offshore = g < -4 && g > -22 && roll < 0.035;
      if (!atCliff && !offshore) continue;
      const count = offshore ? 2 + Math.floor(hashAt(gx, gz, 5) * 3) : 1;
      for (let r = 0; r < count; r++) {
        const size = offshore ? 1.0 + hashAt(gx, gz, 6 + r) * 1.8 : 0.7 + hashAt(gx, gz, 6 + r) * 1.3;
        const rx = x + (r ? (hashAt(gx, gz, 9 + r) - 0.5) * 4 : 0);
        const rz = z + (r ? (hashAt(gx, gz, 12 + r) - 0.5) * 4 : 0);
        const geo = new THREE.DodecahedronGeometry(size, 0);
        jitterVertices(geo, rng, size * 0.22);
        geo.scale(1, 0.6 + hashAt(rx, rz, 7) * 0.5, 1);
        geo.rotateY(hashAt(rx, rz, 8) * Math.PI);
        const base = Math.max(landHeight(rx, rz, p), SEA_Y - 1.2);
        geo.translate(rx, base + size * 0.25, rz);
        rocks.push(bakeColor(geo, jitterColor(PALETTE.cliff, rng, { l: 0.06 })));
      }
    }
  }

  const merged = mergeGeometries(parts, false);
  const flora = new THREE.Group();
  flora.name = 'island-flora';
  if (merged) {
    const trees = new THREE.Mesh(merged, propMaterial({ smooth: true }));
    trees.castShadow = true;
    trees.receiveShadow = true;
    flora.add(trees);
  }
  if (rocks.length) {
    const rock = new THREE.Mesh(mergeGeometries(rocks, false), propMaterial());
    rock.castShadow = true;
    rock.receiveShadow = true;
    flora.add(rock);
  }
  return { flora, crowns };
}

function smoothstepJs(a, b, t) {
  const c = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return c * c * (3 - 2 * c);
}

// --- The tunnel portals ---------------------------------------------------------------------

/**
 * A stone headwall at each end of the L, where its cutting runs into the mountain: wide enough to
 * close off the cutting's sides at full height, with a dark arched mouth and a lighter ring round
 * it. The track and the train past the face are cut away in their own shader (game/ltrain.js), so
 * the mouth only has to read as a hole, not be one.
 */
function createPortals() {
  const path = railPath();
  if (!path) return null;
  const parts = [];
  const top = PORTAL_GROUND + 0.8;
  const floor = RAIL_CUT_FLOOR - 0.8;
  const half = CUT_HALF + (top - RAIL_CUT_FLOOR) / CUT_SLOPE;
  for (const port of path.portals) {
    const local = [];
    // The face is the cutting's own cross-section, a V with a flat floor, so it closes it exactly:
    // the sides of the wall lie along the cutting's sides.
    const face = new THREE.Shape([
      new THREE.Vector2(-CUT_HALF - 0.6, floor), new THREE.Vector2(CUT_HALF + 0.6, floor),
      new THREE.Vector2(half + 0.6, top), new THREE.Vector2(-half - 0.6, top),
    ]);
    const wall = new THREE.ExtrudeGeometry(face, { depth: PORTAL_DEPTH, bevelEnabled: false });
    wall.translate(0, 0, -PORTAL_DEPTH);
    local.push(bakeColor(wall, PALETTE.portalStone));
    const coping = new THREE.BoxGeometry(half * 2 + 1.7, 0.4, PORTAL_DEPTH + 0.4);
    coping.translate(0, top + 0.2, -PORTAL_DEPTH / 2);
    local.push(bakeColor(coping, PALETTE.portalRing));
    // The mouth: the ring, then the dark opening standing just proud of it.
    const mouth = (w, r, z, colour) => {
      const sill = RAIL_DECK_TOP - 0.7;
      const spring = RAIL_DECK_TOP + 2.4;
      const rect = new THREE.BoxGeometry(w, spring - sill, 0.1);
      rect.translate(0, (spring + sill) / 2, z);
      const arch = new THREE.CylinderGeometry(r, r, 0.1, 14);
      arch.rotateX(Math.PI / 2);
      arch.translate(0, spring, z);
      local.push(bakeColor(rect, colour), bakeColor(arch, colour));
    };
    mouth(4.4, 2.2, 0.05, PALETTE.portalRing);
    mouth(3.4, 1.7, 0.12, PALETTE.tunnel);
    // Built facing +z; turned to face back out along the line, away from the hill.
    const geo = mergeGeometries(local, false);
    geo.rotateY(Math.atan2(-port.dx, -port.dz));
    geo.translate(port.x, 0, port.z);
    parts.push(geo);
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'tunnel-portals';
  return mesh;
}
