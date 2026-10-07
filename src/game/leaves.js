import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { KERB_H } from '../city/ground.js';
import { CELL_EDGE } from './squall.js';

// Leaves blown off the park trees by a squall. One `InstancedMesh` of small leaf-shaped cards,
// shared by every tree, on the pool recipe every other mote in the game uses (`game/wake.js`):
// a ring buffer, dead slots parked at zero scale, `skipWhenEmpty` so a sunny frame draws nothing.
//
// A leaf comes off a crown lobe the squall's cell is over, drifts downwind with the cell, swings
// side to side as it drops — the falling-leaf pendulum, slowing at each end of its swing — and then
// lies on the lawn for a while before it shrinks away. Most of them come off at the cell's **edge**
// rather than its core: the gust front is what strips a tree, and the steady rain behind it only
// brings down stragglers. That also puts the shower where the eye already is, on the line between
// sun and rain.

// The pool. A crossing puts ~30 crown lobes under the cell at once; at the rates below that is ~25
// leaves a second at the edge, each alive for ~4.5s of fall and `REST` on the ground, so ~300 at the
// worst moment. The ring buffer recycles the oldest — which is a leaf already lying on the grass,
// and losing one of those early reads as nothing.
const MAX_LEAVES = 448;

// A leaf, as a card: 0.75 long and 0.48 wide, about 6 by 4 pixels at play zoom (1 unit ≈ 7.7px).
// Larger than a real leaf on purpose. The first cut was 0.5 (4px) and at play zoom the shower was
// a few specks lost in the rain streaks — a leaf here has to read as a *shape*, not a dot.
const LEAF_LEN = 0.75;
const LEAF_WID = 0.48;

// Leaves a second off one crown lobe at the cell's edge (`edgeWeight` peaks at 1 there), and how
// much of that keeps coming under the core. A tree that has not turned sheds a quarter as many —
// green leaves do come off in a storm, but a green shower would read as the tree being shredded.
const SHED_RATE = 0.85;
const CORE_SHED = 0.3;
const GREEN_SHED = 0.25;

// The fall: terminal speed of a leaf, u/s, and how much it varies leaf to leaf. ~4.5s from the top
// of a crown to the lawn, which is long enough to watch one come down without it hanging in the air.
const FALL = [0.75, 1.1];
// Downwind drift, u/s, along the cell's own heading — a squall is a moving storm, and the leaves
// going the way it is going is most of what says "wind". Plus a little scatter either side.
const WIND = 1.8;
const WIND_SCATTER = 0.6;
// The swing: how far either side of its path a leaf rocks, how fast (rad/s), and how far it tilts
// at the end of each swing. A real leaf's tilt is what makes it catch the light and flash, which
// is the part that reads at 4 pixels.
const SWAY = [0.35, 0.7];
const SWAY_RATE = [2.2, 3.6];
const TILT = 0.9;
// Seconds a leaf lies on the ground, and the shrink at the end of that.
const REST = [5, 8];
const SHRINK = 1.2;

// Where a leaf comes to rest. In a park, clear of the lawn, the walk and the court's painted lines
// (the highest flat surface in a park, `COURT_TOP_Y` + 0.018) by enough that nothing shimmers; off
// it, clear of the road's own markings at 0.02.
const PARK_REST_Y = KERB_H + 0.01 + 0.08;
const ROAD_REST_Y = 0.04;

/** How strongly the cell's mask `m` (0..1) strips a tree: highest on the edge, a trickle in the core. */
const edgeWeight = (m) => 4 * m * (1 - m) * (1 - CORE_SHED) + CORE_SHED * m;

/**
 * The pool. `crowns` are the parks' canopy lobes (`createProps().crowns`, filtered to park trees),
 * each `{ x, y, z, r, color }`; `plots` the parks' bounds, which say where a leaf lands on the lawn
 * rather than the road; `squall` the weather it reads (game/squall.js).
 */
export function createLeaves(parent, rng, crowns, plots, squall) {
  // A leaf: a pointed oval, six triangles in the XZ plane, facing up. Double-sided, so the winding
  // only has to be right for the normal it carries — and it is the normal, not the winding, that
  // lights it: three flips it for the back face on the smooth path, which is why this is
  // `smooth` and not the flat-shaded default (see CLAUDE.md on `flatShading` and back faces).
  const L = LEAF_LEN / 2;
  const W = LEAF_WID / 2;
  const outline = [[L, 0], [L * 0.35, W], [-L * 0.45, W * 0.8], [-L, 0], [-L * 0.45, -W * 0.8], [L * 0.35, -W]];
  const pos = [];
  for (let k = 0; k < outline.length; k++) {
    const [ax, az] = outline[k];
    const [bx, bz] = outline[(k + 1) % outline.length];
    // Centre, b, a: counter-clockwise seen from +Y, so the face normal is +Y.
    pos.push(0, 0, 0, bx, 0, bz, ax, 0, az);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(
    Array.from({ length: pos.length / 3 }, () => [0, 1, 0]).flat(), 3));
  bakeColor(geometry, '#FFFFFF');   // white, so the per-leaf `instanceColor` is the whole colour

  // A prop, so a leaf takes the same light, shadow tint and look modes as the tree it came off.
  // No AO: a card this small reading the occlusion of the lawn under it goes dark for nothing.
  const material = propMaterial({ ao: false, smooth: true });
  material.side = THREE.DoubleSide;

  const mesh = skipWhenEmpty(new THREE.InstancedMesh(geometry, material, MAX_LEAVES));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.name = 'leaves';
  // The trap from CLAUDE.md: a moving pool's bounding sphere is latched once, off whatever the
  // matrices were on the first frame it is culled — which for this pool is an empty one.
  mesh.frustumCulled = false;
  // Too small to cast a shadow worth its pass, and a leaf lying in a crown's shade is darker anyway.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const white = new THREE.Color(1, 1, 1);
  for (let slot = 0; slot < MAX_LEAVES; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, white);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  parent.add(mesh);

  // Every crown, with what it sheds: its own colour, lifted a little — the underside of a lobe is
  // in its own shade, and a leaf out in the open is lit all round — and how readily it lets go.
  const green = (c) => c.g > c.r * 1.15;
  const sources = crowns.map((c) => ({
    x: c.x, y: c.y, z: c.z, r: c.r,
    color: c.color.clone().offsetHSL(0, 0.04, 0.05),
    shed: green(c.color) ? GREEN_SHED : 1,
    owed: rng.next(),   // a fractional leaf in hand, so every crown doesn't drop its first on one frame
  }));

  const inPark = (x, z) => plots.some(({ x0, z0, x1, z1 }) => x >= x0 && x <= x1 && z >= z0 && z <= z1);

  // A leaf's state. Integrated rather than closed-form: the wind is the cell's heading at the frame
  // the leaf let go, and nothing here needs to be photographed part-way through.
  const alive = new Uint8Array(MAX_LEAVES);   // 0 dead, 1 falling, 2 lying
  const px = new Float32Array(MAX_LEAVES);
  const py = new Float32Array(MAX_LEAVES);
  const pz = new Float32Array(MAX_LEAVES);
  const vx = new Float32Array(MAX_LEAVES);
  const vz = new Float32Array(MAX_LEAVES);
  const fall = new Float32Array(MAX_LEAVES);
  const restY = new Float32Array(MAX_LEAVES);
  const sway = new Float32Array(MAX_LEAVES);
  const rate = new Float32Array(MAX_LEAVES);
  const phase = new Float32Array(MAX_LEAVES);
  const yaw = new Float32Array(MAX_LEAVES);
  const spin = new Float32Array(MAX_LEAVES);
  const age = new Float32Array(MAX_LEAVES);
  const rest = new Float32Array(MAX_LEAVES);   // seconds left on the ground
  const size = new Float32Array(MAX_LEAVES);

  let next = 0;
  let live = 0;
  let shed = 0;   // leaves ever let go, for the checks

  function spawn(src, cell) {
    const slot = next;
    next = (next + 1) % MAX_LEAVES;
    if (!alive[slot]) live += 1;
    shed += 1;
    // Off the lower half of the lobe's surface, where a leaf actually has air under it.
    const a = rng.range(0, Math.PI * 2);
    const out = src.r * rng.range(0.7, 1);
    px[slot] = src.x + Math.cos(a) * out;
    pz[slot] = src.z + Math.sin(a) * out;
    py[slot] = src.y - src.r * rng.range(0, 0.5);
    const scatter = rng.range(-WIND_SCATTER, WIND_SCATTER);
    vx[slot] = cell.dirX * WIND - cell.dirZ * scatter;
    vz[slot] = cell.dirZ * WIND + cell.dirX * scatter;
    fall[slot] = rng.range(FALL[0], FALL[1]);
    sway[slot] = rng.range(SWAY[0], SWAY[1]);
    rate[slot] = rng.range(SWAY_RATE[0], SWAY_RATE[1]);
    phase[slot] = rng.range(0, Math.PI * 2);
    yaw[slot] = rng.range(0, Math.PI * 2);
    spin[slot] = rng.range(-2.5, 2.5);
    age[slot] = 0;
    rest[slot] = rng.range(REST[0], REST[1]);
    size[slot] = rng.range(0.8, 1.2);
    alive[slot] = 1;
    mesh.setColorAt(slot, src.color);
    mesh.instanceColor.needsUpdate = true;
  }

  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  function update(dt) {
    const { cell } = squall;
    if (cell.on) {
      const reach = cell.r * 1.18 + CELL_EDGE;
      for (const src of sources) {
        if (Math.abs(src.x - cell.x) > reach || Math.abs(src.z - cell.z) > reach) continue;
        const m = squall.rainAt(src.x, src.z);
        if (m <= 0.02) continue;
        src.owed += SHED_RATE * src.shed * edgeWeight(m) * dt;
        while (src.owed >= 1) {
          src.owed -= 1;
          spawn(src, cell);
        }
      }
    }
    if (live === 0) return;

    for (let slot = 0; slot < MAX_LEAVES; slot++) {
      if (!alive[slot]) continue;
      age[slot] += dt;
      let scale = size[slot];
      if (alive[slot] === 1) {
        // The pendulum: the sideways swing is a sine across the leaf's own path, and it drops
        // fastest through the bottom of each swing and hangs at the ends — so the fall speed rides
        // the swing at twice its rate.
        const s = age[slot] * rate[slot] + phase[slot];
        const swing = Math.cos(s) * sway[slot] * rate[slot] * dt;
        const sideX = -vz[slot];
        const sideZ = vx[slot];
        const side = Math.hypot(sideX, sideZ) || 1;
        px[slot] += vx[slot] * dt + (sideX / side) * swing;
        pz[slot] += vz[slot] * dt + (sideZ / side) * swing;
        py[slot] -= fall[slot] * (1 - 0.6 * Math.cos(2 * s)) * dt;
        yaw[slot] += spin[slot] * dt;
        const ground = inPark(px[slot], pz[slot]) ? PARK_REST_Y : ROAD_REST_Y;
        if (py[slot] <= ground) {
          py[slot] = ground;
          alive[slot] = 2;
          euler.set(0, yaw[slot], 0);
        } else {
          euler.set(Math.sin(s) * TILT, yaw[slot], Math.cos(s) * TILT * 0.5);
        }
      } else {
        rest[slot] -= dt;
        if (rest[slot] <= 0) {
          alive[slot] = 0;
          live -= 1;
          scale = 0;
        } else if (rest[slot] < SHRINK) {
          scale *= rest[slot] / SHRINK;
        }
        euler.set(0, yaw[slot], 0);
      }
      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.copy(euler);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    mesh,
    update,
    /** Leaves in the air or on the ground right now, and ever let go — for the checks. */
    stats: () => {
      let falling = 0;
      let lying = 0;
      for (let slot = 0; slot < MAX_LEAVES; slot++) {
        if (alive[slot] === 1) falling += 1;
        else if (alive[slot] === 2) lying += 1;
      }
      return { falling, lying, shed };
    },
    /** Where each live leaf is, for the checks: `{ x, y, z, lying }`. */
    positions: () => {
      const out = [];
      for (let slot = 0; slot < MAX_LEAVES; slot++) {
        if (alive[slot]) out.push({ x: px[slot], y: py[slot], z: pz[slot], lying: alive[slot] === 2 });
      }
      return out;
    },
  };
}
