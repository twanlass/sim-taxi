/**
 * Pac-Man steering: the player queues the taxi's next turn with a swipe, and the taxi takes it at
 * the first corner that has it (`?steer=classic` puts back tap-a-rider auto-routing).
 *
 * **The taxi still drives the traffic model.** Nothing here moves the car. What changes is who
 * writes `car.route`: instead of a Dijkstra plan to a destination, it is one step long — the exit
 * at the next junction the car can still choose at — rewritten every frame from the turn the player
 * has queued. Everything `traffic.js` does with a route (the indicator, the left-turn yield, the
 * signal, the late turn in the run-up) applies unchanged, so a steered taxi obeys exactly the rules
 * a routed one did. That is also why a route is never left *empty* while the car is moving: an
 * empty route is an unrouted car, and an unrouted car rolls the ambient dice (`rollExit`).
 *
 * **The queue is a direction on the map, not a hand.** A swipe is read against the heading the car
 * will have at its next decision (a car mid-turn is already heading out of it — `planOrigin`), so
 * on screen it means "go that way", and the queued direction keeps meaning that way after the car
 * turns. Like Pac-Man it waits: a turn queued where the corner has no such exit carries on to the
 * next corner that does, and is spent the moment the car is heading that way.
 *
 * **A dead end waits for you.** At a T with nothing queued (straight on is not an exit), the taxi
 * holds at the line (`car.steerHold`, read in traffic.js) rather than picking for the player — the
 * Pac-Man wall. It holds like a red: the approach slows for it, so the car does not slam to a stop.
 *
 * **Why the swipe is read relative to the heading.** The camera looks down the city's diagonal, so
 * no street runs along a screen axis: foreshortened, each lies ~29° off the horizontal, the two
 * axes ~58° apart above and below it — and a thumb's "up" or "left" sits between two of them.
 * Snapping the swipe to the nearest street axis would hand a lot of those to the wrong street.
 * A swipe here is instead one of three answers — on, left of, right of the way the car is going —
 * and a swipe of ±40° either side of the car's own screen heading is "straight on" (which also
 * clears a queued turn). Backwards clears the queue too; the U-turn stays the brake's move.
 */
import { cityNetwork } from '../city/roadnet.js';
import { opposite, rightOf, leftOf } from '../city/grid.js';

// How far a finger has to travel before the gesture counts as a swipe, in CSS pixels. Fired on the
// move that crosses it rather than on lift, so a turn queued late in the run-up still lands.
export const SWIPE_MIN_PX = 22;
// A swipe within this angle of the car's own screen heading reads as "straight on", and within it
// of the reverse as "backwards". Everything between is a turn to that side.
const STRAIGHT_CONE = (40 * Math.PI) / 180;

// World direction vectors for the grid encoding (DIR: PX, PZ, NX, NZ).
const DIR_VEC = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * The lane whose far junction is the taxi's next choice, and the heading it arrives on. Mirrors
 * `planOrigin` in game/route.js: a car mid-turn has committed that junction, so the choice is at
 * the end of the lane the turn lands on.
 */
export function decisionLane(car, net = cityNetwork()) {
  if (car.state === 'turn') {
    const lane = net.laneOutByGrid(car.dOut, car.i, car.j);
    return lane ? { lane, d: car.dOut } : null;
  }
  return car.lane ? { lane: car.lane, d: car.d } : null;
}

/** The grid directions out of the junction at the end of `lane`, in the network's exit order. */
export function exitDirs(lane, net = cityNetwork()) {
  return lane.exits.map((id) => net.dirOfLane(net.laneById.get(net.turnById.get(id).outLane)));
}

/**
 * What the taxi does at its next junction, given the queued direction (or null).
 *
 * Returns `{ route, hold }`: `route` is the one-step plan for `car.route`, empty only when `hold`
 * says the car should wait at the line for the player.
 */
export function steerPlan(car, queued, net = cityNetwork()) {
  const at = decisionLane(car, net);
  if (!at) return { route: [], hold: false };
  const exits = exitDirs(at.lane, net);
  if (queued != null && queued !== at.d && exits.includes(queued)) return { route: [queued], hold: false };
  if (exits.includes(at.d)) return { route: [at.d], hold: false };
  return { route: [], hold: true };
}

/**
 * Turn a screen-space swipe into a grid direction, given the car's heading `d` and a projector
 * `toScreen(dx, dz)` that maps a world ground vector to a screen vector `{ x, y }` (y down).
 *
 * Returns the grid direction to queue, `'straight'`, or `'back'`.
 */
export function readSwipe(sx, sy, d, toScreen) {
  const [fx, fz] = DIR_VEC[d];
  const f = toScreen(fx, fz);
  const fl = Math.hypot(f.x, f.y) || 1;
  const sl = Math.hypot(sx, sy) || 1;
  const cos = (f.x * sx + f.y * sy) / (fl * sl);
  const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
  if (angle <= STRAIGHT_CONE) return 'straight';
  if (angle >= Math.PI - STRAIGHT_CONE) return 'back';
  // Which side of the heading the swipe falls on, decided by the screen positions of the two
  // perpendicular world directions rather than by a handedness assumption about the projection.
  const r = rightOf(d);
  const [rx, rz] = DIR_VEC[r];
  const rs = toScreen(rx, rz);
  return rs.x * sx + rs.y * sy > 0 ? r : leftOf(d);
}

/**
 * The live controller: owns the queued turn, reads swipes and arrow keys, and rewrites the taxi's
 * one-step route each frame.
 *
 * @param dom        the canvas — swipes are read on it, so HUD buttons keep their own presses
 * @param taxi       the taxi car
 * @param toScreen   `(dx, dz) => { x, y }`, a world ground vector in screen pixels (y down)
 * @param canSteer   live gate: false while a scripted trip, the opening or a menu owns the car
 * @param onQueue    called with the grid direction (or null) whenever the queue changes
 */
export function createSteer({ dom, taxi, toScreen, canSteer = () => true, onQueue = () => {},
  swipe = true }) {
  let queued = null;
  let press = null;
  // The click the browser synthesises after a swipe must not also reach the picker.
  let swiped = false;
  let clearSwiped = null;
  let swipes = 0;

  function setQueue(dir) {
    if (dir === queued) return;
    queued = dir;
    onQueue(dir);
  }

  function queueTurn(dir) {
    if (dir === queued) return;
    setQueue(dir);
    // In the run-up to a junction the car is crossing straight on, it can still take the corner —
    // the same late turn a tap used to buy (`retakeCrossing` in traffic.js decides). Refused, the
    // queue stands for the next corner.
    if (taxi.state === 'turn' && taxi.turn?.hand === 'straight'
      && Math.min(taxi.turnT, 1) * taxi.turnLen < taxi.leadIn) {
      taxi.lateTurn = [dir];
    }
  }

  function apply(sx, sy) {
    if (!canSteer()) return;
    const at = decisionLane(taxi);
    if (!at) return;
    const read = readSwipe(sx, sy, at.d, toScreen);
    swipes += 1;
    if (read === 'straight' || read === 'back') { setQueue(null); return; }
    queueTurn(read);
  }

  // The stick (game/joystick.js) names a street direction outright. Held, it is re-asserted every
  // frame in `update`, so it keeps meaning "that way" through corners.
  let held = null;
  function pushDir(dir) {
    if (dir == null || !canSteer()) return;
    const at = decisionLane(taxi);
    if (!at) return;
    if (dir === opposite(at.d)) return;
    if (dir === at.d) { setQueue(null); return; }
    queueTurn(dir);
  }
  function push(dir) {
    if (dir != null && dir !== held) swipes += 1;
    held = dir;
    pushDir(dir);
  }

  if (swipe) dom.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    clearTimeout(clearSwiped);
    swiped = false;
    press = { x: event.clientX, y: event.clientY, fired: false };
  });
  if (swipe) dom.addEventListener('pointermove', (event) => {
    if (!press || press.fired || !event.isPrimary) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.hypot(dx, dy) < SWIPE_MIN_PX) return;
    press.fired = true;
    swiped = true;
    apply(dx, dy);
  });
  const release = () => {
    press = null;
    if (swiped) clearSwiped = setTimeout(() => { swiped = false; }, 0);
  };
  dom.addEventListener('pointerup', release);
  dom.addEventListener('pointercancel', release);

  // Arrow keys and WASD on a desktop, as the four screen directions.
  const KEYS = {
    ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
    ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
  };
  window.addEventListener('keydown', (event) => {
    const v = KEYS[event.code];
    if (!v || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    apply(v[0], v[1]);
  });

  /** Rewrite the taxi's one-step route from the queue. Call before `traffic.update`. */
  function update() {
    if (!canSteer() || taxi.crashed || taxi.uturn || taxi.staged) {
      taxi.steerHold = false;
      return;
    }
    if (held != null) pushDir(held);
    const at = decisionLane(taxi);
    // Spent: the car is heading the way that was queued. A queue that has come to point backwards
    // (the car turned the other way through a corner) can never be taken, so it goes too.
    if (at && (queued === at.d || queued === opposite(at.d))) setQueue(null);
    const plan = steerPlan(taxi, queued);
    taxi.route = plan.route;
    taxi.routeConsumed = false;
    taxi.steerHold = plan.hold;
    if (plan.route.length) taxi.parked = false;
  }

  function reset() {
    setQueue(null);
    taxi.steerHold = false;
  }

  return {
    update,
    reset,
    queued: () => queued,
    /** The stick: a grid direction while pushed, null when let go (the queue stands). */
    push,
    /** True for the click that ends a swipe, so the picker can ignore it. */
    didSwipe: () => swiped,
    /** How many swipes the player has made this page — the tip stops once they have the idea. */
    swipes: () => swipes,
    holding: () => Boolean(taxi.steerHold),
  };
}
