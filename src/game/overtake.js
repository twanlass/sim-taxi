// The overtake combo: Loco Mode behind a car, a quick blip off the pill and back on, and the taxi
// pulls out and goes round. Without it, holding Loco behind a car tailgates it.
//
// The pass itself is the traffic model's (the pass block in sim/traffic.js). This only decides
// whether it is *allowed* to start, through `taxi.passArmed`: undefined is the old rule (holding
// is enough), which the passing lab and the probe still drive; a boolean is this combo. Once a pass
// is under way it runs to the end for as long as the pill stays down, chaining past whatever else
// is inside PASS_SUSTAIN the way it always has — letting go still tucks the taxi back in. A pass
// that ends spends the combo, so the next car wants another blip.
//
// Polled per frame off the button state rather than hooked to the press and the release, because
// `boost.release()` is called from a dozen places (pause, the depot, the drive-through) that are
// not the player lifting a thumb, and a sub-frame blip is not something a thumb can do. Counted in
// sim time, so a pause in the middle of the gesture neither completes nor expires it.
//
// **Not the drift.** Loco, a brake tap, Loco is also off-and-on-again on the pill — the brake
// releases it ("last pedal pressed wins"). Any brake inside the gap means the gesture was the drift
// or the bootleg, and it does not arm.
//
// First guesses, not measurements — tune here.

/** A release this short or shorter, then the pill again, is the blip. A deliberate one is ~100-200ms. */
export const OVERTAKE_BLIP_MS = 250;
/**
 * How long the pill has to have been down before the blip, in seconds — "holding Loco behind a
 * car" rather than tapping it. Keeps a player stabbing at the pill from a standstill from arming it.
 */
export const OVERTAKE_PRE_HOLD = 0.2;
/**
 * Behind a car means a leader within this many units, at the release and at the re-press. Wider
 * than the 4.5-unit tailgate because the taxi eases off during the blip and the gap opens a little,
 * and wider than PASS_TRIGGER (10) so a blip on the approach still counts: the taxi closes the rest
 * and pulls out as it gets there.
 */
export const OVERTAKE_ARM_RANGE = 16;
/** An armed combo that has not pulled out inside this many seconds lapses — no road, or the car turned off. */
export const OVERTAKE_ARM_WINDOW = 1.0;

/**
 * @param taxi  the traffic model's taxi; reads `passGap` and `passing`, writes `passArmed`
 */
export function createOvertakeCombo({ taxi }) {
  const state = {
    armed: false,
    /** Seconds an armed combo has left to start its pass. */
    armLeft: 0,
    /** Tallies, for the tools. */
    arms: 0,
  };
  let wasHeld = false;
  let heldFor = 0;
  /** The release that might be the first half: sim seconds since, or null. */
  let blip = null;
  let wasPassing = false;

  const behind = () => (taxi.passGap ?? Infinity) < OVERTAKE_ARM_RANGE;

  function reset() {
    state.armed = false;
    state.armLeft = 0;
    wasHeld = false;
    heldFor = 0;
    blip = null;
    wasPassing = false;
    taxi.passArmed = false;
  }

  /**
   * @param held       the pill is down this frame (the hold, not the cooldown tail)
   * @param brakeHeld  the brake pedal is down
   */
  function update(dt, { held, brakeHeld = false }) {
    if (held && !wasHeld) {
      if (blip !== null && blip <= OVERTAKE_BLIP_MS / 1000 && behind()) {
        state.armed = true;
        state.armLeft = OVERTAKE_ARM_WINDOW;
        state.arms += 1;
      }
      blip = null;
      heldFor = 0;
    } else if (!held && wasHeld) {
      blip = heldFor >= OVERTAKE_PRE_HOLD && behind() ? 0 : null;
      state.armed = false;
    } else if (held) {
      heldFor += dt;
    } else if (blip !== null) {
      blip += dt;
    }
    if (brakeHeld) blip = null;
    wasHeld = held;

    // A pass under way holds the combo; one that ends spends it.
    if (taxi.passing) state.armLeft = OVERTAKE_ARM_WINDOW;
    else if (wasPassing) state.armed = false;
    // Not counted through a junction: a pass is only decided on a lane (traffic.js), so an arm
    // thrown mid-crossing waits for the far side rather than lapsing in the box.
    else if (state.armed && taxi.state === 'drive' && (state.armLeft -= dt) <= 0) state.armed = false;
    wasPassing = Boolean(taxi.passing);

    taxi.passArmed = state.armed;
  }

  return { state, update, reset };
}
