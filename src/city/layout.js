import { GRID, blockBounds, HALF_SPAN, segmentKey, setClosedSegments } from './grid.js';
import { roadNetFromGrid, setCityNetwork } from './roadnet.js';
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

  const blocks = [];

  for (let bi = 0; bi < GRID; bi++) {
    for (let bj = 0; bj < GRID; bj++) {
      const { cx, cz } = blockBounds(bi, bj);
      const distance = Math.hypot(cx, cz) / (HALF_SPAN * Math.SQRT2);

      // 1 at the core, ~0 at the corners.
      const centrality = Math.max(0, 1 - distance * 1.55);

      // A district claim wins; otherwise the occasional lone pocket park out in the suburbs.
      const districtId = parkCells.get(`${bi},${bj}`);
      const inDistrict = districtId !== undefined;
      const isPark = inDistrict || rng.chance(0.02 + (1 - centrality) * 0.03);

      blocks.push({
        bi,
        bj,
        bounds: blockBounds(bi, bj),
        type: isPark ? 'park' : 'built',
        districtId: inDistrict ? districtId : null,
        districtBounds: inDistrict ? districts[districtId].bounds : null,
        centrality,
      });
    }
  }

  // --- Landmarks -------------------------------------------------------------
  // A handful of built blocks are promoted to landmark plots, each with a distinct silhouette
  // (see buildings.js). This is deliberately part of the *city* seed rather than the run seed:
  // the whole point of a landmark is to be a stable reference point players can navigate by
  // — "turn left at the dome" only works if the dome is always in the same place for that map.
  const LANDMARK_KINDS = ['clocktower', 'dome', 'cathedral', 'radio', 'roundtower'];
  const chosen = [];
  const candidates = blocks.filter((b) => b.type === 'built');
  // Fisher-Yates over the candidates so landmark placement doesn't privilege low-index blocks.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  // Manhattan spacing of ≥2 blocks: no two landmarks in neighbouring plots, so they stand out
  // against ordinary buildings rather than piling up in one corner.
  for (const candidate of candidates) {
    if (chosen.length >= LANDMARK_KINDS.length) break;
    const tooClose = chosen.some((other) =>
      Math.abs(other.bi - candidate.bi) + Math.abs(other.bj - candidate.bj) < 2,
    );
    if (!tooClose) chosen.push(candidate);
  }
  const kinds = [...LANDMARK_KINDS];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  chosen.forEach((block, idx) => {
    block.type = 'landmark';
    block.landmarkKind = kinds[idx];
  });

  blocks.districts = districts;
  // Handed to the ground mesh so the arterials are actually visible: a main street the player
  // can't identify is just an invisible timing tweak. The coordinated directions ride along too —
  // `configureSignals` needs them, and so does the road network's signal bake, which derives each
  // junction's offset from how far along the wave it sits.
  blocks.arterials = { x: arterialX, z: arterialZ, dirX, dirZ };
  blocks.closedSegments = closed;

  // Bake the road network for the city just decided, and install it as *the* network. Everything
  // above — the closures, the arterials, their coordinated directions — is exactly the input it
  // needs, so this is the one place in the codebase that has it all in hand. Callers get the
  // network by asking `cityNetwork()` rather than by being handed one.
  setCityNetwork(roadNetFromGrid(blocks));

  return blocks;
}
