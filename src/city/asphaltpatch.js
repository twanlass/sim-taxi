import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import {
  GRID_I, GRID_J, lineX, lineZ, halfRoadX, halfRoadZ, laneOffX, laneOffZ, isSegmentClosed,
  isArterialX, isArterialZ, isRiverGap,
} from './grid.js';
import { MARK_Y } from './ground.js';

// Asphalt patches: one or two rectangles of newer, darker tarmac cut into a lane, each with the
// black crack-seal band a crew pours round a patch's edge (Tyler, 2026-10-24: "very sparingly, like
// maybe one or two across the map"). Set dressing with no say in anything — it is there so one
// street somewhere has been dug up and mended, which is what makes the rest read as old road.
//
// **Where.** Mid-block, inside one lane, on a side street. Mid-block because the junction box is the
// manholes' and the brick plaza's, and the crosswalks and stop lines crowd both ends of a run.
// Inside one lane because that is the shape of a utility cut, and because it keeps the patch off
// the centre dashes. Side streets only: an arterial's median sits where its centre line would be,
// and the ring road is half under the edge fog. Never on a bridge (the river row's z-roads).
//
// **Shape.** A rectangle with its edge wobbled a little and its corners rounded, outlined in a band
// of near-black crack seal that thickens and thins as it goes — a crew pours it by hand. Tyler's
// reference (2026-10-24) is a black tar line round a patch only a step darker than the road: the
// outline is what carries the read, so it is wide enough to survive play zoom (~1.5px at its
// thinnest) and far darker than anything else on the street.
//
// **Layering.** Under the lane paint (MARK_Y) and over the slab, and the seal is a ring round the
// patch rather than a bigger shape under it: two surfaces 0.006 apart under this camera's 400-unit
// standoff is a shimmer (CLAUDE.md, "two flat surfaces at the same height"). Fill and ring share
// their edge, so they meet rather than overlap.

export const PATCH_COUNT = [1, 2];
export const PATCH_Y = MARK_Y / 2;
const WOBBLE = 0.07;           // how far the edge strays either side of the rectangle
const SEAL = [0.16, 0.28];     // the seal band's width, thinnest to thickest
const CORNER_R = 0.18;
// Everything the patch can reach past its nominal rectangle: the wobble outward plus the widest
// seal. Placement keeps this much extra clear, and the probe measures against it.
export const SEAL_W = WOBBLE + SEAL[1];
const ACROSS = 1.8;            // a lane is 2.25 from dash to kerb on a side street
const ALONG = [2.2, 3.6];
const END_CLEAR = 2;           // units from either junction box: past the crosswalk (0.15 + 1.5) and a bit
const MIN_SEP = 2.5;           // pitches apart, so two never share a corner of the map

/**
 * Pick the patches. Pure apart from reading the grid, so the probe can sweep seeds with it.
 * Returns `[{ x, z, w, d }]`: the centre and the size in x and z, seal excluded.
 */
export function planPatches(rng) {
  const candidates = [];
  for (let i = 1; i < GRID_I; i++) {
    for (let j = 1; j < GRID_J; j++) {
      // The run east of (i, j), along X at line j.
      if (i + 1 < GRID_I && !isArterialX(j) && !isSegmentClosed(i, j, 0)) {
        candidates.push({
          axis: 'x', i, j, c: lineZ(j), lane: laneOffX(j),
          a: lineX(i) + halfRoadZ(i), b: lineX(i + 1) - halfRoadZ(i + 1),
        });
      }
      // The run north of (i, j), along Z at line i — unless it is a bridge.
      if (j + 1 < GRID_J && !isArterialZ(i) && !isRiverGap(j) && !isSegmentClosed(i, j, 1)) {
        candidates.push({
          axis: 'z', i, j, c: lineX(i), lane: laneOffZ(i),
          a: lineZ(j) + halfRoadX(j), b: lineZ(j + 1) - halfRoadX(j + 1),
        });
      }
    }
  }
  for (let n = candidates.length - 1; n > 0; n--) {
    const m = Math.floor(rng.next() * (n + 1));
    [candidates[n], candidates[m]] = [candidates[m], candidates[n]];
  }
  const want = rng.int(PATCH_COUNT[0], PATCH_COUNT[1]);
  const pitch = lineX(1) - lineX(0);
  const chosen = [];
  for (const k of candidates) {
    if (chosen.length >= want) break;
    const along = ALONG[0] + rng.next() * (ALONG[1] - ALONG[0]);
    // `a` and `b` are the two junction boxes' edges, so the slide is what is left of the run once
    // the patch, its seal and the crosswalk clearance at each end are taken out.
    const slide = Math.max(0, (k.b - k.a) / 2 - END_CLEAR - along / 2 - SEAL_W);
    const s = (k.a + k.b) / 2 + rng.jitter(slide);
    const t = k.c + (rng.chance(0.5) ? 1 : -1) * k.lane;
    const spot = k.axis === 'x'
      ? { x: s, z: t, w: along, d: ACROSS, axis: 'x', i: k.i, j: k.j }
      : { x: t, z: s, w: ACROSS, d: along, axis: 'z', i: k.i, j: k.j };
    if (chosen.every((o) => Math.hypot(o.x - spot.x, o.z - spot.z) >= MIN_SEP * pitch)) chosen.push(spot);
  }
  return chosen;
}

/**
 * The patch's outline: a rounded rectangle walked anticlockwise from above, each point pushed out or
 * in along its normal by a smooth wobble. Returns points with their outward normals and a 0-1 seal
 * width weight, so the band can swell and thin along the same walk.
 */
function outline(w, d, rng) {
  const hw = w / 2 - CORNER_R, hd = d / 2 - CORNER_R;
  const STEP = 0.18;
  const pts = [];
  // Straight edges and quarter circles in turn, starting at the +x edge.
  const corners = [[hw, hd, 0], [-hw, hd, 1], [-hw, -hd, 2], [hw, -hd, 3]];
  const edge = (x0, z0, x1, z1, nx, nz) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / STEP));
    for (let k = 0; k < n; k++) pts.push({ x: x0 + ((x1 - x0) * k) / n, z: z0 + ((z1 - z0) * k) / n, nx, nz });
  };
  const arc = (cx, cz, q) => {
    const n = 3;
    for (let k = 0; k < n; k++) {
      const a = (q + k / n) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * CORNER_R, z: cz + Math.sin(a) * CORNER_R, nx: Math.cos(a), nz: Math.sin(a) });
    }
  };
  edge(hw + CORNER_R, -hd, hw + CORNER_R, hd, 1, 0);
  arc(...corners[0]);
  edge(hw, hd + CORNER_R, -hw, hd + CORNER_R, 0, 1);
  arc(...corners[1]);
  edge(-hw - CORNER_R, hd, -hw - CORNER_R, -hd, -1, 0);
  arc(...corners[2]);
  edge(-hw, -hd - CORNER_R, hw, -hd - CORNER_R, 0, -1);
  arc(...corners[3]);
  // Two sines round the loop, whole numbers of cycles so the walk closes on itself.
  const n = pts.length;
  const p1 = rng.next() * Math.PI * 2, p2 = rng.next() * Math.PI * 2, p3 = rng.next() * Math.PI * 2;
  return pts.map((p, k) => {
    const t = (k / n) * Math.PI * 2;
    const off = WOBBLE * (0.5 * Math.sin(5 * t + p1) + 0.5 * Math.sin(13 * t + p2));
    return {
      x: p.x + p.nx * off, z: p.z + p.nz * off, nx: p.nx, nz: p.nz,
      seal: 0.5 + 0.5 * Math.sin(9 * t + p3),
    };
  });
}

/** Push a triangle so it faces up whichever way round its corners came. */
function upTri(out, a, b, c) {
  const cross = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (cross >= 0) out.push(...a, ...b, ...c);
  else out.push(...a, ...c, ...b);
}

function flat(positions, col) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return bakeColor(geo, col);
}

/** The patches and their seal rings, merged. */
export function patchGeometry(spots, rng) {
  const parts = [];
  for (const { x, z, w, d } of spots) {
    const loop = outline(w, d, rng);
    const fill = [], ring = [];
    const y = PATCH_Y;
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k], q = loop[(k + 1) % loop.length];
      upTri(fill, [x, y, z], [x + p.x, y, z + p.z], [x + q.x, y, z + q.z]);
      const sp = SEAL[0] + (SEAL[1] - SEAL[0]) * p.seal;
      const sq = SEAL[0] + (SEAL[1] - SEAL[0]) * q.seal;
      const pi = [x + p.x, y, z + p.z], qi = [x + q.x, y, z + q.z];
      const po = [x + p.x + p.nx * sp, y, z + p.z + p.nz * sp];
      const qo = [x + q.x + q.nx * sq, y, z + q.z + q.nz * sq];
      upTri(ring, pi, po, qo);
      upTri(ring, pi, qo, qi);
    }
    parts.push(flat(fill, jitterColor(PALETTE.asphaltPatch, rng, { l: 0.02 })));
    parts.push(flat(ring, jitterColor(PALETTE.asphaltSeal, rng, { l: 0.01 })));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

export function createAsphaltPatches(rng, { enabled = true } = {}) {
  if (!enabled) return null;
  const spots = planPatches(rng);
  if (spots.length === 0) return null;
  const mesh = new THREE.Mesh(patchGeometry(spots, rng), propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'asphalt-patches';
  mesh.userData.spots = spots;
  return mesh;
}

/** Half the road a patch spot sits in, across its run — for the probe's kerb check. */
export const patchRoadHalf = (spot) => (spot.axis === 'x' ? halfRoadX(spot.j) : halfRoadZ(spot.i));
