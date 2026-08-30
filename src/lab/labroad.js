// One straight road, and the ground it sits on.
//
// This is the whole world of the passing lab (see docs/lab.md): a single east-west carriageway
// with junctions but no lights, so a boosting taxi can be watched closing on one car and going
// round it with nothing else in the frame.
//
// The road is a *real* road network, baked through `bakeNetwork` exactly like the city is — the
// point of the lab is to watch the shipped traffic model, and a hand-faked lane would be watching
// something else. `city/roadnet.js` was written to take nodes and edges at arbitrary positions
// and derive lanes, turns and signal phases from them, so a straight chain of nodes is a legal
// city; it is just a very boring one.
//
// **Why it has no traffic lights, and why that isn't a special case.** `bakeSignals` gives a node
// a signal only when it has more than one *street* to arbitrate between, and a street is a pair of
// arms that carry on through the junction. Every interior node here has exactly two arms pointing
// exactly opposite each other, so they pair into one street and the node comes out
// `signal === null` — the same branch a park closure leaves an interior junction on in the real
// city. Nothing here asks for the lights to be turned off; there is simply never anything to
// arbitrate.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { KERB_H } from '../city/ground.js';
import { bakeNetwork } from '../city/roadnet.js';
import { PITCH, HALF_ROAD, DIR, isXAxis, dirSign } from '../city/grid.js';

/**
 * Blocks of road, at the city's own `PITCH`. Ten is 200 units end to end.
 *
 * Sized from the manoeuvre rather than picked round. A pass is ~27 units of road on its own
 * (docs/traffic.md, "Sizing it to the city"), the run-up that gets the taxi from cruise to
 * `PASS_TRIGGER` behind a cruising leader is another ~40, and the overdrive band wants 40 units of
 * unbroken straight before it is even reachable. 200 fits all three with room to watch the taxi
 * settle back into lane afterwards, and stays inside the sun's shadow frustum, which covers
 * ±`MAX_SPAN * 1.05` = ±105 (game/scene.js) — a road any longer than this loses its shadows at the
 * ends, which is a strange thing for a lab about how something *looks* to give up.
 */
export const LAB_BLOCKS = 10;

/** Total length of the carriageway, west end to east end. */
export const labRoadLength = (blocks = LAB_BLOCKS) => blocks * PITCH;

/** World x of junction `i`. The road is centred on the origin, so it runs ±length/2. */
export const labNodeX = (i, blocks = LAB_BLOCKS) => i * PITCH - labRoadLength(blocks) / 2;

const nodeId = (i) => `lab:${i}`;

/**
 * The straight road, as a network, with the grid-shaped adapters the sim still asks for.
 *
 * `sim/traffic.js` keeps `car.i`, `car.j` and `car.d` as a *view* of the lane a car is on (see
 * `syncGrid` there), so anything that installs itself as the city network has to answer the same
 * four questions `roadNetFromGrid` answers. That is cheap here because a single row of junctions
 * genuinely is a grid — a 1×N one. `gj` is 0 on every node and `d` is only ever `PX` or `NX`.
 *
 * `laneByGrid` deliberately ignores `j`. Its one caller that passes an arbitrary one is
 * `spawnCars`, which draws `(d, line, seg)` uniformly against the 5×5 city's own ranges and has no
 * idea what shape of network it is drawing onto; ignoring the row it asked for lets that draw
 * land on this road instead of failing twelve times out of twelve. Every car it produces is
 * repositioned by the lab before the first frame anyway — see `stage()` in `lab/passing.js`.
 */
export function labNetwork(blocks = LAB_BLOCKS) {
  const nodes = [];
  for (let i = 0; i <= blocks; i++) {
    nodes.push({ id: nodeId(i), x: labNodeX(i, blocks), z: 0, gi: i, gj: 0 });
  }

  const edges = [];
  for (let i = 0; i < blocks; i++) {
    // `ring` rather than `side`: the shipped straightaway with no lights on it is the ring road,
    // and the class is what `lane.withWave` and the router's road hierarchy read. Nothing in the
    // lab routes, but a road that claims to be a side street while behaving like the ring would be
    // lying to the next person who reads this.
    edges.push({ id: `${nodeId(i)}-${nodeId(i + 1)}`, a: nodeId(i), b: nodeId(i + 1), klass: 'ring' });
  }

  const net = bakeNetwork({ nodes, edges });
  const byEnds = new Map(net.lanes.map((l) => [`${l.from}>${l.to}`, l]));

  net.nodeByGrid = (i) => net.nodeById.get(nodeId(i)) ?? null;
  net.dirOfLane = (lane) => (net.nodeById.get(lane.to).gi > net.nodeById.get(lane.from).gi
    ? DIR.PX : DIR.NX);
  /** The lane a car travelling `d` toward junction `i` is on. */
  net.laneByGrid = (d, i) => {
    if (!isXAxis(d)) return null;             // there is no road running along Z
    return byEnds.get(`${nodeId(i - dirSign(d))}>${nodeId(i)}`) ?? null;
  };
  /** The lane a car leaves junction `i` on, travelling `d`. */
  net.laneOutByGrid = (d, i) => {
    if (!isXAxis(d)) return null;
    return byEnds.get(`${nodeId(i)}>${nodeId(i + dirSign(d))}`) ?? null;
  };
  net.labBlocks = blocks;
  return net;
}

// --- The ground -------------------------------------------------------------

const MARK_Y = 0.02;

/**
 * Green either side of the carriageway, and asphalt carried past each end. Both in world units.
 *
 * These exist to be *off-screen*, which is what lets the lab skip the city's `asphaltFade` skirt
 * entirely: there is no edge to feather if the edge is never in frame. That makes them worth
 * deriving rather than eyeballing, because the first pass eyeballed 60 and the ground plainly
 * ended against the sky in the top corner of the very first screenshot.
 *
 * The 3/4 camera maps screen right to world (1, 0, −1)/√2 and screen up to (−1, 0, −1)/√2 (see
 * `game/camera.js`), so both screen axes contribute to world z and the corner of the frame is the
 * worst case: at `LAB_MAX_ZOOM` (46) the frustum is 92 world units tall and, on a 21:9 monitor,
 * 215 wide, which puts the far corner (215/2 + 92/2)/√2 ≈ 109 units off the road in z. 150 covers
 * that with room for a wider window still. The apron is the same sum along x, plus the camera's
 * own lead ahead of the taxi.
 */
export const LAB_VERGE = 150;
const APRON = 160;

/** The band trees are planted in, measured out from the kerb. */
const TREE_NEAR = HALF_ROAD + 2.4;
const TREE_FAR = HALF_ROAD + 22;

function plane(w, d, x, z, col, y = 0) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

function box(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Asphalt, two raised green verges, and a dashed centre line.
 *
 * Built the same way `city/ground.js` builds the city — the slab is asphalt and everything beside
 * the road is a platform raised `KERB_H` on top of it — so a car reads as sitting *on* the road
 * here exactly as it does in the game, and `city/props.js` can plant its trees at the height it
 * already expects.
 */
export function createLabGround(rng, blocks = LAB_BLOCKS) {
  const half = labRoadLength(blocks) / 2;
  const length = labRoadLength(blocks) + APRON * 2;
  const width = (HALF_ROAD + LAB_VERGE) * 2;
  const parts = [];

  parts.push(plane(length, width, 0, 0, color('asphalt')));

  // One platform each side, running the whole length. Kerb sides, grass on top — the same two
  // pieces a city block is made of, minus the buildings.
  for (const side of [-1, 1]) {
    const centre = side * (HALF_ROAD + LAB_VERGE / 2);
    parts.push(box(length, KERB_H, LAB_VERGE, 0, 0, centre,
      jitterColor(PALETTE.kerb, rng, { l: 0.02 })));
    parts.push(plane(length - 0.3, LAB_VERGE - 0.3, 0, centre,
      jitterColor(PALETTE.park, rng, { l: 0.03 }), KERB_H + 0.01));
  }

  // Dashes, one run per gap between junctions — and no dashes across a junction box, which is
  // what makes the junctions visible at all on a road with no cross streets and no lights.
  const DASH = 1.6;
  const GAP = 1.4;
  const markColor = color('laneMark');
  for (let i = 0; i < blocks; i++) {
    const from = labNodeX(i, blocks) + HALF_ROAD;
    const to = labNodeX(i + 1, blocks) - HALF_ROAD;
    for (let s = from + GAP; s + DASH < to; s += DASH + GAP) {
      parts.push(plane(DASH, 0.18, s + DASH / 2, 0, markColor, MARK_Y));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.receiveShadow = true;
  mesh.name = 'lab-ground';
  return mesh;
}

/**
 * Verge strips shaped as `city/props.js` blocks, so the lab plants the city's own trees.
 *
 * A tree every few units along both verges is the only thing in the frame that says how fast the
 * taxi is actually going: on a bare strip of asphalt a car at cruise and a car in overdrive look
 * about the same, which would make the lab useless for the one question it exists to answer.
 *
 * One strip per block per side rather than two long ones, because `createProps` draws a fixed
 * handful of trees per block — one strip the length of the road would plant seven trees on 200
 * units of verge and call it an avenue.
 */
export function labTreeBlocks(blocks = LAB_BLOCKS) {
  const strips = [];
  for (let i = 0; i < blocks; i++) {
    const x0 = labNodeX(i, blocks);
    const x1 = labNodeX(i + 1, blocks);
    for (const side of [-1, 1]) {
      const z0 = side < 0 ? -TREE_FAR : TREE_NEAR;
      const z1 = side < 0 ? -TREE_NEAR : TREE_FAR;
      strips.push({
        type: 'park',
        districtId: null,
        bounds: { x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 },
      });
    }
  }
  return strips;
}
