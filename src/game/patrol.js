import { GRID_I, GRID_J, PITCH, dirSign, isXAxis, lineX, lineZ } from '../city/grid.js';
import { SPAWN_CLEARANCE } from '../sim/traffic.js';
import { SPOT_RANGE } from '../sim/police.js';
import { findRoute, planOrigin } from './route.js';
import { STAND_DOWN_RANGE, STAND_DOWN_TIMEOUT } from './robbery.js';

// The patrol cruiser: a police car that crosses town edge to edge, past the taxi, with its bar
// swinging gently red and blue, and comes after you if you boost in front of it.
//
// **It used to be a siren run.** A scripted car crossed the map on a rail with its bar going and
// every light on its road held green, and boosting within a block of it ended the run on the spot.
// Two rounds of feedback moved it here. The first: being busted on sight is a rule firing, not a
// chase, so the cruiser now gives chase and can be outrun. The second: a cop car blitzing through
// town with its siren on from the moment it appears is not a patrol — and a car that is always in
// pursuit mode has nothing to *change* when it spots you. So it drives as ordinary traffic with its
// bar swinging gently red and blue, and the hard strobe is what spotting you looks like. (It was
// dark at first; a playtest found it hard to spot before it had spotted you, so the swing is the
// telegraph.)
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
//   patrol    crossing town, bar swinging gently red and blue: in at one edge of the map, past a
//             corner near the taxi, out at the opposite edge (see `enter`)
//   exiting   dissolving at that far edge (FADE_TIME), then retired
//   chase     it spotted you: bar strobing, driving at you — ends caught, or lost
//   leaving   lost you: bar dark, driving off; retired once out of sight
//
// **Spotted** is the rule the old bust was: boost within SPOT_RANGE (one block) of it. What
// changed is what happens next.
//
//   - **Caught** — see CATCH_RANGE. The run ends "Busted!", as it always did; it just takes a cop
//     actually getting to you now, and staying on you.
//   - **Lost** — see ESCAPE_BLOCKS. The bar goes dark and the cruiser drives off, the same
//     stand-down a robbery's cops do.

/**
 * The longest a patrol spends on the way *in*, in seconds, before it gives up on the corner near the
 * taxi and heads for its exit.
 *
 * A patrol is a crossing: in at one edge, past the taxi, out at the other (see `enter`). The taxi
 * keeps moving while the cop drives in, and the corner it is aimed at follows it (`cruise`), so a
 * taxi that happens to lead it around town could keep it on the in leg indefinitely. Past this it
 * carries on out. The ramp's cooldown between patrols (`difficulty.policeCooldown`, 16-30s falling
 * to 8-14s) is the other half of how often one is about.
 */
const PATROL_TIME = 25;

/**
 * How close to its exit junction the cruiser gets before it starts to dissolve, in world units. The
 * fade covers about FADE_TIME of driving — six or seven units at cruise — so starting it a little
 * short of the junction has it gone as it reaches the ring road on the island's edge.
 */
const EXIT_REACH = 8;

/**
 * How far from the taxi a patrol picks the next corner to drive to, in blocks.
 *
 * A crossing that ignored the taxi would pass it only by luck, so the in leg is routed through a
 * junction within this many blocks of it — not *at* the taxi, which would be a chase with its lights
 * off, but past it, which is where a patrol can be run into. Measured over 12 seeds with a taxi
 * rolling dice at junctions: at 2 blocks the crossing came within 40 units of it on 7, at 1 on 9.
 */
const PATROL_REACH = 1;

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
 * ...and for how long, in seconds. The gap has to *hold*: a taxi that pops three blocks clear and
 * is caught back up has not got away, and with the cop flooring it to close (PURSUIT_*) a single
 * frame over the line is exactly what a straight followed by a corner produces. Out of range the
 * clock runs; back inside it, it runs down at the same rate rather than resetting, so an escape
 * that was nearly made still counts for something.
 */
export const ESCAPE_HOLD = 2.5;

// Where those two land, measured over twelve staged chases per row with the taxi driving a route
// across town (not rolling dice at junctions — nobody plays like that, and a taxi that turns at
// random never reaches the overdrive band that is the real way out), boosting for the first N
// seconds of the chase and cruising after:
//
//   | boost spent       | caught | lost  | median time to lose it |
//   |-------------------|--------|-------|------------------------|
//   | none              | 12/12  | 0/12  | —                      |
//   | 5s (a third tank) | 9/12   | 3/12  | 5.2s                   |
//   | 10s               | 6/12   | 6/12  | 7.3s                   |
//   | 15s (full tank)   | 1/12   | 11/12 | 9.9s                   |
//
// Before the catch-up and the hold, a taxi on the pill lost the cop in a median 4.2s on 5s of boost,
// the same as on 15 — the blip that was reported. The tank now decides it.

/**
 * The catch-up: how far behind the cop has to be before it starts flooring it, and where it is
 * flat out — `car.pursuit`, 0..1, which lifts its ceiling by PURSUIT_LIFT in sim/traffic.js.
 *
 * Reported from play without it: boost past a patrol and the chase was a blip — "Pull over!" came
 * and went and the car might never be on screen, because a cop at 21.7 u/s is slower than the pill
 * and the gap only ever grew. Close in, it drives at an ordinary chasing cop's pace, so a taxi off
 * the pill still meets the same car it always did; a block and more back, it is the fastest thing
 * on the road short of the overdrive band.
 */
const PURSUIT_FROM = 14;
const PURSUIT_FULL = 34;

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
    /** Seconds this patrol has been on its way in — see PATROL_TIME. */
    legTime: 0,
    /** 'in' — heading for a corner near the taxi — or 'out', heading for `exit`. */
    leg: 'in',
    /** Where it came onto the map and where it leaves it: junctions on opposite edges. */
    entry: null,
    exit: null,
    /** The traffic car, from the frame it enters to the frame it leaves. */
    cop: null,
    /** Seconds this chase has run. */
    elapsed: 0,
    /** The catch meter, in seconds of a cop on a stopped taxi — see CATCH_TIME. */
    held: 0,
    /** The escape clock, in seconds of the taxi three blocks clear — see ESCAPE_HOLD. */
    clear: 0,
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

  /**
   * Come onto the map at one edge, bound for the opposite one.
   *
   * It used to come in as a robbery's cop does, off screen and as near the taxi as that allows,
   * which puts it anywhere a street runs just outside the frame — reported as the cruiser "popping
   * out mid city". A patrol is a car *passing through*: it enters on the edge of the island furthest
   * from the taxi across one axis of the map, level with the taxi on the other, and leaves by the
   * opposite edge. Level with the taxi so the crossing is one that can meet it, and `cruise` routes
   * the in leg through a corner near it; the exit is anywhere along the far side.
   */
  function enter() {
    const acrossI = rng.chance(0.5);
    const entry = acrossI
      ? { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: clampJ(taxi.j + rng.int(-1, 1)) }
      : { i: clampI(taxi.i + rng.int(-1, 1)), j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    const exit = acrossI
      ? { i: GRID_I - entry.i, j: rng.int(0, GRID_J) }
      : { i: rng.int(0, GRID_I), j: GRID_J - entry.j };
    // `enterPolice` ranks lanes by distance to the point it is handed and never places one in
    // frame (SPAWN_CLEARANCE), so the car arrives on a road at that edge junction or next to it.
    if (!traffic.enterPolice(1, { x: lineX(entry.i), z: lineZ(entry.j) })) { state.cooldown = 3; return; }
    const cop = traffic.policeCars[traffic.policeCars.length - 1];
    cop.patrol = true;
    cop.siren = false;
    cop.chase = 0;
    cop.route = [];
    police.wear(cop);
    police.setBar('patrol');
    state.cop = cop;
    state.phase = 'patrol';
    state.leg = 'in';
    state.legTime = 0;
    state.entry = entry;
    state.exit = exit;
    state.patrols += 1;
    cruisingTo = null;
  }

  // The corner the patrol is cruising to. Kept so a stale one can be dropped — see `cruise`.
  let cruisingTo = null;

  /**
   * The in leg: head for a corner near the taxi, and re-pick it if the taxi has since left. The re-aim is keyed on the target falling out of reach rather than done every frame
   * (see `aimedAt`), and it is not optional: a corner picked near where the taxi *was* can be a
   * six-leg route away, and the probe's patrol spent three quarters of its visit more than three
   * blocks off a taxi that simply drove on.
   */
  function cruise(cop) {
    const stale = cruisingTo && Math.max(
      Math.abs(cruisingTo.i - taxi.i), Math.abs(cruisingTo.j - taxi.j)) > PATROL_REACH + 1;
    if (cop.route?.length && !stale) return;
    // Out of road with a corner already picked is arriving at it: the in leg is done.
    if (!cop.route?.length && cruisingTo && !stale) { headOut(cop); return; }
    // The nearest of a few, by route rather than by grid: a cop heading away from a corner cannot
    // U-turn, so the first corner that merely *routes* was a six-leg lap round the far side of town
    // often enough to matter.
    let best = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const target = {
        i: clampI(taxi.i + rng.int(-PATROL_REACH, PATROL_REACH)),
        j: clampJ(taxi.j + rng.int(-PATROL_REACH, PATROL_REACH)),
      };
      const route = findRoute(planOrigin(cop), target);
      if (route?.length && (!best || route.length < best.route.length)) best = { target, route };
    }
    if (!best) return;
    cop.route = best.route;
    cop.routeConsumed = false;
    cruisingTo = best.target;
  }

  /** The out leg: for the far edge. Nothing to route is already there, so straight to the fade. */
  function headOut(cop) {
    state.leg = 'out';
    if (!routeTo(cop, state.exit)) cop.route = [];
  }

  /** On the out leg: dissolve once it reaches its exit — see EXIT_REACH. */
  function crossOut(cop) {
    const d = Math.hypot(cop.x - lineX(state.exit.i), cop.z - lineZ(state.exit.j));
    if (d < EXIT_REACH) {
      police.fadeOut();
      state.phase = 'exiting';
      return;
    }
    // Out of route short of the exit — the router's last turn is behind it and the dice took it
    // somewhere else. Point it back.
    if (!cop.route?.length) routeTo(cop, state.exit);
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
    police.setBar('strobe');
    cop.chase = 1;
    cop.route = [];
    state.phase = 'chase';
    state.elapsed = 0;
    state.held = 0;
    state.clear = 0;
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
    police.setBar('off');
    cop.chase = 0;
    cop.pursuit = 0;
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
      if (state.leg === 'in') {
        state.legTime += dt;
        if (state.legTime > PATROL_TIME) headOut(cop);
        else cruise(cop);
      }
      if (state.leg === 'out') crossOut(cop);
      return;
    }

    // Dissolving at the far edge. Retired the frame it is gone — and a cop that is still drawn is
    // never taken off, so a failed retire just waits a frame.
    if (state.phase === 'exiting') {
      if (police.state.fade <= 0 && traffic.retirePolice(cop)) retire();
      return;
    }

    if (state.phase === 'leaving') {
      driveOff(cop, dt);
      return;
    }

    // --- chase
    state.elapsed += dt;
    steer(cop);
    cop.pursuit = Math.max(0, Math.min(1, (near - PURSUIT_FROM) / (PURSUIT_FULL - PURSUIT_FROM)));
    if (near < CATCH_RANGE) state.held += dt * (taxi.v < CATCH_SPEED ? 1 : TAIL_RATE);
    else state.held = Math.max(0, state.held - dt * DRAIN_RATE);
    if (state.held >= CATCH_TIME) {
      state.caught += 1;
      // Pull up where it is. `roadblock` is the chosen stop the box-in already uses — it rides the
      // braking flag — and it is what keeps the cop from driving on into a taxi the traffic model
      // has stopped counting as a car in its lane.
      cop.roadblock = Infinity;
      cop.pursuit = 0;
      state.phase = 'arrest';
      onCaught(cop);
      return;
    }
    state.clear = near > ESCAPE_RANGE ? state.clear + dt : Math.max(0, state.clear - dt);
    if (state.clear >= ESCAPE_HOLD || state.elapsed > CHASE_MAX) {
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
