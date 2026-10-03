import { DIR, GRID_I, GRID_J, PITCH, dirSign, isXAxis, lineX, lineZ } from '../city/grid.js';
import { SLAB_X, SLAB_Z } from '../city/ground.js';
import { SPAWN_CLEARANCE } from '../sim/traffic.js';
import { touching } from '../sim/collisions.js';
import { SPOT_RANGE } from '../sim/police.js';
import { findRoute, findRouteOnto, planOrigin, junctionAhead, turnsRound } from './route.js';
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
//   exiting   out of traffic, driving straight off the island and dissolving past the slab's
//             edge (`police.release`), then retired
//   chase     it spotted you: bar strobing, driving at you — ends caught, or lost
//   leaving   lost you: bar dark, driving off; retired once out of sight
//
// **Spotted** is no longer a frame: boosting near it fills its *heat* (NOTICE_RANGE), a full bar
// is the chase, and lifting off cools it. game/heatmeter.js draws it top left.
//
//   - **Caught** — the cop touches the taxi (see TOUCH_SLACK). The run ends "Busted!", as it always
//     did; it just takes a cop actually getting to you now. The taxi ramming the cop on the pill is
//     not that: it is a bump, and buys RAMMED_GRACE.
//   - **Lost** — the escape meter fills (ESCAPE_BLOCKS, SHAKE_RANGE): far enough ahead, or out of
//     the cop's sight. The bar goes dark and the cruiser drives off, the same stand-down a
//     robbery's cops do.
//   - **Gone to ground** — the taxi pulls into the depot mid-chase (`hideout`). Lost, by another
//     door: the cop never saw it go in.

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
 * Straight-line distance, two and a half blocks: 50 units, a little inside `LOST_RANGE` (56) — the
 * distance the robbery measured as "out of the picture" on a phone at play zoom — so the cop is at
 * the edge of the frame as it gives up. It was three (60) and reported as "a touch too hard": the
 * catches that decided it came *after* the tank ran out, the cop reeling in a taxi that had nearly
 * made it. The table below is why 2.5.
 *
 * Distance *between the two cars* rather than distance *driven*, on purpose. "Survive three blocks
 * of driving" would let a cop sitting on your bumper let you go, and would ask nothing of the
 * player but patience; this asks them to actually open a gap, which a boosting taxi can do and a
 * cruising one cannot.
 */
export const ESCAPE_BLOCKS = 2.5;
const ESCAPE_RANGE = ESCAPE_BLOCKS * PITCH;

/**
 * ...and for how long, in seconds: past ESCAPE_RANGE the escape meter fills at 1/ESCAPE_HOLD a
 * second. The gap has to *hold*: a taxi that pops clear and is caught back up has not got away,
 * and with the cop flooring it to close (PURSUIT_*) a single frame over the line is exactly what a
 * straight followed by a corner produces. Back in the cop's sight the meter falls (RESIGHT_RATE)
 * rather than resetting, so an escape that was nearly made still counts for something.
 *
 * It was a clock of 1.5s past the line, and nothing else counted. It is 3 now because breaking the
 * cop's sightline also fills the meter (SHAKE_RANGE), which on its own took a full tank's getaway
 * from a median 6.0s to 3.2s on the probe's seeds — a blip. At 3 it is 5.4s.
 */
export const ESCAPE_HOLD = 3;

// Where those land, measured over sixteen staged chases per row with the taxi driving a route across
// town (not rolling dice at junctions — nobody plays like that, and a taxi that turns at random
// never reaches the overdrive band that is the real way out), boosting for the first N seconds of
// the chase and cruising after, a touch being the bust (TOUCH_SLACK):
//
//   | boost spent       | 3 blocks, 2.5s, lift 1.25 | 2.5 blocks, 1.5s, lift 1.15 (now)        |
//   |-------------------|---------------------------|------------------------------------------|
//   | none              | 16/16 caught              | 15/16 caught, median 7.5s                |
//   | 3s                | 3/16 lost                 | 4/16 lost                                |
//   | 5s (a third tank) | 5/16 lost                 | 8/16 lost, median 4.8s — the coin flip    |
//   | 8s                | 9/16 lost (at 1.25 & 1.5s)| 13/16 lost                               |
//   | 15s (full tank)   | 14/16 lost                | 14/16 lost, median 6.2s                  |
//
// The two full-tank catches are both at 0.6s: taxis staged boosting straight into the cop's side.
// Before the catch-up and the hold, a taxi on the pill lost the cop in a median 4.2s on 5s of boost,
// the same as on 15 — the blip that was reported. The tank decides it.
//
// Re-measured with the heat, the sightline and SPOT_GRACE in (32 staged chases a row over two seed
// bases, `HOLD`-staged as the probe does), against the same harness before them:
//
//   | taxi            | boost spent | before                 | now                          |
//   |-----------------|-------------|------------------------|------------------------------|
//   | routed          | none        | 32/32 caught, ~10s     | 32/32 caught, ~11s           |
//   | routed          | 5s          | 17/32 caught           | 17/32 caught                 |
//   | routed          | 15s         | 5/32 caught (all 0.6s) | 0/32 caught, lost in 6.8s    |
//   | no route (auto) | 5s          | 20/32 caught           | 13/32 caught                 |
//   | no route (auto) | 15s         | 12/32 caught, ~20s in  | 2/32 caught                  |
//
// What got easier is the auto-driving taxi, which used to roll its turns back into the cop
// (`fleeWeight` in sim/traffic.js), and the catches in the first second (SPOT_GRACE). What a
// third of a tank buys a routed taxi is unchanged: still the coin flip.

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
 * How a cop catches the taxi: it touches it. Rammed from behind or sideswiped on a pass — any
 * contact of the cop's making, and that is the arrest. A taxi that drives into the cop on the pill is
 * the exception: that is a bump (RAMMED_GRACE). Off the pill even that is the arrest.
 *
 * It used to be a meter: a cop within 8 units for a second of a stopped taxi, or two of a moving
 * one. Reported from play as the fail state being soft — a cop sitting a car length back and filling
 * a bar is not being caught, it is a timer. A chasing patrol now drives *into* the taxi rather than
 * queueing behind it (`ram`, RAM_GAP in sim/traffic.js), so the cop on your bumper is exactly the
 * thing that ends the run.
 *
 * `slack` because contact is resolved before this reads it: off boost sim/collisions.js shoves the
 * struck car out to the envelope every frame, so two cars that touched are sitting *at* it. 0.15 is
 * well under the 0.3 the ram gap drives into, and nowhere near a car passing in the next lane (the
 * envelope is 2.3; lanes are 4 apart).
 */
export const TOUCH_SLACK = 0.15;

/**
 * The longest a chase runs, in seconds, before the cop is called off anyway. A chase with neither
 * car able to reach the other — a cop stuck behind a jam, a taxi out of reach behind a closed road
 * — would otherwise hold the siren up for the rest of the run.
 */
const CHASE_MAX = 40;

/**
 * Seconds at the start of a handed-over chase in which a touch does not count and the cop does not
 * ram — see `pursueNearest`. The robbery's nearest cop can be sitting on the taxi's bumper on the
 * frame the robber gets out (the cut-offs and brake checks put it there on purpose), and a bust on
 * the very frame the chase is announced is a rule firing, not a chase: the same objection that
 * turned the old bust-on-sight into this module. A second and a half is the "Pull over!" bubble
 * going up and one boost press.
 */
const HANDOFF_GRACE = 1.5;

/**
 * **Heat**: how close a patrolling cop is to coming after you, 0..1 — the stealth game's detection
 * meter, drawn top left by game/heatmeter.js. Boosting near the cruiser fills it and a full one is
 * the chase; off the pill it cools.
 *
 * It replaced spotting on the frame: boost within SPOT_RANGE and the strobe came up at once, which
 * was reported as getting caught "a lot" and with nothing to read beforehand. Now there is a beat
 * in which the player sees the bar climb and can lift off.
 *
 * The rate is NOTICE_RATE a second at SPOT_RANGE on the cop's own street — a second to fill — and
 * scales with the square of closeness, up to NOTICE_MAX: boosting past its bumper is a third of a
 * second, two blocks off is four. Nothing past NOTICE_RANGE. Off its sightline (`inSight`) the rate
 * is NOTICE_OFF_SIGHT of that: a street over, the cop has to hear you rather than see you.
 */
export const NOTICE_RANGE = 2 * PITCH;
const NOTICE_RATE = 1;
const NOTICE_MAX = 3;
const NOTICE_OFF_SIGHT = 0.35;

/** Off the pill, heat holds this long and then falls at COOL_RATE a second. */
const COOL_DELAY = 0.75;
const COOL_RATE = 0.4;

/**
 * Can the cop see the taxi? Both on the same street — within SIGHT_WIDTH of the same grid line,
 * which an arterial's lanes at 3.33 are — or close enough that it does not matter which.
 *
 * A block is a building, and under this camera a block is what stands between two parallel
 * streets, so this is the city's own line of sight to within a junction. It is what makes driving
 * a way out of a chase rather than only holding boost: see SHAKE_RANGE.
 */
const SIGHT_WIDTH = 6;
const SIGHT_CLOSE = 12;

/**
 * Shaking it off: out of the cop's sight and more than SHAKE_RANGE away, the escape meter fills at
 * SHAKE_RATE a second, rising to the ESCAPE_HOLD rate at ESCAPE_RANGE. In sight and inside
 * ESCAPE_RANGE it falls at RESIGHT_RATE. Past ESCAPE_RANGE it fills at the ESCAPE_HOLD rate in sight
 * or out, which is the old rule unchanged.
 */
const SHAKE_RANGE = 24;
const SHAKE_RATE = 0.2;
const RESIGHT_RATE = 0.4;

/**
 * The same grace on the frame a patrol boils over (NOTICE_RANGE), in seconds. The heat only fills
 * on the pill and fastest right beside the cop, so the chase used to open with the two cars a car
 * length apart and the cop ramming at once: measured over 32 staged chases, a full tank was caught
 * in 0.6s on 5 of them, before the player could have read the bar. One second is the strobe and
 * "Pull over!" going up.
 */
const SPOT_GRACE = 1;

/**
 * The same grace after the taxi rams the cop on the pill, in seconds. A boosting hit on a cop is a
 * bump like any other car (sim/collisions.js) — HP off, the cop knocked or launched — and it is the
 * *taxi* driving into the cop, which is not the cop catching anybody. Without it the bump was a bust
 * one frame later: a boost within SPOT_RANGE spots a patrolling cop on the very frame of the hit,
 * the chase arms the touch, and the two cars are still in contact. The cop does not ram inside it
 * either, so a taxi that loses most of its speed to the hit has a moment to get going again. A cop
 * that drives into the taxi is still the arrest, and so is any touch off the pill.
 */
const RAMMED_GRACE = 1.5;

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
 * @param onHid    `(cop) => void` — the taxi got away into the depot (`hideout`)
 */
export function createPatrol({
  rng, police, traffic, taxi, blocked = () => false,
  onSpotted = () => {}, onCaught = () => {}, onLost = () => {}, onHid = () => {},
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
    /** The grid direction that points off the map at `exit` — the way it drives out. */
    exitD: null,
    /** The traffic car, from the frame it enters to the frame it leaves. */
    cop: null,
    /** Seconds this chase has run. */
    elapsed: 0,
    /** Seconds left of HANDOFF_GRACE (a chase handed over from a robbery) or RAMMED_GRACE. */
    grace: 0,
    /** RAMMED_GRACE owed by a ram this frame, spent by the next `update` — see `rammed`. */
    rammedGrace: 0,
    /** The escape meter, 0..1 — lost at 1. See ESCAPE_HOLD and SHAKE_RANGE. */
    escape: 0,
    /** How close a patrolling cop is to giving chase, 0..1 — see NOTICE_RANGE. */
    heat: 0,
    /** Seconds since the taxi last boosted inside NOTICE_RANGE — see COOL_DELAY. */
    cool: 0,
    /** Does the cop see the taxi this frame (`inSight`)? For the meter. */
    sight: false,
    /** Is the escape meter filling this frame? For the meter. */
    evading: false,
    /** Seconds since it started leaving — see STAND_DOWN_TIMEOUT. */
    standingDown: 0,
    /** Tallies, for the tools. */
    patrols: 0,
    spotted: 0,
    caught: 0,
    lost: 0,
    hid: 0,
  };

  // Where the chase was last aimed. Keyed on its endpoints and left alone in between — re-planning
  // a route every frame stalls a car at its junction (see CLAUDE.md), which the robbery found out
  // the same way.
  let aimedAt = null;

  const gap = (cop) => Math.hypot(cop.x - taxi.x, cop.z - taxi.z);
  const inSight = (cop, near) => near <= SIGHT_CLOSE
    || Math.min(Math.abs(cop.x - taxi.x), Math.abs(cop.z - taxi.z)) <= SIGHT_WIDTH;
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
   * the in leg through a corner near it; the exit is anywhere along the far side but its two
   * corners, which have no street carrying on off the island to drive out along.
   */
  function enter() {
    const acrossI = rng.chance(0.5);
    const entry = acrossI
      ? { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: clampJ(taxi.j + rng.int(-1, 1)) }
      : { i: clampI(taxi.i + rng.int(-1, 1)), j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    const exit = acrossI
      ? { i: GRID_I - entry.i, j: rng.int(1, GRID_J - 1) }
      : { i: rng.int(1, GRID_I - 1), j: GRID_J - entry.j };
    const exitD = acrossI
      ? (exit.i === GRID_I ? DIR.PX : DIR.NX)
      : (exit.j === GRID_J ? DIR.PZ : DIR.NZ);
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
    state.exitD = exitD;
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

  /** On the exit lane: the street running into the ring at `exit`, heading off the map. */
  const onExitLane = (cop) => cop.d === state.exitD && cop.i === state.exit.i && cop.j === state.exit.j;

  /**
   * The out leg: onto the street that runs into the ring at the exit, pointed off the map — a lane
   * rather than the junction (`findRouteOnto`), because a cop that reached the exit along the ring
   * has nowhere straight on to go. A car already on it has nothing to route.
   */
  function headOut(cop) {
    state.leg = 'out';
    if (onExitLane(cop)) { cop.route = []; return; }
    const route = findRouteOnto(planOrigin(cop), state.exit, state.exitD);
    if (route?.length) { cop.route = route; cop.routeConsumed = false; }
    else routeTo(cop, state.exit);
  }

  /**
   * On the out leg: drive off the map once it sets off across the ring.
   *
   * It leaves the traffic model at its hold line, the frame its state flips to `turn` — the ring is
   * give-way, so that is the frame the ring has been judged clear — and `police.release` carries the
   * cruiser straight on, across the ring and off the asphalt, dissolving only past the slab's edge.
   * It used to dissolve *at* the exit junction, which is on the ring and in frame whenever the camera
   * is near that side of town: reported as the patrol "fading out mid city".
   */
  function crossOut(cop) {
    if (onExitLane(cop)) {
      if (cop.state === 'turn' && traffic.retirePolice(cop)) {
        police.release(state.exitD, (isXAxis(state.exitD) ? SLAB_X : SLAB_Z) / 2);
        state.cop = null;
        state.phase = 'exiting';
        state.heat = 0;
      }
      return;
    }
    // Out of route short of the exit lane — the router's last turn is behind it and the dice took
    // it somewhere else. Point it back.
    if (!cop.route?.length) headOut(cop);
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

  /**
   * Would turning round in the road get the cop to the taxi sooner than driving on? That is the
   * taxi that has just boosted past it the other way, and the cop U-turns after it (`uturnWanted`,
   * see UTURN_SPEED in sim/traffic.js) rather than driving on to lap the block — which is all the
   * router can offer a car facing away from its target, and reads as a cop that has not seen you.
   *
   * Asked of the router rather than of the geometry. The first cut asked whether the taxi was
   * behind the cop on the same road, heading away, and it lapsed within half a second on most
   * staged chases: a taxi boosting past turns off at the junction behind the cop, and is then on
   * another road — exactly where a real cop still turns round to follow it.
   *
   * **In legs, and only for a saving of two** — which is the lap. The second cut priced each side in
   * road (the lane left to drive plus the legs beyond, the U-turn charged a block) and flip-flopped:
   * the two sides differ by a leg as often as not, and then they break even in the middle of the
   * lane, which is exactly where the U-turn window is. The cop braked hard for the turn and was
   * told to drive on as it arrived, over and over — no U-turn, and a chase that lost a second at a
   * time to it (over the probe's 30 staged chases a full tank's median getaway fell from 6.0s to
   * 5.8s, most of it on chases that never turned round at all). A leg saved is about what the brake,
   * the swing and the pull-away cost; two is the lap, and does not change as the cop drives down
   * the lane.
   *
   * Measured on those 30 chases once the target was the junction after next: 4 turn round, each of
   * them catching the taxi sooner or keeping up with it longer, and no chase that did not turn
   * changed at all. A taxi off the pill is caught in a median 6.6s rather than 7.6s; a full tank
   * still gets away in 6.0s.
   */
  let turnRoundKey = null;
  let turnRoundAnswer = false;
  /** Chase time of the last U-turn, and how long before another — see `turnRound`. */
  let turnedAt = -Infinity;
  const UTURN_SETTLE = 4;
  function turnRound(cop) {
    if (cop.state !== 'drive' || cop.uturn || !cop.lane) return false;
    // Not twice running: a cop that has just come round and is asked to go back reads as lost.
    if (state.elapsed - turnedAt < UTURN_SETTLE) return false;
    // Where the taxi is *going*: the junction after the one it will next choose at, along its route
    // or straight on. Aimed at the next one alone, a taxi about to turn onto the cop's road behind
    // it counted as behind the cop — which turned round, and then wanted to turn back once the
    // taxi had come round the corner after it.
    const target = junctionAhead(taxi, 1);
    const key = `${cop.lane.id}|${target.i},${target.j}`;
    if (key !== turnRoundKey) {
      turnRoundKey = key;
      turnRoundAnswer = turnsRound(cop, target);
    }
    return turnRoundAnswer;
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
  function spot(cop, grace = 0) {
    cop.siren = true;
    police.setBar('strobe');
    cop.chase = 1;
    cop.ram = grace <= 0;
    cop.route = [];
    state.phase = 'chase';
    state.elapsed = 0;
    state.escape = 0;
    state.heat = 1;
    state.grace = grace;
    state.spotted += 1;
    aimedAt = null;
    turnedAt = -Infinity;
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
    cop.ram = false;
    cop.roadblock = 0;
    cop.uturnWanted = false;
    cop.route = [];
    routeTo(cop, { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J });
    state.phase = 'leaving';
    state.heat = 0;
    state.escape = 0;
    taxi.fleeFrom = null;
    state.standingDown = 0;
    aimedAt = null;
  }

  /** Off the road, and the cooldown to the next one starts. */
  function retire() {
    state.cop = null;
    state.heat = 0;
    taxi.fleeFrom = null;
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
   * Fill or cool the heat for one frame on patrol; answers whether it has boiled over. A ram on the
   * pill (`rammedGrace`) is noticed outright, as boosting within SPOT_RANGE always was: the taxi is
   * touching the cop.
   */
  function notice(dt, boosting, near, sight, rammedGrace) {
    if (boosting && rammedGrace > 0 && near <= SPOT_RANGE) return true;
    if (boosting && near <= NOTICE_RANGE) {
      const close = SPOT_RANGE / Math.max(near, 1);
      const rate = Math.min(NOTICE_MAX, NOTICE_RATE * close * close) * (sight ? 1 : NOTICE_OFF_SIGHT);
      state.heat = Math.min(1, state.heat + rate * dt);
      state.cool = 0;
    } else {
      state.cool += dt;
      if (state.cool > COOL_DELAY) state.heat = Math.max(0, state.heat - COOL_RATE * dt);
    }
    return state.heat >= 1;
  }

  /** The escape meter's rate this frame, per second — see SHAKE_RANGE. */
  function escapeRate(near, sight) {
    const hold = 1 / ESCAPE_HOLD;
    if (near > ESCAPE_RANGE) return hold;
    if (sight) return -RESIGHT_RATE;
    if (near <= SHAKE_RANGE) return 0;
    return SHAKE_RATE + (hold - SHAKE_RATE) * (near - SHAKE_RANGE) / (ESCAPE_RANGE - SHAKE_RANGE);
  }

  /**
   * @param boosting  the taxi's Loco Mode is engaged — the one thing a patrol reacts to
   */
  function update(dt, { boosting = false } = {}) {
    // Owed by a ram in this frame's collision pass, and good for this frame only.
    const rammedGrace = state.rammedGrace;
    state.rammedGrace = 0;
    if (state.phase === 'off') {
      if (blocked()) return;
      state.cooldown -= dt;
      if (state.cooldown <= 0) enter();
      return;
    }

    // Driving off the island with no traffic car under it. Retired once it has dissolved.
    if (state.phase === 'exiting') {
      if (!police.state.loose || police.state.loose.done) retire();
      return;
    }

    const cop = state.cop;
    // Gone out from under us — wrecked by a ram (which is the end of the run), or the fleet cleared.
    if (!cop || cop.crashed || !cop.police) { retire(); return; }
    if (state.phase === 'arrest') return;
    if (taxi.crashed) return;   // the run is ending; leave the scene as it is for the shot

    const near = gap(cop);
    const sight = inSight(cop, near);
    state.sight = sight;
    state.evading = false;

    if (state.phase === 'patrol') {
      // A robbery wants the streets: stand the patrol down rather than have a dark cop car
      // wandering through a getaway it takes no part in.
      if (blocked()) { leave(cop); return; }
      if (notice(dt, boosting && !taxi.staged, near, sight, rammedGrace)) {
        spot(cop, Math.max(rammedGrace, SPOT_GRACE));
        return;
      }
      if (state.leg === 'in') {
        state.legTime += dt;
        if (state.legTime > PATROL_TIME) headOut(cop);
        else cruise(cop);
      }
      if (state.leg === 'out') crossOut(cop);
      return;
    }

    if (state.phase === 'leaving') {
      driveOff(cop, dt);
      return;
    }

    // --- chase
    state.elapsed += dt;
    if (rammedGrace > state.grace) {
      state.grace = rammedGrace;
      cop.ram = false;
    }
    steer(cop);
    // Asked every frame, so it lapses the moment the taxi turns off. The U-turn re-plans nothing
    // itself: it leaves the cop with no route, and `steer` above picks that up next frame.
    if (cop.uturn) turnedAt = state.elapsed;
    cop.uturnWanted = turnRound(cop);
    cop.pursuit = Math.max(0, Math.min(1, (near - PURSUIT_FROM) / (PURSUIT_FULL - PURSUIT_FROM)));
    if (state.grace > 0) {
      state.grace -= dt;
      cop.ram = state.grace <= 0;
    }
    if (state.grace <= 0 && touching(taxi, cop, TOUCH_SLACK)) {
      state.caught += 1;
      // Pull up where it is. `roadblock` is the chosen stop the box-in already uses — it rides the
      // braking flag — and it is what keeps the cop from driving on into a taxi the traffic model
      // has stopped counting as a car in its lane.
      //
      // And it stops *here*, not after a braking distance. The bust freezes the taxi and flags it
      // crashed, and a crashed taxi drops out of sim/collisions.js, so nothing shoves the cop off it
      // any more: a ram arrives at up to 21 u/s, and braking from that at the ordinary rate carried
      // the cop straight through — measured over 30 staged catches, 20 ended 1.2–2.3 units deep,
      // 2.3 being the whole envelope, one car drawn on top of the other. The touch is the impact.
      cop.v = 0;
      cop.roadblock = Infinity;
      cop.pursuit = 0;
      cop.ram = false;
      cop.uturnWanted = false;
      state.phase = 'arrest';
      taxi.fleeFrom = null;
      onCaught(cop);
      return;
    }
    // The auto-driving taxi leans its turns away from the cop (`fleeWeight` in sim/traffic.js).
    // A routed taxi never reads it: the player's route wins.
    taxi.fleeFrom = cop;
    const rate = escapeRate(near, sight);
    state.evading = rate > 0;
    state.escape = Math.max(0, Math.min(1, state.escape + rate * dt));
    state.heat = 1 - state.escape;
    if (state.escape >= 1 || state.elapsed > CHASE_MAX) {
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
    /**
     * Take over the nearest of `cops` as a chase: the robbery's getaway is over, the robber is out,
     * and one of the cars that was after them comes after the taxi instead (game/robbery.js,
     * `handOff`). From here it is an ordinary patrol chase — the strobe, "Pull over!", caught on a
     * touch or lost ESCAPE_BLOCKS out — which is the point: it is the rule the player already
     * knows, not a second one.
     *
     * Only a cop already inside ESCAPE_RANGE is taken. One further out has lost the taxi by this
     * module's own definition, and handing it a chase would have it give up a second and a half
     * later with a radio call about a car nobody saw. Answers the cop taken, or null.
     *
     * A cruiser still on the map from before the robbery (driving off — a robbery stands a patrol
     * down, see `blocked`) is taken off to make room: there is one cruiser mesh. By the end of a
     * getaway it has almost always gone on its own.
     */
    pursueNearest(cops) {
      if (taxi.crashed || taxi.staged || state.phase === 'chase' || state.phase === 'arrest') return null;
      let best = null;
      let bestD = ESCAPE_RANGE;
      for (const cop of cops) {
        if (cop.crashed || cop.staged || !cop.police) continue;
        const d = gap(cop);
        if (d < bestD) { best = cop; bestD = d; }
      }
      if (!best) return null;
      if (state.cop) {
        if (!traffic.retirePolice(state.cop)) return null;
        retire();
      }
      best.patrol = true;
      police.wear(best, { fade: false });
      state.cop = best;
      spot(best);
      state.grace = HANDOFF_GRACE;
      best.ram = false;
      return best;
    },
    /**
     * The taxi has just rammed `cop` on the pill — a bump, not an arrest (see RAMMED_GRACE). Called
     * from the collision pass, which runs before `update` in the same frame. Anything but the
     * patrol's own cop is ignored: a robbery's cops never bust anybody.
     */
    rammed(cop) {
      if (cop === state.cop) state.rammedGrace = RAMMED_GRACE;
    },
    /**
     * The taxi has just pulled into the depot (main.js, the frame the opening takes it off the
     * road at the driveway): a chase in progress is called off as if the taxi had got clear —
     * bar dark, the cruiser routed away, the cooldown to the next patrol starting once it is out
     * of sight. Nothing else is touched: a crossing patrol carries on crossing, and one that is
     * already leaving keeps leaving. The arrest is past saving — the run is over. Answers whether
     * a chase was called off.
     *
     * It does not need to be told the taxi came back out. A staged taxi cannot be spotted (`sees`),
     * and by the time it is released the cop is driving off to the far corner.
     */
    hideout() {
      if (state.phase !== 'chase' || !state.cop) return false;
      state.hid += 1;
      const cop = state.cop;
      leave(cop);
      onHid(cop);
      return true;
    },
    /** Is a patrol after the taxi, or has it just lost it? The robbery waits for both. */
    busy: () => state.phase === 'chase' || state.phase === 'arrest',
  };
}
