import { GRID, rightOf, leftOf } from '../city/grid.js';
import { cityNetwork, gridNodeId } from '../city/roadnet.js';

/**
 * Routing over the road network.
 *
 * The graph node is a **lane** — a directed half of one road — which is the same thing the old
 * `(i, j, d)` state was: "approaching this junction, travelling this way". It has to carry the
 * arrival, because the legal moves out of a junction depend on how you got there (no U-turns).
 * Treating the junction alone as the node would happily plan routes that flip direction on the
 * spot, and the car would never be able to execute them.
 *
 * What changes by moving off `(i, j, d)` is that the successors now come from `lane.exits` — the
 * turns baked into the network — instead of from direction arithmetic. A three-way junction, a
 * diagonal or a roundabout has legal moves that `(d + 1) % 4` cannot name; a lane's exits are
 * whatever the geometry says they are. At 5x5 that's 120 lanes against the old 144 states — small
 * enough that a plain rescan-the-open-set Dijkstra still beats any structured heap.
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
};

/**
 * Cost of driving one lane. Reads the class off the lane rather than recomputing it from `(i, j,
 * d)`: the network already worked out what kind of road this is and which way its green wave
 * runs, and an editor-drawn arterial has no line index to look either up by.
 */
export function laneCost(lane) {
  if (lane.klass === 'ring') return EDGE_COST.ring;
  if (lane.klass === 'arterial') {
    return lane.withWave ? EDGE_COST.arterialWith : EDGE_COST.arterialAgainst;
  }
  return EDGE_COST.side;
}

/** The search's one non-lane state: "arrived at the origin junction, about to choose". */
const START = Symbol('start');

/**
 * Lanes the car can take out of the junction it is currently heading toward.
 *
 * Every later step is just `lane.onward`, which the network baked in straight/right/left order —
 * see `HAND_ORDER` in roadnet.js for why that order is load-bearing rather than cosmetic. The
 * first step is the only one that needs help, because the car may not be on a lane at all:
 * `tools/probe.mjs` asks about every `(i, j, d)`, including arrivals from off the map. There is
 * nothing to exclude in that case — a U-turn would leave along the very road the car did not come
 * in on, and that road's absence is what made the arrival virtual in the first place.
 */
function startExits(net, origin, inDir) {
  const inLane = net.laneByGrid(inDir, origin.gi, origin.gj);
  if (inLane) return inLane.onward;

  const straight = inDir;
  const right = rightOf(inDir);
  const left = leftOf(inDir);
  const rank = (lane) => {
    const d = net.dirOfLane(lane);
    return d === straight ? 0 : d === right ? 1 : d === left ? 2 : 3;
  };
  return origin.outbound
    .filter((lane) => !lane.degenerate && rank(lane) < 3)
    .sort((p, q) => rank(p) - rank(q));
}

/**
 * @param from  {{i, j, d}} the intersection the car is heading toward, and its current heading
 * @param target {{i, j}}   intersection to reach
 * @param cost   optional (lane) -> number, overriding the built-in road-hierarchy weights.
 *               Only tools/router-sweep.mjs uses this, to compare tunings.
 * @returns array of directions to take at each successive intersection, or null if unreachable.
 *          An empty array means the car is already heading to the target.
 */
export function findRoute(from, target, cost = laneCost) {
  if (from.i === target.i && from.j === target.j) return [];

  const net = cityNetwork();
  const origin = net.nodeByGrid(from.i, from.j);
  const targetId = gridNodeId(target.i, target.j);
  if (!origin || !net.nodeById.has(targetId)) return null;

  // The search starts *at* the origin junction rather than on a lane, so a car arriving from
  // off-map — a state the probe asks about and the game never reaches — still has somewhere to
  // plan from. START is that arrival; every other state is a lane.
  const dist = new Map([[START, 0]]);
  const prev = new Map([[START, null]]);
  const open = new Set([START]);

  while (open.size) {
    let cur = null;
    let curDist = Infinity;
    for (const state of open) {
      const d = dist.get(state);
      if (d < curDist) { curDist = d; cur = state; }
    }
    open.delete(cur);

    if (cur !== START && cur.to === targetId) {
      const out = [];
      for (let lane = cur; lane !== START; lane = prev.get(lane)) out.unshift(net.dirOfLane(lane));
      return out;
    }

    for (const next of cur === START ? startExits(net, origin, from.d) : cur.onward) {
      const nd = curDist + cost(next);
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, cur);
        open.add(next);
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
    // The lane the turn is landing on runs *out* of (i, j); its far end is the junction the car
    // will next have a choice at, which is where planning has to resume.
    const net = cityNetwork();
    const lane = net.laneOutByGrid(car.dOut, car.i, car.j);
    if (lane) {
      const landing = net.nodeById.get(lane.to);
      return { i: landing.gi, j: landing.gj, d: car.dOut };
    }
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
