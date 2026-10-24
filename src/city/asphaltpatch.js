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
// **Layering.** Under the lane paint (MARK_Y) and over the slab, and the seal is a frame of four
// strips round the patch rather than a bigger quad under it: two quads at 0.006 apart under this
// camera's 400-unit standoff is a shimmer (CLAUDE.md, "two flat surfaces at the same height").

export const PATCH_COUNT = [1, 2];
export const PATCH_Y = MARK_Y / 2;
export const SEAL_W = 0.12;
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

function quad(w, d, x, z, col) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, PATCH_Y, z);
  return bakeColor(geo, col);
}

/** The patches and their seal frames, merged. */
export function patchGeometry(spots, rng) {
  const parts = [];
  for (const { x, z, w, d } of spots) {
    parts.push(quad(w, d, x, z, jitterColor(PALETTE.asphaltPatch, rng, { l: 0.02 })));
    const seal = jitterColor(PALETTE.asphaltSeal, rng, { l: 0.01 });
    const ww = w + SEAL_W * 2;
    parts.push(quad(ww, SEAL_W, x, z - d / 2 - SEAL_W / 2, seal));
    parts.push(quad(ww, SEAL_W, x, z + d / 2 + SEAL_W / 2, seal));
    parts.push(quad(SEAL_W, d, x - w / 2 - SEAL_W / 2, z, seal));
    parts.push(quad(SEAL_W, d, x + w / 2 + SEAL_W / 2, z, seal));
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
