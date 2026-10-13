import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { riverBanks, coastWest, GRID_J, isArterialX, lineZ, LTRAIN_NS } from './grid.js';
import { KERB_H, PAVE_INSET, SLAB_RADIUS } from './ground.js';
import { WATER_Y, waterEdges } from './river.js';
import { harborPiers, islandHalf, seaStartX, insidePolygon } from './harborplan.js';

// The harbor at the river's east mouth: the walls of everything standing in the sea, the rocks
// along the seawall, the two piers' container yards and warehouses, the sheds on the aprons and two
// big gantry cranes on the far quay. The ships that come in under them are game/harborships.js.
//
// Tyler, 2026-10-13, once the island had gone: "keep the harbor on the east edge. Rocky shore,
// maybe some warehouse buildings, 2 big cranes, ships coming in and out of port".
//
// Where it goes is grid.js's decision (`harborBasin`), and the shape of the land round it —
// seawall, piers, quays — is city/harborplan.js's. The slab, its fade skirt and the sea read the
// same outline (ground.js, river.js). This module is the scenery standing on it.
// None of it is a road: the waterfront drive is the east ring road, which is unchanged.
//
// **The cranes go on the far quay, the -z one.** The camera looks down the -x-z diagonal, so the
// far quay's wall is the one that faces it across the water: a ship moored there sits in front of
// a lit wall, and the cranes' height is thrown up-screen over their own yard rather than over the
// basin. On the near quay the same cranes would stand between the camera and everything else.

const WALL_FOOT = 0.6;
// The yards start a footway's width off the ring road's kerb: the ring bridge's footway reaches
// 1.4 past the kerb (`DECK_OVERHANG`), and the apron beside the inlet has to clear its abutment.
const YARD_SET = 1.4;

// --- The cranes ---------------------------------------------------------------
//
// Ship-to-shore gantries, sized to the camera rather than to the real thing. A real one is three
// times the ship's beam in reach and taller than anything in this city; at that scale a crane hides
// a block of the yard behind it (1.087 units of ground per unit of height). These stand 12 to the
// apex, which hides about 13 units up-screen — still their own yard.
const CRANE_LEG_H = 7.2;
const CRANE_GAUGE = 5.0;      // seaside leg to landside leg, across the quay
const CRANE_SPAN = 4.2;       // between the two leg frames, along the quay
const CRANE_OUTREACH = 10.5;  // boom past the seaside legs, out over the water
const CRANE_BACKREACH = 3.5;  // boom behind the landside legs
const CRANE_APEX = 4.6;       // apex of the A-frame over the boom
const CRANE_QUAY_GAP = 1.0;   // seaside rail in from the quay edge
const CRANE_PITCH = 7.5;      // centre to centre along the quay
// **Two of them, and big.** Three at the size above read as a row of furniture on the quay; two
// at a third larger again read as the port's landmark. Everything above is in the crane's own frame
// and the scale goes on the merged crane, so the numbers stay the ones that were measured.
const CRANE_SCALE = 1.4;
const CRANES = 2;

// --- The containers -------------------------------------------------------------
//
// Stylised, like the cars: a 40ft box is three cars long in life, which here would be ten units
// and a yard of four stacks. 3.4 by 1.2 by 1.2 keeps a stack readable as boxes at play zoom.
const BOX_L = 3.4;
const BOX_W = 1.2;
const BOX_H = 1.15;
const BOX_GAP = 0.12;

// --- The ship --------------------------------------------------------------------
export const SHIP_L = 19;
export const SHIP_B = 5.2;
const SHIP_FREEBOARD = 2.3;   // deck above the waterline
const SHIP_DRAUGHT = 0.8;     // hull below it, enough that the shelf never shows under the bilge
const SHIP_FENDER = 0.7;      // off the quay wall

// --- The rocky shore -------------------------------------------------------------
//
// The seawall used to be a wall with a scatter of riprap at its foot, which read as a kerb with
// gravel on it. Now the rock is the shore: a bank of boulders tipped against the wall from the
// waterline nearly to the top, and a looser apron of smaller ones out in the water in front.
const ROCK_BANK = [0.75, 1.3];   // boulder radius against the wall
const ROCK_APRON = [0.4, 0.8];   // and out in the water
const ROCK_PITCH = 1.2;

// --- The warehouses ----------------------------------------------------------------
//
// Long sheds on the aprons between the ring road and the basin, the strip the quay paving left
// bare, and one big warehouse at the landward end of each pier with the yard behind it.
const SHED_X = [2, 6.6];   // from the ring road's kerb
const SHED_LEN = [9, 13];
const SHED_GAP = 1.6;
const SHED_EAVE = [2.8, 3.4];
const SHED_PITCH = 0.9;
const WAREHOUSE_LEN = 13;    // along x, from the pier's landward end
const WAREHOUSE_EAVE = 3.6;
const WAREHOUSE_PITCH = 1.3;

function box(w, h, d, x, y, z, col) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return bakeColor(g, col);
}

/** A strut between two points, as a box of section `s` — the cranes' bracing. */
function strut(a, b, s, col) {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(s, len, s);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate(mid.x, mid.y, mid.z);
  return bakeColor(g, col);
}

/**
 * One gantry crane, in its own frame: the quay edge on z = 0, the water at +z, standing on the
 * quay's top at y = 0. `trolleyAt` is how far out along the boom the trolley is parked (0..1).
 */
function crane(rng, trolleyAt) {
  const frame = PALETTE.craneFrame;
  const dark = PALETTE.craneDark;
  const parts = [];
  const zSea = -CRANE_QUAY_GAP;
  const zLand = zSea - CRANE_GAUGE;
  const hx = CRANE_SPAN / 2;
  const legW = 0.42;
  const boomY = CRANE_LEG_H + 0.55;

  // Four legs, a sill beam along the quay at the foot of each pair (the bogies), and the portal
  // beams at the top tying the four together.
  for (const x of [-hx, hx]) {
    for (const z of [zSea, zLand]) {
      parts.push(box(legW, CRANE_LEG_H, legW, x, CRANE_LEG_H / 2, z, frame));
      parts.push(box(0.9, 0.35, 0.7, x, 0.18, z, dark));
    }
    parts.push(box(legW * 0.8, legW, CRANE_GAUGE, x, CRANE_LEG_H - 0.2, (zSea + zLand) / 2, frame));
    // A diagonal in each leg frame, so it reads as a structure and not as four poles.
    parts.push(strut(new THREE.Vector3(x, 1.4, zSea), new THREE.Vector3(x, CRANE_LEG_H - 0.4, zLand), 0.2, frame));
  }
  for (const z of [zSea, zLand]) {
    parts.push(box(CRANE_SPAN + legW, legW, legW, 0, CRANE_LEG_H - 0.2, z, frame));
    parts.push(box(CRANE_SPAN, 0.28, 0.28, 0, 2.0, z, frame));
  }

  // The boom: one deep girder down the middle, from the backreach out over the water.
  const zBack = zLand - CRANE_BACKREACH;
  const zTip = zSea + CRANE_QUAY_GAP + CRANE_OUTREACH;
  parts.push(box(1.1, 0.6, zTip - zBack, 0, boomY, (zTip + zBack) / 2, frame));

  // The A-frame over the seaside legs, and the stays from its apex to the boom's two ends.
  const apex = new THREE.Vector3(0, boomY + CRANE_APEX, zSea - 0.6);
  for (const x of [-hx, hx]) {
    parts.push(strut(new THREE.Vector3(x, CRANE_LEG_H, zSea), apex, 0.3, frame));
    parts.push(strut(new THREE.Vector3(x, CRANE_LEG_H, zLand), apex, 0.26, frame));
  }
  parts.push(strut(apex, new THREE.Vector3(0, boomY + 0.3, zTip - 0.3), 0.14, frame));
  parts.push(strut(apex, new THREE.Vector3(0, boomY + 0.3, zBack + 0.4), 0.14, frame));

  // Machinery house on the backreach, and the operator's cab hung under the boom.
  parts.push(box(2.2, 1.4, 2.4, 0, boomY + 1.0, zBack + 1.3, PALETTE.craneHouse));
  const trolleyZ = zSea + (zTip - zSea) * trolleyAt;
  parts.push(box(1.3, 0.55, 1.3, 0, boomY - 0.55, trolleyZ, PALETTE.craneHouse));
  // The spreader on its cables, part way down — a crane mid-lift rather than parked.
  const drop = 2.0 + rng.next() * 2.0;
  parts.push(box(0.06, drop, 0.06, -0.35, boomY - 0.8 - drop / 2, trolleyZ, dark));
  parts.push(box(0.06, drop, 0.06, 0.35, boomY - 0.8 - drop / 2, trolleyZ, dark));
  parts.push(box(BOX_L * 0.9, 0.2, 1.0, 0, boomY - 0.8 - drop, trolleyZ, dark));
  return parts;
}

/** A stack of containers, lying along x, bottom on y. */
function stack(rng, x, y, z, tiers, along = 'x') {
  const parts = [];
  for (let t = 0; t < tiers; t++) {
    const col = jitterColor(rng.pick(PALETTE.containerColors), rng, { l: 0.03 });
    const w = along === 'x' ? BOX_L : BOX_W;
    const d = along === 'x' ? BOX_W : BOX_L;
    parts.push(box(w, BOX_H, d, x, y + BOX_H * (t + 0.5) + t * 0.02, z, col));
  }
  return parts;
}

/**
 * A block of stacks filling [x0, x1] × [z0, z1] on a yard: rows along x, boxes end to end, with a
 * lane left every few rows for the straddle carriers. Heights vary, and a few slots are empty, so
 * the block reads as worked rather than as a solid.
 */
function containerBlock(rng, x0, x1, z0, z1, y, keepClear = null) {
  const parts = [];
  const pitchX = BOX_L + BOX_GAP;
  const pitchZ = BOX_W + BOX_GAP;
  const nx = Math.floor((x1 - x0) / pitchX);
  const nz = Math.floor((z1 - z0) / pitchZ);
  const offX = x0 + ((x1 - x0) - nx * pitchX) / 2 + pitchX / 2;
  const offZ = z0 + ((z1 - z0) - nz * pitchZ) / 2 + pitchZ / 2;
  // A cross aisle every few bays as well, so a block reads as rows of stacks with room to work
  // them rather than as one carpet of boxes.
  const aisle = Math.max(3, Math.round(nx / 3));
  for (let r = 0; r < nz; r++) {
    if (r % 4 === 3) continue;          // the lane
    const rz = offZ + r * pitchZ;
    if (keepClear && rz + pitchZ / 2 > keepClear[0] && rz - pitchZ / 2 < keepClear[1]) continue;
    for (let c = 0; c < nx; c++) {
      if (c % aisle === aisle - 1) continue;
      if (rng.chance(0.18)) continue;
      const tiers = 1 + rng.int(0, 2);
      parts.push(...stack(rng, offX + c * pitchX, y, offZ + r * pitchZ, tiers));
    }
  }
  return parts;
}

/**
 * The container ship, in its own frame: waterline at y = 0, bow toward +x, beam along z.
 * The hull is an extruded top-view outline so the bow can come to a point without hand-wound
 * triangles (CLAUDE.md, the winding traps); everything above deck is boxes.
 */
export function ship(rng) {
  const parts = [];
  const hl = SHIP_L / 2;
  const hb = SHIP_B / 2;
  const outline = new THREE.Shape();
  outline.moveTo(-hl, -hb);
  outline.lineTo(hl - 3.2, -hb);
  outline.quadraticCurveTo(hl - 0.6, -hb * 0.85, hl, 0);
  outline.quadraticCurveTo(hl - 0.6, hb * 0.85, hl - 3.2, hb);
  outline.lineTo(-hl, hb);
  outline.lineTo(-hl, -hb);
  const hullH = SHIP_FREEBOARD + SHIP_DRAUGHT;
  const extrude = (shape, depth) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
    // Extruded along +z from the shape's xy plane: lay it down so the outline is the deck plan.
    g.rotateX(-Math.PI / 2);
    return g;
  };
  // Shape-space y maps to world -z under that rotation; the outline is symmetric, so it does not
  // matter here, and the bow still points +x.
  const hull = extrude(outline, hullH);
  hull.translate(0, -SHIP_DRAUGHT, 0);
  parts.push(bakeColor(hull, PALETTE.shipHull));
  // The boot-top: a band at the waterline in the hull's antifouling colour, a hair proud of it.
  const boot = extrude(outline, 0.45);
  boot.scale(1.004, 1, 1.02);
  boot.translate(0, -0.15, 0);
  parts.push(bakeColor(boot, PALETTE.shipBoot));
  // The deck, inset so the hull's sheer shows as a rim round it.
  const deck = box(SHIP_L - 4.2, 0.08, SHIP_B - 0.5, -0.6, SHIP_FREEBOARD + 0.04, 0, PALETTE.shipDeck);
  parts.push(deck);

  // The bridge and accommodation, aft, and its funnel.
  const houseX = -hl + 1.6;
  parts.push(box(2.6, 3.4, SHIP_B - 0.6, houseX, SHIP_FREEBOARD + 1.7, 0, PALETTE.shipHouse));
  parts.push(box(2.75, 0.45, SHIP_B - 0.3, houseX, SHIP_FREEBOARD + 2.9, 0, PALETTE.craneDark));
  parts.push(box(3.0, 0.18, SHIP_B + 0.6, houseX + 0.1, SHIP_FREEBOARD + 3.45, 0, PALETTE.shipHouse));
  parts.push(box(1.1, 1.5, 1.2, houseX - 0.5, SHIP_FREEBOARD + 4.1, 0, PALETTE.craneHouse));
  parts.push(box(1.14, 0.3, 1.24, houseX - 0.5, SHIP_FREEBOARD + 4.7, 0, PALETTE.craneDark));

  // The cargo: bays of containers across the beam, forward of the house. Stacked lower towards
  // the bow, the way a loaded ship's profile steps down.
  const bayX0 = houseX + 1.6 + BOX_L / 2;
  const bays = Math.floor((SHIP_L - 6.5) / (BOX_L + 0.15));
  const rows = Math.floor((SHIP_B - 0.6) / (BOX_W + 0.05));
  for (let b = 0; b < bays; b++) {
    const cap = b === bays - 1 ? 2 : 3;
    for (let r = 0; r < rows; r++) {
      const z = (r - (rows - 1) / 2) * (BOX_W + 0.05);
      const tiers = Math.max(1, cap - rng.int(0, 1));
      parts.push(...stack(rng, bayX0 + b * (BOX_L + 0.15), SHIP_FREEBOARD + 0.08, z, tiers));
    }
  }
  return parts;
}

/**
 * Everything the harbor builds, or null when there is none.
 *
 * Returns `{ mesh }`: the quays, walls, yards, cranes, containers and ship, merged into one static
 * mesh like the rest of the city's scenery.
 */
export function createHarbor(rng) {
  const piers = harborPiers();
  if (!piers) return null;
  const { basin } = piers;
  const banks = riverBanks();
  const parts = [];
  const wallCol = jitterColor(PALETTE.riverWall, rng, { l: 0.02 });
  const kerbCol = jitterColor(PALETTE.kerb, rng, { l: 0.02 });
  const quayCol = jitterColor(PALETTE.quay, rng, { l: 0.02 });

  // --- The walls: every edge of the land that stands in the sea — the seawall and its corner, both
  // piers, both quays and the basin's back wall — read off the same outline the slab is cut from
  // (city/harborplan.js), so the two cannot disagree. Ground level down past the waterline; a
  // pier's own kerb box covers the step from there up to the yard.
  //
  // Faced away from the land by testing which side of each edge the land is on, rather than by
  // trusting the outline's winding: a wall wound into the land is a wall that does not draw.
  const seaFrom = seaStartX();
  const wallBottom = WATER_Y - WALL_FOOT;
  const seawall = [];
  for (const side of [1, -1]) {
    const poly = islandHalf(side, coastWest(), SLAB_RADIUS);
    for (let k = 0; k < poly.length; k++) {
      const [ax, az] = poly[k];
      const [bx, bz] = poly[(k + 1) % poly.length];
      if (Math.min(ax, bx) < seaFrom - 1e-6) continue;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      let nx = (bz - az) / len;
      let nz = -(bx - ax) / len;
      if (insidePolygon(poly, (ax + bx) / 2 + nx * 0.05, (az + bz) / 2 + nz * 0.05)) { nx = -nx; nz = -nz; }
      parts.push(wallQuad(ax, az, bx, bz, nx, nz, 0, wallBottom, wallCol));
      // The seawall proper — not a pier or a quay — takes the riprap.
      const onPier = Math.abs(az - bz) < 1e-6 || Math.abs(ax - bx) < 1e-6;
      if (!onPier || Math.max(ax, bx) < basin.x0 - 1) seawall.push({ ax, az, bx, bz, nx, nz, len });
    }
  }

  // The ends of the channel's two embankments, where they stop at the basin. Each is a strip
  // `EMBANK_WALK` wide between the bank and the channel wall, open at this end — which showed the
  // sky through it as a bright speck either side of the inlet.
  const edges = waterEdges();
  for (const [za, zb] of [[banks.z0, edges.z0], [edges.z1, banks.z1]]) {
    parts.push(wallQuad(basin.x0, za, basin.x0, zb, 1, 0, KERB_H, wallBottom, wallCol));
  }

  // --- The rocky shore (see ROCK_* above). Placed off the stream in segment order, so it stays
  // put for a given city.
  const rock = (r, x, y, z) => {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1 + rng.next() * 0.45, 0.7 + rng.next() * 0.35, 1 + rng.next() * 0.45);
    g.rotateY(rng.next() * Math.PI);
    g.translate(x, y, z);
    parts.push(bakeColor(g, jitterColor(PALETTE.riprap, rng, { l: 0.07 })));
  };
  for (const seg of seawall) {
    const n = Math.max(1, Math.round(seg.len / ROCK_PITCH));
    for (let k = 0; k < n; k++) {
      // The bank: against the wall, crowns up near the top of it.
      const t = (k + rng.next()) / n;
      const r = rng.range(ROCK_BANK[0], ROCK_BANK[1]);
      const out = r * 0.55 + rng.next() * 0.4;
      rock(r, seg.ax + (seg.bx - seg.ax) * t + seg.nx * out, WATER_Y + 0.6 + rng.next() * 0.7,
        seg.az + (seg.bz - seg.az) * t + seg.nz * out);
      // The apron: smaller, further out, half under the water.
      if (rng.chance(0.7)) {
        const u = (k + rng.next()) / n;
        const ra = rng.range(ROCK_APRON[0], ROCK_APRON[1]);
        const outA = 1.4 + rng.next() * 1.4;
        rock(ra, seg.ax + (seg.bx - seg.ax) * u + seg.nx * outA, WATER_Y + 0.05 + rng.next() * 0.25,
          seg.az + (seg.bz - seg.az) * u + seg.nz * outA);
      }
    }
  }

  // --- The yards and the apron, as raised platforms the way a block's is: a kerb box with the
  // quay's concrete inset on top.
  const x0 = basin.kerbX + YARD_SET;
  const platforms = [
    // The two piers, from the ring road out along the basin.
    { x0, x1: piers.end, z0: piers.far.out, z1: basin.z0 },
    { x0, x1: piers.end, z0: basin.z1, z1: piers.near.out },
    // The apron either side of the channel's last stretch, between the ring bridge and the basin.
    { x0, x1: basin.x0, z0: basin.z0, z1: banks.z0 },
    { x0, x1: basin.x0, z0: banks.z1, z1: basin.z1 },
  ];
  for (const p of platforms) {
    const w = p.x1 - p.x0;
    const d = p.z1 - p.z0;
    if (w <= 0 || d <= 0) continue;
    parts.push(box(w, KERB_H, d, p.x0 + w / 2, KERB_H / 2, p.z0 + d / 2, kerbCol));
    const top = new THREE.PlaneGeometry(w - PAVE_INSET * 2, d - PAVE_INSET * 2);
    top.rotateX(-Math.PI / 2);
    top.translate(p.x0 + w / 2, KERB_H + 0.01, p.z0 + d / 2);
    parts.push(bakeColor(top, quayCol));
  }
  const topY = KERB_H + 0.01;
  const len = piers.end - basin.x0;

  // --- The quay edges: a pale coping line and a row of bollards, both sides.
  for (const [z, dir] of [[basin.z0, -1], [basin.z1, 1]]) {
    const coping = new THREE.PlaneGeometry(len, 0.35);
    coping.rotateX(-Math.PI / 2);
    coping.translate(basin.x0 + len / 2, topY + 0.01, z + dir * 0.3);
    parts.push(bakeColor(coping, PALETTE.quayEdge));
    for (let x = basin.x0 + 1.5; x < piers.end - 1; x += 3.2) {
      const b = new THREE.CylinderGeometry(0.16, 0.2, 0.42, 6);
      b.translate(x, topY + 0.21, z + dir * 0.75);
      parts.push(bakeColor(b, PALETTE.bollard));
    }
  }

  // --- The cranes, and their rails. On the far quay unless the L train runs over it.
  //
  // The line is the city's first east-west arterial (game/ltrain.js `planLTrain`, read off the
  // grid the same way here because a city module cannot import a game one), and it carries on out
  // over the harbor at deck height 6.4 — under the cranes' 7.75 boom. In over half of all cities it
  // runs along the far pier six units behind the quay, which is exactly the cranes' landside rail:
  // 594 vertices of crane in the deck's slot. So the cranes, and the ship they work, take the near
  // quay instead whenever the line crosses their footprint, and the yard leaves the line a lane.
  // (A north-south line never comes near the harbor.)
  let lz = null;
  if (!LTRAIN_NS) for (let j = 0; j <= GRID_J; j++) if (isArterialX(j)) { lz = lineZ(j); break; }
  const LINE_CLEAR = 2.5;   // the deck's half-width and its columns' footings, with room
  const footprint = (quay, dir) => [quay - dir * (CRANE_QUAY_GAP + CRANE_GAUGE + CRANE_BACKREACH) * CRANE_SCALE,
    quay + dir * (CRANE_OUTREACH - CRANE_QUAY_GAP) * CRANE_SCALE].sort((a, b) => a - b);
  const crosses = ([a, b]) => lz !== null && lz + LINE_CLEAR > a && lz - LINE_CLEAR < b;
  const onNear = crosses(footprint(basin.z0, 1)) && !crosses(footprint(basin.z1, -1));
  // `dir` points from the quay out over the water: +z off the far quay, -z off the near one.
  const craneZ = onNear ? basin.z1 : basin.z0;
  const dir = onNear ? -1 : 1;
  const railLen = len - 2;
  for (const dz of [-CRANE_QUAY_GAP * CRANE_SCALE * dir, -(CRANE_QUAY_GAP + CRANE_GAUGE) * CRANE_SCALE * dir]) {
    const rail = new THREE.PlaneGeometry(railLen, 0.22);
    rail.rotateX(-Math.PI / 2);
    rail.translate(basin.x0 + 1 + railLen / 2, topY + 0.01, craneZ + dz);
    parts.push(bakeColor(rail, PALETTE.craneDark));
  }
  // Over the ship's berth (`berth` below), a ship's length apart less a little, so both work it.
  const craneMid = basin.x0 + 2 + SHIP_L / 2;
  const cranePitch = SHIP_L * 0.55;
  for (let k = 0; k < CRANES; k++) {
    const cx = craneMid + (k - (CRANES - 1) / 2) * cranePitch;
    const geo = mergeGeometries(crane(rng, 0.35 + rng.next() * 0.5), false);
    geo.scale(CRANE_SCALE, CRANE_SCALE, CRANE_SCALE);
    // Built facing +z; a half turn faces it the other way without mirroring its winding.
    if (onNear) geo.rotateY(Math.PI);
    geo.translate(cx, topY, craneZ);
    parts.push(geo);
  }

  // --- Containers: a block on each pier behind the quay strip.
  const craneBack = (CRANE_QUAY_GAP + CRANE_GAUGE + CRANE_BACKREACH) * CRANE_SCALE + 1.5;
  const clear = lz === null ? null : [lz - LINE_CLEAR, lz + LINE_CLEAR];
  // The containers start past each pier's warehouse.
  const yardFrom = x0 + 3 + WAREHOUSE_LEN + 2;
  parts.push(...containerBlock(rng, yardFrom, piers.end - 2, piers.far.out + 2,
    basin.z0 - (onNear ? 3.5 : craneBack), topY, clear));
  parts.push(...containerBlock(rng, yardFrom, piers.end - 2, basin.z1 + (onNear ? craneBack : 3.5),
    piers.near.out - 2, topY, clear));

  // --- The warehouses: the aprons' sheds, and a big one at the landward end of each pier, filling
  // the pier's depth behind the crane strip on the cranes' side.
  sheds(rng, parts, basin, banks, topY);
  for (const [z0, z1] of [
    [piers.far.out + 2, basin.z0 - (onNear ? 3.5 : craneBack)],
    [basin.z1 + (onNear ? craneBack : 3.5), piers.near.out - 2],
  ]) {
    // In two, either side of a lane, where the depth would make one a hangar.
    const lots = (z1 - z0) > 22 ? [[z0, (z0 + z1) / 2 - 1.5], [(z0 + z1) / 2 + 1.5, z1]] : [[z0, z1]];
    for (const [za, zb] of lots) warehouse(za, zb);
  }
  function warehouse(z0, z1) {
    const d = z1 - z0;
    if (d < 6) return;
    const xc = x0 + 2 + WAREHOUSE_LEN / 2;
    const zc = (z0 + z1) / 2;
    const wall = jitterColor(rng.pick([PALETTE.brick, PALETTE.concrete]), rng, { l: 0.05 });
    parts.push(box(WAREHOUSE_LEN, WAREHOUSE_EAVE, d, xc, topY + WAREHOUSE_EAVE / 2, zc, wall));
    parts.push(gableRoof(WAREHOUSE_LEN, d, WAREHOUSE_PITCH, xc, topY + WAREHOUSE_EAVE, zc,
      jitterColor(PALETTE.slate, rng, { l: 0.05 }), true));
    // Loading doors along the +x end and the +z side: the faces the camera sees.
    for (let k = 0; k < 3; k++) {
      const dz = zc - d / 2 + (k + 0.5) * (d / 3);
      parts.push(box(0.08, WAREHOUSE_EAVE * 0.6, Math.min(2.6, d / 3 - 1), xc + WAREHOUSE_LEN / 2 + 0.04,
        topY + WAREHOUSE_EAVE * 0.3, dz, PALETTE.garageDoor));
    }
    for (let k = 0; k < 3; k++) {
      const dx = xc - WAREHOUSE_LEN / 2 + (k + 0.5) * (WAREHOUSE_LEN / 3);
      parts.push(box(2.6, WAREHOUSE_EAVE * 0.6, 0.08, dx, topY + WAREHOUSE_EAVE * 0.3, z1 + 0.04,
        PALETTE.garageDoor));
    }
  }

  // --- Where the ship ties up: along the cranes' quay, a fender off the wall, under the cranes.
  // The ship itself moves (game/harborships.js).
  const berth = {
    x: craneMid,
    z: craneZ + dir * (SHIP_FENDER + SHIP_B / 2),
    // Which way is out from the quay, and where the open sea starts past the piers.
    out: dir,
    seaX: piers.end,
    basin,
  };

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'harbor';
  return { mesh, basin, berth };
}

/**
 * A vertical wall along a→b from `top` down to `bottom`, wound so its face points along (nx, nz).
 * Hand-written triangles, so the winding is checked here against the normal it is meant to have
 * rather than trusted (CLAUDE.md, the roadworks ramp).
 */
function wallQuad(ax, az, bx, bz, nx, nz, top, bottom, col) {
  const A = [ax, top, az]; const B = [bx, top, bz]; const C = [bx, bottom, bz]; const D = [ax, bottom, az];
  let tris = [A, C, B, A, D, C];
  // Face normal of the first triangle from its winding: (C - A) x (B - A).
  const u = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const v = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const fx = u[1] * v[2] - u[2] * v[1];
  const fz = u[0] * v[1] - u[1] * v[0];
  if (fx * nx + fz * nz < 0) tris = [A, B, C, A, C, D];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
  return bakeColor(g, col);
}

/** The long sheds on the aprons either side of the channel's last stretch. */
function sheds(rng, parts, basin, banks, floor) {
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
      parts.push(box(w, eave, len, xc, floor + eave / 2, zc, wall));
      parts.push(gableRoof(w, len, SHED_PITCH, xc, floor + eave, zc, jitterColor(PALETTE.slate, rng, { l: 0.05 })));
      // Loading doors down the basin side, the side the camera sees.
      const doors = Math.max(1, Math.floor(len / 4));
      for (let k = 0; k < doors; k++) {
        const dz = zc - len / 2 + (k + 0.5) * (len / doors);
        parts.push(box(0.08, eave * 0.62, Math.min(2.2, len / doors - 0.8), xb + 0.04, floor + eave * 0.31, dz,
          PALETTE.garageDoor));
      }
    }
  }
}

/**
 * A gabled roof over a `w` x `d` footprint with its ridge along z (or along x with `alongX`),
 * eaves at `y`, `rise` to the ridge and a little overhang. A closed prism from six hand-placed
 * points, so the probe asserts its winding rather than trusting it.
 */
export function gableRoof(w, d, rise, x, y, z, colour, alongX = false) {
  // Built ridge-along-z; with `alongX` the footprint is swapped first and turned a quarter.
  const [fw, fd] = alongX ? [d, w] : [w, d];
  const hw = fw / 2 + 0.25;
  const hd = fd / 2 + 0.25;
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
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  if (alongX) g.rotateY(Math.PI / 2);
  g.translate(x, y, z);
  g.computeVertexNormals();
  return bakeColor(g, colour);
}
