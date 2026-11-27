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

// The riders on the skatepark (city/skatepark.js): a crew of two or three taking turns on it — see
// "The session" below for the turn-taking, the coping grinds and sparks, the bails and the deeper
// knees. Whoever is up rides as the solo rider always did: one person using the whole park,
// carving across from the funbox lane to the rail's on the quarter pipes, and putting something
// different down at each end. `?skaters=classic` is that solo rider alone, before the session;
// `?skater=classic` is the first cut (game/skatersclassic.js): one or two riders, each fixed to a
// lane, airs and kickturns only.
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

// --- The session (the default since `?skaters=classic`) ----------------------------
//
// **A crew taking turns.** Two or three riders, one on the ramp at a time — which is how a mini
// ramp is actually skated, and what keeps them out of each other's way by construction. The rest
// wait on the decks out past the lanes with their boards stood on the tail, watching, and throw an
// arm up when someone lands something. A turn ends in a rest on the deck: the rider steps off,
// kicks the board up into a hand and walks to a free spot; the next one lays theirs down and drops
// in. Each rider has a style of their own (`makeStyle`) — how low they ride, how deep they load a
// pop, how long a turn lasts, which tricks they like — so the session never settles into a loop.
//
// The spot is out past the lanes (`WAIT_OUT` in from the slab's side) and back from the coping
// (`WAIT_IN`): a lane is a quarter of the slab's width off the middle, so on the narrowest park
// (6.4) the waiting figure's shoulder clears a rider stalled in the near lane by about a tenth.
const WAIT_IN = 0.55;
const WAIT_OUT = 0.75;
const WALK_SPEED = 1.15;
/** The board stood on its tail beside a waiting figure, in the figure's frame (x out its side). */
const BOARD_STAND_X = 0.68;
/** ...and carried against the hip while walking, so it stays over the deck whichever way they face. */
const BOARD_CARRY_X = 0.42;
const BOARD_STAND_Z = -0.12;
/** How long a waiter holds an arm up after a landing, and the chance one does. */
const CHEER_TIME = 0.9;
const CHEER_CHANCE = 0.45;

// **Grinds that throw sparks.** Steel trucks on the steel rail and along the coping: a 50-50, a
// 5-0 (back truck, nose up) and a nosegrind on the rail; a 50-50 along the coping from one lane
// to the other, which is the mini ramp's signature trick. Sparks go through the taxi's own pool
// (game/sparks.js) at a fraction of its throw — a few at a time, falling short — so a grind costs
// no draw call of its own. A boardslide is wood on the rail and throws none.
const SPARK_EVERY = [0.025, 0.06];
const SPARK_REACH = 0.3;
const SPARK_LIFT = 0.45;
/** Along the coping: how fast, and the pop up onto it and back in. */
const COPING_SPEED = [2.4, 3.2];
const COPING_ON = 0.22;
const COPING_OFF = 0.32;
/** The coping's top over the floor, which is what the axles sit on. Half-sunk in the lip. */
const COPING_TOP = 0.08;

// **Bails.** Now and then a kickflip or a shove-it over the funbox does not come back under the
// feet. The rider lands running, the board carries on up the transition on its own and rolls back
// down, and the rider traps it with a foot and hops back on — or walks over to it if it stopped
// short. The board alone is the same pendulum on the same surface, with rolling friction.
const BAIL_FRICTION = 1.1;
const RUNOUT_DECEL = 6.5;
const TRAP_REACH = 0.55;

// **Knees.** Deeper on every beat than the solo rider's: a pop is loaded lower and for longer
// (`POP_LOAD`, `POP_WINDOW`) and leaves with the legs snapping straight (`POP_SNAP`), and every
// landing sinks further (`LAND_SINK`). At play zoom a 0.1 crouch is under a pixel; these are sized
// to be seen.
const POP_LOAD = 0.46;
const POP_WINDOW = 0.3;
const POP_SNAP = 4.2;
const LAND_SINK = 4.4;

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
 * One rider's way of riding, for the session: everything a crew member does differently from the
 * next. Drawn once per rider, so a turn by one looks like that person and not like a reshuffle.
 */
function makeStyle(rng, base) {
  const T = {
    ...base,
    crouch: base.crouch + rng.range(-0.04, 0.08),
    load: base.load * rng.range(1.2, 1.6),
    unload: base.unload * rng.range(1.0, 1.4),
    deep: base.deep + rng.range(0, 0.1),
    hinge: base.hinge + rng.range(-0.06, 0.1),
    spread: base.spread + rng.range(-0.1, 0.15),
  };
  return {
    T,
    /** How deep a pop is loaded, on top of `POP_LOAD`. */
    pop: rng.range(-0.06, 0.1),
    /** Passes in a turn. */
    passes: [rng.int(4, 6), rng.int(8, 12)],
    /** Which tricks this one reaches for: weights multiplied in where the tables are drawn. */
    likes: {
      air: rng.range(0.6, 1.6), flip: rng.range(0.5, 1.6), air360: rng.range(0.4, 1.4),
      coping: rng.range(0.8, 1.8), rock: rng.range(0.6, 1.4), deck180: rng.range(0.6, 1.3),
      kickflip: rng.range(0.6, 1.6), manual: rng.range(0.6, 1.5), grind: rng.range(0.8, 1.6),
    },
    /** The chance a flip trick over the funbox does not come back under the feet. */
    bail: rng.range(0.12, 0.26),
    /** Off-board idling, so two waiters never sway together. */
    phase: rng.range(0, TAU),
  };
}

/** A table with this rider's likes multiplied in. */
function liked(style, table) {
  if (!style) return table;
  return table.map(([n, w]) => {
    const like = style.likes[n] ?? (n === 'shuv' ? style.likes.kickflip
      : n === 'nosemanual' ? style.likes.manual
        : n === '5050' || n === '50' || n === 'nosegrind' || n === 'boardslide' ? style.likes.grind : 1);
    return [n, w * like];
  });
}

/**
 * @param park  the plan from city/skatepark.js, or null — a quiet no-op, as the hoopers are.
 * @param options.deep    the session: a crew, coping grinds, sparks, bails and deeper knees.
 *                        Off is `?skaters=classic`, the one rider before it.
 * @param options.sparks  the shared spark pool (game/sparks.js), or null headless.
 */
export function createSkaters(scene, rng, park, { stiff = false, push = true, deep = false, sparks = null } = {}) {
  const BASE = stiff ? STIFF : LOOSE;
  const group = new THREE.Group();
  group.name = 'skaters';
  if (!park) return { group, riders: [], entryObjects: [], update: () => {} };
  scene.add(group);

  const lanes = park.lanes;
  const laneOf = (feature) => lanes.find((l) => l.feature === feature);

  /** The figure and the board, in the hierarchy every mode poses. */
  function buildRig({ body, legs, hair, deck }) {
    const person = createPerson({ body, legs, hair, pickable: null });
    // holder — on the surface, in the board's frame
    //   tiltPivot — at one truck, for lifting the other end (a kickturn, a manual, an ollie's pop)
    //     tiltInner
    //       boardPivot — the board's own flips and shove-its
    //       stance — the figure, through `bodyRoot`, which the session takes off the board
    const holder = new THREE.Group();
    const tiltPivot = new THREE.Group();
    const tiltInner = new THREE.Group();
    const boardPivot = new THREE.Group();
    boardPivot.position.y = BOARD_PIVOT_Y;
    const board = new THREE.Mesh(buildBoard(deck), propMaterial());
    board.castShadow = true;
    board.position.y = -BOARD_PIVOT_Y;
    boardPivot.add(board);
    const stance = new THREE.Group();
    stance.position.y = DECK_TOP;
    const bodyRoot = new THREE.Group();
    bodyRoot.add(person.group);
    stance.add(bodyRoot);
    tiltInner.add(boardPivot, stance);
    tiltPivot.add(tiltInner);
    holder.add(tiltPivot);
    group.add(holder);
    return { person, holder, tiltPivot, tiltInner, boardPivot, board, stance, bodyRoot };
  }

  function makeRider(rig, { lane, u, psi, mode, t, passes, dir, style }) {
    return {
      ...rig,
      style,
      T: style ? style.T : BASE,
      lane, v: lane.v,
      u, s: 0, E: G * LIP_H,
      psi,
      mode,
      stall: null,
      air: null, hop: null, grind: null, coping: null,
      spin: null,
      end: null, lastEnd: null,
      mid: null, midDone: false,
      carve: null,
      passes,
      t,
      dir,
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
      // The session: off the board (`foot`), where this one waits, and the spark clock.
      foot: null,
      spot: null,
      go: false,
      waitedSince: 0,
      cheer: 0,
      sparkIn: 0,
      bailNext: false,
    };
  }

  const riders = [];
  if (!deep) {
    // The solo rider, drawn in the order it always was so `?skaters=classic` rides the same runs.
    const rig = buildRig({
      body: rng.chance(0.5) ? PALETTE.skaterA : PALETTE.skaterB, legs: PALETTE.skaterPants,
      hair: rng.pick(['#2E2520', '#6B4A33', '#B8863B']), deck: PALETTE.skateDeck,
    });
    const side0 = rng.chance(0.5) ? 1 : -1;
    riders.push(makeRider(rig, {
      lane: laneOf('box'), u: side0 * (park.lipU + DECK_IN), psi: side0 > 0 ? Math.PI : 0,
      mode: 'stall', passes: rng.int(PASSES[0], PASSES[1]), t: rng.next() * 10, dir: -side0,
    }));
  } else {
    const n = rng.chance(0.6) ? 3 : 2;
    const tops = [PALETTE.skaterA, PALETTE.skaterB, PALETTE.skaterC];
    const decks = [PALETTE.skateDeck, PALETTE.skateDeckB, PALETTE.skateDeckC];
    const hairs = ['#2E2520', '#6B4A33', '#B8863B', '#1E1B19'];
    const order = [0, 1, 2].sort(() => rng.next() - 0.5);
    for (let i = 0; i < n; i++) {
      const style = makeStyle(rng, BASE);
      const rig = buildRig({
        body: tops[order[i]], legs: rng.chance(0.5) ? PALETTE.skaterPants : PALETTE.skaterPantsB,
        hair: rng.pick(hairs), deck: decks[order[(i + 1) % 3]],
      });
      const side = rng.chance(0.5) ? 1 : -1;
      riders.push(makeRider(rig, {
        lane: rng.pick(lanes), u: side * (park.lipU + DECK_IN), psi: side > 0 ? Math.PI : 0,
        mode: 'stall', t: rng.next() * 10, passes: rng.int(style.passes[0], style.passes[1]), dir: -side,
        style,
      }));
    }
  }
  const rider = riders[0];

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
  function orient(r, a, psi) {
    tangent.copy(U).multiplyScalar(Math.cos(a)).addScaledVector(Y, Math.sin(a));
    normal.copy(U).multiplyScalar(-Math.sin(a)).addScaledVector(Y, Math.cos(a));
    across.crossVectors(normal, tangent);
    fwd.copy(tangent).multiplyScalar(Math.cos(psi)).addScaledVector(across, Math.sin(psi));
    face.crossVectors(fwd, normal);
    basis.makeBasis(fwd, normal, face);
    r.holder.quaternion.setFromRotationMatrix(basis);
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
      r.end = weighted(rng, liked(r.style, [['air', 0.35], ['flip', 0.2], ['air360', 0.2], ['deck180', 0.25]]),
        r.lastEnd);
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
      // The session ends a turn on the deck and hands over; alone, the rider rests there.
      end = deep ? 'handover' : 'rest';
    } else if (push && !fakie && toeSideAway(r) && rng.chance(PUSH_SHARE)) {
      // A lazy kickturn low on the transition, to come back slow enough to push.
      end = 'kick';
      r.pushNext = true;
    } else {
      // Fakie, the rider leans toward the tricks that bring them back round: a rock or a 360.
      end = weighted(rng, liked(r.style, fakie
        ? [['kick', 0.3], ['rock', 0.4], ['air360', 0.3]]
        : [['kick', deep ? 0.22 : 0.3], ['air', 0.22], ['flip', 0.12], ['air360', 0.1], ['rock', 0.12],
          ['deck180', 0.14],
          // Along the coping to the other lane: only from a lane, and only in the session.
          ['coping', deep && r.lane !== PUSH_LANE ? 0.2 : 0]]),
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
    let next = r.pushNext ? PUSH_LANE
      : r.lane === PUSH_LANE ? rng.pick(lanes)
        : rng.chance(SWITCH_LANE) ? lanes.find((l) => l !== r.lane) : r.lane;
    // Heading for the coping, stay in the lane: the grind itself is the lane change.
    if (r.end === 'coping' && r.lane !== PUSH_LANE) next = r.lane;
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
    r.mid = !deep ? (next.feature === 'rail'
      ? weighted(rng, [['5050', 0.55], ['boardslide', 0.45]])
      : weighted(rng, [['ollie', 0.3], ['kickflip', 0.25], ['shuv', 0.15], ['manual', 0.3]]))
      : next.feature === 'rail'
        ? weighted(rng, liked(r.style, [['5050', 0.35], ['50', 0.22], ['nosegrind', 0.15], ['boardslide', 0.28]]))
        : weighted(rng, liked(r.style,
          [['ollie', 0.2], ['kickflip', 0.24], ['shuv', 0.14], ['manual', 0.26], ['nosemanual', 0.16]]));
    r.midDone = false;
  }

  /** How much transition path a pass out to `end` covers, there and back. */
  function outAndBack(r, end) {
    if (end === 'kick') {
      // The peak `pump` drew: a push's set-up kickturn turns well short of the others.
      const peak = r.peak ?? LIP_H - (KICK_SHORT[0] + KICK_SHORT[1]) / 2;
      return 2 * Math.sqrt(TRANS_R * TRANS_R - (TRANS_R - peak) ** 2);
    }
    return 2 * TRANS_RUN
      + (end === 'air' || end === 'flip' || end === 'air360' || end === 'coping' ? 0 : 2 * DECK_IN);
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
    // The legs drive the board off the lip: the crouch loaded on the way up snaps straight.
    if (deep) r.crouch.v -= 0.7 * POP_SNAP;
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
      r.crouch.v += deep ? LAND_SINK : 2.6;
      r.air = null;
      landed(r, air.kind === 'air' ? 0.6 : 1);
    }
  }

  /** Up onto the deck for a rock, a 180 or a rest, and back in. */
  function startStall(r, kind) {
    const side = Math.sign(r.u) || 1;
    r.u = side * park.lipU;
    r.mode = 'stall';
    const turn = kind === 'rock' || kind === 'handover' ? 0
      // After a rest the rider drops in facing forward: a fakie arrival needs no turn to get there.
      : kind === 'rest' && travel(r) < 0 ? 0 : (rng.chance(0.5) ? 1 : -1) * Math.PI;
    const up = kind === 'rock' ? 0.28 : 0.35;
    r.stall = {
      kind, side, t: 0, turn,
      up,
      // A handover holds until the rider steps off: `stepStall` hands it to the session.
      hold: kind === 'rock' ? 0.22 : kind === 'rest' ? 0.55 + rng.range(REST[0], REST[1])
        : kind === 'handover' ? Infinity : 0.6,
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
      if (st.kind === 'handover') {
        holdHandover(r, st, h);
        return;
      }
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
        if (st.kind === 'drop') r.passes = rng.int(r.style.passes[0], r.style.passes[1]);
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
    r.crouch.v -= deep ? POP_SNAP : 3.2;
    // A flip trick that will not come back under the feet: decided at the pop, so the air can
    // already look wrong.
    r.bailNext = deep && then === 'ride' && (trick === 'kickflip' || trick === 'shuv') && rng.chance(r.style.bail);
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
    // A bail's board is late — still turning as it comes down — and the rider has jumped clear of
    // it (`sep`, in `pose`): the two never meet again, which is the whole story of a missed flip.
    const done = r.bailNext ? 1 : 0.8;
    if (hop.trick === 'kickflip') r.flip = TAU * ease(clamp(k / done, 0, 1));
    if (hop.trick === 'shuv') r.shuv = Math.PI * ease(clamp(k / done, 0, 1));
    r.sep = r.bailNext ? 0.4 * hump(k) + 0.15 * k : 0;
    if (hop.trick === 'boardslide') r.slide = hop.slideBy * ease(k);
    if (hop.trick === 'slideOff') r.slide = hop.slideFrom * (1 - ease(k));
    if (hop.t < hop.T) return;
    r.flip = 0;
    r.shuv = 0;
    r.crouch.v += deep ? LAND_SINK : 2.4;
    if (r.bailNext) {
      r.bailNext = false;
      r.hop = null;
      startBail(r, Math.sign(hop.u1 - hop.u0));
      return;
    }
    if (hop.then === 'ride') landed(r, 1);
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

  // --- The coping grind ------------------------------------------------------------

  /** At the lip heading out: pop the back truck onto the coping and turn the board along it. */
  function startCoping(r) {
    const side = Math.sign(r.u) || 1;
    const lane = lanes.find((l) => l !== r.lane);
    r.coping = {
      side, t: 0, phase: 'on', lane, from: r.v, to: lane.v,
      speed: rng.range(COPING_SPEED[0], COPING_SPEED[1]),
      y0: restingY(r), y: restingY(r), psi0: r.psi,
      turn: (rng.chance(0.5) ? 1 : -1) * Math.PI / 2, offTurn: 0, psiG: 0,
    };
    r.u = side * park.lipU;
    r.mode = 'coping';
    r.s = 0;
    r.end = null;
    r.carve = null;
    r.spin = null;
    r.crouch.v -= 0.5 * POP_SNAP;
  }

  /** The axles' height on the coping, as the board's origin. */
  const COPING_Y = LIP_H + COPING_TOP - AXLE_Y;

  function stepCoping(r, h) {
    const c = r.coping;
    c.t += h;
    if (c.phase === 'on') {
      const k = Math.min(1, c.t / COPING_ON);
      r.psi = c.psi0 + c.turn * ease(k);
      c.y = lerp(c.y0, COPING_Y, ease(k)) + 0.12 * hump(k);
      if (k >= 1) { c.phase = 'grind'; c.t = 0; r.crouch.v += 0.6 * LAND_SINK; }
    } else if (c.phase === 'grind') {
      const dv = c.to - r.v;
      const step = c.speed * h;
      c.speed = Math.max(1.4, c.speed - 0.5 * h);
      c.y = COPING_Y;
      if (Math.abs(dv) <= step) {
        r.v = c.to;
        c.phase = 'off';
        c.t = 0;
        c.psiG = r.psi;
        // On round the same way and the board comes off nose first; back the way it came, fakie.
        c.offTurn = rng.chance(0.7) ? c.turn : -c.turn;
      } else {
        r.v += Math.sign(dv) * step;
      }
    } else {
      const k = Math.min(1, c.t / COPING_OFF);
      r.psi = c.psiG + c.offTurn * ease(k);
      c.y = lerp(COPING_Y, LIP_H - 0.05, ease(k)) + 0.08 * hump(k);
      if (k >= 1) {
        r.psi = norm(r.psi);
        r.lane = c.lane;
        r.mode = 'ride';
        r.u = c.side * (park.lipU - 0.03);
        r.s = -c.side * 2.0;
        r.dir = travel(r);
        planPass(r, TRANS_RUN);
        r.E = 0.5 * r.s * r.s + G * surf(r, r.u).h;
        r.coping = null;
        r.crouch.v += LAND_SINK;
        landed(r, 0.8);
      }
    }
  }

  // --- The session: off the board -----------------------------------------------------

  let clock = 0;
  let idleFor = 0;
  /** Where one waits: a deck, and which side of the middle. */
  const spotFor = (side, sign) => ({ side, v: sign * (park.wid / 2 - WAIT_OUT) });
  const deckY = SKATE_TOP_Y + LIP_H;
  const worldAt = (u, v, y, out = new THREE.Vector3()) => {
    const w = park.toWorld(u, v);
    return out.set(w.x, y, w.z);
  };
  /** The yaw that faces a figure (local +Z) along park +u times `sign`. */
  const yawAlongU = (sign) => Math.atan2(sign * park.U.x, sign * park.U.z);
  /** The park's u of a world point. */
  const uOf = (p) => (p.x - park.x) * park.U.x + (p.z - park.z) * park.U.z;

  /** Someone landed something: the ones waiting may throw an arm up. */
  function landed(r, strength) {
    if (!deep) return;
    for (const q of riders) {
      if (q === r || q.mode !== 'foot' || q.foot.phase !== 'wait' || q.cheer > 0) continue;
      if (rng.chance(CHEER_CHANCE * strength)) q.cheer = CHEER_TIME;
    }
  }

  /** On the ramp, or about to be, or picking themselves up: anything but waiting a turn. */
  const busy = (q) => q.go || q.mode !== 'foot'
    || ['runout', 'stand', 'walkboard', 'mount', 'stepon'].includes(q.foot.phase);

  /** Which side of a figure facing `yaw` points away from the middle of the park, for the board. */
  function outwardSide(yaw, v) {
    // A figure's +X in the world is (cos yaw, 0, −sin yaw).
    const along = Math.cos(yaw) * park.V.x - Math.sin(yaw) * park.V.z;
    return Math.sign(along * v) || 1;
  }

  function startWaiting(r, spot) {
    r.spot = spot;
    const faceYaw = yawAlongU(-spot.side);
    r.foot = {
      phase: 'wait', t: 0, pos: worldAt(spot.side * (park.lipU + WAIT_IN), spot.v, deckY),
      yaw: faceYaw, faceYaw, look: 0, board: 'carry', side: outwardSide(faceYaw, spot.v), loose: false,
      cadence: 0,
    };
    r.mode = 'foot';
    r.waitedSince = clock;
    r.cheer = 0;
    r.go = false;
  }

  /** The board out from under the rider, and the figure loose in the world. */
  function detach(r) {
    r.holder.updateMatrixWorld(true);
    group.attach(r.bodyRoot);
    const pos = new THREE.Vector3();
    r.bodyRoot.getWorldPosition(pos);
    return pos;
  }

  function attach(r) {
    r.stance.add(r.bodyRoot);
    r.bodyRoot.position.set(0, 0, 0);
    r.bodyRoot.quaternion.identity();
    r.person.rest();
  }

  /** The turn's last rest on the deck: hand over, and step off once the next one is clear. */
  function holdHandover(r, st, h) {
    if (!st.asked) {
      st.asked = true;
      // Whatever lane change was in hand ends here, wherever it had got to.
      r.carve = null;
      st.wait = 0;
      const sign = Math.sign(r.v) || (rng.chance(0.5) ? 1 : -1);
      st.spot = spotFor(st.side, sign);
      // Whoever is standing on the spot this rider is walking to goes first: they drop in from it
      // and are on the far deck before anyone gets there.
      st.waitFor = riders.find((q) => q !== r && q.spot && q.spot.side === st.side
        && Math.sign(q.spot.v) === sign) ?? null;
      if (st.waitFor) st.waitFor.go = true;
    }
    st.wait += h;
    if (st.wait < 0.45) return;
    if (st.waitFor && (st.waitFor.mode === 'foot' || st.waitFor.mode === 'stall')) return;
    stepOff(r, st.spot);
  }

  function stepOff(r, spot) {
    const from = detach(r);
    const sideDir = Math.sign(spot.v - r.v) || 1;
    const start = worldAt(r.u, r.v + sideDir * 0.55, deckY);
    const faceYaw = yawAlongU(-spot.side);
    const target = worldAt(spot.side * (park.lipU + WAIT_IN), spot.v, deckY);
    r.spot = spot;
    r.stall = null;
    r.mode = 'foot';
    r.foot = {
      phase: 'stepoff', t: 0, from, to: start, pos: start.clone(), target, after: 'turn',
      yaw: Math.atan2(target.x - start.x, target.z - start.z), faceYaw, look: 0,
      board: 'blend', blendFrom: null, side: outwardSide(faceYaw, spot.v), loose: false, cadence: 0,
    };
  }

  /** A waiter's turn: lay the board down on the deck, hop on, drop in. */
  function beginStepOn(r) {
    const f = r.foot;
    const side = r.spot.side;
    r.go = false;
    r.carve = null;
    r.lane = rng.pick(lanes);
    r.u = side * (park.lipU + DECK_IN);
    r.v = r.spot.v;
    r.psi = side > 0 ? Math.PI : 0;
    r.pitch.x = 0;
    r.pitch.v = 0;
    r.pOff.x = 0;
    r.pOff.v = 0;
    r.lastHull = null;
    r.s = 0;
    r.tilt.x = 0;
    r.yaw.x = 0;
    r.slide = 0;
    f.phase = 'stepon';
    f.t = 0;
    f.board = 'blend';
    f.blendFrom = null;
    f.toGround = true;
    f.from = f.pos.clone();
  }

  function finishStepOn(r) {
    attach(r);
    const side = r.spot.side;
    r.spot = null;
    r.foot = null;
    r.mode = 'stall';
    r.end = null;
    r.carve = null;
    r.push = null;
    r.stall = {
      kind: 'drop', side, t: 0.35, turn: 0, up: 0.35, hold: rng.range(0.3, 0.8), back: 0.34,
      reach: DECK_IN, planned: false,
    };
    r.crouch.x = 0.05;
  }

  // --- Bails ------------------------------------------------------------------------

  function startBail(r, dirU) {
    const from = detach(r);
    from.y = SKATE_TOP_Y;
    r.mode = 'foot';
    r.sep = 0;
    r.slide = 0;
    r.tilt.x = 0;
    r.carve = null;
    r.push = null;
    r.end = null;
    // The board carries on alone, a little faster for the kick the feet gave it on the way off.
    r.s = dirU * Math.max(3.4, Math.abs(r.s));
    r.foot = {
      phase: 'runout', t: 0, pos: from, yaw: yawAlongU(dirU), dirU, run: Math.min(3, Math.abs(r.s) * 0.65),
      board: 'ground', loose: true, cadence: 0, side: 1,
    };
  }

  /** The board on its own: the lane's pendulum, with rolling friction and nobody pumping it. */
  function stepLoose(r, h) {
    const { slope } = surf(r, r.u);
    const a = Math.atan(slope);
    r.u += r.s * Math.cos(a) * h;
    r.s -= G * Math.sin(a) * h;
    r.s -= Math.sign(r.s) * Math.min(Math.abs(r.s), BAIL_FRICTION * h);
    if (Math.abs(r.u) > park.lipU - 0.1) {
      r.u = Math.sign(r.u) * (park.lipU - 0.1);
      r.s = -0.3 * r.s;
    }
    if (Math.abs(r.u) < park.transU && Math.abs(slope) < 1e-3 && Math.abs(r.s) < 0.12) {
      r.s = 0;
      r.foot.loose = false;
    }
  }

  /** Back on: roll toward the near end, push once or twice, and kick round low for a push home. */
  function finishMount(r) {
    attach(r);
    r.foot = null;
    r.mode = 'ride';
    const out = Math.sign(r.u) || 1;
    r.s = out * 0.8;
    r.E = 0.5 * r.s * r.s;
    r.dir = travel(r);
    r.end = 'kick';
    r.pushNext = true;
    r.peak = rng.range(PUSH_SETUP_PEAK[0], PUSH_SETUP_PEAK[1]);
    r.mid = null;
    r.midDone = true;
    r.carve = null;
    r.push = push ? {
      phase: 'wait', E1: G * r.peak, base: r.E, dE: 0, n: 0, kick: 0, t: 0, plantU: 0,
      foot: new THREE.Vector3(), deck: 1, w: 0, out: true,
    } : null;
    if (!push) r.E = G * r.peak;
    r.crouch.x = 0.1;
  }

  function stepFoot(r, h) {
    const f = r.foot;
    f.t += h;
    if (f.loose) stepLoose(r, h);
    if (f.phase === 'wait') {
      r.cheer = Math.max(0, r.cheer - h);
      if (r.go) beginStepOn(r);
    } else if (f.phase === 'stepon') {
      if (f.t >= 0.6) finishStepOn(r);
    } else if (f.phase === 'stepoff') {
      if (f.t >= 0.32) { f.phase = 'walk'; f.t = 0; f.board = 'carry'; }
    } else if (f.phase === 'walk' || f.phase === 'walkboard') {
      const dx = f.target.x - f.pos.x;
      const dz = f.target.z - f.pos.z;
      const d = Math.hypot(dx, dz);
      const step = WALK_SPEED * h;
      f.cadence += h * 7.5;
      if (d <= step) {
        f.pos.x = f.target.x;
        f.pos.z = f.target.z;
        f.phase = f.after;
        f.t = 0;
        f.yaw0 = f.yaw;
        f.from = f.pos.clone();
        f.fromYaw = f.yaw;
      } else {
        f.pos.x += (dx / d) * step;
        f.pos.z += (dz / d) * step;
        f.yaw = Math.atan2(dx, dz);
      }
    } else if (f.phase === 'turn') {
      const k = Math.min(1, f.t / 0.4);
      let d = norm(f.faceYaw - f.yaw0);
      if (d > Math.PI) d -= TAU;
      f.yaw = f.yaw0 + d * ease(k);
      if (k >= 1) {
        f.phase = 'wait';
        f.t = 0;
        r.waitedSince = clock;
      }
    } else if (f.phase === 'runout' || f.phase === 'stand') {
      if (f.phase === 'runout') {
        f.run = Math.max(0, f.run - RUNOUT_DECEL * h);
        f.cadence += h * (4 + 4 * f.run);
        const u = uOf(f.pos);
        const lim = park.transU - 0.2;
        if (f.dirU * u < lim) {
          f.pos.x += park.U.x * f.dirU * f.run * h;
          f.pos.z += park.U.z * f.dirU * f.run * h;
        } else f.run = 0;
        if (f.run <= 0) { f.phase = 'stand'; f.t = 0; }
      }
      // Trap it with a foot as it comes back past, or walk to it once it has stopped.
      const ru = uOf(f.pos);
      const gap = r.u - ru;
      if (f.loose && Math.abs(gap) < TRAP_REACH && Math.sign(r.s) === -Math.sign(gap) && f.t > 0.3) {
        r.s = 0;
        f.loose = false;
        r.u = ru + Math.sign(gap || 1) * 0.45;
        f.phase = 'mount';
        f.t = 0;
        f.from = f.pos.clone();
        f.fromYaw = f.yaw;
      } else if (!f.loose && f.phase === 'stand' && f.t > 0.9) {
        const near = Math.sign(ru - r.u) || 1;
        f.target = worldAt(r.u + near * 0.45, r.v, SKATE_TOP_Y);
        f.phase = 'walkboard';
        f.after = 'mount';
        f.t = 0;
      }
    } else if (f.phase === 'mount') {
      if (f.t >= 0.3) finishMount(r);
    }
  }

  /** Every frame, the session's own bookkeeping: if nobody is up, the longest waiter goes. */
  function stepSession(dt) {
    clock += dt;
    if (!deep) return;
    if (riders.some(busy)) { idleFor = 0; return; }
    idleFor += dt;
    if (idleFor < 0.7) return;
    const next = riders.filter((q) => q.mode === 'foot' && q.foot.phase === 'wait')
      .sort((a, b) => a.waitedSince - b.waitedSince)[0];
    if (next) next.go = true;
    idleFor = 0;
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
      // A restart after a bail pushes off *toward* the near end — it has nowhere else to go.
      if (r.spin || (heading > 0 && !p.out)) return;
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
      else if (r.end === 'deck180' || r.end === 'rest' || r.end === 'handover') startStall(r, r.end);
      else if (r.end === 'coping') startCoping(r);
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
    const T = r.T;
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

    // A board lying on the concrete with nobody on it rests the same way — a bail's runaway, or
    // the one stopped where it rolled to.
    const onFoot = r.mode === 'foot';
    const resting = r.mode === 'ride' || r.mode === 'stall' || (onFoot && r.foot.board === 'ground');
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
      const manual = r.mid === 'manual' || r.mid === 'nosemanual';
      if (r.mode === 'ride' && r.lane.feature === 'box' && manual
        && Math.abs(r.u) < BOX_TOP_HALF + 0.25) {
        // On the back wheels with the weight over the tail, or on the front with it over the nose.
        const nose = r.mid === 'nosemanual';
        tiltTo = nose ? 0.22 : 0.28;
        tiltLead = nose ? -dir : dir;
        leanTo = (nose ? 0.24 : -0.2) * dir;
        spreadTo = T.wide;
        if (deep) crouchTo = T.deep;
      }
      // Loading up for a pop, a stride before it. The session loads deeper and earlier, and
      // loads for the lip too: an air is legs driving up off the coping, not a ramp throwing a
      // passenger.
      const popWindow = deep ? POP_WINDOW : 0.22;
      const loadBy = deep ? POP_LOAD + r.style.pop : 0.3;
      if (r.mode === 'ride' && !r.midDone && Math.abs(r.s) > 0.1 && !manual) {
        const at = r.lane.feature === 'rail' ? RAIL_HALF + railRun() : BOX_TOP_HALF;
        const toGo = (Math.abs(r.u) - at) / Math.abs(r.s);
        if (toGo > 0 && toGo < popWindow && Math.sign(r.s) * Math.sign(r.u) < 0 && r.mid !== 'push') crouchTo += loadBy;
      }
      if (deep && r.mode === 'ride' && (r.end === 'air' || r.end === 'flip' || r.end === 'air360'
        || r.end === 'coping') && onTrans && Math.sign(r.s) * Math.sign(r.u) > 0) {
        const toLip = (park.lipU - Math.abs(r.u)) / Math.max(0.5, Math.abs(r.s));
        if (toLip < 0.24) crouchTo += 0.6 * loadBy;
      }
      if (r.mode === 'stall') {
        const st = r.stall;
        const holding = st.t > st.up && st.t < st.up + st.hold;
        if ((st.kind === 'rest' || st.kind === 'handover') && holding) {
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
      // A 5-0 rides the back truck with the nose up, a nosegrind the front with the tail up; the
      // weight goes over whichever truck is on the rail.
      if (r.mid === '50' || r.mid === 'nosegrind') {
        const nose = r.mid === 'nosegrind';
        tiltTo = 0.2;
        tiltLead = nose ? -dir : dir;
        leanTo += (nose ? 0.22 : -0.16) * dir;
      }
    } else if (r.mode === 'coping') {
      const c = r.coping;
      const lipAngle = Math.asin(TRANS_RUN / TRANS_R);
      pitchTo = c.phase === 'off' ? c.side * lipAngle * ease(clamp(c.t / COPING_OFF, 0, 1)) : 0;
      pitchW = 26;
      crouchTo = T.deep * 0.9;
      spreadTo = T.wide;
      leanTo = 0.08 * Math.sin(r.t * 8.3) + 0.05 * Math.sin(r.t * 13.1);
      if (c.phase !== 'grind') {
        const k = c.phase === 'on' ? c.t / COPING_ON : c.t / COPING_OFF;
        tiltTo = 0.3 * hump(k);
      }
    } else if (onFoot) {
      pitchTo = 0;
      crouchTo = 0.05;
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
    else if (r.mode === 'coping') stepCoping(r, h);
    else if (r.mode === 'foot') stepFoot(r, h);
    settle(r, h);
  }

  // --- Posing ----------------------------------------------------------------

  function pose(r, dt) {
    if (r.mode === 'foot') {
      poseFoot(r, dt);
      return;
    }
    const { holder, tiltPivot, tiltInner, boardPivot, person, stance } = r;
    const T = r.T;
    orient(r, r.pitch.x, r.psi + r.yaw.x + r.slide);
    let y;
    if (r.mode === 'air') {
      const air = r.air;
      y = air.y0 + air.vy * air.t - 0.5 * G * air.t * air.t;
    } else if (r.mode === 'hop') {
      y = hopY(r.hop);
    } else if (r.mode === 'grind') {
      y = r.grind.y;
    } else if (r.mode === 'coping') {
      y = r.coping.y;
    } else {
      y = restingY(r);
    }
    const at = park.toWorld(r.u, r.v);
    holder.position.set(at.x, SKATE_TOP_Y + y, at.z);
    // A bail: the rider has jumped clear of a board that is not coming back.
    stance.position.y = DECK_TOP + (r.mode === 'hop' ? r.sep || 0 : 0);

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
    if (sparks && !warming) throwSparks(r, dt);
  }
  const deckFoot = new THREE.Vector3();

  // --- Sparks -------------------------------------------------------------------------

  const contact = new THREE.Vector3();
  /** Steel on steel: the trucks on the rail, or along the coping. */
  function throwSparks(r, dt) {
    let along = null;
    let trucks = null;
    let floorY = SKATE_TOP_Y;
    if (r.mode === 'grind' && r.mid !== 'boardslide') {
      along = Math.sign(r.s) || 1;
      // The truck on the rail: both on a 50-50, the back one on a 5-0, the front on a nosegrind.
      const dir = travel(r);
      trucks = r.mid === '50' ? [-dir] : r.mid === 'nosegrind' ? [dir] : [-1, 1];
      contact.set(park.U.x * along, 0, park.U.z * along);
    } else if (r.mode === 'coping' && r.coping.phase === 'grind') {
      along = Math.sign(r.coping.to - r.coping.from) || 1;
      trucks = [-1, 1];
      floorY = deckY;
      contact.set(park.V.x * along, 0, park.V.z * along);
    } else {
      r.sparkIn = 0;
      return;
    }
    r.sparkIn -= dt;
    if (r.sparkIn > 0) return;
    r.sparkIn = rng.range(SPARK_EVERY[0], SPARK_EVERY[1]);
    // `burst` takes a sim heading — forward is (cos yaw, −sin yaw) — and throws backwards off it.
    const yaw = Math.atan2(-contact.z, contact.x);
    r.holder.updateMatrixWorld(true);
    const P = new THREE.Vector3();
    for (const t of trucks) {
      r.board.localToWorld(P.set(t * TRUCK, AXLE_Y - 0.06, 0));
      sparks.burst(P.x, P.y, P.z, yaw, 1, 0, { reach: SPARK_REACH, lift: SPARK_LIFT, floor: floorY });
    }
  }

  // --- Posing off the board --------------------------------------------------------------

  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const carryQuat = [new THREE.Quaternion(), new THREE.Quaternion()];
  carryQuat[0].setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
  carryQuat[1].setFromEuler(new THREE.Euler(0, Math.PI, 0)).multiply(carryQuat[0]);
  const bodyQuat = new THREE.Quaternion();
  const Yaxis = new THREE.Vector3(0, 1, 0);

  /** The board lying on the concrete at the rider's u, v and psi. */
  function poseBoardGround(r) {
    orient(r, r.pitch.x, r.psi);
    const at = park.toWorld(r.u, r.v);
    r.holder.position.set(at.x, SKATE_TOP_Y + restingY(r), at.z);
    r.tiltPivot.rotation.z = 0;
    r.boardPivot.rotation.set(0, 0, 0);
  }

  /** The board stood on its tail at the figure's side (or carried just off the floor). */
  function boardCarry(r, lift, outPos, outQuat) {
    const f = r.foot;
    const side = f.side || 1;
    r.bodyRoot.updateMatrixWorld(true);
    const out = f.phase === 'wait' || f.phase === 'stepon' ? BOARD_STAND_X
      : f.phase === 'turn' ? lerp(BOARD_CARRY_X, BOARD_STAND_X, ease(clamp(f.t / 0.4, 0, 1))) : BOARD_CARRY_X;
    outPos.set(side * out, 0.99 + lift, BOARD_STAND_Z).applyMatrix4(r.bodyRoot.matrixWorld);
    outQuat.copy(r.bodyRoot.quaternion).multiply(carryQuat[side > 0 ? 0 : 1]);
  }

  function poseFoot(r) {
    const f = r.foot;
    const { person, bodyRoot, holder } = r;
    const T = r.T;
    let hop = 0;
    let pos = f.pos;
    // Where the body is, for every phase but the two that end on the board.
    if (f.phase === 'stepoff') {
      const k = clamp(f.t / 0.32, 0, 1);
      pos = tmpPos.lerpVectors(f.from, f.to, ease(k));
      hop = 0.35 * hump(k);
    }
    const toBoard = f.phase === 'stepon' || f.phase === 'mount';
    if (!toBoard) {
      bodyRoot.position.copy(pos);
      bodyRoot.position.y += hop;
      bodyRoot.quaternion.setFromAxisAngle(Yaxis, f.yaw + (f.look || 0));
    }

    // The board.
    if (f.board === 'ground' || (f.phase === 'stepon' && f.t >= 0.28)) {
      poseBoardGround(r);
    } else if (f.board === 'carry') {
      const lift = f.phase === 'wait' ? 0 : f.phase === 'turn' ? 0.18 * (1 - ease(clamp(f.t / 0.4, 0, 1))) : 0.18;
      boardCarry(r, lift, holder.position, holder.quaternion);
      r.tiltPivot.rotation.z = 0;
      r.boardPivot.rotation.set(0, 0, 0);
    } else {
      // Blending between the deck and the hand: kicked up into it, or laid down out of it.
      const T0 = f.phase === 'stepon' ? 0.28 : 0.32;
      const k = ease(clamp(f.t / T0, 0, 1));
      const lift = f.phase === 'stepon' ? 0 : 0.18;
      boardCarry(r, lift, tmpPos, tmpQuat);
      const gPos = new THREE.Vector3();
      const gQuat = new THREE.Quaternion();
      poseBoardGround(r);
      gPos.copy(holder.position);
      gQuat.copy(holder.quaternion);
      const w = f.phase === 'stepon' ? 1 - k : k;
      holder.position.lerpVectors(gPos, tmpPos, w);
      // Popped up off the tail: a little arc on the way to the hand.
      holder.position.y += 0.25 * hump(k);
      holder.quaternion.copy(gQuat).slerp(tmpQuat, w);
    }

    // The two that end on the board: hop from where they stand to the stance.
    if (toBoard) {
      const T1 = f.phase === 'stepon' ? 0.28 : 0;
      const k = ease(clamp((f.t - T1) / (f.phase === 'stepon' ? 0.32 : 0.3), 0, 1));
      holder.updateMatrixWorld(true);
      r.stance.getWorldPosition(tmpPos);
      r.stance.getWorldQuaternion(tmpQuat);
      bodyRoot.position.lerpVectors(f.from, tmpPos, k);
      bodyRoot.position.y += 0.35 * hump(k);
      bodyQuat.setFromAxisAngle(Yaxis, f.phase === 'mount' ? f.fromYaw : f.yaw);
      bodyRoot.quaternion.copy(bodyQuat).slerp(tmpQuat, k);
    }

    // The figure.
    person.rest();
    if (f.phase === 'wait' || f.phase === 'turn' || (f.phase === 'stepon' && f.t < 0.28)) {
      // Watching whoever is up: the head and shoulders follow them, within reason.
      if (f.phase === 'wait') {
        const up = riders.find((q) => q.mode !== 'foot');
        let want = 0;
        if (up) {
          up.holder.getWorldPosition(tmpPos);
          let d = norm(Math.atan2(tmpPos.x - f.pos.x, tmpPos.z - f.pos.z) - f.faceYaw);
          if (d > Math.PI) d -= TAU;
          want = clamp(d, -0.9, 0.9) * 0.7;
        }
        f.look = lerp(f.look || 0, want, 0.08);
      }
      const cheer = r.cheer > 0 ? hump(1 - r.cheer / CHEER_TIME) : 0;
      person.stand(r.t + clock, { phase: r.style.phase, hold: 1, side: f.side, cheer });
    } else if (f.phase === 'stepoff') {
      person.stand(clock, { phase: r.style.phase, hold: clamp(f.t / 0.32, 0, 1), side: f.side });
    } else if (f.phase === 'walk' || f.phase === 'walkboard') {
      const bob = person.walk(f.cadence, f.phase === 'walk' ? 1 : 0, f.side);
      bodyRoot.position.y += bob;
    } else if (f.phase === 'runout') {
      const bob = person.run(f.cadence);
      bodyRoot.position.y += bob * clamp(f.run / 2, 0.3, 1);
    } else if (f.phase === 'stand') {
      // Hands on the head for a beat, then down.
      const hands = f.t < 1.1 ? hump(clamp(f.t / 1.1, 0, 1)) : 0;
      person.stand(clock, { phase: r.style.phase, hands });
    } else {
      // Stepping on: into the riding crouch the board will hand them.
      person.ride({ drop: T.crouch, spread: T.spread, hinge: T.hinge, elbow: T.elbow, bow: T.bow });
    }
  }

  function update(dt) {
    // Short steps: the transition near the lip is a 72° wall, and a long frame would step a rider
    // straight through the top of it.
    const steps = Math.min(32, Math.ceil(dt / (1 / 240)));
    const h = dt / Math.max(1, steps);
    for (let n = 0; n < steps; n++) for (const r of riders) step(r, h);
    stepSession(dt);
    for (const r of riders) pose(r, dt);
  }

  // Start on the deck about to drop in, and run a few seconds before anyone looks — shot mode ticks
  // once and freezes, and a screenshot of a skatepark should have someone on the ramp.
  rider.stall = {
    kind: 'rest', side: Math.sign(rider.u), t: 0.35, turn: 0, up: 0.35, hold: rng.range(0.2, 1.2), back: 0.34,
    reach: DECK_IN, planned: false,
  };
  // The rest of the crew wait their turn on the decks, each on a spot of their own.
  const spots = deep ? [[1, 1], [1, -1], [-1, 1], [-1, -1]].sort(() => rng.next() - 0.5) : [];
  riders.slice(1).forEach((r, i) => {
    startWaiting(r, spotFor(spots[i][0], spots[i][1]));
    group.attach(r.bodyRoot);
    r.waitedSince = -1 - i;
  });
  const detachedAtStart = riders.filter((r) => r.mode === 'foot');
  // No sparks while warming up: the shared pool is built after this, and nobody is looking yet.
  let warming = true;
  update(0);
  for (let k = 0; k < 60 * 3; k++) update(1 / 60);
  warming = false;

  const entryObjects = [...riders.map((r) => r.holder), ...detachedAtStart.map((r) => r.bodyRoot)]
    .map((object) => ({ object, x: park.x, z: park.z, rand: hash01(park.x, park.z) }));

  return { group, riders, entryObjects, park, update, U, V };
}

/** A skateboard along +X: deck with kicked nose and tail, two trucks, four wheels. */
function buildBoard(deck = PALETTE.skateDeck) {
  const parts = [];
  const box = (w, h, d, x, y, z, col, roll = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (roll) geo.rotateZ(roll);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };
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
