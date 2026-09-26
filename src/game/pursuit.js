import { GRID_I, GRID_J, PITCH, dirSign, isXAxis } from '../city/grid.js';
import { SPAWN_CLEARANCE } from '../sim/traffic.js';
import { findRoute, planOrigin } from './route.js';
import { STAND_DOWN_RANGE, STAND_DOWN_TIMEOUT } from './robbery.js';

// The patrol cruiser's chase, once it is a car in traffic.
//
// Boost within a block of the corridor cruiser and it used to end the run on the spot. Now it
// comes after you (`chase()` in sim/police.js), hands itself to the traffic model as an ordinary
// cop — the same kind of car a bank robbery brings — and this module drives the rest: where it is
// going, whether it has caught you, and when it gives up.
//
// **It is the robbery's chase with one cop in it**, and deliberately so. The robbery already worked
// out what a cop in this city can and cannot do (docs/traffic.md, "Cop cars in ambient traffic"),
// and every one of those findings carries over unchanged:
//
//   - it cruises at 21.7 against a boosting taxi's 22.1, so the pill outruns it and lifting off
//     does not — which makes Loco Mode the answer to being spotted, and the wreck the price;
//   - it queues, stops at reds and yields, bar the one red on a provably empty junction;
//   - it overtakes a slow taxi and brake-checks it (the cop-pass block in sim/traffic.js, which
//     runs for any chasing cop) — and a brake check is exactly how a pursuit pulls you over;
//   - ramming it is a bump that costs hit points, and the last one is the wreck.
//
// What it does *not* borrow is the recycling. A robbery keeps its cops in the picture by retiring
// the ones that fall behind and bringing new ones in behind the taxi, because a getaway is about
// the drive and the police are its weather. A patrol chase is about this one car, and a cop that
// falls out of the picture is the point: that is what outrunning it means.
//
// Three outcomes, each read once a frame:
//
//   - **Caught** — see CATCH_RANGE. The run ends "Busted!", as it always did; it just takes a cop
//     actually getting to you now, and staying on you.
//   - **Lost** — see ESCAPE_BLOCKS. The bar goes dark and the cruiser drives off, the same stand-down
//     a robbery's cops do.
//   - **Given up** — see PURSUIT_MAX. A backstop, and it reads the same as lost.

/**
 * How far ahead, in blocks, the taxi has to get before the cop gives up.
 *
 * Straight-line distance, three blocks: 60 units, which is just past `LOST_RANGE` (56) — the
 * distance the robbery measured as "out of the picture" on a phone at play zoom. So the rule the
 * player learns is the one they can see: get the siren out of frame and you are clear.
 *
 * Distance *between the two cars* rather than distance *driven*, on purpose. "Survive three blocks
 * of driving" would let a cop sitting on your bumper let you go, and would ask nothing of the
 * player but patience; this asks them to actually open a gap, which a boosting taxi can do (mean
 * speed ~27 against a cop's ~9-11 over a robbery) and a cruising one cannot.
 */
export const ESCAPE_BLOCKS = 3;
const ESCAPE_RANGE = ESCAPE_BLOCKS * PITCH;

/**
 * How a cop catches the taxi: by being on it — within CATCH_RANGE, centre to centre — for long
 * enough. It is a meter rather than a line, and it fills at two rates.
 *
 * **A taxi that has stopped with a cop on it fills it in CATCH_TIME** — one second. Queued at a red
 * with the siren behind, pinned behind a brake check, pulled in at a kerb for a fare. One second is
 * long enough that a taxi that stops for a red and immediately boosts through it gets away, and
 * short enough that sitting there does not.
 *
 * **A taxi still moving with a cop on its bumper fills it at TAIL_RATE**, so four seconds of being
 * tailed is an arrest too. This half was not in the first cut and the probe is why it is now: a
 * taxi cruising the ring road — which has no lights, so it never stops — had a cop three to eight
 * units behind it for forty seconds and was then "lost" by the backstop. A cop glued to you is not
 * a cop you have outrun, and the only honest answers to one are the pill or the brake check it is
 * about to give you.
 *
 * Distance alone would bust the wrong things, which is why neither rate is instant: a cop drawing
 * past in the oncoming lane is inside a car length for a beat and has caught nobody, and a taxi
 * rammed into a cop is inside it too — that is a bump, not an arrest. Out of range the meter drains
 * rather than resetting, so a cop that drops back a length for a moment has not started again.
 *
 * 8 units is a car length of daylight either way: a cop queued behind the taxi sits ~5.5 back, one
 * slewed across the road in front of it ~5-6. 4 u/s is a crawl, well under the 8.5 cruise, so a
 * taxi pulling away from a light is not "stopped" on the frame it starts moving.
 */
export const CATCH_RANGE = 8;
export const CATCH_SPEED = 4;
export const CATCH_TIME = 1;
const TAIL_RATE = 0.25;

/**
 * The longest a pursuit runs, in seconds, before the cop is called off anyway.
 *
 * A pursuit with neither car able to reach the other — a cop stuck a block behind a jam, a taxi
 * parked out of reach at a kerb that is behind a closed road — would otherwise hold the siren up
 * for the rest of the run, and the corridor with it: the cruiser does not start another run while
 * this one is still in traffic.
 */
const PURSUIT_MAX = 40;

/**
 * @param police  the patrol cruiser (sim/police.js); its `state.cop` is the traffic car it became
 * @param traffic the sim (sim/traffic.js) — `leavePolice`/`swapAmbient` to take the car off again
 * @param taxi    the player's car
 * @param onCaught `(cop) => void` — the run ends here (main.js stops the taxi and raises "Busted!")
 * @param onLost   `(cop) => void` — the taxi got away
 */
export function createPursuit({ police, traffic, taxi, onCaught = () => {}, onLost = () => {} }) {
  const state = {
    /** The cop running the taxi down, or null. */
    cop: null,
    /** The cop that has given up and is driving off, or null. */
    leaving: null,
    /** The cop that made the arrest, parked with its bar going until the run is over. */
    arrested: null,
    /** Seconds this pursuit has run. */
    elapsed: 0,
    /** The catch meter, in seconds of a cop on a stopped taxi — see CATCH_TIME. */
    held: 0,
    /** Seconds since the leaving cop stood down — see STAND_DOWN_TIMEOUT. */
    standingDown: 0,
    /** Tallies, for the tools. */
    caught: 0,
    lost: 0,
  };

  // Where the chase was last aimed. Keyed on its endpoints and left alone in between — re-planning
  // a route every frame stalls a car at its junction (see CLAUDE.md), which the robbery found out
  // the same way.
  let aimedAt = null;

  /**
   * The junction to send the cop to: the one the taxi is driving into, or — if the cop is already
   * heading into that one itself, which is the stern chase on the taxi's own road — the one after
   * it, along the taxi's route or, with no route, straight on down its road. A route to the
   * junction you are already driving into is empty, and a cop with an empty route rolls the
   * ordinary dice at the junction and wanders off the taxi's tail a beat before it turns.
   */
  function aimFor(cop) {
    const at = { i: taxi.i, j: taxi.j };
    const origin = planOrigin(cop);
    if (origin.i !== at.i || origin.j !== at.j) return at;
    const d = taxi.state === 'turn' && taxi.dOut != null ? taxi.dOut : (taxi.route?.[0] ?? taxi.d);
    if (isXAxis(d)) at.i += dirSign(d); else at.j += dirSign(d);
    return { i: Math.max(0, Math.min(GRID_I, at.i)), j: Math.max(0, Math.min(GRID_J, at.j)) };
  }

  function steer(cop) {
    const key = `${taxi.i},${taxi.j},${taxi.route?.[0] ?? ''}`;
    if (key === aimedAt && cop.route?.length) return;
    // Not while it is out overtaking the taxi: the pass was only offered because this route carried
    // straight on (sim/traffic.js), and a re-aim mid-manoeuvre hands it a turn from the oncoming
    // lane. Same rule as the robbery's.
    if (cop.pass > 0) return;
    const route = findRoute(planOrigin(cop), aimFor(cop));
    if (route?.length) {
      cop.route = route;
      cop.routeConsumed = false;
    }
    aimedAt = key;
  }

  /**
   * Call the cop off: bar dark, chase off, routed to the corner of the map furthest from the taxi.
   * The robbery's stand-down, for one car — see `stop` in game/robbery.js for why each line is
   * there (and why "routed out" rather than "unrouted").
   */
  function standDown(cop) {
    cop.siren = false;
    cop.chase = 0;
    cop.roadblock = 0;
    const out = {
      i: taxi.i > GRID_I / 2 ? 0 : GRID_I,
      j: taxi.j > GRID_J / 2 ? 0 : GRID_J,
    };
    cop.route = findRoute(planOrigin(cop), out) ?? [];
    cop.routeConsumed = false;
    state.cop = null;
    state.leaving = cop;
    state.standingDown = 0;
    aimedAt = null;
  }

  /**
   * Take the cop off the map once it is out of sight — `driveOff` in game/robbery.js, for one car.
   * `leavePolice` only takes the tail of the fleet, so it is swapped there first; that is safe for
   * the reason the robbery's recycling is, since the police are a contiguous block.
   */
  function driveOff(dt) {
    const cop = state.leaving;
    state.standingDown += dt;
    const bar = state.standingDown >= STAND_DOWN_TIMEOUT ? SPAWN_CLEARANCE : STAND_DOWN_RANGE;
    if (Math.hypot(cop.x - taxi.x, cop.z - taxi.z) < bar) {
      // Out of route and still in sight: point it at the edge again, or it rolls dice.
      if (!cop.route?.length && !cop.crashed) {
        const out = {
          i: cop.i > GRID_I / 2 ? 0 : GRID_I,
          j: cop.j > GRID_J / 2 ? 0 : GRID_J,
        };
        const route = findRoute(planOrigin(cop), out);
        if (route?.length) { cop.route = route; cop.routeConsumed = false; }
      }
      return;
    }
    const fleet = traffic.policeCars;
    const tail = fleet[fleet.length - 1];
    if (tail !== cop) {
      const at = fleet.indexOf(cop);
      if (at === -1) { state.leaving = null; return; }
      fleet[fleet.length - 1] = cop;
      fleet[at] = tail;
      traffic.swapAmbient(cop, tail);
    }
    if (traffic.leavePolice(cop)) state.leaving = null;
  }

  function update(dt) {
    if (state.leaving) {
      if (!state.leaving.police) state.leaving = null;
      else driveOff(dt);
    }

    const cop = police.state.cop;
    if (!state.cop) {
      // A new hand-off: the cruiser has just joined traffic with its siren going.
      if (!cop || cop.chase === 0 || cop === state.leaving || cop === state.arrested) return;
      state.cop = cop;
      state.elapsed = 0;
      state.held = 0;
      aimedAt = null;
    }
    if (state.cop !== cop || cop.crashed || !cop.police) {
      // Gone out from under us — wrecked by a ram, or the run reset. Nothing to stand down.
      state.cop = null;
      return;
    }
    if (taxi.crashed) return;   // the run is ending; leave the scene as it is for the shot

    state.elapsed += dt;
    steer(cop);

    const gap = Math.hypot(cop.x - taxi.x, cop.z - taxi.z);
    if (gap < CATCH_RANGE) state.held += dt * (taxi.v < CATCH_SPEED ? 1 : TAIL_RATE);
    else state.held = Math.max(0, state.held - dt);
    if (state.held >= CATCH_TIME) {
      state.caught += 1;
      // Pull up where it is. `roadblock` is the chosen stop the box-in already uses — it rides the
      // braking flag — and it is what keeps the cop from driving on into a taxi the traffic model
      // has stopped counting as a car in its lane.
      cop.roadblock = Infinity;
      state.cop = null;
      state.arrested = cop;
      onCaught(cop);
      return;
    }
    if (gap > ESCAPE_RANGE || state.elapsed > PURSUIT_MAX) {
      state.lost += 1;
      standDown(cop);
      onLost(cop);
    }
  }

  return {
    state,
    update,
    /** Is a patrol cop on the road at all — chasing or driving off? The robbery waits for both. */
    busy: () => Boolean(state.cop || state.leaving || police.state.chasing || police.state.cop),
  };
}
