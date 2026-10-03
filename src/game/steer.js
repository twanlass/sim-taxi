import { legalExits, leftOf, nextIntersection, opposite, rightOf } from '../city/grid.js';
import { findRoute, laneOpen, planOrigin } from './route.js';
import { cityNetwork } from '../city/roadnet.js';

// Active steering for chases — a **prototype**, off unless `?steer=` asks for it.
//
// The complaint it answers: during a getaway or a patrol chase the only live input is the boost
// pill, and the patrol's own escape table (game/patrol.js) says the tank decides it — none spent is
// 15/16 caught, a full tank 14/16 lost. Redrawing the route is the steering the game already has,
// and it cannot be used at chase speed: a block is under a second at the Loco top, and a drag takes
// longer than that to land.
//
// Four pieces, each switchable on its own so they can be played against each other:
//
//   flick  A quick swipe picks the taxi's exit at the next junction it has a choice at — swipe the
//          way the road goes *on screen*, which under this fixed diagonal camera is a diagonal —
//          and the rest of the trip re-plans from the far side of it. Keys: J/I/L for
//          left/straight/right. One decision per block, at the cadence the chase actually runs.
//   uturn  A swipe back down the road (or K) turns the taxi round mid-block, on the same window
//          and the same arc a chasing cop uses (`uturnWindow` in sim/traffic.js). Every cop sent
//          ahead to cut you off is suddenly behind you.
//   drift  Hold the brake through a real turn and it does not stop the car: the taxi slides round
//          the corner at its cornering speed and, let go on the way out, fires a short fuel-free
//          turbo sized by how long the slide was held. Boost becomes something you time.
//   los    Line of sight (game/patrol.js, game/robbery.js): a patrol that cannot see the taxi drives
//          to where it last saw it, and loses it after LOS_LOST_HOLD out of sight. The robbery's
//          cops only learn a redrawn route while one of them can see the taxi.
//
// Gated on a chase being on (`chasing`), except drift, which is a driving technique and has no
// reason to wait for the police — but the turbo only pays for itself against them.

/**
 * Which prototypes are on, from `?steer=`: a comma list of `flick,uturn,drift,los`, or `all`.
 * `always` arms the flick and the U-turn outside a chase too, so they can be tried without waiting
 * for the police — `?steer=all,always`.
 */
export function parseSteerFlags(search) {
  const raw = new URLSearchParams(search).get('steer');
  const flags = { flick: false, uturn: false, drift: false, los: false, always: false };
  if (raw == null) return flags;
  const want = raw.split(',');
  if (raw === '' || want.includes('all') || want.includes('on')) {
    flags.flick = flags.uturn = flags.drift = flags.los = true;
  }
  for (const k of want) if (k in flags) flags[k] = true;
  return flags;
}

/** A swipe: at least this far on screen, in px... */
const FLICK_MIN_PX = 36;
/** ...inside this long, in ms. Slower than this is a drag, and drags pan or bend the route band. */
const FLICK_MAX_MS = 320;
/**
 * How long a U-turn request stands, in seconds. The window is under two units of a 12-unit lane
 * (`uturnWindow`), so a flick that lands past it waits for the next lane rather than vanishing — but
 * not forever: a U-turn taken a block after it was asked for is a different decision.
 */
const UTURN_TTL = 3;
/** Slower than this through the corner and it is not a slide, it is a crawl: no charge. */
const DRIFT_MIN_V = 4;
/** Seconds of slide that buy the full turbo. A corner at cruise takes ~0.9s, half of it lead-in. */
const DRIFT_FULL = 0.55;
/** The turbo, seconds of free boost: the floor for a slide at all, and the most a full one buys. */
const DRIFT_TURBO_MIN = 0.35;
const DRIFT_TURBO_MAX = 1.3;
/**
 * How long after the arc ends the brake can still be held and the slide count. Past this the
 * player is braking on the straight, and gets the ordinary brake with the charge thrown away.
 */
const DRIFT_GRACE = 0.25;
/** How far the body slews out of the arc at the height of a full slide, in radians. */
const DRIFT_SLIP = 0.5;

/**
 * @param flags        parseSteerFlags()
 * @param taxi         the traffic model's taxi
 * @param project      (x, y, z) -> {x, y} screen px
 * @param chasing      () => boolean — a getaway or a patrol chase is on
 * @param destination  () => {i, j} | null — what the rest of the trip re-plans to
 * @param canvas       the element a flick has to start on (not a pedal, not a HUD control)
 * @param busyPointer  () => boolean — a gesture something else owns (the route band's drag)
 */
export function createSteer({
  flags, taxi, project, chasing = () => false, destination = () => null,
  canvas = null, busyPointer = () => false,
}) {
  const any = flags.flick || flags.uturn || flags.drift || flags.los;
  const state = {
    /** Tallies, for the panel and the tools. */
    flicks: 0,
    refused: 0,
    uturns: 0,
    drifts: 0,
    /** Seconds the current U-turn request has left. */
    uturnFor: 0,
    /** The slide in progress: seconds of charge, or null. */
    charge: null,
    /** Seconds since the arc ended with the slide still held. */
    afterArc: 0,
    /** Seconds of turbo left. */
    turbo: 0,
    /** The last thing the player asked for, for the HUD hint. */
    last: null,
  };
  // Inputs waiting for the next frame, in order — two keys inside one frame are two decisions.
  const queued = [];
  let wasUturn = false;

  // Which input just landed, said on screen — a prototype has to tell the playtester what it did.
  let toast = null;
  let toastFor = 0;
  if (any && typeof document !== 'undefined') {
    toast = document.createElement('div');
    toast.id = 'steer-toast';
    document.body.appendChild(toast);
  }
  function say(text) {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('is-on');
    toastFor = 0.9;
  }

  const armed = () => any && (flags.always || chasing()) && !taxi.crashed && !taxi.staged;
  /** A flick gesture is live: the canvas swipe is ours rather than the camera's. */
  const claimsSwipes = () => (flags.flick || flags.uturn) && armed();

  // --- Where each exit goes on screen --------------------------------------------------------

  /** Screen-space unit vector of grid direction d, measured at the taxi. */
  function screenDir(d) {
    const net = cityNetwork();
    const from = planOrigin(taxi);
    const lane = net.laneOutByGrid(d, from.i, from.j) ?? net.laneByGrid(d, taxi.i, taxi.j);
    let dx = 0;
    let dz = 0;
    if (lane) {
      const t = lane.path.tangentAt(lane.length / 2);
      dx = t.x; dz = t.z;
    } else {
      // Off-map exit: grid directions are axis-aligned, so the tangent is the axis itself.
      const n = nextIntersection(d, 1, 1);
      dx = n.i - 1; dz = n.j - 1;
    }
    const a = project(taxi.x, 0, taxi.z);
    const b = project(taxi.x + dx * 6, 0, taxi.z + dz * 6);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }

  /** The grid direction whose road on screen best matches a swipe (sx, sy) in px. */
  function dirForSwipe(sx, sy) {
    const len = Math.hypot(sx, sy);
    let best = null;
    for (let d = 0; d < 4; d++) {
      const v = screenDir(d);
      const dot = (v.x * sx + v.y * sy) / len;
      if (!best || dot > best.dot) best = { d, dot };
    }
    return best.d;
  }

  // --- The two requests ------------------------------------------------------------------------

  /**
   * Take `d` at the next junction the taxi can choose at, and re-plan the rest from beyond it.
   * Refused (and counted) where `d` is not a legal exit there: a U-turn, off the map, a closed road.
   */
  function forceTurn(d) {
    const from = planOrigin(taxi);
    const net = cityNetwork();
    const out = net.laneOutByGrid(d, from.i, from.j);
    if (!legalExits(from.d, from.i, from.j).includes(d) || !out || !laneOpen(out)) {
      state.refused += 1;
      state.last = 'refused';
      say('✕ no road');
      return false;
    }
    const beyond = nextIntersection(d, from.i, from.j);
    const target = destination();
    let rest = [];
    if (target && beyond && (beyond.i !== target.i || beyond.j !== target.j)) {
      rest = findRoute({ i: beyond.i, j: beyond.j, d }, target) ?? [];
    }
    taxi.route = [d, ...rest];
    taxi.routeConsumed = false;
    taxi.lateTurn = null;
    taxi.parked = false;
    state.flicks += 1;
    state.last = 'turn';
    const rel = d === from.d ? 'straight' : d === rightOf(from.d) ? 'right' : 'left';
    say({ straight: '↑ straight on', right: '↱ right', left: '↰ left' }[rel]);
    return true;
  }

  function askUturn() {
    state.uturnFor = UTURN_TTL;
    state.last = 'uturn';
    say('⟲ turning round…');
  }

  /**
   * A swipe or a key. `rel` is 'left' | 'right' | 'straight' | 'back' relative to the heading at
   * the next choice; a swipe hands an absolute grid direction instead.
   */
  function request({ rel = null, d = null }) {
    if (!armed()) return;
    const from = planOrigin(taxi);
    if (d === null) {
      d = rel === 'straight' ? from.d
        : rel === 'right' ? rightOf(from.d)
          : rel === 'left' ? leftOf(from.d)
            : opposite(taxi.state === 'turn' ? taxi.dOut : taxi.d);
    }
    // Back down the road the taxi is on is the U-turn, whatever the next junction would say.
    const heading = taxi.state === 'turn' ? taxi.dOut : taxi.d;
    if (d === opposite(heading)) {
      if (flags.uturn) askUturn();
      return;
    }
    if (flags.flick) forceTurn(d);
  }

  // --- Input -----------------------------------------------------------------------------------

  if (any && typeof window !== 'undefined') {
    let press = null;
    window.addEventListener('pointerdown', (event) => {
      press = null;
      if (!event.isPrimary || !claimsSwipes()) return;
      if (canvas && event.target !== canvas) return;
      press = { x: event.clientX, y: event.clientY, t: performance.now(), owned: busyPointer() };
    }, { capture: true });
    window.addEventListener('pointermove', () => {
      if (press && busyPointer()) press.owned = true;
    }, { capture: true });
    window.addEventListener('pointerup', (event) => {
      const p = press;
      press = null;
      if (!p || p.owned) return;
      const sx = event.clientX - p.x;
      const sy = event.clientY - p.y;
      if (Math.hypot(sx, sy) < FLICK_MIN_PX || performance.now() - p.t > FLICK_MAX_MS) return;
      // Applied on the next frame, after anything else answering this pointerup has had its say.
      queued.push({ d: dirForSwipe(sx, sy) });
    }, { capture: true });
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      const rel = { KeyJ: 'left', KeyL: 'right', KeyI: 'straight', KeyK: 'back' }[event.code];
      if (rel) queued.push({ rel });
    });
  }

  // --- The frame -------------------------------------------------------------------------------

  /**
   * @param brakeHeld  the pedal is down
   * @returns {{ braking: boolean, turbo: boolean }} what main.js writes onto the taxi this frame —
   *          the brake the sim should see (a slide is not a brake) and whether the turbo is on
   */
  function update(dt, { brakeHeld = false } = {}) {
    while (queued.length) request(queued.shift());

    // U-turn: the sim's swing does the driving. Asked every frame while the request stands; a
    // started arc clears `uturnWanted` and empties the route, and the trip is re-planned from the
    // landing lane the frame after.
    if (state.uturnFor > 0) {
      state.uturnFor -= dt;
      taxi.uturnWanted = state.uturnFor > 0 && !taxi.crashed;
      if (taxi.uturn) state.uturnFor = 0;
      // Lapsed without a swing: no window on this road (an arterial, a bridge) or no room in it.
      else if (state.uturnFor <= 0) { state.refused += 1; say('✕ no room to turn'); }
    }
    if (taxi.uturn && !wasUturn) {
      state.uturns += 1;
      say('⟲ U-turn');
      const target = destination();
      const route = target ? findRoute(planOrigin(taxi), target) : null;
      taxi.route = route ?? [];
      taxi.routeConsumed = false;
    }
    wasUturn = Boolean(taxi.uturn);

    // Drift.
    let braking = brakeHeld;
    taxi.drifting = false;
    taxi.yawSlip = 0;
    if (flags.drift && !taxi.crashed && !taxi.staged) {
      const turning = taxi.state === 'turn' && taxi.dOut !== taxi.d;
      if (brakeHeld && turning && (taxi.v > DRIFT_MIN_V || state.charge !== null)) {
        state.charge = (state.charge ?? 0) + dt;
        state.afterArc = 0;
        braking = false;
        taxi.drifting = true;
        const along = Math.min(1, taxi.turnT);
        const hand = taxi.turn?.hand === 'right' ? 1 : -1;
        const ramp = Math.min(1, state.charge / DRIFT_FULL);
        taxi.yawSlip = hand * DRIFT_SLIP * ramp * Math.sin(Math.PI * along);
      } else if (state.charge !== null && brakeHeld) {
        // Out of the arc with the pedal still down: a short grace to let go in, then it is a brake.
        state.afterArc += dt;
        if (state.afterArc <= DRIFT_GRACE) { braking = false; taxi.drifting = true; }
        else state.charge = null;
      } else if (state.charge !== null) {
        const k = Math.min(1, state.charge / DRIFT_FULL);
        state.turbo = DRIFT_TURBO_MIN + (DRIFT_TURBO_MAX - DRIFT_TURBO_MIN) * k;
        state.drifts += 1;
        state.last = 'drift';
        say(k >= 1 ? '★ drift turbo!' : 'drift turbo');
        state.charge = null;
      }
    }
    if (state.turbo > 0) state.turbo = Math.max(0, state.turbo - dt);
    if (toastFor > 0) {
      toastFor -= dt;
      if (toastFor <= 0) toast.classList.remove('is-on');
    }
    return { braking, turbo: state.turbo > 0 };
  }

  return {
    flags,
    state,
    enabled: any,
    update,
    request,
    claimsSwipes,
    /** Drop everything held — a run ending, a pause. */
    reset() {
      queued.length = 0;
      state.uturnFor = 0;
      state.charge = null;
      state.turbo = 0;
      taxi.uturnWanted = false;
      taxi.drifting = false;
      taxi.yawSlip = 0;
    },
  };
}
