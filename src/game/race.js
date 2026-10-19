import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRID_I, GRID_J, lineX, lineZ, riverBanks } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  carGeometry, setClosedLanes, isLaneClosed, stopDistance, hardBrake, STOP_SETBACK, CAR_LEN, CAR_W, MIN_GAP,
  CABIN_X, CABIN_TOP, SPAWN_CLEARANCE, ROAD_Y,
} from '../sim/traffic.js';
import { findRoute, findRouteOnto, planOrigin, estimateSeconds } from './route.js';
import { sightlineClear } from './sightline.js';
import { ARRIVE_RADIUS, blockDistance } from './fares.js';
import { BILLBOARD, VIEW_UP } from './camera.js';
import { propMaterial, cloneProp, bakeColor, setFinish, FINISH, BODY_EULER_ORDER } from '../util/geo.js';
import { color } from '../palette.js';
import { wheelAnchors, wheelGeometry, SILL_Y } from '../geometry/wheels.js';
import { createTargetRing, RING_Y } from '../geometry/targetring.js';
import { createRaceFlag } from '../geometry/raceflag.js';
import { BOOST_START_FRACTION } from './boost.js';
import { markOccluder } from './ssao.js';

// The street race. A violet car with a wing on it pulls over a couple of blocks from the taxi and
// waits with a chequered flag over its roof. Tap it and drive up behind it, and a corner a few blocks
// away is marked as the finish; three, two, one, and both cars go. Get there first and it pays; get
// there second and it costs.
//
// **It is taken on, never imposed.** The robbery's rule is that an imposed event cannot cost the run,
// and a race costs cash when it is lost — so it has to be a choice, and the cheapest way to make it one
// is the way every other choice in this game is made: a tap. Declining is not tapping. Nothing is
// asked, there is no button to say no with, and an offer nobody takes drives off on its own
// (`OFFER_TIME`). The stakes are on the rival's speech bubble before anything is committed.
//
// **One seat.** It is taken with an empty cab only (`canAccept`, main.js), and while it runs the rest
// of the board steps aside exactly as it does for a getaway — riders hidden, their clocks held, nobody
// new spawning, the courier's pads off the map (`holdsBoard`, read through `setHold` in
// game/fares.js). Otherwise accepting would cost a fare's clock on top of the bet, and nobody would.
//
// **The rival is a car in traffic** (`enterGuest` in sim/traffic.js), the fire engine's arrangement:
// it is routed to the finish by the same router the taxi is, queues, and can be bumped. What makes it
// a racer is a share of a chasing cop's kit (`car.chase`): a lifted cruise ceiling, the car in front
// pulling out of its way, and the licence to cross a red on a provably empty junction. There is no
// rubber band. A rival that visibly slowed down to let you catch it, or found speed from nowhere when
// you got ahead, would take the win away from the player along with the loss — so it drives one way
// all race, and what the player has over it is Loco Mode and a route of their own choosing.
//
// **The start is window to window.** Say yes and the taxi pulls up where it is (`parked`), and the
// rival comes to it: routed onto the lane that runs the other way past the taxi, and stopped level
// with it. Then the camera goes and looks at the finish (main.js, `countIn`), comes back, and it is
// three, two, one. Facing opposite ways is the point rather than the price: the streets have one
// lane each way, so "beside you, in the other lane" is the oncoming lane, and a rival sat in it
// facing *your* way would be driving into traffic the moment the flag dropped. Facing its own way
// it is an ordinary car in its own lane, and the two set off in opposite directions — two routes to
// one corner, by construction, which is the race worth watching. The finish is chosen so the two
// routes take about as long (`chooseFinish`).
//
// It replaced a start where the taxi was sent to queue up behind a parked rival. That read wrong
// (Tyler: "pulling around behind them is strange"), handed the rival a car length's lead, and needed
// three separate fixes to stop the queue deadlocking on the cross traffic.

// When an offer turns up. Off the run's own clock and only while nothing upstages it (`blocked`),
// like the fire and the roadworks: it is something to take or leave, not pressure.
const FIRST_WAIT = [45, 75];
const REPEAT_WAIT = [100, 160];
const SOON_WAIT = 4;            // ?race=soon
const RETRY_WAIT = 4;           // nothing qualified this time

const ARRIVE_MAX = 40;          // the rival has this long to get to its spot, or the offer is dropped
export const OFFER_TIME = 30;   // how long it waits at the kerb for a taker
const STOP_MAX = 20;            // the taxi has this long to find somewhere to pull up once it said yes
const PULLUP_MAX = 35;          // ...and the rival this long to get round to it
// The camera's look at the finish is main.js's (`countIn`); this is how long the start waits for it
// before counting anyway — a swipe mid-pan drops the peek's callback, and the tools have no camera.
const REVEAL_MAX = 6;
export const COUNTDOWN = 3;     // seconds of three, two, one
const RACE_MAX = 75;            // nobody home by now — the race is called off and nothing changes hands
const LINE_SHORT = 1;           // how far short of the hold line the rival waits — see `spots`
// Where on its lane the taxi may pull up: the middle of the block. Short of its own hold line, so it
// has not committed to the junction ahead (CLAUDE.md: `state` flips to `turn` there); and far enough
// in that the rival, level with it on the other lane, is short of *its* hold line too — the two lanes
// are one street run both ways, so that is the same line seen from the far end. On a 12-unit lane
// it leaves a stretch of 3, which a taxi on the hard brake from cruise (about a unit) hits easily.
const PULL_BACK = STOP_SETBACK + CAR_LEN / 2;
const PULL_FRONT = STOP_SETBACK + 0.5;
// The taxi pulls up on its own brake pedal (`braking`, the HUD's brake button), which lands it
// `v² / 2·hardBrake()` on — about a unit from cruise — plus this for the frame it takes to bite.
// Not on `parked`: that holds a car still, but from speed it stops it dead in one frame.
const PULL_SLACK = 0.3;
const PULLED_UP = 0.3;          // slower than this, on the pedal, and it is pulled up

// Stakes. Shown on the rival's bubble before anything is decided. A median fare is $20, so a win is
// two of them and a loss a fare and a quarter. **Lopsided on purpose**: declining is free, so an even
// bet is one a sensible player never takes, and a race nobody accepts is content nobody sees. The
// lean is what makes it a gamble a confident driver should take, not a coin flip.
export const WIN_PAY = 40;
export const LOSE_COST = 25;

/**
 * The tank the taxi is guaranteed at the green, as a fraction of a full one: what a run starts with.
 *
 * The race is decided by Loco Mode — the rival cruises well over an unboosted taxi, and an unboosted
 * taxi lost every race measured — so a player who accepted on an empty tank would lose before the
 * flag dropped, and learn nothing from it except that races are rigged. Topped *up to* this, never
 * down: a fuller tank is still an edge (see RIVAL_CHASE for how much).
 */
export const TANK_FLOOR = BOOST_START_FRACTION;

/**
 * The rival's share of a chasing cop's kit while racing (see CHASE_SPEED in sim/traffic.js) — twice
 * a whole cop's, because a cop is the city's *slowest* answer to a boosting taxi and this has to be
 * a race. A ceiling of ~35 u/s, Loco Mode's overdrive top, that it reaches only on the longest
 * straights. It also rolls all-way stops and holds the junction it is driving into, the way the
 * boosting taxi and a chasing patrol do (`car.racer` in sim/traffic.js); without those it lost all
 * 32 races it ran against Loco Mode whatever this was set to.
 *
 * Measured with `tools/race.mjs` over 24 races, a player holding Loco Mode from the green until
 * the tank is dry: 1/4 tank wins 63%, the 1/3 floor 67%, a full tank 71%, and never touching the
 * pill wins none (the boosting taxi is home in a median 4.9s). At 1.3 the floor won 83%, at 1.8
 * 75%. It was 1.3 when the start was a queue with the rival a car length ahead; window to window,
 * with the two routes evened out, the taxi lost that lead and the kick off the line is all its own.
 * That bot never misses a turn or brushes a car, so a person wins less often than it does — about
 * even is the aim, which the lopsided stakes then pay for.
 */
export const RIVAL_CHASE = 2.0;
const ARRIVING_CHASE = 0.3;     // on its way to the kerb: a car in a hurry, not a race

// Where the rival may park, off the taxi: far enough to be a drive, near enough to be on screen.
const SPOT_NEAR = 16;
const SPOT_FAR = 46;
const SPOT_IDEAL = 30;

// How far the finish is from the start, in blocks, leaning to the far end of the range (see
// `chooseFinish`) — across the island rather than round the corner, with the river to cross on most.
// The ring road is out (it is in the fog bank), which caps what an island this size can offer.
const FINISH_MIN = 4;
const FINISH_MAX = 8;

const FADE_TIME = 0.8;          // the fire engine's dissolve
const EXIT_REACH = 8;
const LEAVE_MAX = 30;

// The flag over the rival: how high it flies off the roof.
const FLAG_LIFT = 0.6;
// ...and the one over the finish: clear of a truck's roof (the cars drive under it), and half as
// big again as the roof flag so it reads from the far side of a phone screen.
const FINISH_FLAG_Y = 4.5;
const FINISH_FLAG_SCALE = 1.5;
// The tap target: a quad in the screen plane over the car and its flag (see BILLBOARD in
// game/camera.js and the tap-target trap in CLAUDE.md). 9 across is well inside the 14.1 that two
// neighbouring junctions are apart on screen.
const HIT_W = 9;
const HIT_H = 9;

const BUSY = new Set(['stopping', 'pulling-up', 'reveal', 'countdown', 'racing']);

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The rival's body: an ordinary car's, in its own paint, with a wing on the boot. */
function rivalBodyGeometry() {
  const wing = (w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return setFinish(bakeColor(g, color('racerWing')), FINISH.PAINT);
  };
  const tail = -CAR_LEN / 2 + 0.3;
  const top = CABIN_TOP - 0.05;
  const parts = [
    carGeometry(),
    // The blade, a little under the roofline so it reads as a wing and not a second roof.
    wing(0.42, 0.08, CAR_W * 0.95, tail, top, 0),
    // Its two struts down onto the boot.
    wing(0.1, top - 1.35, 0.1, tail, (top + 1.35) / 2, CAR_W * 0.3),
    wing(0.1, top - 1.35, 0.1, tail, (top + 1.35) / 2, -CAR_W * 0.3),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The rival's mesh. Same arrangement as the fire engine and the patrol cruiser: the group stays in
 * the scene for the whole run and only `shell` is switched, so nothing here moves the scene's light
 * count (see the hidden-light trap in CLAUDE.md — there is no light in it today, and this keeps it
 * that way if one is ever added).
 */
function createRivalMesh() {
  const group = new THREE.Group();
  group.name = 'race-rival';
  group.rotation.order = BODY_EULER_ORDER;
  const shell = new THREE.Group();
  group.add(shell);

  const bodyGeo = rivalBodyGeometry();
  const body = new THREE.Mesh(bodyGeo, propMaterial({ gloss: { geometry: bodyGeo, floor: SILL_Y } }));
  // The body is baked white under the paint (see `carGeometry`), and the wing baked dark, so one
  // multiply paints the car and leaves the wing and the glass dark.
  body.material.color.set(color('racerBody'));
  body.castShadow = true;
  body.receiveShadow = true;
  shell.add(body);

  const wheelGeo = wheelGeometry();
  const wheelMat = propMaterial({ gloss: { geometry: wheelGeo } });
  const wheels = wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      shell.add(wheel);
      return wheel;
    });

  // Dissolved in and out rather than blended — the cruiser's and the engine's `alphaHash`.
  const faders = [body.material, wheelMat];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;
  return { group, shell, body, wheels, faders, occluders: [body, ...wheels] };
}

/**
 * @param rng      its own stream: when, where, and which corner is the finish
 * @param scene    where the rival, its flag and the finish are drawn
 * @param traffic  the sim — `enterGuest`, `retireGuest`, `taxi`
 * @param routeTo  main.js's router, `(target) => boolean` — the one that keeps `pendingTarget` and the
 *                 route band honest (see `createBurgerRun` for why it is injected)
 * @param blocked  `() => boolean` — true while no new offer may turn up; the countdown holds
 * @param onEvent  `(type, detail) => void` — everything the player sees off the car: the bubble, the
 *                 count, the money. This module knows a race happened, not what a run's cash is.
 * @param soon     `?race=soon`
 */
export function createRace({
  rng, scene, traffic, routeTo, blocked = () => false, onEvent = () => {}, soon = false,
}) {
  const taxi = traffic.taxi;
  let rivalChase = RIVAL_CHASE;

  const rival = createRivalMesh();
  scene.add(rival.group);
  markOccluder(rival.group);

  // The flag over the rival's roof, and the tap target with it. On a group that follows the car
  // rather than on the car's own group, so it can stand upright while the body pitches and rolls.
  const offer = new THREE.Group();
  offer.name = 'race-offer';
  const roofFlag = createRaceFlag({ pole: 1.8 });
  roofFlag.group.position.y = CABIN_TOP + FLAG_LIFT - 1.8 * 0.35;
  offer.add(roofFlag.group);
  const hit = new THREE.Mesh(
    new THREE.PlaneGeometry(HIT_W, HIT_H),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
  );
  hit.quaternion.copy(BILLBOARD);
  hit.position.copy(VIEW_UP).multiplyScalar(HIT_H / 2 - 1);
  offer.add(hit);
  offer.userData.pickable = 'racer';
  offer.visible = false;
  scene.add(offer);

  // The finish: the waypoint ring on the junction, and a flag planted on its corner.
  const finishRing = createTargetRing(color('waypoint'));
  finishRing.setWaypoint(true);
  finishRing.group.visible = false;
  scene.add(finishRing.group);
  // The finish flag flies over the ring rather than standing beside it: planted on a pavement
  // corner it was inside whatever the block had built there — measured on the first browser pass,
  // a gas station's kiosk swallowed it whole and the finish was a ring on the road and nothing
  // else. Up here, under this camera, nothing a block builds can hide it, and the cars drive under.
  const finishFlag = createRaceFlag({ pole: 1.2 });
  finishFlag.group.scale.setScalar(FINISH_FLAG_SCALE);
  finishFlag.group.visible = false;
  scene.add(finishFlag.group);

  const state = {
    // 'waiting' — nothing on; 'arriving' — the rival is driving to its spot; 'offer' — parked, flag
    // up, waiting for a tap; 'stopping' — the taxi said yes and is pulling up; 'pulling-up' — the
    // rival is on its way round to it; 'reveal' — side by side, the camera off looking at the
    // finish; 'countdown'; 'racing'; 'leaving' — it is over and the rival is driving off.
    phase: 'waiting',
    phaseT: 0,
    t: 0,
    cooldown: soon ? SOON_WAIT : rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    car: null,
    /** Where the rival is headed and stops: the offer's kerb, then the taxi's side. */
    spot: null,
    /** The lane the taxi pulled up on. */
    taxiLane: null,
    /** The taxi's brake pedal is ours this frame — see `braking` on the API. */
    braking: false,
    /** ...and for the finish, a junction. Object identity is what the route band keys off. */
    finish: null,
    exit: null,
    fade: 0,
    fading: 0,
    /** The last whole second the countdown announced, so each is said once. */
    count: 0,
    // What happened, for the tools.
    offers: 0,
    races: 0,
    wins: 0,
    losses: 0,
    voids: 0,
    lastResult: null,
    taxiTime: null,
    rivalTime: null,
    pullUpTime: null,
  };

  function setPhase(phase) {
    state.phase = phase;
    state.phaseT = 0;
  }

  // --- Choosing where ---------------------------------------------------------

  /** Is this z on or beside the river? Nobody parks on a bridge, and a finish there is a lift bridge's. */
  function overWater(z) {
    const banks = riverBanks();
    return Boolean(banks) && z > banks.z0 - 2 && z < banks.z1 + 2;
  }

  /** Every lane the rival could park on this frame, with where on it. */
  function spots() {
    const net = cityNetwork();
    const out = [];
    for (const lane of net.lanes) {
      if (lane.degenerate || isLaneClosed(lane.id)) continue;
      const a = net.nodeById.get(lane.from);
      const b = net.nodeById.get(lane.to);
      if (!a || !b) continue;
      // Not the ring road: its corners are curves and its outer kerb is the edge of the island.
      const ring = (n) => n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
      if (ring(a) && ring(b)) continue;
      // At the hold line, like a car waiting on a light, which leaves the rest of the lane for the
      // queue behind it rather than parking it across the junction behind. Standing at the line
      // costs the cross streets nothing past one `STOP_PATIENCE`.
      //
      // **Short of it, not on it.** A car's state flips to `turn` at the hold line (CLAUDE.md), and
      // a rival that reached it committed to the corner and then stood there under its roadblock —
      // stranded in the junction box as far as everyone else could tell, which held the whole
      // junction for the length of the offer.
      const s = lane.length - STOP_SETBACK - LINE_SHORT;
      if (s - MIN_GAP < CAR_LEN / 2 + 0.5) continue;
      const p = lane.path.at(s);
      if (overWater(p.z)) continue;
      const d = Math.hypot(p.x - taxi.x, p.z - taxi.z);
      if (d < SPOT_NEAR || d > SPOT_FAR) continue;
      if (!sightlineClear(p.x, 2.2, p.z)) continue;
      out.push({ lane, s, x: p.x, z: p.z, d, to: { i: b.gi, j: b.gj }, dir: net.dirOfLane(lane) });
    }
    return out;
  }

  /**
   * A corner FINISH_MIN..FINISH_MAX blocks off that both cars can be routed to, from where each
   * stands and the way each is facing (`taxiFrom`, `rivalFrom`, as `planOrigin` reads them).
   *
   * The two set off in opposite directions, so for any corner one of them is pointing the right way
   * and the other has a turn or two to make first — on a grid, one of the two junctions they are
   * heading for is always a block nearer. Picked by the router's own estimate of the drive
   * (`estimateSeconds`, the fare clocks' arithmetic) so that gap is as small as the city allows,
   * rather than by blocks, which cannot see the river's three bridges.
   */
  function chooseFinish(taxiFrom, rivalFrom) {
    const net = cityNetwork();
    const options = [];
    // Never on the ring road: its corners are the island's, out in the fog bank, and a finish line
    // nobody can see is a race decided off screen.
    for (let i = 1; i < GRID_I; i++) {
      for (let j = 1; j < GRID_J; j++) {
        if (!net.nodeById.has(`${i},${j}`)) continue;
        const d = Math.min(blockDistance(taxiFrom, { i, j }), blockDistance(rivalFrom, { i, j }));
        if (d < FINISH_MIN || d > FINISH_MAX) continue;
        const x = lineX(i);
        const z = lineZ(j);
        if (overWater(z)) continue;
        if (!sightlineClear(x, 0.5, z)) continue;
        const taxiRoute = findRoute(taxiFrom, { i, j });
        const rivalRoute = findRoute(rivalFrom, { i, j });
        if (!taxiRoute?.length || !rivalRoute?.length) continue;
        const gap = Math.abs(estimateSeconds(taxiRoute, taxiFrom.d) - estimateSeconds(rivalRoute, rivalFrom.d));
        options.push({ i, j, d, gap });
      }
    }
    if (!options.length) return null;
    // Leaning long: the further of what qualifies, so a race is a drive rather than a sprint; and
    // of those, the evenest few.
    const far = Math.max(...options.map((o) => o.d));
    const pool = options.filter((o) => o.d >= far - 1).sort((a, b) => a.gap - b.gap).slice(0, 3);
    const { i, j } = rng.pick(pool);
    return { i, j };
  }

  /** The lane running the other way along the same street, if there is one to stop in. */
  function oppositeOf(lane) {
    const net = cityNetwork();
    const back = net.lanes.find((l) => l.from === lane.to && l.to === lane.from);
    return back && !back.degenerate ? back : null;
  }

  /** Could the taxi pull up on this lane, and is there room for the rival to stop beside it? */
  function pullable(lane) {
    if (!lane || lane.degenerate) return false;
    const net = cityNetwork();
    const a = net.nodeById.get(lane.from);
    const b = net.nodeById.get(lane.to);
    if (!a || !b) return false;
    const ring = (n) => n.gi === 0 || n.gi === GRID_I || n.gj === 0 || n.gj === GRID_J;
    if (ring(a) && ring(b)) return false;
    if (lane.length - PULL_FRONT < PULL_BACK) return false;
    const back = oppositeOf(lane);
    return Boolean(back) && !isLaneClosed(back.id);
  }

  /** Bring the rival on, and point it at its spot. Answers whether it arrived. */
  function summon() {
    const all = spots();
    if (!all.length) return false;
    const pool = all.sort((a, b) => Math.abs(a.d - SPOT_IDEAL) - Math.abs(b.d - SPOT_IDEAL)).slice(0, 5);
    const spot = rng.pick(pool);
    const car = traffic.enterGuest({ x: spot.x, z: spot.z }, { isTruck: false });
    if (!car) return false;
    car.skin = skin;
    car.guestWreck = wreck;
    car.route = [];
    car.chase = ARRIVING_CHASE;
    state.car = car;
    state.spot = spot;
    state.finish = null;
    state.taxiLane = null;
    rival.group.position.set(car.x, 0, car.z);
    rival.shell.visible = true;
    state.fade = 0;
    state.fading = 1;
    state.offers += 1;
    setPhase('arriving');
    return true;
  }

  /** Re-plan to the spot's lane — only when it has run out of route, never per frame (CLAUDE.md). */
  function steerToSpot(car) {
    const { spot } = state;
    if (car.route?.length) return;
    if (car.lane === spot.lane && car.state === 'drive' && car.s < spot.s + 2.5) return;
    const route = findRouteOnto(planOrigin(car), spot.to, spot.dir);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  /** On the spot's lane and within braking distance of it: put the pedal down and hold it. */
  function tryPark(car) {
    const { spot } = state;
    if (car.lane !== spot.lane || car.state !== 'drive') return false;
    if (car.s + stopDistance(car.v) < spot.s) return false;
    // A little past is still beside it; further than that, round the block again (`steerToSpot`).
    if (car.s > spot.s + 2.5) return false;
    car.roadblock = Infinity;
    // Nothing to commit to at the line it is stopping short of.
    car.route = [];
    // ...and tell the oncoming lefts not to wait for it (see `leftYieldBlocked` in sim/traffic.js).
    car.holdsLine = true;
    return true;
  }

  function steerToFinish(car) {
    if (car.route?.length) return;
    const route = findRoute(planOrigin(car), state.finish);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  // --- The race ---------------------------------------------------------------

  /**
   * The tap on the rival. Answers whether the race is on: the taxi drops whatever it was heading for
   * (an empty cab's only errand is a rider, and the board is about to be held) and pulls up at the
   * first stretch of road that has room (`tryPullUp`).
   */
  function accept() {
    if (state.phase !== 'offer') return false;
    taxi.route = [];
    taxi.pendingTarget = null;
    taxi.parked = false;
    setPhase('stopping');
    onEvent('accepted', { car: state.car });
    return true;
  }

  /** Put the taxi's brake on if it would come to rest inside the stretch `pullable` allows. */
  function tryPullUp() {
    const lane = taxi.lane;
    if (taxi.state !== 'drive' || !pullable(lane)) return false;
    const rest = taxi.s + (taxi.v * taxi.v) / (2 * hardBrake()) + PULL_SLACK;
    if (rest < PULL_BACK || rest > lane.length - PULL_FRONT) return false;
    const p = lane.path.at(Math.min(rest, lane.length));
    if (overWater(p.z) || !sightlineClear(p.x, 2.2, p.z)) return false;
    state.braking = true;
    return true;
  }

  /** The taxi has stopped: send the rival round onto the other lane, to stop level with it. */
  function callRival() {
    const car = state.car;
    const lane = taxi.lane;
    const back = oppositeOf(lane);
    const net = cityNetwork();
    const to = net.nodeById.get(back.to);
    // Level with the taxi: the two lanes are the same street run both ways, so its arc length on
    // the one is the other's measured from the far end.
    const s = Math.max(PULL_FRONT, Math.min(back.length - PULL_BACK, back.length - taxi.s));
    const p = back.path.at(s);
    state.taxiLane = lane;
    state.spot = { lane: back, s, x: p.x, z: p.z, to: { i: to.gi, j: to.gj }, dir: net.dirOfLane(back) };
    // Nothing more joins the taxi's lane behind it while it stands there, the way the engine shuts
    // its lane. The rival's lane is shut once the rival is on it — shut now, its own route onto it
    // would be refused (`refusesLane` in sim/traffic.js).
    setClosedLanes([lane.id], 'race');
    // A car that is not moving is no reason for an oncoming left to wait — see `leftYieldBlocked`.
    taxi.holdsLine = true;
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.route = [];
    // Coming round at race pace, with the racer's licence at the stops: the player is sat waiting,
    // and every second it spends on the way is a second of nothing. See PULLUP_* for the times.
    car.chase = rivalChase;
    car.racer = true;
    offer.visible = false;
    setPhase('pulling-up');
  }

  /** Side by side: pick the finish, show it, and wait for the camera's look at it (`countIn`). */
  function lineUp() {
    const car = state.car;
    state.pullUpTime = state.phaseT;
    car.racer = false;
    const goal = chooseFinish(planOrigin(taxi), planOrigin(car));
    if (!goal) { finish('void'); return; }
    state.finish = goal;
    showFinish();
    setPhase('reveal');
    onEvent('lined-up', { car, finish: goal, x: lineX(goal.i), z: lineZ(goal.j) });
  }

  /** Start the count — called when the camera is back from the finish, or by `REVEAL_MAX`. */
  function countIn() {
    if (state.phase !== 'reveal') return;
    state.count = COUNTDOWN + 1;
    setPhase('countdown');
  }

  function go() {
    const car = state.car;
    setPhase('racing');
    state.races += 1;
    state.taxiTime = null;
    state.rivalTime = null;
    setClosedLanes([], 'race');
    taxi.holdsLine = false;
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.chase = rivalChase;
    car.racer = true;
    car.route = [];
    steerToFinish(car);
    routeTo(state.finish);
    onEvent('go', { car });
  }

  function finish(result) {
    const car = state.car;
    state.lastResult = result;
    if (result === 'won') state.wins += 1;
    else if (result === 'lost') state.losses += 1;
    else state.voids += 1;
    hideFinish();
    onEvent(result, { car, finish: state.finish });
    // The taxi is nobody's now: no route, no target, the board back on. Only if it is still ours —
    // a race that ended because something else took the wheel leaves that something alone.
    if (state.finish && taxi.pendingTarget === state.finish) {
      taxi.route = [];
      taxi.pendingTarget = null;
    }
    taxi.parked = false;
    leave();
  }

  /** Drive off — whether the race was run or the offer lapsed — and dissolve once out of the way. */
  function leave() {
    state.braking = false;
    setClosedLanes([], 'race');
    taxi.holdsLine = false;
    offer.visible = false;
    hideFinish();
    const car = state.car;
    setPhase('leaving');
    if (!car) return;
    car.roadblock = 0;
    car.holdsLine = false;
    car.braking = false;
    car.chase = 0;
    car.racer = false;
    car.route = [];
    const exit = { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    state.exit = exit;
    const route = findRoute(planOrigin(car), exit);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  function retire() {
    if (state.car) traffic.retireGuest(state.car);
    state.car = null;
    state.spot = null;
    state.taxiLane = null;
    state.finish = null;
    rival.shell.visible = false;
    offer.visible = false;
    hideFinish();
    setClosedLanes([], 'race');
    setPhase('waiting');
    state.cooldown = soon ? SOON_WAIT * 3 : rng.range(REPEAT_WAIT[0], REPEAT_WAIT[1]);
  }

  function showFinish() {
    const { i, j } = state.finish;
    finishRing.group.position.set(lineX(i), ROAD_Y + RING_Y, lineZ(j));
    finishRing.appear();
    finishFlag.group.position.set(lineX(i), FINISH_FLAG_Y, lineZ(j));
    finishFlag.group.visible = true;
  }

  function hideFinish() {
    if (finishRing.group.visible) finishRing.vanish();
    finishFlag.group.visible = false;
  }

  const near = (car, target, reach) => Math.hypot(car.x - lineX(target.i), car.z - lineZ(target.j)) < reach;

  // --- Drawing the rival ------------------------------------------------------

  function skin(pos, quat, car) {
    rival.group.position.copy(pos);
    rival.group.quaternion.copy(quat);
    for (const wheel of rival.wheels) wheel.rotation.y = car.wheelAngle;
  }

  /** The rival's body for the wreck effects, if the taxi ever writes it off. */
  function wreck() {
    rival.group.updateMatrixWorld(true);
    const shell = rival.shell.clone(true);
    shell.traverse((o) => {
      if (o.isMesh) {
        o.material = cloneProp(o.material);
        o.material.alphaHash = false;
        o.material.opacity = 1;
      }
    });
    shell.visible = true;
    rival.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    rival.shell.visible = false;
    return shell;
  }

  // --- Frame ------------------------------------------------------------------

  function update(dt) {
    state.t += dt;
    state.phaseT += dt;
    const car = state.car;

    // The taxi wrote it off — the run is ending. Leave the scene as it stands.
    if (car?.crashed) {
      state.car = null;
      offer.visible = false;
    }

    switch (state.phase) {
      case 'waiting':
        if (!blocked()) {
          state.cooldown -= dt;
          if (state.cooldown <= 0 && !summon()) state.cooldown = RETRY_WAIT;
        }
        break;
      case 'arriving':
        if (!car || state.phaseT > ARRIVE_MAX || blocked()) { leave(); break; }
        if (car.roadblock > 0) {
          if (car.v < 0.05) {
            // Parked: shut the lane behind it to newcomers, the way the engine does, so the queue
            // does not grow back through the junction for the half-minute it waits.
            setClosedLanes([state.spot.lane.id], 'race');
            offer.visible = true;
            setPhase('offer');
            onEvent('offer', { car, win: WIN_PAY, lose: LOSE_COST });
          }
        } else if (!tryPark(car)) {
          steerToSpot(car);
        }
        break;
      case 'offer':
        if (!car) { leave(); break; }
        if (state.phaseT > OFFER_TIME || blocked()) {
          onEvent('expired', { car });
          leave();
        }
        break;
      case 'stopping':
      case 'pulling-up':
      case 'reveal': {
        if (!car) { finish('void'); break; }
        // Something else took the wheel — a tap on the map, the depot, a package: a route on a
        // parked taxi un-parks it (sim/traffic.js). Called off, and nothing changes hands.
        const redirected = taxi.route.length > 0;
        const late = state.phase === 'stopping' ? state.phaseT > STOP_MAX
          : state.phase === 'pulling-up' ? state.phaseT > PULLUP_MAX : false;
        if (redirected || late || blocked()) { finish('void'); break; }
        if (state.phase === 'stopping') {
          // `parked` with an empty route eases the taxi to a halt and outranks Loco Mode, so a thumb
          // already on the pill cannot drive off while it waits. Until it finds room it drives on
          // with no route, taking whatever exits come, like any car.
          if (!state.braking && !taxi.parked) tryPullUp();
          if (state.braking && taxi.v < PULLED_UP) {
            state.braking = false;
            taxi.parked = true;
          }
          if (taxi.parked && taxi.v < 0.05 && taxi.state === 'drive') callRival();
        } else if (state.phase === 'pulling-up') {
          if (car.lane === state.spot.lane && car.state === 'drive') {
            setClosedLanes([state.taxiLane.id, state.spot.lane.id], 'race');
          }
          if (car.roadblock > 0) {
            if (car.v < 0.05) lineUp();
          } else if (tryPark(car)) {
            // Its own frame's stop, as at the kerb — see `tryPark`.
          } else {
            steerToSpot(car);
          }
        } else if (state.phaseT > REVEAL_MAX) {
          countIn();
        }
        break;
      }
      case 'countdown': {
        if (!car) { finish('void'); break; }
        const left = Math.ceil(COUNTDOWN - state.phaseT);
        if (left < state.count && left > 0) {
          state.count = left;
          onEvent('count', { n: left });
        }
        if (state.phaseT >= COUNTDOWN) go();
        break;
      }
      case 'racing': {
        if (!car) { finish('void'); break; }
        // The taxi's own route can run out short of the corner (a missed turn, a re-plan the
        // player dragged into a lap); put it back on the finish rather than let it cruise.
        if (taxi.pendingTarget === state.finish && !taxi.route.length && !near(taxi, state.finish, ARRIVE_RADIUS)) {
          routeTo(state.finish);
        }
        steerToFinish(car);
        const taxiHome = near(taxi, state.finish, ARRIVE_RADIUS);
        const rivalHome = near(car, state.finish, ARRIVE_RADIUS);
        // The taxi wins a dead heat: it is the one the player is watching cross the line.
        if (taxiHome) { state.taxiTime = state.phaseT; finish('won'); break; }
        if (rivalHome) { state.rivalTime = state.phaseT; finish('lost'); break; }
        if (state.phaseT > RACE_MAX) finish('void');
        break;
      }
      case 'leaving':
        if (!car) { retire(); break; }
        {
          const ex = state.exit;
          const home = ex && near(car, ex, EXIT_REACH);
          const away = Math.hypot(car.x - taxi.x, car.z - taxi.z) > SPAWN_CLEARANCE;
          if (state.fading >= 0 && (home || state.phaseT > LEAVE_MAX || (away && state.phaseT > 4))) {
            state.fading = -1;
          }
          if (!car.route?.length && state.fading >= 0 && ex) {
            const route = findRoute(planOrigin(car), ex);
            if (route?.length) { car.route = route; car.routeConsumed = false; }
          }
          if (state.fading < 0 && state.fade <= 0) retire();
        }
        break;
      default:
        break;
    }

    // The rival: dissolve.
    if (state.fading) {
      state.fade = clamp01(state.fade + state.fading * dt / FADE_TIME);
      if (state.fade === 1 && state.fading > 0) state.fading = 0;
    }
    for (const material of rival.faders) material.opacity = state.fade;

    // The flag rides the roof and flies.
    if (offer.visible && state.car) {
      offer.position.set(state.car.x, 0, state.car.z);
      roofFlag.cloth.rotation.y = Math.sin(state.t * 5.5) * 0.25;
      // A slow bob, so a car waiting at the kerb reads as waiting *for* something.
      roofFlag.group.position.y = CABIN_TOP + FLAG_LIFT - 1.8 * 0.35 + Math.sin(state.t * 2.4) * 0.12;
    }
    if (finishFlag.group.visible) {
      finishFlag.cloth.rotation.y = Math.sin(state.t * 5.5 + 1) * 0.25;
      finishFlag.group.position.y = FINISH_FLAG_Y + Math.sin(state.t * 2.4) * 0.25;
    }
    if (finishRing.group.visible) finishRing.update(state.t);
  }

  return {
    state,
    update,
    accept,
    /** Start one now, if anywhere qualifies — for `?race=soon` and the tools. */
    summon,
    /** The rival's flag and its tap target, for the picker. Empty unless an offer stands. */
    pickables: () => (offer.visible && state.phase === 'offer' ? [offer] : []),
    /**
     * Is the board held? From the yes to the line — a rider's clock running down while the taxi
     * stood waiting for the rival would be the race costing a fare before it had started.
     */
    holdsBoard: () => BUSY.has(state.phase),
    /** Is the taxi committed to a race — waiting at the start, or in one? */
    busy: () => BUSY.has(state.phase),
    /** Side by side and the finish shown: count down now (main.js, once the camera is back). */
    countIn,
    /** Is the start waiting on the camera's look at the finish? */
    revealing: () => state.phase === 'reveal',
    /**
     * Is the race pulling the taxi up? main.js ORs this into the brake pedal it writes every frame,
     * so a press of the real one still works alongside it.
     */
    braking: () => state.braking,
    /** Is a challenge up and waiting for a tap? */
    offering: () => state.phase === 'offer',
    rival,
    /** Every solid part of the rival, for the AO prepass. */
    occluders: rival.occluders,
    /** Where the bubble pins: the rival's roof, or null with no rival on the road. */
    rivalAt: () => (state.car ? { x: state.car.x, z: state.car.z } : null),
    /** Called off a run ending, so a race cannot outlive it. */
    abandon: () => {
      if (state.phase === 'waiting' || state.phase === 'leaving') return;
      taxi.parked = false;
      leave();
    },
    /** For `tools/race.mjs`'s sweep. */
    setRivalChase: (v) => { rivalChase = v; },
    finishRing,
    settle: () => finishRing.settle(),
  };
}
