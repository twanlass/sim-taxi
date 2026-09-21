import { GRID_I, GRID_J, dirSign, isXAxis, lineX, lineZ } from '../city/grid.js';
import { URGENCY_SEGMENTS, urgencyLevel } from './urgency.js';
import { findRoute, planOrigin } from './route.js';

// The bank robbery: the empty taxi drives past the bank, somebody gets in with a bag, and the
// streets fill with police for as long as it takes to get them where they are going.
//
// **It is the existing loop turned up, not a new one**, and that is a constraint rather than a
// description. Nothing here invents a mechanic:
//
//   - The robber is an ordinary fare that skipped the kerb — `spawnRobber` in game/fares.js. Same
//     crystal, same ring, same band of paint, same arrival test, same payout flight. What differs
//     is the clock (the tightest in the game) and a bonus that reads it at the drop-off.
//   - The cop cars are ordinary ambient traffic wearing police livery — `setPoliceCars` in
//     sim/traffic.js. They queue, indicate, stop at reds, yield and can be crashed into exactly
//     like the cars they were a moment before.
//   - **And they come after you**, which is the one thing in this event that was originally ruled
//     out and is now the point of it. It is still not pursuit *AI*: a chasing cop is an ordinary
//     car with a `route` — the same single branch that drives the player's own taxi
//     ([traffic.md](../../docs/traffic.md#the-one-routing-branch)) — and a multiplier on its cruise
//     ceiling. See `steerChase` below. Nothing in sim/police.js, which owns the corridor cruiser
//     and its own scripted chase, is touched by any of this.
//   - Loco Mode is untouched. It is still a finite tank spent in a hold, and the choice the event
//     poses is the one the tank already poses, now with something on the other side of it: boost
//     past the traffic and risk the wreck, or hold off and risk the clock.
//   - The fail state is untouched. Crashing into a cop car is crashing into a car —
//     sim/collisions.js does not know what livery anything is wearing and is not told.
//
// So the whole of this module is a trigger, a cooldown, and the bookkeeping that keeps the police
// near the player while it runs.

/**
 * How near the bank's door the taxi has to get, in world units.
 *
 * Measured rather than picked. The door point sits 0.5 out from the building's own setback, which
 * is 0.35 inside the block's edge; the near lane is `LANE` = 2 off the kerb, so a taxi driving past
 * the middle of the frontage is about 2.9 units out. The frontage is 10.2 long, so passing its far
 * end is hypot(2.9, 5.1) = 5.9. The *oncoming* lane is another `2 · LANE` out, which takes the same
 * pass to hypot(6.9, 5.1) = 8.6 — and a taxi on the far side of the street has still driven past
 * the bank, so it counts.
 *
 * Twelve clears all of that with room for a car mid-junction at either corner. What it deliberately
 * does not reach is the street on the *other* side of the block: the bank is 9.7 deep and the road
 * beyond it is another 8 wide, so the nearest point of that carriageway is 18 units away.
 */
const TRIGGER_RANGE = 12;

/**
 * Seconds after an event ends before another can start.
 *
 * From the **end** of the last one rather than its start, so two robberies can never run into each
 * other however short the getaway was. Longer than `VIP_COOLDOWN` (55) because this event takes the
 * seat rather than offering itself from a kerb: a player who cannot stop it happening should not
 * meet it as often as one who can walk past it.
 *
 * **It is not the frequency knob it looks like**, and that has now been measured twice. Nearly
 * doubling it moved the count of robberies from 33 to 34 over 30 runs; doubling it again on top of
 * a raised `MIN_DELIVERED` moved nothing at all — the same 8 robberies and the same 9.4-fare mean,
 * to the digit. The cooldown is not what limits the event. What limits it is the taxi happening to
 * drive past the bank with an empty cab and a calm kerb, which on a five-block city is about once a
 * run whatever this says. What the constant actually buys is the one thing its own sentence says:
 * two robberies can never run into each other.
 */
const COOLDOWN = 70;

/**
 * The lowest urgency level a rider may be standing on the kerb at for a robbery to start.
 *
 * **This is the gate that makes the event fair, and it is the only one that was measured.** A
 * robbery takes the seat, and every rider already waiting when it starts is spending a clock that
 * was budgeted without it (`budgetFor` in game/fares.js). A rider who was comfortable can usually
 * absorb that; a rider who was already in trouble cannot, and *their* clock running out ends the
 * run. So the event that cannot end a run directly was ending runs by proxy.
 *
 * Measured with `tools/autoplay.mjs` over 30 paired runs per cell, against a no-robbery baseline
 * of a 13.9-fare mean on $339 at a 1.5s reaction and 11.2 on $264 at 4s:
 *
 * | | 1.5s | 4s | robberies (1.5s) |
 * |---|---|---|---|
 * | no gate at all | 9.8 fares · $239 | 8.4 · $206 | 28 |
 * | **this gate** | **12.4 fares · $309** | **8.6 · $211** | 18 |
 * | tightened to the top step | 14.0 fares · $349 | 11.2 · $264 | **2** |
 *
 * Two findings, and the second is the reason this constant is not turned up. The gate is worth two
 * and a half fares to a fast player, which is most of what a cross-town getaway costs. And it has
 * **no usable room above it**: at the top step the event fires twice in thirty runs at 1.5s and
 * never at all at 4s, which is not a rarer event, it is no event. What is left is the distance
 * itself (`ROBBER_DROPOFF_DARTS` in game/fares.js), and that one is a design choice rather than a
 * tuning knob.
 *
 * The cooldown is not a third lever, though it looks like one — see COOLDOWN above.
 *
 * Expressed as a **level** rather than a fraction so the rule is one the player can read off the
 * board: the urgency scale is four even quarters (game/urgency.js), so this is "every crystal on
 * the kerb is still on one of its top two steps". A number like 0.45 would measure the same thing
 * and mean nothing on screen.
 */
const CALM_LEVEL = URGENCY_SEGMENTS / 2 + 1;

/**
 * Deliveries before the first one can happen.
 *
 * `VIP_MIN_DELIVERED` is 1, on the grounds that a purple diamond needs something to be
 * distinguished *from*. This is higher for a different reason: a robbery takes the wheel. A player
 * two fares in has seen a pickup, a drop-off, a payout and a refill, which is the whole loop — and
 * an event that overrides the loop is only legible to somebody who has one.
 *
 * It was measured as a difficulty knob too, since a cross-town getaway costs a slower player more
 * than a fast one (see ROBBER_DROPOFF_DARTS in game/fares.js). At 4 it buys back 0.8 of a fare at a
 * 4s reaction — and halves how often the event happens, from 14 robberies in 30 runs to 8. That is
 * not a gentler event, it is less of one, which is why it stays at 2.
 */
const MIN_DELIVERED = 2;

/**
 * How many ambient cars wear police livery while it runs.
 *
 * Flat rather than on the difficulty ramp, and that is a decision. The event already tightens with
 * the run: a robber's clock is budgeted off `difficulty.slack`, so the same getaway is a harder
 * drive on delivery forty than on delivery three. Hanging a second knob off the same ramp would
 * make the event's difficulty a product of two curves neither of which could then be read on its
 * own — the trap `difficulty.md` describes as a survival curve going flat against every knob
 * because none of them was the one doing the work.
 *
 * Four is what a five-block city can show at once: at play zoom a block is about a third of a
 * phone's frame, so four cars spread around the taxi puts one or two in shot at any moment without
 * the road ever reading as a parade.
 */
const POLICE_CARS = 4;

/**
 * How many vehicles the event asks the fleet to grow by, on top of repainting the nearest four.
 *
 * This is the half that genuinely *adds* traffic, and it is bounded by something already in the
 * game rather than by a number of its own. `setCarCount` (sim/traffic.js) only ever grows and is
 * capped at the pool the difficulty ramp's own ceiling sized — so what a robbery does is spend that
 * ramp's headroom early. The cars it brings forward are cars the run was going to get anyway, a
 * shift or two later, and no run can end up with more traffic in it than one that never met a
 * robbery at all.
 *
 * They are not marked police, and they are not un-spawned at the end. A permanent +2 that the ramp
 * was going to deliver regardless is honest; a fleet that shrank on the frame an event ended would
 * mean deleting cars out of the middle of an instance buffer while the player watched, which is the
 * thing `setCarCount` refuses to do for good reasons.
 */
const EXTRA_CARS = 2;

/**
 * How often the police are re-picked, in seconds.
 *
 * `setPoliceCars` takes the nearest N to the taxi, so re-running it is what keeps the event around
 * the player: a cop car that has driven off across town is handed back its own paint and a nearer
 * one turns blue. That is the closest this module comes to the cars acknowledging the taxi, and it
 * is deliberately as far as it goes — the *set* follows the player, not the cars.
 *
 * Not every frame, because each change is a `setColorAt` plus an `instanceColor` upload, and not
 * much slower, because the swap has to happen off screen to read as a car that was always there.
 * `SPEED` is 8.5, so a car covers 17 units in two seconds — most of a 20-unit block — and anything
 * that turns over between two re-picks has been out of the frame it was last seen in for most of
 * that. It is a bound rather than a guarantee: a car stopped at a red does not move at all, which
 * is why the swap is a paint change on a car that is already there rather than a car appearing.
 */
const REPICK = 2;

/** The junction nearest a world point, clamped onto the grid. */
function nearestJunction(x, z) {
  let best = { i: 0, j: 0 };
  let bestD = Infinity;
  for (let i = 0; i <= GRID_I; i++) {
    for (let j = 0; j <= GRID_J; j++) {
      const d = Math.abs(lineX(i) - x) + Math.abs(lineZ(j) - z);
      if (d < bestD) { bestD = d; best = { i, j }; }
    }
  }
  return best;
}

/**
 * @param site     the bank (`buildBank` in city/bank.js). Null is a real answer — a city with
 *                 nowhere to put a bank simply never has a robbery, and main.js does not construct
 *                 this module at all.
 * @param taxi     the player's car, as a traffic-model car
 * @param fares    the fare loop (game/fares.js) — `spawnRobber`, and its state for the gates below
 * @param traffic  the sim (sim/traffic.js) — `setPoliceCars` and `setCarCount`
 * @param onBoard  `(fare) => void`, fired on the frame the robber is in the car. main.js aims the
 *                 taxi at the getaway and lights the roof sign, which is exactly what it does on an
 *                 ordinary `'pickup'` — this module knows a fare started, not what a roof sign is.
 */
export function createRobbery({ site, taxi, fares, traffic, onBoard = () => {} }) {
  // The junction the bank's door belongs to, worked out once: the city does not move, and this is a
  // thirty-six-cell scan.
  const junction = nearestJunction(site.door.x, site.door.z);

  const state = {
    /** Is one running right now? */
    active: false,
    /** Sim seconds since the last one ended. Starts clear, so the gates below are the only bar. */
    since: COOLDOWN,
    sinceRepick: 0,
    /** How many have happened this run, for the tools. */
    count: 0,
  };

  /** How far the taxi is from the bank's door, in world units. */
  const range = () => Math.hypot(taxi.x - site.door.x, taxi.z - site.door.z);

  // Where the chase was last aimed. A plan is keyed on its endpoint and left alone in between,
  // which is not a micro-optimisation: re-planning a route every frame is a standing trap in this
  // codebase — the turn a car has already committed to never retires from its route, so it sits at
  // the junction re-deciding the same turn and never takes it. See CLAUDE.md.
  let aimedAt = null;

  /**
   * How far down the taxi's own route the police are sent, in junctions.
   *
   * **This is the whole difference between a chase that works and one that does not**, and the
   * first cut got it wrong in the most reasonable way available: it sent every cop to the junction
   * the taxi was *at*. That is a stern chase, and a stern chase against this taxi is arithmetically
   * unwinnable. Measured over six events with the player boosting, a cop averaged 7 u/s against a
   * taxi's 27 — it is being sent to a point the taxi left a second ago, so the gap grows every
   * frame it drives. The numbers say so without any ambiguity: the nearest cop sat at a median of
   * 25-30 units for the length of the getaway and was inside half a block for **0-9%** of it. On
   * screen that is four blue cars milling about somewhere behind you, which is exactly how it was
   * reported — "none of the other police actually moved or followed me".
   *
   * And it is not a tuning problem. The chase was given three separate advantages, each measured:
   * traffic that scatters out of its lane, corners taken at nearly twice an ordinary car's speed,
   * and — as an experiment, not shipped — **every red light in the city turned green for it**. All
   * three together moved a cop's mean speed from 7 to 13 and moved the distance to the taxi by
   * nothing at all. A pursuer slower than its quarry does not catch it, however much licence it is
   * given.
   *
   * So the cops stop pursuing and start **cutting you off**. The taxi's route is a list of the
   * junctions it is going to drive through, and it is already sitting on `taxi.route` because the
   * player drew it; sending a cop to one of them is the same `findRoute` to a different target. It
   * turns the event from a tail-chase into a road that keeps filling up ahead of you — which is
   * both the drama and, unlike the tail-chase, a thing that can actually happen: a cop only has to
   * beat the taxi to *one* junction on its way, and the taxi has told everyone which ones those
   * are.
   *
   * Three junctions, spread. A block is ~2.3s at ordinary cruise and about 0.75s at the Loco top,
   * so aiming at the next junction lands the cop behind the taxi again; aiming ten ahead puts it
   * somewhere the run may never reach. Three to five is the band where a cop starting a block or
   * two off to the side arrives while the taxi is still coming. They are dealt round-robin rather
   * than all sent to one, so the road ahead is seeded rather than barricaded at a single point.
   */
  const CUT_OFF_AHEAD = [3, 4, 5];

  /**
   * Where a cop should be heading: a junction on the taxi's route, `steps` ahead of it.
   *
   * Falls back to the taxi's own junction, which is the right answer for both cases that get here
   * — a taxi with no route (nobody aboard, or the player has not drawn one yet) and a taxi within
   * `steps` of its destination. In the second the drop-off *is* where everyone is converging, which
   * is the ending this event wants anyway.
   */
  function cutOffFor(steps) {
    const route = taxi.route;
    if (!route?.length) return { i: taxi.i, j: taxi.j };
    // `taxi.i/j` is the junction the taxi's lane runs *into*, so walking the route from there is
    // walking it from the first junction it has not decided yet — which is exactly what the route
    // steps describe. Each step is a grid direction: one junction along that axis.
    let { i, j } = taxi;
    for (let k = 0; k < Math.min(steps, route.length); k++) {
      const d = route[k];
      if (isXAxis(d)) i += dirSign(d);
      else j += dirSign(d);
    }
    // A route step is a grid direction, so walking it can only leave the grid if the route did —
    // but clamp anyway: `findRoute` answers null for a junction that does not exist, and a null
    // route is a cop that quietly stops chasing.
    return { i: Math.max(0, Math.min(GRID_I, i)), j: Math.max(0, Math.min(GRID_J, j)) };
  }

  /**
   * Point every cop car at a junction the taxi is about to drive through.
   *
   * **The whole chase is this function**, and it is deliberately four lines of behaviour:
   *
   *   - `car.chase = 1` lifts that car's cruise ceiling by `CHASE_SPEED` and its cornering by
   *     `CHASE_CORNER_SPEED` (both sim/traffic.js), and puts the cars in front of it to flight on
   *     the same `scatter` the boosting taxi uses. A cop cruises at 20.4 against a boosting taxi's
   *     22.1 and an ordinary car's 8.5 — so the pill still outruns them in a straight line, and
   *     what it cannot outrun is one that is already parked across the junction ahead.
   *   - `car.route` is a plain `findRoute` to a junction on the taxi's own route — see
   *     `CUT_OFF_AHEAD`. From there the one routing branch in sim/traffic.js does everything: the
   *     cop takes the turn its route calls for and is subject to every signal, yield and following
   *     rule unchanged.
   *   - It is re-planned when the **taxi** moves to a new junction, not on a clock and not per
   *     frame. A chase that re-aims every frame stalls; one that re-aims per junction converges.
   *   - A cop whose route has run dry gets a fresh one even if the taxi has not moved, which is
   *     what happens when it arrives at its cut-off and the taxi has not got there yet.
   *
   * What it deliberately does **not** do is give a cop any licence an ordinary car lacks. It does
   * not run reds, it does not ignore queues, and it cannot be crashed into by anything but the
   * player — `sim/collisions.js` only ever tests the taxi. A cop let through a red would drive
   * *through* the cross traffic rather than into it, which is the trap `releaseCar` already
   * records. That licence was measured (see CUT_OFF_AHEAD) and bought nothing, which is the
   * happier half of this: the version that reads best is also the one that keeps every rule.
   */
  function steerChase() {
    // What the aim is keyed on: the junction the taxi is heading into, **and the route it is
    // heading down**. The second half is not redundant — the cut-off targets are junctions on that
    // route, so a player who redraws it has moved every one of them without moving the taxi an
    // inch. Keyed on the junction alone, the police went on converging on a road the taxi had
    // stopped driving down until it happened to cross a junction, which is up to a whole block of
    // the chase aiming at nothing. A prefix rather than the whole list because only the first few
    // steps are read (see CUT_OFF_AHEAD), and a route's tail changes every time a leg retires.
    const at = {
      i: taxi.i,
      j: taxi.j,
      plan: (taxi.route ?? []).slice(0, Math.max(...CUT_OFF_AHEAD)).join(','),
    };
    const moved = !aimedAt || aimedAt.i !== at.i || aimedAt.j !== at.j || aimedAt.plan !== at.plan;
    let nth = 0;
    for (const car of traffic.policeCars) {
      if (car.crashed) continue;
      car.chase = 1;
      const steps = CUT_OFF_AHEAD[nth % CUT_OFF_AHEAD.length];
      nth += 1;
      if (!moved && car.route?.length) continue;
      // An **empty** route is a cop already standing on the junction it was sent to, and leaving
      // it there is the one thing that undoes the whole idea: a car with no route rolls the
      // ordinary dice at its next junction, so the cop that got there first then wanders off the
      // getaway a beat before the taxi arrives. Send it further down the same road instead — the
      // taxi is still coming, and a cop driving along the road ahead of you reads better than one
      // parked on it anyway. Null is an unroutable pair, which `main.js` rerolls the city to
      // prevent; that one is left rolling the dice until the next re-aim, because there is
      // genuinely nowhere to send it.
      let route = findRoute(planOrigin(car), cutOffFor(steps));
      if (route && route.length === 0) {
        route = findRoute(planOrigin(car), cutOffFor(steps + CUT_OFF_AHEAD.length));
      }
      if (route?.length) car.route = route;
      car.routeConsumed = false;
    }
    aimedAt = at;
  }

  function eligible() {
    if (state.active || fares.state.gameOver) return false;
    if (state.since < COOLDOWN) return false;
    if (fares.state.delivered < MIN_DELIVERED) return false;
    // The seat. A robber gets *in*, so there has to be room — and a player mid-delivery has a clock
    // running that this event would spend on somebody else's trip.
    if (fares.carrying()) return false;
    // ...and not on top of a VIP, which is the one interaction that would be unfair rather than
    // merely busy. A VIP's clock is budgeted to be served **next** (`budgetFor` in game/fares.js —
    // its whole tension is that jumping the queue for one is what lands it), so a robber taking the
    // seat for a cross-town getaway does not make a VIP harder, it makes it arithmetically
    // impossible. Missing one is only ever the bonus, so nothing breaks; it would just be the game
    // quietly cancelling a fare it had offered.
    if (fares.state.fares.some((f) => f.vip)) return false;
    // ...and not on top of a rider who is already running out — see CALM_LEVEL. This is the gate
    // that keeps an imposed event from ending runs by proxy.
    if (fares.state.fares.some((f) => f.stage === 'waiting'
      && urgencyLevel(f.timeLeft / f.limit) < CALM_LEVEL)) return false;
    // A crashed or staged taxi is not driving past anything — it is in a wreck or in its garage.
    if (taxi.crashed || taxi.staged) return false;
    return range() <= TRIGGER_RANGE;
  }

  function start() {
    const fare = fares.spawnRobber(taxi, junction, site.door);
    // `spawnRobber` can still refuse — a full board has no free slot for the figure and the
    // crystal. Nothing is spent when it does: the cooldown has not been reset, so the next pass
    // down the same street tries again.
    if (!fare) return;

    state.active = true;
    state.count += 1;
    state.sinceRepick = 0;
    // The traffic first, so the police are already on the road on the frame the player looks up
    // from the crystal appearing over their roof.
    //
    // One call per car: `setCarCount` adds **at most one vehicle per invocation** and gives up
    // quietly when the draw cannot find a legal spot, so asking it for two in one go quietly
    // delivers one. It is the target-count shape that makes that easy to miss.
    for (let k = 0; k < EXTRA_CARS; k++) traffic.setCarCount(traffic.cars.length + 1);
    traffic.setPoliceCars(POLICE_CARS);
    // `onBoard` first, and the order matters now. It is what dispatches the taxi to the getaway
    // (main.js), so it is what puts a route on the car — and the police are sent to junctions on
    // *that* route. Aiming before it ran left the whole set converging on the taxi's own junction
    // until it next crossed one, which is the stern chase this event was just taken off.
    onBoard(fare);
    // Pointed down the getaway on the frame they turn blue rather than on the next re-pick, so the
    // road is already filling up as the robber is still getting in.
    steerChase();
  }

  /** Hand the cop cars back their own paint and start the clock on the next one. */
  function stop() {
    if (!state.active) return;
    state.active = false;
    state.since = 0;
    aimedAt = null;
    // `setPoliceCars(0)` clears each car's `chase` and its route as it hands the paint back — see
    // the note there. It is the one place a car leaves the set, so it is the one place that can be
    // sure of catching every one of them.
    traffic.setPoliceCars(0);
  }

  function update(dt) {
    state.since += dt;

    if (state.active) {
      // The event ends when the robber does, whichever way that went: delivered, clock run out
      // (they bail — see the timeout branch in game/fares.js), or the run over. All three land here
      // as the same fact, which is why this is a poll on the fare loop rather than three callbacks
      // that each have to remember to put the paint back.
      if (!fares.robbing()) { stop(); return; }
      state.sinceRepick += dt;
      if (state.sinceRepick >= REPICK) {
        state.sinceRepick = 0;
        traffic.setPoliceCars(POLICE_CARS);
        // A car that has just been handed the livery has no route and no chase yet, so the aim has
        // to be forgotten along with the set — otherwise a fresh cop waits for the taxi to change
        // junction before it is ever pointed anywhere.
        aimedAt = null;
      }
      steerChase();
      return;
    }

    if (eligible()) start();
  }

  return {
    state,
    update,
    /** Where the bank is, for the HUD and the tools. */
    site,
    junction,
    range,
    /**
     * Called off a run ending, so an event cannot outlive the run it happened during — the same
     * contract `burgerRun.abandon` keeps. The fare loop has already cleared the board by then
     * (`crash` in game/fares.js); what is left is a fleet of blue cars that would otherwise stay
     * blue behind the retry screen.
     */
    abandon: stop,
  };
}
