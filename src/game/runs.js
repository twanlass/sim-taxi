// Run bonuses: how a trip was driven, judged once at the drop-off and paid as a multiplier on it.
//
// A streak (×1, ×2, ×3 per clean drop-off, back to ×1 on damage) was tried first and only ever
// asked one thing of the player — don't crash — across the whole run, so the number on screen was
// mostly a measure of how long ago the last mistake was. A run bonus is decided trip by trip, so
// every ride is a fresh choice about *how* to drive it:
//
//   Loco Run     Loco Mode held for at least LOCO_SHARE of the ride.                       ×2
//   Perfect Run  no damage on a ride where Loco Mode was actually used (PERFECT_MIN_BOOST). ×1.5
//   Stealth Run  boosted past the patrol car inside STEALTH_RANGE without it spotting you.  ×1.5
//
// They multiply, so the whole set — flat out, clean, under a cop's nose — pays ×4.5.
//
// **Perfect needs boost because off boost it would be free.** The taxi drives itself between the
// player's taps — it follows, queues and stops at reds like any other car — and a contact off boost
// costs no HP (sim/collisions.js). Counting every contact instead would hand the player a penalty
// for the traffic model's own nudges. So "perfect" means the hard version: you leant on the button
// and still did not hit anything.
//
// **Loco is a share, not "the whole time".** A full tank is BOOST_DURATION = 15s and a fare refills a
// third of it, against a median ride of roughly that, so "boost from pickup to drop-off" would be a
// bonus for VIP trips only. 80% is "you held it down", with room for the corner you had to take
// off it.
//
// **Stealth is a close shave, not an absence.** Not being spotted is free whenever there is no
// patrol out, so it has to be earned in its presence: boosting inside two blocks of a patrolling
// cruiser (spotting is one block, SPOT_RANGE) and the cruiser never giving chase before the drop-off.
//
// This module is pure bookkeeping: main.js feeds it the facts each frame and `fares` asks it for the
// verdict at the drop-off (`judgeRun`), so a probe can drive it with no renderer.

/** Share of the ride's seconds spent in Loco Mode for a Loco Run. */
export const LOCO_SHARE = 0.8;
/** Seconds of Loco Mode a ride needs before it can be a Perfect Run. See the header. */
export const PERFECT_MIN_BOOST = 1;
/** Two blocks: the band between this and SPOT_RANGE (one block) is the close shave. */
export const STEALTH_RANGE = 40;

export const RUNS = {
  loco: { label: 'Loco Run', mult: 2 },
  perfect: { label: 'Perfect Run', mult: 1.5 },
  stealth: { label: 'Stealth Run', mult: 1.5 },
};

export function createRunTracker() {
  // The ride being watched, and what has happened on it so far. `fare` is null between rides.
  const ride = {
    fare: null,
    seconds: 0,
    boosted: 0,
    damaged: false,
    closeShave: false,
    spotted: false,
  };

  function begin(fare) {
    ride.fare = fare;
    ride.seconds = 0;
    ride.boosted = 0;
    ride.damaged = false;
    ride.closeShave = false;
    ride.spotted = false;
  }

  /**
   * One frame of the ride. `fare` is whoever is aboard (null for nobody) — a new face starts a new
   * ride, which covers every way a rider gets in, the robber's cut scene included.
   * `cop` is the patrol as main.js sees it: `{ phase, gap }`, or null when there is none.
   */
  function update(dt, { fare, boosting, cop }) {
    if (fare !== ride.fare) begin(fare);
    if (!fare) return;
    ride.seconds += dt;
    if (boosting) ride.boosted += dt;
    if (cop?.phase === 'chase') ride.spotted = true;
    if (boosting && cop?.phase === 'patrol' && cop.gap <= STEALTH_RANGE) ride.closeShave = true;
  }

  /** Any damage to the taxi. Only a ride in progress cares. */
  const damage = () => { if (ride.fare) ride.damaged = true; };

  /** Which bonuses the ride in progress is on course for, in display order. */
  function live() {
    const out = [];
    if (!ride.fare) return out;
    const share = ride.seconds > 0 ? ride.boosted / ride.seconds : 0;
    if (ride.boosted > 0) out.push({ key: 'loco', share, earned: share >= LOCO_SHARE });
    if (ride.boosted >= PERFECT_MIN_BOOST) out.push({ key: 'perfect', earned: !ride.damaged });
    if (ride.closeShave) out.push({ key: 'stealth', earned: !ride.spotted });
    return out;
  }

  /** The verdict on `fare`'s ride: what it earned and the product of their multipliers. */
  function judge(fare) {
    if (fare !== ride.fare) return { runs: [], mult: 1 };
    const runs = live().filter((r) => r.earned).map((r) => ({ key: r.key, ...RUNS[r.key] }));
    return { runs, mult: runs.reduce((m, r) => m * r.mult, 1) };
  }

  return { ride, update, damage, live, judge };
}
