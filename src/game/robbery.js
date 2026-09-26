import {
  GRID_I, GRID_J, LANE, dirSign, dirYaw, halfRoadX, halfRoadZ, isXAxis, laneOffsetFor, leftOf,
  lineX, lineZ, opposite, rightOf,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { URGENCY_SEGMENTS, urgencyLevel } from './urgency.js';
import { findRoute, findRouteOnto, planOrigin } from './route.js';
import {
  CAR_LEN, CIRCLE_OFFSET, CIRCLE_R, POLICE_FLEET, SPAWN_CLEARANCE, plannedTurn, stopDistance,
  turnPointAt,
} from '../sim/traffic.js';

// The bank robbery: the empty taxi drives past the bank, somebody gets in with a bag, and the
// streets fill with police for as long as it takes to get them where they are going.
//
// **It is the existing loop turned up, not a new one**, and that is a constraint rather than a
// description. Nothing here invents a mechanic:
//
//   - The robber is an ordinary fare that skipped the kerb — `spawnRobber` in game/fares.js. Same
//     crystal, same ring, same band of paint, same arrival test, same payout flight. What differs
//     is the clock (generous, so there is time to play with the police) and a bonus that reads it at the drop-off.
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
//     past the traffic and risk the wreck, or hold off and risk the clock. The one thing the event
//     does to it is fill it when the robber gets in (`onBoard` in main.js), so that choice is
//     always there to make rather than decided by whatever the meter held at the bank.
//   - The fail state is untouched. Crashing into a cop car is crashing into a car —
//     sim/collisions.js does not know what livery anything is wearing and is not told.
//   - **And they get in your way.** A cop crossing a junction on the taxi's route stops across it
//     (`holdRoadblocks` below), and one that catches the taxi goes round it and brake-checks it
//     (sim/traffic.js). Both are a car braking — the same `braking` a stunned car uses — so the
//     taxi meets them on the terms it meets everything: wait, go round, or ram it for a bump that
//     costs hit points.
//
// So the whole of this module is a trigger, a cooldown, and the bookkeeping that keeps the police
// near — and in front of — the player while it runs.

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
 * itself (`ROBBER_DROPOFF_SPREAD` in game/fares.js), and that one is a design choice rather than a
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
 * than a fast one (see ROBBER_DROPOFF_SPREAD in game/fares.js). At 4 it buys back 0.8 of a fare at a
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
 * A shade further out than `LOST_RANGE`, and for a different reason: a cop being recycled mid-chase
 * is replaced by another a moment later, where one standing down is gone for good, so it is worth a
 * little extra margin that nobody catches it going.
 *
 * It is **not** worth a lot of extra margin, which the first cut got wrong. At 90 units — four and
 * a half blocks — a stood-down cop driving away at ordinary cruise takes eleven seconds to qualify,
 * so it was the `STAND_DOWN_TIMEOUT` backstop that retired most of them rather than the distance,
 * and the police hung around long after the event they belonged to. 62 is three blocks: clear of
 * the frame by a quarter of a block and reached in about seven seconds.
 */
export const STAND_DOWN_RANGE = 62;

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

/**
 * How many junctions down the taxi's route a cop may throw a roadblock across.
 *
 * The cut-off cops are sent three and five ahead (`CUT_OFF_AHEAD`), so this is the band where they
 * actually arrive. Further out than that the taxi is a long way from arriving and the hold would
 * run out first — see `BLOCK_REACH`, which is the tighter of the two in practice. Four, up from
 * three, loosened along with `BLOCK_REACH` and `BLOCK_GAP` to make roadblocks more common: the three
 * together moved them from 33 to 38 over 60 staged getaways (`tools/probe.mjs` with the box-in
 * loop at 60). Small, because the gate that binds is none of these — it is whether a cop happens to
 * be crossing the route at all, and routing the cut-off cops in from a side street to make them
 * cross moved it by nothing (37).
 */
const BLOCK_AHEAD = 4;

/**
 * How near the taxi has to be, in world units of Manhattan distance, for a cop crossing one of
 * those junctions to stop in it.
 *
 * A roadblock the taxi never reaches is a cop parked in a junction for no reason, holding the
 * city's cross traffic. Three blocks: about seven seconds at ordinary cruise, which is past
 * `BLOCK_HOLD` on its own but inside it once `PAIR_WAIT` is added — and one that has stopped or
 * turned off lets it go (`holdRoadblocks`). Was 50; see `BLOCK_AHEAD`.
 */
const BLOCK_REACH = 60;

/**
 * How near is too near, for the same measure.
 *
 * A taxi inside its own stopping distance of the line has in effect already entered: off the pill
 * it is committed to the box, and the sim has no collision test for a taxi that is not boosting, so
 * a cop stopping across it then would be two cars drawn through each other. The hold line is 7.4
 * from the junction's centre and the lane 2 off it, and an ordinary brake from cruise takes 2.1
 * units — so 12 is the nearest a taxi can be and still be asked to stop.
 */
const BLOCK_NEAR = 12;

/**
 * The longest a cop stands across a junction, in seconds.
 *
 * It is let go sooner the moment the junction stops being on the taxi's way — driven through,
 * rammed through or routed round — so this is only the bound on a taxi that sits and waits. Five
 * seconds is a cost against a robber's clock without being a wall — the clock is budgeted at 60%
 * or more over the driving (ROBBER_SLACK_FACTOR in game/fares.js), so waiting is always an answer,
 * it just eats into the bonus. The other two answers are to route round it and to ram it.
 */
const BLOCK_HOLD = 4;

/**
 * How close to the blocking line — the centreline of the road the taxi is on, see
 * `acrossPoint` — a cop's path through the junction has to come for it to count as across it, in
 * world units.
 *
 * A cop turning right from the far side of a junction sweeps its own corner and never comes near
 * the taxi's approach lane, and stopping it there would be a cop parked in a corner looking busy.
 * One unit is under a third of a body length off the lane's centre line, so anything inside it is
 * a car the taxi cannot get past in its own lane.
 */
const BLOCK_ACROSS = 1;

/**
 * Seconds from one roadblock going up to the next being allowed, and only one standing at a time.
 *
 * Without either, a getaway was a string of them. Measured over 12 staged events with a taxi that
 * drives its route off the pill and never re-routes: 42 roadblocks in 360 seconds, one standing
 * for 40% of the event, and the taxi stopped behind one for a quarter of it — against 18% of the
 * time stopped *at all* with no roadblocks. That is a city that has been shut, not a chase.
 * Spaced out, a block is an event the player meets and answers rather than the weather. Was 8,
 * and cut to 5 to make them more common (see `BLOCK_AHEAD`); still one standing at a time.
 */
const BLOCK_GAP = 5;

/**
 * How far from a roadblock, in world units of Manhattan distance, a second cop may be summoned
 * to stand beside it. At 50 a third of roadblocks had nobody in range; at 80 it is about one in
 * five. The cost is arrival: a partner from that far takes longer than `BLOCK_HOLD` plus
 * `PAIR_WAIT`, and roughly half of the summoned arrive after the first cop has been let go.
 */
const PAIR_REACH = 80;

/**
 * Extra seconds the first cop holds once a partner has been sent for, so the partner has a box to
 * arrive at. Only granted when one is actually on its way.
 */
const PAIR_WAIT = 3;

/**
 * Daylight a partner keeps from the cop it joins, beyond the two collision circles touching. The
 * plan is a prediction: a cop braking from chase speed lands a frame's travel either side of its
 * point, and the diagonal it swings to is latched off its heading on the frame the brake goes on.
 * Planned with no margin, the pair stood 0.53 into each other (measured).
 */
const PAIR_MARGIN = 0.6;

/** How far past its planned point a partner is also checked standing, for the same reason. */
const PAIR_OVERSHOOT = 0.75;

/** Two car bodies — `{ x, z, yaw }`, the circles sim/collisions.js tests — at least `margin` apart. */
function apart(a, b, margin) {
  const reach = 2 * CIRCLE_R + margin;
  for (const sa of [1, -1]) {
    for (const sb of [1, -1]) {
      const dx = (b.x + sb * Math.cos(b.yaw) * CIRCLE_OFFSET)
        - (a.x + sa * Math.cos(a.yaw) * CIRCLE_OFFSET);
      const dz = (b.z - sb * Math.sin(b.yaw) * CIRCLE_OFFSET)
        - (a.z - sa * Math.sin(a.yaw) * CIRCLE_OFFSET);
      if (dx * dx + dz * dz < reach * reach) return false;
    }
  }
  return true;
}

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
 * @param busy     `() => boolean` — true while the patrol cruiser is chasing somebody in traffic
 *                 (game/pursuit.js). A robbery waits it out: it would bring four cars in the same
 *                 paint onto a street with a pursuit already on it, and `raiseAlarm` clears the
 *                 fleet it inherits, which would delete the patrol car in front of the player.
 * @param holdAlarm  true to board the robber *without* the police, and wait for `raiseAlarm()`.
 *                 main.js holds it for the robber's line (game/robberline.js): the world stops, the
 *                 robber shouts, and the cops arrive on the tap that clears it. False — the tools'
 *                 default — raises it on the same frame, as it always did.
 */
export function createRobbery({
  site, taxi, fares, traffic, onBoard = () => {}, holdAlarm = false, busy = () => false,
}) {
  // The junction the bank's door belongs to, worked out once: the city does not move, and this is a
  // thirty-six-cell scan.
  const junction = nearestJunction(site.door.x, site.door.z);

  const state = {
    /** Is one running right now? */
    active: false,
    /** ...and are the police out for it yet? Lags `active` by the robber's line — see holdAlarm. */
    alarmed: false,
    /** Sim seconds since the last one ended. Starts clear, so the gates below are the only bar. */
    since: COOLDOWN,
    /** Seconds since a cop last came onto the map — see REENTRY_GAP. */
    sinceEntry: 0,
    /** Seconds since the last event ended, while its cop cars are still driving off. */
    standingDown: 0,
    /** How many have happened this run, for the tools. */
    count: 0,
    /** How many junction roadblocks the police have thrown this run, for the tools. */
    roadblocks: 0,
    /** Seconds since a roadblock last went up — see BLOCK_GAP. Starts clear. */
    sinceBlock: BLOCK_GAP,
    /** How many roadblocks were joined by a second cop, for the tools. */
    pairs: 0,
  };

  // The cop summoned to stand beside the current roadblock, and the one it is joining. At most one
  // of each, because only one roadblock stands at a time.
  let partner = null;
  let partnerLead = null;

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
   * What it deliberately does **not** do is give a cop an unfenced licence. It does not ignore
   * queues, and it cannot be crashed into by anything but the player — `sim/collisions.js` only
   * ever tests the taxi. A cop let through a red would drive *through* the cross traffic rather
   * than into it, which is the trap `releaseCar` already records; the one red it may cross is a
   * provably empty junction (sim/traffic.js), and the roadblock below is fenced the same way.
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
      // Not while it is out overtaking the taxi. The pass was only offered because this route
      // carried straight on (sim/traffic.js), and a re-aim mid-manoeuvre handed it a turn with the
      // cop still in the oncoming lane — frozen out there through the corner, and cutting back in
      // on the far side across whatever was coming. It is re-aimed on the next junction instead.
      if (car.pass > 0) continue;
      // Nor while it is on its way to join a roadblock: its route is `summonPartner`'s.
      if (car.summoned) continue;
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

  /**
   * The junctions the taxi is about to drive through, nearest first — the one its lane runs into,
   * then `BLOCK_AHEAD` more down its route — each with the heading the taxi will enter it on.
   *
   * A taxi mid-turn is *inside* `taxi.i/j` already, and its route has had that turn taken off the
   * front, so the next junction is one step along `dOut` rather than along `route[0]`.
   */
  function upcoming() {
    let { i, j } = taxi;
    const out = [{ i, j, enter: taxi.d, inside: taxi.state === 'turn' }];
    const steps = [];
    if (taxi.state === 'turn' && taxi.dOut != null) steps.push(taxi.dOut);
    for (const d of taxi.route ?? []) steps.push(d);
    for (let k = 0; k < Math.min(BLOCK_AHEAD, steps.length); k++) {
      const d = steps[k];
      if (isXAxis(d)) i += dirSign(d); else j += dirSign(d);
      out.push({ i, j, enter: d, inside: false });
    }
    return out;
  }

  /**
   * Where on its turn a cop has to stop to be standing across the taxi's road, or null if its path
   * never comes near the middle of it.
   *
   * On the centreline of the road the taxi enters by, so the cop skids to rest across both lanes:
   * swung to 45° (SLEW_* in sim/traffic.js) the body is 3.6 across, 1.8 either side of the middle.
   * It used to stop halfway between the taxi's lane and the centreline, which covered the taxi's
   * lane and 0.8 of the other and read as a cop parked askew in one lane. The oncoming half needs
   * no yielding of its own here: the box is held (`heldAt`) while the cop stands in it, so nothing
   * new enters from any arm.
   *
   * Except on an arterial, which keeps the halfway point. Its lane is 3.33 off the middle, so a cop
   * centred on the middle leaves the taxi's flank (2.33 off it) half a unit clear of the body's 1.8
   * and a boosting taxi drives past without touching it; halfway, at 1.67, the body reaches 3.47
   * and the kerb side is 1.86 wide against a 2-unit taxi. Same rule as the brake check's
   * `blocksOnCentreline` in sim/traffic.js.
   *
   * The turn is sampled along the same Bézier the render pass draws it on, so the point found here
   * is where the car is actually drawn.
   */
  function acrossPoint(cop, at) {
    const lane = cityNetwork().laneByGrid(at.enter, at.i, at.j);
    if (!lane) return null;
    const end = lane.path.at(lane.length);
    const centre = isXAxis(at.enter) ? lineZ(at.j) : lineX(at.i);
    const laneLine = isXAxis(at.enter) ? end.z : end.x;
    const mid = laneOffsetFor(at.enter, at.i, at.j) <= LANE + 1e-9 ? centre : (laneLine + centre) / 2;
    const offLine = (p) => (isXAxis(at.enter) ? p.z - mid : p.x - mid);
    let best = null;
    // The start excluded, and the last third: a stop late in the arc has the car's nose out of the
    // box and in its exit lane, where the lane bookkeeping lists it only as a phantom short of the
    // lane's start — a car was measured landing on a cop stopped at 0.84 of a right turn.
    for (let n = 1; n <= 11; n++) {
      const p = turnPointAt(cop, n / 16);
      const off = Math.abs(offLine(p));
      if (!best || off < best.off) best = { off, travelled: p.travelled };
    }
    return best && best.off <= BLOCK_ACROSS ? best.travelled : null;
  }

  /**
   * **Stop across the junction the taxi is about to drive through.** The box-in's junction half;
   * the other half — a cop overtaking the taxi and brake-checking it — lives in sim/traffic.js,
   * because it needs the lane bookkeeping only the sim has.
   *
   * A cop already crossing a junction on the taxi's way, with the taxi near enough to arrive while
   * it holds, brakes so that it comes to rest across the taxi's lane and holds there on
   * `roadblock`. Nothing else is needed to make it a roadblock, which is the point of doing it this
   * way: a car braking inside a box is already what the sim calls a stranded junction (`heldAt`),
   * so the cross traffic is held, a taxi off the pill is refused entry at its line exactly as it
   * would be by a stalled car, and a boosting one barges through — into the cop, which is a bump
   * that costs hit points (sim/collisions.js) and the wreck once they are gone.
   *
   * Let go the moment the junction stops being on the taxi's way (driven or rammed through,
   * routed round) or after `BLOCK_HOLD`, whichever is first. A cop only ever blocks a given
   * crossing once, so one that has been let go carries on through rather than stopping again a
   * frame later.
   */
  function holdRoadblocks(dt) {
    state.sinceBlock += dt;
    const path = upcoming();
    const onPath = new Map(path.map((at) => [`${at.i},${at.j}`, at]));
    for (const cop of traffic.policeCars) {
      if (cop.crashed) continue;
      if (cop.blocking) {
        // Out of the box is out of the roadblock, however it got there. A partner goes when the
        // cop it joined does — they were stood down on the same clock — but not until that cop
        // has driven out of the box: its path out was checked clear of the partner, the
        // partner's path on was not checked against the first cop's stopping point.
        const lead = cop.partnerOf;
        const over = !onPath.has(cop.blocking) || cop.roadblock <= 0 || taxi.crashed
          || cop.state !== 'turn' || (lead != null && !lead.blocking);
        if (over && lead && cop.state === 'turn' && inBox(lead, cop.blocking)) {
          cop.roadblock = Math.max(cop.roadblock, 2 * dt);
        } else if (over) {
          cop.roadblock = 0;
          cop.blocking = null;
          cop.partnerOf = null;
        }
        continue;
      }
      if (cop.summoned) continue;
      if (cop.state !== 'turn') { cop.blockSpent = null; continue; }
      const key = `${cop.i},${cop.j}`;
      if (cop.blockSpent === key || cop.roadblock > 0) continue;
      if (state.sinceBlock < BLOCK_GAP
        || traffic.policeCars.some((other) => other.blocking)) continue;
      const at = onPath.get(key);
      // The taxi already in the box has driven past the point a block could stop it.
      if (!at || at.inside) continue;
      // Straight through against the taxi's own heading is the other carriageway: it never
      // crosses the taxi's lane, so there is nothing for it to block.
      if (cop.turn?.hand === 'straight' && cop.d === opposite(at.enter)) continue;
      // Nor anything out of the taxi's own lane, whichever way it goes: that is a car *in front
      // of* the taxi, not across it, and the lane bookkeeping handles it badly stopped in a box.
      // It counts a crossing as 5 units of lane for an 8-unit junction, so a taxi following a cop
      // that stops dead in the middle closes to 2.2 units centre to centre (measured, 3 events in
      // 12), and a cop turning off is handed to its exit lane part way round — after which it is a
      // car the taxi no longer sees, stopped on the corner of the lane it is about to drive through.
      // The cop that stops in front of the taxi in its own lane is the brake check's job
      // (sim/traffic.js), and that one happens on a lane, where the bookkeeping is exact.
      if (cop.d === at.enter) continue;
      // Nor half way through an overtake: the swing is frozen through a corner, so the body is
      // drawn off the arc this point is measured on.
      if (cop.pass > 0) continue;
      const reach = Math.abs(lineX(at.i) - taxi.x) + Math.abs(lineZ(at.j) - taxi.z);
      if (reach > BLOCK_REACH || reach < BLOCK_NEAR) continue;
      const stopAt = acrossPoint(cop, at);
      const travelled = cop.turnT * cop.turnLen;
      if (stopAt == null || travelled > stopAt) { cop.blockSpent = key; continue; }
      // Brake on the frame the remaining road equals the stopping distance, so it comes to rest
      // on the point rather than short of it or through it.
      if (travelled + stopDistance(cop.v) < stopAt) continue;
      // Not into a box something else is already crossing. The hold keeps anyone new out, but a
      // car already committed to its turn cannot be asked to stop, and it drives through a cop
      // that has stopped across its path — traffic is never collision-tested against traffic.
      if (traffic.cars.some((other) => other !== cop && !other.crashed && other.state === 'turn'
        && other.i === cop.i && other.j === cop.j)) continue;
      // Nor one a car has only just left, with its tail still in the box. It is a lane's car by
      // then, not a turning one, so the test above lets it by — and with the cop now braking onto
      // the centreline its arc swept the oncoming exit behind a car pulling out of it: 7 frames
      // deep by up to 0.92 on `tools/probe.mjs 8`, the only overlap across seeds 1-8.
      const cx = lineX(cop.i);
      const cz = lineZ(cop.j);
      if (traffic.cars.some((other) => other !== cop && !other.crashed
        && Math.abs(other.x - cx) < halfRoadZ(cop.i) + CAR_LEN / 2
        && Math.abs(other.z - cz) < halfRoadX(cop.j) + CAR_LEN / 2)) continue;
      cop.roadblock = BLOCK_HOLD;
      cop.blockAxis = at.enter;
      cop.blocking = key;
      cop.blockSpent = key;
      cop.partnerOf = null;
      state.roadblocks += 1;
      state.sinceBlock = 0;
      summonPartner(cop, at);
    }
    pairUp(onPath);
  }

  /** A car's heading part way round a turn — the same easing the render pass draws it with. */
  function turnYaw(d, dOut, t) {
    const a = dirYaw(d);
    const delta = ((dirYaw(dOut) - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return a + delta * t;
  }

  /** Is this car still inside the junction `key`, on its arc? */
  const inBox = (car, key) => !car.crashed && car.state === 'turn' && `${car.i},${car.j}` === key;

  /** Call a summoned cop off: it goes back to the chase on the next re-aim. */
  function dismiss(cop) {
    cop.summoned = null;
    cop.joinBlock = null;
    cop.partnerStop = null;
    if (partner === cop) { partner = null; partnerLead = null; }
    aimedAt = null;
  }

  /**
   * **Send a second cop to the roadblock that just went up**, so the two of them stand across both
   * halves of the road. One 45° body is 3.6 across against an 8-unit street and a 10.67 arterial,
   * so a lone cop only ever closes part of it — on a street it stands on the centreline and
   * leaves 2.2 at each kerb, on an arterial it stands across the taxi's half.
   *
   * The nearest free cop within `PAIR_REACH` is routed *through* the junction rather than to it:
   * a route that ends at a junction leaves the car rolling the ordinary dice there, and the
   * partner's stop is planned off the turn its route calls for (`pairUp`). Straight on first, since
   * a straight crossing is the one that sweeps the whole width of the taxi's road; then either
   * turn. Never a cop arriving down the taxi's own lane — that is the taxi's following car, and
   * the lane bookkeeping handles a car stopped in front of it badly (see `holdRoadblocks`).
   */
  function summonPartner(lead, at) {
    const J = { i: at.i, j: at.j };
    const jx = lineX(J.i);
    const jz = lineZ(J.j);
    const free = traffic.policeCars
      .filter((c) => c !== lead && !c.crashed && !c.blocking && !c.passing && c.pass === 0
        && c.roadblock === 0 && c.state === 'drive')
      .map((c) => ({ c, d: Math.abs(c.x - jx) + Math.abs(c.z - jz) }))
      .filter((e) => e.d <= PAIR_REACH)
      .sort((a, b) => a.d - b.d);
    for (const { c } of free) {
      const from = planOrigin(c);
      // Onto the junction down any arm but the taxi's own, shortest first.
      let best = null;
      for (const last of [0, 1, 2, 3]) {
        if (last === at.enter || !cityNetwork().laneByGrid(last, J.i, J.j)) continue;
        // `findRouteOnto` answers a lap for a car already on that lane (see CLAUDE.md) — and the
        // nearest free cop is often exactly that, already on its way in.
        const toJ = from.i === J.i && from.j === J.j && from.d === last
          ? [] : findRouteOnto(from, J, last);
        if (toJ && (!best || toJ.length < best.toJ.length)) best = { toJ, last };
      }
      if (!best) continue;
      const { toJ, last } = best;
      for (const e of [last, leftOf(last), rightOf(last)]) {
        const nb = {
          i: J.i + (isXAxis(e) ? dirSign(e) : 0),
          j: J.j + (isXAxis(e) ? 0 : dirSign(e)),
        };
        if (nb.i < 0 || nb.i > GRID_I || nb.j < 0 || nb.j > GRID_J) continue;
        const onward = findRoute({ i: J.i, j: J.j, d: last }, nb);
        if (onward?.[0] !== e) continue;
        c.route = [...toJ, ...onward];
        c.routeConsumed = false;
        c.summoned = lead.blocking;
        lead.roadblock += PAIR_WAIT;
        partner = c;
        partnerLead = lead;
        return;
      }
    }
  }

  /**
   * Where on its planned arc a partner should stop, or null if there is nowhere safe.
   *
   * The line it stops on is the other half of the road from the first cop: a cop on the
   * centreline (an ordinary street) is joined on either lane's centre, a cop off it (an arterial,
   * halfway to the taxi's lane) on its mirror image. The stop is the first point on the arc near
   * one of those lines that is `PAIR_CLEAR` from the first cop *and* from every point of the first
   * cop's own way out of the box, and the arc up to it has to stay that clear too — nothing
   * between two cops is collision-tested, so anything short of that is one drawn through the
   * other. Sampled to the same 11/16 of the arc as `acrossPoint`, for the same reason.
   */
  function partnerStop(g, lead, at, d) {
    if (!g) return null;
    const x = isXAxis(at.enter);
    const centre = x ? lineZ(at.j) : lineX(at.i);
    const lat = (p) => (x ? p.z : p.x) - centre;
    const aLat = lat(lead);
    const laneOff = laneOffsetFor(at.enter, at.i, at.j);
    const lines = Math.abs(aLat) < 0.5 ? [laneOff, -laneOff] : [-aLat];
    const dOut = cityNetwork().dirOfLane(cityNetwork().laneById.get(g.turn.outLane));
    // Poses in the shape `penetration` reads: the same two circles the taxi is tested with.
    const pose = (car, t) => ({ ...turnPointAt(car, t), yaw: turnYaw(car.d, car.dOut, t) });
    const road = dirYaw(at.enter);
    // A stopped blocker is swung to one of the road's two diagonals. The first cop's is already
    // latched; the partner's is chosen here, as whichever of the two clears (sim/traffic.js
    // latches it off the heading otherwise, and a car crossing square to the road is a tie).
    const diagonals = [road + Math.PI / 4, road - Math.PI / 4];
    const swung = (p, yaws = diagonals) => yaws.map((yaw) => ({ x: p.x, z: p.z, yaw }));
    const hits = (a, b) => !apart(a, b, PAIR_MARGIN);
    const leadAt = swung(lead, lead.slewTarget != null ? [lead.slewTarget] : diagonals);
    const span = lead.turnLen - lead.leadIn;
    const from = Math.max(0, (lead.turnT * lead.turnLen - lead.leadIn) / span);
    const leadOut = [];
    for (let k = 0; k <= 16; k++) leadOut.push(pose(lead, from + (1 - from) * (k / 16)));
    const arc = { ...g, d, dOut };
    for (let n = 1; n <= 22; n++) {
      const p = pose(arc, n / 32);
      if (leadAt.some((q) => hits(p, q))) return null;
      const off = Math.min(...lines.map((l) => Math.abs(lat(p) - l)));
      if (off > BLOCK_ACROSS) continue;
      const past = pose(arc, n / 32 + PAIR_OVERSHOOT / (arc.turnLen - arc.leadIn));
      for (const yaw of diagonals) {
        const stood = [{ x: p.x, z: p.z, yaw }, { x: past.x, z: past.z, yaw }];
        if (stood.some((a) => leadAt.some((q) => hits(a, q)) || leadOut.some((q) => hits(a, q)))) continue;
        // The representative of that diagonal nearest the heading, so it swings the short way.
        const toward = [0, 1, 2, 3].map((k) => yaw + k * Math.PI)
          .reduce((a, b) => (Math.abs(Math.atan2(Math.sin(b - p.yaw), Math.cos(b - p.yaw)))
            < Math.abs(Math.atan2(Math.sin(a - p.yaw), Math.cos(a - p.yaw))) ? b : a));
        return { travelled: p.travelled, yaw: toward };
      }
    }
    return null;
  }

  /**
   * Bring the summoned partner in. On its approach it is planned (`partnerStop`) once the first
   * cop has come to rest, and only a partner with a plan is let into the held box (`joinBlock`,
   * sim/traffic.js); in the box it brakes onto its stop exactly as the first cop did, and holds on
   * the first cop's clock. Called off the moment the first cop is let go before it has entered.
   */
  function pairUp(onPath) {
    const cop = partner;
    if (!cop) return;
    const lead = partnerLead;
    const key = cop.summoned;
    if (!traffic.policeCars.includes(cop) || cop.crashed || !lead || taxi.crashed) {
      dismiss(cop);
      return;
    }
    const at = onPath.get(key);
    if (cop.state === 'drive') {
      if (!lead.blocking || lead.blocking !== key || !at || !inBox(lead, key)) { dismiss(cop); return; }
      if (cop.joinBlock || `${cop.i},${cop.j}` !== key || lead.v > 0.05) return;
      const stop = cop.d === at.enter ? null : partnerStop(plannedTurn(cop), lead, at, cop.d);
      if (stop == null) { dismiss(cop); return; }
      cop.partnerStop = stop.travelled;
      cop.partnerYaw = stop.yaw;
      cop.joinBlock = key;
      return;
    }
    // In a turn. At some other junction on the way it is simply still coming — unless the first
    // cop has been let go meanwhile. In this one it must have been planned: a partner that got
    // into the box without a plan (a green before the first cop settled) just drives on.
    if (`${cop.i},${cop.j}` !== key) {
      if (!lead.blocking || lead.blocking !== key) dismiss(cop);
      return;
    }
    if (cop.partnerStop == null) { dismiss(cop); return; }
    const travelled = cop.turnT * cop.turnLen;
    if (travelled + stopDistance(cop.v) < cop.partnerStop) return;
    cop.roadblock = Math.max(lead.roadblock, 1);
    cop.blockAxis = lead.blockAxis;
    cop.slewTarget = cop.partnerYaw;
    cop.slewLat = 0;
    cop.blocking = key;
    cop.blockSpent = key;
    cop.partnerOf = lead;
    state.pairs += 1;
    dismiss(cop);
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
    // ...and not with a patrol car already after the taxi — see `busy`.
    if (busy()) return false;
    return range() <= TRIGGER_RANGE;
  }

  function start() {
    const fare = fares.spawnRobber(taxi, junction, site.door);
    // `spawnRobber` can still refuse — a full board has no free slot for the figure and the
    // crystal. Nothing is spent when it does: the cooldown has not been reset, so the next pass
    // down the same street tries again.
    if (!fare) return;

    state.active = true;
    state.alarmed = false;
    state.count += 1;
    state.sinceEntry = 0;
    state.standingDown = 0;
    // `onBoard` before the police either way, and the order matters. It is what dispatches the taxi
    // to the getaway (main.js), so it is what puts a route on the car — and the police are sent to
    // junctions on *that* route. Aiming before it ran left the whole set converging on the taxi's
    // own junction until it next crossed one, which is the stern chase this event was taken off.
    onBoard(fare);
    if (!holdAlarm) raiseAlarm();
  }

  /**
   * The police come on. Its own step so main.js can hold it behind the robber's line; everything
   * else about the event — the fare, the clock, the getaway route — is already running by now.
   */
  function raiseAlarm() {
    if (!state.active || state.alarmed) return;
    state.alarmed = true;
    state.sinceEntry = 0;
    // Anything still driving off from the last event goes now rather than being adopted by this
    // one — it has no chase and no route, so it would sit in the fleet as a cop that never
    // converges and never leaves. The cooldown makes this all but unreachable; it is here because
    // "all but" is not a guarantee.
    traffic.clearPolice();
    // The traffic first, so the police are already on the road on the frame the lights come back
    // up after the robber's line. They come in off screen near the bank —
    // `enterPolice` in sim/traffic.js owns where, and why "near the bank" and "off screen" have to
    // be traded off against each other.
    traffic.enterPolice(POLICE_CARS, site.door);
    // Pointed down the getaway on the frame they arrive rather than on the next tick, so the road
    // is already filling up on the first frame the player can drive it.
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
    state.alarmed = false;
    state.since = 0;
    state.standingDown = 0;
    aimedAt = null;
    partner = null;
    partnerLead = null;
    // The corner of the map furthest from the taxi, worked out once: every cop is sent there, so
    // they leave *together and away*, which is both how a police response actually disperses and
    // the only version that reliably gets them out of shot.
    const out = {
      i: taxi.i > GRID_I / 2 ? 0 : GRID_I,
      j: taxi.j > GRID_J / 2 ? 0 : GRID_J,
    };
    for (const cop of traffic.policeCars) {
      // **Bar off first.** The robbery is over on this frame, and a car driving away from a
      // finished scene with its lights still going reads as an event that has not ended — which is
      // most of what "they need to turn off their lights and exit" was. `siren` is separate from
      // `police` for exactly this beat: the car keeps its paint, because that is what it is, and
      // loses the bar, because that is what it was *doing*.
      cop.siren = false;
      cop.chase = 0;
      // Out of any roadblock too. The overtake lets itself go once `chase` is 0; a junction hold
      // is this module's and is let go here, or the stand-down would begin with a cop parked
      // across a box holding the city's traffic for the rest of its `BLOCK_HOLD`.
      cop.roadblock = 0;
      cop.blocking = null;
      cop.partnerOf = null;
      cop.summoned = null;
      cop.joinBlock = null;
      cop.partnerStop = null;
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
      // The patrol cruiser, if it is in traffic chasing somebody, is game/pursuit.js's to retire.
      if (cop.patrol) continue;
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
        if (cop.route?.length || cop.crashed || cop.patrol) continue;
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
      // Boarded, but the robber's line is still up — nobody has called the police yet.
      if (!state.alarmed) return;
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
      holdRoadblocks(dt);
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
    raiseAlarm,
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
