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
 * Weights encode the road hierarchy. A fewest-blocks router (unit weights) fights it: the ring and
 * the arterials are the roads without traffic lights on them, so a route that ignores them spends
 * its time at reds it never had to meet. Slightly preferring them produces routes with less time
 * stopped and — because the weights sit close to 1.0 — no meaningful detouring. Measured across
 * 240 fares vs unit-weight BFS: trip time -3.9%, time-stopped -13.7%, average path length
 * essentially unchanged (see tools/router-sweep.mjs).
 *
 * The weights are ratios of expected trip-time-per-block, not raw seconds. Keeping side street
 * at 1.0 and only nudging the preferred classes below it means the router is a tie-breaker on
 * paths of equal length, not a detour finder — the difference between two 5-block routes, not
 * "add two blocks to hit the arterial." Aggressive weights (ring 0.55, arterial 0.70) were
 * tried; they dropped stopped-time further but added length that ate the win.
 */
const EDGE_COST = {
  ring: 0.90,
  // The same road driven two ways. With the arterials unsignalised there are no offsets left to
  // run with or against, so this split is a preference rather than a timing claim — the coordinated
  // direction is simply the one the road was drawn for. Collapsing it buys nothing: over 150 trips
  // x 6 seeds (tools/router-sweep.mjs), 14.36s a trip as shipped against 14.43s for a symmetric
  // 0.95 and 14.84s for 0.90 both ways, all inside the spread.
  arterialWith: 0.95,
  arterialAgainst: 1.00,
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
 * Null covers three different refusals and the caller wants the same thing for all of them —
 * keep the route it already had:
 *
 *   - either leg is unreachable (a waypoint inside a park district has no junction),
 *   - the detour blows `maxDetour`,
 *   - the direct route itself is unroutable, which a shipped city never is.
 */
export function findRouteVia(from, via, target, { maxDetour = MAX_VIA_DETOUR } = {}) {
  const direct = findRoute(from, target);
  if (direct === null) return null;

  const toVia = findRoute(from, via);
  if (toVia === null) return null;
  // An empty first leg means the car is already heading at the waypoint, so the heading it will
  // arrive on is the one it has now.
  const atVia = { i: via.i, j: via.j, d: toVia.length ? toVia[toVia.length - 1] : from.d };

  const onward = findRoute(atVia, target);
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
// flat number for everybody. These three constants are that conversion.
//
// The floor is arithmetic: a block is PITCH = 20 units and cruise is SPEED = 8.5 u/s, so a block
// at full speed is 2.353s. Nothing drives a whole trip at full speed — signals, cornering and
// queueing behind ambient traffic all take their cut — so all three are *fitted* against
// measured trips by `tools/eta.mjs` rather than derived. Re-run it after any change to the signal
// model, the router weights or the car physics; a stale estimator makes every fare clock wrong in
// the same direction, which reads as the game being unfair rather than as a broken constant.
//
// A turn is charged separately because it is the part that doesn't scale with distance: a corner
// is taken at CORNER_SPEED (5.95, 70% of cruise) and its Bezier is longer than the 8-unit straight
// through the junction — a left is 15.4 against a straight's 11.4.
//
// **A light is charged separately too, and that one is new.** It was not needed while every
// interior junction had a signal: "lights crossed" was then just "blocks, give or take one", so a
// per-block charge already carried the waiting and a third term would have been collinear noise.
// De-signalising the arterials broke that. Two four-block routes across the same city can now
// cross four lights or none, and a model that cannot see the difference has to split them —
// charging the arterial route for waits it never does and the side-street route for fewer than it
// does. That does not show up as a worse average; it shows up in the *tail*, which is exactly
// where a fare clock is felt. Measured with `node tools/difficulty-sweep.mjs 21 shipped`, p10
// fares survived at 1.5s/3s/4s reaction: 2/9/7 before the arterials changed, 1/1/0 on a two-term
// refit — under the tuning's own p10 target of 3 at every reaction — and 5/6/7 with this term in.
// Medians barely moved across all three (12/14/12, 12/13/11, 13/13/12), which is the tell: this is
// a tail fix, and a median is exactly what cannot see it.
//
// Fitted by least squares over 582 trips across 6 cities (`node tools/eta.mjs 100 6`): mean trip
// 4.19 blocks, 1.92 turns, 1.47 lights, 14.6s. Against that data the three below score MAE 2.96s
// and bias -0.02s — near enough unbiased, which is the property that matters, because a biased
// estimator tilts every clock in the game the same way.
//
// **The 2.96s is not estimator slop, it is the city.** The same route driven twice differs by
// about that much depending on which signal phase the taxi meets and what it queues behind;
// worst observed miss was 16.6s on a 38.9s trip. No function of (blocks, turns, lights) can do
// better than that variance, which is precisely why the deadline is `budget * slack(d)` and not
// `budget`: slack is what pays for the traffic you happen to get, and shrinking it is what makes
// the game harder.
//
// The whole set moved when the arterials lost their lights. On the same sample shape:
//
//   3.28 / 1.30 / —        MAE 4.35s   before, when every junction had a signal
//   3.03 / 0.93 / —        MAE 3.32s   same two terms, refitted to the faster city
//   2.41 / 0.64 / 2.25     MAE 2.96s   <- shipped
//
// The mean trip went 16.4s → 14.6s, which is the point of that change; the part worth writing down
// is that the *error* fell with it. A signal is where a trip time picks up its variance — which
// phase you meet is luck no estimator can see — so taking lights off the main roads makes the city
// not just quicker but more predictable.
export const SEC_PER_BLOCK = 2.41;
export const SEC_PER_TURN = 0.64;
export const SEC_PER_LIGHT = 2.25;

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

/**
 * How many junctions along the route carry a light.
 *
 * The origin junction and every one after it up to — but not including — the destination, which
 * is exactly the set the car has to get *through*. Read off the network rather than counted as
 * "blocks minus one", because that is the whole point: since the arterials lost their signals the
 * two are no longer the same number, and which roads a route uses is now most of what decides how
 * long it takes.
 */
export function countLights(route, from) {
  const net = cityNetwork();
  let node = net.nodeByGrid(from.i, from.j);
  let lights = 0;
  for (const d of route) {
    if (!node) break;
    if (node.signal) lights += 1;
    const lane = net.laneOutByGrid(d, node.gi, node.gj);
    if (!lane) break;
    node = net.nodeById.get(lane.to);
  }
  return lights;
}

/** Estimated seconds to drive `route`, having arrived at `from` — `{i, j, d}`. */
export const estimateSeconds = (route, from) =>
  route.length * SEC_PER_BLOCK
  + countTurns(route, from.d) * SEC_PER_TURN
  + countLights(route, from) * SEC_PER_LIGHT;

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
    total += estimateSeconds(route, at);
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
