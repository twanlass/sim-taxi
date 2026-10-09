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

/**
 * A release this short or shorter, then the pill again, is the blip. It was 250, and that was a
 * cliff: a bot throwing the combo with a 300ms release passed **0 of 118** cars against 46 of 98 at
 * 180ms, and a thumb lifting and landing on a phone pill is 150-350ms. 400 takes in a relaxed lift
 * and is still well short of a release meant as a release — that runs to the cooldown tail (1s).
 */
export const OVERTAKE_BLIP_MS = 400;
/**
 * How long the pill has to have been down before the blip, in seconds. It was 0.2, to keep a player
 * stabbing at the pill from arming it, and that also meant a quick tap, tap-and-hold behind a car
 * did nothing — the first tap ended too soon to count. Tyler wanted that to throw it (2026-10-07):
 * a double tap behind a car is deliberate, and the car still has to be within OVERTAKE_ARM_RANGE.
 */
export const OVERTAKE_PRE_HOLD = 0;
/**
 * Behind a car means a leader within this many units, at the release and at the re-press. Since a
 * taxi held behind a car without the combo rams it (`canPass` in sim/traffic.js), this is the
 * player's whole reaction window, and it was 16 at first: measured over 16 cities × 40s with the
 * button held, a car went from 16 units off to rammed in a median of 0.52s (p10 0.23s), which is
 * less than the gesture itself takes with OVERTAKE_PRE_HOLD in front of it. 30 adds the ~1.5s it
 * takes to close the extra 14 units at a boosting taxi's usual 8-10 u/s on traffic.
 */
export const OVERTAKE_ARM_RANGE = 30;
/**
 * An armed combo that has not pulled out inside this many seconds lapses — no road, or the car
 * turned off. Long enough to close from OVERTAKE_ARM_RANGE to PASS_TRIGGER (10) at ~8 u/s.
 */
export const OVERTAKE_ARM_WINDOW = 3.0;

/**
 * Seconds a car the taxi has just caught is tailgated rather than rammed (`?grace=` overrides it).
 * The ram is what makes the combo matter, and it was landing before a human could throw it: a bot
 * reacting 0.6s after a car came within OVERTAKE_ARM_RANGE — see it, decide, lift — passed 25 of
 * 77 and was rammed 52 times, **50 of them before its thumb was back on the pill**. Lift length
 * barely moved it (0.12s against 0.3s); reaction time moved everything (97% at 0.15s). So the
 * window was the problem, not the gesture (tools/overtakebot.mjs). Hold Loco behind a car past
 * this and it still rams.
 */
export const OVERTAKE_GRACE = 1.2;

/**
 * Under `?overtake=double` (Tyler, 2026-10-09), the combo is a double tap instead of a blip: the
 * pill is usually down already, so the gesture is let go (for as long as you like), tap, tap and
 * hold. A press this short or shorter counts as the first tap; the second press then has to land
 * within OVERTAKE_BLIP_MS of it coming up. Lifting off a long hold and pressing again does *not*
 * arm, which is what makes it a different input from the blip rather than a looser one, and what
 * keeps a player feathering the pill from overtaking by accident.
 */
export const OVERTAKE_TAP = 0.35;

/**
 * @param taxi   the traffic model's taxi; reads `passGap`, `passLeader` and `passing`, writes
 *               `passArmed`, `passPending` and `passGrace`
 * @param grace  seconds of OVERTAKE_GRACE to give a newly caught car; 0 rams on contact (the
 *               probe and the bot pass it explicitly)
 * @param input  how the combo is thrown: 'blip' (the default), 'double' (`?overtake=double`, the
 *               double tap — OVERTAKE_TAP) or 'signal' (`?overtake=signal`, a button of its own —
 *               see `signal()` below)
 */
export function createOvertakeCombo({ taxi, grace = 0, input = 'blip' }) {
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
  /** The car the grace was last started for, and what is left of it. */
  let graceFor = null;
  let graceLeft = 0;

  const behind = () => (taxi.passGap ?? Infinity) < OVERTAKE_ARM_RANGE;
  /** Is a release that could still be the blip in progress? Read by sim/traffic.js `canPass`. */
  const pending = () => blip !== null && blip <= OVERTAKE_BLIP_MS / 1000;

  function reset() {
    state.armed = false;
    state.armLeft = 0;
    wasHeld = false;
    heldFor = 0;
    blip = null;
    wasPassing = false;
    graceFor = null;
    graceLeft = 0;
    taxi.passArmed = false;
    taxi.passPending = false;
    taxi.passGrace = false;
    taxi.passSignal = false;
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
      // The first half: a blip off a hold, or the first tap of a double tap.
      const first = input === 'double' ? heldFor <= OVERTAKE_TAP : heldFor >= OVERTAKE_PRE_HOLD;
      blip = input !== 'signal' && first && behind() ? 0 : null;
      // Letting go of the pill drops a combo thrown *on* the pill. The signal button is thrown off
      // it — a thumb reaching for it may well come off Loco to do so — so that arm survives the lift
      // and the pass goes as soon as Loco is down again.
      if (input !== 'signal') state.armed = false;
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
    // The taxi's left indicator, for the signal button: on while it is asking to pull out, and
    // through the pull-out itself (sim/traffic.js reads it ahead of every other reason to signal).
    taxi.passSignal = input === 'signal' && (state.armed || Boolean(taxi.passing));
    taxi.passPending = !held && pending();
    // A new car within range starts its own grace; the same car again does not. Keyed on the car
    // rather than on the gap so a leader that drops out of view for a junction box and comes back
    // is still the one already being judged.
    const leader = behind() ? taxi.passLeader : null;
    if (grace > 0 && leader && leader !== graceFor) { graceFor = leader; graceLeft = grace; }
    graceLeft = Math.max(0, graceLeft - dt);
    taxi.passGrace = graceLeft > 0;
  }

  /**
   * The overtake button (`?overtake=signal`, Tyler 2026-10-09: "treat it almost like a self-driving
   * car where you would hit your blinker"). Arms the pass outright — no gesture, no car needed yet:
   * it waits OVERTAKE_ARM_WINDOW for one, and the taxi indicates left for as long as it does.
   */
  function signal() {
    if (input !== 'signal' || taxi.passing) return;
    state.armed = true;
    state.armLeft = OVERTAKE_ARM_WINDOW;
    state.arms += 1;
    taxi.passArmed = true;
  }

  return { state, update, reset, signal, input };
}
