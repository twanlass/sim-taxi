import { DIR } from '../city/grid.js';
import { stopDistance } from '../sim/traffic.js';
import { findRouteOnto, planOrigin } from './route.js';

// The player's trip back to the depot for repairs: the tap that starts it, the route that gets the
// taxi to the driveway, and catching it there.
//
// The visit itself is not here. From the lane onward it is the opening vignette played backwards and
// then forwards again (`enter` in game/opening.js), because it is the same shot on the same door.
// This is the half before that — the burger run's shape (game/burgerrun.js), for the same reasons:
//
// **The destination is a lane, not a junction — one of two.** The driveway opens off the road the
// door faces, and a car can turn into it from either side of that road: right off the near lane
// (running +Z, the one the opening merges onto) or left off the far one, across the near lane
// (`entryPath` in game/opening.js). The router is asked for a route that *ends* on each lane
// (`findRouteOnto`) and the run takes the cheaper, so a taxi already heading down the far side turns
// straight in rather than going round the block to come back up the near one.
//
// That lap was the only way in until October 2026 — Tyler: "Taxi never routes into the garage turning
// left into it. Why?" — and `?garageroute=classic` keeps it. A main street's median rules the left
// out (`site.far` is null there), and so does the classic flag, by passing no far mouth.
//
// **The left waits for a gap.** The taxi is out of the traffic model from the frame it is caught,
// so nothing on the near lane can see it crossing. On the far lane it is still an ordinary car, so
// it holds short of the mouth on the brake (`holdsTaxi`) until the near lane is clear for long enough
// to get across, the way any car waits to turn left — and followers queue behind it rather than
// through it. If the gap does not come in HOLD_MAX it drives on and the run plans again.
//
// **It is caught, not driven in by the router.** The taxi stays in the traffic model right up to the
// mouth, and on the frame it reaches it the opening takes it off the road. A taxi that went past —
// boosting, or weaving wide at the mouth — is sent round the block for another go, once.
//
// **Anything else the player aims the taxi at wins**, checked by the identity of `pendingTarget`, as
// the burger run does it. That includes a rider boarding en route: the fare loop re-aims the taxi at
// their drop-off and the trip ends there, because main.js refuses a repair with anyone aboard.
//
// What it costs is the drive there, on the board's clocks. The visit itself is free: the board's
// clocks are held from the turn-in to the camera being handed back (main.js).

/** How far either side of the lane centre the taxi may be and still count as on it — the weave. */
const LANE_TOL = 1.3;
/** How far past the mouth a car can get between two frames and still be taken. */
const CATCH = 1.0;
/** How far short of the mouth a car on its lane counts as still approaching it when a plan is made. */
const PAST_MOUTH = 1.0;
/** Seconds before a trip that has stopped making progress is re-planned — see TRIP_MAX in burgerrun.js. */
const TRIP_MAX = 75;
const MAX_TRIES = 1;

// The gap a left in needs on the near lane: a box around where the driveway crosses it. Behind is
// what an oncoming car covers at cruise (8.5) in the ~2.4s from the catch to the taxi's tail clearing
// the near lane — 7.1 units of arc and 2 of straight at ENTER_V 4.6, plus a body — and ahead is a car
// stood in the lane across the driveway, the back of a queue for the next junction.
const GAP_LATERAL = 2.6;          // half a lane plus a body — the near lane, not the far one
const GAP_BEHIND = 22;
const GAP_AHEAD = 3;
// How long it will wait for that gap before giving up and driving on.
const HOLD_MAX = 6;
// A left in is only worth preferring when it saves more than this, in the router's own block
// weights: the wait for a gap is a cost the right in never pays.
const LEFT_PENALTY = 0.25;

/**
 * @param site     the depot's geometry — see `garageSite` in city/garage.js
 * @param mouth    where the entry path leaves the lane (`opening.mouth`)
 * @param taxi     the player's car, as a traffic-model car
 * @param routeTo  main.js's own router, for the reasons given on the same parameter in burgerrun.js
 * @param farMouth where the left in leaves the far lane (`entryPath(site, 'far').mouth`), or null for
 *                 no left in — a main street, or `?garageroute=classic`
 * @param cars     every vehicle, for the gap a left in waits for
 * @param onArrive `(s0, handBack, side) => boolean` — the taxi reached the mouth `s0` past it; take it
 *                 in by `side` ('near' or 'far'). Returns whether it was taken. `handBack` is the job
 *                 the tap interrupted.
 */
export function createDepotRun({
  site, mouth, farMouth = null, cars = [], taxi, routeTo, onArrive,
}) {
  /**
   * One way in. `ahead` is how far short of the mouth the taxi is, measured along its lane: the near
   * lane runs +Z and the far one −Z. The target is one object for the life of the module, for the
   * identity reasons on the burger run's `target`; `endAt` stops the band at the driveway rather
   * than at the junction the lane runs to.
   */
  const way = (side, d, i, j, at, penalty) => ({
    side,
    lane: { d, i, j },
    mouth: at,
    target: { i, j, endAt: at },
    ahead: d === DIR.PZ ? () => at.z - taxi.z : () => taxi.z - at.z,
    penalty,
  });
  const ways = [way('near', DIR.PZ, site.merge.i, site.merge.j, mouth, 0)];
  if (farMouth && site.far) {
    ways.push(way('far', site.far.d, site.far.i, site.far.j, farMouth, LEFT_PENALTY));
  }
  // The way the current plan arrives by.
  let chosen = ways[0];

  const state = {
    active: false, clock: 0, tries: 0, approached: false, handBack: null, holding: false, held: 0,
  };

  /** On the chosen mouth's lane, heading the right way, in the traffic model. */
  const onLane = () => !taxi.staged && !taxi.crashed && taxi.state === 'drive'
    && taxi.d === chosen.lane.d && taxi.i === chosen.lane.i && taxi.j === chosen.lane.j
    && Math.abs(taxi.x - chosen.mouth.x) < LANE_TOL;

  /** Nothing on the near lane that a left in across it would be driven through by. */
  const nearX = site.kerbX + site.turnR;
  const crossClear = () => !cars.some((car) => car !== taxi && !car.crashed && !car.staged
    && Math.abs(car.x - nearX) < GAP_LATERAL
    && car.z > site.doorZ - GAP_BEHIND && car.z < site.doorZ + GAP_AHEAD);

  /**
   * Carry on to the junction if a mouth is still ahead on the lane the taxi is on, otherwise route
   * onto whichever lane is cheaper to reach.
   */
  function plan() {
    const origin = planOrigin(taxi);
    for (const w of ways) {
      const same = origin.i === w.lane.i && origin.j === w.lane.j && origin.d === w.lane.d;
      if (same && taxi.state === 'drive' && w.ahead() > PAST_MOUTH) {
        chosen = w;
        return routeTo(w.target);
      }
    }
    let best = null;
    for (const w of ways) {
      const route = findRouteOnto(origin, w.target, w.lane.d);
      if (!route) continue;
      const cost = route.cost + w.penalty;
      if (!best || cost < best.cost) best = { w, cost };
    }
    chosen = best?.w ?? ways[0];
    return routeTo(chosen.target, { onto: chosen.lane.d });
  }

  function reset() {
    state.active = false;
    state.clock = 0;
    state.tries = 0;
    state.approached = false;
    state.handBack = null;
    state.holding = false;
    state.held = 0;
  }

  /** Aim the taxi at the depot. Returns whether it is now on its way. */
  function send() {
    const back = taxi.pendingTarget;
    if (!plan()) return false;
    if (back && !ways.some((w) => w.target === back)) state.handBack = back;
    if (!state.active) {
      state.active = true;
      state.clock = 0;
      state.tries = 0;
    }
    state.approached = false;
    state.holding = false;
    state.held = 0;
    return true;
  }

  function retry() {
    state.tries += 1;
    state.clock = 0;
    state.approached = false;
    state.holding = false;
    state.held = 0;
    if (state.tries > MAX_TRIES || !plan()) reset();
  }

  function update(dt) {
    if (!state.active) return;
    state.clock += dt;
    if (taxi.crashed || taxi.pendingTarget !== chosen.target) { reset(); return; }

    state.holding = false;
    if (onLane()) {
      const ahead = chosen.ahead();
      // A left in waits for the near lane, on the brake, from wherever it would otherwise reach the
      // mouth before it could stop — and gives up after HOLD_MAX, driving on to be planned again.
      const blocked = chosen.side === 'far' && ahead > -CATCH && !crossClear();
      if (blocked && state.held < HOLD_MAX && ahead - stopDistance(taxi.v) <= 0.3) {
        state.holding = true;
        state.held += dt;
      } else if (!blocked && ahead > -CATCH && ahead <= 0) {
        const back = state.handBack;
        if (onArrive(-ahead, back, chosen.side)) { reset(); return; }
      }
      if (ahead > 0) state.approached = true;
      else if (state.approached && ahead <= -CATCH) { retry(); return; }
    }
    if (state.clock > TRIP_MAX) retry();
  }

  return {
    state,
    send,
    update,
    /** The route band, dragged — the waypoint plus the lane the plain re-plan would drop. */
    reroute: (via) => routeTo(chosen.target, { via, onto: chosen.lane.d }),
    active: () => state.active,
    /** Holding the taxi short of the far mouth for a gap — main.js puts it on the brake. */
    holdsTaxi: () => state.active && state.holding,
    abandon: reset,
  };
}
