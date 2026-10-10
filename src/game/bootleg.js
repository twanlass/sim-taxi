import { findRoute, planOrigin } from './route.js';
import { spinTaxi } from '../sim/traffic.js';

// The bootleg: in Loco Mode, tap the brake twice in quick succession and the taxi spins round where
// it is, onto the far lane, in under half a second (`spinTaxi` in sim/traffic.js).
//
// It exists because a chase had one live input — the boost pill — and nothing that turned the
// situation round. The robbery's cut-off cops sit in the junctions *ahead* of the taxi
// (game/robbery.js); a 180 puts every one of them behind it.
//
// **Why a brake combo.** The first prototype was a swipe back down the road, and a swipe on a
// phone is a pan, a route-band drag or a fare tap first: it fought all three and read as imprecise.
// The pedals are already under the thumb and already one control surface (the pedal slide), and
// "boost, then stab the brake twice" is the motion of a handbrake turn.
//
// **Why it reads Loco Mode as *engaged* rather than held.** The first tap is an ordinary brake, and
// `holdBrake` releases the pill on it ("last pedal pressed wins") — so by the second tap the pill is
// up. What survives is its one-second tail (BOOST_COOLDOWN in game/boost.js), which `isEngaged`
// covers, and which is longer than the combo window. That also means a player who has *just* let
// go of the pill can still pull it.
//
// It is a prototype, playtested once on the deploy preview ("working really well"), not measured:
// the speeds and the window are first guesses that felt right.

/** Two brake taps inside this, in ms, are the combo. A deliberate double tap is ~150-250ms. */
export const COMBO_GAP_MS = 350;
/** Slower than this and there is nothing to spin: a standing car turning round is a three-point turn. */
const SPIN_MIN_V = 4;
/**
 * How long a combo that lands mid-junction (or mid-overtake) waits to be spent, in seconds. A spin
 * needs a straight lane under it, and the taxi is crossing a junction ~40% of the time at chase
 * speed — refusing those taps was the commonest refusal of all over a bot sweep of staged chases.
 * The crossing takes ~0.4s at the Loco top, so this covers it with room.
 */
const SPIN_BUFFER = 0.7;

/**
 * @param taxi         the traffic model's taxi
 * @param destination  () => {i, j} | null — what the trip re-plans to after a spin
 * @param onSpin       () => void — the spin started: main.js puts the noise, the shake, the haptic on it
 */
export function createBootleg({ taxi, destination = () => null, onSpin = () => {} }) {
  const state = {
    /** Tallies, for the tools. */
    spins: 0,
    refused: 0,
    /** Why the last spin was refused (`spinTaxi`'s answer, or 'slow'), for the tools. */
    why: null,
    /** The last brake tap: when, and whether Loco Mode was engaged at it. */
    lastTap: null,
    /** The taxi's speed at the first tap of the combo — what the handbrake turn goes in at. */
    entry: 0,
    /** Seconds a buffered spin has left — see SPIN_BUFFER. */
    pending: 0,
    /** A spin owns the brake until it comes back up — see `update`. */
    holdOff: false,
  };
  let wasSpinning = false;

  const refuse = (why) => { state.refused += 1; state.why = why; state.pending = 0; return false; };

  /**
   * Spin now. Answers whether it went. A taxi between lanes — in a junction, out on an overtake —
   * holds the request for SPIN_BUFFER and spins the moment it is back on one. A refusal is silent:
   * the second tap was a brake press, and it brakes.
   */
  function spin({ buffer = true } = {}) {
    if (taxi.v < SPIN_MIN_V) return refuse('slow');
    // The speed from before the first tap, which the brake has been eating since.
    const why = spinTaxi(taxi, Math.max(taxi.v, state.entry));
    if (why === 'road' && buffer && (taxi.state === 'turn' || taxi.pass > 0 || taxi.passing)) {
      state.pending = SPIN_BUFFER;
      return false;
    }
    if (why) return refuse(why);
    state.pending = 0;
    state.spins += 1;
    state.holdOff = true;
    onSpin();
    return true;
  }

  return {
    state,
    spin,
    /**
     * The brake pedal went down — main.js's `holdBrake`, before it releases the pill. `engaged` is
     * Loco Mode as it stood *before* this press. Answers whether the press completed the combo.
     */
    brakeTap({ engaged }) {
      const now = performance.now();
      const prev = state.lastTap;
      state.lastTap = { at: now, engaged, v: taxi.v };
      if (prev && prev.engaged && now - prev.at <= COMBO_GAP_MS) {
        state.lastTap = null;
        state.entry = prev.v ?? 0;
        return spin();
      }
      return false;
    },

    /**
     * @param brakeHeld  the pedal is down
     * @returns the brake the sim should see this frame
     */
    update(dt, { brakeHeld = false } = {}) {
      if (state.pending > 0) {
        state.pending -= dt;
        if (taxi.state === 'drive' && !(taxi.pass > 0) && !taxi.passing) spin({ buffer: false });
        else if (state.pending <= 0) refuse('road');
      }
      // The spin was asked for with the pedal, and the pedal is very likely still down when it
      // lands. Braking out of it would stop the taxi broadside on the far lane, so the brake is
      // ignored until it comes back up.
      if (!brakeHeld) state.holdOff = false;

      // Landed: re-plan the trip from the lane it is on now. `spinTaxi` empties the route, because
      // the one it had runs the other way.
      const spinning = taxi.uturn?.kind === 'spin';
      if (wasSpinning && !spinning) {
        const target = destination();
        const route = target ? findRoute(planOrigin(taxi), target) : null;
        taxi.route = route ?? [];
        taxi.routeConsumed = false;
      }
      wasSpinning = spinning;

      return brakeHeld && !state.holdOff;
    },

    /** Drop anything half-done — a pause, a run ending. */
    reset() {
      state.lastTap = null;
      state.entry = 0;
      state.pending = 0;
      state.holdOff = false;
    },
  };
}
