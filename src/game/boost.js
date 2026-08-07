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

// Releasing used to drop straight back to 'ready' and take every boost-only rule (collision,
// police bust range, running reds) with it in the same frame — you could floor it at a cop or a
// bumper and bail out a frame before impact with zero risk. This is the window that closes
// instead: the taxi keeps behaving like it's boosting for one more second, so letting go mid-risk
// is a real decision rather than a free undo. See `isEngaged` for what stays active through it,
// and `isActive` for what doesn't (the taxi's actual speed cap eases back over the same second —
// see `fullPower` in traffic.js).
export const BOOST_COOLDOWN = 1;

// Idle trickle when the button isn't held and the tank is partial. 1/5 of the empty-recharge
// rate — a full tank from idle takes 75s, so the fast recharge (15s from empty) is still the
// right move if you want to top up quickly; this just keeps a half-spent meter from sitting
// there forever after a couple of short taps.
const SLOW_REGEN_FACTOR = 0.2;

export function createBoost(duration = BOOST_DURATION, recharge = BOOST_RECHARGE, cooldown = BOOST_COOLDOWN) {
  // Starts full and ready — the player can hold Loco Mode from the very first frame. Trades the
  // "learn the loop before you get the toy" pacing for immediate access to the crazy-taxi feel.
  const state = {
    mode: 'ready',        // 'ready' | 'active' | 'cooldown' | 'recharging'
    fuel: duration,       // seconds of boost still in the tank, 0..duration
    held: false,          // is the button currently pressed?
    pending: 0,           // fuel queued by top-ups, poured in over ~0.4s so the bar animates
    cooldownLeft: 0,      // seconds still owed on the post-release momentum window
  };

  // Leaving 'active' for any reason — letting go or running the tank dry — passes through here
  // first instead of landing straight on 'ready'/'recharging'.
  function enterCooldown() {
    state.mode = 'cooldown';
    state.cooldownLeft = cooldown;
  }

  // Half a tank per second. A 15% top-up lands in ~0.3s, slow enough to read as *filling* rather
  // than snapping, fast enough that it's obviously connected to the drop-off that triggered it.
  const POUR_RATE = duration * 0.5;

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',
    isCoolingDown: () => state.mode === 'cooldown',
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

    /** Player let go. Idempotent. Starts the cooldown; recharge waits until the tank hits empty. */
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
      // Mode-driven change first: drain while held, fast refill while empty, slow trickle when
      // idle with a partial tank.
      if (state.mode === 'active') {
        state.fuel -= dt;
      } else if (state.mode === 'recharging') {
        state.fuel += dt * (duration / recharge);
      } else if (state.mode === 'ready' && state.fuel < duration) {
        state.fuel += dt * (duration / recharge) * SLOW_REGEN_FACTOR;
      } else if (state.mode === 'cooldown') {
        // Frozen, same as a plain release used to leave it — the tank neither drains nor
        // trickles until the momentum window has run out.
        state.cooldownLeft -= dt;
        if (state.cooldownLeft <= 0) {
          state.cooldownLeft = 0;
          if (state.fuel <= 0) state.mode = 'recharging';
          else if (state.held) state.mode = 'active'; // re-pressed and still owed fuel
          else state.mode = 'ready';
        }
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
        // Running the tank dry gets the same momentum tail as letting go on purpose — the taxi
        // was still at full tilt the frame the fuel ran out, so it still deserves the coast-down.
        if (state.mode === 'active') enterCooldown();
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
