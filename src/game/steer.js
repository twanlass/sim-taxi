import { findRoute, planOrigin } from './route.js';
import { spinTaxi } from '../sim/traffic.js';

// Active steering for chases — a **prototype**, off unless `?steer=` asks for it.
//
// The complaint it answers: during a getaway or a patrol chase the only live input is the boost
// pill, and the patrol's own escape table (game/patrol.js) says the tank decides it — none spent is
// 15/16 caught, a full tank 14/16 lost.
//
// Three pieces, each switchable on its own:
//
//   uturn  The bootleg: in Loco Mode, tap the brake twice in quick succession and the taxi spins
//          round where it is, onto the far lane, in under half a second (`spinTaxi` in
//          sim/traffic.js). The first tap is an ordinary brake and drops the pill, but the boost's
//          one-second tail is still engaged, which is what the combo reads. Every cop sent ahead to
//          cut you off is suddenly behind you. K on a keyboard.
//   drift  Hold the brake through a real turn and it does not stop the car: the taxi slides round
//          the corner at its cornering speed and, let go on the way out, fires a short fuel-free
//          turbo sized by how long the slide was held. Boost becomes something you time.
//   los    Line of sight (game/patrol.js, game/robbery.js): a patrol that cannot see the taxi drives
//          to where it last saw it, and loses it after LOS_LOST_HOLD out of sight. The robbery's
//          cops only learn a redrawn route while one of them can see the taxi.
//
// The first build also had swipe-to-turn and swipe-back-to-U-turn. Playtested and dropped: a swipe
// on a phone is a pan, a route-band drag or a fare tap first, and an imprecise turn signal last.

/**
 * Which prototypes are on, from `?steer=`: a comma list of `uturn,drift,los`, or `all`.
 */
export function parseSteerFlags(search) {
  const raw = new URLSearchParams(search).get('steer');
  const flags = { uturn: false, drift: false, los: false };
  if (raw == null) return flags;
  const want = raw.split(',');
  if (raw === '' || want.includes('all') || want.includes('on')) {
    flags.uturn = flags.drift = flags.los = true;
  }
  for (const k of want) if (k in flags) flags[k] = true;
  return flags;
}

/** Two brake taps inside this, in ms, are the combo. A deliberate double tap is ~150-250ms. */
const COMBO_GAP_MS = 350;
/**
 * How long a combo that lands mid-junction (or mid-overtake) waits to be spent, in seconds. A spin
 * needs a straight lane under it, and the taxi is crossing a junction ~40% of the time at chase
 * speed — refusing those taps measured as the commonest refusal of all. The crossing takes ~0.4s
 * at the Loco top, so this covers it with room.
 */
const SPIN_BUFFER = 0.7;
/** Slower than this and there is nothing to spin: a standing car turning round is a three-point turn. */
const SPIN_MIN_V = 4;
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

const REFUSED = { median: '✕ median', bridge: '✕ bridge', short: '✕ no room', road: '✕ can’t here' };

/**
 * @param flags        parseSteerFlags()
 * @param taxi         the traffic model's taxi
 * @param destination  () => {i, j} | null — what the trip re-plans to after a spin
 * @param onSpin       () => void — the spin started: main.js puts the noise, the shake, the haptic on it
 */
export function createSteer({ flags, taxi, destination = () => null, onSpin = () => {} }) {
  const any = flags.uturn || flags.drift || flags.los;
  const state = {
    /** Tallies, for the tools. */
    spins: 0,
    refused: 0,
    drifts: 0,
    /** The last brake tap: when, and whether Loco Mode was engaged at it. */
    lastTap: null,
    /** The slide in progress: seconds of charge, or null. */
    charge: null,
    /** Seconds since the arc ended with the slide still held. */
    afterArc: 0,
    /** Seconds of turbo left. */
    turbo: 0,
    /** A spin owns the brake until it comes back up — see `update`. */
    holdOff: false,
    /** Seconds a buffered spin has left — see SPIN_BUFFER. */
    spinPending: 0,
    /** Why the last spin was refused, for the tools. */
    why: null,
    last: null,
  };
  let wasSpinning = false;

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

  const refuse = (why, text) => { state.refused += 1; state.why = why; say(text); return false; };

  /**
   * Spin now, whatever led here. Answers whether it went. A taxi between lanes — in a junction, out
   * on an overtake — holds the request for SPIN_BUFFER and spins the moment it is back on one.
   */
  function spin({ buffer = true } = {}) {
    if (!flags.uturn) return false;
    if (taxi.v < SPIN_MIN_V) return refuse('slow', '✕ too slow');
    const why = spinTaxi(taxi);
    if (why === 'road' && buffer && (taxi.state === 'turn' || taxi.pass > 0 || taxi.passing)) {
      state.spinPending = SPIN_BUFFER;
      return false;
    }
    if (why) return refuse(why, REFUSED[why] ?? REFUSED.road);
    state.spinPending = 0;
    state.spins += 1;
    state.last = 'spin';
    state.holdOff = true;
    state.charge = null;
    say('⟲ BOOTLEG!');
    onSpin();
    return true;
  }

  if (flags.uturn && typeof window !== 'undefined') {
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyK' && !event.repeat) spin();
    });
  }

  return {
    flags,
    state,
    enabled: any,
    spin,
    /**
     * The brake pedal went down — main.js's `holdBrake`, before it releases the pill. `engaged` is
     * Loco Mode as it stood *before* this press. Answers whether the press completed the combo.
     */
    brakeTap({ engaged }) {
      if (!flags.uturn) return false;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const prev = state.lastTap;
      state.lastTap = { at: now, engaged };
      if (prev && prev.engaged && now - prev.at <= COMBO_GAP_MS) {
        state.lastTap = null;
        return spin();
      }
      return false;
    },

    /**
     * @param brakeHeld  the pedal is down
     * @returns {{ braking: boolean, turbo: boolean }} what main.js writes onto the taxi this frame —
     *          the brake the sim should see (a slide is not a brake) and whether the turbo is on
     */
    update(dt, { brakeHeld = false } = {}) {
      // A spin was asked for with the pedal, and the pedal is very likely still down when it lands.
      // Braking out of the spin would stop the taxi broadside on the far lane: the brake is ignored
      // until it comes back up.
      if (state.spinPending > 0) {
        state.spinPending -= dt;
        if (taxi.state === 'drive' && !(taxi.pass > 0) && !taxi.passing) spin({ buffer: false });
        else if (state.spinPending <= 0) refuse('road', REFUSED.road);
      }
      if (!brakeHeld) state.holdOff = false;
      let braking = brakeHeld && !state.holdOff;

      // After a spin, re-plan the trip from the lane it landed on.
      if (taxi.uturn?.kind !== 'spin' && wasSpinning) {
        const target = destination();
        const route = target ? findRoute(planOrigin(taxi), target) : null;
        taxi.route = route ?? [];
        taxi.routeConsumed = false;
      }
      wasSpinning = taxi.uturn?.kind === 'spin';

      // Drift.
      taxi.drifting = false;
      taxi.yawSlip = 0;
      if (flags.drift && braking && !taxi.crashed && !taxi.staged) {
        const turning = taxi.state === 'turn' && taxi.dOut !== taxi.d;
        if (turning && (taxi.v > DRIFT_MIN_V || state.charge !== null)) {
          state.charge = (state.charge ?? 0) + dt;
          state.afterArc = 0;
          braking = false;
          taxi.drifting = true;
          const along = Math.min(1, taxi.turnT);
          const hand = taxi.turn?.hand === 'right' ? 1 : -1;
          const ramp = Math.min(1, state.charge / DRIFT_FULL);
          taxi.yawSlip = hand * DRIFT_SLIP * ramp * Math.sin(Math.PI * along);
        } else if (state.charge !== null) {
          // Out of the arc with the pedal still down: a short grace to let go in, then it is a brake.
          state.afterArc += dt;
          if (state.afterArc <= DRIFT_GRACE) { braking = false; taxi.drifting = true; }
          else state.charge = null;
        }
      } else if (state.charge !== null) {
        const k = Math.min(1, state.charge / DRIFT_FULL);
        state.turbo = DRIFT_TURBO_MIN + (DRIFT_TURBO_MAX - DRIFT_TURBO_MIN) * k;
        state.drifts += 1;
        state.last = 'drift';
        state.charge = null;
        say(k >= 1 ? '★ drift turbo!' : 'drift turbo');
      }
      if (state.turbo > 0) state.turbo = Math.max(0, state.turbo - dt);
      if (toastFor > 0) {
        toastFor -= dt;
        if (toastFor <= 0) toast.classList.remove('is-on');
      }
      return { braking, turbo: state.turbo > 0 };
    },

    /** Drop everything held — a run ending, a pause. */
    reset() {
      state.lastTap = null;
      state.spinPending = 0;
      state.charge = null;
      state.turbo = 0;
      state.holdOff = false;
      taxi.drifting = false;
      taxi.yawSlip = 0;
    },
  };
}
