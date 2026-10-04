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

  // **Two dials.** Everything about how hard the fare game is comes down to these, and each one
  // answers a question the player can feel:
  //
  //   pace      how hard do I have to drive to make this rider?
  //   pressure  can I take everyone, or do I have to choose?
  //
  // **Pace** is a rider's clock over their own trip at cruise — `estimateSeconds`, which is fitted
  // against a taxi driving the speed limit and stopping at every red (route.js). At 1.0 a clean,
  // legal drive arrives on the last second. Above it there is room for a wrong turn; below it
  // there is not enough road at the speed limit, and the seconds have to come out of Loco Mode,
  // running reds and taking the overtake. That is the driving the game is meant to ask for, so
  // the end of the ramp sits *below* 1.0 on purpose.
  //
  // It used to be `slack`, held above 1.0 by an assertion, because any rider timing out ended the
  // run: a clock the legal drive could not meet was a guaranteed loss. A rider let go on the kerb
  // is a strike now (`MAX_STRIKES` in fares.js), so a clock that asks for Loco Mode is a demand
  // rather than a trap. The floor that does still matter is how fast the taxi can actually go:
  // `LOCO_PACE_SELF` in tools/autoplay.mjs is that number, measured, and `tools/probe.mjs`
  // asserts the curve never asks for less.
  //
  // It is the fraction of the clock left at an on-time drop-off, near enough: a fare driven at
  // cruise hands back `1 - 1/pace`, so 1.5 lands a legal drive with a third of the ring lit and
  // 0.85 lands it 18% short of the drop-off — the ring empties with the rider still in the back.
  //
  // Swept with `node tools/difficulty-sweep.mjs 21 opening` (21 cities, 2s reaction), deliveries
  // p10 / median for a player who never boosts and one who boosts whenever the job in hand would
  // not make it at cruise:
  //
  //                                 cruise    loco
  //   pace 1.3→0.85, pressure 0.7    2 / 6    9 / 11
  //   pace 1.5→0.85, pressure 0.7    3 / 8    8 / 12
  //   pace 1.3→0.85, pressure 0.5    2 / 7   10 / 12
  //   pace 1.5→0.85, pressure 0.5    3 / 7   10 / 12   <- shipped
  //
  // The gap between the two columns is the dial working: a player who drives it like a bus is
  // done by the seventh fare, and one who drives it like a getaway car lasts nearly twice as long.
  // The old slack curve, for comparison, gave a never-boosting perfect player a median of 14.
  paceStart: 1.5,
  paceEnd: 0.85,

  // **Pressure** is riders offered over riders one taxi can serve. Below 1.0 the board drains
  // faster than it fills and any order works; above it riders arrive faster than anyone can take
  // them, and the game becomes choosing who to let go. It sets the spawn stagger through
  // `FARE_CYCLE` below, and nothing else: the board size, the spacing and the spawn radius all
  // used to be knobs of their own, and between them they were only ever saying this one thing.
  pressureStart: 0.5,
  pressureEnd: 1.4,

  // Floor and ceiling on the resulting clock, in seconds.
  //
  // Both are guards, not shapers: they exist to catch the arithmetic going somewhere silly, and if
  // either is binding on an ordinary fare then the budget is what needs fixing. The floor stops a
  // next-door hop from being an instant panic — a rider who appears with 9 seconds reads as a bug
  // however fair the sums were. The ceiling only has to clear one rider aboard plus a corner-to-
  // corner trip now that a clock no longer covers the queue in front of it.
  //
  // A binding ceiling silently becomes the difficulty curve: at 180, with every clock covering the
  // whole queue, the median clock issued sat at 175s and sweeping the slack moved nothing. That is
  // the failure to watch for if this ever comes down.
  clockFloor: 12,
  clockCeiling: 240,

  // Seconds allowed for the player to notice a rider and tap them. Charged once per fare, not
  // twice: the drop-off dispatches itself, so the only reaction a fare actually costs is on the
  // kerb. It sits inside the pace multiplier, so early fares are forgiving about it and late
  // ones are not.
  reactionAllowance: 2.5,

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

/**
 * Seconds one taxi spends per delivery, start to finish, at the shipped pace of play: the reaction,
 * the drive to the kerb and the trip. Pressure is measured against it — a spawn every
 * `FARE_CYCLE / pressure` seconds is `pressure` riders for every one the taxi can carry.
 *
 * Measured, not chosen: `node tools/difficulty-sweep.mjs 21 shipped` prints the `cycle` column,
 * the mean seconds per delivery of a perfect player across 21 cities — 40–44s for one who never
 * boosts and 33–35s for one who does. 35 sits at the boosting end on purpose: the taxi the game is
 * asking for is the one driving hard, and pressure is "riders per rider *that* taxi can serve".
 */
export const FARE_CYCLE = 35;

/** Board size. The mesh pool in fares.js is built for exactly this many. */
export const BOARD_MAX = 4;

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

// --- The two dials --------------------------------------------------------------
// Each takes the delivery count so no caller has to hold `d` itself, and each is a plain lerp
// along the curve. Linear on purpose: a curve shape is one more thing to justify, and the sweep
// showed the endpoints matter far more than the path between them.

/** A rider's clock over their own trip at cruise. Below 1.0 means Loco Mode. */
export const pace = (delivered) =>
  lerp(TUNING.paceStart, TUNING.paceEnd, difficulty(delivered));

/** Riders offered per rider one taxi can serve. Above 1.0 means some have to be let go. */
export const pressure = (delivered) =>
  lerp(TUNING.pressureStart, TUNING.pressureEnd, difficulty(delivered));

/**
 * How many seconds a rider gets, given the estimated seconds of driving they cost.
 *
 * The reaction allowance is inside the multiplier rather than added after it, so the time to
 * notice a rider is squeezed by the ramp along with everything else.
 */
export function fareLimit(workSeconds, delivered) {
  const raw = (workSeconds + TUNING.reactionAllowance) * pace(delivered);
  return Math.max(TUNING.clockFloor, Math.min(TUNING.clockCeiling, raw));
}

// --- What the dials decide ------------------------------------------------------

/**
 * How many fares may be on the board at once: the first fare alone, so the loop is taught with
 * nothing else on screen, and then the whole board. How *full* it gets is pressure's job — a board
 * that drains faster than it fills never reaches four, and one that fills faster always does.
 */
export function maxFares(delivered) {
  const at = pinned === null ? delivered : pinned * TUNING.rampFares;
  return at >= 1 ? BOARD_MAX : 1;
}

/** Seconds between successive spawns on a non-empty board. */
export const spawnGap = (delivered) => FARE_CYCLE / pressure(delivered);

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
