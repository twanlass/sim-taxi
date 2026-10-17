import {
  GRID_I, GRID_J, blockBounds, HALF_SPAN_X, HALF_SPAN_Z, isRiverBlock, segmentKey,
  setArterialLines, setClosedSegments, setParkBlocks, setRiverRow, BIG_CITY, setParkwayMid,
} from './grid.js';
import { planCentralPark } from './centralpark.js';
import { planRiver, setRiverCrossings } from './river.js';
import { roadNetFromGrid, setCityNetwork } from './roadnet.js';
import { chooseGarageBlock } from './garage.js';
import { chooseBurgerBlock } from './burgerjoint.js';
import { chooseGraveyardBlock, planGraveyardPair, GRAVEYARD_MODE } from './graveyard.js';
import { chooseCarWashBlock, CAR_WASH_ON } from './carwash.js';
import { clearPlantedCrowns } from './props.js';
import { configureSignals } from '../sim/traffic.js';

// Decides what each block *is* before anything is built. Ground, buildings and props all read
// this, so a park is a park in every system rather than three subsystems each rolling their own
// dice and disagreeing.

/**
 * Density falls off from the centre, which is what gives a generated city a downtown instead of
 * a uniform mat of identical towers. Parks are more likely out in the cheaper suburbs.
 */
export function createLayout(rng) {
  // A new layout is a new city, so the last one's trees are no longer anybody's (`plantedCrowns`).
  clearPlantedCrowns();

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

  // `?city=big` lays a 2 × 2 central park with a curving road through it first, then the usual two
  // districts round it — see city/centralpark.js. Its lawns are too narrow for the skatepark, so
  // the districts are where that still goes.
  const centralPark = BIG_CITY ? planCentralPark(rng, { arterialX, arterialZ }) : null;
  const centralCells = new Set(centralPark ? centralPark.cells.map(([bi, bj]) => `${bi},${bj}`) : []);
  if (centralPark) closed.push(...centralPark.closed);
  setParkwayMid(centralPark ? centralPark.C : null);
  const DISTRICT_COUNT = 2;

  for (let n = 0; n < DISTRICT_COUNT; n++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const horizontal = rng.chance(0.5);
      const bi = rng.int(0, horizontal ? GRID_I - 2 : GRID_I - 1);
      const bj = rng.int(0, horizontal ? GRID_J - 1 : GRID_J - 2);
      const a = [bi, bj];
      const b = horizontal ? [bi + 1, bj] : [bi, bj + 1];
      if (parkCells.has(`${a[0]},${a[1]}`) || parkCells.has(`${b[0]},${b[1]}`)) continue;
      if (centralCells.has(`${a[0]},${a[1]}`) || centralCells.has(`${b[0]},${b[1]}`)) continue;
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
  const centralityOf = (bi, bj) => {
    const distance = (offCentre(bi, bj) - floorDist) / (1 - floorDist);
    // 1 at the core, ~0 at the corners.
    return Math.max(0, 1 - distance * 1.55);
  };

  // **The graveyard, as a double block** — two blocks and the road between them, the way a park
  // district is, so the road has to be closed here with the districts' rather than at the end with
  // the depot's. Planned without a draw (see `planGraveyardPair`), so nothing above or below moves
  // but the blocks it takes and the road it closes. `?graveyard=single` plans nothing here and takes
  // one block at the end instead.
  const gravePair = GRAVEYARD_MODE === 'double' ? planGraveyardPair({
    taken: (bi, bj) => parkCells.has(`${bi},${bj}`) || centralCells.has(`${bi},${bj}`),
    isWater: isRiverBlock,
    arterialZ,
    centrality: centralityOf,
    districts,
  }) : null;
  const graveCells = new Set(gravePair ? gravePair.cells.map(([bi, bj]) => `${bi},${bj}`) : []);
  if (gravePair) closed.push(gravePair.closed);

  // The river's bridgeless crossings join the districts' closures: from here down nothing knows
  // the difference between a road a park built over and a road with a river across it.
  setClosedSegments([...closed, ...river.closed]);

  const blocks = [];

  for (let bi = 0; bi < GRID_I; bi++) {
    for (let bj = 0; bj < GRID_J; bj++) {
      const centrality = centralityOf(bi, bj);

      // A district claim wins; otherwise the occasional lone pocket park out in the suburbs.
      const central = centralCells.has(`${bi},${bj}`);
      const districtId = central ? 'central' : parkCells.get(`${bi},${bj}`);
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
        // The graveyard's two blocks still roll for a park above, and throw it away — the river's
        // reason: the draw stays the same shape for every seed wherever the graveyard landed.
        type: water ? 'river' : graveCells.has(`${bi},${bj}`) ? 'graveyard' : isPark ? 'park' : 'built',
        districtId: water || !inDistrict ? null : districtId,
        districtBounds: water || !inDistrict ? null
          : central ? centralPark.bounds : districts[districtId].bounds,
        centrality,
      });
    }
  }

  // **One more pocket park, always.** The two districts now carry the statue, the pond, the
  // basketball court and the skatepark between them, and the lone pocket park above is a 2–5% roll
  // that most cities never win — so the city's open lawn had all been built on. This hands one
  // built block back to the grass: off downtown (a park in the middle of the towers punches a hole
  // in the skyline rather than adding green), and not touching another park on any side or corner,
  // so it reads as a separate green rather than as a district's ragged edge.
  //
  // **Without a draw.** Every generator downstream reads this stream after here, so a draw would
  // move the depot and the burger joint on every seed. Which candidate wins is hashed off the
  // districts' positions instead — already a fact about this city, and different from one city to
  // the next.
  const isGreen = (bi, bj) => blocks.some((b) => b.bi === bi && b.bj === bj && b.type === 'park');
  const spare = blocks.filter((b) => b.type === 'built' && b.centrality < 0.6
    && ![-1, 0, 1].some((di) => [-1, 0, 1].some((dj) => isGreen(b.bi + di, b.bj + dj))));
  if (spare.length) {
    const key = districts.reduce((sum, d, k) => sum + (k + 1) * (d.bounds.cx * 12.9898 + d.bounds.cz * 78.233), 0);
    const frac = Math.abs(Math.sin(key) * 43758.5453) % 1;
    spare[Math.min(spare.length - 1, Math.floor(frac * spare.length))].type = 'park';
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
  blocks.centralPark = centralPark;
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

  // ...and the graveyard, after both and for the same reasons: a whole block, `null` a real answer,
  // and drawn last so that adding it moves nothing above. It reads the depot's and the joint's
  // blocks as spoken for so the three landmarks don't clump. `?graveyard=classic` skips the draw
  // and leaves the block to the towers. See city/graveyard.js.
  // In double mode the pair was planned above; this is the `?graveyard=single` path.
  if (GRAVEYARD_MODE === 'single') {
    const single = chooseGraveyardBlock(rng, blocks);
    if (single) single.type = 'graveyard';
    blocks.graveyardBlock = single ?? null;
  } else if (gravePair) {
    // One record for the whole lot, shaped like a block so `createGraveyard` takes either: the
    // first block's indices, and bounds spanning both blocks and the road between them.
    const [a, b] = gravePair.cells.map(([bi, bj]) => blocks.find((k) => k.bi === bi && k.bj === bj));
    const x0 = Math.min(a.bounds.x0, b.bounds.x0);
    const x1 = Math.max(a.bounds.x1, b.bounds.x1);
    const z0 = Math.min(a.bounds.z0, b.bounds.z0);
    const z1 = Math.max(a.bounds.z1, b.bounds.z1);
    blocks.graveyardBlock = {
      bi: a.bi, bj: a.bj, type: 'graveyard', double: true, blocks: [a, b],
      centrality: Math.max(a.centrality, b.centrality),
      bounds: { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 },
    };
  } else {
    blocks.graveyardBlock = null;
  }

  // ...and the car wash, last of all and for the same reasons: a whole block, `null` a real answer,
  // and drawn after everything above so adding it moves no park, landmark or arterial. It reads the
  // other landmarks' blocks as spoken for. `?carwash=classic` skips the draw. See city/carwash.js.
  const carWash = CAR_WASH_ON ? chooseCarWashBlock(rng, blocks) : null;
  if (carWash) carWash.type = 'carwash';
  blocks.carWashBlock = carWash ?? null;

  // Bake the road network for the city just decided, and install it as *the* network. Everything
  // above — the closures, the arterials, their coordinated directions — is exactly the input it
  // needs, so this is the one place in the codebase that has it all in hand. Callers get the
  // network by asking `cityNetwork()` rather than by being handed one.
  setCityNetwork(roadNetFromGrid(blocks));

  return blocks;
}
