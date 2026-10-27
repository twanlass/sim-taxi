import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import { VIEW_DIR } from './camera.js';
import {
  SKATE_TOP_Y, LIP_H, TRANS_RUN, TRANS_R, RAIL_H, RAIL_R, RAIL_HALF, BOX_TOP_HALF, BOX_KICK,
  surfaceAt,
} from '../city/skatepark.js';

// The rider on the skatepark (city/skatepark.js): one person, using the whole park — carving
// across from the funbox lane to the rail's on the quarter pipes, and putting something different
// down at each end. `?skater=classic` is the first cut (game/skatersclassic.js): one or two riders,
// each fixed to a lane, airs and kickturns only.
//
// Scenery on the hoopers' terms: no collisions, nothing the fare loop knows about, and a run seed
// rather than the city's.
//
// **Still a pendulum, pumped** — the first cut's model, and the right one: a point on the lane's
// surface with a signed speed along it, gravity doing the work, and the speed *set* on entering
// the flat so the far end peaks where its trick wants it. What is new is that the energy is kept
// (`E`), so a hop over the funbox or a grind down the rail can take the rider off the surface and
// hand them back at the speed the far end was budgeted for.
//
// **What read as robotic, and what replaces it.**
//
//   - *The board snapped over the funbox.* It was oriented by the slope under its middle, and the
//     funbox's slope is piecewise constant, so the whole board flipped between 0° and 24° on the
//     frame its centre crossed an edge. Now the board is a rigid stick on its two trucks
//     (`restLine`): its pitch is the slope of the surface's upper hull under the wheelbase, eased
//     by a stiff spring, and its height is the lowest the stick can sit at that pitch without a
//     wheel going through the concrete. Over a convex edge it *tips*, pivoting on the edge as a
//     real board does; up a transition it is the chord between the trucks, which is the sag the
//     first cut faked with a constant.
//   - *The body was a function of the slope.* Knees, lean and arms are now springs (`settle`)
//     driven by what the rider feels — the load pressing them into a transition, the deceleration
//     pitching them forward, a landing — with enough underdamping to overshoot. That lag is most
//     of the difference between a figure that moves and one that is moved.
//   - *Every turn was the same 180.* The ends now draw from kickturns, airs (grabbed, kickflipped,
//     spun a full 360), a rock to fakie, a 180 on the deck and a rest; the middle from ollies,
//     kickflips and shove-its over the funbox, a manual across its top, and 50-50s and boardslides
//     down the rail.
//
// **The orientation is a frame, not three angles** (`orient`): the board lies on the surface's
// tangent, and every turn is a spin about the board's normal. Stance is not stored either — riding
// fakie is just travelling toward the tail, and the tricks that toggle it (a rock, a 360) are
// the ones that reverse the travel without turning the board round.

/** Gravity, a little under the hoopers' 16: an air should hang long enough to see the spin in. */
const G = 13;
/**
 * And for a hop off the flat. Stiffer than the ramps' on purpose: an ollie is legs, not a fall,
 * and at `G` one high enough to clear the rail travels further than the flat is long.
 */
const G_HOP = 26;

/** Half the wheelbase — the trucks sit this far either side of the board's middle. */
const TRUCK = 0.55;
const DECK_TOP = 0.255;
/** Where the board flips and spins about, over its own origin: halfway up the trucks. */
const BOARD_PIVOT_Y = 0.15;
/** The trucks' axles over the board's origin — what sits on the rail in a 50-50. */
const AXLE_Y = 0.07;
/** The deck's underside over the board's origin — what sits on the rail in a boardslide. */
const DECK_UNDER = 0.185;

/** Above the lip on an air, and how far short of it a kickturn turns. */
const AIR_PEAK = [0.6, 1.3];
const KICK_SHORT = [0.15, 0.45];
/** A 360 needs the hang time: only airs at least this far over the lip spin one. */
const SPIN360_PEAK = 1.0;
/** How much of the lip's 72° the board gives back at the top of an air: it comes up over level. */
const AIR_FLATTEN = 0.65;
const KICK_TIME = 0.45;
/**
 * The board tipping over an edge: a change in the resting pitch bigger than `TIP_STEP` in one
 * substep is an edge (a smooth transition turns ~0.01 a substep at full speed), and it is let go
 * at `TIP_W` — about a sixth of a second to settle, which reads as a board tipping rather than
 * snapping.
 */
const TIP_STEP = 0.03;
const TIP_W = 12;
/** Passes between rests on the deck, and the rest itself. */
const PASSES = [6, 12];
const REST = [1.4, 3.2];
/** How far onto the deck the board's middle goes for a stall: tail over the coping, nose at the back. */
const DECK_IN = 0.42;
/** The share of passes that carve across to the other lane. */
const SWITCH_LANE = 0.55;

/**
 * **The push.** Half the forward passes that would come back toes-to-camera (`toeSideAway`) end
 * in a lazy kickturn low on the transition
 * (`PUSH_SETUP_PEAK`, against the lip's 1.57), and the pass back comes down the middle of the flat
 * — clear of the funbox and the rail, `PUSH_LANE` — with the back foot off the board, kicking. The
 * speed the far end was budgeted for is earned on the ground rather than handed over at the pump:
 * each kick adds its share of the energy while the foot is planted, so the rider visibly comes in
 * slow and leaves fast. One to three kicks, as many as fit before the far transition, then the
 * foot goes back on and the board glides into whatever the far end draws.
 *
 * The foot is planted in the *world* (`planted`, pinned in `pose`) and the board rolls past it, so it never skates
 * over the concrete: it touches down `PLANT_X` ahead of the deck's middle, beside the board on the
 * toe side (`FOOT_Z` — the deck is 0.26 either side and the shin 0.155, so anything nearer clips
 * the edge of the deck), and lifts at `PUSH_END_X`, about the back truck. `PUSH_DROP` is the front
 * knee folding so the back leg reaches the floor 0.255 under the deck: the hips can sit no higher
 * than ~0.95 over the floor for a 1.15 leg reaching 0.4 out to the side and 0.45 back.
 */
const PUSH_SHARE = 0.5;
const PUSH_SETUP_PEAK = [0.22, 0.32];
const PUSH_LANE = { v: 0, feature: 'flat' };
const PLANT_X = 0.05;
const PUSH_END_X = -0.65;
const FOOT_Z = 0.44;
const FOOT_LIFT = 0.2;
const PUSH_REACH = 0.22;
const PUSH_RECOVER = 0.2;
const PUSH_RETURN = 0.28;
const PUSH_DROP = 0.42;
const PUSH_MAX = 3;

/**
 * The body's set points. `LOOSE` is the default; `STIFF` is the pose #461 shipped with, kept behind
 * `?skater=stiff` for comparison. It read as a frozen T-pose, and the numbers say why: knees at a
 * 0.1 crouch are 0.4 rad off straight, the back never left vertical, and arms held out at a radian
 * either side are most of a T. A riding stance is the opposite on all three — knees well bent all
 * the time, the chest folded over them, the arms low and loose until something needs balancing.
 */
const LOOSE = {
  crouch: 0.3, load: 0.25, unload: 0.16, deep: 0.42, pop: 0.06,
  spread: 0.5, wide: 1.0, bow: 0.04, hinge: 0.38, elbow: 0.6,
};
const STIFF = {
  crouch: 0.1, load: 0.24, unload: 0, deep: 0.3, pop: 0.04,
  spread: 0.95, wide: 1.35, bow: 0.1, hinge: 0, elbow: 0.45,
};

const TAU = Math.PI * 2;
const ease = (t) => t * t * (3 - 2 * t);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const hump = (k) => Math.sin(Math.PI * clamp(k, 0, 1));
/** An angle folded into [0, 2π). */
const norm = (a) => ((a % TAU) + TAU) % TAU;

/** A damped spring, stepped semi-implicitly. */
function spring(st, target, w, zeta, h) {
  st.v += (w * w * (target - st.x) - 2 * zeta * w * st.v) * h;
  st.x += st.v * h;
}

/** Pick from `[[name, weight], …]`, skipping `avoid` unless it is all there is. */
function weighted(rng, table, avoid = null) {
  const pool = table.filter(([n, w]) => w > 0 && n !== avoid);
  const use = pool.length ? pool : table;
  let x = rng.next() * use.reduce((s, [, w]) => s + w, 0);
  for (const [n, w] of use) {
    x -= w;
    if (x <= 0) return n;
  }
  return use[use.length - 1][0];
}

/**
 * @param park  the plan from city/skatepark.js, or null — a quiet no-op, as the hoopers are.
 */
export function createSkaters(scene, rng, park, { stiff = false, push = true } = {}) {
  const T = stiff ? STIFF : LOOSE;
  const group = new THREE.Group();
  group.name = 'skaters';
  if (!park) return { group, riders: [], entryObjects: [], update: () => {} };
  scene.add(group);

  const person = createPerson({
    body: rng.chance(0.5) ? PALETTE.skaterA : PALETTE.skaterB, legs: PALETTE.skaterPants,
    hair: rng.pick(['#2E2520', '#6B4A33', '#B8863B']), pickable: null,
  });

  // holder — on the surface, in the board's frame
  //   tiltPivot — at one truck, for lifting the other end (a kickturn, a manual, an ollie's pop)
  //     tiltInner
  //       boardPivot — the board's own flips and shove-its
  //       stance — the figure
  const holder = new THREE.Group();
  const tiltPivot = new THREE.Group();
  const tiltInner = new THREE.Group();
  const boardPivot = new THREE.Group();
  boardPivot.position.y = BOARD_PIVOT_Y;
  const board = new THREE.Mesh(buildBoard(), propMaterial());
  board.castShadow = true;
  board.position.y = -BOARD_PIVOT_Y;
  boardPivot.add(board);
  const stance = new THREE.Group();
  stance.position.y = DECK_TOP;
  stance.add(person.group);
  tiltInner.add(boardPivot, stance);
  tiltPivot.add(tiltInner);
  holder.add(tiltPivot);
  group.add(holder);

  const lanes = park.lanes;
  const laneOf = (feature) => lanes.find((l) => l.feature === feature);
  const side0 = rng.chance(0.5) ? 1 : -1;
  const lane0 = laneOf('box');

  const rider = {
    person, holder, board,
    lane: lane0, v: lane0.v,
    u: side0 * (park.lipU + DECK_IN), s: 0, E: G * LIP_H,
    psi: side0 > 0 ? Math.PI : 0,
    mode: 'stall',
    stall: null,
    air: null, hop: null, grind: null,
    spin: null,
    end: null, lastEnd: null,
    mid: null, midDone: false,
    carve: null,
    passes: rng.int(PASSES[0], PASSES[1]),
    t: rng.next() * 10,
    dir: -side0,
    // Springs: board pitch, the carve's yaw, the lift of one end, and the body.
    pitch: { x: 0, v: 0 },
    pOff: { x: 0, v: 0 },
    lastHull: null,
    yaw: { x: 0, v: 0 },
    slide: 0,
    tilt: { x: 0, v: 0 },
    tiltLead: 1,
    flip: 0,
    shuv: 0,
    crouch: { x: 0.05, v: 0 },
    lean: { x: 0, v: 0 },
    twist: { x: 0, v: 0 },
    swing: { x: 0, v: 0 },
    spread: { x: 0.5, v: 0 },
    grab: 0,
    tuck: 0,
    // The push in progress (`stepPush`), and whether the pass being set up ends in one.
    push: null,
    pushNext: false,
    pushW: 0,
    // What `settle` is aiming each one at, set by whichever mode is running this step.
    want: null,
  };
  const riders = [rider];

  // --- The surface the board rests on --------------------------------------------

  const surf = (r, u) => surfaceAt(park, r.lane.feature, u);

  /** Where the profile changes slope: a sample set has to include these or a chord can cut one. */
  function kinks(r) {
    const k = [park.transU, park.lipU];
    if (r.lane.feature === 'box') k.push(BOX_TOP_HALF, BOX_TOP_HALF + BOX_KICK);
    return k.flatMap((x) => [x, -x]);
  }

  const SAMPLES = 8;
  const xs = [];
  const hs = [];
  function sample(r, u, half) {
    xs.length = 0;
    for (let i = 0; i <= SAMPLES; i++) xs.push(u - half + (2 * half * i) / SAMPLES);
    for (const k of kinks(r)) if (k > u - half && k < u + half) xs.push(k);
    xs.sort((a, b) => a - b);
    hs.length = 0;
    for (const x of xs) hs.push(surf(r, x).h);
  }

  /**
   * The slope a board with its trucks `half` either side of `u` settles at: the slope of the
   * surface's upper hull under its middle. On a concave transition that is the chord between the
   * trucks; over a convex edge it is whichever side of the edge the board's middle is on, which is
   * the board tipping as its weight crosses the edge.
   */
  const hull = [];
  function restSlope(r, u, half) {
    sample(r, u, Math.max(1e-3, half));
    hull.length = 0;
    for (let i = 0; i < xs.length; i++) {
      while (hull.length >= 2) {
        const a = hull[hull.length - 2];
        const b = hull[hull.length - 1];
        // Upper hull: drop b while it sits on or under the line from a to the new point.
        const cross = (xs[b] - xs[a]) * (hs[i] - hs[a]) - (hs[b] - hs[a]) * (xs[i] - xs[a]);
        if (cross >= -1e-12) hull.pop();
        else break;
      }
      hull.push(i);
    }
    for (let j = 0; j < hull.length - 1; j++) {
      const a = hull[j];
      const b = hull[j + 1];
      if (u <= xs[b] || j === hull.length - 2) {
        const dx = xs[b] - xs[a];
        return dx > 1e-9 ? (hs[b] - hs[a]) / dx : 0;
      }
    }
    return 0;
  }

  /**
   * The height of the board's middle for a board at `slope` over `u`: the lowest the straight line
   * through its trucks can sit without going under the surface anywhere along it. Checking the
   * samples is enough — between two of them the surface is a straight or a concave-up arc, and a
   * line can only dip under one of those at its ends.
   */
  function restHeight(r, u, slope, half) {
    // Even a board turned across the slope gets sampled: centred on a concave ramp at its tangent,
    // its trucks would sit a few millimetres into it.
    sample(r, u, Math.max(1e-3, half));
    let c = -Infinity;
    for (let i = 0; i < xs.length; i++) c = Math.max(c, hs[i] - slope * (xs[i] - u));
    return c;
  }

  /** How far either side of the middle the trucks reach along u, for the board as it now lies. */
  const truckSpan = (r) => TRUCK * Math.cos(r.pitch.x) * Math.abs(Math.cos(r.psi + r.yaw.x + r.slide));

  /** The board's middle over the floor, for a rider on the surface. */
  const restingY = (r) => restHeight(r, r.u, Math.tan(r.pitch.x), truckSpan(r));

  // --- The frame ---------------------------------------------------------------

  const U = new THREE.Vector3(park.U.x, 0, park.U.z);
  const V = new THREE.Vector3(park.V.x, 0, park.V.z);
  const Y = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const across = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const face = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  /**
   * The holder's rotation for a board on a slope of `a` radians (rising along +u) spun `psi` about
   * its normal. The figure stands sideways, so the *board* is its X axis and it faces along
   * board × normal.
   */
  function orient(a, psi) {
    tangent.copy(U).multiplyScalar(Math.cos(a)).addScaledVector(Y, Math.sin(a));
    normal.copy(U).multiplyScalar(-Math.sin(a)).addScaledVector(Y, Math.cos(a));
    across.crossVectors(normal, tangent);
    fwd.copy(tangent).multiplyScalar(Math.cos(psi)).addScaledVector(across, Math.sin(psi));
    face.crossVectors(fwd, normal);
    basis.makeBasis(fwd, normal, face);
    holder.quaternion.setFromRotationMatrix(basis);
  }

  // --- Planning ------------------------------------------------------------------

  /** Which way along the board the rider is travelling: +1 toward the nose, −1 riding fakie. */
  const travel = (r) => Math.sign(Math.cos(r.psi) * r.s) || r.dir;

  /**
   * Whether the rider's toes point away from the camera. The kicking foot goes down on the toe
   * side, so a push with the toes away is a figure's back with a leg somewhere behind it — and the
   * view never turns, so which way along the park a rider faces decides it for the whole pass. A
   * push comes back the other way after a kickturn, so it is set up on a pass that has its toes
   * *away*. The toe side is the stance's +Z, `fwd × normal` on the flat:
   * cos ψ (U × Y) + sin ψ U, with U × Y = (−U.z, 0, U.x).
   */
  function toeSideAway(r) {
    const c = Math.cos(r.psi);
    const sn = Math.sin(r.psi);
    return c * (VIEW_DIR.z * park.U.x - VIEW_DIR.x * park.U.z)
      + sn * (VIEW_DIR.x * park.U.x + VIEW_DIR.z * park.U.z) < 0;
  }

  /** On entering the flat: what happens at the far end, and the speed that peaks there for it. */
  function pump(r) {
    r.passes -= 1;
    const fakie = travel(r) < 0;
    if (r.mid === 'push') {
      // The energy for the far end is the push's to earn: the speed is left as it arrived.
      r.end = weighted(rng, [['air', 0.35], ['flip', 0.2], ['air360', 0.2], ['deck180', 0.25]], r.lastEnd);
      r.lastEnd = r.end;
      const peak = r.end === 'air360' ? LIP_H + rng.range(SPIN360_PEAK, AIR_PEAK[1])
        : r.end === 'deck180' ? LIP_H + rng.range(0.08, 0.14)
          : LIP_H + rng.range(AIR_PEAK[0], AIR_PEAK[1]);
      r.push = { phase: 'wait', E1: G * peak, base: r.E, dE: 0, n: 0, kick: 0, t: 0, plantU: 0,
        foot: new THREE.Vector3(), deck: 1, w: 0 };
      return;
    }
    let end;
    if (r.passes <= 0) {
      end = 'rest';
    } else if (push && !fakie && toeSideAway(r) && rng.chance(PUSH_SHARE)) {
      // A lazy kickturn low on the transition, to come back slow enough to push.
      end = 'kick';
      r.pushNext = true;
    } else {
      // Fakie, the rider leans toward the tricks that bring them back round: a rock or a 360.
      end = weighted(rng, fakie
        ? [['kick', 0.3], ['rock', 0.4], ['air360', 0.3]]
        : [['kick', 0.3], ['air', 0.22], ['flip', 0.12], ['air360', 0.1], ['rock', 0.12], ['deck180', 0.14]],
      r.lastEnd);
    }
    let peak;
    if (r.pushNext) peak = rng.range(PUSH_SETUP_PEAK[0], PUSH_SETUP_PEAK[1]);
    else if (end === 'kick') peak = LIP_H - rng.range(KICK_SHORT[0], KICK_SHORT[1]);
    else if (end === 'air360') peak = LIP_H + rng.range(SPIN360_PEAK, AIR_PEAK[1]);
    else if (end === 'air' || end === 'flip') peak = LIP_H + rng.range(AIR_PEAK[0], AIR_PEAK[1]);
    else peak = LIP_H + rng.range(0.08, 0.14);
    r.end = end;
    r.lastEnd = end;
    r.peak = peak;
    r.E = G * peak;
    r.s = Math.sign(r.s) * Math.sqrt(2 * r.E);
  }

  /**
   * On the way out of the flat, or dropping in: which lane the next pass takes and what it does
   * in the middle. The lane change is a carve across the transition, spread over the path the rider
   * will cover on it, so it is finished by the time they are back on the flat.
   */
  function planPass(r, pathLen) {
    const next = r.pushNext ? PUSH_LANE
      : r.lane === PUSH_LANE ? rng.pick(lanes)
        : rng.chance(SWITCH_LANE) ? lanes.find((l) => l !== r.lane) : r.lane;
    r.carve = next === r.lane && Math.abs(r.v - next.v) < 1e-6 ? null
      : { from: r.v, to: next.v, done: 0, len: Math.max(0.5, pathLen) };
    r.lane = next;
    r.push = null;
    if (r.pushNext) {
      r.pushNext = false;
      r.mid = 'push';
      r.midDone = true;
      return;
    }
    r.mid = next.feature === 'rail'
      ? weighted(rng, [['5050', 0.55], ['boardslide', 0.45]])
      : weighted(rng, [['ollie', 0.3], ['kickflip', 0.25], ['shuv', 0.15], ['manual', 0.3]]);
    r.midDone = false;
  }

  /** How much transition path a pass out to `end` covers, there and back. */
  function outAndBack(r, end) {
    if (end === 'kick') {
      // The peak `pump` drew: a push's set-up kickturn turns well short of the others.
      const peak = r.peak ?? LIP_H - (KICK_SHORT[0] + KICK_SHORT[1]) / 2;
      return 2 * Math.sqrt(TRANS_R * TRANS_R - (TRANS_R - peak) ** 2);
    }
    return 2 * TRANS_RUN + (end === 'air' || end === 'flip' || end === 'air360' ? 0 : 2 * DECK_IN);
  }

  // --- The modes ---------------------------------------------------------------

  /** Leaving the surface at the lip. */
  function startAir(r, kind) {
    const side = Math.sign(r.u) || 1;
    r.u = side * (park.lipU - 0.02);
    const vy = Math.sqrt(Math.max(0.5, 2 * (r.E - G * LIP_H)));
    const by = (rng.chance(0.5) ? 1 : -1) * (kind === 'air360' ? TAU : Math.PI);
    r.air = { kind, side, vy, T: (2 * vy) / G, t: 0, y0: restingY(r), psi0: r.psi, by };
    r.mode = 'air';
    r.spin = null;
  }

  function stepAir(r, h) {
    const air = r.air;
    air.t = Math.min(air.T, air.t + h);
    const k = air.t / air.T;
    r.psi = air.psi0 + air.by * ease(clamp((k - 0.08) / 0.84, 0, 1));
    r.flip = air.kind === 'flip' ? TAU * ease(clamp(k / 0.6, 0, 1)) : 0;
    if (air.t >= air.T) {
      // Back in on the lip at the speed it left with. A 180 lands nose first; a 360 lands fakie.
      r.mode = 'ride';
      r.psi = norm(air.psi0 + air.by);
      r.flip = 0;
      r.u = air.side * (park.lipU - 0.02);
      r.s = -air.side * air.vy;
      r.end = null;
      r.crouch.v += 2.6;
      r.air = null;
    }
  }

  /** Up onto the deck for a rock, a 180 or a rest, and back in. */
  function startStall(r, kind) {
    const side = Math.sign(r.u) || 1;
    r.u = side * park.lipU;
    r.mode = 'stall';
    const turn = kind === 'rock' ? 0
      // After a rest the rider drops in facing forward: a fakie arrival needs no turn to get there.
      : kind === 'rest' && travel(r) < 0 ? 0 : (rng.chance(0.5) ? 1 : -1) * Math.PI;
    const up = kind === 'rock' ? 0.28 : 0.35;
    r.stall = {
      kind, side, t: 0, turn,
      up,
      hold: kind === 'rock' ? 0.22 : kind === 'rest' ? 0.55 + rng.range(REST[0], REST[1]) : 0.6,
      back: kind === 'rock' ? 0.32 : 0.34,
      reach: kind === 'rock' ? 0.36 : DECK_IN,
      planned: false,
    };
    r.s = 0;
    r.end = null;
  }

  function stepStall(r, h) {
    const st = r.stall;
    st.t += h;
    const { up, hold, back, reach, side } = st;
    const lip = park.lipU;
    // No speed to speak of on the deck, but a direction: out until the hold, back in after it.
    // `travel` reads which end of the board leads from it.
    r.s = (st.t < up ? side : -side) * 1e-3;
    if (st.t < up) {
      // Rolling up over the coping and slowing to a stop.
      const k = st.t / up;
      r.u = side * (lip + reach * (1 - (1 - k) * (1 - k)));
    } else if (st.t < up + hold) {
      r.u = side * (lip + reach);
      // The turn, on the back truck with the nose up, in the first part of the hold.
      if (st.turn && !r.spin && !st.turned) {
        r.spin = {
          from: r.psi, by: st.turn, t: 0, T: st.kind === 'rest' ? 0.75 : 0.5, lift: 0.4,
          lead: Math.sign(Math.cos(r.psi)) * side,
        };
        st.turned = true;
      }
    } else {
      if (!st.planned) {
        st.planned = true;
        r.dir = travel(r);
        planPass(r, TRANS_RUN);
      }
      // Dropping back in: a push off the deck, accelerating over the coping.
      const k = Math.min(1, (st.t - up - hold) / back);
      r.u = side * (lip + reach - (reach + 0.03) * k * k);
      if (k >= 1) {
        r.mode = 'ride';
        r.s = -side * 1.6;
        r.E = 0.5 * r.s * r.s + G * surf(r, r.u).h;
        r.stall = null;
        if (st.kind === 'rest') r.passes = rng.int(PASSES[0], PASSES[1]);
      }
    }
  }

  /** The take-off for a hop: from where the board is now to `u1`, landing at `y1`. */
  function startHop(r, u1, y1, then, trick) {
    const u0 = r.u;
    const y0 = restingY(r);
    const vh = Math.max(2.5, Math.abs(r.s));
    const T = Math.abs(u1 - u0) / vh;
    const vy = (y1 - y0 + 0.5 * G_HOP * T * T) / T;
    r.hop = { u0, u1, y0, y1, vy, T, t: 0, then, trick, slideBy: 0 };
    r.mode = 'hop';
    r.crouch.v -= 3.2;
    if (trick === 'boardslide') r.hop.slideBy = (rng.chance(0.5) ? 1 : -1) * Math.PI / 2;
    if (trick === 'slideOff') r.hop.slideFrom = r.slide;
  }

  function hopY(hop) {
    return hop.y0 + hop.vy * hop.t - 0.5 * G_HOP * hop.t * hop.t;
  }

  function stepHop(r, h) {
    const hop = r.hop;
    hop.t = Math.min(hop.T, hop.t + h);
    const k = hop.t / hop.T;
    r.u = lerp(hop.u0, hop.u1, k);
    if (hop.trick === 'kickflip') r.flip = TAU * ease(clamp(k / 0.8, 0, 1));
    if (hop.trick === 'shuv') r.shuv = Math.PI * ease(clamp(k / 0.8, 0, 1));
    if (hop.trick === 'boardslide') r.slide = hop.slideBy * ease(k);
    if (hop.trick === 'slideOff') r.slide = hop.slideFrom * (1 - ease(k));
    if (hop.t < hop.T) return;
    r.flip = 0;
    r.shuv = 0;
    r.crouch.v += 2.4;
    if (hop.then === 'grind') {
      r.mode = 'grind';
      r.grind = { y: hop.y1 };
    } else {
      if (hop.trick === 'slideOff') r.slide = 0;
      r.mode = 'ride';
      const v2 = 2 * (r.E - G * surf(r, r.u).h);
      r.s = Math.sign(hop.u1 - hop.u0) * Math.sqrt(Math.max(1, v2));
    }
    r.hop = null;
  }

  /** How far out from the rail's end a hop onto it starts, and where off it a hop lands. */
  const railRun = () => clamp(park.transU - RAIL_HALF - 0.1, 0.6, 1.3);

  function stepGrind(r, h) {
    r.u += r.s * h;
    const out = Math.sign(r.s);
    if (r.u * out >= RAIL_HALF - 0.15) {
      startHop(r, out * (RAIL_HALF + railRun()), 0, 'ride', r.slide ? 'slideOff' : 'pop');
      r.midDone = true;
      r.grind = null;
    }
  }

  /** The foot down: on the floor where it now is, which `pose` pins it to from here. */
  function plant(r, p, nose) {
    p.phase = 'plant';
    p.plantU = r.u + PLANT_X * nose;
    p.planted = null;
  }

  /** The last kick done, or the flat run out: the foot back up onto the deck from where it is. */
  function returnFoot(p) {
    p.phase = 'return';
    p.t = 0;
    p.from = p.foot.clone();
    p.deck0 = p.deck;
    p.w0 = p.w;
  }

  /**
   * The push, stepped while the rider rolls down the middle of the flat. `foot` is where the back
   * foot is wanted in the stance's frame (x along the board, z out the toe side, the floor at
   * −DECK_TOP), `deck` how much of the way back to its place on the deck it is, and `w` how far
   * the body has gone into the push stance.
   */
  function stepPush(r, h, now, heading) {
    const p = r.push;
    const floor = -DECK_TOP;
    // The board's +X along u, and a point on the floor in the board's x.
    const nose = Math.sign(Math.cos(r.psi)) || 1;
    const boardX = (u) => (u - r.u) * nose;
    // The kickturn's spin has to be finished before a foot goes down, or it is planted on a board
    // still turning under it.
    // Run out of flat with kicks still to go: what is left of the energy lands at once, and the
    // foot comes back aboard from wherever it is. Putting it back can finish up the bank — the
    // foot is in the air by then — but a kick cannot.
    if (p.phase !== 'return' && heading > 0 && now > park.transU - 0.1) {
      r.E = p.E1;
      if (p.phase === 'wait') r.push = null;
      else returnFoot(p);
      return;
    }
    if (p.phase === 'wait') {
      if (r.spin || heading > 0) return;
      // Come back fakie (a kickturn finishing as the pass was planned can leave it so), the back
      // foot is the leading one and the push would run backwards: the pump's way instead.
      if (travel(r) < 0) {
        r.E = p.E1;
        r.push = null;
        return;
      }
      // As many kicks as fit before the far transition: the foot's swing out, then each kick's
      // sweep under the board, and the swing back between kicks at the speed reached by then.
      const room = park.transU - r.u * Math.sign(r.s) - 0.2;
      const sweep = PLANT_X - PUSH_END_X;
      const fits = (n) => {
        let used = Math.sqrt(2 * r.E) * PUSH_REACH + n * sweep;
        for (let k = 1; k < n; k++) used += Math.sqrt(2 * (r.E + (k * (p.E1 - r.E)) / n)) * PUSH_RECOVER;
        return used <= room;
      };
      let n = PUSH_MAX;
      while (n > 1 && !fits(n)) n -= 1;
      p.n = n;
      p.dE = (p.E1 - p.base) / n;
      p.phase = 'reach';
      p.t = 0;
    }
    p.t += h;
    if (p.phase === 'reach') {
      const k = Math.min(1, p.t / PUSH_REACH);
      p.foot.set(PLANT_X, floor + FOOT_LIFT * hump(k), FOOT_Z);
      p.deck = 1 - ease(k);
      p.w = ease(k);
      if (k >= 1) plant(r, p, nose);
    } else if (p.phase === 'plant') {
      // Where the foot is drawn is `pose`'s, from the point on the floor it went down on; the kick
      // is paced off the distance rolled since.
      const x = boardX(p.plantU);
      p.deck = 0;
      p.w = 1;
      const k = clamp((PLANT_X - x) / (PLANT_X - PUSH_END_X), 0, 1);
      // The kick: the energy rises while the foot drives back against the floor.
      r.E = p.base + p.dE * ease(k);
      if (k >= 1) {
        p.base += p.dE;
        p.kick += 1;
        p.t = 0;
        p.from = p.foot.clone();
        if (p.kick < p.n) p.phase = 'recover';
        else {
          r.E = p.E1;
          returnFoot(p);
        }
      }
    } else if (p.phase === 'recover') {
      // Swinging forward for the next kick, toes clear of the floor.
      const k = Math.min(1, p.t / PUSH_RECOVER);
      p.foot.set(PLANT_X, floor, FOOT_Z).sub(p.from).multiplyScalar(ease(k)).add(p.from);
      p.foot.y += FOOT_LIFT * hump(k);
      if (k >= 1) plant(r, p, nose);
    } else if (p.phase === 'return') {
      const k = Math.min(1, p.t / PUSH_RETURN);
      p.foot.copy(p.from);
      p.foot.y += FOOT_LIFT * hump(k);
      p.deck = lerp(p.deck0, 1, ease(k));
      p.w = p.w0 * (1 - ease(k));
      if (k >= 1) r.push = null;
    }
  }

  /** Rolling, under gravity: the pendulum, and everything that starts from it. */
  function stepRide(r, h) {
    const was = Math.abs(r.u);
    const { slope } = surf(r, r.u);
    const a = Math.atan(slope);
    const du = r.s * Math.cos(a) * h;
    r.u += du;
    r.s -= G * Math.sin(a) * h;
    // Hold the energy, so nothing a hop or a long frame does drifts the peak off its trick. Left
    // alone near a standstill, where the sign of the speed is gravity's to decide.
    const v2 = 2 * (r.E - G * surf(r, r.u).h);
    if (Math.abs(r.s) > 0.6 && v2 > 0) r.s = Math.sign(r.s) * Math.sqrt(v2);
    const now = Math.abs(r.u);
    const out = Math.sign(r.u) || 1;
    const heading = Math.sign(r.s) * out; // +1 heading out toward an end, −1 in toward the middle

    if (r.carve && (now > park.transU || was > park.transU)) r.carve.done += Math.abs(du);

    // Into the flat: the pump, and the lane change finished.
    if (now < park.transU && was >= park.transU) {
      r.dir = travel(r);
      pump(r);
      if (r.carve) r.v = r.carve.to;
      r.carve = null;
    }
    // Out of the flat: the next pass.
    if (now >= park.transU && was < park.transU) planPass(r, outAndBack(r, r.end));

    // The middle.
    if (!r.midDone && heading < 0) {
      if (r.lane.feature === 'box' && (r.mid === 'ollie' || r.mid === 'kickflip' || r.mid === 'shuv')
        && now <= BOX_TOP_HALF && was > BOX_TOP_HALF) {
        // Off the near edge of the top, over the far kicker, onto the flat beyond it.
        const land = -out * Math.min(park.transU - 0.25, BOX_TOP_HALF + BOX_KICK + 0.35);
        startHop(r, land, 0, 'ride', r.mid);
        r.midDone = true;
        return;
      }
      if (r.lane.feature === 'rail' && now <= RAIL_HALF + railRun() && was > RAIL_HALF + railRun()) {
        const y1 = r.mid === 'boardslide' ? RAIL_H + RAIL_R - DECK_UNDER : RAIL_H - AXLE_Y;
        startHop(r, out * (RAIL_HALF - 0.15), y1, 'grind', r.mid === 'boardslide' ? 'boardslide' : 'pop');
        return;
      }
    }
    if (now < 0.05) r.midDone = true;
    if (r.push) stepPush(r, h, now, heading);

    // A kickturn, timed so the 180 straddles the moment the rider stops climbing.
    if (r.end === 'kick' && heading > 0 && now > park.transU && !r.spin) {
      const toApex = Math.abs(r.s) / Math.max(1, G * Math.abs(Math.sin(a)));
      if (toApex < KICK_TIME * 0.45) {
        r.spin = { from: r.psi, by: (rng.chance(0.5) ? 1 : -1) * Math.PI, t: 0, T: KICK_TIME, lift: 0.45 };
        r.end = null;
      }
    }

    // At the lip, heading out.
    if (now >= park.lipU && heading > 0) {
      if (r.end === 'air' || r.end === 'flip' || r.end === 'air360') startAir(r, r.end);
      else if (r.end === 'deck180' || r.end === 'rest') startStall(r, r.end);
      // A rock, or anything that got there without meaning to: a rock is the graceful way back.
      else startStall(r, 'rock');
    }
  }

  // --- The body ------------------------------------------------------------------

  /**
   * Every spring, aimed at what the rider would be doing in the mode they are in. The board's
   * pitch is one of them: it chases the slope the trucks would rest at, and `restingY` sits the
   * board on the concrete at whatever pitch it has reached — so a lag never puts a wheel through
   * the ramp, it only lets the board tip over an edge rather than snap.
   */
  function settle(r, h) {
    const dir = travel(r);
    if (r.s) r.dir = dir;
    let pitchTo = r.pitch.x;
    let pitchW = 30;
    let crouchTo = T.crouch;
    let leanTo = 0;
    let twistTo = 0.3 * dir;
    let spreadTo = T.spread;
    let tiltTo = 0;
    let tiltLead = dir;
    let grab = 0;
    let tuck = 0;

    const resting = r.mode === 'ride' || r.mode === 'stall';
    if (resting) {
      // The pitch the trucks would rest at, passed straight through while it moves smoothly — up a
      // transition it turns at v/R and any lag would stand the board off the ramp — and only its
      // *jumps* eased: the moment the board's weight crosses an edge, the hull under it changes
      // side, and `pOff` takes the step and lets it go at `TIP_W`.
      const hullPitch = Math.atan(restSlope(r, r.u, truckSpan(r)));
      if (r.lastHull === null) {
        r.pOff.x = r.pitch.x - hullPitch;
        r.pOff.v = r.pitch.v;
      } else if (Math.abs(hullPitch - r.lastHull) > TIP_STEP) {
        r.pOff.x -= hullPitch - r.lastHull;
      }
      r.lastHull = hullPitch;
      pitchTo = hullPitch;
      const { slope } = surf(r, r.u);
      const a = Math.atan(slope);
      const onTrans = Math.abs(r.u) > park.transU && Math.abs(r.u) < park.lipU;
      // The load: gravity's share into the board, plus what the curve adds.
      const load = Math.cos(a) + (onTrans ? (r.s * r.s) / (TRANS_R * G) : 0);
      // Down into the bottom of a transition, and standing tall again as the load comes off near
      // the top: the pump, which is the motion that most says a person is riding this.
      crouchTo = T.crouch + T.load * clamp(load - 1, 0, 1.3) - T.unload * clamp(1 - load, 0, 1);
      // Inertia: slowing toward the nose pitches the body over it, and the arms come up against it.
      const aFwd = -G * Math.sin(a) * Math.cos(r.psi);
      leanTo = clamp(-0.5 * aFwd / G, -0.3, 0.3);
      spreadTo = T.spread + 0.25 * clamp(load - 1, 0, 1);
      if (r.mode === 'ride' && r.lane.feature === 'box' && r.mid === 'manual'
        && Math.abs(r.u) < BOX_TOP_HALF + 0.25) {
        tiltTo = 0.28;
        leanTo = -0.2 * dir;
        spreadTo = T.wide;
      }
      // Loading up for a pop, a stride before it.
      if (r.mode === 'ride' && !r.midDone && Math.abs(r.s) > 0.1 && r.mid !== 'manual') {
        const at = r.lane.feature === 'rail' ? RAIL_HALF + railRun() : BOX_TOP_HALF;
        const toGo = (Math.abs(r.u) - at) / Math.abs(r.s);
        if (toGo > 0 && toGo < 0.22 && Math.sign(r.s) * Math.sign(r.u) < 0 && r.mid !== 'push') crouchTo += 0.3;
      }
      if (r.mode === 'stall') {
        const st = r.stall;
        const holding = st.t > st.up && st.t < st.up + st.hold;
        if (st.kind === 'rest' && holding) {
          // Stood up on the deck, looking about.
          crouchTo = 0.03;
          spreadTo = 0.35;
          twistTo = 0.55 * Math.sin(r.t * 0.9);
          leanTo = 0.05 * Math.sin(r.t * 1.3);
        } else if (st.kind === 'rock' && holding) {
          leanTo = 0.22 * st.side * Math.sign(Math.cos(r.psi));
          crouchTo = T.deep;
        } else if (st.t >= st.up + st.hold) {
          // Committing to the drop: weight over the front foot.
          crouchTo = T.deep;
          leanTo = -0.25 * st.side * Math.sign(Math.cos(r.psi));
        }
      }
    } else if (r.mode === 'air') {
      const air = r.air;
      const k = air.t / air.T;
      const lipAngle = Math.asin(TRANS_RUN / TRANS_R);
      pitchTo = air.side * lipAngle * (1 - AIR_FLATTEN * hump(k));
      pitchW = 14;
      const up = hump(k);
      grab = air.kind === 'air' ? Math.pow(up, 0.6) : 0;
      tuck = air.kind === 'flip' ? hump(k / 0.7) : air.kind === 'air360' ? 0.35 * up : 0;
      crouchTo = 0.06;
      spreadTo = air.kind === 'air360' ? 0.6 : T.wide;
      leanTo = 0;
    } else if (r.mode === 'hop') {
      const hop = r.hop;
      const k = hop.t / hop.T;
      // Level in the air, then meeting whatever it lands on.
      pitchTo = k > 0.55 && hop.then === 'ride' ? Math.atan(surf(r, hop.u1).slope) : 0;
      pitchW = 24;
      tiltTo = k < 0.3 ? 0.5 : 0;
      tiltLead = Math.sign(hop.u1 - hop.u0) * Math.sign(Math.cos(r.psi)) || 1;
      crouchTo = T.pop;
      tuck = hop.trick === 'kickflip' || hop.trick === 'shuv' ? hump(k) : 0.35 * hump(k);
      spreadTo = T.wide;
    } else if (r.mode === 'grind') {
      pitchTo = 0;
      crouchTo = T.deep;
      spreadTo = T.wide;
      leanTo = 0.1 * Math.sin(r.t * 9) + 0.06 * Math.sin(r.t * 14.3);
    }

    // Pushing: down on the front knee so the back foot reaches the floor, shoulders open toward
    // where they are going, the arms low and swinging against the leg.
    let swingTo = -0.12 * r.lean.v + 0.1 * Math.sin(r.t * 1.7);
    const pw = r.push && r.mode === 'ride' ? r.push.w : 0;
    if (pw > 0) {
      crouchTo = lerp(crouchTo, PUSH_DROP, pw);
      leanTo = lerp(leanTo, 0.06 * dir, pw);
      twistTo = lerp(twistTo, 0.6 * dir, pw);
      spreadTo = lerp(spreadTo, 0.3, pw);
      swingTo += pw * 0.45 * (r.push.phase === 'plant' ? 1 : -1);
    }
    r.pushW = pw;

    // A spin in progress — a kickturn or a turn on the deck — lifts the leading end off the back
    // truck and puts the weight back over it.
    if (r.spin) {
      const sp = r.spin;
      if (!sp.lead) sp.lead = dir;
      sp.t = Math.min(sp.T, sp.t + h);
      const k = sp.t / sp.T;
      r.psi = sp.from + sp.by * ease(k);
      tiltTo = sp.lift * hump(k);
      tiltLead = sp.lead;
      leanTo = -0.25 * sp.lead;
      if (k >= 1) {
        r.psi = norm(sp.from + sp.by);
        r.spin = null;
      }
    }

    // The carve: the lane change, and the board pointing where the path goes.
    let yawTo = 0;
    if (r.carve) {
      const c = r.carve;
      const k = clamp(c.done / c.len, 0, 1);
      r.v = lerp(c.from, c.to, ease(k));
      if (r.mode === 'ride' && Math.abs(r.s) > 0.3) {
        const dvdu = ((c.to - c.from) * 6 * k * (1 - k) / c.len) * Math.sign(r.s);
        yawTo = clamp(Math.atan(dvdu), -0.6, 0.6);
      }
    }

    // The pivot only moves to the other truck while that end is down.
    if (Math.abs(r.tilt.x) < 0.01 && tiltTo) r.tiltLead = tiltLead;
    if (tiltLead !== r.tiltLead) tiltTo = 0;

    if (resting) {
      spring(r.pOff, 0, TIP_W, 1, h);
      r.pitch.x = pitchTo + r.pOff.x;
      r.pitch.v = r.pOff.v;
    } else {
      r.lastHull = null;
      spring(r.pitch, pitchTo, pitchW, 0.9, h);
    }
    spring(r.yaw, yawTo, 8, 1, h);
    spring(r.tilt, tiltTo, 22, 0.7, h);
    spring(r.crouch, crouchTo, 13, 0.5, h);
    spring(r.lean, leanTo, 9, 0.45, h);
    spring(r.twist, twistTo, 6, 0.8, h);
    spring(r.spread, spreadTo, 7, 0.6, h);
    spring(r.swing, swingTo, 10, 0.5, h);
    // Tilts that never lift a wheel below the deck: a spring overshooting through zero would.
    if (r.tilt.x < 0) { r.tilt.x = 0; r.tilt.v = Math.max(0, r.tilt.v); }
    r.grab = grab;
    r.tuck = tuck;
  }

  function step(r, h) {
    r.t += h;
    if (r.mode === 'ride') stepRide(r, h);
    else if (r.mode === 'air') stepAir(r, h);
    else if (r.mode === 'stall') stepStall(r, h);
    else if (r.mode === 'hop') stepHop(r, h);
    else if (r.mode === 'grind') stepGrind(r, h);
    settle(r, h);
  }

  // --- Posing ----------------------------------------------------------------

  function pose(r) {
    orient(r.pitch.x, r.psi + r.yaw.x + r.slide);
    let y;
    if (r.mode === 'air') {
      const air = r.air;
      y = air.y0 + air.vy * air.t - 0.5 * G * air.t * air.t;
    } else if (r.mode === 'hop') {
      y = hopY(r.hop);
    } else if (r.mode === 'grind') {
      y = r.grind.y;
    } else {
      y = restingY(r);
    }
    const at = park.toWorld(r.u, r.v);
    holder.position.set(at.x, SKATE_TOP_Y + y, at.z);

    tiltPivot.position.x = -r.tiltLead * TRUCK;
    tiltInner.position.x = r.tiltLead * TRUCK;
    tiltPivot.rotation.z = r.tilt.x * r.tiltLead;
    boardPivot.rotation.set(r.flip, r.shuv, 0);

    const sink = clamp(r.crouch.x, 0, 0.75);
    person.ride({
      drop: sink,
      lean: clamp(r.lean.x, -0.4, 0.4),
      bow: T.bow + 0.12 * clamp(sink, 0, 0.6) * (1 - r.pushW),
      // Folding at the waist with the knees: a squat with a bolt-upright back is the T-pose.
      // Capped: past ~0.45 rad on top of a deep crouch the head goes down to the board.
      // Pushing, the deep front knee is the leg's and not a crouch: the back stays tall over it.
      hinge: lerp(T.hinge * clamp(sink / 0.3, 0, 1.2), 0.12, r.pushW),
      elbow: T.elbow + 0.4 * T.hinge * clamp(sink, 0, 0.6),
      twist: clamp(r.twist.x, -0.7, 0.7),
      swing: clamp(r.swing.x, -0.6, 0.6),
      spread: clamp(r.spread.x, 0.2, 1.5),
      grab: r.grab,
      tuck: r.tuck,
      waist: !stiff,
    });
    // The push foot, off the deck: from where `ride()` just stood it toward the floor.
    if (r.push && r.mode === 'ride' && r.push.deck < 1) {
      const p = r.push;
      if (p.phase === 'plant') {
        // Planted, the foot stays put on the floor in the world and the board rolls away from it,
        // whatever the board does under it — a carve's last yaw settling included.
        holder.updateMatrixWorld(true);
        if (!p.planted) {
          p.planted = stance.localToWorld(p.foot.clone());
          p.planted.y = SKATE_TOP_Y;
        }
        stance.worldToLocal(p.foot.copy(p.planted));
      }
      person.footAt(deckFoot);
      person.plantFoot(deckFoot.lerp(r.push.foot, 1 - r.push.deck));
    }
  }
  const deckFoot = new THREE.Vector3();

  function update(dt) {
    // Short steps: the transition near the lip is a 72° wall, and a long frame would step a rider
    // straight through the top of it.
    const steps = Math.min(32, Math.ceil(dt / (1 / 240)));
    const h = dt / Math.max(1, steps);
    for (let n = 0; n < steps; n++) for (const r of riders) step(r, h);
    for (const r of riders) pose(r);
  }

  // Start on the deck about to drop in, and run a few seconds before anyone looks — shot mode ticks
  // once and freezes, and a screenshot of a skatepark should have someone on the ramp.
  rider.stall = {
    kind: 'rest', side: side0, t: 0.35, turn: 0, up: 0.35, hold: rng.range(0.2, 1.2), back: 0.34,
    reach: DECK_IN, planned: false,
  };
  update(0);
  for (let k = 0; k < 60 * 3; k++) update(1 / 60);

  const entryObjects = riders.map((r) => ({
    object: r.holder, x: park.x, z: park.z, rand: hash01(park.x, park.z),
  }));

  return { group, riders, entryObjects, park, update, U, V };
}

/** A skateboard along +X: deck with kicked nose and tail, two trucks, four wheels. */
function buildBoard() {
  const parts = [];
  const box = (w, h, d, x, y, z, col, roll = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (roll) geo.rotateZ(roll);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };
  const deck = PALETTE.skateDeck;
  box(1.5, 0.07, 0.52, 0, 0.22, 0, deck);
  for (const s of [-1, 1]) {
    box(0.26, 0.07, 0.5, s * 0.86, 0.255, 0, deck, s * 0.38);
    box(0.12, 0.07, 0.4, s * TRUCK, 0.155, 0, PALETTE.skateTruck);
    for (const z of [-0.2, 0.2]) box(0.14, 0.14, 0.1, s * TRUCK, 0.07, z, PALETTE.skateWheel);
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}
