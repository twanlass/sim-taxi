// A level: the authored half of a city, and nothing else.
//
// `roadNetFromGrid` generates a city from a seed. This is the other way in — a city somebody drew.
// Both end at the same place, `setCityNetwork` plus an array of blocks tagged with what they are,
// because everything downstream reads the network and the blocks rather than how they were made.
//
// Only *authored* data is stored. Lanes, turns, signal phases and the block polygons are all
// re-derived by `bakeNetwork` on load, which is what stops a saved level going stale the moment the
// derivation changes — and it is the same property that lets the editor re-bake on every edit.

import {
  GRID, lineCoord, segmentKey, setClosedSegments, blockBounds,
} from './grid.js';
import { bakeNetwork, setCityNetwork, attachGridView, gridNodeId } from './roadnet.js';
import { pointInPolygon } from './curves.js';
import { configureSignals } from '../sim/traffic.js';

export const LEVEL_VERSION = 1;

/**
 * A stable name for a face, so a block keeps its contents when the graph changes elsewhere.
 *
 * The face's node ids, sorted. Not the traversal order — that rotates depending on which half-edge
 * the walk happened to start from — and not an index, which renumbers the moment an edge is added
 * anywhere in the city.
 */
export const faceKey = (block) => block.nodes.slice().sort().join('|');

/** The level a generated city corresponds to, so the editor can open one and edit it. */
export function levelFromCity(net, blocks) {
  return {
    version: LEVEL_VERSION,
    nodes: net.nodes.map((n) => ({
      id: n.id, x: round(n.x), z: round(n.z), ...(n.gi === undefined ? {} : { gi: n.gi, gj: n.gj }),
    })),
    edges: net.edges.map((e) => ({
      id: e.id, a: e.a, b: e.b, klass: e.klass, wave: e.wave, ...(e.bulge ? { bulge: e.bulge } : {}),
    })),
    blocks: Object.fromEntries(blocks.map((b) => [faceKey(b), { type: b.type }])),
  };
}

const round = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Install a level as the running city, and hand back its blocks in the shape the mesh builders
 * want — the same contract `createLayout` fulfils.
 */
export function cityFromLevel(level) {
  // A junction nothing connects to is not part of the city. Dropping it here rather than asking
  // every caller to filter is what lets a level be edited down to a handful of roads and still
  // describe a coherent place.
  const used = new Set(level.edges.flatMap((e) => [e.a, e.b]));
  const nodes = level.nodes.filter((n) => used.has(n.id));
  const net = setCityNetwork(attachGridView(bakeNetwork({ nodes, edges: level.edges })));

  // The grid still answers two questions for a lattice-aligned level — `isCityConnected` in
  // main.js and `legalExits` in the tools — and both work off the closed-segment set. Deriving it
  // from the edges the level *doesn't* have keeps those answers true without the level having to
  // store closures separately. A level drawn off the lattice has no grid answer to give, and says
  // so via `net.onLattice`.
  if (net.onLattice) setClosedSegments(missingLatticeSegments(level));
  else setClosedSegments([]);

  const arterials = arterialsOf(level, net);
  configureSignals({
    arterialX: arterials.x, arterialZ: arterials.z, dirX: arterials.dirX, dirZ: arterials.dirZ,
  });

  const stored = level.blocks ?? {};
  const blocks = net.blocks.map((block) => {
    const saved = stored[faceKey(block)];
    block.type = saved?.type ?? 'built';
    // Centrality drives building height, and is a property of where the block sits rather than of
    // anything authored — so it is computed here rather than stored.
    const { cx, cz } = block.bounds;
    block.centrality = Math.max(0, 1 - (Math.hypot(cx, cz) / (GRID * 20 * 0.5 * Math.SQRT2)) * 1.55);
    block.cells = cellsUnder(block);
    return block;
  });

  blocks.arterials = arterials;
  blocks.closedSegments = net.onLattice ? missingLatticeSegments(level) : [];
  return blocks;
}

/** How many grid cells a face covers, which is what sets park planting density. */
function cellsUnder(block) {
  let n = 0;
  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const { cx, cz } = blockBounds(bi, bj);
      if (pointInPolygon(cx, cz, block.polygon)) n += 1;
    }
  }
  return n;
}

/** Lattice segments the level has no edge for — the closures, expressed the way `grid.js` wants. */
function missingLatticeSegments(level) {
  const present = new Set();
  for (const e of level.edges) present.add(segmentKey(...idPair(e.a), ...idPair(e.b)));

  const closed = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (i < GRID && !present.has(segmentKey(i, j, i + 1, j))) closed.push(segmentKey(i, j, i + 1, j));
      if (j < GRID && !present.has(segmentKey(i, j, i, j + 1))) closed.push(segmentKey(i, j, i, j + 1));
    }
  }
  return closed;
}

const idPair = (id) => id.split(',').map(Number);

/** Arterials, read back off the edges that carry the class rather than stored twice. */
function arterialsOf(level, net) {
  const x = new Set();
  const z = new Set();
  const dirX = new Map();
  const dirZ = new Map();

  for (const edge of net.edges) {
    if (edge.klass !== 'arterial') continue;
    const a = net.nodeById.get(edge.a);
    const b = net.nodeById.get(edge.b);
    if (a.gi === undefined) continue;
    if (a.gj === b.gj) { x.add(a.gj); dirX.set(a.gj, edge.wave || 1); }
    if (a.gi === b.gi) { z.add(a.gi); dirZ.set(a.gi, edge.wave || 1); }
  }
  return { x, z, dirX, dirZ };
}

/** Every lattice position an editor may put a junction at, as a level's node list. */
export function latticeNodes() {
  const nodes = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      nodes.push({ id: gridNodeId(i, j), x: lineCoord(i), z: lineCoord(j), gi: i, gj: j });
    }
  }
  return nodes;
}

/** The edge id `roadNetFromGrid` would give the road between two lattice junctions. */
export const latticeEdgeId = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// --- Storage -----------------------------------------------------------------
//
// localStorage, because the editor has to work on the deployed site with no server behind it, and
// because a level being a plain object means export is `JSON.stringify` and import is `JSON.parse`.

const KEY = 'sim-taxi.level';

export function saveLevel(level, key = KEY) {
  globalThis.localStorage?.setItem(key, JSON.stringify(level));
}

export function loadLevel(key = KEY) {
  const raw = globalThis.localStorage?.getItem(key);
  if (!raw) return null;
  try {
    const level = JSON.parse(raw);
    return level?.version === LEVEL_VERSION ? level : null;
  } catch {
    return null;
  }
}
