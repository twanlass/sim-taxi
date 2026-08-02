// "Crazy taxi" mode: a spendable burst of speed on a fixed duty cycle.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.

export const BOOST_DURATION = 15;
export const BOOST_RECHARGE = 15;

export function createBoost(duration = BOOST_DURATION, recharge = BOOST_RECHARGE) {
  // Starts on the charger, not ready. The first fare is the one that teaches the loop, and a
  // boost available from the first frame gets spent on it out of curiosity rather than judgement —
  // by the time the city is busy enough to need it, it's on cooldown. Making the player wait out
  // one full recharge puts the first press somewhere around the first drop-off instead.
  const state = { mode: 'recharging', remaining: recharge };

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',

    activate() {
      if (state.mode !== 'ready') return false;
      state.mode = 'active';
      state.remaining = duration;
      return true;
    },

    update(dt) {
      if (state.mode === 'ready') return;
      state.remaining -= dt;
      if (state.remaining > 0) return;
      // Runs its full length, then recharges its full length — no partial spend, so the decision
      // is purely *when* to press it.
      state.mode = state.mode === 'active' ? 'recharging' : 'ready';
      state.remaining = state.mode === 'recharging' ? recharge : 0;
    },

    /** 0..1 of the dial that should be filled: draining while active, filling while recharging. */
    fraction() {
      if (state.mode === 'active') return Math.max(0, state.remaining / duration);
      if (state.mode === 'recharging') return 1 - Math.max(0, state.remaining / recharge);
      return 1;
    },
  };
}
