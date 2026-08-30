import {
  GRID_I, GRID_J, blockBounds, HALF_SPAN_X, HALF_SPAN_Z, isRiverBlock, segmentKey,
  setArterialLines, setClosedSegments, setParkBlocks, setRiverRow,
} from './grid.js';
import { planRiver, setRiverCrossings } from './river.js';
import { roadNetFromGrid, setCityNetwork } from './roadnet.js';
import { chooseGarageBlock } from './garage.js';
import { chooseBurgerBlock } from './burgerjoint.js';
import { configureSignals } from '../sim/traffic.js';

// Decides what each block *is* before anything is built. Ground, buildings and props all read
// this, so a park is a park in every system rather than three subsystems each rolling their own
// dice and disagreeing.

/**
 * Density falls off from the centre, which is what gives a generated city a downtown instead of
 * a uniform mat of identical towers. Parks are more likely out in the cheaper suburbs.
 */
export function createLayout(rng) {
  // --- Arterials, first ------------------------------------------------------
  // Road hierarchy is a property of the city, so it is decided here alongside the blocks and
  // handed to the signal model. Two main streets, one per axis, drawn from the middle lines so
  // they genuinely run *through* the city rather than skirting an edge. Four arterials (the
  // previous count) meant most junctions had an arterial on at least one axis, which flattened
  // the hierarchy back out. Each gets a coordinated direction of travel, so the map has a grain:
  // some streets simply move better than others, and in one direction more than the other.
  //
  // This runs **before** anything else because an arterial is a third wider than a side street
  // and takes that width out of the blocks either side of it — so `blockBounds` cannot answer
  // until `setArterialLines` has been told. See the divided-arterial note in `grid.js`.
  const middle = () => (rng.chance(0.5) ? 2 : 3);

  const arterialX = new Set([middle()]);   // runs east-west
  const arterialZ = new Set([middle()]);   // runs north-south
  const dirX = new Map([...arterialX].map((j) => [j, rng.chance(0.5) ? 1 : -1]));
  const dirZ = new Map([...arterialZ].map((i) => [i, rng.chance(0.5) ? 1 : -1]));

  setArterialLines({ x: arterialX, z: arterialZ });
  configureSignals({ arterialX, arterialZ, dirX, dirZ });

  // --- The river, second ------------------------------------------------------
  //
  // After the arterials, because the channel's width is the gap between the two roads either side
  // of it and one of those may be a main street (`riverBanks` reads `halfRoadX`). Before everything
  // below, for two reasons that both bite: the crossings with no bridge are **closed segments**, so
  // they have to be in hand before `setClosedSegments` runs, and a park district must not be able
  // to claim a row that is water or to close a crossing on top of one already closed.
  //
  // See city/river.js for which crossings bridge and why the two ring roads always do.
  const river = planRiver(rng);
  setRiverRow(river.row);
  setRiverCrossings(river.crossings);

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
      const bi = rng.int(0, horizontal ? GRID_I - 2 : GRID_I - 1);
      const bj = rng.int(0, horizontal ? GRID_J - 1 : GRID_J - 2);
      const a = [bi, bj];
      const b = horizontal ? [bi + 1, bj] : [bi, bj + 1];
      if (parkCells.has(`${a[0]},${a[1]}`) || parkCells.has(`${b[0]},${b[1]}`)) continue;
      // Not on the water, and not straddling it. A district lays one platform across both its
      // blocks and the road between them, so a vertical pair spanning the bank would pave over the
      // river; and closing the road between them would close a crossing that may be a bridge.
      if (isRiverBlock(a[0], a[1]) || isRiverBlock(b[0], b[1])) continue;

      const id = districts.length;
      parkCells.set(`${a[0]},${a[1]}`, id);
      parkCells.set(`${b[0]},${b[1]}`, id);

      // The road between the pair, named by the two intersections at its ends.
      closed.push(horizontal
        ? segmentKey(bi + 1, bj, bi + 1, bj + 1)
        : segmentKey(bi, bj + 1, bi + 1, bj + 1));

      const ba = blockBounds(a[0], a[1]);
      const bb = blockBounds(b[0], b[1]);
      districts.push({
        id,
        bounds: {
          x0: Math.min(ba.x0, bb.x0), x1: Math.max(ba.x1, bb.x1),
          z0: Math.min(ba.z0, bb.z0), z1: Math.max(ba.z1, bb.z1),
          cx: (Math.min(ba.x0, bb.x0) + Math.max(ba.x1, bb.x1)) / 2,
          cz: (Math.min(ba.z0, bb.z0) + Math.max(ba.z1, bb.z1)) / 2,
        },
      });
      break;
    }
  }

  // The river's bridgeless crossings join the districts' closures: from here down nothing knows
  // the difference between a road a park built over and a road with a river across it.
  setClosedSegments([...closed, ...river.closed]);

  // Normalised by the map's own half-diagonal, which stopped being `HALF_SPAN * SQRT2` when the
  // two axes came apart. Taken per axis rather than off the longer one: centrality is "how far in
  // from the edge is this", and the edge is nearer on the short axis.
  const offCentre = (bi, bj) => {
    const { cx, cz } = blockBounds(bi, bj);
    return Math.hypot(cx / HALF_SPAN_X, cz / HALF_SPAN_Z) / Math.SQRT2;
  };

  // **The core is where the nearest block is, not where the origin is.** With an even number of
  // rows the map's centre falls *between* two of them, so no block can stand on it: at six rows
  // the most central block is half a row out and a raw distance tops out at 0.82 rather than 1,
  // which quietly takes two units off the tallest tower in the city and with it the helipad the
  // helicopter lands on. Measuring from the nearest a block can actually get keeps "1 at the core"
  // true of whatever grid this is handed — and on an odd grid, where a block does sit on the
  // origin, `floor` is 0 and this is exactly the arithmetic it always was.
  let floorDist = Infinity;
  for (let bi = 0; bi < GRID_I; bi++) {
    for (let bj = 0; bj < GRID_J; bj++) floorDist = Math.min(floorDist, offCentre(bi, bj));
  }

  const blocks = [];

  for (let bi = 0; bi < GRID_I; bi++) {
    for (let bj = 0; bj < GRID_J; bj++) {
      const distance = (offCentre(bi, bj) - floorDist) / (1 - floorDist);

      // 1 at the core, ~0 at the corners.
      const centrality = Math.max(0, 1 - distance * 1.55);

      // A district claim wins; otherwise the occasional lone pocket park out in the suburbs.
      const districtId = parkCells.get(`${bi},${bj}`);
      const inDistrict = districtId !== undefined;
      const isPark = inDistrict || rng.chance(0.02 + (1 - centrality) * 0.03);
      // ...and the river row is neither. Typed rather than filtered out of the array, so that every
      // generator downstream skips it by the rule it already has — `createBuildings` walks `'built'`
      // blocks, `createProps` walks `'park'` ones, and neither needs to learn about water.
      //
      // The park roll still happens on a river block, and is thrown away. That is deliberate: it
      // keeps this loop's draw from the rng stream the same shape for every seed regardless of
      // which row the river landed on, so moving the river does not reshuffle the whole city.
      const water = isRiverBlock(bi, bj);

      blocks.push({
        bi,
        bj,
        bounds: blockBounds(bi, bj),
        type: water ? 'river' : isPark ? 'park' : 'built',
        districtId: water || !inDistrict ? null : districtId,
        districtBounds: water || !inDistrict ? null : districts[districtId].bounds,
        centrality,
      });
    }
  }

  // Install the green blocks the same way the closures above were installed. A park is a fact about
  // the ground that anything placing a marker on a kerb has to be able to ask about without holding
  // this array — see `isParkBlock`.
  setParkBlocks(blocks.filter((block) => block.type === 'park'));

  blocks.districts = districts;
  // Handed to the ground mesh so the arterials are actually visible: a main street the player
  // can't identify is just an invisible timing tweak. The coordinated directions ride along too —
  // `configureSignals` needs them, and so does the road network's signal bake, which derives each
  // junction's offset from how far along the wave it sits.
  blocks.arterials = { x: arterialX, z: arterialZ, dirX, dirZ };
  blocks.closedSegments = closed;
  blocks.river = river;

  // The taxi's depot, and the block it takes out of the tower generator's hands. Chosen **last**,
  // after every other draw in this function, so adding it cannot reshuffle a single park or
  // arterial — the generators downstream all run their own offset stream (see architecture.md), so
  // a draw here is genuinely free.
  //
  // A whole block rather than a lot: the depot needs a forecourt to pull out of, and reserving a
  // footprint inside a block that `splitLot` is about to divide leaves the building generator a
  // sliver it will happily put a tower on. `null` is a real answer — a city with nowhere to put
  // one opens without the vignette rather than not opening. See city/garage.js.
  const garage = chooseGarageBlock(rng, blocks);
  if (garage) garage.type = 'garage';
  blocks.garageBlock = garage ?? null;

  // ...and the burger joint, drawn after it and for the same three reasons: it needs a whole block
  // rather than a lot inside one, `null` is a real answer, and drawing it last means adding it
  // cannot reshuffle a park, an arterial, a tower or the depot. It reads the depot's block as
  // already spoken for, since the line above has set its `type` — which is also why the order of
  // these two is not free. See city/burgerjoint.js.
  const burger = chooseBurgerBlock(rng, blocks);
  if (burger) burger.type = 'burger';
  blocks.burgerBlock = burger ?? null;

  // Bake the road network for the city just decided, and install it as *the* network. Everything
  // above — the closures, the arterials, their coordinated directions — is exactly the input it
  // needs, so this is the one place in the codebase that has it all in hand. Callers get the
  // network by asking `cityNetwork()` rather than by being handed one.
  setCityNetwork(roadNetFromGrid(blocks));

  return blocks;
}
