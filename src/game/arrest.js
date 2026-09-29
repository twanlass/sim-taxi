import {
  GRID_I, GRID_J, dirSign, halfRoadX, halfRoadZ, isXAxis, lineX, lineZ, opposite,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { findRoute, planOrigin } from './route.js';
import { CAR_LEN, SPAWN_CLEARANCE, STOP_SETBACK, releaseCar, stageCar } from '../sim/traffic.js';

// The end of a bank robbery that got where it was going: the robber climbs out onto the corner, puts
// their hands up, and the police come screaming in and **circle them**, bars going, until one pulls
// up at the kerb and the robber is put in the back of it.
//
// **The robber stands on the corner and the cops go round the junction, not round the robber**, and
// that is geometry rather than taste. A drop-off corner is a kerb corner (`cornerFor` in
// game/fares.js): half a unit onto the pavement of a block whose buildings start another 0.35 in. A
// circle *centred on the robber* runs a quarter of its length through that block, whatever its
// radius — there is no ring round a figure standing on a corner that stays on the road. So the ring
// is the junction box, sized off the box itself (RING_PAD), and its nearest pass is about a car's
// width off the robber's shoulder (2.4 centre to figure, measured). From the fixed camera the
// robber's corner is the near one (`cornerFor` picks it so), so the cars sweep round directly behind
// and beside them, which is what "circling" has to look like on screen.
//
// **These cars are driven by hand.** Nothing in the traffic model can drive a circle: a car there is
// always on a lane or on a turn's Bézier, and neither goes round. So a cop that arrives is taken out
// of traffic with `stageCar` — the split the opening vignette uses for the taxi in its garage: out of
// every simulation loop, still posed by the render pass, so it keeps its suspension and its lights —
// driven round here, and handed back with `releaseCar` on a lane leaving the junction. That makes
// two things this module's job that traffic would otherwise do:
//
//   - **Nothing else may be in the box.** Traffic cannot see a staged car, so an ambient car let
//     into the junction would drive straight through the circling cops. The junction is sealed
//     (`sealJunction` in sim/traffic.js) for as long as the scene has a car in it, and a cop is only
//     taken into the box once it is empty.
//   - **The hand-back has to land clear of the stop line.** `releaseCar` will put a car anywhere on
//     a lane, and one released inside its own hold line runs the next light (see CLAUDE.md). Every
//     release here is a few units down a lane *leaving* the sealed junction, so the far end's line
//     is a whole lane-length away, and nothing is coming up behind it because nothing can leave a
//     sealed box.
//
// The scene is a sequence, one phase at a time:
//
//   converge  cops routed to the junction as ordinary chasing traffic and held at its line; each is
//             staged once the box is empty and there is a gap in the ring, and goes on rails once
//             it is on it (`tryStage`, `circle`)
//   circle    round and round, each on its own wobble and drifting nose-in (CIRCLE_TIME)
//   close     the one best placed peels off and pulls up at the kerb beside the robber
//   board     the robber runs to it and is gone (BOARD_TIME)
//   leave     one at a time the rest peel off down the arms, are handed back to traffic with their
//             bars off, and drive off the map the way a robbery's stood-down cops always have

/**
 * How far round the junction box the ring runs, past the kerb line on each axis. None: the ring is
 * the box's own edge.
 *
 * It was half a unit out at first, and the thing it ran into was the **queue**. The seal holds
 * traffic at every stop line (sim/traffic.js), a queued car's nose is `STOP_SETBACK - CAR_LEN / 2`
 * = 1.7 past the box edge, and a car sliding nose-in (DRIFT) swings its tail out by
 * `CAR_LEN / 2 · sin(DRIFT)` on top of its own half-width — so at half a unit out, every pass of an
 * arm clipped the front of whoever was waiting there (measured on 4 seeds in 5). On the box edge
 * the tail clears the queue by 0.4, and the robber, 6.4 out on the diagonal, by about 1.3.
 */
const RING_PAD = 0;

/**
 * How far inside that each car's own line may wander, in units — the chaos. Inward only, for both
 * of the reasons above.
 */
const WOBBLE = 0.5;

/** Ring speed, u/s. About a lap every three seconds on an ordinary street's junction. */
const RING_V = 9;
/**
 * The least arc between two cars on the ring, centre to centre. A body length and a bit, plus what
 * sliding nose-in costs: two cars both turned DRIFT across a curve need more road between their
 * centres than two driving straight.
 */
const RING_GAP = CAR_LEN + 2.2;
/** The tightest a hand-driven cop turns, in units of radius. Under the ring's own 4 on a street. */
const TURN_R = 3.2;
/** Nose into the ring by this much, rad: donuts, not a roundabout. See RING_PAD for its cost. */
const DRIFT = 0.28;
const ACCEL = 12;
const DECEL = 18;

/**
 * How close, along its arm, a converging cop has to be to be taken out of traffic. Past the queue a
 * sealed junction builds up on its approach (three or four cars), because a cop behind one goes in
 * up the far side of the road — see `tryStage` and `upFarSide`.
 */
const ENTER_R = 26;

/**
 * No cop goes into the box while the taxi is this near its middle. Collision only ever tests the
 * taxi, and off the pill a staged car is not even shoved (sim/collisions.js), so a cop circling
 * through a taxi that has not yet pulled away from the drop-off would be drawn straight through it.
 */
const TAXI_CLEAR = 11;

/** Seconds of circling before one of them closes in — from the first car on the ring. */
const CIRCLE_TIME = 4.5;
/** ...but a cop still coming is waited for this much longer, so the ring fills before it breaks. */
const LATE_WAIT = 3;
/** How long past that the kerb is waited for, if something is parked where the car pulls up. */
const KERB_WAIT = 4;
/** The robber's run from the kerb into the car. */
const BOARD_TIME = 1;
/** Seconds between cops peeling off the ring on the way out. */
const LEAVE_GAP = 0.7;
/** Nobody has made it to the ring by now: the robber gives up waiting. */
const ARREST_WAIT = 14;
/** The backstop over the whole scene, well inside the figure's own (`EXIT_HOLD_MAX`, game/fares.js). */
const SCENE_MAX = 40;

/** Seconds the car queued behind a cop is held while that cop pulls out of the line — see `tryStage`. */
const PULL_OUT = 1.6;
/**
 * See `peelAt`: how far across toward its lane a car is when it leaves the ring, as a fraction of
 * the lane's offset — negative, so a little *short* of the arm. The turn out carries a car about a
 * lane and a half sideways, so it has to start early. Swept over eight seeds: at +0.35 the car
 * arriving to pick the robber up ran onto the kerb, its centre 0.98 from the figure; at 0 it landed
 * 0.8 wide of its lane; at -0.2 it lands on it, 2.35 from the figure — no nearer than the ring
 * itself passes — and pulls up two seconds sooner.
 */
const PEEL_ACROSS = -0.2;
/** A hand-driven car that has sat still this long, short of where it was going, is called there. */
const STUCK = 1.5;
/** Where a car pulls up beside the robber, measured from the junction's middle along the arm. */
const PARK_OUT = 3.4;
/** How far down a lane leaving the junction a cop is handed back to traffic. */
const RELEASE_S = 4;

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (x, z) => Math.atan2(-z, x);
const unit = (d) => ({ x: isXAxis(d) ? dirSign(d) : 0, z: isXAxis(d) ? 0 : dirSign(d) });

/**
 * @param traffic  the sim — `sealJunction`, `retirePolice`, `cars`
 * @param taxi     the player's car
 * @param inShot   `(x, z) => boolean`: could the player be looking at this point? main.js asks the
 *                 camera; without one it is "within SPAWN_CLEARANCE of the taxi", which is what the
 *                 camera shows when nobody has panned it — see `outOfShot`.
 */
export function createArrest({ traffic, taxi, inShot = null }) {
  const state = {
    /** 'off' | 'converge' | 'circle' | 'close' | 'board' | 'leave' — see the header. */
    phase: 'off',
    /** Seconds in this scene, and in this phase. */
    time: 0,
    phaseTime: 0,
    /** Seconds since the first car made the ring, or -1. */
    ringTime: -1,
    /** Tallies, for the tools. */
    scenes: 0,
    arrests: 0,
  };

  let J = null;
  let centre = null;
  let figure = null;
  /** Per cop: { car, mode, v, heading, slot, wobble, arm, rail, peel, exit, stuck } */
  let crew = [];
  let arms = [];
  let ring = null;
  let park = null;
  let sinceLeave = 0;

  function armsAt(at) {
    const net = cityNetwork();
    const out = [];
    for (let e = 0; e < 4; e++) {
      const leave = net.laneOutByGrid(e, at.i, at.j);
      const arrive = net.laneByGrid(opposite(e), at.i, at.j);
      out.push({ e, u: unit(e), leave, exists: Boolean(leave || arrive) });
    }
    return out;
  }

  /** The ring's two half-axes, and which way round it runs. */
  function ringFor() {
    const hx = halfRoadZ(J.i);
    const hz = halfRoadX(J.j);
    const rx = hx + RING_PAD;
    const rz = hz + RING_PAD;
    // Round the way that puts a cop coming in on the far side of the road — past the queue the
    // seal builds on the near side — straight onto it: the ring's tangent at each arm points at the
    // side of the road the lane *leaving* the junction is on. Traffic keeps right everywhere, so
    // the first arm with a lane out answers for all of them.
    let sense = 1;
    for (const arm of arms) {
      if (!arm.leave) continue;
      const side = lateralOf(arm);
      const theta = Math.atan2(arm.u.z, arm.u.x);
      const tx = -rx * Math.sin(theta);
      const tz = rz * Math.cos(theta);
      sense = tx * side.x + tz * side.z >= 0 ? 1 : -1;
      break;
    }
    return { hx, hz, rx, rz, sense, phase: 0, omega: RING_V / ((rx + rz) / 2) };
  }

  /** Which side of the road an arm's lane *out* is on, as a unit vector, and how far off the middle. */
  function lateralOf(arm) {
    const p = arm.leave.path.at(Math.min(1, arm.leave.length));
    const vx = p.x - centre.x;
    const vz = p.z - centre.z;
    const along = vx * arm.u.x + vz * arm.u.z;
    const lx = vx - along * arm.u.x;
    const lz = vz - along * arm.u.z;
    const off = Math.hypot(lx, lz) || 1;
    return { x: lx / off, z: lz / off, off };
  }

  const armHalf = (arm) => (isXAxis(arm.e) ? ring.hx : ring.hz);

  /**
   * Where on the ring a car leaves it for `arm`'s lane out: just short of the arm itself. The ring
   * runs *toward* that lane's side as it crosses each arm (see `ringFor`), so the car is already
   * heading the right way and only has to turn out — and the turn carries it across onto the lane
   * (PEEL_ACROSS). Leaving from wherever it happened to be, the first cut, had it cutting across
   * the ring in front of the others.
   */
  function peelAt(arm) {
    const side = lateralOf(arm);
    const r = isXAxis(arm.e) ? ring.rz : ring.rx;
    return wrap(Math.atan2(arm.u.z, arm.u.x) + ring.sense * Math.asin(Math.min(0.9, PEEL_ACROSS * side.off / r)));
  }

  /** Pull a ring point back inside the box on any side with no road beyond it. */
  function clampToRoad(p) {
    for (const arm of arms) {
      if (arm.exists) continue;
      const along = (p.x - centre.x) * arm.u.x + (p.z - centre.z) * arm.u.z;
      const limit = armHalf(arm) - 1;
      if (along > limit) {
        p.x -= (along - limit) * arm.u.x;
        p.z -= (along - limit) * arm.u.z;
      }
    }
    return p;
  }

  const angleOf = (x, z) => Math.atan2((z - centre.z) / ring.rz, (x - centre.x) / ring.rx);
  const ringPoint = (theta, shrink = 0) => clampToRoad({
    x: centre.x + (ring.rx - shrink) * Math.cos(theta),
    z: centre.z + (ring.rz - shrink) * Math.sin(theta),
  });

  /**
   * Is anything but this scene's own staged cars inside the box, or about to be? "About to be"
   * includes a car still short of it on its run-up: `state` flips to `'turn'` at the hold line,
   * STOP_SETBACK before the box (see CLAUDE.md), and a car that has flipped is committed — a seal
   * going on then does not stop it.
   */
  function boxBusy() {
    const reachX = ring.hx + CAR_LEN / 2;
    const reachZ = ring.hz + CAR_LEN / 2;
    return traffic.cars.some((c) => !c.crashed && !c.staged
      && ((c.state === 'turn' && c.i === J.i && c.j === J.j)
        || (Math.abs(c.x - centre.x) < reachX && Math.abs(c.z - centre.z) < reachZ)));
  }

  const taxiNear = () => Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < TAXI_CLEAR;

  /**
   * Begin, at the junction the robber was delivered to.
   *
   * @param at      the drop-off junction
   * @param held    the figure on the kerb — the handle `beginExit` returns in game/fares.js
   * @param cops    the cars that are going to do it. Already cleared of anything the chase had them
   *                doing (game/robbery.js, `stop`); this puts their bars and their route on.
   */
  function begin(at, held, cops) {
    abandon();
    J = { i: at.i, j: at.j };
    centre = { x: lineX(J.i), z: lineZ(J.j) };
    figure = held;
    arms = armsAt(J);
    ring = ringFor();
    park = parkSpot();
    state.phase = 'converge';
    state.time = 0;
    state.phaseTime = 0;
    state.ringTime = -1;
    state.scenes += 1;
    sinceLeave = 0;
    crew = cops.map((car, k) => {
      car.arrest = true;
      // Held at the line rather than let through: a route that ends at a junction rolls the
      // ordinary dice there, and a cop driving on through the scene it was sent to has to come
      // all the way round the block again.
      car.holdAt = `${J.i},${J.j}`;
      car.siren = true;
      car.chase = 1;
      car.uturnWanted = false;
      return {
        car,
        mode: 'inbound',
        v: 0,
        heading: car.yaw,
        slot: k,
        // Each car's own wobble, so they do not breathe in and out together.
        wobble: { rate: 1.3 + 0.37 * k, phase: 1.9 * k },
        routedAt: null,
      };
    });
    for (const m of crew) routeIn(m);
  }

  /**
   * Where the arresting car pulls up: on the lane *out* of whichever arm beside the robber's corner
   * has that lane on the robber's side — so it stops at the kerb facing away from the junction, and
   * once the robber is in, simply drives on. Null if neither arm has one (a corner at the map's
   * edge), in which case the robber is taken in where they stand.
   */
  function parkSpot() {
    if (!figure) return null;
    const rx = figure.x - centre.x;
    const rz = figure.z - centre.z;
    for (const arm of arms) {
      if (!arm.leave) continue;
      // The arm has to run past the robber's corner...
      if ((isXAxis(arm.e) ? rx : rz) * (isXAxis(arm.e) ? arm.u.x : arm.u.z) <= 0) continue;
      // ...with its lane out on the robber's side of the road.
      const side = lateralOf(arm);
      if (side.x * rx + side.z * rz <= 0) continue;
      const lane = arm.leave;
      const start = lane.path.at(0);
      const along0 = (start.x - centre.x) * arm.u.x + (start.z - centre.z) * arm.u.z;
      const s = Math.min(lane.length - STOP_SETBACK - 1.5, Math.max(1, armHalf(arm) + PARK_OUT - along0));
      if (s <= 0) continue;
      return { arm, lane, s };
    }
    return null;
  }

  /** Route a converging cop at the junction. Keyed on where it is planning from — see CLAUDE.md. */
  function routeIn(m) {
    const from = planOrigin(m.car);
    const key = `${from.i},${from.j},${from.d}`;
    if (m.routedAt === key && m.car.route?.length) return;
    m.routedAt = key;
    const route = findRoute(from, J);
    m.car.route = route ?? [];
    m.car.routeConsumed = false;
  }

  /**
   * Take a converging cop out of traffic, if it can get onto the ring from where it is.
   *
   * Two ways in, and one car at a time on each arm, because two taken out together on the same
   * approach both wanted the same piece of road and piled into each other (measured, three deep).
   *
   *   - **From the front of the queue**, straight onto the ring: it is at the stop line with nothing
   *     between it and the box, so it pulls out onto the ring the moment there is a gap at that
   *     arm (`roomAt`). Until then it simply waits at the line — in traffic, so whatever comes up
   *     behind it queues behind it the ordinary way.
   *   - **From behind a queue**, once the box is sealed: up the far side of its own road, which a
   *     sealed junction has emptied (nothing can leave it), to the edge of the box — see `onLine`.
   */
  function tryStage(m) {
    const car = m.car;
    if (car.state !== 'drive' || car.pass > 0 || car.uturn) return;
    if (car.i !== J.i || car.j !== J.j) return;
    const arm = arms.find((a) => a.e === opposite(car.d));
    if (!arm) return;
    const along = (car.x - centre.x) * arm.u.x + (car.z - centre.z) * arm.u.z;
    if (along > ENTER_R) return;
    if (taxiNear() || boxBusy()) return;
    // The nearest car in front of it in its lane, if any — measured in the world rather than on
    // the lane, because the one in front may be a cop taken out of traffic this same frame, and a
    // staged car's lane position is whatever it was when it left.
    const laneAt = (c) => (c.x - centre.x) * -arm.u.z + (c.z - centre.z) * arm.u.x;
    let lead = Infinity;
    for (const c of traffic.cars) {
      if (c === car || c.crashed) continue;
      const a = (c.x - centre.x) * arm.u.x + (c.z - centre.z) * arm.u.z;
      if (a < along && a > armHalf(arm) - 1 && Math.abs(laneAt(c) - laneAt(car)) < 1.5) {
        lead = Math.min(lead, along - a);
      }
    }
    const ahead = lead < Infinity;
    const theta = Math.atan2(arm.u.z, arm.u.x);
    let mode;
    if (!ahead && along < armHalf(arm) + STOP_SETBACK + 2) {
      // Pulled up at the line, not still arriving at a chase's 20 u/s: that is a car coming onto
      // the ring at twice the ring's speed, into the back of whoever is on it.
      if (car.v > 3 || !roomAt(m, theta)) return;
      mode = 'ring';
    } else {
      // Not up the side the arresting car parks on: that *is* the far side, and it stops on it.
      if (!arm.leave || !J.sealed || arm === park?.arm) return;
      if (crew.some((o) => o.mode === 'in' && o.arm === arm)) return;
      // Room to get out round the car in front: two quarter-turns at TURN_R to cross the road, and
      // it was clipping the back of the queue at anything less.
      if (lead < 2 * TURN_R + CAR_LEN) return;
      // The far side has to be empty between it and the box. It only fills from the box, and
      // nothing leaves a sealed box — but a car can still be on its way out from before the seal,
      // and one of the scene's own can be on its way out down it (`exitFor`).
      const side = lateralOf(arm);
      const blocked = traffic.cars.some((c) => {
        if (c === car || c.crashed) return false;
        const a = (c.x - centre.x) * arm.u.x + (c.z - centre.z) * arm.u.z;
        const l = (c.x - centre.x) * side.x + (c.z - centre.z) * side.z;
        return a > armHalf(arm) && a < along + CAR_LEN && Math.abs(l - side.off) < 2.2;
      }) || crew.some((o) => o.exit?.arm === arm && o.mode !== 'gone');
      if (blocked) return;
      // ...and it has to be able to stop where it waits (`upFarSide`), from whatever speed the
      // chase has it doing: taken off the road at 20 u/s six units short, it ran through its mark
      // and into the ring.
      // And room to get across the road before it gets there: 2 · TURN_R + CAR_LEN, the same
      // swing as round the car in front.
      const edge = armHalf(arm) + STOP_SETBACK + 0.6;
      if (along - edge < Math.max((car.v * car.v) / (2 * DECEL) + 1, 2 * TURN_R + CAR_LEN)) return;
      mode = 'in';
    }
    const v = car.v;
    // **The box closes the moment the first car goes in, not when the robber gets out.** Sealed
    // from the drop-off, every arm queued up while the police were still on their way, and on a
    // busy street the queue backed out through the junction behind — with the cops in it
    // (measured: two held a block short for the whole of ARREST_WAIT, and no scene at all). Until
    // then only the cops are held (`holdAt`), and the traffic keeps moving past the robber.
    traffic.sealJunction(J.i, J.j, true);
    J.sealed = true;
    car.holdAt = null;
    stageCar(car, car.x, car.z, car.yaw);
    car.v = v;
    m.v = v;
    m.heading = car.yaw;
    m.mode = mode;
    m.arm = arm;
    m.stuck = 0;
    if (mode === 'ring' && state.ringTime < 0) state.ringTime = 0;
    // Whoever was queued behind it cannot see it any more — a staged car is out of traffic — and
    // rolls up to the line into the space it is still pulling out of (measured: the next cop in,
    // nose into the tail of the first). So it sits on its brakes for as long as the pull-out
    // takes, on the same `stun` a bumped car uses to do exactly that.
    for (const c of traffic.cars) {
      if (c === car || c.crashed || c.staged || c.lane !== car.lane || c.state !== 'drive') continue;
      if (c.s < car.s && car.s - c.s < 14) c.stun = Math.max(c.stun ?? 0, PULL_OUT);
    }
  }

  /**
   * Off the ring and onto a lane leaving the junction, `s` down it: a Bézier from the car's own
   * pose to the lane's, sampled by length so the car can be driven along it at a speed.
   *
   * **A curve, not steering**, and for the reason the ring went on rails. A car steered off the
   * ring and onto a lane overshot its line by however much its speed and the ring's shape at that
   * arm said — onto the kerb beside the robber, measured 1.3 from the figure, on the one edge
   * junction where the ring is flattened. The curve's control points run along the car's heading
   * and back along the lane, so it lies inside their hull: between the ring and the lane's line,
   * and never past it.
   */
  function pathOut(m, lane, s) {
    const car = m.car;
    const end = lane.path.at(s);
    const t = lane.path.tangentAt(s);
    const tl = Math.hypot(t.x, t.z) || 1;
    const reach = 0.45 * Math.hypot(end.x - car.x, end.z - car.z);
    const p0 = { x: car.x, z: car.z };
    const p1 = { x: car.x + Math.cos(m.heading) * reach, z: car.z - Math.sin(m.heading) * reach };
    const p2 = { x: end.x - (t.x / tl) * reach, z: end.z - (t.z / tl) * reach };
    const pts = [];
    let len = 0;
    for (let k = 0; k <= 24; k++) {
      const u = k / 24;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u * u;
      const d = u ** 3;
      const p = {
        x: a * p0.x + b * p1.x + c * p2.x + d * end.x,
        z: a * p0.z + b * p1.z + c * p2.z + d * end.z,
      };
      if (pts.length) len += Math.hypot(p.x - pts[pts.length - 1].x, p.z - pts[pts.length - 1].z);
      pts.push({ ...p, at: len });
    }
    return { pts, len, s: 0, yaw: yawOf(t.x, t.z) };
  }

  /** Drive along `m.path`; true at its end. `stop` brakes onto the end rather than through it. */
  function alongPath(m, dt, stop) {
    const car = m.car;
    car.skid = false;
    const path = m.path;
    const left = path.len - path.s;
    const want = stop ? Math.min(RING_V, Math.sqrt(2 * 6 * Math.max(0, left))) : RING_V;
    m.v += Math.max(-DECEL * dt, Math.min(ACCEL * dt, want - m.v));
    if (stop && left < 0.05) m.v = 0;
    path.s = Math.min(path.len, path.s + Math.max(m.v, stop ? 0.3 : 0) * dt);
    let k = 1;
    while (k < path.pts.length - 1 && path.pts[k].at < path.s) k += 1;
    const a = path.pts[k - 1];
    const b = path.pts[k];
    const f = b.at > a.at ? (path.s - a.at) / (b.at - a.at) : 1;
    car.x = a.x + (b.x - a.x) * f;
    car.z = a.z + (b.z - a.z) * f;
    m.heading = path.s >= path.len ? path.yaw : yawOf(b.x - a.x, b.z - a.z);
    m.slip = (m.slip ?? 0) * Math.exp(-dt * 6);
    car.yaw = wrap(m.heading + m.slip);
    car.v = m.v;
    car.travelled += m.v * dt;
    return path.s >= path.len;
  }

  /**
   * Drive along a straight line — through (ox, oz), direction (tx, tz) — to `s` along it, braking
   * to a stop there if `stop`; true once it is there. Steered onto the line rather than at a point
   * on it: chasing a point it cannot turn tight enough to reach is how a car ends up orbiting it
   * (see `drive`), and a car handed back to traffic has to be on its lane and pointing down it
   * already, or `releaseCar` snaps it there in one frame.
   */
  function onLine(m, dt, ox, oz, tx, tz, s, stop) {
    const car = m.car;
    const dx = car.x - ox;
    const dz = car.z - oz;
    const along = dx * tx + dz * tz;
    const across = dx * -tz + dz * tx;
    const pull = Math.max(-1.2, Math.min(1.2, 0.9 * across));
    const left = s - along;
    const want = stop ? Math.min(RING_V, Math.sqrt(2 * 6 * Math.max(0, left - 0.1))) : RING_V + 2;
    drive(m, yawOf(tx + pull * tz, tz - pull * tx), want, dt, { drift: false });
    // Arrived, however square: a car that overshoots its mark by a hair would otherwise sit there
    // wanting to reverse onto it. What is left of the offset is taken up as it settles.
    return left <= (stop ? 0.2 : 0) && Math.abs(across) < (stop ? 1.2 : 0.6);
  }

  /** Up the far side of its own road to the edge of the box — the way in past a queue. */
  function upFarSide(m, dt) {
    const side = lateralOf(m.arm);
    const ox = centre.x + side.x * side.off;
    const oz = centre.z + side.z * side.off;
    // Measured *toward* the junction, so `s` counts down the arm from its far end. Level with the
    // front of the queue beside it: any nearer and the cars sliding round the ring clip its nose.
    const edge = armHalf(m.arm) + STOP_SETBACK + 0.6;
    return onLine(m, dt, ox + m.arm.u.x * 100, oz + m.arm.u.z * 100, -m.arm.u.x, -m.arm.u.z, 100 - edge, true);
  }

  /**
   * Is there room on the ring at `theta` for one more? Checked before a car pulls onto it from the
   * edge of the box, which is the only place a car can wait without being in someone's way: a car
   * that slowed to let the ring go by once it was *on* the line was sitting in the path of the next
   * one round (measured: the one overlap left between two of the scene's own cars).
   */
  function roomAt(m, theta) {
    const r = (ring.rx + ring.rz) / 2;
    return !crew.some((o) => {
      if (o === m || !o.car.staged) return false;
      const at = o.rail ? o.rail.theta : angleOf(o.car.x, o.car.z);
      const ahead = ring.sense * wrap(at - theta) * r;
      // Behind it by less than a gap and a second's travel, or ahead by less than a gap.
      return ahead > -(RING_GAP + RING_V) && ahead < RING_GAP;
    });
  }

  /** The angle a ring slot is at right now. */
  const slotAngle = (k) => ring.phase + (TAU * k) / Math.max(1, crew.length);

  /**
   * One frame of a hand-driven car: steer for heading `desired`, try for `want` u/s, and keep off
   * the car in front. Turn rate is capped at a real car's (TURN_R), so it arcs rather than pivots —
   * which is also how a car chasing a point it cannot turn tight enough to reach ends up orbiting
   * it for good (measured: a cop circling its own waypoint for 25 seconds). So a car that is
   * pointing well off where it wants to go slows right down first, and turns tight at a crawl, the
   * way a driver does.
   */
  function drive(m, desired, want, dt, { drift = true } = {}) {
    const car = m.car;
    car.skid = false;
    // Nobody drives into the back of another of the scene's cars. Traffic cannot do this for them —
    // they are staged — so it is done here, off the same following idea: slow to the car ahead.
    const fx = Math.cos(m.heading);
    const fz = -Math.sin(m.heading);
    const radius = Math.hypot(car.x - centre.x, car.z - centre.z);
    for (const o of crew) {
      if (o === m || !o.car.staged || o.mode === 'inbound') continue;
      // Only a car on the same line round. The one parked at the kerb is tangentially "ahead" of
      // every car passing its arm, and read as a leader it stopped the whole ring dead.
      if (Math.abs(Math.hypot(o.car.x - centre.x, o.car.z - centre.z) - radius) > 2.2) continue;
      const dx = o.car.x - car.x;
      const dz = o.car.z - car.z;
      const ahead = dx * fx + dz * fz;
      const across = Math.abs(dx * fz - dz * fx);
      if (ahead <= 0 || ahead > CAR_LEN + 2.5 || across > 2.2) continue;
      want = Math.min(want, Math.max(0, o.v * 0.9 + (ahead - CAR_LEN - 0.6) * 2));
    }
    const off = Math.abs(wrap(desired - m.heading));
    if (off > 0.7) want = Math.min(want, 1.5 + 4 * Math.max(0, 1.6 - off));
    m.v += Math.max(-DECEL * dt, Math.min(ACCEL * dt, want - m.v));
    const rate = Math.max(m.v, 3) / TURN_R;
    const turn = Math.max(-rate * dt, Math.min(rate * dt, wrap(desired - m.heading)));
    m.heading = wrap(m.heading + turn);
    car.x += Math.cos(m.heading) * m.v * dt;
    car.z -= Math.sin(m.heading) * m.v * dt;
    // The slide: nose in by DRIFT at the ring's own yaw rate, eased so it swings rather than snaps.
    const yawRate = dt > 0 ? turn / dt : 0;
    const slip = drift ? DRIFT * Math.max(-1, Math.min(1, yawRate / (RING_V / ring.rx))) : 0;
    m.slip = (m.slip ?? 0) + (slip - (m.slip ?? 0)) * Math.min(1, dt * 5);
    car.yaw = wrap(m.heading + m.slip);
    car.v = m.v;
    car.travelled += m.v * dt;
  }

  /**
   * Round and round.
   *
   * **On rails once it is there.** Steering a car round a ring from its own heading — first at a
   * point ahead on the ring, then along the tangent with a pull back onto the line — cut inside
   * or ran wide by most of a unit, and a unit wide is the queue at the stop line or the robber
   * (measured: a car 0.16 from the figure). So a car only steers until it is on the line and
   * pointing round it (`merge`), and from then on its position *is* the ring at its angle, with
   * whatever it was off by when it joined bled away over a second.
   */
  function circle(m, dt) {
    const car = m.car;
    const shrink = WOBBLE * (0.5 + 0.5 * Math.sin(state.time * m.wobble.rate + m.wobble.phase));
    if (!m.rail) {
      if (!merge(m, dt, shrink)) return;
    }
    const rail = m.rail;
    // Off the rails where it has been told to leave them (`peelAt`), and onto its lane.
    if (m.peel) {
      const past = ring.sense * wrap(rail.theta - m.peel.theta);
      if (past >= 0 && past < 1) {
        m.mode = m.peel.mode;
        m.peel = null;
        m.rail = null;
        m.path = pathOut(m, m.exit.lane, m.exit.s);
        return;
      }
    }
    // Catch up with or drop back to its own slot, so the ring spreads out evenly.
    const behind = ring.sense * wrap(slotAngle(m.slot) - rail.theta);
    let want = Math.max(RING_V * 0.5, Math.min(RING_V * 1.5, RING_V * (1 + 0.8 * behind)));
    // A car about to leave does not race to catch its slot first: the turn out is sized for the
    // ring's own speed (PEEL_ACROSS), and one taken at the catch-up's 13 u/s ran wide onto the
    // kerb beside the robber.
    if (m.peel) want = Math.min(want, RING_V);
    // ...and never into the back of the car in front, which on rails is only ever an angle.
    // Anything of the scene's on the line counts, not only the cars on rails: one peeling off for
    // the kerb is still on the ring for its first couple of units, and was run into from behind.
    for (const o of crew) {
      // Not one waiting at the edge of the box to join (`roomAt`): it is outside the line by
      // design, and a ring that stopped for it could never give it the gap it is waiting for.
      if (o === m || !o.car.staged || o.mode === 'in') continue;
      const theta = o.rail ? o.rail.theta : angleOf(o.car.x, o.car.z);
      if (!o.rail && Math.abs(Math.hypot(o.car.x - centre.x, o.car.z - centre.z) - rail.radius) > 2.2) continue;
      const gap = ring.sense * wrap(theta - rail.theta) * rail.radius;
      if (gap > 0 && gap < RING_GAP + 2) want = Math.min(want, Math.max(0, o.v + (gap - RING_GAP) * 3));
    }
    m.v += Math.max(-DECEL * dt, Math.min(ACCEL * dt, want - m.v));
    rail.theta = wrap(rail.theta + ring.sense * m.v * dt / Math.max(1, rail.radius));
    rail.off *= Math.exp(-dt * 3);
    const on = ringPoint(rail.theta, shrink);
    const r = Math.hypot(on.x - centre.x, on.z - centre.z);
    const nx = (on.x - centre.x) / (r || 1);
    const nz = (on.z - centre.z) / (r || 1);
    rail.radius = r;
    const x = on.x + nx * rail.off;
    const z = on.z + nz * rail.off;
    const moved = Math.hypot(x - car.x, z - car.z);
    if (moved > 1e-4) m.heading = yawOf(x - car.x, z - car.z);
    car.x = x;
    car.z = z;
    m.slip = (m.slip ?? 0) + (ring.sense * DRIFT - (m.slip ?? 0)) * Math.min(1, dt * 3);
    car.yaw = wrap(m.heading + m.slip);
    // Sliding round lays rubber and squeals, the chase's own tyre marks (`copLaysRubber`).
    car.skid = true;
    car.v = m.v;
    car.travelled += m.v * dt;
  }

  /**
   * Steer onto the ring: along its tangent, pulled toward the line by how far off it the car is.
   * True — and the car is on rails from here — once it is within half a unit of the line and
   * pointing round it.
   */
  function merge(m, dt, shrink) {
    const car = m.car;
    const theta = angleOf(car.x, car.z);
    const on = ringPoint(theta, shrink);
    const want = Math.hypot(on.x - centre.x, on.z - centre.z);
    const at = Math.hypot(car.x - centre.x, car.z - centre.z) || 1;
    const nx = (car.x - centre.x) / at;
    const nz = (car.z - centre.z) / at;
    const tx = -ring.sense * nz;
    const tz = ring.sense * nx;
    const tangent = yawOf(tx, tz);
    if (Math.abs(at - want) < 0.5 && Math.abs(wrap(m.heading - tangent)) < 0.45) {
      m.rail = { theta, off: at - want, radius: want };
      return true;
    }
    const pull = Math.max(-1.5, Math.min(1.5, 2 * (at - want)));
    drive(m, yawOf(tx - pull * nx, tz - pull * nz), RING_V, dt);
    return false;
  }

  /** Put a staged cop back in traffic on `lane` at `s`, bar off, and send it off the map. */
  function handBack(m, lane, s) {
    const car = m.car;
    const to = cityNetwork().nodeById.get(lane.to);
    const d = cityNetwork().dirOfLane(lane);
    const v = m.v;
    if (!releaseCar(car, d, to.gi, to.gj, lane.length - s)) return false;
    car.v = v;
    standDown(car);
    m.mode = 'gone';
    return true;
  }

  /** Lights off, and routed to the corner of the map furthest from the taxi. */
  function standDown(car) {
    car.arrest = false;
    car.skid = false;
    car.holdAt = null;
    car.siren = false;
    car.chase = 0;
    car.uturnWanted = false;
    const out = { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    car.route = findRoute(planOrigin(car), out) ?? [];
    car.routeConsumed = false;
  }

  /** Off the map outright — only ever where the player cannot see it happen. */
  function retire(m) {
    m.car.skid = false;
    m.car.staged = false;
    m.car.arrest = false;
    m.car.holdAt = null;
    traffic.retirePolice(m.car);
    m.mode = 'gone';
  }

  /**
   * Nobody can see this point, so a car here may simply be taken off. Asked of the camera when there
   * is one, and not of the taxi: the camera follows the taxi until the player pans it, and a player
   * who pans over to watch the arrest is exactly who would see the cars blink out — the first build
   * did that, on the frame the robber was taken in.
   */
  const outOfShot = (p) => (inShot
    ? !inShot(p.x, p.z)
    : Math.hypot(p.x - taxi.x, p.z - taxi.z) >= SPAWN_CLEARANCE);

  function setPhase(phase) {
    state.phase = phase;
    state.phaseTime = 0;
  }

  /** The car best placed to peel off for the kerb: the next one round to the parking arm. */
  function closer() {
    const theta = peelAt(park.arm);
    let best = null;
    let bestAhead = Infinity;
    for (const m of crew) {
      if (m.mode !== 'ring' || !m.rail || m.peel) continue;
      let ahead = ring.sense * wrap(theta - m.rail.theta);
      if (ahead < 0.3) ahead += TAU;
      if (ahead < bestAhead) { best = m; bestAhead = ahead; }
    }
    return best;
  }

  /**
   * Is `lane` clear around `s` — nothing on it near there, and none of the scene's own cars on its
   * way to it? Asked in the world as well as on the lane, because a staged car's lane position is
   * stale (see `tryStage`) and a car parked on the kerb is only a position.
   */
  function laneClear(lane, s, self) {
    const p = lane.path.at(s);
    // The cars going round are not in the way of a spot off the ring, however near it they pass.
    const circling = (c) => crew.some((o) => o.car === c && o.mode === 'ring');
    return !traffic.cars.some((c) => !c.crashed && c !== self?.car && !circling(c)
      && ((c.lane === lane && c.state === 'drive' && !c.staged && Math.abs(c.s - s) < CAR_LEN * 2)
        // Under a lane's width: the queue at the stop line beside it is the next lane over.
        || Math.hypot(c.x - p.x, c.z - p.z) < 3))
      && !crew.some((o) => o !== self && o.mode !== 'gone' && o.exit?.lane === lane);
  }

  /** The way out for a ring car: the next arm round with a lane out and room on it. */
  function exitFor(m) {
    const theta = m.rail.theta;
    let best = null;
    let bestAhead = Infinity;
    for (const arm of arms) {
      if (!arm.leave) continue;
      const lane = arm.leave;
      const s = Math.min(RELEASE_S, lane.length - STOP_SETBACK - 2);
      if (s <= 0) continue;
      // Room where it will land, and nobody coming up it the other way to join (`upFarSide`).
      const busy = !laneClear(lane, s, m) || crew.some((o) => o.mode === 'in' && o.arm === arm);
      if (busy) continue;
      let ahead = ring.sense * wrap(peelAt(arm) - theta);
      if (ahead < 0.3) ahead += TAU;
      if (ahead < bestAhead) { best = { arm, lane, s }; bestAhead = ahead; }
    }
    return best;
  }

  function end() {
    if (J) traffic.sealJunction(J.i, J.j, false);
    J = null;
    crew = [];
    figure = null;
    state.phase = 'off';
  }

  function update(dt) {
    if (state.phase === 'off') return;
    state.time += dt;
    state.phaseTime += dt;
    ring.phase += ring.sense * ring.omega * dt;
    // Anything wrecked, or taken off the road from under the scene, is simply out of it.
    crew = crew.filter((m) => m.mode === 'gone' || (traffic.policeCars.includes(m.car) && !m.car.crashed));

    for (const m of crew) {
      if (m.mode === 'inbound') {
        if (state.phase === 'converge' || state.phase === 'circle') {
          routeIn(m);
          tryStage(m);
        }
      }
      if (m.mode === 'in') {
        // Up the far side to the edge of the box, and wait there for a gap in the ring.
        m.stuck = m.v < 0.3 ? m.stuck + dt : 0;
        const there = upFarSide(m, dt) || m.stuck > STUCK;
        if (there && !taxiNear() && roomAt(m, angleOf(m.car.x, m.car.z))) {
          m.mode = 'ring';
          if (state.ringTime < 0) state.ringTime = 0;
        }
      } else if (m.mode === 'ring') {
        circle(m, dt);
      } else if (m.mode === 'close') {
        if (alongPath(m, dt, true)) {
          m.mode = 'parked';
          m.v = 0;
          m.car.v = 0;
        }
      } else if (m.mode === 'out') {
        if (alongPath(m, dt, false)) handBack(m, m.exit.lane, m.exit.s);
      }
    }
    if (state.ringTime >= 0) state.ringTime += dt;

    const onRing = crew.filter((m) => m.mode === 'ring');
    const coming = crew.filter((m) => m.mode === 'inbound' || m.mode === 'in');

    // The figure: hands up once it is on the kerb, facing the middle of the junction.
    if (figure?.settled() && (state.phase === 'converge' || state.phase === 'circle' || state.phase === 'close')) {
      const s = figure.standing;
      s?.surrender?.(state.time, centre.x - figure.x, centre.z - figure.z);
    }

    if (state.phase === 'converge') {
      if (onRing.length) setPhase('circle');
      else if (state.time > ARREST_WAIT || !crew.length) { giveUp(); return; }
    }

    if (state.phase === 'circle') {
      const late = coming.length > 0 && state.ringTime < CIRCLE_TIME + LATE_WAIT;
      if (state.ringTime >= CIRCLE_TIME && !late && (!figure || figure.settled())) {
        // Anyone still on their way in is not needed now.
        for (const m of coming) {
          if (m.mode === 'inbound') { standDown(m.car); m.mode = 'gone'; }
        }
        // The kerb has to be free to pull up at. It can be taken — by the taxi itself, parked on
        // that lane, and whatever has queued behind it — and it is waited for a little rather than
        // parked into. Traffic cannot see a staged car, so nothing would move out of its way.
        const free = park && laneClear(park.lane, park.s, null);
        const m = free && closer();
        if (m) {
          m.peel = { theta: peelAt(park.arm), mode: 'close' };
          m.exit = { arm: park.arm, lane: park.lane, s: park.s };
          setPhase('close');
        } else if (park && state.ringTime < CIRCLE_TIME + LATE_WAIT + KERB_WAIT) {
          // Keep circling.
        } else {
          // Nowhere to pull up: taken in where they stand.
          figure?.release({ fade: true });
          figure = null;
          state.arrests += 1;
          setPhase('leave');
        }
      }
    }

    if (state.phase === 'close') {
      const m = crew.find((c) => c.mode === 'parked');
      if (m) setPhase('board');
      else if (!crew.some((c) => c.mode === 'close' || c.peel?.mode === 'close')) setPhase('circle');
    }

    if (state.phase === 'board') {
      const m = crew.find((c) => c.mode === 'parked');
      const t = Math.min(1, state.phaseTime / BOARD_TIME);
      if (figure && m) figure.standing?.board?.(t, m.car.x - figure.x, m.car.z - figure.z);
      if (t >= 1 || !m) {
        figure?.release();
        figure = null;
        state.arrests += 1;
        // Off it goes with them — it is already on the lane out, facing down it.
        if (m) handBack(m, park.lane, park.s);
        setPhase('leave');
      }
    }

    if (state.phase === 'leave') {
      sinceLeave += dt;
      // A car nobody can see skips the drive out.
      for (const m of crew) {
        if (m.mode !== 'gone' && m.car.staged && m.mode !== 'out' && outOfShot(m.car)) retire(m);
      }
      if (sinceLeave >= LEAVE_GAP) {
        const m = crew.find((c) => c.mode === 'ring' && c.rail && !c.peel);
        const exit = m && exitFor(m);
        if (exit) {
          m.exit = exit;
          m.peel = { theta: peelAt(exit.arm), mode: 'out' };
          sinceLeave = 0;
        }
      }
      if (!crew.some((m) => m.mode !== 'gone' && m.car.staged)) { end(); return; }
    }

    if (state.time > SCENE_MAX) {
      // Something has wedged. Whatever is out of shot goes now; anything still in it keeps trying
      // to leave, because a car the player can see does not blink out.
      if (figure) { figure.release({ fade: true }); figure = null; }
      if (state.phase !== 'leave') setPhase('leave');
      for (const m of crew) {
        if (m.mode === 'inbound') { standDown(m.car); m.mode = 'gone'; }
        else if (m.mode !== 'gone' && outOfShot(m.car)) retire(m);
      }
    }
  }

  /**
   * No cop ever made the ring. The robber walks off and the ones still coming stand down; one
   * already out of traffic on its way in is seen out by the leave phase like any other, which only
   * retires what nobody can see.
   */
  function giveUp() {
    figure?.release({ fade: true });
    figure = null;
    for (const m of crew) {
      if (m.mode === 'inbound') { standDown(m.car); m.mode = 'gone'; }
    }
    if (crew.some((m) => m.mode !== 'gone' && m.car.staged)) setPhase('leave');
    else end();
  }

  /** The run is over: everything off at once. See `abandon` in game/robbery.js. */
  function abandon() {
    if (state.phase === 'off') return;
    for (const m of crew) {
      if (m.mode === 'gone') continue;
      m.car.arrest = false;
      m.car.holdAt = null;
      if (m.car.staged) retire(m);
    }
    figure?.release();
    end();
  }

  return {
    state,
    begin,
    update,
    abandon,
    /** Is a scene on? */
    active: () => state.phase !== 'off',
    /** The cars in it and what each is doing, for the tools. */
    crew: () => crew.map((m) => ({ car: m.car, mode: m.mode, rail: Boolean(m.rail) })),
    /** The junction it is at, or null. */
    junction: () => (J ? { ...J } : null),
  };
}
