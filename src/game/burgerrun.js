import { planOrigin } from './route.js';

// The player's own trip through the drive-through: the tap that starts it, the route that gets the
// taxi to the mouth, and what happens to the job it interrupted.
//
// The lot itself is not here. Everything from the driveway to the kerb on the way out is
// `game/drivethru.js`, exactly as it is for an ambient car — this module holds a *ticket* from that
// one (see `inviteTaxi`) and watches it. What is here is the half a drive-through has never needed
// before: a car that has to be *steered* to the mouth, and a job waiting at the other end of the
// detour.
//
// **The destination is a lane, not a junction.** The lot only takes a car off the kerbside −X lane
// of the road along the joint's +Z edge, so "drive to the burger joint" cannot be expressed as a
// junction: the router would happily arrive at either end of that lane from the other three
// directions and drive straight past the thing the player asked for. `findRouteOnto` (game/route.js)
// is the router that takes a lane, `site.approach` (city/burgerjoint.js) is which lane, and the
// comment on the former carries the measurement — routing *via* the junction the lane leaves, which
// is the obvious first try, silently answers about one trip in five with a lap that arrives at the
// right corner from the wrong side.
//
// **It costs the clock it interrupts, and nothing else.** A rider in the back keeps counting down the
// whole way there, through both windows and back out again. Measured end to end, tap to back on the
// road (`tools/probe.mjs`): **12s** when the taxi is already coming down the joint's own street, 28s
// for a lap of the block from the lane it was just spat out onto, 38s from the far side of the city.
// Against 2.25s of boost at the end of it (`BOOST_BURGER_REWARD`, game/boost.js) — so it is a bad
// trade taken on purpose and a good one when the taxi was going past anyway, which is the whole of
// the decision the secret is offering. Nothing here checks the clock before taking it: same rule as
// the courier detour, and for the same reason, it is the player's to make.
//
// **Anything else the player aims the taxi at wins.** The run is abandoned the moment
// `pendingTarget` stops being this module's own object — a tap on a rider or a package, a rider
// picked off a finder chip, a route poked in from the ⚙️ panel — rather than each of those call
// sites having to remember that a burger might be running. The one exception is a rider boarding
// *en route*, which re-aims the taxi at their drop-off from inside the fare loop: main.js hands the
// wheel straight back with `send()`, and the drop-off becomes what the trip returns to.

/**
 * How far short of the driveway the taxi still counts as approaching it, in units of x on the mouth's
 * own lane.
 *
 * Only used to answer "is the mouth still in front of us?" when a plan is made, and only when the
 * taxi is already on that lane: past this and the pass is spent, so the route has to go round the
 * block for another one. It is `CATCH` from game/drivethru.js — the window that module gives itself
 * to take a car that reached the driveway between two frames — because a plan that leaves the mouth
 * ahead by less than that is a plan the lot is about to answer anyway.
 */
const PAST_MOUTH = 1.0;

/**
 * How long a trip may run before it is written off, in seconds.
 *
 * Generous rather than tuned, and it is a **re-plan** rather than a refusal: the slowest honest trip
 * measured is 38s, so this is twice the worst case before anything happens at all, and what happens
 * then is one more attempt (`MAX_TRIES`). Only the second timeout gives up.
 *
 * What it is actually here for is a trip that has stopped making progress at all — a taxi that
 * weaved wide enough at the driveway for the lot to lose it *and* never came back round, a route
 * that fell apart under a roadworks closure. Without it the lot stays held for a taxi that is never
 * coming and ambient cars stop pulling in, which shows up as the drive-through mysteriously going
 * quiet for the rest of the run.
 */
const TRIP_MAX = 75;

/** How many times a missed pass is re-planned before the trip is given up on. */
const MAX_TRIES = 1;

/**
 * @param site   the joint's geometry — see `burgerSite` in city/burgerjoint.js
 * @param lot    the drive-through (game/drivethru.js), for `inviteTaxi`/`dismissTaxi`
 * @param taxi   the player's car, as a traffic-model car
 * @param routeTo  main.js's own router — `(target, opts) => boolean`. Injected rather than reaching
 *                 for `findRoute` directly, because everything else that function does around the
 *                 plan (clearing `routeConsumed`, releasing `parked`, keeping `pendingTarget`'s
 *                 identity stable for the route band) is load-bearing for a route that replaces one
 *                 already part-driven.
 * @param onServed  fires once per visit, on the frame the order is handed over at the window. The
 *                  reward lives at the call site: this module knows the taxi went through a
 *                  drive-through, not what a tank of boost is.
 * @param onFinish  `(handBack) => void` — the trip is over and the taxi is somebody else's problem
 *                  again. `handBack` is whatever the taxi was aimed at when this took the wheel, or
 *                  null when the trip ended because the player aimed it somewhere else themselves.
 */
export function createBurgerRun({ site, lot, taxi, routeTo, onServed = () => {}, onFinish = () => {} }) {
  const { approach } = site;

  // One object for the life of the module, and its *identity* is what two separate things key off:
  // the route band's rollout sweep (which replays from scratch if the target is merely equal), and
  // this module's own "is that still my route" test in `update`. A fresh `{ i, j }` per plan would
  // break both.
  const target = { i: approach.i, j: approach.j };

  const state = {
    // 'off' — nothing running. 'driving' — on the road, heading for the mouth. 'inlot' — the
    // drive-through has the wheel and nothing out here can help it.
    stage: 'off',
    clock: 0,
    tries: 0,
    paid: false,
    /** What the taxi was doing before the tap, to be handed back on the way out. */
    handBack: null,
    /** The lot's ticket for this visit — see `inviteTaxi` in game/drivethru.js. */
    ticket: null,
  };

  /**
   * Aim the taxi at the mouth.
   *
   * Two shapes, and the difference is one question: is the driveway still in front of the car on the
   * lane it is already on? If it is — the player tapped while driving down the joint's own street —
   * the route is simply "carry on to the far junction" and the lot catches the taxi on the way past.
   * Anything else goes to `findRouteOnto`, which answers with a route that *ends* on the mouth's
   * lane. That includes being on that lane already but past the driveway, where the shortest way
   * back onto it is a lap of the block — the honest answer, since there is one way into a
   * drive-through and the pass has been spent.
   */
  function plan() {
    const origin = planOrigin(taxi);
    const onLane = origin.i === target.i && origin.j === target.j && origin.d === approach.d;
    // The lane the mouth is on runs −X, so a car short of the driveway is at a *greater* x.
    if (onLane && taxi.x > site.entry.x + PAST_MOUTH) return routeTo(target);
    return routeTo(target, { onto: approach.d });
  }

  function reset() {
    state.stage = 'off';
    state.clock = 0;
    state.tries = 0;
    state.paid = false;
    state.handBack = null;
    state.ticket = null;
  }

  /**
   * End the trip. `resume` is whether the job it interrupted should be handed back — true for a
   * visit that ran to the kerb and for one that was given up on (the taxi is somewhere on the map
   * with an empty route, which is the state that most needs a job putting back into it), false when
   * the player has already told the taxi to do something else.
   */
  function stop(resume) {
    lot.dismissTaxi();
    const back = resume ? state.handBack : null;
    reset();
    if (back) onFinish(back);
  }

  /**
   * Take the wheel: plan the route and hold the lot.
   *
   * Called by the tap, and again by main.js on the frame a rider boards mid-trip — the fare loop
   * dispatches the taxi at their drop-off on that frame, and this puts the burger back in front of
   * it with the drop-off remembered as what to return to. Refused while the taxi is in the lot,
   * where there is no route to plan and nothing to take.
   *
   * Returns whether the taxi is now on its way, which is what the tap's haptic is gated on: a
   * refused plan is a route that did not change, and a buzz for it would report a trip that is not
   * happening.
   */
  function send() {
    if (state.stage === 'inlot') return false;
    const back = taxi.pendingTarget;
    if (!plan()) return false;
    // Not `back ?? state.handBack`: a re-plan mid-trip reads our own target back out of the car and
    // would otherwise overwrite the job with the detour.
    if (back && back !== target) state.handBack = back;
    if (state.stage === 'off') {
      state.stage = 'driving';
      state.clock = 0;
      state.tries = 0;
      state.paid = false;
    }
    if (!state.ticket || state.ticket.stage === 'out' || state.ticket.missed) {
      state.ticket = lot.inviteTaxi(taxi);
    }
    return true;
  }

  /** Another pass at it, or give up. A missed ticket is dead, so this always takes a fresh one. */
  function retry() {
    state.tries += 1;
    if (state.tries > MAX_TRIES) { stop(true); return; }
    state.clock = 0;
    state.ticket = lot.inviteTaxi(taxi);
    if (!plan()) stop(true);
  }

  function update(dt) {
    if (state.stage === 'off') return;
    state.clock += dt;
    const { ticket } = state;

    // Paid at the window rather than at the kerb on the way out: what the player is being paid for
    // is the visit, and the visit ends when the order is handed over. Latched, because `served`
    // stays true for the rest of the ticket.
    if (ticket.served && !state.paid) {
      state.paid = true;
      onServed();
    }

    if (ticket.stage === 'inlot') {
      state.stage = 'inlot';
      return;
    }
    if (ticket.stage === 'out') { stop(true); return; }

    // Everything below is about the leg that can go wrong: the drive to the mouth.
    //
    // A wrecked or busted run first — the taxi is not going anywhere, and the job it was doing is
    // over too, so there is nothing to hand back.
    if (taxi.crashed) { stop(false); return; }
    // Somebody else has taken the wheel. Checked by identity against the object this module aims
    // at, which is the one thing every other dispatch in the game overwrites.
    if (taxi.pendingTarget !== target) { stop(false); return; }
    if (ticket.missed || state.clock > TRIP_MAX) retry();
  }

  return {
    state,
    send,
    update,
    /**
     * The route band, dragged (game/pathdrag.js). Same waypoint the drag would name on any other
     * trip, and the same cap — this exists only to carry the lane the plain re-plan would drop.
     */
    reroute: (via) => routeTo(target, { via, onto: approach.d }),
    /** Is a trip running at all? */
    active: () => state.stage !== 'off',
    /**
     * Is the drive-through driving the taxi right now? The pill reads this: a player leaning on Loco
     * Mode at a pickup window would be pouring the tank away into a car that cannot move, and would
     * empty it in the fifteen seconds a wait behind two ambient cars can take.
     */
    holdsTaxi: () => state.stage === 'inlot',
    /** Called off a run ending, so a trip cannot outlive the run it was taken during. */
    abandon: () => { if (state.stage !== 'off') stop(false); },
  };
}
