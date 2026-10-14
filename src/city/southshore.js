import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, bakeColors, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { GRID_I, lineX, halfRoadZ, isArterialZ, LTRAIN_NS, coastWest } from './grid.js';
import { KERB_H, PAVE_INSET, SLAB_RADIUS, EDGE_FADE, FADE_RINGS } from './ground.js';
import { WATER_Y } from './river.js';
import { wallQuad } from './harbor.js';
import { treeParts } from './props.js';
import {
  southShore, southKerbZ, shoreZ, shorePoints, islandHalf, onShoreline, coastArcStart,
} from './harborplan.js';

// The south shore (`?southshore=classic` keeps the old apron fading into the sky).
//
// Tyler, 2026-10-14, circling where the harbor's rocks stop at the south-east corner: "Continue the
// rocky shoreline around the south end. Opposite the buildings add a curb, then grass patch then
// swooping walkway then more grass at the waters edge. Put a few trees in for measure."
//
// So the harbor's seawall turns the corner and runs west the whole length of the south end, with
// the same bank of boulders against it, and the sea in front of it (city/harborplan.js owns the
// outline, river.js `seaMesh` the water). Between the ring road and the water is a raised strip of
// park: a kerb and a pavement band facing the road, lawn, a walkway swinging along it, and lawn on
// to the water's edge, with a few trees.
//
// Scenery only, on the harbor's and the north park's terms: it is all outside the ring road, so no
// street, junction or fare moves, and nothing routes into it. Its own rng stream.

// The pavement band along the kerb. The kerb's own face looks up-screen, away from the camera, so
// without a band on top of it the strip's edge would read as lawn dropped on the road.
const WALK = 1.0;
// The walkway: its width, where its middle runs across the strip, and how far it swings either way.
// The swing keeps ~2.5 units of lawn on both sides at its widest, against the shoreline's wobble.
const PATH_W = 1.6;
const PATH_MID = 6.5;          // off the kerb
const PATH_SWING = 2.4;
// Where the walkway turns up to join the pavement at the east end, and over how long a run.
const PATH_JOIN_RUN = 14;
// The trees: a few, small, and down by the water. Every crown here is *down-screen* of the ring
// road, and the sightline climbs 0.92 per unit, so a crown topping out at 4.6 hides ground up to
// ~5 units behind it. Planted at least 8 off the kerb they hide lawn, not road or riders.
const TREE_PITCH = 9;
const TREE_HEIGHT = [3.3, 4.4];
const TREE_FROM_KERB = 8;
const TREE_FROM_SHORE = 1.6;
const TREE_CLEAR_PATH = 1.8;
const TREE_CLEAR_RAIL = 4;
// The rocks, at the harbor's sizes (city/harbor.js `ROCK_*`) so the two read as one shore.
const ROCK_BANK = [0.75, 1.3];
const ROCK_APRON = [0.4, 0.8];
const ROCK_PITCH = 1.2;
const WALL_FOOT = 0.6;
// The hot dog cart (Tyler, 2026-10-14: "let's place a hot dog cart along the way"). It stands on
// the lawn beside the walkway, on the road side, where the path has swung furthest toward the water
// and left the most room, and out of the first and last stretches so it is not at the corner or in
// the fade. Sized off the taxi: the drawn taxi is ~4 long, the cart about half that with its handle.
const CART_FROM_PATH = 1.2;       // its centre off the path's edge
// Built at street-furniture size and then grown: at 1 it was ~15px long at play zoom, a speck with
// an umbrella on it.
const CART_SCALE = 1.3;
const CART_KEEP_OUT = 2.4;        // what a tree keeps clear of it
const CART_END_MARGIN = 20;       // off each end of the walkway

// Heights, named off each other (CLAUDE.md: two flat surfaces at one height shimmer).
const LAWN_Y = KERB_H + 0.01;      // lawn and pavement band, side by side
const PATH_Y = LAWN_Y + 0.01;      // the walkway on the lawn

/** The x of the L's line where it runs south over the strip, or null. */
function railX() {
  if (!LTRAIN_NS) return null;
  for (let i = 1; i < GRID_I; i++) if (isArterialZ(i)) return lineX(i);
  return null;
}

/**
 * The strip's outline south of a line `z` (the kerb, or the lawn's inner edge): down the island's
 * west edge to the shoreline, along it, round the corner into the seawall and up it to `z`. Read off
 * the slab's own outline, so the strip stands exactly on the land.
 */
function stripOutline(z) {
  const x0 = coastWest();
  const poly = islandHalf(1, x0, SLAB_RADIUS);
  const start = poly.findIndex(([x, pz]) => x === x0 && onShoreline(x, pz));
  const out = [[x0, z]];
  for (let k = start; k < poly.length; k++) {
    const [ax, az] = poly[k];
    const [bx, bz] = poly[(k + 1) % poly.length];
    out.push([ax, az]);
    // Up the seawall until it crosses `z`, and stop there.
    if (bz < z) {
      const t = (az - z) / (az - bz);
      out.push([ax + (bx - ax) * t, z]);
      break;
    }
  }
  return out;
}

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

/** Triangles lying flat at y, each turned to face up whichever way it was handed in. */
function upTriangles(tris, y, colour) {
  const pos = [];
  for (const [a, b, c] of tris) {
    // y of (b - a) × (c - a): positive faces up.
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    for (const p of ny >= 0 ? [a, b, c] : [a, c, b]) pos.push(p.x, y, p.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return bakeColor(g, colour);
}

/** Distance from (x, z) to the segment a-b. */
function segDistance(x, z, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
}

/**
 * The walkway's centreline at a world x: two long sines for the swoop, turning up to meet the
 * pavement band at the ring road's south-east corner, where the strip narrows into the seawall.
 */
function pathZ(x, kerbZ, joinX) {
  const swoop = PATH_SWING * (0.78 * Math.sin(0.15 * x + 0.9) + 0.22 * Math.sin(0.41 * x + 2.3));
  const free = kerbZ + PATH_MID + swoop;
  const t = Math.min(1, Math.max(0, (x - (joinX - PATH_JOIN_RUN)) / PATH_JOIN_RUN));
  const e = t * t * (3 - 2 * t);
  return free + (kerbZ + WALK + PATH_W / 2 - free) * e;
}

/**
 * The strip, its shore and its trees, or null without a south shore. `mesh` is the solid part (one
 * smooth-lit mesh, the trees' rule) and `fade` the lawn dissolving off the west end with the island.
 */
export function createSouthShore(rng) {
  if (!southShore()) return null;
  const parts = [];
  const kerbZ = southKerbZ();
  const x0 = coastWest();
  const kerbCol = jitterColor(PALETTE.kerb, rng, { l: 0.02 });
  const walkCol = jitterColor(PALETTE.sidewalk, rng, { l: 0.03 });
  const lawnCol = jitterColor(PALETTE.park, rng, { l: 0.03 });
  const pathCol = jitterColor(PALETTE.parkPath, rng, { l: 0.03 });
  const wallCol = jitterColor(PALETTE.riverWall, rng, { l: 0.02 });

  // --- The platform: a kerb block over the whole strip, the pavement band along its road edge, and
  // the lawn from the band to the water.
  const outline = stripOutline(kerbZ);
  parts.push(slab(outline, KERB_H, kerbCol));
  const lawn = stripOutline(kerbZ + WALK);
  parts.push(flat(lawn, LAWN_Y, lawnCol));
  // The band: from the kerb's 0.15 lip to the lawn, ending where the lawn's own edge meets the wall.
  const [bandEnd] = lawn.slice(-1);
  const [kerbEnd] = outline.slice(-1);
  parts.push(flat([
    [x0, kerbZ + PAVE_INSET], [kerbEnd[0] - PAVE_INSET, kerbZ + PAVE_INSET],
    [bandEnd[0] - PAVE_INSET, kerbZ + WALK], [x0, kerbZ + WALK],
  ], LAWN_Y, walkCol));

  // --- The walkway, from the west edge to the pavement at the corner.
  const joinX = lineX(GRID_I) + halfRoadZ(GRID_I) + 1.5;
  const path = [];
  for (let x = x0; x < joinX; x += 0.75) path.push({ x, z: pathZ(x, kerbZ, joinX) });
  path.push({ x: joinX, z: pathZ(joinX, kerbZ, joinX) });
  parts.push(ribbon(path, PATH_W, PATH_Y, pathCol));

  // --- The seawall along the shoreline, and the rocks against it: the harbor's shore, carried on.
  const shore = shorePoints(x0);
  const wallBottom = WATER_Y - WALL_FOOT;
  const rock = (r, x, y, z) => {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1 + rng.next() * 0.45, 0.7 + rng.next() * 0.35, 1 + rng.next() * 0.45);
    g.rotateY(rng.next() * Math.PI);
    g.translate(x, y, z);
    parts.push(bakeColor(g, jitterColor(PALETTE.riprap, rng, { l: 0.07 })));
  };
  for (let k = 1; k < shore.length; k++) {
    const [ax, az] = shore[k - 1];
    const [bx, bz] = shore[k];
    const len = Math.hypot(bx - ax, bz - az);
    // The sea is on +z: the outward normal of a segment running east.
    const nx = -(bz - az) / len;
    const nz = (bx - ax) / len;
    parts.push(wallQuad(ax, az, bx, bz, nx, nz, 0, wallBottom, wallCol));
    // As harbor.js lays them: a bank of boulders against the wall, crowns up near its top, and a
    // looser apron of smaller ones half under the water in front.
    const n = Math.max(1, Math.round(len / ROCK_PITCH));
    for (let j = 0; j < n; j++) {
      const t = (j + rng.next()) / n;
      const r = rng.range(ROCK_BANK[0], ROCK_BANK[1]);
      const out = r * 0.55 + rng.next() * 0.4;
      rock(r, ax + (bx - ax) * t + nx * out, WATER_Y + 0.6 + rng.next() * 0.7, az + (bz - az) * t + nz * out);
      if (rng.chance(0.7)) {
        const u = (j + rng.next()) / n;
        const ra = rng.range(ROCK_APRON[0], ROCK_APRON[1]);
        const outA = 1.4 + rng.next() * 1.4;
        rock(ra, ax + (bx - ax) * u + nx * outA, WATER_Y + 0.05 + rng.next() * 0.25, az + (bz - az) * u + nz * outA);
      }
    }
  }

  // --- The hot dog cart, beside the walkway.
  const rail = railX();
  const cart = placeCart(path, kerbZ, rail);
  if (cart) parts.push(...hotDogCart(cart));

  // --- A few trees, by the water, clear of the walkway, the cart and the L's columns.
  const pathDistance = (x, z) => {
    let best = Infinity;
    for (let k = 1; k < path.length; k++) best = Math.min(best, segDistance(x, z, path[k - 1], path[k]));
    return best;
  };
  const crowns = [];
  for (let x = x0 + 5; x < coastArcStart(1) - 4; x += TREE_PITCH) {
    const tx = x + rng.range(-3, 3);
    // Between the walkway and the water, or now and then up by the pavement where the path swings
    // out toward the sea and leaves the room there.
    const lo = kerbZ + TREE_FROM_KERB;
    const hi = shoreZ(tx) - TREE_FROM_SHORE;
    const tz = rng.range(lo, hi);
    const roll = rng.next();
    if (hi <= lo || roll < 0.2) continue;
    if (rail !== null && Math.abs(tx - rail) < TREE_CLEAR_RAIL) continue;
    if (pathDistance(tx, tz) < TREE_CLEAR_PATH) continue;
    if (cart && Math.hypot(tx - cart.x, tz - cart.z) < CART_KEEP_OUT) continue;
    parts.push(...treeParts(tx, tz, rng, { low: TREE_HEIGHT[0], high: TREE_HEIGHT[1], crowns }));
  }

  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial({ smooth: true }));
  parts.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'south-shore';

  return { mesh, fade: westFade(kerbZ, x0, joinX, { lawnCol, walkCol, pathCol }), crowns, cart };
}

/**
 * Where the cart stands: on the walkway's road side at the point where that side has the most lawn,
 * turned to face the path. No draw, so it is the same spot for a given city and moving it reshuffles
 * nothing. Null if no stretch has the room.
 */
function placeCart(path, kerbZ, rail) {
  let best = null;
  for (let k = 1; k < path.length - 1; k++) {
    const p = path[k];
    if (p.x < path[0].x + CART_END_MARGIN || p.x > path[path.length - 1].x - CART_END_MARGIN) continue;
    if (rail !== null && Math.abs(p.x - rail) < TREE_CLEAR_RAIL) continue;
    const room = p.z - PATH_W / 2 - (kerbZ + WALK);
    if (!best || room > best.room) best = { k, room };
  }
  if (!best || best.room < 2.4) return null;
  const p = path[best.k];
  const q = path[best.k + 1];
  const o = path[best.k - 1];
  // The path's direction there, and the normal toward the kerb (-z side).
  const len = Math.hypot(q.x - o.x, q.z - o.z);
  const tx = (q.x - o.x) / len;
  const tz = (q.z - o.z) / len;
  const nx = tz;
  const nz = -tx;
  const off = PATH_W / 2 + CART_FROM_PATH;
  // Its serving side faces the path; yaw turns the cart's local +z (that side) onto -n.
  return { x: p.x + nx * off, z: p.z + nz * off, yaw: Math.atan2(-nx, -nz) };
}

/** The cart in its own frame (serving side +z, standing on the lawn at y 0), then placed. */
function hotDogCart({ x, z, yaw }) {
  const parts = [];
  const box = (w, h, d, px, py, pz, colour) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(px, py, pz);
    parts.push(bakeColor(g, colour));
  };
  const steel = PALETTE.cartSteel;
  // Two wheels at one end and a leg at the other, the way a street cart parks.
  for (const s of [-1, 1]) {
    const w = new THREE.CylinderGeometry(0.24, 0.24, 0.1, 10);
    w.rotateX(Math.PI / 2);
    w.translate(-0.45, 0.24, s * 0.4);
    parts.push(bakeColor(w, PALETTE.wheelWell));
  }
  box(0.1, 0.32, 0.1, 0.55, 0.16, 0, PALETTE.pole);
  // The box: a red skirt band low down, steel above it, and a darker counter top.
  box(1.5, 0.22, 0.78, 0, 0.42, 0, PALETTE.cartTrim);
  box(1.5, 0.48, 0.78, 0, 0.77, 0, steel);
  box(1.56, 0.06, 0.84, 0, 1.04, 0, PALETTE.pole);
  // The handle off the wheel end, and the umbrella's pole from the middle of the box.
  box(0.36, 0.06, 0.06, -0.93, 0.92, 0.28, PALETTE.pole);
  box(0.36, 0.06, 0.06, -0.93, 0.92, -0.28, PALETTE.pole);
  box(0.06, 0.06, 0.62, -1.1, 0.92, 0, PALETTE.pole);
  box(0.06, 1.05, 0.06, 0.1, 1.55, 0, PALETTE.pole);
  // The umbrella: an eight-sided cone in alternating segments, wide enough to shade the whole cart.
  const cone = new THREE.ConeGeometry(1.15, 0.42, 8, 1, true).toNonIndexed();
  cone.translate(0.1, 2.24, 0);
  const red = new THREE.Color(PALETTE.cartUmbrellaRed);
  const mustard = new THREE.Color(PALETTE.cartUmbrellaMustard);
  const n = cone.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    // One triangle per segment: with a point at the top, three skips the torso's other one.
    const c = Math.floor(v / 3) % 2 === 0 ? red : mustard;
    colours.set([c.r, c.g, c.b], v * 3);
  }
  parts.push(bakeColors(cone, colours));
  for (const g of parts) {
    g.scale(CART_SCALE, CART_SCALE, CART_SCALE);
    g.rotateY(yaw);
    g.translate(x, LAWN_Y, z);
  }
  return parts;
}

/** A strip `w` wide down a polyline, lying flat at y. */
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

/**
 * The strip dissolving off the island's west edge with everything else: the band, the lawn and the
 * walkway carried on west over the skirt's band (`EDGE_FADE`) on the skirt's own curve, alpha in a
 * 4-component vertex colour the way the asphalt's skirt does it (ground.js `asphaltFade`). Without
 * it the lawn stopped on a hard line where the asphalt beside it was still fading.
 */
function westFade(kerbZ, x0, joinX, { lawnCol, walkCol, pathCol }) {
  const alphaAt = (t) => 1 - t * t * (3 - 2 * t);
  const shore = shoreZ(x0);
  const pos = [];
  const col = [];
  const steps = FADE_RINGS * 2;
  // Each band runs from z = lo(x) to z = hi(x), at its own height.
  const band = (lo, hi, y, colour) => {
    const c = new THREE.Color(colour);
    for (let k = 0; k < steps; k++) {
      const xa = x0 - (EDGE_FADE * k) / steps;
      const xb = x0 - (EDGE_FADE * (k + 1)) / steps;
      const aa = alphaAt(k / steps);
      const ab = alphaAt((k + 1) / steps);
      const A = [xa, lo(xa), aa]; const B = [xa, hi(xa), aa];
      const C = [xb, hi(xb), ab]; const D = [xb, lo(xb), ab];
      for (const [a, b, d] of [[A, B, C], [A, C, D]]) {
        // Turned to face up from its own winding rather than worked out by hand (CLAUDE.md, the
        // roadworks ramp): y of (b - a) x (d - a) in the x-z plane.
        const ny = (b[1] - a[1]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[1] - a[1]);
        for (const [x, z, al] of ny >= 0 ? [a, b, d] : [a, d, b]) {
          pos.push(x, y, z);
          col.push(c.r, c.g, c.b, al);
        }
      }
    }
  };
  const p = (x) => pathZ(x, kerbZ, joinX);
  band(() => kerbZ + PAVE_INSET, () => kerbZ + WALK, LAWN_Y, walkCol);
  band(() => kerbZ + WALK, () => shore, LAWN_Y, lawnCol);
  band((x) => p(x) - PATH_W / 2, (x) => p(x) + PATH_W / 2, PATH_Y, pathCol);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.computeVertexNormals();
  const material = propMaterial();
  material.transparent = true;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  // After the asphalt's skirt (-1), which it lies on.
  mesh.renderOrder = 0;
  mesh.name = 'south-shore-fade';
  return mesh;
}
