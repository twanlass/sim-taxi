import {
  halfRoadX, halfRoadZ, isXAxis, dirSign, lineX, lineZ, opposite, PITCH,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { CAR_LEN, laneSpinRefusal, setClosedLanes, stageCar } from '../sim/traffic.js';
import { setBlockedLanes, setClosedJunctions } from './route.js';

// The getaway's last checkpoint, shut: three cop cars parked across its junction box, bars going,
// waiting for the taxi. Prototype, behind `?chase=stream` (game/robbery.js).
//
// **It is the U-turn's moment.** The chase is a stream of cops behind the taxi, and the box ahead
// is a wall, so the only way on is back past them: two taps of the brake and the taxi spins round
// onto the far lane (game/bootleg.js). Driving into the blockade those two taps are enough on their
// own — no Loco Mode and no speed (`cornered`) — because a taxi that has already pulled up at the
// cars has neither, and a player stood in front of a wall with no way to turn round is stuck. The
// robber says so as the cars come into view (`onCornered`, BLOCKADE_SHOUT in game/radio.js).
//
// **Getting to the cars counts as the checkpoint** (`arriveRadius` on the fare, game/fares.js). The
// mark is the corner, which the cars stand in front of; without this the checkpoint could only be
// had by ramming through them, and the spin would throw it away.
//
// **The cars are staged, the box is sealed hard.** Nothing in the traffic model parks a car across a
// junction, so the cops are taken out of traffic with `stageCar`, the way game/arrest.js takes its
// fan — and traffic cannot see a staged car, so nothing may drive into the box: `sealJunction`
// holds every arm, and `hard` holds a boosting taxi too, which an ordinary seal lets barge. A taxi
// at Loco speed into three parked cars is the wreck, and an imposed event does not get to end the
// run that way. The lanes in are closed to new traffic (`setClosedLanes`) from the moment the
// getaway is heading for the junction, so the box has drained when the cars go in and no queue
// grows at the seal; and every route is told it can drive *to* the junction but not through it
// (`setClosedJunctions`), so neither the taxi's re-plan after the spin nor a chasing cop asks to.
//
// **Only arms the spin works on.** A lane into the box that the taxi could not turn round on — an
// arterial (the median), a bridge — is shut to routes outright (`setBlockedLanes`), so the taxi can
// only ever arrive somewhere it can leave. No such arm, no blockade.
//
// **Staged out of shot, as early as it can be.** The cars go in the first frame the box is out of
// the camera, empty, and not on the route the taxi is driving right now — usually while it is still
// on an earlier leg, so there is no pop-in to hide. If the taxi is coming at it and close before any
// of that holds, there is no blockade this getaway.

/** How many cars make the wall. Two across the mouth the taxi is expected by, one behind. */
const CARS = 3;
/** Nearer than this and the cars would be put down in front of the taxi: not staged. Units. */
const PLACE_MIN = 1.5 * PITCH;
/**
 * How close to the junction centre counts as reaching the checkpoint while the blockade stands.
 * The stop line is 7.4 out; one car queued ahead of the taxi puts it at 12.7, two at 18. 16 takes
 * the first and leaves the second short.
 */
const REACH = 16;
/** How near the junction the robber shouts about it. About half the frame's height at play zoom. */
const SIGHTED = 36;
/** How far the taxi has to be before the cars are taken off — `LOST_RANGE`'s 56. */
const LIFT_RANGE = 56;
/**
 * The two cars across the mouth point in at the middle of the road and back toward the taxi by
 * this much, rad, so the pair reads as a V aimed at it rather than as two cars parked end to end.
 */
const SPLAY = 0.44;

/**
 * @param traffic     the sim — `enterPolice`, `retirePolice`, `sealJunction`, `cars`
 * @param taxi        the traffic model's taxi
 * @param inShot      (x, z) => boolean — could the player be looking at this point? Null in the tools.
 * @param onCornered  () => void — the taxi is driving into it; the robber says so
 */
export function createBlockade({ traffic, taxi, inShot = null, onCornered = () => {} }) {
  const state = {
    /** idle → armed (waiting to stage) → standing → idle. */
    phase: 'idle',
    /** The junction, while armed or standing. */
    at: null,
    /** How many have stood this run, for the tools. */
    stood: 0,
    /** The robber has shouted about this one. */
    sighted: false,
  };
  let fare = null;
  let cops = [];
  let node = null;
  let inLaneIds = new Set();
  /** The arms the taxi can turn round on, as headings into the junction. */
  let spinnable = [];
  // Once the event it belongs to is over, it only waits to be out of sight.
  let released = false;

  const seen = (x, z) => Boolean(inShot?.(x, z));
  const centre = () => ({ x: lineX(state.at.i), z: lineZ(state.at.j) });
  const range = () => {
    const c = centre();
    return Math.hypot(taxi.x - c.x, taxi.z - c.z);
  };
  const isHere = (p) => p?.i === state.at.i && p?.j === state.at.j;
  /** The getaway still has this junction to touch, and it is the one it is driving for now. */
  const targeted = () => isHere(fare?.target);
  /** ...or it has touched it already. */
  const touched = () => !targeted() && !fare?.checkpoints?.some(isHere);

  /**
   * The heading the taxi will come into the junction on, off its route, or null if its route does
   * not go there. A taxi already on a lane into it answers its own heading.
   */
  function approach() {
    let { i, j } = taxi;
    if (taxi.state === 'drive' && i === state.at.i && j === state.at.j) return taxi.d;
    const steps = [];
    if (taxi.state === 'turn' && taxi.dOut != null) steps.push(taxi.dOut);
    steps.push(...(taxi.route ?? []));
    for (const d of steps) {
      if (isXAxis(d)) i += dirSign(d); else j += dirSign(d);
      if (i === state.at.i && j === state.at.j) return d;
    }
    return null;
  }

  /**
   * Which mouth to face the cars at when the taxi is not on its way yet: the spinnable arm on the
   * side the leg before this one starts from — the checkpoint before it, or the taxi. A guess, and
   * a cheap one to get wrong: every arm is sealed, so the cars are a wall from any side.
   */
  function expected() {
    const list = fare?.checkpoints ?? [];
    const k = list.findIndex(isHere);
    const from = k > 0 ? list[k - 1] : { i: taxi.i, j: taxi.j };
    // Headings *into* the junction: coming from the west is travelling east, and so on.
    const dx = state.at.i - from.i;
    const dz = state.at.j - from.j;
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    const alongX = dx >= 0 ? 0 : 2;
    const alongZ = dz >= 0 ? 1 : 3;
    const ranked = xFirst ? [alongX, alongZ] : [alongZ, alongX];
    ranked.push(opposite(ranked[1]), opposite(ranked[0]));
    return ranked.find((d) => spinnable.includes(d)) ?? spinnable[0];
  }

  function reopen() {
    if (state.at) traffic.sealJunction(state.at.i, state.at.j, false);
    setClosedLanes([], 'blockade');
    setBlockedLanes([], 'blockade');
    setClosedJunctions([]);
    if (fare) fare.arriveRadius = null;
    fare = null;
    cops = [];
    node = null;
    inLaneIds = new Set();
    spinnable = [];
    released = false;
    state.phase = 'idle';
    state.at = null;
    state.sighted = false;
  }

  /**
   * The box is clear of anything crossing it — a staged car would be driven through — and the lanes
   * into it are clear of anything queued: the seal holds it at the line for good, and a lane with
   * somebody stuck in it is a lane the taxi cannot get into (the line refuses a car whose exit has
   * no room). Measured before this, one getaway in sixteen stopped a junction short of the cars
   * behind a car that had been waiting at the light when they went in. The lanes in are closed to
   * new traffic from `arm`, so this only waits for the queue there was to drain.
   *
   * And nothing still *leaving* it: a car that has finished its turn is on the lane out at s = 0,
   * with half its body back in the box. Without the footprint test, five getaways in sixteen staged
   * the wall onto the tail of somebody driving out of it (penetration 0.8 to 1.9).
   */
  function boxEmpty() {
    const c = centre();
    const reachX = halfRoadZ(state.at.i) + CAR_LEN;
    const reachZ = halfRoadX(state.at.j) + CAR_LEN;
    for (const car of traffic.cars) {
      if (car === taxi || car.staged) continue;
      if (Math.abs(car.x - c.x) < reachX && Math.abs(car.z - c.z) < reachZ) return false;
      if (car.state === 'turn' && car.i === state.at.i && car.j === state.at.j) return false;
      if (car.state === 'drive' && car.lane?.to === node) return false;
      // ...including one part way round a corner into one, which committed before they closed.
      if (car.state === 'turn' && inLaneIds.has(car.turn?.outLane)) return false;
    }
    return true;
  }

  /**
   * Where the three cars stand, in the box, as {x, z, yaw}; `d` is the heading the taxi comes in
   * on. The pair across the mouth sits back from the near edge by enough to keep a splayed body's
   * corners inside the box (the queue at the line has its nose 1.7 short of it), nose to nose with
   * a few hundredths between them; the third stands behind them at 45°. Only ordinary streets get
   * here — the spin rules out an arterial approach — so the box is 8 across the taxi's road.
   */
  function slots(d) {
    const c = centre();
    const fx = isXAxis(d) ? dirSign(d) : 0;
    const fz = isXAxis(d) ? 0 : dirSign(d);
    const rx = -fz;
    const rz = fx;
    // Half the box along the taxi's heading is half the *crossing* road; across it, half its own.
    const along = isXAxis(d) ? halfRoadZ(state.at.i) : halfRoadX(state.at.j);
    const across = isXAxis(d) ? halfRoadX(state.at.j) : halfRoadZ(state.at.i);
    const yawOf = (x, z) => Math.atan2(-z, x);
    const out = [];
    for (const side of [1, -1]) {
      const nx = -rx * side * Math.cos(SPLAY) - fx * Math.sin(SPLAY);
      const nz = -rz * side * Math.cos(SPLAY) - fz * Math.sin(SPLAY);
      const lon = -(along - 1.9);
      const lat = side * (across - 2.1);
      out.push({ x: c.x + fx * lon + rx * lat, z: c.z + fz * lon + rz * lat, yaw: yawOf(nx, nz) });
    }
    const lon = along - 2;
    out.push({ x: c.x + fx * lon, z: c.z + fz * lon, yaw: yawOf((fx + rx) / Math.SQRT2, (fz + rz) / Math.SQRT2) });
    return out;
  }

  function stand(d) {
    const placed = traffic.enterPolice(CARS, centre());
    const fresh = traffic.policeCars.slice(traffic.policeCars.length - placed);
    if (placed < 2) {
      for (const cop of fresh) traffic.retirePolice(cop);
      return false;
    }
    const at = slots(d);
    fresh.forEach((cop, k) => {
      cop.blockade = true;
      cop.chase = 0;
      stageCar(cop, at[k].x, at[k].z, at[k].yaw);
    });
    cops = fresh;
    traffic.sealJunction(state.at.i, state.at.j, true, { hard: true });
    setClosedJunctions([node]);
    state.phase = 'standing';
    state.stood += 1;
    return true;
  }

  function lift() {
    for (const cop of cops) traffic.retirePolice(cop);
    reopen();
  }

  /** Is the taxi driving into it — on a lane into the box, close enough to see the cars? */
  function cornered() {
    if (state.phase !== 'standing' || released || taxi.state !== 'drive' || !taxi.lane) return false;
    return taxi.lane.to === node && range() < SIGHTED + PITCH;
  }

  return {
    state,
    cornered,
    /** Is this car (not one of the wall) queued on a lane into the standing blockade? */
    holds: (car) => state.phase === 'standing' && !car.staged && car.state === 'drive'
      && car.lane?.to === node,
    /** The cars, for the tools. */
    cops: () => cops,

    /**
     * Shut `at`, a checkpoint the getaway `robber` still has to touch. Closes the lanes into it to
     * new traffic straight away, so the box has drained by the time the cars go in.
     */
    arm(robber, at) {
      if (state.phase !== 'idle' || !at) return;
      const net = cityNetwork();
      state.at = { i: at.i, j: at.j };
      fare = robber;
      const inLanes = [0, 1, 2, 3]
        .map((d) => ({ d, lane: net.laneByGrid(d, at.i, at.j) }))
        .filter(({ lane }) => lane && !lane.degenerate);
      spinnable = inLanes.filter(({ d, lane }) => !laneSpinRefusal(lane, d, at.i, at.j)).map(({ d }) => d);
      // A closed lane keeps traffic out by pricing every turn into it at nothing — but a car with
      // no other way on takes it anyway (`rollExit` in sim/traffic.js), and at the seal it is stuck
      // for good, in the lane the taxi needs. Measured once in thirty getaways, at a map corner.
      const forced = inLanes.some(({ lane }) => {
        const from = net.nodeById.get(lane.from);
        return [0, 1, 2, 3].some((d) => {
          const into = net.laneByGrid(d, from.gi, from.gj);
          return into && !into.degenerate && into.onward.length > 0
            && into.onward.every((out) => out === lane || out.degenerate);
        });
      });
      if (!spinnable.length || forced) { reopen(); return; }
      inLaneIds = new Set(inLanes.map(({ lane }) => lane.id));
      node = inLanes[0].lane.to;
      released = false;
      state.phase = 'armed';
      setClosedLanes(inLanes.map(({ lane }) => lane.id), 'blockade');
      setBlockedLanes(inLanes.filter(({ d }) => !spinnable.includes(d)).map(({ lane }) => lane.id), 'blockade');
    },

    /** The event is over (delivered, bailed): take the cars off once nobody can see them go. */
    release() {
      if (state.phase === 'armed') { reopen(); return; }
      if (state.phase === 'standing') released = true;
    },

    /** A run ending: everything off now, there is a retry screen over it. */
    clear() {
      if (state.phase === 'standing') lift(); else reopen();
    },

    update() {
      if (state.phase === 'armed') {
        const toward = approach();
        // Too late: the taxi is coming at it and nearly there.
        if (targeted() && toward != null && range() < PLACE_MIN) { reopen(); return; }
        // Not while the route the taxi is driving goes through it on an earlier leg — that taxi
        // would be cornered somewhere it has nothing to touch.
        if (toward != null && !targeted()) return;
        const c = centre();
        if (range() < PLACE_MIN || seen(c.x, c.z) || !boxEmpty()) return;
        const d = toward != null && spinnable.includes(toward) ? toward : expected();
        if (!stand(d)) reopen();
        return;
      }
      if (state.phase !== 'standing') return;
      // Getting to the cars is getting to the checkpoint. game/fares.js clears the radius on every
      // checkpoint, so it is put back while this one is the target.
      if (targeted() && fare.arriveRadius !== REACH) fare.arriveRadius = REACH;
      // Done with: the event is over or the checkpoint touched, and the taxi well away. The cars
      // go when nobody can see them.
      const c = centre();
      if ((released || touched()) && range() > LIFT_RANGE && !seen(c.x, c.z)) {
        lift();
        return;
      }
      if (!state.sighted && cornered() && range() < SIGHTED) {
        state.sighted = true;
        onCornered();
      }
    },
  };
}
