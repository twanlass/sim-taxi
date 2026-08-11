/**
 * The difficulty curve, and every knob hung off it.
 *
 * One number drives the whole ramp, and it lives here for the same reason every colour lives in
 * `palette.js`: a knob inlined at its call site is a knob nothing can sweep. `tools/difficulty-
 * sweep.mjs` drives this module and nothing else, and the ⚙️ panel scrubs the same handle.
 *
 * **Deliveries, not elapsed time.** A delivery is the player's own success, so the ramp
 * self-adjusts to skill: a quick player reaches the hard part sooner in wall-clock terms and a
 * slow one gets more room to find their feet. Ramping on the clock instead would lean hardest on
 * the player already struggling, which is the wrong way round — and it would make the ramp
 * something that happens *to* you rather than something you earned.
 *
 * The module is pure and DOM-free, like `boost.js` and `boostmeter.js`. It also knows nothing
 * about the sim: `sim/` must not import from `game/`, so the two knobs that steer traffic and
 * police are pushed *into* those systems by `main.js`, the same way `traffic.taxi.boost` is.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Everything tunable, in one object so a sweep can drive it.
 *
 * Mutable rather than `const` exports for the same reason `fareSeconds` is: the sweep and the
 * debug panel both need to move these without a rebuild, and the shipped values stay written down
 * right here as the documented baseline.
 */
const TUNING = {
  // How many deliveries the ramp takes to run its full length. Past this the game is as hard as
  // it gets and stays there — the run still ends, but because the clocks are tight rather than
  // because something new keeps arriving.
  rampFares: 12,

  // The main lever: how much more than the estimated work a rider's clock is worth.
  //
  // It cannot go below 1.0 — a deadline shorter than the driving it pays for is unwinnable by
  // construction, and `tools/probe.mjs` asserts that across the whole curve. The floor sits above
  // 1.0 anyway, because `estimateSeconds` has a measured MAE of 4.35s against real trips (see
  // route.js) and slack is what pays for the traffic you happen to get.
  //
  // **Slack is the fraction of the clock left at the drop-off**, near enough to read off directly:
  // a fare served straight through eats its estimate and hands back `1 - 1/slack`. At 2.0 that is
  // half the ring still lit, which is why the shipped game read as generous however the survival
  // numbers looked — the player is watching the diamond, not the median. 1.7 lands an on-time
  // drop-off at ~41% (orange) and the end of the ramp at ~5% (red).
  //
  // Swept over 21 cities × 2 reaction times (`node tools/difficulty-sweep.mjs 21 slack`), median
  // fares delivered by a perfect player at 1.5s / 4s, and the mean share of the clock a fare's
  // drive actually ate at deliveries 1-3 / 12+:
  //
  //   2.0 → 1.15   20 / 15   58% → 84%   — was shipped; p10 12/11
  //   1.7 → 1.10   15 / 11   65% → 85%   — p10 11/4
  //   1.7 → 1.05   14 / 11   64% → 87%   <- shipped; p10 9/7
  //   1.6 → 1.05   13 / 12   66% → 86%   — a run died on fare 2 at 1.5s (p10 2)
  //
  // 1.7 → 1.05 is the last row where nobody dies during the tutorial. Below it the tail starts
  // eating first-fare runs, which is the one failure a score-attack cannot have. The floor is not
  // 1.0 even at the end of the ramp because `estimateSeconds` has a measured MAE of 4.35s against
  // real trips (see route.js) — at 1.0 the traffic you happen to get decides the fare, not you.
  //
  // 2.0 → 1.15 was measured at a median of 15/13 when it shipped and re-measured at 20/15 here:
  // the build drifted easier underneath the tuning. Re-run the sweep before trusting a row above.
  slackStart: 1.7,
  slackEnd: 1.05,

  // Floor and ceiling on the resulting clock, in seconds.
  //
  // Both are guards, not shapers: they exist to catch the arithmetic going somewhere silly, and if
  // either is binding on an ordinary fare then the budget is what needs fixing. The floor stops a
  // next-door hop from being an instant panic — a rider who appears with 9 seconds reads as a bug
  // however fair the sums were. The ceiling has to clear a full board's queue, which at four fares
  // is three whole trips plus a drop-off ahead of this one.
  //
  // Both earlier values were binding and both did damage. 90 clipped ordinary late-game clocks,
  // quietly reintroducing the unmeetable deadline the queue chain exists to remove. 180 was
  // subtler and worse: with a saturated board the median clock issued sat at 175s against a 180s
  // cap, so `limit` was `min(ceiling, work × slack)` with the ceiling winning — and the whole
  // slack curve stopped doing anything. Sweeping slack from 1.35 down to 1.05 moved the median run
  // length by less than a fare, because the clamp was setting the real slack. The ceiling has to
  // sit clear of the deepest queue the board cap allows, or it *is* the difficulty curve.
  //
  // The floor came down from 20 with the slack end: a median 16.4s trip (tools/eta.mjs) budgets
  // 19.8s at slack 1.05, so 20 had quietly become the clock every short late fare was issued —
  // `tools/probe.mjs` caught it. **A floor has to be re-checked against the tightest slack on the
  // curve**, because that is the only place it can start binding.
  clockFloor: 15,
  clockCeiling: 240,

  // Seconds allowed for the player to notice a rider and tap them. Charged once per fare, not
  // twice: the drop-off dispatches itself, so the only reaction a fare actually costs is on the
  // kerb. It sits inside the slack multiplier, so early fares are forgiving about it and late
  // ones are not.
  reactionAllowance: 2.5,

  // Deliveries at which the board is allowed to hold 2, 3 and 4 fares. The first fare teaches the
  // loop with nothing else on screen; two clocks is where the game becomes a prioritisation
  // puzzle; the fourth is an endgame beat, well past where that shape has been learned.
  boardSteps: [1, 2, 10],

  // Seconds between successive spawns on a non-empty board. The floor is 7 rather than lower
  // because `tools/probe.mjs` asserts a minimum stagger of 6.5s, and because extras landing closer
  // together than that stop reading as separate decisions.
  //
  // **Widening it does not make the game easier, it makes the opening more fragile.** Swept over
  // 9 cities × 3 reaction times (`node tools/difficulty-sweep.mjs 9 gap`), the median run length
  // is flat at 12–15 fares across everything from 15→7 to 40→18 — but the *worst* runs get much
  // worse, p10 falling from 7–12 down to 1–6. A sparse board means short queues, short queues mean
  // short budgeted clocks, and a short clock has less absolute margin to absorb one bad set of
  // lights. The stagger shapes how the board reads; it is not the difficulty.
  spawnGapStart: 15,
  spawnGapEnd: 7,

  // Blocks from the bias point an extra rider may spawn within. This only became a knob once
  // clocks were budgeted: it used to be a fairness patch, holding extras near the current
  // drop-off because a flat 60s could not pay for a distant one. The budget pays for it now, so
  // the radius is free to open up — and GRID is the whole map.
  spawnRadiusStart: 3,
  spawnRadiusEnd: 5,

  // Total vehicles, taxi included. Pushed into the sim by main.js; `?cars=N` overrides it outright
  // and the headless tools pin their own so their baselines stay comparable across builds.
  //
  // The opening value is the number the game already shipped with (`getCarCount`'s fallback), so
  // the ramp adds traffic rather than starting by removing some. The measured cost of density is
  // in docs/traffic.md: at 12 cars a boosting taxi holds 95% of its cap and loses 9.2% of its
  // frames to the car in front, at 24 it is 92% and 15.0%. Ending at 22 lands just under that
  // second column — busy enough to be felt in every corner, short of the point where the boost
  // stops being usable at all.
  carsStart: 12,
  carsEnd: 22,

  // Seconds between police corridor runs, as a range the sim draws from. Roughly halved across the
  // ramp, so the corridor goes from an occasional interruption to something that has to be planned
  // around — and it is a *delay*, not a death, unless the player is boosting through it.
  policeCooldownStart: [16, 30],
  policeCooldownEnd: [8, 14],
};

export const setTuning = (patch) => Object.assign(TUNING, patch);
export const getTuning = () => ({ ...TUNING });

// A pinned curve position, for `?d=` and for the tools. Overrides the delivery count entirely, so
// a screenshot of a four-fare board doesn't have to play ten fares first, and so soak/probe/
// signals can hold the world at one density while they measure something else.
let pinned = null;
export const pinDifficulty = (v) => { pinned = v === null ? null : clamp01(v); };
export const getPinned = () => pinned;

/** Where the run is on the curve: 0 at the first fare, 1 once the ramp has run its length. */
export const difficulty = (delivered) =>
  pinned ?? clamp01(delivered / TUNING.rampFares);

// --- The knobs ----------------------------------------------------------------
// Each takes the delivery count so no caller has to hold `d` itself, and each is a plain lerp
// along the curve. Linear on purpose: a curve shape is one more thing to justify, and the sweep
// showed the endpoints matter far more than the path between them.

/** Multiplier on a fare's estimated work to get its deadline. */
export const slack = (delivered) =>
  lerp(TUNING.slackStart, TUNING.slackEnd, difficulty(delivered));

/**
 * How many seconds a rider gets, given the estimated seconds of driving they cost.
 *
 * The reaction allowance is inside the multiplier rather than added after it, so the time to
 * notice a rider is squeezed by the ramp along with everything else.
 */
export function fareLimit(workSeconds, delivered) {
  const raw = (workSeconds + TUNING.reactionAllowance) * slack(delivered);
  return Math.max(TUNING.clockFloor, Math.min(TUNING.clockCeiling, raw));
}

/** How many fares may be on the board at once. */
export function maxFares(delivered) {
  // Stepped, not lerped: the board is a count, and the steps are the design statement — "the
  // third rider arrives at two deliveries" is the rule, not a point on a ramp.
  const at = pinned === null ? delivered : pinned * TUNING.rampFares;
  let n = 1;
  for (const step of TUNING.boardSteps) if (at >= step) n += 1;
  return n;
}

/** Seconds between successive spawns on a non-empty board. */
export const spawnGap = (delivered) =>
  lerp(TUNING.spawnGapStart, TUNING.spawnGapEnd, difficulty(delivered));

/** Blocks from the bias point an extra rider may land within. */
export const spawnRadius = (delivered) =>
  Math.round(lerp(TUNING.spawnRadiusStart, TUNING.spawnRadiusEnd, difficulty(delivered)));

/** Ambient car count the sim should be running at. */
export const carCount = (delivered) =>
  Math.round(lerp(TUNING.carsStart, TUNING.carsEnd, difficulty(delivered)));

/** Seconds between police corridor runs, as `[min, max]` for the sim to draw from. */
export function policeCooldown(delivered) {
  const d = difficulty(delivered);
  return [
    lerp(TUNING.policeCooldownStart[0], TUNING.policeCooldownEnd[0], d),
    lerp(TUNING.policeCooldownStart[1], TUNING.policeCooldownEnd[1], d),
  ];
}

// --- Shifts -------------------------------------------------------------------

/**
 * The ramp, as something the player is told rather than something they infer from dying more.
 *
 * Four bands over the delivery count, each with a payout multiplier. Deliberately *not* named
 * after times of day: `daylight.js` runs the sky on its own clock, and a "Night Shift" banner
 * over a midday sky is two systems contradicting each other.
 *
 * The payout steps with the band rather than creeping continuously, so the number on the counter
 * changes on the beat it crosses into a new one.
 */
export const SHIFTS = [
  { at: 0, name: 'Early Shift', payout: 1 },
  { at: 3, name: 'Busy', payout: 1.25 },
  { at: 7, name: 'Rush Hour', payout: 1.5 },
  { at: 12, name: 'Gridlock', payout: 2 },
];

/** Which shift a run is in. Index is what `main.js` compares to spot an entry. */
export function shiftFor(delivered) {
  const at = pinned === null ? delivered : pinned * TUNING.rampFares;
  let index = 0;
  for (let k = 0; k < SHIFTS.length; k++) if (at >= SHIFTS[k].at) index = k;
  return { index, ...SHIFTS[index] };
}

/** What a fare is worth, as a multiple of its distance price. */
export const payoutMultiplier = (delivered) => shiftFor(delivered).payout;
