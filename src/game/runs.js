// The Perfect Run: how a job was driven, judged once at the drop-off and paid as a multiplier on it.
//
// A job is a Perfect Run when the taxi spent more than PERFECT_SHARE of it in Loco Mode and took no
// damage. Paid at RUNS.perfect.mult on top of the fare's price.
//
// **A job is the whole of it**: from the tap that sends the taxi at a rider, through the pickup, to
// the drop-off. It was the leg from pickup to drop-off at first, and that let a taxi bounce off
// three cars on its way to the kerb and still collect a Perfect Run for a smooth second half.
// Re-targeting the taxi at a different rider starts a new job.
//
// **It needs boost because off boost it would be free.** The taxi drives itself between the
// player's taps — it follows, queues and stops at reds like any other car — and a contact off boost
// costs no HP (sim/collisions.js). So "perfect" means the hard version: you leant on the button for
// most of the job and still did not hit anything. Half rather than all of it because a full tank is
// BOOST_DURATION = 15s and a fare refills a third of it, against a median job longer than that.
//
// How it got here, so nobody walks the same road twice: a streak (×1, ×2, ×3 per clean drop-off,
// back to ×1 on damage) only ever asked "don't crash" across the whole run. Then three run bonuses —
// Loco (80% boost, ×2), Perfect (no damage, ×1.5), Stealth (boost past the patrol unspotted, ×1.5) —
// which was more to read than to play. This is Loco and Perfect folded into one rule.
//
// This module is pure bookkeeping: main.js feeds it the facts each frame and `fares` asks it for the
// verdict at the drop-off (`judgeRun`), so a probe can drive it with no renderer. The verdict is a
// list of runs so the payout sequence and the HUD tags can carry another one if it ever comes back.

/** Share of the job's seconds spent in Loco Mode that a Perfect Run needs — strictly more than. */
export const PERFECT_SHARE = 0.5;

export const RUNS = {
  perfect: { label: 'Perfect Run', mult: 2 },
};

export function createRunTracker() {
  // The job being watched, and what has happened on it so far. `fare` is null between jobs.
  const ride = {
    fare: null,
    seconds: 0,
    boosted: 0,
    damaged: false,
  };

  function begin(fare) {
    ride.fare = fare;
    ride.seconds = 0;
    ride.boosted = 0;
    ride.damaged = false;
  }

  /**
   * One frame of the job. `fare` is the job in hand — the rider the taxi has been sent at or is
   * carrying (`fares.job()`, null for neither). A different fare starts a new job, which covers a
   * re-target and every way a rider gets in, the robber's cut scene included.
   */
  function update(dt, { fare, boosting }) {
    if (fare !== ride.fare) begin(fare);
    if (!fare) return;
    ride.seconds += dt;
    if (boosting) ride.boosted += dt;
  }

  /** Any damage to the taxi. Only a job in progress cares. */
  const damage = () => { if (ride.fare) ride.damaged = true; };

  /**
   * What the job in progress is on course for. Shown once Loco Mode has been used at all. `earned`
   * can come and go with the share; `broken` is for good — damage cannot be taken back.
   */
  function live() {
    if (!ride.fare || ride.boosted <= 0) return [];
    const share = ride.seconds > 0 ? ride.boosted / ride.seconds : 0;
    return [{
      key: 'perfect',
      share,
      earned: !ride.damaged && share > PERFECT_SHARE,
      broken: ride.damaged,
    }];
  }

  /** The verdict on `fare`'s job: what it earned and the product of their multipliers. */
  function judge(fare) {
    if (fare !== ride.fare) return { runs: [], mult: 1 };
    const runs = live().filter((r) => r.earned).map((r) => ({ key: r.key, ...RUNS[r.key] }));
    return { runs, mult: runs.reduce((m, r) => m * r.mult, 1) };
  }

  return { ride, update, damage, live, judge };
}
