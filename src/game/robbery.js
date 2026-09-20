import { GRID_I, GRID_J, lineX, lineZ } from '../city/grid.js';
import { URGENCY_SEGMENTS, urgencyLevel } from './urgency.js';

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
//     sim/traffic.js. They queue, indicate, stop at reds and can be crashed into exactly like the
//     cars they were a moment before. **There is no pursuit AI of any kind**: not one of them ever
//     steers toward the taxi, and the module that could make them (sim/police.js, the corridor
//     cruiser and its chase) is not touched by any of this.
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
 * **It is not the frequency knob it looks like.** Measured over 30 runs, nearly doubling it moved
 * the count of robberies from 33 to 34 — because the cooldown is not what limits the event. What
 * limits it is the taxi happening to drive past the bank with an empty cab and a calm kerb, which
 * on a five-block city is about once a run either way. The knob that *does* move the event is
 * `CALM_LEVEL` below; see the table on it. What this constant actually buys is the one thing its
 * own sentence says: two robberies can never run into each other.
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
 * Measured with `tools/autoplay.mjs` over 30 paired runs at a 1.5s reaction, against a no-robbery
 * baseline of a 13.9-fare mean on $339:
 *
 * | | mean fares | mean cash | robberies |
 * |---|---|---|---|
 * | no gate | 10.4 | $253 | 33 |
 * | no gate, cooldown near doubled | 11.0 | $266 | 34 |
 * | this gate | **12.6** | **$314** | 23 |
 *
 * The middle row is the finding, and it is why the cooldown is not the knob: raising it barely
 * moved either number, because the cooldown is not what limits the event. What limits it is the
 * taxi happening to drive past the bank with an empty cab, which on a five-block city is about
 * once a run either way.
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
    onBoard(fare);
  }

  /** Hand the cop cars back their own paint and start the clock on the next one. */
  function stop() {
    if (!state.active) return;
    state.active = false;
    state.since = 0;
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
      }
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
