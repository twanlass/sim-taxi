// "Crazy taxi" mode: a hold-to-enable burst of speed that drains a shared meter.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.
//
// The meter only moves while held (drains) or while empty (recharges). Releasing mid-spend just
// pauses it, so a short tap costs a short slice of fuel and a long hold keeps flowing until it
// runs out — the decision is now *how long* to press, not just *when*.

export const BOOST_DURATION = 15;
export const BOOST_RECHARGE = 15;

export function createBoost(duration = BOOST_DURATION, recharge = BOOST_RECHARGE) {
  // Starts on the charger, not ready. The first fare is the one that teaches the loop, and a
  // boost available from the first frame gets spent on it out of curiosity rather than judgement —
  // by the time the city is busy enough to need it, it's on cooldown. Making the player wait out
  // one full recharge puts the first hold somewhere around the first drop-off instead.
  const state = {
    mode: 'recharging',   // 'ready' | 'active' | 'recharging'
    fuel: 0,              // seconds of boost still in the tank, 0..duration
    held: false,          // is the button currently pressed?
  };

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

    update(dt) {
      if (state.mode === 'active') {
        state.fuel -= dt;
        if (state.fuel <= 0) {
          state.fuel = 0;
          state.mode = 'recharging';
        }
      } else if (state.mode === 'recharging') {
        state.fuel += dt * (duration / recharge);
        if (state.fuel >= duration) {
          state.fuel = duration;
          // Rolling through a full recharge without letting go re-engages boost, so a very long
          // hold flows through the recharge instead of dropping the player back at the button.
          state.mode = state.held ? 'active' : 'ready';
        }
      }
      // 'ready' is a paused meter — no drain, no fill, waits on the next press.
    },

    /** 0..1 of the dial that should be filled: drops while active, climbs while recharging. */
    fraction() {
      return state.fuel / duration;
    },
  };
}
