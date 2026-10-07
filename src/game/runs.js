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

/**
 * Seconds into a job before the HUD tag may appear, and then only once the job is on course. It
 * used to show from the first press of the button with the share as a percentage, which Tyler
 * found too much to read mid-drive; now it is a plain "you are on your way to one".
 */
export const TAG_AFTER = 2;

export const RUNS = {
  perfect: { label: 'Perfect Run', mult: 2 },
  stunts: { label: 'Stunts' },
};

// --- The stunt bonus (prototype, `?stunts=on`) ------------------------------------------------
//
// Flat cash for each combo landed during a job, banked into a pot that pays at the drop-off and is
// lost with the job — a rider who walks, or a re-target, takes the pot with them. So a stunt is a
// bet on finishing the ride, which is what keeps it from being free money: cash is the score, and
// the clocks (game/difficulty.js) are what the run is survived on, so a stunt that paid on the spot
// would only ever inflate the number without touching the tension.
//
// Flat rather than a multiplier, and added *after* the Perfect Run's ×2, so the two stay separate
// rewards: Perfect is "leaned on Loco and touched nothing", stunts are "did something with it". A
// multiplier would make a stunt on a $8 hop worth a third of one on a $23 haul for the same move.
//
// Priced against a fare of FARE_BASE + FARE_PER_BLOCK per block ($5 + $3, so ~$11–23): one stunt is
// a block or so, a full drift chain is about a fare, and the bridge launch — which needs a drift
// kick still being carried as the taxi crests an arch heading straight on — is the jackpot.
export const STUNTS = {
  overtake: { label: 'Overtake', pays: 2 },
  uturn: { label: 'U-Turn', pays: 3 },
  // By chain tier (DRIFT_CHAIN in sim/traffic.js), so the third kick in a row is worth the most.
  drift: { label: ['Drift', 'Drift ×2', 'Drift ×3'], pays: [3, 5, 7] },
  launch: { label: 'Big Air', pays: 12 },
};

/** A stunt's label and price; `tier` is 1-based and only the drift has tiers. */
export function stuntValue(key, tier = 1) {
  const def = STUNTS[key];
  if (!def) return null;
  const at = (v) => (Array.isArray(v) ? v[Math.max(0, Math.min(v.length - 1, tier - 1))] : v);
  return { label: at(def.label), pays: at(def.pays) };
}

export function createRunTracker({ stunts = false } = {}) {
  // The job being watched, and what has happened on it so far. `fare` is null between jobs.
  const ride = {
    fare: null,
    seconds: 0,
    boosted: 0,
    damaged: false,
    shown: false,   // whether the HUD tag has appeared — latched, so it does not blink at the line
    pot: 0,         // stunt cash banked on this job, paid at the drop-off
  };

  function begin(fare) {
    ride.fare = fare;
    ride.seconds = 0;
    ride.boosted = 0;
    ride.damaged = false;
    ride.shown = false;
    ride.pot = 0;
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
    if (!ride.shown && ride.seconds >= TAG_AFTER && status()?.earned) ride.shown = true;
  }

  /** Any damage to the taxi. Only a job in progress cares. */
  const damage = () => { if (ride.fare) ride.damaged = true; };

  /**
   * A stunt landed. Banks its price on the job in hand and returns what it banked, or null when
   * there is nothing to bank it on — stunts off, or no job — so the caller knows whether to say so.
   */
  function stunt(key, tier = 1) {
    if (!stunts || !ride.fare) return null;
    const v = stuntValue(key, tier);
    if (!v) return null;
    ride.pot += v.pays;
    return v;
  }

  /** Where the job in progress stands, shown or not. `broken` is for good — damage cannot be undone. */
  function status() {
    if (!ride.fare) return null;
    const share = ride.seconds > 0 ? ride.boosted / ride.seconds : 0;
    return { key: 'perfect', share, earned: !ride.damaged && share > PERFECT_SHARE, broken: ride.damaged };
  }

  /**
   * The HUD's tags: the job's status once the tag has appeared (`TAG_AFTER`, and on course). After
   * that `earned` can come and go with the share, which the tag shows as lit or dim.
   */
  const live = () => {
    const tags = ride.shown ? [status()] : [];
    if (ride.pot > 0) tags.push({ key: 'stunts', earned: true, broken: false, pot: ride.pot });
    return tags;
  };

  /**
   * The verdict on `fare`'s job: what it earned, the product of the multipliers, and the flat
   * `bonus` paid on top of that product (the stunt pot). Multiplier runs come first in `runs` and
   * flat ones after, which is the order the payout sequence spells them out in.
   */
  function judge(fare) {
    if (fare !== ride.fare) return { runs: [], mult: 1, bonus: 0 };
    const s = status();
    const runs = s?.earned ? [{ key: s.key, ...RUNS[s.key] }] : [];
    const mult = runs.reduce((m, r) => m * r.mult, 1);
    if (ride.pot > 0) runs.push({ key: 'stunts', ...RUNS.stunts, pays: ride.pot });
    return { runs, mult, bonus: ride.pot };
  }

  return { ride, update, damage, stunt, live, judge };
}
