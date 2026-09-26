import { DIR } from '../city/grid.js';
import { planOrigin } from './route.js';

// The player's trip back to the depot for repairs: the tap that starts it, the route that gets the
// taxi to the driveway, and catching it there.
//
// The visit itself is not here. From the lane onward it is the opening vignette played backwards and
// then forwards again (`enter` in game/opening.js), because it is the same shot on the same door.
// This is the half before that — the burger run's shape (game/burgerrun.js), for the same reasons:
//
// **The destination is a lane, not a junction.** The driveway only opens off the near lane of the
// road the door faces, running +Z — the lane the opening merges onto — so the router is asked for a
// route that *ends* on that lane (`findRouteOnto`), and a car that reaches the right junction from
// any other side is not arriving at the depot.
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

/**
 * @param site     the depot's geometry — see `garageSite` in city/garage.js
 * @param mouth    where the entry path leaves the lane (`opening.mouth`)
 * @param taxi     the player's car, as a traffic-model car
 * @param routeTo  main.js's own router, for the reasons given on the same parameter in burgerrun.js
 * @param onArrive `(s0, handBack) => boolean` — the taxi reached the mouth `s0` past it; take it in.
 *                 Returns whether it was taken. `handBack` is the job the tap interrupted.
 */
export function createDepotRun({ site, mouth, taxi, routeTo, onArrive }) {
  const lane = { d: DIR.PZ, i: site.merge.i, j: site.merge.j };
  // One object for the life of the module, for the identity reasons on the burger run's `target`.
  // `endAt` stops the band at the driveway rather than at the junction the lane runs to.
  const target = { i: lane.i, j: lane.j, endAt: mouth };

  const state = { active: false, clock: 0, tries: 0, approached: false, handBack: null };

  /** On the mouth's lane, heading the right way, in the traffic model. */
  const onLane = () => !taxi.staged && !taxi.crashed && taxi.state === 'drive'
    && taxi.d === lane.d && taxi.i === lane.i && taxi.j === lane.j
    && Math.abs(taxi.x - mouth.x) < LANE_TOL;

  /** Carry on to the junction if the mouth is still ahead on this lane, otherwise route onto it. */
  function plan() {
    const origin = planOrigin(taxi);
    const same = origin.i === lane.i && origin.j === lane.j && origin.d === lane.d;
    // The lane runs +Z, so a car short of the mouth is at a *smaller* z.
    if (same && taxi.state === 'drive' && taxi.z < mouth.z - PAST_MOUTH) return routeTo(target);
    return routeTo(target, { onto: lane.d });
  }

  function reset() {
    state.active = false;
    state.clock = 0;
    state.tries = 0;
    state.approached = false;
    state.handBack = null;
  }

  /** Aim the taxi at the depot. Returns whether it is now on its way. */
  function send() {
    const back = taxi.pendingTarget;
    if (!plan()) return false;
    if (back && back !== target) state.handBack = back;
    if (!state.active) {
      state.active = true;
      state.clock = 0;
      state.tries = 0;
    }
    state.approached = false;
    return true;
  }

  function retry() {
    state.tries += 1;
    state.clock = 0;
    state.approached = false;
    if (state.tries > MAX_TRIES || !plan()) reset();
  }

  function update(dt) {
    if (!state.active) return;
    state.clock += dt;
    if (taxi.crashed || taxi.pendingTarget !== target) { reset(); return; }

    if (onLane()) {
      const ahead = mouth.z - taxi.z;
      if (ahead > -CATCH && ahead <= 0) {
        const back = state.handBack;
        if (onArrive(-ahead, back)) { reset(); return; }
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
    reroute: (via) => routeTo(target, { via, onto: lane.d }),
    active: () => state.active,
    abandon: reset,
  };
}
