// "Crazy taxi" mode: a hold-to-enable burst of speed. Hold it, get it; let go, lose it.
//
// Kept as a pure clock with no knowledge of the taxi or the DOM, so the sim, the button and the
// headless tests can all read the same state without any of them owning it.
//
// **There is no tank.** Nitro used to be a consumable — a 15-second meter that opened at a third
// full, was topped up by drop-offs, packages and the drive-through, and left the pill grey and
// dead when it ran out. That version made the button a resource-management question ("can I
// afford this?") layered on top of the driving one ("should I be going this fast here?"), and the
// second question is the interesting one. Free nitro asks it every corner instead of once a tank.
//
// What still costs something is the *risk*: collision detection, police bust range and running
// reds are all armed for as long as the mode is engaged (see `isEngaged` and the cooldown below),
// so flooring it into traffic is as expensive as it ever was. The price moved from the meter onto
// the road.
//
// Releasing is still a real decision because of that tail — a short tap and a long hold expose the
// taxi for different lengths of time.

// Releasing used to drop straight back to 'ready' and take every boost-only rule (collision,
// police bust range, running reds) with it in the same frame — you could floor it at a cop or a
// bumper and bail out a frame before impact with zero risk. This is the window that closes
// instead: the taxi keeps behaving like it's boosting for one more second, so letting go mid-risk
// is a real decision rather than a free undo. See `isEngaged` for what stays active through it,
// and `isActive` for what doesn't (the taxi's actual speed cap eases back over the same second —
// see `fullPower` in traffic.js).
export const BOOST_COOLDOWN = 1;

export function createBoost(cooldown = BOOST_COOLDOWN) {
  const state = {
    mode: 'ready',                     // 'ready' | 'active' | 'cooldown'
    held: false,                       // is the button currently pressed?
    cooldownLeft: 0,                   // seconds still owed on the post-release momentum window
    // How long the button has been down *without letting go*, in seconds. Zero whenever it isn't.
    // The clock exists because a tap and a hold are two different inputs here (see the note at the
    // top of this file) and one of them — the camera's push-in, see LOCO_PUNCH in game/camera.js —
    // is only allowed to answer the second. Counted against sim time like everything else in
    // `update`, so it stops with a paused run rather than banking the length of the pause.
    heldFor: 0,
  };

  // Leaving 'active' passes through here first instead of landing straight back on 'ready'.
  function enterCooldown() {
    state.mode = 'cooldown';
    state.cooldownLeft = cooldown;
  }

  return {
    state,
    isActive: () => state.mode === 'active',
    isReady: () => state.mode === 'ready',
    isCoolingDown: () => state.mode === 'cooldown',
    // What the taxi's boost-only rules (collision, police bust range, running reds) key off —
    // true for the hold itself and for the one-second tail after it, false the moment that tail
    // runs out.
    isEngaged: () => state.mode === 'active' || state.mode === 'cooldown',

    /**
     * How long the current hold has run, in seconds — 0 the moment the button comes up. A raw
     * reading rather than a verdict: what counts as "long enough to be a hold" is a feel constant
     * belonging to whatever is reacting, so it lives there (LOCO_PUNCH_HOLD in game/camera.js).
     */
    heldSeconds: () => (state.held ? state.heldFor : 0),

    /** Player started holding the button. Idempotent — safe to call every pointerdown. */
    press() {
      // Only a *fresh* press restarts the clock. press() is idempotent by contract and a re-press
      // mid-boost is a real gesture (it snaps a cooling car back to full send), so zeroing this
      // unconditionally would let a player who taps the pill during their own hold knock the
      // camera back out of its push-in.
      if (!state.held) state.heldFor = 0;
      state.held = true;
      // A re-press mid-cooldown catches the car before the window closes and snaps it straight
      // back to full send — same transition-into-boost feel (wheelie, flame, kick) as a fresh
      // press, just without having let it fully coast back down first.
      if (state.mode === 'ready' || state.mode === 'cooldown') {
        state.mode = 'active';
        state.cooldownLeft = 0;
        return true;
      }
      return false;
    },

    /** Player let go. Idempotent. Starts the cooldown. */
    release() {
      state.held = false;
      state.heldFor = 0;
      if (state.mode === 'active') enterCooldown();
    },

    update(dt) {
      if (state.held) state.heldFor += dt;

      if (state.mode === 'cooldown') {
        state.cooldownLeft -= dt;
        if (state.cooldownLeft <= 0) {
          state.cooldownLeft = 0;
          // A press that arrived during the window is honoured on its way out rather than being
          // dropped: `press()` already re-entered 'active' for it, so this only catches the case
          // where the pedal went back down without a fresh press reaching the clock.
          state.mode = state.held ? 'active' : 'ready';
        }
      }
    },
  };
}
