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
  roadwork: 0.45,             // see below — measured, and not purely a claim about driving time
};

/**
 * Lanes closed for roadworks, published by game/roadwork.js when it stands a zone up.
 *
 * The taxi's router is the *only* thing here that wants them cheap. Ambient traffic gets the same
 * ids through `setClosedLanes` in sim/traffic.js, which zeroes the weight of any turn that would
 * enter them — cars route around, the taxi routes through, and the asymmetry is the vignette.
 *
 * Pushed rather than imported so route.js keeps knowing nothing about sim/ or game/.
 */
let roadworkLanes = new Set();
export function setRoadworkLanes(ids) {
  roadworkLanes = new Set(ids);
}

/**
 * Cost of driving one lane. Reads the class off the lane rather than recomputing it from `(i, j,
 * d)`: the network already worked out what kind of road this is and which way its green wave
 * runs, and an editor-drawn arterial has no line index to look either up by.
 */
export function laneCost(lane) {
  // Checked before the class, because a closed street is a side street and would otherwise take the
  // 1.00 below.
  //
  // Unlike every other weight here this one is not purely a claim about trip time. An emptied road
  // genuinely is quicker — no queue, nothing to follow — so *a* discount is honest, but 0.45 is
  // larger than the time saved and is chosen to make the taxi actually meet the thing the vignette
  // built. The scale is what the rest of this comment block warns about: at ~1.0 a block, a weight
  // of `w` only wins a detour worth less than `1 - w` blocks, so anything near 0.9 is a pure
  // tie-break and the player would meet a zone by luck. 0.45 buys roughly half a block of detour.
  //
  // Fitted, not picked. Over 24 runs of 240s with the zone on its own schedule and one drop-off
  // aimed at it (tools/roadwork-pull.mjs), the share of runs where the taxi drove a closed lane:
  //
  //     weight    1.00   0.62   0.45   0.20
  //     entered    50%    88%    96%    96%
  //
  // 0.45 is the knee — 0.20 buys nothing more and only risks dragging unrelated trips. The detour it
  // costs is nil: mean planned route goes 4.23 → 4.17 legs, i.e. slightly *down*, because a cheap
  // lane shortens as many routes as it bends. Without the aimed drop-off the same weights give
  // 33% / 67% / 67% / 67%, which is the measurement that says the two mechanisms are both needed:
  // this discount cannot pull a route that was never heading that way.
  if (roadworkLanes.has(lane.id)) return EDGE_COST.roadwork;
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
 * Dijkstra from `from` until `reached(lane)` says the search has arrived, as a list of directions.
 *
 * Split out of `findRoute` for `findRouteOnto` below: the two searches differ in nothing but that
 * predicate — one stops at a *junction*, the other on a particular lane into it — and a second copy
 * of the open-set loop would be a second place for the road hierarchy's weights to drift.
 */
function search(net, from, reached, cost) {
  const origin = net.nodeByGrid(from.i, from.j);
  if (!origin) return null;

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

    if (cur !== START && reached(cur)) {
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
  const targetId = gridNodeId(target.i, target.j);
  if (!net.nodeById.has(targetId)) return null;

  return search(net, from, (lane) => lane.to === targetId, cost);
}

/**
 * The route that arrives at (i, j) **travelling `d`** — a route to a *lane* rather than to a
 * junction.
 *
 * Every other router in this file answers "get me to that corner", which is the right question for
 * a rider standing on one. It is the wrong question for anything that can only be reached from one
 * side: the drive-through's mouth opens off one kerbside lane (game/burgerrun.js), and a route that
 * arrives at the same junction down any of the other three drives straight past it.
 *
 * `findRouteVia` through the junction the lane leaves is the version that looks like it works and
 * does not, which is worth writing down because it is the obvious first try. Its second leg is
 * planned from the heading the first leg arrives on, and `legalExits` forbids U-turns — so a car
 * that reaches that junction travelling *along* the target lane's road in the other direction
 * cannot take the lane, and the router quietly answers with a three-leg lap that arrives at the
 * right corner from the wrong side. Measured on the burger run: about one trip in five, and the
 * failure is invisible from the outside because the taxi does exactly what a taxi does, just not the
 * thing that was asked for.
 *
 * **No empty route.** A car already on this lane still gets a way back onto it — the shortest one,
 * which is a lap of the block — because "I am already on it" and "the thing I wanted on it is
 * behind me" are the same state from here and only the caller can tell them apart.
 */
export function findRouteOnto(from, target, d, cost = laneCost) {
  const net = cityNetwork();
  const goal = net.laneByGrid(d, target.i, target.j);
  if (!goal) return null;

  return search(net, from, (lane) => lane === goal, cost);
}

// --- Routing through a waypoint ---------------------------------------------
//
// How much longer than the direct route a hand-drawn detour may be, in legs. The player drags the
// route band sideways (game/pathdrag.js) and the junction under their finger becomes a waypoint;
// this is what stops a sloppy drag — or a finger that lands behind the taxi — from answering with
// a lap of the city instead of the one-block dodge that was meant.
//
// Six because the honest unit here is "blocks of extra driving", and the gesture's whole vocabulary
// is one or two of them: pulling a straight run one block sideways costs 2 legs (out and back), a
// two-block bulge costs 4, and past that the drag has stopped describing a detour and started
// describing a different trip — which is what tapping a different fare is for. It is a *cap*, not
// a preference: anything under it is taken exactly as drawn.
export const MAX_VIA_DETOUR = 6;

/**
 * The route from `from` to `target` that passes through `via`, or null.
 *
 * Two Dijkstra runs stitched at the waypoint, exactly as `chainSeconds` bills a multi-leg trip:
 * the heading is carried across the join rather than guessed, because `legalExits` forbids
 * U-turns and the second leg planned from the wrong heading is a route the car cannot drive.
 *
 * `onto` makes the destination a lane rather than a junction, for both legs of the comparison — see
 * `findRouteOnto`. It is what lets the route band be dragged during a burger run: without it a
 * dragged waypoint re-plans to the mouth's junction and quietly drops the one thing that made the
 * route a drive-through visit rather than a drive past one.
 *
 * Null covers three different refusals and the caller wants the same thing for all of them —
 * keep the route it already had:
 *
 *   - either leg is unreachable (a waypoint inside a park district has no junction),
 *   - the detour blows `maxDetour`,
 *   - the direct route itself is unroutable, which a shipped city never is.
 */
export function findRouteVia(from, via, target, { maxDetour = MAX_VIA_DETOUR, onto = null } = {}) {
  const arrive = (at) => (onto !== null ? findRouteOnto(at, target, onto) : findRoute(at, target));

  const direct = arrive(from);
  if (direct === null) return null;

  const toVia = findRoute(from, via);
  if (toVia === null) return null;
  // An empty first leg means the car is already heading at the waypoint, so the heading it will
  // arrive on is the one it has now.
  const atVia = { i: via.i, j: via.j, d: toVia.length ? toVia[toVia.length - 1] : from.d };

  const onward = arrive(atVia);
  if (onward === null) return null;

  const route = [...toVia, ...onward];
  return route.length > direct.length + maxDetour ? null : route;
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

// --- How long a route takes ---------------------------------------------------
//
// The router costs a route in dimensionless weights; the fare system needs *seconds*, because a
// rider's deadline is now budgeted from the work their trip actually costs rather than being one
// flat number for everybody. These two constants are that conversion.
//
// The floor is arithmetic: a block is PITCH = 20 units and cruise is SPEED = 8.5 u/s, so a block
// at full speed is 2.353s. Nothing drives a whole trip at full speed — signals, cornering and
// queueing behind ambient traffic all take their cut — so both constants are *fitted* against
// measured trips by `tools/eta.mjs` rather than derived. Re-run it after any change to the signal
// model, the router weights or the car physics; a stale estimator makes every fare clock wrong in
// the same direction, which reads as the game being unfair rather than as a broken constant.
//
// A turn is charged separately because it is the part that doesn't scale with distance: a corner
// is taken at CORNER_SPEED (5.95, 70% of cruise) and its Bezier is longer than the 8-unit straight
// through the junction — a left is 15.4 against a straight's 11.4.
//
// Fitted by least squares over 581 trips across 6 cities (`node tools/eta.mjs 100 6`): mean trip
// 4.20 blocks, 1.92 turns, 16.4s. Against that data the pair below scores MAE 4.35s and bias
// -0.14s — near enough unbiased, which is the property that matters, because a biased estimator
// tilts every clock in the game the same way.
//
// **The 4.35s is not estimator slop, it is the city.** The same route driven twice differs by
// about that much depending on which signal phase the taxi meets and what it queues behind;
// worst observed miss was 26s on a 49.5s trip. No function of (blocks, turns) can do better than
// that variance, which is precisely why the deadline is `budget * slack(d)` and not `budget`:
// slack is what pays for the traffic you happen to get, and shrinking it is what makes the game
// harder.
export const SEC_PER_BLOCK = 3.28;
export const SEC_PER_TURN = 1.30;

/**
 * How many of a route's steps change direction — the turns, as opposed to going straight through.
 *
 * Counted against the heading the car arrives on, so a route whose very first step turns is
 * charged for it. This is the same distinction `car.state === 'turn'` famously does *not* make
 * (it covers going straight through a junction too); here only a real change of direction counts.
 */
export function countTurns(route, fromDir) {
  let turns = 0;
  let prev = fromDir;
  for (const d of route) {
    if (d !== prev) turns += 1;
    prev = d;
  }
  return turns;
}

/** Estimated seconds to drive `route`, having arrived on heading `fromDir`. */
export const estimateSeconds = (route, fromDir) =>
  route.length * SEC_PER_BLOCK + countTurns(route, fromDir) * SEC_PER_TURN;

/**
 * Estimated seconds to drive from `from` through every stop in order, or null if any leg is
 * unreachable.
 *
 * The heading is carried forward rather than guessed: the last step of one leg's route *is* the
 * direction the car arrives on, so the next leg plans from a real state. That matters because
 * `legalExits` forbids U-turns — planning the second leg from the wrong heading can cost or save a
 * whole block, and this function's whole job is to be the number a deadline is set from.
 *
 * A stop the car is already heading at returns an empty route, which costs nothing and leaves the
 * heading alone. That is correct: it is the same junction.
 */
export function chainSeconds(from, stops) {
  let at = from;
  let total = 0;
  for (const stop of stops) {
    const route = findRoute(at, stop);
    if (route === null) return null;
    total += estimateSeconds(route, at.d);
    at = { i: stop.i, j: stop.j, d: route.length ? route[route.length - 1] : at.d };
  }
  return total;
}

/** Every intersection on the grid, as {i, j}. */
export function allIntersections() {
  const out = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) out.push({ i, j });
  }
  return out;
}
