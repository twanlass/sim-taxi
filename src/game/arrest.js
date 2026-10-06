import {
  GRID_I, GRID_J, halfRoadX, halfRoadZ, isXAxis, dirSign, lineX, lineZ, opposite,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { findRoute, planOrigin } from './route.js';
import { CAR_LEN, CAR_W, SPAWN_CLEARANCE, STOP_SETBACK, releaseCar, stageCar } from '../sim/traffic.js';

// The end of a bank robbery that got where it was going: the robber climbs out onto the corner, puts
// their hands up, and the police come screaming in and **screech to a halt in a fan around them**,
// every bonnet pointed at the robber, bars going. After a beat of standoff the robber walks to the
// nearest car and gets in the back, and the cars pull out and drive off.
//
// This replaced a ring: the cops used to circle the junction box for a few seconds before one
// pulled up at the kerb. It read as cars going round in circles rather than as an arrest — a
// standoff is what the scene is, and a car that has stopped pointed at someone says so.
//
// **The fan is in the junction box, round the robber's side of it.** A drop-off corner is a kerb
// corner (`cornerFor` in game/fares.js), so of the directions out from the robber only the quarter
// facing the box and a little either side of it is road; the other three quarters are the block
// behind them. Three slots at FAN_R from the robber, FAN_SPREAD apart and centred on the diagonal
// to the junction's middle, all fall inside the box (each clamped to it, see `fanSlots`), which is
// the one place the seal keeps clear: the queue at every stop line has its nose 1.7 past the box
// edge, and the outer slots' bodies stay inside it.
//
// **These cars are driven by hand.** Nothing in the traffic model can park a car across a junction
// pointed at the pavement, so a cop that arrives is taken out of traffic with `stageCar` — the split
// the opening vignette uses for the taxi in its garage: out of every simulation loop, still posed by
// the render pass, so it keeps its suspension and its lights — driven in on a curve, and handed back
// with `releaseCar` on a lane leaving the junction. That makes two things this module's job that
// traffic would otherwise do:
//
//   - **Nothing else may be in the box.** Traffic cannot see a staged car, so an ambient car let
//     into the junction would drive straight through the cops. The junction is sealed
//     (`sealJunction` in sim/traffic.js) for as long as the scene has a car in it, and a cop is only
//     taken into the box once it is empty.
//   - **The hand-back has to land clear of the stop line.** `releaseCar` will put a car anywhere on
//     a lane, and one released inside its own hold line runs the next light (see CLAUDE.md). Every
//     release here is a few units down a lane *leaving* the sealed junction, so the far end's line
//     is a whole lane-length away, and nothing is coming up behind it because nothing can leave a
//     sealed box.
//
// And one thing it has to do for itself: **every curve is checked before it is driven** (`pathOk`).
// Staged cars are invisible to traffic and to each other, so a path is sampled for the car's four
// corners staying on the road and its centre staying clear of every other car, and a car with no
// clear path simply waits where it is — at its stop line on the way in, in its slot on the way out.
//
// The scene is a sequence, one phase at a time:
//
//   converge  cops routed to the junction as ordinary chasing traffic and held at its line; each is
//             staged once the box is empty and it has a clear run at a free slot (`tryStage`)
//   standoff  the first car has screeched up; the rest join it, all pointed at the robber
//             (STANDOFF_TIME, and LATE_WAIT for one still coming)
//   board     the robber walks to the nearest car and is gone (BOARD_TIME)
//   leave     one at a time the cars pull out down whichever arm they can reach, are handed back to
//             traffic with their bars off, and drive off the map the way a robbery's stood-down cops
//             always have

/** Car centre to robber, in units. Nose 3.8 off them: close enough to mean it, clear of the kerb. */
const FAN_R = 5.5;
/**
 * Between neighbouring slots, rad. 40°: at FAN_R the noses are 2.6 apart centre to centre against a
 * car's 1.7 width, which reads as a line of cars rather than a crowd, and the outer two still land
 * inside a street's box.
 */
const FAN_SPREAD = 0.7;
/** Keep a slot's centre this far inside the box edge, so a body across the arm misses the queue. */
const SLOT_INSET = 0.5;

/** The run in: top speed, and the braking into the slot, u/s and u/s². Harder than traffic brakes. */
const SCREECH_V = 11;
const SCREECH_DECEL = 14;
/**
 * The handbrake: over the last this-much of its run in, a car's body swings from the way it is
 * travelling round to the way its slot points, however far that is. Its path and its body are two
 * different things for that stretch, which is what lets a car coming in on the robber's own side
 * of the junction end up facing back at them without a lap of the box to turn round in.
 */
const SLIDE_FROM = 0.4;
/** The pull out. */
const OUT_V = 9;
const OUT_DECEL = 6;
const ACCEL = 12;
const DECEL = 18;
/** The tightest a hand-driven cop turns when steering rather than on a curve, in units of radius. */
const TURN_R = 3.2;
/** The most a pull-out may turn through, rad. Past this it backs up first (`backUp`). */
const OUT_TURN_MAX = 1.85;
/** How far a car with no way out backs up before it looks again. */
const BACK_UP = 2.5;
/**
 * Centre to centre, the least room a path keeps from any other car. Two bodies side by side are
 * 1.7 apart; this is that and most of a car's width to spare, for the corners of two cars at angles.
 */
const CLEAR = 2.6;

/**
 * How close, along its arm, a converging cop has to be to be taken out of traffic. Past the queue a
 * sealed junction builds up on its approach (three or four cars), because a cop behind one goes in
 * up the far side of the road — see `tryStage` and `upFarSide`.
 */
const ENTER_R = 26;

/**
 * No cop goes into the box while the taxi is this near its middle. Collision only ever tests the
 * taxi, and off the pill a staged car is not even shoved (sim/collisions.js), so a cop driving into
 * a taxi that has not yet pulled away from the drop-off would be drawn straight through it.
 */
const TAXI_CLEAR = 11;

/** Seconds of standoff before the robber gives up and walks over — from the first car parked. */
const STANDOFF_TIME = 3;
/** ...but a cop still coming is waited for this much longer, so the fan fills before it breaks. */
const LATE_WAIT = 3;
/** The robber's walk from the kerb into the car. Four units or so, so a bit over the old kerb hop. */
const BOARD_TIME = 1.3;
/** Seconds between cops pulling out on the way off. */
const LEAVE_GAP = 0.7;
/** Nobody has made it into the box by now: the robber gives up waiting. */
const ARREST_WAIT = 14;
/** The backstop over the whole scene, well inside the figure's own (`EXIT_HOLD_MAX`, game/fares.js). */
const SCENE_MAX = 40;

/** Seconds the car queued behind a cop is held while that cop pulls out of the line — see `tryStage`. */
const PULL_OUT = 1.6;
/** A hand-driven car that has sat still this long, short of where it was going, is called there. */
const STUCK = 1.5;
/** How far down a lane leaving the junction a cop is handed back to traffic. */
const RELEASE_S = 4;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const yawOf = (x, z) => Math.atan2(-z, x);
const unit = (d) => ({ x: isXAxis(d) ? dirSign(d) : 0, z: isXAxis(d) ? 0 : dirSign(d) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param traffic  the sim — `sealJunction`, `retirePolice`, `cars`
 * @param taxi     the player's car
 * @param inShot   `(x, z) => boolean`: could the player be looking at this point? main.js asks the
 *                 camera; without one it is "within SPAWN_CLEARANCE of the taxi", which is what the
 *                 camera shows when nobody has panned it — see `outOfShot`.
 */
export function createArrest({ traffic, taxi, inShot = null }) {
  const state = {
    /** 'off' | 'converge' | 'standoff' | 'board' | 'leave' — see the header. */
    phase: 'off',
    /** Seconds in this scene, and in this phase. */
    time: 0,
    phaseTime: 0,
    /** Seconds since the first car pulled up in the fan, or -1. */
    fanTime: -1,
    /** Tallies, for the tools. */
    scenes: 0,
    arrests: 0,
  };

  let J = null;
  let centre = null;
  let box = null;
  let figure = null;
  /** Per cop: { car, mode, v, heading, slip, arm, slot, path, exit, stuck } */
  let crew = [];
  let arms = [];
  let slots = [];
  let boarder = null;
  let sinceLeave = 0;
  let leaveStuck = 0;

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

  const armHalf = (arm) => (isXAxis(arm.e) ? box.hx : box.hz);

  /**
   * The fan: middle slot first, on the line from the robber to the junction's middle, then one either
   * side. Each points its bonnet at the robber, and is pulled back inside the box if it fell outside
   * it — on a divided arterial's wider box none do; on a street's the outer two sit just inside.
   */
  function fanSlots() {
    const base = Math.atan2(centre.z - figure.z, centre.x - figure.x);
    const out = [];
    for (const k of [0, -1, 1]) {
      const a = base + k * FAN_SPREAD;
      const x = clamp(figure.x + Math.cos(a) * FAN_R, centre.x - box.hx + SLOT_INSET, centre.x + box.hx - SLOT_INSET);
      const z = clamp(figure.z + Math.sin(a) * FAN_R, centre.z - box.hz + SLOT_INSET, centre.z + box.hz - SLOT_INSET);
      out.push({ x, z, yaw: yawOf(figure.x - x, figure.z - z), by: null });
    }
    return out;
  }

  /**
   * Is this point on the road? Near a junction that is everything but the four blocks on its
   * diagonals, less any arm the map has no road down (a junction on its edge).
   */
  function onRoad(px, pz) {
    const dx = px - centre.x;
    const dz = pz - centre.z;
    if (Math.abs(dx) > box.hx && Math.abs(dz) > box.hz) return false;
    for (const arm of arms) {
      if (arm.exists) continue;
      if (dx * arm.u.x + dz * arm.u.z > armHalf(arm) - 0.2) return false;
    }
    return true;
  }

  /**
   * Can `self` stand at this pose? All four corners on the road, and its centre CLEAR of every other
   * car — traffic, the scene's own as they stand now, and the slots of any of the scene's own still
   * on their way to one.
   */
  function poseOk(x, z, yaw, self) {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    for (const a of [1, -1]) {
      for (const b of [1, -1]) {
        const px = x + fx * a * (CAR_LEN / 2) - fz * b * (CAR_W / 2);
        const pz = z + fz * a * (CAR_LEN / 2) + fx * b * (CAR_W / 2);
        if (!onRoad(px, pz)) return false;
      }
    }
    for (const c of traffic.cars) {
      if (c === self.car || c.crashed || c.isTaxi) continue;
      if (Math.hypot(c.x - x, c.z - z) < CLEAR) return false;
    }
    if (Math.hypot(taxi.x - x, taxi.z - z) < CLEAR + 1) return false;
    for (const o of crew) {
      if (o === self || o.mode !== 'arrive' || !o.slot) continue;
      if (Math.hypot(o.slot.x - x, o.slot.z - z) < CLEAR) return false;
    }
    return true;
  }

  /**
   * A cubic from a pose to a pose, sampled by length so a car can be driven along it at a speed. Its
   * control points run along the start heading and back along the end one, so it lies inside their
   * hull — which is what keeps a pull-out from swinging onto the kerb past its lane.
   */
  function curve(x0, z0, yaw0, x1, z1, yaw1) {
    const reach = 0.45 * Math.hypot(x1 - x0, z1 - z0);
    const p1 = { x: x0 + Math.cos(yaw0) * reach, z: z0 - Math.sin(yaw0) * reach };
    const p2 = { x: x1 - Math.cos(yaw1) * reach, z: z1 + Math.sin(yaw1) * reach };
    const pts = [];
    let len = 0;
    for (let k = 0; k <= 24; k++) {
      const u = k / 24;
      const a = (1 - u) ** 3;
      const b = 3 * (1 - u) ** 2 * u;
      const c = 3 * (1 - u) * u * u;
      const d = u ** 3;
      const p = {
        x: a * x0 + b * p1.x + c * p2.x + d * x1,
        z: a * z0 + b * p1.z + c * p2.z + d * z1,
      };
      if (pts.length) {
        const q = pts[pts.length - 1];
        len += Math.hypot(p.x - q.x, p.z - q.z);
        p.yaw = yawOf(p.x - q.x, p.z - q.z);
      } else {
        p.yaw = yaw0;
      }
      pts.push({ ...p, at: len, body: p.yaw });
    }
    return { pts, len, s: 0, yaw: yaw1 };
  }

  /**
   * A run in that ends sliding round to face `yaw` (SLIDE_FROM). Travel ends along the chord, so a
   * car that has to swing right round does it in the body, not in a loop of road it does not have.
   */
  function slideIn(x0, z0, yaw0, slot) {
    const path = curve(x0, z0, yaw0, slot.x, slot.z, yawOf(slot.x - x0, slot.z - z0));
    for (const p of path.pts) {
      const u = path.len > 0 ? p.at / path.len : 1;
      const w = clamp((u - SLIDE_FROM) / (1 - SLIDE_FROM), 0, 1);
      p.body = wrap(p.yaw + wrap(slot.yaw - p.yaw) * w * w * (3 - 2 * w));
    }
    path.slide = true;
    path.yaw = slot.yaw;
    return path;
  }

  /** Straight back along its own heading, still pointed the way it was. */
  function reverseLine(m, dist) {
    const car = m.car;
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const at = (dist * k) / 4;
      pts.push({ x: car.x - Math.cos(m.heading) * at, z: car.z + Math.sin(m.heading) * at, yaw: m.heading, body: m.heading, at });
    }
    return { pts, len: dist, s: 0, yaw: m.heading, reverse: true };
  }

  /** Every pose along a path is one `self` can stand at. The first few are where it already is. */
  function pathOk(path, self) {
    return path.pts.every((p, k) => k < 2 || poseOk(p.x, p.z, p.body, self));
  }

  /**
   * Is anything but this scene's own staged cars inside the box, or about to be? "About to be"
   * includes a car still short of it on its run-up: `state` flips to `'turn'` at the hold line,
   * STOP_SETBACK before the box (see CLAUDE.md), and a car that has flipped is committed — a seal
   * going on then does not stop it.
   */
  function boxBusy() {
    const reachX = box.hx + CAR_LEN / 2;
    const reachZ = box.hz + CAR_LEN / 2;
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
    box = { hx: halfRoadZ(J.i), hz: halfRoadX(J.j) };
    figure = held;
    arms = armsAt(J);
    // No figure, no one to point at and no fan: nobody is staged, and the scene gives up.
    slots = figure ? fanSlots() : [];
    boarder = null;
    state.phase = 'converge';
    state.time = 0;
    state.phaseTime = 0;
    state.fanTime = -1;
    state.scenes += 1;
    sinceLeave = 0;
    leaveStuck = 0;
    crew = cops.map((car) => {
      car.arrest = true;
      // Held at the line rather than let through: a route that ends at a junction rolls the
      // ordinary dice there, and a cop driving on through the scene it was sent to has to come
      // all the way round the block again.
      car.holdAt = `${J.i},${J.j}`;
      car.siren = true;
      car.chase = 1;
      car.uturnWanted = false;
      return { car, mode: 'inbound', v: 0, heading: car.yaw, slip: 0, routedAt: null };
    });
    for (const m of crew) routeIn(m);
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
   * The free slot furthest from this car that it has a clear run at, and the run — or null. Called
   * with the car's own pose, which for a car still in traffic is its pose on the lane.
   *
   * **Furthest, not nearest.** The cops mostly arrive down the same arm, the one the chase came in
   * on, and the slot nearest the mouth of that arm is parked right across it: taken first, it walled
   * off the box from every car behind (measured, the first build: one car in the fan on 4 runs of
   * 4, the other two sat at the line for the whole standoff). Filled from the far side, each car
   * leaves the next one the road it needs.
   */
  function slotRun(m, x, z, yaw) {
    let best = null;
    let bestD = -Infinity;
    for (const slot of slots) {
      if (slot.by) continue;
      const d = Math.hypot(slot.x - x, slot.z - z);
      if (d <= bestD) continue;
      if (!poseOk(slot.x, slot.z, slot.yaw, m)) continue;
      const path = slideIn(x, z, yaw, slot);
      if (!pathOk(path, m)) continue;
      best = { slot, path };
      bestD = d;
    }
    return best;
  }

  /** Onto its run at a slot, and claim it. */
  function arrive(m, run) {
    m.mode = 'arrive';
    m.slot = run.slot;
    run.slot.by = m;
    m.path = run.path;
  }

  /**
   * Take a converging cop out of traffic, if it can get to a slot from where it is.
   *
   * Two ways in, and one car at a time on each arm, because two taken out together on the same
   * approach both wanted the same piece of road and piled into each other (measured, three deep,
   * on the ring this replaced).
   *
   *   - **From the front of the queue**, straight in: it is at the stop line with nothing between it
   *     and the box, so it goes the moment it has a clear run at a free slot (`slotRun`). Until
   *     then it simply waits at the line — in traffic, so whatever comes up behind it queues behind
   *     it the ordinary way.
   *   - **From behind a queue**, once the box is sealed: up the far side of its own road, which a
   *     sealed junction has emptied (nothing can leave it), to the edge of the box — see `onLine`.
   */
  function tryStage(m) {
    const car = m.car;
    if (car.state !== 'drive' || car.pass > 0 || car.uturn) return;
    if (car.i !== J.i || car.j !== J.j) return;
    if (!slots.some((s) => !s.by)) return;
    const arm = arms.find((a) => a.e === opposite(car.d));
    if (!arm) return;
    const along = (car.x - centre.x) * arm.u.x + (car.z - centre.z) * arm.u.z;
    if (along > ENTER_R) return;
    if (taxiNear() || boxBusy()) return;
    // One car on the move at a time. The runs are checked against where the others are going, but
    // two cars sweeping across the same box together is a thing to watch for rather than to allow.
    if (crew.some((o) => o.mode === 'arrive')) return;
    // The nearest car in front of it in its lane, if any — measured in the world rather than on
    // the lane, because the one in front may be a cop taken out of traffic this same frame, and a
    // staged car's lane position is whatever it was when it left.
    const laneAt = (c) => (c.x - centre.x) * -arm.u.z + (c.z - centre.z) * arm.u.x;
    let lead = Infinity;
    for (const c of traffic.cars) {
      if (c === car || c.crashed) continue;
      const a = (c.x - centre.x) * arm.u.x + (c.z - centre.z) * arm.u.z;
      // Outside the box only: a car already parked in the fan is not a car in front in the queue.
      if (a < along && a > armHalf(arm) + 0.5 && Math.abs(laneAt(c) - laneAt(car)) < 1.5) {
        lead = Math.min(lead, along - a);
      }
    }
    const ahead = lead < Infinity;
    let run = null;
    if (!ahead && along < armHalf(arm) + STOP_SETBACK + 2) {
      // Pulled up at the line, not still arriving at a chase's 20 u/s: the run in is sized from a
      // standstill, and a car taken onto it at speed overshoots its slot into the next one.
      if (car.v > 3) return;
      run = slotRun(m, car.x, car.z, car.yaw);
      if (!run) return;
    } else {
      if (!arm.leave || !J.sealed) return;
      if (crew.some((o) => o.mode === 'in' && o.arm === arm)) return;
      // Room to get out round the car in front: two quarter-turns at TURN_R to cross the road, and
      // it was clipping the back of the queue at anything less.
      if (lead < 2 * TURN_R + CAR_LEN) return;
      // The far side has to be empty between it and the box. It only fills from the box, and
      // nothing leaves a sealed box — but a car can still be on its way out from before the seal,
      // and one of the scene's own can be on its way out down it.
      const side = lateralOf(arm);
      const blocked = traffic.cars.some((c) => {
        if (c === car || c.crashed) return false;
        const a = (c.x - centre.x) * arm.u.x + (c.z - centre.z) * arm.u.z;
        const l = (c.x - centre.x) * side.x + (c.z - centre.z) * side.z;
        return a > armHalf(arm) && a < along + CAR_LEN && Math.abs(l - side.off) < 2.2;
      }) || crew.some((o) => o.exit?.arm === arm && o.mode !== 'gone');
      if (blocked) return;
      // ...and it has to be able to stop where it waits (`upFarSide`), from whatever speed the
      // chase has it doing, with room to get across the road before it gets there.
      const edge = armHalf(arm) + STOP_SETBACK + 0.6;
      if (along - edge < Math.max((car.v * car.v) / (2 * DECEL) + 1, 2 * TURN_R + CAR_LEN)) return;
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
    m.slip = 0;
    m.arm = arm;
    m.stuck = 0;
    if (run) arrive(m, run);
    else m.mode = 'in';
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
   * Drive along `m.path`; true at its end. `stop` brakes onto the end rather than through it, at
   * `decel`. The body is posed off the path's own `body` yaw, which on a run in swings round to the
   * slot (`slideIn`) — the screech — and lands on it exactly, so a parked car points where its slot
   * says.
   */
  function follow(m, dt, { vmax, decel, stop }) {
    const car = m.car;
    const path = m.path;
    const left = path.len - path.s;
    const want = stop ? Math.min(vmax, Math.sqrt(2 * decel * Math.max(0, left))) : vmax;
    const braking = stop && want < m.v - 0.5;
    m.v += Math.max(-Math.max(DECEL, decel) * dt, Math.min(ACCEL * dt, want - m.v));
    if (stop && left < 0.05) m.v = 0;
    path.s = Math.min(path.len, path.s + Math.max(m.v, stop ? 0.3 : 0) * dt);
    let k = 1;
    while (k < path.pts.length - 1 && path.pts[k].at < path.s) k += 1;
    const a = path.pts[k - 1];
    const b = path.pts[k];
    const f = b.at > a.at ? (path.s - a.at) / (b.at - a.at) : 1;
    car.x = a.x + (b.x - a.x) * f;
    car.z = a.z + (b.z - a.z) * f;
    const done = path.s >= path.len;
    const body = done ? path.yaw : wrap(a.body + wrap(b.body - a.body) * f);
    m.heading = body;
    m.slip *= Math.exp(-dt * 6);
    car.yaw = wrap(body + m.slip);
    // Sliding in lays rubber and squeals, the chase's own tyre marks (`copLaysRubber`).
    car.skid = Boolean(path.slide) && braking;
    car.v = m.v;
    car.travelled += m.v * dt;
    return done;
  }

  /**
   * Drive along a straight line — through (ox, oz), direction (tx, tz) — to `s` along it, braking
   * to a stop there if `stop`; true once it is there. Steered onto the line rather than at a point
   * on it: chasing a point it cannot turn tight enough to reach is how a car ends up orbiting it
   * (see `drive`).
   */
  function onLine(m, dt, ox, oz, tx, tz, s, stop) {
    const car = m.car;
    const dx = car.x - ox;
    const dz = car.z - oz;
    const along = dx * tx + dz * tz;
    const across = dx * -tz + dz * tx;
    const pull = Math.max(-1.2, Math.min(1.2, 0.9 * across));
    const left = s - along;
    const want = stop ? Math.min(OUT_V, Math.sqrt(2 * 6 * Math.max(0, left - 0.1))) : OUT_V + 2;
    drive(m, yawOf(tx + pull * tz, tz - pull * tx), want, dt);
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
    // front of the queue beside it: any nearer and its nose is in the box before it has a slot.
    const edge = armHalf(m.arm) + STOP_SETBACK + 0.6;
    return onLine(m, dt, ox + m.arm.u.x * 100, oz + m.arm.u.z * 100, -m.arm.u.x, -m.arm.u.z, 100 - edge, true);
  }

  /**
   * One frame of a hand-driven car: steer for heading `desired`, try for `want` u/s, and keep off
   * the car in front. Turn rate is capped at a real car's (TURN_R), so it arcs rather than pivots —
   * which is also how a car chasing a point it cannot turn tight enough to reach ends up orbiting
   * it for good (measured: a cop circling its own waypoint for 25 seconds). So a car that is
   * pointing well off where it wants to go slows right down first, and turns tight at a crawl, the
   * way a driver does.
   */
  function drive(m, desired, want, dt) {
    const car = m.car;
    car.skid = false;
    const fx = Math.cos(m.heading);
    const fz = -Math.sin(m.heading);
    for (const o of crew) {
      if (o === m || !o.car.staged || o.mode === 'inbound') continue;
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
    m.slip *= Math.exp(-dt * 6);
    car.yaw = wrap(m.heading + m.slip);
    car.v = m.v;
    car.travelled += m.v * dt;
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
    if (m.slot) m.slot.by = null;
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

  /**
   * Is `lane` clear around `s` — nothing on it near there, and none of the scene's own cars on its
   * way to it? Asked in the world as well as on the lane, because a staged car's lane position is
   * stale (see `tryStage`).
   */
  function laneClear(lane, s, self) {
    const p = lane.path.at(s);
    return !traffic.cars.some((c) => !c.crashed && c !== self.car
      && ((c.lane === lane && c.state === 'drive' && !c.staged && Math.abs(c.s - s) < CAR_LEN * 2)
        // Under a lane's width: the queue at the stop line beside it is the next lane over.
        || Math.hypot(c.x - p.x, c.z - p.z) < 3))
      && !crew.some((o) => o !== self && o.mode !== 'gone' && o.exit?.lane === lane);
  }

  /**
   * The way out for a parked car: the clear pull-out onto a lane leaving the junction that turns it
   * least. A car pointed at a corner has two arms a quarter-turn or less away and two more it would
   * have to swing right round for; OUT_TURN_MAX rules out the ones it would have to back up for.
   */
  function exitFor(m) {
    let best = null;
    let bestTurn = Infinity;
    for (const arm of arms) {
      if (!arm.leave) continue;
      const lane = arm.leave;
      const s = Math.min(RELEASE_S, lane.length - STOP_SETBACK - 2);
      if (s <= 0) continue;
      const end = lane.path.at(s);
      const t = lane.path.tangentAt(s);
      const yaw = yawOf(t.x, t.z);
      const turn = Math.abs(wrap(yaw - m.heading));
      if (turn > OUT_TURN_MAX || turn >= bestTurn) continue;
      // Room where it will land, and nobody coming up it the other way to join (`upFarSide`).
      if (!laneClear(lane, s, m) || crew.some((o) => o.mode === 'in' && o.arm === arm)) continue;
      const path = curve(m.car.x, m.car.z, m.heading, end.x, end.z, yaw);
      if (!pathOk(path, m)) continue;
      best = { arm, lane, s, path };
      bestTurn = turn;
    }
    return best;
  }

  /** Start `m` off the fan, if it has a way out. True if it went. */
  function pullOut(m) {
    const exit = exitFor(m);
    if (!exit) return false;
    if (m.slot) m.slot.by = null;
    m.slot = null;
    m.exit = { arm: exit.arm, lane: exit.lane, s: exit.s };
    m.path = exit.path;
    m.mode = 'out';
    return true;
  }

  function end() {
    if (J) traffic.sealJunction(J.i, J.j, false);
    J = null;
    crew = [];
    slots = [];
    figure = null;
    boarder = null;
    state.phase = 'off';
  }

  function update(dt) {
    if (state.phase === 'off') return;
    state.time += dt;
    state.phaseTime += dt;
    // Anything wrecked, or taken off the road from under the scene, is simply out of it.
    crew = crew.filter((m) => {
      const keep = m.mode === 'gone' || (traffic.policeCars.includes(m.car) && !m.car.crashed);
      if (!keep && m.slot) m.slot.by = null;
      return keep;
    });

    for (const m of crew) {
      if (m.mode === 'inbound') {
        if (state.phase === 'converge' || state.phase === 'standoff') {
          routeIn(m);
          tryStage(m);
        }
      } else if (m.mode === 'in') {
        // Up the far side to the edge of the box, and wait there for a clear run at a slot.
        m.stuck = m.v < 0.3 ? m.stuck + dt : 0;
        const there = upFarSide(m, dt) || m.stuck > STUCK;
        if (there && !taxiNear() && !crew.some((o) => o.mode === 'arrive')) {
          const run = slotRun(m, m.car.x, m.car.z, m.heading);
          if (run) arrive(m, run);
        }
      } else if (m.mode === 'arrive') {
        if (follow(m, dt, { vmax: SCREECH_V, decel: SCREECH_DECEL, stop: true })) {
          m.mode = 'parked';
          m.v = 0;
          m.car.v = 0;
          if (state.fanTime < 0) state.fanTime = 0;
        }
      } else if (m.mode === 'parked') {
        // Settle whatever is left of the slide, at a standstill.
        m.slip *= Math.exp(-dt * 8);
        m.car.yaw = wrap(m.heading + m.slip);
        m.car.skid = false;
        m.car.v = 0;
      } else if (m.mode === 'backup') {
        if (follow(m, dt, { vmax: 3, decel: 6, stop: true })) {
          m.mode = 'parked';
          m.v = 0;
          m.car.v = 0;
        }
      } else if (m.mode === 'out') {
        if (follow(m, dt, { vmax: OUT_V, decel: OUT_DECEL, stop: false })) handBack(m, m.exit.lane, m.exit.s);
      }
    }
    if (state.fanTime >= 0) state.fanTime += dt;

    const parked = crew.filter((m) => m.mode === 'parked');
    const moving = crew.filter((m) => m.mode === 'arrive' || m.mode === 'in');
    const coming = crew.filter((m) => m.mode === 'inbound');

    // The figure: hands up once it is on the kerb, facing the middle of the junction — which is
    // the middle of the fan.
    if (figure?.settled() && (state.phase === 'converge' || state.phase === 'standoff')) {
      figure.standing?.surrender?.(state.time, centre.x - figure.x, centre.z - figure.z);
    }

    if (state.phase === 'converge') {
      if (parked.length) setPhase('standoff');
      else if (state.time > ARREST_WAIT || !crew.length) { giveUp(); return; }
    }

    if (state.phase === 'standoff') {
      const late = coming.length > 0 && state.fanTime < STANDOFF_TIME + LATE_WAIT;
      if (state.fanTime >= STANDOFF_TIME && !late && !moving.length && (!figure || figure.settled())) {
        // Anyone still on their way in is not needed now.
        for (const m of coming) { standDown(m.car); m.mode = 'gone'; }
        // The robber gives themselves up to the nearest car.
        boarder = figure && parked.length
          ? parked.reduce((a, b) => (Math.hypot(a.car.x - figure.x, a.car.z - figure.z)
            <= Math.hypot(b.car.x - figure.x, b.car.z - figure.z) ? a : b))
          : null;
        if (boarder) {
          setPhase('board');
        } else {
          figure?.release({ fade: true });
          figure = null;
          setPhase('leave');
        }
      }
    }

    if (state.phase === 'board') {
      const m = crew.includes(boarder) && boarder.mode === 'parked' ? boarder : null;
      const t = Math.min(1, state.phaseTime / BOARD_TIME);
      if (figure && m) {
        // To the rear door on the robber's side, not the middle of the car: the middle is the far
        // side of the bonnet the robber is standing in front of.
        const fx = Math.cos(m.heading);
        const fz = -Math.sin(m.heading);
        let sx = -fz;
        let sz = fx;
        if ((figure.x - m.car.x) * sx + (figure.z - m.car.z) * sz < 0) { sx = -sx; sz = -sz; }
        const dx = m.car.x - fx * 0.5 + sx * (CAR_W / 2 + 0.25) - figure.x;
        const dz = m.car.z - fz * 0.5 + sz * (CAR_W / 2 + 0.25) - figure.z;
        figure.standing?.board?.(t, dx, dz, dx - sx * 0.6, dz - sz * 0.6);
      }
      if (t >= 1 || !m) {
        figure?.release();
        figure = null;
        state.arrests += 1;
        setPhase('leave');
      }
    }

    if (state.phase === 'leave') {
      sinceLeave += dt;
      // A car nobody can see skips the drive out.
      for (const m of crew) {
        if (m.mode !== 'gone' && m.car.staged && m.mode !== 'out' && outOfShot(m.car)) retire(m);
      }
      const busy = crew.some((m) => m.mode === 'out' || m.mode === 'backup' || m.mode === 'arrive');
      if (sinceLeave >= LEAVE_GAP && !busy) {
        // The one with the robber in it goes first.
        const order = crew.filter((m) => m.mode === 'parked')
          .sort((a, b) => (b === boarder) - (a === boarder));
        const went = order.find((m) => pullOut(m));
        if (went) {
          sinceLeave = 0;
          leaveStuck = 0;
        } else if (order.length) {
          // Nobody can get out from where they are. After a moment, one backs up and looks again.
          leaveStuck += dt;
          if (leaveStuck > STUCK) {
            const m = order.find((o) => pathOk(reverseLine(o, BACK_UP), o));
            if (m) {
              m.path = reverseLine(m, BACK_UP);
              m.mode = 'backup';
              if (m.slot) m.slot.by = null;
              m.slot = null;
            }
            leaveStuck = 0;
          }
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
   * No cop ever made it into the box. The robber walks off and the ones still coming stand down;
   * one already out of traffic on its way in is seen out by the leave phase like any other, which
   * only retires what nobody can see.
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
    crew: () => crew.map((m) => ({ car: m.car, mode: m.mode, slot: m.slot ? { ...m.slot, by: undefined } : null })),
    /** The robber's figure while the scene has one, for the tools. */
    figure: () => (figure ? { x: figure.x, z: figure.z } : null),
    /** The junction it is at, or null. */
    junction: () => (J ? { ...J } : null),
    /**
     * The car the robber gave themselves up to, while the scene still has it — the police
     * helicopter (game/policeheli.js) follows it away. Null before the board and once it is back
     * in traffic.
     */
    boarder: () => (boarder && crew.includes(boarder) && boarder.mode !== 'gone' ? boarder.car : null),
  };
}
