// "Crazy taxi" mode: a hold-to-enable burst of speed that drains a meter earned by driving fares.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.
//
// The meter does not refill on its own. Every drop of it is *earned* — the run opens with a third
// of a tank and each successful drop-off pours another third in — so a spent tank is a real cost
// and the only way back is to go work a fare. An earlier version trickled back up on its own
// (and fast-recharged from empty), which meant waiting was a valid way to get boost back and the
// meter said nothing about how the run was going.
//
// Releasing mid-spend just pauses the drain, so a short tap costs a short slice of fuel and a long
// hold keeps flowing until it runs out — the decision is *how long* to press as well as *when*.

export const BOOST_DURATION = 15;

// A third of a tank to open with, and a third earned per drop-off. Three deliveries is a full
// tank, and 5s of boost is enough to be worth spending on the run's first fare rather than being
// hoarded — a start from empty left the button dead in the hand until the first drop-off landed.
export const BOOST_START_FRACTION = 1 / 3;
export const BOOST_FARE_REWARD = 1 / 3;

export function createBoost(duration = BOOST_DURATION, startFraction = BOOST_START_FRACTION) {
  const state = {
    mode: 'ready',                     // 'ready' | 'active' | 'empty'
    fuel: duration * startFraction,    // seconds of boost still in the tank, 0..duration
    held: false,                       // is the button currently pressed?
    pending: 0,                        // fuel queued by top-ups, poured in over ~0.4s so the bar animates
  };

  // Half a tank per second. A one-third top-up lands in ~0.7s, slow enough to read as *filling*
  // rather than snapping, fast enough that it's obviously connected to the drop-off that
  // triggered it.
  const POUR_RATE = duration * 0.5;

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',
    isEmpty: () => state.mode === 'empty',

    /** Player started holding the button. Idempotent — safe to call every pointerdown. */
    press() {
      state.held = true;
      if (state.mode === 'ready' && state.fuel > 0) {
        state.mode = 'active';
        return true;
      }
      return false;
    },

    /** Player let go. Idempotent. Only pauses; the fuel that's left stays in the tank. */
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
      if (state.mode === 'active') state.fuel -= dt;

      // Bonus fuel pours in on top of whatever the mode is doing, so a top-up mid-drain slows the
      // drain visibly and a top-up on an empty tank refills it in front of the player.
      if (state.pending > 0) {
        const drip = Math.min(state.pending, POUR_RATE * dt);
        state.fuel += drip;
        state.pending -= drip;
      }

      // One clamp point covers both sources of change (drain, top-up).
      if (state.fuel <= 0) {
        state.fuel = 0;
        // Dry. 'empty' rather than 'ready' so the button can go dead and grey instead of looking
        // pressable — nothing but a drop-off gets it back.
        if (state.mode === 'active') state.mode = 'empty';
      } else if (state.mode === 'empty') {
        // A top-up landed on a dead tank. If the player never let go, roll straight back into
        // boost — the drop-off just handed them a live one, not a "press again" moment.
        state.mode = state.held ? 'active' : 'ready';
      } else if (state.fuel > duration) {
        state.fuel = duration;
      }
    },

    /** 0..1 of the dial that should be filled: drops while active, climbs while topping up. */
    fraction() {
      return state.fuel / duration;
    },
  };
}
