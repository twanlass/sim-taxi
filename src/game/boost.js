// "Crazy taxi" mode: a hold-to-enable burst of speed that drains a shared meter.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.
//
// Releasing mid-spend just pauses the drain, so a short tap costs a short slice of fuel and a
// long hold keeps flowing until it runs out — the decision is *how long* to press as well as
// *when*. A partial tank left idle also trickles back up (see SLOW_REGEN_FACTOR), so short taps
// don't leave the meter stranded, while a full drain still calls for the fast empty-recharge.

export const BOOST_DURATION = 15;
export const BOOST_RECHARGE = 15;

// Idle trickle when the button isn't held and the tank is partial. 1/5 of the empty-recharge
// rate — a full tank from idle takes 75s, so the fast recharge (15s from empty) is still the
// right move if you want to top up quickly; this just keeps a half-spent meter from sitting
// there forever after a couple of short taps.
const SLOW_REGEN_FACTOR = 0.2;

export function createBoost(duration = BOOST_DURATION, recharge = BOOST_RECHARGE) {
  // Starts on the charger, not ready. The first fare is the one that teaches the loop, and a
  // boost available from the first frame gets spent on it out of curiosity rather than judgement —
  // by the time the city is busy enough to need it, it's on cooldown. Making the player wait out
  // one full recharge puts the first hold somewhere around the first drop-off instead.
  const state = {
    mode: 'recharging',   // 'ready' | 'active' | 'recharging'
    fuel: 0,              // seconds of boost still in the tank, 0..duration
    held: false,          // is the button currently pressed?
    pending: 0,           // fuel queued by top-ups, poured in over ~0.4s so the bar animates
  };

  // Half a tank per second. A 15% top-up lands in ~0.3s, slow enough to read as *filling* rather
  // than snapping, fast enough that it's obviously connected to the drop-off that triggered it.
  const POUR_RATE = duration * 0.5;

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',

    /** Player started holding the button. Idempotent — safe to call every pointerdown. */
    press() {
      state.held = true;
      if (state.mode === 'ready' && state.fuel > 0) {
        state.mode = 'active';
        return true;
      }
      return false;
    },

    /** Player let go. Idempotent. Only pauses; recharge waits until the tank hits empty. */
    release() {
      state.held = false;
      if (state.mode === 'active') state.mode = 'ready';
    },

    /**
     * Queue a fuel top-up (fraction of a full tank). Drips in over time so the meter *fills* on
     * screen rather than snapping — the animation is how the player sees they got a bonus.
     */
    topUp(fraction) {
      if (fraction <= 0) return;
      state.pending += fraction * duration;
    },

    update(dt) {
      // Mode-driven change first: drain while held, fast refill while empty, slow trickle when
      // idle with a partial tank.
      if (state.mode === 'active') {
        state.fuel -= dt;
      } else if (state.mode === 'recharging') {
        state.fuel += dt * (duration / recharge);
      } else if (state.mode === 'ready' && state.fuel < duration) {
        state.fuel += dt * (duration / recharge) * SLOW_REGEN_FACTOR;
      }

      // Bonus fuel pours in on top of whatever the mode is doing, so a top-up mid-drain slows the
      // drain visibly and a top-up mid-recharge accelerates the fill.
      if (state.pending > 0) {
        const drip = Math.min(state.pending, POUR_RATE * dt);
        state.fuel += drip;
        state.pending -= drip;
      }

      // One clamp point covers all three sources of change (drain, refill, top-up).
      if (state.fuel <= 0) {
        state.fuel = 0;
        if (state.mode === 'active') state.mode = 'recharging';
      } else if (state.fuel >= duration) {
        state.fuel = duration;
        if (state.mode === 'recharging') {
          // A recharge that finishes while the button is still held rolls straight back into
          // boost — same reason a top-up that finishes a recharge should feel like the drop-off
          // just handed the player a live boost, not a "press again" moment.
          state.mode = state.held ? 'active' : 'ready';
        }
      }
    },

    /** 0..1 of the dial that should be filled: drops while active, climbs while recharging. */
    fraction() {
      return state.fuel / duration;
    },
  };
}
