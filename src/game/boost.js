// "Crazy taxi" mode: a hold-to-enable burst of speed that drains a meter earned by driving fares.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.
//
// The meter does not refill on its own. Every drop of it is *earned* — the run opens with a third
// of a tank, each successful drop-off pours another third in, and a package delivered pours half of
// that — so a spent tank is a real cost and the only way back is to go do a job. An earlier version
// trickled back up on its own (and fast-recharged from empty), which meant waiting was a valid way
// to get boost back and the meter said nothing about how the run was going.
//
// Releasing mid-spend just pauses the drain, so a short tap costs a short slice of fuel and a long
// hold keeps flowing until it runs out — the decision is *how long* to press as well as *when*.

export const BOOST_DURATION = 15;

// A third of a tank to open with, and a third earned per drop-off. Three deliveries is a full
// tank, and 5s of boost is enough to be worth spending on the run's first fare rather than being
// hoarded — a start from empty left the button dead in the hand until the first drop-off landed.
export const BOOST_START_FRACTION = 1 / 3;
export const BOOST_FARE_REWARD = 1 / 3;

// A package pays half what a rider does: 2.5s of boost, six deliveries to a full tank. Half rather
// than a third keeps the fare the thing that fuels the run — a courier detour still has not
// delivered anybody — while giving the errand something the cash alone could not, since the payout
// is deliberately small enough that greed is punished by arithmetic (see docs/gameplay.md). A sixth
// is also the smallest slice the pill's pour animation still reads as *filling* rather than
// twitching: ~0.35s of pour at POUR_RATE, against the ~0.7s a fare's third takes.
export const BOOST_PARCEL_REWARD = 1 / 6;

// Releasing used to drop straight back to 'ready' and take every boost-only rule (collision,
// police bust range, running reds) with it in the same frame — you could floor it at a cop or a
// bumper and bail out a frame before impact with zero risk. This is the window that closes
// instead: the taxi keeps behaving like it's boosting for one more second, so letting go mid-risk
// is a real decision rather than a free undo. See `isEngaged` for what stays active through it,
// and `isActive` for what doesn't (the taxi's actual speed cap eases back over the same second —
// see `fullPower` in traffic.js).
export const BOOST_COOLDOWN = 1;

export function createBoost(duration = BOOST_DURATION, startFraction = BOOST_START_FRACTION,
  cooldown = BOOST_COOLDOWN) {
  const state = {
    mode: 'ready',                     // 'ready' | 'active' | 'cooldown' | 'empty'
    fuel: duration * startFraction,    // seconds of boost still in the tank, 0..duration
    held: false,                       // is the button currently pressed?
    pending: 0,                        // fuel queued by top-ups, poured in over ~0.7s so the bar animates
    cooldownLeft: 0,                   // seconds still owed on the post-release momentum window
  };

  // Leaving 'active' for any reason — letting go or running the tank dry — passes through here
  // first instead of landing straight on 'ready'/'empty'.
  function enterCooldown() {
    state.mode = 'cooldown';
    state.cooldownLeft = cooldown;
  }

  // Half a tank per second. A one-third top-up lands in ~0.7s, slow enough to read as *filling*
  // rather than snapping, fast enough that it's obviously connected to the drop-off that
  // triggered it.
  const POUR_RATE = duration * 0.5;

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',
    isCoolingDown: () => state.mode === 'cooldown',
    isEmpty: () => state.mode === 'empty',
    // What the taxi's boost-only rules (collision, police bust range, running reds) key off —
    // true for the hold itself and for the one-second tail after it, false the moment that tail
    // runs out.
    isEngaged: () => state.mode === 'active' || state.mode === 'cooldown',

    /** Player started holding the button. Idempotent — safe to call every pointerdown. */
    press() {
      state.held = true;
      // A re-press mid-cooldown catches the car before the window closes and snaps it straight
      // back to full send — same transition-into-boost feel (wheelie, flame, kick) as a fresh
      // press, just without having let it fully coast back down first.
      if ((state.mode === 'ready' || state.mode === 'cooldown') && state.fuel > 0) {
        state.mode = 'active';
        state.cooldownLeft = 0;
        return true;
      }
      return false;
    },

    /** Player let go. Idempotent. Starts the cooldown; the fuel that's left stays in the tank. */
    release() {
      state.held = false;
      if (state.mode === 'active') enterCooldown();
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
      if (state.mode === 'active') {
        state.fuel -= dt;
      } else if (state.mode === 'cooldown') {
        // Frozen, same as a plain release used to leave it — the tank doesn't drain until the
        // momentum window has run out.
        state.cooldownLeft -= dt;
        if (state.cooldownLeft <= 0) {
          state.cooldownLeft = 0;
          if (state.fuel <= 0) state.mode = 'empty';
          else if (state.held) state.mode = 'active';   // re-pressed and still owed fuel
          else state.mode = 'ready';
        }
      }

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
        // Running the tank dry gets the same momentum tail as letting go on purpose — the taxi
        // was still at full tilt the frame the fuel ran out, so it still deserves the coast-down.
        // 'empty' comes after that tail, and it's where the button goes dead and grey rather than
        // looking pressable: nothing but a drop-off gets it back.
        if (state.mode === 'active') enterCooldown();
      } else {
        if (state.fuel > duration) state.fuel = duration;
        // A top-up landed on a dead tank. If the player never let go, roll straight back into
        // boost — the drop-off just handed them a live one, not a "press again" moment. A tank
        // refilled mid-cooldown needs nothing here: the window's own expiry already picks the
        // right mode now that there's fuel again.
        if (state.mode === 'empty') state.mode = state.held ? 'active' : 'ready';
      }
    },

    /** 0..1 of the dial that should be filled: drops while active, climbs while topping up. */
    fraction() {
      return state.fuel / duration;
    },
  };
}
