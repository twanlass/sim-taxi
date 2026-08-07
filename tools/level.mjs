/**
 * Does a level round-trip, and does editing one do what the editor claims?
 *
 * The editor edits two things and derives everything else, so these are the assertions that make
 * that claim true rather than aspirational: a saved level rebuilds the same city, removing a road
 * merges the blocks either side of it, and a block keeps its contents when the graph changes
 * somewhere else. That last one is why a face is named by its ring of junctions rather than by an
 * index — an index renumbers the moment an edge is added anywhere in the city.
 *
 *   node tools/level.mjs
 */
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { cityNetwork, bakeNetwork, isNetworkConnected } from '../src/city/roadnet.js';
import { cityFromLevel, levelFromCity, faceKey, latticeNodes } from '../src/city/level.js';
import { GRID } from '../src/city/grid.js';
import { findRoute, allIntersections } from '../src/game/route.js';

const results = [];
const failures = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const SEED = 71624;

/** The generated city, as a level. */
function generated() {
  const blocks = createLayout(makeRng(SEED));
  return levelFromCity(cityNetwork(), blocks);
}

// --- Round trip --------------------------------------------------------------
{
  const before = createLayout(makeRng(SEED));
  const level = levelFromCity(cityNetwork(), before);
  const summary = (bs) => bs.map((b) => `${b.type}:${b.cells}:${b.bounds.cx.toFixed(2)},${b.bounds.cz.toFixed(2)}`).sort().join('|');
  const wanted = summary(before);

  const after = cityFromLevel(JSON.parse(JSON.stringify(level)));
  check('level round-trips the generated city', summary(after) === wanted,
    `${after.length} blocks vs ${before.length}`);
  check('round trip keeps the arterials',
    [...after.arterials.x].join() === [...before.arterials.x].join()
    && [...after.arterials.z].join() === [...before.arterials.z].join());
  check('round trip stays drivable', isNetworkConnected(cityNetwork()));
}

// --- Removing a road merges the blocks either side --------------------------
{
  const level = generated();
  const before = cityFromLevel(level).length;

  // An interior road with a block on each side. `2,2-2,3` runs along Z at i=2, between j=2 and 3.
  const victim = '2,2-2,3';
  const had = level.edges.some((e) => e.id === victim);
  level.edges = level.edges.filter((e) => e.id !== victim);
  const after = cityFromLevel(level);

  check('the road to remove was there', had, victim);
  check('removing a road merges two blocks into one', after.length === before - 1,
    `${before} -> ${after.length}`);

  // The cells either side of `2,2-2,3` are (1,2) and (2,2), and (2,2) is already half of a park
  // district — so this merges a third cell into an existing face rather than making a new one.
  const cells = after.filter((b) => b.cells > 1).reduce((n, b) => n + b.cells, 0);
  check('the merged face swallows a third cell', cells === 5, `${cells} cells in multi-cell faces`);
}

// --- A block keeps what it is when the graph changes elsewhere --------------
{
  const level = generated();
  const blocks = cityFromLevel(level);

  // Paint a block a park, the way the editor does.
  const target = blocks.find((b) => b.type === 'built' && b.cells === 1);
  level.blocks[faceKey(target)] = { type: 'park' };
  const key = faceKey(target);

  // Now change the graph a long way away, which renumbers every face.
  level.edges = level.edges.filter((e) => e.id !== '4,0-5,0');
  const after = cityFromLevel(level);

  const still = after.find((b) => faceKey(b) === key);
  check('a painted block survives an edit elsewhere', Boolean(still) && still.type === 'park',
    still ? `type ${still.type}` : 'face not found');
}

// --- A level that strands a junction is reported, not silently broken -------
{
  const level = generated();
  // Cut every road into one corner junction.
  level.edges = level.edges.filter((e) => e.a !== '0,0' && e.b !== '0,0');
  cityFromLevel(level);

  const net = cityNetwork();
  check('a junction with no roads is dropped from the city',
    !net.nodes.some((n) => n.id === '0,0'), 'node 0,0 still present');
  check('and so is not offered as a destination',
    !allIntersections().some((p) => p.i === 0 && p.j === 0));
  check('what is left is still drivable', isNetworkConnected(cityNetwork()));
  check('the rest of the city still routes',
    findRoute({ i: 1, j: 1, d: 0 }, { i: 4, j: 4 }) !== null);
}

// --- Clearing to the ring leaves one enormous block -------------------------
{
  const level = generated();
  level.edges = level.edges.filter((e) => e.klass === 'ring');
  const after = cityFromLevel(level);
  check('a ring-only level is one block', after.length === 1, `${after.length} blocks`);
  check('the ring alone is still drivable', isNetworkConnected(cityNetwork()));
}

// --- A diagonal bakes, which is the point of the whole model -----------------
{
  const nodes = latticeNodes().filter((n) => (n.gi === 0 || n.gi === GRID || n.gj === 0 || n.gj === GRID));
  const edges = [];
  for (let i = 0; i < GRID; i++) {
    edges.push({ id: `${i},0-${i + 1},0`, a: `${i},0`, b: `${i + 1},0`, klass: 'ring' });
    edges.push({ id: `${i},${GRID}-${i + 1},${GRID}`, a: `${i},${GRID}`, b: `${i + 1},${GRID}`, klass: 'ring' });
    edges.push({ id: `0,${i}-0,${i + 1}`, a: `0,${i}`, b: `0,${i + 1}`, klass: 'ring' });
    edges.push({ id: `${GRID},${i}-${GRID},${i + 1}`, a: `${GRID},${i}`, b: `${GRID},${i + 1}`, klass: 'ring' });
  }
  // Corner to corner, straight across the middle of the city.
  edges.push({ id: 'diag', a: '0,0', b: `${GRID},${GRID}`, klass: 'side' });

  const net = bakeNetwork({ nodes, edges });
  check('a diagonal splits the city into two faces', net.blocks.length === 2,
    `${net.blocks.length} blocks`);
  const corner = net.nodes.find((n) => n.id === '0,0');
  check('the diagonal makes a three-arm junction', corner.arms.length === 3,
    `${corner.arms.length} arms`);
  check('the three-arm junction gets its own phase plan',
    corner.signal === null || corner.signal.phases.length >= 2,
    `${corner.signal?.phases.length ?? 'unsignalised'}`);
}

const passed = results.filter(Boolean).length;
for (const line of failures) console.log(`  FAIL ${line}`);
console.log(`${passed}/${results.length} checks passed`);
process.exit(failures.length ? 1 : 0);
