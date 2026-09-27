import { GRID_I, GRID_J, PITCH, dirSign, isXAxis } from '../city/grid.js';
import { SPAWN_CLEARANCE } from '../sim/traffic.js';
import { SPOT_RANGE } from '../sim/police.js';
import { findRoute, planOrigin } from './route.js';
import { STAND_DOWN_RANGE, STAND_DOWN_TIMEOUT } from './robbery.js';

// The patrol cruiser: a police car that comes into town, drives around it with its lights off, and
// comes after you if you boost in front of it.
//
// **It used to be a siren run.** A scripted car crossed the map on a rail with its bar going and
// every light on its road held green, and boosting within a block of it ended the run on the spot.
// Two rounds of feedback moved it here. The first: being busted on sight is a rule firing, not a
// chase, so the cruiser now gives chase and can be outrun. The second: a cop car blitzing through
// town with its siren on from the moment it appears is not a patrol — and a car that is always in
// pursuit mode has nothing to *change* when it spots you. So it drives as ordinary traffic with a
// dark bar, and the siren is what spotting you looks like.
//
// **It is a car in traffic for the whole of its life**, the same kind a bank robbery brings (see
// "Cop cars in ambient traffic" in docs/traffic.md): it queues, stops at reds, yields, can be
// rammed, and — once chasing — overtakes and brake-checks. sim/police.js draws the cruiser's own
// mesh on it (`wear`), which is what makes this *the* patrol car rather than one more hatchback in
// police paint.
//
// The life of one patrol, a phase at a time:
//
//   off       waiting out a cooldown, which the difficulty ramp shortens (`setCooldownRange`)
//   patrol    on the map, bar dark, cruising the streets near the taxi for PATROL_TIME
//   chase     it spotted you: bar on, driving at you — ends caught, or lost
//   leaving   done here, driving off the map; retired once out of sight
//
// **Spotted** is the rule the old bust was: boost within SPOT_RANGE (one block) of it. What
// changed is what happens next.
//
//   - **Caught** — see CATCH_RANGE. The run ends "Busted!", as it always did; it just takes a cop
//     actually getting to you now, and staying on you.
//   - **Lost** — see ESCAPE_BLOCKS. The bar goes dark and the cruiser drives off, the same
//     stand-down a robbery's cops do.

/**
 * How long a patrol stays in town before it drives off, in seconds.
 *
 * Long enough to meet: a patrol has to be somewhere near the taxi to matter, and it comes in from
 * off screen and then cruises the streets around it at ordinary traffic speed. Short enough that
 * it is an event with an end rather than a permanent resident — the ramp's cooldown between
 * patrols (`difficulty.policeCooldown`, 16-30s falling to 8-14s) is the other half of how often
 * one is about.
 */
const PATROL_TIME = 25;

/**
 * How far from the taxi a patrol picks the next corner to drive to, in blocks.
 *
 * A patrol with no route rolls the ordinary dice at every junction and is as likely to spend its
 * visit on the far side of the river as anywhere the player is. So when it runs out of road it is
 * pointed at a junction within this many blocks of the taxi — not *at* the taxi, which would be a
 * chase with its lights off, but around it, which is where a patrol can be run into.
 */
const PATROL_REACH = 2;

/**
 * How far ahead, in blocks, the taxi has to get before the cop gives up.
 *
 * Straight-line distance, three blocks: 60 units, which is just past `LOST_RANGE` (56) — the
 * distance the robbery measured as "out of the picture" on a phone at play zoom. So the rule the
 * player learns is the one they can see: get the siren out of frame and you are clear.
 *
 * Distance *between the two cars* rather than distance *driven*, on purpose. "Survive three blocks
 * of driving" would let a cop sitting on your bumper let you go, and would ask nothing of the
 * player but patience; this asks them to actually open a gap, which a boosting taxi can do and a
 * cruising one cannot.
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
 * **A taxi still moving with a cop on its bumper fills it at TAIL_RATE**, so two seconds of being
 * tailed is an arrest too. The first cut had only the stopped rate, and the probe is why it has
 * both: a taxi cruising the ring road — which has no lights, so it never stops — had a cop three to
 * eight units behind it for forty seconds and was then "lost" by the backstop. A cop glued to you
 * is not a cop you have outrun. It was a quarter at first (four seconds) and measured too lenient
 * alongside the half-speed drain below: 5 of 10 cruising taxis caught, against 10 of 10 with this
 * and the siren hold (`sirenHold` in sim/traffic.js).
 *
 * Distance alone would bust the wrong things, which is why neither rate is instant: a cop drawing
 * past in the oncoming lane is inside a car length for a beat and has caught nobody, and a taxi
 * rammed into a cop is inside it too — that is a bump, not an arrest. Out of range the meter drains
 * at half the rate it fills, rather than resetting, so a cop that drops back a length for a moment
 * — as a following car does at every junction — has not started again.
 *
 * 8 units is a car length of daylight either way: a cop queued behind the taxi sits ~5.5 back, one
 * slewed across the road in front of it ~5-6. 4 u/s is a crawl, well under the 8.5 cruise, so a
 * taxi pulling away from a light is not "stopped" on the frame it starts moving.
 */
export const CATCH_RANGE = 8;
export const CATCH_SPEED = 4;
export const CATCH_TIME = 1;
const TAIL_RATE = 0.5;
const DRAIN_RATE = 0.5;

/**
 * The longest a chase runs, in seconds, before the cop is called off anyway. A chase with neither
 * car able to reach the other — a cop stuck behind a jam, a taxi out of reach behind a closed road
 * — would otherwise hold the siren up for the rest of the run.
 */
const CHASE_MAX = 40;

/**
 * @param rng      its own stream: where a patrol cruises, and the cooldowns between them
 * @param police   the cruiser's look (sim/police.js) — `wear`/`shed` the traffic car
 * @param traffic  the sim — `enterPolice`, `retirePolice`, `policeCars`
 * @param taxi     the player's car
 * @param blocked  `() => boolean` — true while a patrol may not start: a robbery is on, or its cops
 *                 are still driving off. Both share the cop fleet (see `leavePolice`)
 * @param onSpotted `(cop) => void` — the moment it lights up. main.js puts "Pull over!" over it
 * @param onCaught `(cop) => void` — the run ends here (main.js stops the taxi and raises "Busted!")
 * @param onLost   `(cop) => void` — the taxi got away
 */
export function createPatrol({
  rng, police, traffic, taxi, blocked = () => false,
  onSpotted = () => {}, onCaught = () => {}, onLost = () => {},
}) {
  const state = {
    phase: 'off',
    /** Seconds until the next patrol comes in. The first is short: a run opens with a patrol due. */
    cooldown: rng.range(5, 12),
    cooldownRange: [16, 30],
    /** Seconds left on this patrol before it drives off. */
    patrolLeft: 0,
    /** The traffic car, from the frame it enters to the frame it leaves. */
    cop: null,
    /** Seconds this chase has run. */
    elapsed: 0,
    /** The catch meter, in seconds of a cop on a stopped taxi — see CATCH_TIME. */
    held: 0,
    /** Seconds since it started leaving — see STAND_DOWN_TIMEOUT. */
    standingDown: 0,
    /** Tallies, for the tools. */
    patrols: 0,
    spotted: 0,
    caught: 0,
    lost: 0,
  };

  // Where the chase was last aimed. Keyed on its endpoints and left alone in between — re-planning
  // a route every frame stalls a car at its junction (see CLAUDE.md), which the robbery found out
  // the same way.
  let aimedAt = null;

  const gap = (cop) => Math.hypot(cop.x - taxi.x, cop.z - taxi.z);
  const clampI = (i) => Math.max(0, Math.min(GRID_I, i));
  const clampJ = (j) => Math.max(0, Math.min(GRID_J, j));
  const routeTo = (cop, target) => {
    const route = findRoute(planOrigin(cop), target);
    if (route?.length) { cop.route = route; cop.routeConsumed = false; }
    return Boolean(route?.length);
  };

  function enter() {
    // Off screen and as near the taxi as that allows — `enterPolice` owns the trade between the
    // two (see the cop-car section in sim/traffic.js). It arrives as a robbery's cop does, siren
    // on and chasing, and is turned into a patrol before it has drawn a frame.
    if (!traffic.enterPolice(1, taxi)) { state.cooldown = 3; return; }
    const cop = traffic.policeCars[traffic.policeCars.length - 1];
    cop.patrol = true;
    cop.siren = false;
    cop.chase = 0;
    cop.route = [];
    police.wear(cop);
    state.cop = cop;
    state.phase = 'patrol';
    state.patrolLeft = PATROL_TIME;
    state.patrols += 1;
  }

  /** Out of road: pick a corner near the taxi to drive to next. */
  function cruise(cop) {
    if (cop.route?.length) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const target = {
        i: clampI(taxi.i + rng.int(-PATROL_REACH, PATROL_REACH)),
        j: clampJ(taxi.j + rng.int(-PATROL_REACH, PATROL_REACH)),
      };
      if (routeTo(cop, target)) return;
    }
  }

  /**
   * The junction to send a chasing cop to: the one the taxi is driving into, or — if the cop is
   * already heading into that one itself, the stern chase on the taxi's own road — the one after
   * it, along the taxi's route or, with no route, straight on. A route to the junction you are
   * already driving into is empty, and a cop with an empty route rolls the ordinary dice at the
   * junction and wanders off the taxi's tail a beat before it turns.
   */
  function aimFor(cop) {
    const at = { i: taxi.i, j: taxi.j };
    const origin = planOrigin(cop);
    if (origin.i !== at.i || origin.j !== at.j) return at;
    const d = taxi.state === 'turn' && taxi.dOut != null ? taxi.dOut : (taxi.route?.[0] ?? taxi.d);
    if (isXAxis(d)) at.i += dirSign(d); else at.j += dirSign(d);
    return { i: clampI(at.i), j: clampJ(at.j) };
  }

  function steer(cop) {
    const key = `${taxi.i},${taxi.j},${taxi.route?.[0] ?? ''}`;
    if (key === aimedAt && cop.route?.length) return;
    // Not while it is out overtaking the taxi: the pass was only offered because this route carried
    // straight on (sim/traffic.js), and a re-aim mid-manoeuvre hands it a turn from the oncoming
    // lane. Same rule as the robbery's.
    if (cop.pass > 0) return;
    routeTo(cop, aimFor(cop));
    aimedAt = key;
  }

  /** Lights on, and after the taxi. */
  function spot(cop) {
    cop.siren = true;
    cop.chase = 1;
    cop.route = [];
    state.phase = 'chase';
    state.elapsed = 0;
    state.held = 0;
    state.spotted += 1;
    aimedAt = null;
    steer(cop);
    onSpotted(cop);
  }

  /**
   * Done here: bar dark, chase off, routed to the corner of the map furthest from the taxi. The
   * robbery's stand-down, for one car — see `stop` in game/robbery.js for why each line is there
   * (and why "routed out" rather than "unrouted").
   */
  function leave(cop) {
    cop.siren = false;
    cop.chase = 0;
    cop.roadblock = 0;
    cop.route = [];
    routeTo(cop, { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J });
    state.phase = 'leaving';
    state.standingDown = 0;
    aimedAt = null;
  }

  /** Off the road, and the cooldown to the next one starts. */
  function retire() {
    state.cop = null;
    state.phase = 'off';
    state.cooldown = rng.range(state.cooldownRange[0], state.cooldownRange[1]);
    police.shed();
  }

  /** Take the cop off the map once it is out of sight — `driveOff` in game/robbery.js, for one car. */
  function driveOff(cop, dt) {
    state.standingDown += dt;
    const bar = state.standingDown >= STAND_DOWN_TIMEOUT ? SPAWN_CLEARANCE : STAND_DOWN_RANGE;
    if (gap(cop) < bar) {
      // Out of route and still in sight: point it at the edge again, or it rolls dice.
      if (!cop.route?.length) {
        routeTo(cop, { i: cop.i > GRID_I / 2 ? 0 : GRID_I, j: cop.j > GRID_J / 2 ? 0 : GRID_J });
      }
      return;
    }
    if (traffic.retirePolice(cop)) retire();
  }

  /**
   * @param boosting  the taxi's Loco Mode is engaged — the one thing a patrol reacts to
   */
  function update(dt, { boosting = false } = {}) {
    if (state.phase === 'off') {
      if (blocked()) return;
      state.cooldown -= dt;
      if (state.cooldown <= 0) enter();
      return;
    }

    const cop = state.cop;
    // Gone out from under us — wrecked by a ram (which is the end of the run), or the fleet cleared.
    if (!cop || cop.crashed || !cop.police) { retire(); return; }
    if (state.phase === 'arrest') return;
    if (taxi.crashed) return;   // the run is ending; leave the scene as it is for the shot

    const near = gap(cop);
    const sees = boosting && near <= SPOT_RANGE && !taxi.staged;

    if (state.phase === 'patrol') {
      // A robbery wants the streets: stand the patrol down rather than have a dark cop car
      // wandering through a getaway it takes no part in.
      if (blocked()) { leave(cop); return; }
      if (sees) { spot(cop); return; }
      state.patrolLeft -= dt;
      if (state.patrolLeft <= 0) { leave(cop); return; }
      cruise(cop);
      return;
    }

    if (state.phase === 'leaving') {
      driveOff(cop, dt);
      return;
    }

    // --- chase
    state.elapsed += dt;
    steer(cop);
    if (near < CATCH_RANGE) state.held += dt * (taxi.v < CATCH_SPEED ? 1 : TAIL_RATE);
    else state.held = Math.max(0, state.held - dt * DRAIN_RATE);
    if (state.held >= CATCH_TIME) {
      state.caught += 1;
      // Pull up where it is. `roadblock` is the chosen stop the box-in already uses — it rides the
      // braking flag — and it is what keeps the cop from driving on into a taxi the traffic model
      // has stopped counting as a car in its lane.
      cop.roadblock = Infinity;
      state.phase = 'arrest';
      onCaught(cop);
      return;
    }
    if (near > ESCAPE_RANGE || state.elapsed > CHASE_MAX) {
      state.lost += 1;
      leave(cop);
      onLost(cop);
    }
  }

  return {
    state,
    update,
    /**
     * How often a patrol comes round, as `[min, max]` seconds between them. Pushed in by main.js
     * off the difficulty curve; takes effect from the *next* draw, so a delivery landing does not
     * summon a cop on the spot.
     */
    setCooldownRange: ([min, max]) => { state.cooldownRange = [min, max]; },
    /** Is a patrol after the taxi, or has it just lost it? The robbery waits for both. */
    busy: () => state.phase === 'chase' || state.phase === 'arrest',
  };
}
