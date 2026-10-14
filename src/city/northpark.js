import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import {
  GRID_I, lineX, lineZ, halfRoadX, halfRoadZ, isArterialZ, LTRAIN_NS, NORTH_PARK, NORTH_PARK_DEPTH,
} from './grid.js';
import { KERB_H, EDGE_FADE, FADE_RINGS } from './ground.js';
import { STATUE_PLAZA, statueParts, treeParts } from './props.js';
import { parkShore } from './harborplan.js';

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
/** The lawn's feather, for the park shore's strip beside it (city/parkshore.js) to fade on. */
export const PARK_FADE = FADE;
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
const DRIVE_Y = LAWN_Y + 0.014;     // the drive's asphalt, over the lawn and the pavement it crosses

// The drive: a rainbow of asphalt off the ring road, round a statue and back out again, with both
// mouths shut by a row of yellow pylons. Tyler, 2026-10-14: "To help break up the park wall let's
// add a rainbow shaped drive way into the park around a statue / fountain. Block off the entrances
// from the Main Street with some yellow pylons. It's purely decorative". So it is not in the road
// network: nothing routes onto it and no fare stands on it. Then, on seeing it: "Add one to either
// side of the train", so there is one each side of the L where the lake leaves room.
// `?parkdrive=classic` leaves the wall
// unbroken.
const PARK_DRIVE = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('parkdrive') !== 'classic'
  : globalThis.process?.env?.PARKDRIVE !== 'classic';
// The arch is a half ring centred on the wall's line, so each leg runs straight across the
// pavement to the kerb. Its mouths are 3 wide; the inner radius leaves the statue's 3.6 plaza a
// pace of lawn all round.
const DRIVE_R = 8;
const DRIVE_W = 3;
const DRIVE_EDGE = 0.3;
const PYLON_R = 0.15;
const PYLON_H = 0.95;

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
  // --- Paths: the loop round the lake, a little way out from its shore, and a spur from each gate
  // in the wall to the nearest point on it.
  const loopFor = () => {
    const pts = [];
    for (let k = 0; k <= 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const wob = 1.2 * Math.sin(5 * a + lake.p2);
      pts.push(lakeAt(a, 5.5 + wob));
    }
    return pts;
  };
  let loop = loopFor();

  // A drive goes where it can be seen to: square on to a street meeting the ring road, so the
  // street ends on the statue, and the junction box falls between its two mouths (the box reaches
  // 4, or 5.33 off an arterial, and the inner kerb of a mouth is at 6.5). Of the streets clear of
  // the L and of the lake's loop, the one nearest the L on each side of it, which is the stretch of
  // bare wall Tyler circled and its mirror.
  let drives = PARK_DRIVE ? placeDrives(b, rail, loop) : [];
  // The loop's south side comes within ~5 of the wall, so on about one seed in six it sits over
  // every street on one side of the L and that side gets no drive (7 of 40 measured). Slide the
  // lake along the wall, the least distance that frees a street on both sides and keeps it off the
  // line and inside the lawn — it is the one thing in the park nobody placed on purpose.
  if (PARK_DRIVE && rail !== null && drives.length < 2) {
    const home = lake.x;
    const lo = b.x0 + lake.rx + 6;
    const hi = b.x1 - lake.rx - 6;
    let best = null;
    for (let step = 1; step <= 24 && !best; step++) {
      for (const dir of [-1, 1]) {
        const x = home + dir * step;
        if (x < lo || x > hi || Math.abs(x - rail) < lake.rx + TREE_CLEAR_RAIL) continue;
        lake.x = x;
        const tried = placeDrives(b, rail, loopFor());
        if (tried.length === 2) { best = x; break; }
      }
    }
    lake.x = best ?? home;
    loop = loopFor();
    drives = placeDrives(b, rail, loop);
  }
  parts.push(ring(lakeAt, 0, 1.1, BANK_Y, PALETTE.pondBank));
  const water = disc(lakeAt, WATER_Y, PALETTE.pondWater);
  parts.push(ribbon(loop, PATH_W, PATH_Y, PALETTE.parkPath));
  const paths = [loop];
  const inDrive = (x, z, pad) => drives.some((d) => Math.abs(x - d.x) < DRIVE_R + DRIVE_W / 2 + pad
    && z > d.z - DRIVE_R - DRIVE_W / 2 - pad);
  const gates = [];
  const gateCount = 4;
  for (let g = 0; g < gateCount; g++) {
    const x = b.x0 + (b.x1 - b.x0) * ((g + 0.5) / gateCount) + rng.range(-5, 5);
    if (rail !== null && Math.abs(x - rail) < GATE_W + 2) continue;
    if (inDrive(x, b.wall, GATE_W + 1)) continue;
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
    // A spur from a gate further along can still bend across the arch on its way to the loop.
    if (spur.some((p) => inDrive(p.x, p.z, PATH_W))) { gates.pop(); continue; }
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
    // And across the whole drive, mouths and island both: a wall between the legs would stand in
    // front of the statue.
    const driveHalf = DRIVE_R + DRIVE_W / 2 + DRIVE_EDGE + 0.4;
    const driveXs = drives.map((d) => d.x);
    cuts.push(...driveXs);
    cuts.sort((p, q) => p - q);
    for (const x of cuts) {
      const half = x === rail ? 1.4 : driveXs.includes(x) ? driveHalf : GATE_W / 2;
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
      if (inDrive(tx, tz, TREE_CLEAR_PATH)) continue;
      parts.push(...treeParts(tx, tz, rng, { low: 4.2, high: 6.8, crowns }));
    }
  }

  // Built last, so that switching it off (`?parkdrive=classic`) moves no tree the gates didn't.
  for (const d of drives) parts.push(...driveParts(d, rng));

  const mesh = new THREE.Mesh(mergeGeometries(parts, false), propMaterial({ smooth: true }));
  parts.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'north-park';

  const waterMesh = new THREE.Mesh(water, propMaterial({ ao: false }));
  waterMesh.receiveShadow = true;
  waterMesh.name = 'north-park-lake';

  return { mesh, water: waterMesh, fade: lawnFade(b), crowns, bounds: b, lake, drives };
}

/**
 * Where the drives go: at most one each side of the L (or the two streets nearest the middle, with
 * no L), and none on a side with no room. `x` is the street a drive faces, `z` the wall's line (the
 * arch's centre), `kerb` the ring road's kerb its legs run down to.
 */
function placeDrives(b, rail, loop) {
  const reach = DRIVE_R + DRIVE_W / 2 + DRIVE_EDGE;
  const z = b.z1 - WALK;
  const fits = (x) => {
    if (x - reach < b.x0 + 2 || x + reach > b.x1 - 2) return false;
    if (isArterialZ(lineXIndex(x))) return false;
    if (rail !== null && Math.abs(x - rail) < reach + TREE_CLEAR_RAIL) return false;
    // The lake's loop path, with a pace of lawn between it and the outer edge.
    for (const p of loop) {
      if (p.z > z - reach - 2 && Math.abs(p.x - x) < reach + 2 && Math.hypot(p.x - x, p.z - z) < reach + 2) return false;
    }
    return true;
  };
  const streets = [];
  for (let i = 1; i < GRID_I; i++) if (fits(lineX(i))) streets.push(lineX(i));
  const at = (x) => ({ x, z, kerb: b.z1 });
  const mid = rail === null ? 0 : rail;
  const near = (side) => streets.filter((x) => Math.sign(x - mid) === side)
    .sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid))[0];
  const picks = [near(-1), near(1)].filter((x) => x !== undefined);
  // Neighbouring streets are 20 apart and a drive is 19.6 across, so two side by side would share
  // a wall pier; with no L to split them that can happen, and one is the answer.
  if (picks.length === 2 && picks[1] - picks[0] < 2 * reach + 3) picks.pop();
  return picks.map(at);
}

function lineXIndex(x) {
  for (let i = 0; i <= GRID_I; i++) if (Math.abs(lineX(i) - x) < 1e-6) return i;
  return -1;
}

/** The drive's asphalt, its kerb edging, the statue on the island and the pylons in its mouths. */
function driveParts(d, rng) {
  const parts = [];
  // The centre line: down the west leg from the kerb, over the arch, and back down the east one.
  const centre = [];
  const leg = (sx, z0, z1) => {
    for (let k = 0; k <= 2; k++) centre.push({ x: d.x + sx * DRIVE_R, z: z0 + (z1 - z0) * (k / 2) });
  };
  leg(-1, d.kerb, d.z);
  for (let k = 1; k < 36; k++) {
    const a = Math.PI - (k / 36) * Math.PI;
    centre.push({ x: d.x + Math.cos(a) * DRIVE_R, z: d.z - Math.sin(a) * DRIVE_R });
  }
  leg(1, d.z, d.kerb);
  parts.push(ribbon(centre, DRIVE_W, DRIVE_Y, PALETTE.asphalt));
  // The edging: a kerb-grey strip either side, laid edge to edge with the asphalt rather than
  // under it (CLAUDE.md: touching is a seam, overlapping is a shimmer).
  const offset = (pts, by) => pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)];
    const c = pts[Math.min(pts.length - 1, k + 1)];
    const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
    return { x: p.x - ((c.z - a.z) / len) * by, z: p.z + ((c.x - a.x) / len) * by };
  });
  const edge = (DRIVE_W + DRIVE_EDGE) / 2;
  parts.push(ribbon(offset(centre, edge), DRIVE_EDGE, DRIVE_Y, PALETTE.kerb));
  parts.push(ribbon(offset(centre, -edge), DRIVE_EDGE, DRIVE_Y, PALETTE.kerb));

  // The statue, in the middle of the island and pushed back off the pavement so its plaza sits on
  // lawn: the park's own figure (city/props.js), the one the graveyard borrows too.
  const inner = DRIVE_R - DRIVE_W / 2;
  const sz = d.z - Math.min(inner - STATUE_PLAZA / 2 - 0.8, 3);
  parts.push(...statueParts(d.x, sz, LAWN_Y, rng));

  // The pylons: three across each mouth, on the pavement a step back from the kerb, so the drive
  // reads as shut from the street that faces it.
  const pylon = new THREE.Color(PALETTE.parkPylon);
  const band = new THREE.Color(PALETTE.parkPylonBand);
  for (const sx of [-1, 1]) {
    for (const t of [-1, 0, 1]) {
      const x = d.x + sx * DRIVE_R + t * (DRIVE_W / 2 - 0.45);
      const z = d.kerb - 0.55;
      const post = new THREE.CylinderGeometry(PYLON_R, PYLON_R * 1.15, PYLON_H, 8);
      post.translate(x, DRIVE_Y + PYLON_H / 2, z);
      parts.push(bakeColor(post, pylon));
      const cap = new THREE.CylinderGeometry(PYLON_R * 0.8, PYLON_R, 0.08, 8);
      cap.translate(x, DRIVE_Y + PYLON_H + 0.04, z);
      parts.push(bakeColor(cap, pylon));
      const stripe = new THREE.CylinderGeometry(PYLON_R * 1.04, PYLON_R * 1.04, 0.1, 8);
      stripe.translate(x, DRIVE_Y + PYLON_H * 0.72, z);
      parts.push(bakeColor(stripe, band));
    }
  }
  return parts;
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
  // With the park shore the east edge is lawn running on to the seawall (city/parkshore.js), so
  // the feather stops square at the north-east corner instead of going round it.
  if (parkShore()) outline.push({ x: b.x1, z: b.z0, nx: 0, nz: -1 });
  else {
    corner(b.x1, b.z0, Math.PI * 1.5, Math.PI * 2);
    outline.push({ x: b.x1, z: b.z1, nx: 1, nz: 0 });
  }
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
