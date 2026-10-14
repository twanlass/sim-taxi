import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';
import {
  GRID_I, GRID_J, HALF_ROAD, lineX, isSegmentClosed, DIR,
} from './grid.js';

// The warehouse shortcut (Tyler, 2026-10-14): two blocks side by side and the street between them
// under one low brick shed, with a roller door where that street goes in at each end. To every
// other car in the city it is a wall. To the taxi under Loco Mode it is the shortest way across the
// block: the router is offered the street only while the boost is held, the taxi hits the shut door
// at speed, it bursts open, and the car comes out of the far one in a ball of dust.
//
// **The street is not closed, it is unpopular.** A park district or the graveyard closes its road
// with `setClosedSegments`, which deletes the edge from the network at bake time — and then nothing
// can ever drive it. This keeps the edge and closes its two lanes the way roadworks close theirs
// (`setClosedLanes(ids, 'warehouse')` in sim/traffic.js), so ambient cars weigh the turn in at zero
// and every routed car but the taxi is refused it at the line. The taxi's router is told
// separately (`setPassageLanes` in game/route.js), and told to price the lanes at Infinity unless
// the boost is down. Both are installed by `createLayout`, beside the network they name, so every
// tool that builds a city gets the same closure the game does.
//
// **Which way it faces is the graveyard's answer**: a pair side by side along X, so the street
// through it runs along Z and one of its two doors is on the +Z face the camera looks at. The other
// is round the back. A taxi heading −Z smashes in where the player can see it and out where they
// mostly cannot; heading +Z it is the exit that is in view — the dust ball rolling out of the front
// of the building, which is the half of the gag worth seeing.
//
// `?warehouse=classic` leaves the two blocks to the towers and the street open.

/** `'classic'` for none — `?warehouse=` in the browser, `WAREHOUSE=` for the headless tools. */
export const WAREHOUSE_ON = (() => {
  const raw = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('warehouse')
    : globalThis.process?.env?.WAREHOUSE;
  return raw !== 'classic';
})();

// --- The shed -------------------------------------------------------------------
/** In from the block's own edge, so a strip of pavement shows round the walls. */
const INSET = 0.6;
/**
 * The tunnel walls stand this far out into the road from each kerb line. Exactly on it they would
 * share a plane with the kerb's own riser and fight it (CLAUDE.md: two surfaces that *overlap*).
 */
const KERB_PROUD = 0.06;
/** Eaves, over the pavement. Low on purpose: it is a shed among towers, and the camera has to see over it. */
const EAVE = 5.2;
/** The door: the opening's height over the road. The taxi is ~2 tall drawn. */
export const DOOR_H = 3.7;
const SLATS = 9;
/** The curtain sits this far back inside the opening, so the frame round it reads as a frame. */
const CURTAIN_BACK = 0.18;
/** The sawtooth roof: teeth along Z, each with its glazed vertical face to +Z, toward the camera. */
const TOOTH_RISE = 1.3;
const TEETH = 3;

function box(dx, dy, dz, x, base, z, col) {
  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(x, base + dy / 2, z);
  return bakeColor(geo, col);
}

function span(x0, x1, y0, y1, z0, z1, col) {
  return box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, y0, (z0 + z1) / 2, col);
}

/**
 * One sawtooth tooth: a right triangle in (z, y) — flat on the roof, rising toward +Z to a vertical
 * face — run along X from `x0` to `x1`. Extruded rather than hand-wound, so three winds it (CLAUDE.md:
 * a hand-written triangle is a winding bug waiting to be found).
 */
function tooth(x0, x1, z0, z1, y, rise, col) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(z1 - z0, 0);
  shape.lineTo(z1 - z0, rise);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false });
  // Shape x -> world z, extrusion -> world -x (a rotation, so the winding is kept).
  geo.rotateY(-Math.PI / 2);
  geo.translate(x1, y, z0);
  return bakeColor(geo, col);
}

/**
 * Where the warehouse goes, or `null`: two `'built'` blocks side by side along X, out of any park
 * district, with the north-south street between them neither a main street nor already closed.
 *
 * **Chosen last and without a draw**, the pocket park's way: it runs after the depot, the burger
 * joint and the graveyard have taken their blocks, and which candidate wins is hashed off the park
 * districts' positions — so adding it moves nothing but the towers on the two blocks it takes.
 *
 * **Neither end of the street may be left a dead end.** The passage is closed to almost everything,
 * so each junction it runs into must still have two other open arms: one way in and one way out
 * that is not a U-turn. A junction with one is a cul-de-sac every router in the game would refuse.
 * Off the ring (both junctions inside the grid) is preferred and so is out of downtown, where a
 * low shed is a hole in the skyline the camera cannot see into. Each filter falls back to the pool
 * it narrows.
 */
export function chooseWarehousePair(blocks, arterialZ) {
  const at = (bi, bj) => blocks.find((b) => b.bi === bi && b.bj === bj);
  const free = (b) => b && b.type === 'built' && (b.districtId === null || b.districtId === undefined);
  const openArms = (i, j) => [DIR.PX, DIR.PZ, DIR.NX, DIR.NZ].filter((d) => {
    const ni = i + (d === DIR.PX ? 1 : d === DIR.NX ? -1 : 0);
    const nj = j + (d === DIR.PZ ? 1 : d === DIR.NZ ? -1 : 0);
    if (ni < 0 || ni > GRID_I || nj < 0 || nj > GRID_J) return false;
    return !isSegmentClosed(i, j, d);
  }).length;

  const pairs = [];
  for (let bi = 0; bi + 1 < GRID_I; bi++) {
    for (let bj = 0; bj < GRID_J; bj++) {
      const a = at(bi, bj);
      const b = at(bi + 1, bj);
      if (!free(a) || !free(b)) continue;
      const i = bi + 1;
      if (arterialZ.has(i)) continue;
      if (isSegmentClosed(i, bj, DIR.PZ)) continue;
      // Three arms each, so two remain once the passage is shut.
      if (openArms(i, bj) < 3 || openArms(i, bj + 1) < 3) continue;
      pairs.push({ a, b, i, bj, quiet: Math.max(a.centrality, b.centrality) });
    }
  }
  if (!pairs.length) return null;

  const inner = pairs.filter((p) => p.bj > 0 && p.bj + 1 < GRID_J);
  const pool = inner.length ? inner : pairs;
  const quiet = pool.filter((p) => p.quiet <= 0.55);
  const from = quiet.length ? quiet : pool;
  const key = (blocks.districts ?? []).reduce(
    (sum, d, k) => sum + (k + 1) * (d.bounds.cx * 17.713 + d.bounds.cz * 53.117), 3.1);
  const frac = Math.abs(Math.sin(key) * 43758.5453) % 1;
  const pick = from[Math.min(from.length - 1, Math.floor(frac * from.length))];

  const { a, b } = pick;
  const x0 = a.bounds.x0;
  const x1 = b.bounds.x1;
  const { z0, z1 } = a.bounds;
  return {
    bi: a.bi, bj: a.bj, type: 'warehouse', blocks: [a, b],
    /** The street through it: line `i`, between junctions (i, bj) and (i, bj + 1). */
    street: { i: pick.i, j0: pick.bj, j1: pick.bj + 1 },
    centrality: pick.quiet,
    bounds: { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 },
  };
}

/** Every measurement the mesh and the smash are built from. */
export function warehouseSite(lot) {
  const { x0, x1, z0, z1 } = lot.bounds;
  const cx = lineX(lot.street.i);
  const half = HALF_ROAD - KERB_PROUD;
  return {
    bounds: lot.bounds,
    street: lot.street,
    /** The shed's walls. */
    wall: { x0: x0 + INSET, x1: x1 - INSET, z0: z0 + INSET, z1: z1 - INSET },
    /** The tunnel: the street's centreline and the half-width of the opening either side of it. */
    cx,
    half,
    base: KERB_H,
    /** The lintel, in world y. */
    head: DOOR_H,
    top: KERB_H + EAVE,
    /**
     * The two doors: their plane in z and which way is out. The curtain is recessed into the
     * opening by `CURTAIN_BACK`; `z` is the wall plane, which is what the taxi bursts through.
     */
    doors: [
      { z: z0 + INSET, out: -1 },
      { z: z1 - INSET, out: 1 },
    ],
  };
}

/**
 * The shed, and its two doors.
 *
 * One shell mesh and one per curtain, the depot's split for the depot's reason: the curtains move.
 * All three are stamped with the one entrance anchor so the city's wave lifts the building with
 * its doors in it.
 */
export function createWarehouse(lot, rng) {
  const site = warehouseSite(lot);
  const { wall, cx, half, base, head, top } = site;
  const tx0 = cx - half;
  const tx1 = cx + half;

  const brick = jitterColor(color('warehouseWall'), rng, { l: 0.03 });
  const trim = color('warehouseTrim');
  const roof = jitterColor(color('warehouseRoof'), rng, { l: 0.03 });
  const glass = color('warehouseGlass');
  const dark = color('warehouseBay');
  const hazard = color('warehouseHazard');

  const parts = [
    // The mass, hollowed for the street: a wing either side of the tunnel and a header over it.
    // Four solids rather than one box with a hole, the depot's reason: every face lining the void
    // is then some solid's outward face, and so drawn from inside it. The wings stand on the road
    // rather than the pavement — their tunnel faces come down to the tarmac.
    span(wall.x0, tx0, 0, top, wall.z0, wall.z1, brick),
    span(tx1, wall.x1, 0, top, wall.z0, wall.z1, brick),
    span(tx0, tx1, head, top, wall.z0, wall.z1, brick),
    // The tunnel's lining, a hair inside the wings and the header so it wins the depth test, and
    // stopping short of the openings so the brick reveals frame it.
    span(tx0, tx0 + 0.04, 0, head, wall.z0 + 0.5, wall.z1 - 0.5, dark),
    span(tx1 - 0.04, tx1, 0, head, wall.z0 + 0.5, wall.z1 - 0.5, dark),
    span(tx0, tx1, head - 0.04, head, wall.z0 + 0.5, wall.z1 - 0.5, dark),
    // The coping.
    span(wall.x0 - 0.12, wall.x1 + 0.12, top, top + 0.22, wall.z0 - 0.12, wall.z1 + 0.12, trim),
  ];

  // Each opening: yellow-and-dark hazard posts either side and a dark lintel band over it, proud of
  // the wall on the outside face. What says *loading bay* from across the map is the stripe.
  for (const { z, out } of site.doors) {
    const face = z;
    const proud = face + out * 0.12;
    const [za, zb] = out > 0 ? [face - 0.02, proud] : [proud, face + 0.02];
    parts.push(span(tx0 - 0.45, tx0, 0, head, za, zb, hazard));
    parts.push(span(tx1, tx1 + 0.45, 0, head, za, zb, hazard));
    // Dark bands across the posts, three to a post.
    for (let k = 0; k < 3; k++) {
      const y = 0.5 + k * 1.1;
      const [ya, yb] = [y, y + 0.45];
      const [zc, zd] = out > 0 ? [za, zb + 0.01] : [za - 0.01, zb];
      parts.push(span(tx0 - 0.46, tx0 + 0.01, ya, yb, zc, zd, trim));
      parts.push(span(tx1 - 0.01, tx1 + 0.46, ya, yb, zc, zd, trim));
    }
    parts.push(span(tx0 - 0.45, tx1 + 0.45, head, head + 0.4, za, zb, trim));
  }

  // A run of high windows along the +Z face of each wing — the elevation the camera sees.
  const winY = base + 3.0;
  for (const [a, b] of [[wall.x0 + 1, tx0 - 1.2], [tx1 + 1.2, wall.x1 - 1]]) {
    const n = Math.max(1, Math.floor((b - a) / 2.2));
    const pitch = (b - a) / n;
    for (let k = 0; k < n; k++) {
      const x = a + (k + 0.5) * pitch;
      parts.push(span(x - pitch * 0.32, x + pitch * 0.32, winY, winY + 1.1, wall.z1 - 0.02, wall.z1 + 0.06, glass));
    }
  }
  // ...and a painted loading door and its band on the +X end, the other face in view.
  parts.push(span(wall.x1 - 0.02, wall.x1 + 0.08, base, base + 2.8, lot.bounds.cz - 1.6, lot.bounds.cz + 1.6,
    color('warehouseDoor')));
  parts.push(span(wall.x1 - 0.02, wall.x1 + 0.1, base + 2.8, base + 3.1, lot.bounds.cz - 1.9, lot.bounds.cz + 1.9, trim));

  // The sawtooth: TEETH across the depth, each glazed on its vertical +Z face.
  const depth = (wall.z1 - wall.z0) / TEETH;
  for (let k = 0; k < TEETH; k++) {
    const za = wall.z0 + k * depth;
    const zb = za + depth;
    parts.push(tooth(wall.x0, wall.x1, za, zb, top + 0.22, TOOTH_RISE, roof));
    parts.push(span(wall.x0 + 0.3, wall.x1 - 0.3, top + 0.4, top + 0.22 + TOOTH_RISE - 0.15, zb - 0.01, zb + 0.03, glass));
  }

  const anchorX = lot.bounds.cx;
  const anchorZ = lot.bounds.cz;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);

  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'warehouse';

  // --- The curtains -----------------------------------------------------------
  const slatH = head / SLATS;
  const doorCol = color('warehouseDoor');
  const curtains = site.doors.map(({ z, out }, n) => {
    const cz = z - out * CURTAIN_BACK;
    const slats = [];
    for (let k = 0; k < SLATS; k++) {
      slats.push(box(tx1 - tx0 - 0.04, slatH - 0.05, 0.1, cx, k * slatH + 0.02, cz,
        k === 0 ? trim : doorCol));
    }
    slats.forEach(stampAll);
    const geo = mergeGeometries(slats, false);
    slats.forEach((s) => s.dispose());
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.castShadow = true;
    mesh.name = `warehouse-door-${n}`;
    return { mesh, geo, restY: Float32Array.from(geo.attributes.position.array) };
  });

  const group = new THREE.Group();
  group.add(shell, ...curtains.map((c) => c.mesh));

  /**
   * Wind door `n` up: 0 shut, 1 gone. The depot's curtain exactly (`setDoor` in city/garage.js):
   * every vertex rises by the same travel and stops dead at the lintel, which is what winding onto
   * a drum looks like at this scale.
   */
  function setDoor(n, open) {
    const c = curtains[n];
    const travel = THREE.MathUtils.clamp(open, 0, 1) * head;
    const array = c.geo.attributes.position.array;
    for (let i = 1; i < array.length; i += 3) array[i] = Math.min(c.restY[i] + travel, head);
    c.geo.attributes.position.needsUpdate = true;
  }

  return {
    site,
    group,
    shell,
    setDoor,
    meshes: [shell, ...curtains.map((c) => c.mesh)],
    entrySite: {
      x: anchorX, z: anchorZ, r: Math.max(wall.x1 - wall.x0, wall.z1 - wall.z0) / 2, rand,
    },
  };
}
