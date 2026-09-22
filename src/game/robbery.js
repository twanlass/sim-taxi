import { GRID_I, GRID_J, dirSign, isXAxis, lineX, lineZ } from '../city/grid.js';
import { URGENCY_SEGMENTS, urgencyLevel } from './urgency.js';
import { findRoute, planOrigin } from './route.js';
import { POLICE_FLEET, SPAWN_CLEARANCE } from '../sim/traffic.js';

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
 * How many cop cars the event puts on the road.
 *
 * `POLICE_FLEET` lives in sim/traffic.js and is imported rather than restated, because it is also
 * the buffer headroom the vehicle meshes reserve over and above the density ramp's ceiling. Two
 * copies of that number would be a fleet that quietly stops arriving the day somebody changes one.
 *
 * Flat rather than on the difficulty ramp, and that is a decision. The event already tightens with
 * the run: a robber's clock is budgeted off `difficulty.slack`, so the same getaway is a harder
 * drive on delivery forty than on delivery three. Hanging a second knob off the same ramp would
 * make the event's difficulty a product of two curves neither of which could then be read on its
 * own — the trap `difficulty.md` describes as a survival curve going flat against every knob
 * because none of them was the one doing the work.
 */
const POLICE_CARS = POLICE_FLEET;

/**
 * How far a cop may fall behind before it is taken off the road and sent in again, in world units.
 *
 * **This is what makes the chase read, and it exists because the honest version cannot.** A cop
 * cruises at 20.4 against a boosting taxi's 22.1, and that is its *ceiling* — cornering and
 * queueing put its mean over a getaway at about 9, against the taxi's 27. Measured over 40 seeds,
 * a cop simply left to drive after the taxi is 28 units back at the median and still falling. The
 * arithmetic does not care how the route is planned: a pursuer three times slower than its quarry
 * does not stay in the picture, and one that is not in the picture is not a chase.
 *
 * So a cop that has lost the taxi does what a police force would: it stops being that car, and
 * another one joins ahead. `leavePolice` takes it off the map and `enterPolice` brings a fresh one
 * in off screen — which is exactly the machinery the event already uses to start, so this is a
 * re-entry rather than a new mechanic.
 *
 * 56 units, which is just past `SPAWN_CLEARANCE` — the 50 this file's sibling already uses for
 * "far enough that the player does not watch it happen". A cop is therefore only ever retired
 * somewhere off screen, which matters: a car vanishing in the mirror is the repaint's own bug
 * wearing a different hat.
 *
 * Swept against 72 and 52 over 40 seeds. 72 leaves the fleet strung out — the furthest cop sits at
 * a median of 65 and the recycle fires on under a quarter of frames — and 52 buys nothing over 56
 * while cutting into the margin that keeps a retirement out of sight. At 56 there is a cop in
 * frame for **89%** of a getaway against 85% at 72, and two of them at a time rather than 1.8.
 */
export const LOST_RANGE = 56;

/**
 * Seconds between re-entries, so the stream is a stream rather than a wall.
 *
 * Without it, four cops that all fall behind on the same straight are all replaced on the same
 * frame and arrive as a rank. Spaced, they come into view one at a time, which is what a pursuit
 * looks like from the car in front.
 */
const REENTRY_GAP = 1.1;

/**
 * How far a cop has to get from the taxi after the event before it leaves the map, in world units.
 *
 * **A getaway used to end with every cop car blinking out of existence**, including whichever ones
 * were in frame at the drop-off — which is the same failure the repaint had at the other end of the
 * event, and just as bad: a car the player is looking at should not stop existing. So the drop-off
 * stands the police *down* rather than deleting them. They lose the chase, lose their route, and
 * drive off as ordinary traffic; each one leaves the map only once it is this far away.
 *
 * Deliberately further out than `LOST_RANGE`. A cop being recycled mid-chase is replaced by another
 * a moment later, so the bar only has to be past the frame; one standing down is gone for good, and
 * the player has time to watch it go. 90 units is four and a half blocks, which on this camera is
 * most of the way to the map edge.
 */
export const STAND_DOWN_RANGE = 90;

/**
 * Seconds before a cop that has not managed to get clear is taken off anyway.
 *
 * The backstop, and it needs one: a cop standing down is ordinary traffic, so it can end up queued
 * behind a red two blocks from a taxi that has itself stopped at a kerb, and neither of them is
 * going anywhere. Without this the fleet would sit there indefinitely — and `setCarCount` refuses
 * to grow the city while any police are out, so the density ramp would stall behind it too.
 *
 * Twelve seconds is long enough that the ordinary case (a cop driving away down a clear street at
 * cruise, 8.5 u/s, covering the 90 units in about eleven) resolves on its own, and short enough
 * that the pathological case is over before the next fare is delivered.
 */
export const STAND_DOWN_TIMEOUT = 12;

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
    /** Seconds since a cop last came onto the map — see REENTRY_GAP. */
    sinceEntry: 0,
    /** Seconds since the last event ended, while its cop cars are still driving off. */
    standingDown: 0,
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
   * **Half of them are still sent at the taxi itself**, which is the `0`s here, and that is not a
   * hedge — it is the half the player actually sees. A cop aimed three junctions down the road is
   * doing the useful work and is usually somewhere off to the side doing it; a cop aimed at the
   * taxi is *behind* the taxi, in the mirror, on the same straight, which is what a chase looks
   * like from the driver's seat. The first version sent every car to a cut-off and the getaway
   * read as an empty road with the occasional cop appearing at a junction.
   *
   * What makes the stern half viable now — and it was not, before — is that a cop which loses the
   * taxi is taken off the map and another comes in behind (see `LOST_RANGE`). Left to drive, a
   * pursuer three times slower than its quarry simply recedes; recycled, the road behind the taxi
   * keeps refilling.
   *
   * For the two that do cut off: a block is ~2.3s at ordinary cruise and about 0.75s at the Loco
   * top, so aiming at the next junction lands the cop behind the taxi again and aiming ten ahead
   * puts it somewhere the run may never reach. Three and five straddle the band where a cop a
   * block or two off to the side arrives while the taxi is still coming, and being different
   * seeds the road rather than barricading one point of it.
   */
  const CUT_OFF_AHEAD = [0, 0, 3, 5];

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
    // Zero steps is the taxi's own junction: a stern chase, deliberately. See CUT_OFF_AHEAD.
    if (steps <= 0 || !route?.length) return { i: taxi.i, j: taxi.j };
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
    state.sinceEntry = 0;
    state.standingDown = 0;
    // Anything still driving off from the last event goes now rather than being adopted by this
    // one — it has no chase and no route, so it would sit in the fleet as a cop that never
    // converges and never leaves. The cooldown makes this all but unreachable; it is here because
    // "all but" is not a guarantee.
    traffic.clearPolice();
    // The traffic first, so the police are already on the road on the frame the player looks up
    // from the crystal appearing over their roof. They come in off screen near the bank —
    // `enterPolice` in sim/traffic.js owns where, and why "near the bank" and "off screen" have to
    // be traded off against each other.
    traffic.enterPolice(POLICE_CARS, site.door);
    // `onBoard` first, and the order matters now. It is what dispatches the taxi to the getaway
    // (main.js), so it is what puts a route on the car — and the police are sent to junctions on
    // *that* route. Aiming before it ran left the whole set converging on the taxi's own junction
    // until it next crossed one, which is the stern chase this event was just taken off.
    onBoard(fare);
    // Pointed down the getaway on the frame they arrive rather than on the next tick, so the road
    // is already filling up as the robber is still getting in.
    steerChase();
  }

  /**
   * The event is over: stand the police down.
   *
   * They are **not** deleted here. Every cop loses its chase and its route and carries on as
   * ordinary traffic, and `driveOff` takes each one off the map once it is out of sight — see
   * `STAND_DOWN_RANGE`. That is the whole difference between a getaway that ends and one where
   * four cars blink out in front of the player.
   */
  function stop() {
    if (!state.active) return;
    state.active = false;
    state.since = 0;
    state.standingDown = 0;
    aimedAt = null;
    // The corner of the map furthest from the taxi, worked out once: every cop is sent there, so
    // they leave *together and away*, which is both how a police response actually disperses and
    // the only version that reliably gets them out of shot.
    const out = {
      i: taxi.i > GRID_I / 2 ? 0 : GRID_I,
      j: taxi.j > GRID_J / 2 ? 0 : GRID_J,
    };
    for (const cop of traffic.policeCars) {
      cop.chase = 0;
      // **Routed out rather than simply unrouted**, and the difference is not cosmetic. A car with
      // no route rolls the ordinary dice at every junction, so a "departing" cop wanders — it
      // circles the block the taxi is parked on as often as it leaves, and then the backstop below
      // deletes it in full view. Measured: with the route cleared instead of replaced, the nearest
      // departure was **5 units** from the taxi, which is the exact failure standing them down was
      // supposed to fix. Given somewhere to be, they drive there.
      const route = findRoute(planOrigin(cop), out);
      cop.route = route ?? [];
      cop.routeConsumed = false;
    }
  }

  /**
   * Take the stood-down cops off the map as they get clear, and give up on the stragglers.
   *
   * Runs on every frame there are police but no event. `leavePolice` only takes the last car in the
   * fleet, so this walks from the tail — the same reason `clearPolice` does.
   */
  function driveOff(dt) {
    state.standingDown += dt;
    // **The bar relaxes with the backstop; it never disappears.** Past the timeout a cop only has
    // to be out of frame rather than four blocks away — but `SPAWN_CLEARANCE` is a floor under it
    // whatever happens, because "a car the player is watching does not blink out" is the rule this
    // whole phase exists to keep, and a backstop that broke it would be worse than no backstop.
    // The route out (see `stop`) is what makes the floor reachable rather than a deadlock.
    const bar = state.standingDown >= STAND_DOWN_TIMEOUT ? SPAWN_CLEARANCE : STAND_DOWN_RANGE;
    for (let k = traffic.policeCars.length - 1; k >= 0; k--) {
      const cop = traffic.policeCars[k];
      // A wreck is not going to drive anywhere, and its shell has already been handed to the
      // effects — so it leaves the fleet on distance alone, with no route to wait on.
      if (Math.hypot(cop.x - taxi.x, cop.z - taxi.z) < bar) continue;
      // Only the tail can go, so a cop that is clear but not last waits its turn — at most a
      // frame each, since the ones behind it are being tested on the same pass.
      if (k === traffic.policeCars.length - 1) traffic.leavePolice(cop);
    }
    // Out of route and still hanging about: point it at the edge again. Its first plan is spent
    // by the time it reaches the corner, and an unrouted car rolls dice.
    if (state.standingDown >= STAND_DOWN_TIMEOUT) {
      for (const cop of traffic.policeCars) {
        if (cop.route?.length || cop.crashed) continue;
        const out = {
          i: cop.i > GRID_I / 2 ? 0 : GRID_I,
          j: cop.j > GRID_J / 2 ? 0 : GRID_J,
        };
        const route = findRoute(planOrigin(cop), out);
        if (route?.length) { cop.route = route; cop.routeConsumed = false; }
      }
    }
  }

  /**
   * Retire the cops that have lost the taxi, and send the same number in again.
   *
   * See `LOST_RANGE`. `leavePolice` will only take the **last** car in the fleet, because anything
   * else is a hole in the middle of an instance buffer — so a cop that is to be retired is first
   * swapped to the tail of `policeCars`. That swap is safe for exactly the reason the tail rule
   * exists: the police are a contiguous block at the end of `ambient`, so exchanging two of them
   * only ever moves police indices past each other.
   */
  function recyclePolice(dt) {
    state.sinceEntry += dt;
    if (state.sinceEntry < REENTRY_GAP) return;

    const fleet = traffic.policeCars;
    // The furthest-gone first, and one per tick: the gap is what turns four simultaneous
    // replacements into a stream arriving one at a time.
    let worst = -1;
    let worstD = LOST_RANGE;
    for (let k = 0; k < fleet.length; k++) {
      const cop = fleet[k];
      const d = Math.hypot(cop.x - taxi.x, cop.z - taxi.z);
      // A crashed cop is off the road as far as the player is concerned and will never close
      // again, so it is always a candidate however near it stopped.
      if (cop.crashed || d > worstD) { worst = k; worstD = cop.crashed ? Infinity : d; }
    }
    if (worst === -1) return;

    // Swap to the tail, retire, replace.
    const last = fleet.length - 1;
    const tailCar = fleet[last];
    fleet[last] = fleet[worst];
    fleet[worst] = tailCar;
    // ...and the same swap in `ambient`, which is the array the instance indices actually name.
    // `policeCars` is only a view; moving a car within it changes nothing about what is drawn.
    traffic.swapAmbient(fleet[last], tailCar);
    if (!traffic.leavePolice(fleet[last])) return;
    state.sinceEntry = 0;
    // **Behind the taxi**, which is the whole point of recycling rather than simply letting a cop
    // trail away. A replacement dropped on a ring around the player is as likely to turn up beside
    // them or in front; dropped behind, it comes into frame in the mirror on the straight they are
    // already driving, and the road behind a getaway keeps refilling.
    traffic.enterPolice(1, taxi, { behind: true });
    // A fresh cop has no route, and the aim is keyed on the taxi not having moved — so without
    // this it would wait for the taxi to cross a junction before it was ever pointed anywhere.
    aimedAt = null;
  }

  function update(dt) {
    state.since += dt;

    if (state.active) {
      // The event ends when the robber does, whichever way that went: delivered, clock run out
      // (they bail — see the timeout branch in game/fares.js), or the run over. All three land here
      // as the same fact, which is why this is a poll on the fare loop rather than three callbacks
      // that each have to remember to take the cars off.
      if (!fares.robbing()) { stop(); return; }
      // Top the fleet up first: a saturated network can leave `enterPolice` short, and a robbery
      // that opened with three cop cars should not run with three for the whole getaway.
      if (traffic.policeCars.length < POLICE_CARS && state.sinceEntry >= REENTRY_GAP) {
        if (traffic.enterPolice(1, taxi, { behind: true })) {
          state.sinceEntry = 0;
          aimedAt = null;
        }
      }
      recyclePolice(dt);
      steerChase();
      return;
    }

    // Left over from the event that just ended, driving themselves off the map.
    if (traffic.policeCars.length) driveOff(dt);

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
     *
     * **Immediate, unlike `stop`.** A drop-off stands the police down and lets them drive away
     * because the player is watching; a wreck puts a retry screen over the city, so there is
     * nobody to watch them go and nothing to be gained by animating it.
     */
    abandon() {
      stop();
      traffic.clearPolice();
    },
  };
}
