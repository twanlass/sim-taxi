import * as THREE from 'three';
import { VIEW_DIR } from './camera.js';
import { SKYLINE_CEILING } from '../city/buildings.js';

// Can the camera see this patch of ground, or is a building standing in the way?
//
// The view never rotates and the projection is orthographic, so **occlusion is a property of the
// city alone** — it does not change when the player pans or zooms, and it can therefore be settled
// once, when the city is built, rather than tested per frame. That is the whole reason this module
// is cheap enough to exist: the question "is this corner visible" has one answer per seed.
//
// It exists because a marker lying flat on the ground has no way to announce itself over a
// building. The fare crystal floats at 9.65 and clears every skyline in the city (measured: the
// tallest thing that ever stands in front of a kerb corner tops out 5.6 units above it), but the
// courier pad — a rounded square painted on the pavement, see geometry/parcelpad.js — is at 0.3,
// and a package whose drop-off pad is behind a tower is a job with no visible destination. Rather
// than give the pad a floating head back (marker.js removed one deliberately), the board simply
// stops using the corners the camera cannot see: `cornerSeen` in game/fares.js, which both the
// fare board and the courier draw through.
//
// **Two junctions in a typical 5×5 city are affected, and they are not random.** Measured over 20
// seeds, 3.6% of corners have less than 60% of their pad visible, and they fall into two families:
//
//   - **(0, 0), in 19 of 20 cities.** `cornerFor` flips its corner inward at the grid edge, and at
//     the origin junction *both* axes flip — which lands the pin on the +X+Z corner of block
//     (0, 0), the one corner of that block that has the block's own building between it and the
//     camera. Every other edge junction flips one axis only, so its sightline leaves the block
//     within half a unit and never meets the mass.
//   - **The most central junctions**, where the block on the +X+Z side carries a tower. A ray from
//     a kerb corner reaches that block's near corner 8.5 units later, by which point it is 7.8
//     units up, so anything over about 8 tall there hides the pad. Only the downtown blocks get
//     that tall (`buildTower` ceilings on centrality).
//
// --- How the test is answered -------------------------------------------------------------------
//
// A real `Raycaster` through the merged city is the honest way to ask, and it is what
// `tools/probe.mjs` uses to check this module. It is not what the game can afford: the city is one
// merged 5,570-triangle mesh with no acceleration structure, so a ray scans every triangle, and the
// 324 rays a corner sweep needs measured **527 ms** — half a second of boot to answer a question
// about 36 junctions.
//
// So the runtime rasterises the city into a **height field** — one pass over the merged geometry,
// stamping each triangle's peak into the half-unit cells its footprint covers — and marches the
// sightline through that instead. Six milliseconds a city, once, against half a second.
//
// The stamp is per-triangle-AABB rather than a true scan conversion, which rounds *up*: a cell can
// come out taller than the city really is there, never shorter. That asymmetry is the point. A
// height field that over-states an occluder can only ever call a visible corner hidden, which
// costs the board a junction; the opposite error is the bug this module was written to remove.
// `tools/probe.mjs` asserts that direction against real rays, and asserts the other one too — the
// cell size is what keeps the over-statement from eating corners that were fine. At a full unit it
// threw away one visible corner in every six cities; at a half it threw away none in twenty.

// Cell size of the height field, in world units. Half a unit rather than one: see the note above
// on which way the rounding goes, and what a coarser grid costs.
const CELL = 0.5;

// The march starts this far along the sightline, and the cell it starts in is skipped. A corner pin
// stands 0.35 clear of its own building's façade, so the cell under the mark can contain a slice of
// the wall *behind* it — and behind is not in the way: the sightline leaves in +X+Z and never comes
// back. Skipping one cell cannot hide a real occluder, because a marker sample that genuinely sits
// under a building has units of that building ahead of it rather than one cell's worth.
const START_OFFSET = 0.5;

// Nothing in the city is taller than this, so a sightline that has climbed past it is in open sky
// and the rest of the march is wasted work. At 0.92 of height per unit travelled that is about 22
// units — a block and a bit — rather than the 110 it would take to reach the map's edge.
const CEILING = SKYLINE_CEILING;

// Height gained per unit of travel along x (and along z — this view direction moves equally in
// both). VIEW_DIR is normalised, so this is the ratio rather than the component.
const RISE = VIEW_DIR.y / VIEW_DIR.x;

let field = null;

/**
 * Rasterise a mesh's geometry into the height field the sightline test marches through.
 *
 * Takes every mesh that can stand in front of a marker — the merged city and the merged props,
 * which is trees as well as towers: a crown over a kerb hides a mark on the ground exactly as a
 * wall does, and both are one merged mesh apiece by the time they reach here.
 *
 * Called by main.js once, after `createBuildings` and `createProps`. Until then — and in every
 * headless tool that never builds one — the field is null and `sightlineClear` answers "clear",
 * the same way `isParkBlock` answers "no parks" before a layout exists. A tool measuring the fare
 * board with no city in the scene should get the fare board, not an empty one.
 */
export function setCityOccluders(...meshes) {
  const built = meshes.filter(Boolean);
  if (!built.length) { field = null; return null; }

  // One box round everything, so the buildings, the props and the depot share a grid rather than
  // being asked separately and answered three times.
  //
  // In world space, via each mesh's own matrix. The city and the props are both built at world
  // coordinates and sit on identity transforms, so this is a no-op for them — but the depot is a
  // group, and a rasteriser that read raw vertices would put its walls wherever the geometry
  // happened to be authored.
  const bb = new THREE.Box3();
  for (const mesh of built) {
    mesh.updateWorldMatrix(true, false);
    bb.expandByObject(mesh);
  }

  const x0 = Math.floor(bb.min.x) - 1;
  const z0 = Math.floor(bb.min.z) - 1;
  const nx = Math.ceil((bb.max.x - x0) / CELL) + 2;
  const nz = Math.ceil((bb.max.z - z0) / CELL) + 2;
  const heights = new Float32Array(nx * nz);

  // Every triangle stamps its own peak across the cells its footprint touches. Walked through
  // `index` where there is one: an indexed geometry's position attribute in threes is not a list of
  // triangles, which is the trap the courier pad's winding check fell into (see CLAUDE.md).
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (const mesh of built) {
    const pos = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    const at = (k) => (index ? index.getX(k) : k);
    for (let k = 0; k < count; k += 3) {
      va.fromBufferAttribute(pos, at(k)).applyMatrix4(mesh.matrixWorld);
      vb.fromBufferAttribute(pos, at(k + 1)).applyMatrix4(mesh.matrixWorld);
      vc.fromBufferAttribute(pos, at(k + 2)).applyMatrix4(mesh.matrixWorld);
      const minX = Math.min(va.x, vb.x, vc.x);
      const maxX = Math.max(va.x, vb.x, vc.x);
      const minZ = Math.min(va.z, vb.z, vc.z);
      const maxZ = Math.max(va.z, vb.z, vc.z);
      const top = Math.max(va.y, vb.y, vc.y);
      const ci0 = Math.max(0, Math.floor((minX - x0) / CELL));
      const ci1 = Math.min(nx - 1, Math.floor((maxX - x0) / CELL));
      const cj0 = Math.max(0, Math.floor((minZ - z0) / CELL));
      const cj1 = Math.min(nz - 1, Math.floor((maxZ - z0) / CELL));
      for (let ci = ci0; ci <= ci1; ci++) {
        for (let cj = cj0; cj <= cj1; cj++) {
          const cell = ci * nz + cj;
          if (top > heights[cell]) heights[cell] = top;
        }
      }
    }
  }

  field = { x0, z0, nx, nz, heights };
  return field;
}

/** Forget the city. For tools that build several and would otherwise measure the last one. */
export const clearCityOccluders = () => { field = null; };

/**
 * Is the straight line from this point to the camera clear of the city?
 *
 * The march is a DDA over the height field. `y` is taken at the point the ray *enters* each cell,
 * which is the lowest it is anywhere in that cell — the conservative choice, in the direction that
 * costs a junction rather than hides a marker.
 */
export function sightlineClear(x, y, z) {
  if (!field) return true;

  let cx = x + VIEW_DIR.x * START_OFFSET;
  let cz = z + VIEW_DIR.z * START_OFFSET;
  let cy = y + VIEW_DIR.y * START_OFFSET;

  const { x0, z0, nx, nz, heights } = field;
  let ci = Math.floor((cx - x0) / CELL);
  let cj = Math.floor((cz - z0) / CELL);

  // Distance along x to the next cell boundary in each axis. The direction is +X+Z for this camera
  // and always will be — VIEW_DIR is a constant — so the walk only ever steps up in both.
  let tx = (x0 + (ci + 1) * CELL - cx);
  let tz = (z0 + (cj + 1) * CELL - cz);

  // The cell the sample stands in is skipped: see START_OFFSET.
  let travelled = 0;
  for (let step = 0; step < 512; step++) {
    // Advance to whichever boundary comes first, in units of x — which is also units of z here.
    const advance = Math.min(tx, tz);
    travelled += advance;
    tx -= advance;
    tz -= advance;
    if (tx <= 1e-9) { ci += 1; tx = CELL; }
    if (tz <= 1e-9) { cj += 1; tz = CELL; }
    if (ci >= nx || cj >= nz) return true;          // out over the edge of the city

    const rayY = cy + travelled * RISE;
    if (rayY > CEILING) return true;                // above everything the city can build
    // A sample can start just outside the field's own box — it is drawn round the geometry, not
    // round the map — and a negative index would fold round into some other row's cell rather than
    // reading nothing. There is nothing built out there by definition, so step over it.
    if (ci < 0 || cj < 0) continue;
    if (heights[ci * nz + cj] > rayY) return false;
  }
  return true;
}
