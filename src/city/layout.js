import { GRID, blockBounds, HALF_SPAN, segmentKey, setClosedSegments } from './grid.js';
import { roadNetFromGrid, setCityNetwork } from './roadnet.js';
import { pointInPolygon } from './curves.js';
import { configureSignals } from '../sim/traffic.js';

// Decides what each block *is* before anything is built. Ground, buildings and props all read
// this, so a park is a park in every system rather than three subsystems each rolling their own
// dice and disagreeing.

/**
 * Density falls off from the centre, which is what gives a generated city a downtown instead of
 * a uniform mat of identical towers. Parks are more likely out in the cheaper suburbs.
 */
export function createLayout(rng) {
  // A park district is two adjacent blocks *plus the road that used to separate them*, merged
  // into one solid green mass. Leaving the road in place produced two parks either side of a
  // street, which still reads as the same repeating grid. Closing the segment is what actually
  // breaks the rhythm — and it means the road genuinely isn't there, so traffic routes around it
  // rather than driving through a park.
  const parkCells = new Map();   // "bi,bj" -> district id
  const districts = [];
  const closed = [];
  const DISTRICT_COUNT = 2;

  for (let n = 0; n < DISTRICT_COUNT; n++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const horizontal = rng.chance(0.5);
      const bi = rng.int(0, horizontal ? GRID - 2 : GRID - 1);
      const bj = rng.int(0, horizontal ? GRID - 1 : GRID - 2);
      const a = [bi, bj];
      const b = horizontal ? [bi + 1, bj] : [bi, bj + 1];
      if (parkCells.has(`${a[0]},${a[1]}`) || parkCells.has(`${b[0]},${b[1]}`)) continue;

      const id = districts.length;
      parkCells.set(`${a[0]},${a[1]}`, id);
      parkCells.set(`${b[0]},${b[1]}`, id);

      // The road between the pair, named by the two intersections at its ends.
      closed.push(horizontal
        ? segmentKey(bi + 1, bj, bi + 1, bj + 1)
        : segmentKey(bi, bj + 1, bi + 1, bj + 1));

      districts.push({ id });
      break;
    }
  }

  setClosedSegments(closed);

  // --- Arterials -------------------------------------------------------------
  // Road hierarchy is a property of the city, so it is decided here alongside the blocks and
  // handed to the signal model. Two roads per axis, never adjacent, each with a coordinated
  // direction of travel — so the map has a grain: some streets simply move better than others,
  // and in one direction more than the other.
  // Two main streets, one per axis, drawn from the middle lines so they genuinely run *through*
  // the city rather than skirting an edge. Four arterials (the previous count) meant most
  // junctions had an arterial on at least one axis, which flattened the hierarchy back out.
  const middle = () => (rng.chance(0.5) ? 2 : 3);

  const arterialX = new Set([middle()]);   // runs east-west
  const arterialZ = new Set([middle()]);   // runs north-south
  const dirX = new Map([...arterialX].map((j) => [j, rng.chance(0.5) ? 1 : -1]));
  const dirZ = new Map([...arterialZ].map((i) => [i, rng.chance(0.5) ? 1 : -1]));

  configureSignals({ arterialX, arterialZ, dirX, dirZ });

  const arterials = { x: arterialX, z: arterialZ, dirX, dirZ };

  // Bake the road network for the city just decided, and install it as *the* network. Everything
  // above — the closures, the arterials, their coordinated directions — is exactly the input it
  // needs, so this is the one place in the codebase that has it all in hand. Callers get the
  // network by asking `cityNetwork()` rather than by being handed one.
  const net = setCityNetwork(roadNetFromGrid({ arterials }));

  // --- Blocks ----------------------------------------------------------------
  //
  // The buildable land is whatever the roads enclose — a face of the road graph — so the network
  // already produced it, and closing the road between two park cells has *already* merged them
  // into one block. The hand-computed merged AABB that used to live here is gone with it.
  //
  // What the network has no opinion about is what a block *is*: park or built, and how central.
  // That is still decided per grid cell and projected onto the face containing the cell. Keeping
  // this loop grid-shaped is deliberate — iterating faces instead would change both the number and
  // the order of `rng.chance` draws, and re-roll which blocks are parks on every existing seed.
  for (const block of net.blocks) {
    block.type = 'built';
    block.centrality = 0;
    block.cells = 0;
  }

  const placed = new Map();   // block -> where it sits in the grid, for ordering below

  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const { cx, cz } = blockBounds(bi, bj);
      const distance = Math.hypot(cx, cz) / (HALF_SPAN * Math.SQRT2);

      // 1 at the core, ~0 at the corners.
      const centrality = Math.max(0, 1 - distance * 1.55);

      // A district claim wins; otherwise the occasional lone pocket park out in the suburbs.
      const districtId = parkCells.get(`${bi},${bj}`);
      const isPark = districtId !== undefined || rng.chance(0.02 + (1 - centrality) * 0.03);

      const block = net.blocks.find((b) => pointInPolygon(cx, cz, b.polygon));
      if (!block) continue;

      block.cells += 1;
      // Both cells of a district land on the same merged face, so park-ness ORs. Centrality only
      // ever matters for a built block, and a closure can only merge two *park* cells, so a merged
      // block's value is never read — max keeps it defined rather than arbitrary.
      if (isPark) block.type = 'park';
      block.centrality = Math.max(block.centrality, centrality);
      if (!placed.has(block)) placed.set(block, { district: districtId ?? null, bi, bj });
    }
  }

  // Ordered so the mesh builders' RNG streams do not move: merged park districts first, in the
  // order they were created, then the rest in the grid's bi-outer/bj-inner order — which is
  // exactly the order `ground.js` and `props.js` used to walk when districts were a separate pass.
  // Face traversal order is arbitrary, and both builders draw per block from their own stream, so
  // a reshuffle would re-tint every kerb and move every tree in the city.
  const rank = (block) => placed.get(block) ?? { district: null, bi: GRID, bj: GRID };
  const blocks = [...net.blocks].sort((p, q) => {
    const a = rank(p);
    const b = rank(q);
    if ((a.district === null) !== (b.district === null)) return a.district === null ? 1 : -1;
    if (a.district !== null) return a.district - b.district;
    return a.bi - b.bi || a.bj - b.bj;
  });

  // Handed to the ground mesh so the arterials are actually visible: a main street the player
  // can't identify is just an invisible timing tweak.
  blocks.arterials = arterials;
  blocks.closedSegments = closed;
  return blocks;
}
