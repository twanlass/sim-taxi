// The burnout launch: the street racer's trick, and the one move in the game that has to be earned.
// Hold the brake at a standstill, then hit Loco Mode, and the taxi leaves on a cloud of tyre smoke
// pulling three times as hard as an ordinary press (LAUNCH_GAIN in sim/traffic.js).
//
// **Earned, not taught.** The overtake, the U-turn and the drift all work from the first second of
// the first run; their cards only say so. This one is off until the player first beats the racer
// (game/race.js), and from then on it is theirs for good, remembered under UNLOCK_KEY (Tyler,
// 2026-10-21: "winning a race unlocks a combo"). A race-only reward has to be a *new* move: gating
// one of the three that already exist behind a coin-flip race would take it away from anyone who
// never races. And it is for good rather than for the run, because the racer turns up at random
// and a reward that has to be won again every run is a toll on the next one.
//
// **Why brake-then-Loco.** It is the drag racer's launch — foot on the brake, then the gas — and it
// is the only order of the two pedals that fits the controls as they are. The pedal row is owned by
// one pointer and the last pedal pressed wins (main.js, `holdBrake`/`holdLocoMode`), so "hold both
// and let the brake go" cannot be pressed at all: the second thumb takes the row and the brake comes
// up under the first. Brake *then* Loco is a press the row already makes — a thumb sliding off the
// brake onto the pill is the pedal slide — and at a standstill it meant nothing until now. Nothing
// else reads it: the bootleg and the drift both need speed, and the overtake needs a car to pass.
//
// **Armed by a held brake, so a jab is not a launch.** ARM_HOLD of brake with the car stopped, and
// the brake button wears a white ring to say it is ready (`is-armed`), the way the pill does for an
// armed overtake. Stopped at an all-way stop is exactly when a player is already standing on it.
//
// **It pays a half on the combo meter**, like the overtake and the U-turn, but once per lane: an
// all-way stop on every corner would otherwise make it the cheapest step in the game.

/** Remembered once the racer is beaten. `?raceunlock=classic` ignores it and has no burnout. */
export const UNLOCK_KEY = 'simTaxi.unlocked.burnout';
/** Seconds of brake at a standstill before Loco Mode launches rather than just going. */
export const ARM_HOLD = 0.35;
/** Below this the taxi counts as stopped, in u/s. A car easing onto a line is still at ~0.3. */
export const STILL_V = 0.6;
/** Seconds the launch pulls at LAUNCH_GAIN once the pill goes down: off the line and up to the top. */
export const LAUNCH_TIME = 0.6;
/** Seconds the rear tyres mark the road off the line — an ordinary press's 0.5 (main.js), and then some. */
export const BURNOUT_SKID_TIME = 1.1;

/**
 * @param taxi      the traffic model's taxi
 * @param unlocked  () => boolean — has the player beaten the racer
 */
export function createBurnout({ taxi, unlocked = () => false }) {
  const state = {
    /** Seconds the brake has been down with the car stopped. */
    held: 0,
    armed: false,
    /** Tallies, for the tools. */
    launches: 0,
    /** The lane the last launch that paid the combo left from — see the header. */
    paidLane: null,
  };

  /** Every frame: is the brake down on a stopped car, and for how long. */
  function update(dt, { brakeHeld }) {
    const still = brakeHeld && unlocked() && !taxi.crashed && !taxi.staged && taxi.v < STILL_V;
    state.held = still ? state.held + dt : 0;
    state.armed = state.held >= ARM_HOLD;
    return state.armed;
  }

  /**
   * Loco Mode went down. Answers null when this press is not a launch, else whether it lands a
   * combo. Called before the press releases the brake, since that release is what disarms it.
   */
  function press() {
    if (!state.armed) return null;
    state.held = 0;
    state.armed = false;
    state.launches += 1;
    taxi.launchT = LAUNCH_TIME;
    const lane = taxi.lane?.id ?? null;
    const pays = lane === null || lane !== state.paidLane;
    if (pays) state.paidLane = lane;
    return pays;
  }

  /** The pill did not go down after all (an empty tank): no launch. */
  function cancel() {
    taxi.launchT = 0;
  }

  function reset() {
    state.held = 0;
    state.armed = false;
  }

  return { state, update, press, cancel, reset };
}
