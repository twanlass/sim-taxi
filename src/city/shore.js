import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { harborBasin, riverBanks } from './grid.js';
import { ISLAND, pad, landHeight, islet } from './coast.js';
import { KERB_H } from './ground.js';

// The island's edges, built on (`?island=classic` has none of it): the sheds between the ring road
// and the docks, the row of low buildings along the south shore, and the lighthouse on its rock off
// the south-west corner. All of it from Tyler's painted reference, 2026-10-13.
//
// Scenery only — nothing here is a fare, a road or an obstacle — so one merged mesh.

// --- The dock sheds --------------------------------------------------------------------------
//
// The aprons between the ring road and the basin were bare quay, which reads as the city stopping
// rather than as a port starting. A row of long sheds on them is the transition the reference
// asks for. They keep west of the L's posts, which run up the waterfront north of the river
// (city/railpath.js) at x ≈ kerb + 8, and under its cap (5.35), so the deck passes over them.
const SHED_X = [2, 6.6];   // from the ring road's kerb
const SHED_LEN = [9, 13];
const SHED_GAP = 1.6;
const SHED_EAVE = [2.8, 3.4];
const SHED_PITCH = 0.9;

// --- The south shore row ---------------------------------------------------------------------
//
// Low on purpose. This is the near side — the camera looks in over it — and anything `h` tall
// hides `1.09 h` of ground behind it (CLAUDE.md, the camera's diagonal). Set back `ROW_SET` off
// the walk, a ridge at 3.2 hides ground to 0.3 short of the ring road's kerb: the row stands in
// front of the road without covering any of it.
const ROW_SET = 1.2;
const ROW_DEEP = 4.6;
const ROW_W = [4.5, 7.5];
const ROW_GAP = [1.0, 3.5];
const ROW_EAVE = [1.8, 2.2];
const ROW_RIDGE_MAX = 3.2;

export function createShore(rng) {
  if (!ISLAND) return null;
  const parts = [];
  sheds(rng, parts);
  southRow(rng, parts);
  lighthouse(rng, parts);
  if (!parts.length) return null;
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'shore';
  return mesh;
}

/** A box, its base centred on (x, y, z). */
function block(parts, w, h, d, x, y, z, colour) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  parts.push(bakeColor(g, colour));
}

/**
 * A gabled roof over a `w` × `d` footprint with its ridge along z (or along x with `alongX`),
 * eaves at `y`, `rise` to the ridge and a little overhang. Wound outward, every face — a closed
 * prism from six hand-placed points, so the winding is asserted by the probe rather than trusted.
 */
export function gableRoof(w, d, rise, x, y, z, colour, alongX = false) {
  const hw = w / 2 + 0.25;
  const hd = d / 2 + 0.25;
  // Built ridge-along-z: the gable ends face ±z.
  const v = [
    [-hw, 0, -hd], [hw, 0, -hd], [0, rise, -hd],
    [-hw, 0, hd], [hw, 0, hd], [0, rise, hd],
  ];
  const tris = [
    [0, 2, 1], [3, 4, 5],           // gable ends
    [0, 3, 5], [0, 5, 2],           // -x slope
    [1, 2, 5], [1, 5, 4],           // +x slope
    [0, 1, 4], [0, 4, 3],           // soffit
  ];
  const pos = [];
  for (const t of tris) for (const k of t) pos.push(...v[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (alongX) g.rotateY(Math.PI / 2);
  g.translate(x, y, z);
  g.computeVertexNormals();
  return bakeColor(g, colour);
}

function sheds(rng, parts) {
  const basin = harborBasin();
  const banks = riverBanks();
  if (!basin || !banks) return;
  // The aprons either side of the river's last stretch, between the ring road and the basin: the
  // harbor paves them as quay (city/harbor.js) and leaves them empty, and they are exactly the
  // strip between the street and the docks. The piers beyond them are the container yards.
  const floor = KERB_H + 0.01;
  const xa = basin.kerbX + SHED_X[0];
  const xb = basin.kerbX + SHED_X[1];
  for (const [z0, z1] of [[basin.z0 + 1, banks.z0 - 1.5], [banks.z1 + 1.5, basin.z1 - 1]]) {
    let z = z0;
    while (z1 - z >= SHED_LEN[0]) {
      const len = Math.min(rng.range(SHED_LEN[0], SHED_LEN[1]), z1 - z);
      const zc = z + len / 2;
      z += len + SHED_GAP;
      const w = xb - xa;
      const xc = (xa + xb) / 2;
      const eave = rng.range(SHED_EAVE[0], SHED_EAVE[1]);
      const wall = jitterColor(rng.pick([PALETTE.brick, PALETTE.tan, PALETTE.concrete]), rng, { l: 0.05 });
      block(parts, w, eave, len, xc, floor, zc, wall);
      parts.push(gableRoof(w, len, SHED_PITCH, xc, floor + eave, zc, jitterColor(PALETTE.slate, rng, { l: 0.05 })));
      // Loading doors down the quay side, the side the camera sees.
      const doors = Math.max(1, Math.floor(len / 4));
      for (let k = 0; k < doors; k++) {
        const dz = zc - len / 2 + (k + 0.5) * (len / doors);
        block(parts, 0.08, eave * 0.62, Math.min(2.2, len / doors - 0.8), xb + 0.04, floor, dz, PALETTE.garageDoor);
      }
    }
  }
}

function southRow(rng, parts) {
  const p = pad();
  const z0 = p.z1 + ROW_SET;
  const zc = z0 + ROW_DEEP / 2;
  let x = p.x0 + 6;
  const end = p.x1 - (harborBasin() ? 2 : 6);
  while (x < end) {
    const w = rng.range(ROW_W[0], ROW_W[1]);
    const xc = x + w / 2;
    x += w + rng.range(ROW_GAP[0], ROW_GAP[1]);
    if (xc + w / 2 > end) break;
    // Only on level verge: a lot with the coast's drop under any corner is left as grass.
    const hs = [];
    for (const dx of [-w / 2, 0, w / 2]) for (const dz of [-ROW_DEEP / 2, ROW_DEEP / 2]) hs.push(landHeight(xc + dx, zc + dz, p));
    const lo = Math.min(...hs);
    const hi = Math.max(...hs);
    if (lo < KERB_H - 0.05 || hi > 1.4) continue;
    if (rng.chance(0.18)) continue;    // the odd empty lot, so the row is a street and not a wall
    const base = hi;
    // A plinth down to the lowest corner, so a house on a roll of the verge is not on stilts.
    block(parts, w + 0.2, base - lo + 0.3, ROW_DEEP + 0.2, xc, lo - 0.3, zc, PALETTE.kerb);
    const eave = rng.range(ROW_EAVE[0], ROW_EAVE[1]);
    const rise = Math.min(ROW_RIDGE_MAX - eave - (base - KERB_H), 1.1);
    const wall = jitterColor(rng.pick([PALETTE.pale, PALETTE.tan, PALETTE.brick, PALETTE.concrete]), rng, { l: 0.06 });
    block(parts, w, eave, ROW_DEEP, xc, base, zc, wall);
    if (rise > 0.3) parts.push(gableRoof(w, ROW_DEEP, rise, xc, base + eave, zc, jitterColor(PALETTE.roof, rng, { l: 0.06 }), true));
    // A shopfront and a door on the side facing the camera (+z), towards the sea.
    block(parts, w * 0.55, eave * 0.55, 0.06, xc - w * 0.12, base + 0.15, zc + ROW_DEEP / 2 + 0.03, PALETTE.window);
    block(parts, 0.8, eave * 0.62, 0.06, xc + w * 0.32, base, zc + ROW_DEEP / 2 + 0.03, PALETTE.door);
  }
}

/** The lighthouse on its rock off the south-west corner (`islet` in city/coast.js). */
function lighthouse(rng, parts) {
  const rock = islet();
  if (!rock) return;
  const y = landHeight(rock.x, rock.z);
  const tower = new THREE.CylinderGeometry(0.85, 1.25, 7.5, 10);
  tower.translate(rock.x, y + 3.75, rock.z);
  parts.push(bakeColor(tower, PALETTE.pale));
  for (const band of [2.2, 5.0]) {
    const ring = new THREE.CylinderGeometry(1.25 - 0.4 * (band + 0.6) / 7.5 + 0.03, 1.25 - 0.4 * band / 7.5 + 0.03, 1.1, 10);
    ring.translate(rock.x, y + band + 0.55, rock.z);
    parts.push(bakeColor(ring, PALETTE.lightRed));
  }
  const gallery = new THREE.CylinderGeometry(1.35, 1.35, 0.25, 10);
  gallery.translate(rock.x, y + 7.6, rock.z);
  parts.push(bakeColor(gallery, PALETTE.slate));
  const lantern = new THREE.CylinderGeometry(0.65, 0.65, 1.1, 8);
  lantern.translate(rock.x, y + 8.27, rock.z);
  parts.push(bakeColor(lantern, PALETTE.litWarm));
  const cap = new THREE.ConeGeometry(0.85, 0.9, 8);
  cap.translate(rock.x, y + 9.27, rock.z);
  parts.push(bakeColor(cap, PALETTE.lightRed));
  // The keeper's cottage, on the landward side of the tower.
  const cx = rock.x + 2.6;
  const cz = rock.z - 1.2;
  const cy = landHeight(cx, cz);
  block(parts, 2.6, 1.6, 3.2, cx, cy - 0.2, cz, PALETTE.pale);
  parts.push(gableRoof(2.6, 3.2, 0.9, cx, cy + 1.4, cz, PALETTE.lightRed));
}
