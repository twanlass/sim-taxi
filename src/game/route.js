import { legalExits, nextIntersection, GRID } from '../city/grid.js';
import { edgeClass } from '../sim/traffic.js';

/**
 * Routing over the road network.
 *
 * The graph node is *directed* — `(i, j, d)` means "approaching intersection (i, j) travelling
 * direction d". It has to be, because the legal moves out of an intersection depend on how you
 * arrived: `legalExits` forbids U-turns. Treating a plain (i, j) as the node would happily plan
 * routes that flip direction on the spot, and the car would never be able to execute them.
 *
 * At 5x5 that's 6*6*4 = 144 states — small enough that a plain rescan-the-open-set Dijkstra
 * beats any structured heap.
 *
 * Weights encode the road hierarchy. A fewest-blocks router (unit weights) fights the signal
 * coordination the city was tuned for: arterials run a green wave with a 64% share for their
 * axis, and the outermost roads are unsignalised. Slightly preferring those roads produces
 * routes with less time spent at reds and — because the weights sit close to 1.0 — no
 * meaningful detouring. Measured across 240 fares vs unit-weight BFS: trip time -3.9%,
 * time-stopped -13.7%, average path length essentially unchanged (see tools/router-sweep.mjs).
 *
 * The weights are ratios of expected trip-time-per-block, not raw seconds. Keeping side street
 * at 1.0 and only nudging the preferred classes below it means the router is a tie-breaker on
 * paths of equal length, not a detour finder — the difference between two 5-block routes, not
 * "add two blocks to hit the arterial." Aggressive weights (ring 0.55, arterial 0.70) were
 * tried; they dropped stopped-time further but added length that ate the win.
 */
const EDGE_COST = {
  ring: 0.90,
  arterialWith: 0.95,
  arterialAgainst: 1.00,      // 64% green helps, but reversed offsets cancel most of the wave
  side: 1.00,
  // The avenue, priced at what it actually is: one segment is √2 blocks long, so it costs √2.
  // That is what makes it worth taking without any thumb on the scale — three diagonal segments
  // cost 4.24 against the six side-street blocks (6.00) they replace, so the router picks it up
  // for exactly the reason a driver would, and ignores it when the trip doesn't run its way.
  // A discount on top was tried and pulled every route across the city onto one street.
  avenue: Math.SQRT2,
};

const key = (i, j, d) => `${i},${j},${d}`;

function edgeCost(i, j, d) {
  const edge = edgeClass(i, j, d);
  if (edge.kind === 'avenue') return EDGE_COST.avenue;
  if (edge.kind === 'ring') return EDGE_COST.ring;
  if (edge.kind === 'arterial') return edge.withWave ? EDGE_COST.arterialWith : EDGE_COST.arterialAgainst;
  return EDGE_COST.side;
}

/**
 * @param from  {{i, j, d}} the intersection the car is heading toward, and its current heading
 * @param target {{i, j}}   intersection to reach
 * @param cost   optional (i, j, d) -> number, overriding the built-in road-hierarchy weights.
 *               Only tools/router-sweep.mjs uses this, to compare tunings.
 * @returns array of directions to take at each successive intersection, or null if unreachable.
 *          An empty array means the car is already heading to the target.
 */
export function findRoute(from, target, cost = edgeCost) {
  if (from.i === target.i && from.j === target.j) return [];

  const start = key(from.i, from.j, from.d);
  const dist = new Map([[start, 0]]);
  const prev = new Map([[start, null]]);
  const open = new Set([start]);

  while (open.size) {
    let cur = null;
    let curDist = Infinity;
    for (const k of open) {
      const d = dist.get(k);
      if (d < curDist) { curDist = d; cur = k; }
    }
    open.delete(cur);

    const [ci, cj, cd] = cur.split(',').map(Number);
    if (ci === target.i && cj === target.j) {
      const out = [];
      for (let cursor = cur; prev.get(cursor); cursor = prev.get(cursor).from) {
        out.unshift(prev.get(cursor).dir);
      }
      return out;
    }

    for (const dOut of legalExits(cd, ci, cj)) {
      const next = nextIntersection(dOut, ci, cj);
      if (!next) continue;
      const nk = key(next.i, next.j, dOut);
      const nd = curDist + cost(ci, cj, dOut);
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { from: cur, dir: dOut });
        open.add(nk);
      }
    }
  }

  return null;
}

/**
 * Where planning must start from for a given car.
 *
 * A car in the middle of a turn has *already* committed its choice at (i, j), so planning from
 * that intersection produces a route whose first step is silently skipped — every subsequent turn
 * then lands one intersection early. Plan from where the turn is about to deposit it instead.
 */
export function planOrigin(car) {
  if (car.state === 'turn') {
    const next = nextIntersection(car.dOut, car.i, car.j);
    if (next) return { i: next.i, j: next.j, d: car.dOut };
  }
  return { i: car.i, j: car.j, d: car.d };
}

/** Every intersection on the grid, as {i, j}. */
export function allIntersections() {
  const out = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) out.push({ i, j });
  }
  return out;
}
