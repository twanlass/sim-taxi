/**
 * Auto-play soak.
 *
 * Simulates a perfect *router* rather than a player — see autoplay.mjs on what that is worth now
 * that the game is hand-steered. Sends the taxi at a fare the instant one appears or changes hands,
 * with a
 * configurable reaction delay. A real player is strictly slower than this, so the run length here
 * is the ceiling — how long the game *can* be survived, not how long it usually is.
 *
 * The airport prototype taught the lesson behind this file: three builds passed a short probe and
 * then froze at t=900. A snapshot cannot distinguish a working system from a slowly dying one.
 *
 *   node tools/soak.mjs [fares] [reaction] [runs] [firstSeed]
 *
 * **Runs, plural, is the point.** A single run is dominated by trip-length luck — one
 * corner-to-corner fare eats 40s against a 17s average — and on some seeds even a perfect player
 * loses the very first fare. Tuning difficulty against one seed is tuning against noise; it is how
 * a 30% harder game once read as a 75% harder one. The suite reports the median of a fixed sweep.
 */
import { play, pct, mean } from './autoplay.mjs';

const FARES = Number(process.argv[2] ?? 40);
const REACTION = Number(process.argv[3] ?? 1.5);   // seconds before the "player" reacts
const RUNS = Number(process.argv[4] ?? 9);
const FIRST_SEED = Number(process.argv[5] ?? 71624);
// The city, separately from the situation. It defaults to the shipped screenshot seed so the
// suite's number does not move, but it has to be reachable: everything below averages over
// trip-length luck within ONE city, so a change that shifts that city's signal offsets reads as a
// difficulty change with no way to tell whether it generalises. It usually doesn't.
const CITY_SEED = Number(process.argv[6] ?? 71624);
// Cities are spread the same way situations are, and for the same reason.
const CITY_STRIDE = 7919;
// Spread rather than consecutive: adjacent seeds through this RNG produce visibly similar first
// fares, and a sweep of near-duplicates measures one situation nine times.
const SEED_STRIDE = 613;

const runs = Array.from({ length: RUNS }, (_, k) => play(
  FIRST_SEED + k * SEED_STRIDE, CITY_SEED + k * CITY_STRIDE,
  { fares: FARES, reaction: REACTION },
));

const delivered = runs.map((r) => r.delivered).sort((a, b) => a - b);
const median = delivered[delivered.length >> 1];
const routeFailures = runs.reduce((a, r) => a + r.routeFailures, 0);
const violations = runs.reduce((a, r) => a + r.violations, 0);
const worstMargin = Math.min(...runs.map((r) => r.worstMargin));

for (const r of runs) {
  console.log(`  seed ${r.seed}: ${String(r.delivered).padStart(2)} fares, $${r.money}`
    + `, ${r.elapsed.toFixed(0)}s${r.failReason ? ` — ${r.failReason}` : ''}`);
}

// **The distribution, not just the median.** What is being tuned is the shape of the survival
// curve, and a median hides both ends of it: a build where nobody gets past 3 and a build where
// half the runs never end can share one. p10 is the "did anyone die during the tutorial" number
// and p90 is the ceiling.
console.log(`delivered over ${RUNS} runs: p10 ${pct(delivered, 0.1)} · median ${median} `
  + `· p90 ${pct(delivered, 0.9)} · mean ${mean(delivered).toFixed(1)} `
  + `· worst ${delivered[0]} · best ${delivered[delivered.length - 1]} (of ${FARES})`);

// How much of each fare's budget the drive actually ate, bucketed along the ramp. This is the
// direct read on `slack(d)`: if late fares still land with half their clock unspent then the ramp
// is not ramping, whatever the survival numbers happen to say. Deliveries per bucket are printed
// too, because the late buckets are thin by construction — only long runs reach them.
const rows = runs.flatMap((r) => r.budgets);
if (rows.length) {
  const buckets = [[1, 3], [4, 7], [8, 11], [12, Infinity]];
  const parts = buckets.map(([lo, hi]) => {
    const inBucket = rows.filter((b) => b.index >= lo && b.index <= hi);
    if (!inBucket.length) return `${lo}${hi === Infinity ? '+' : `-${hi}`}: —`;
    return `${lo}${hi === Infinity ? '+' : `-${hi}`}: `
      + `${(100 * mean(inBucket.map((b) => b.spent))).toFixed(0)}% of `
      + `${mean(inBucket.map((b) => b.limit)).toFixed(0)}s (n=${inBucket.length})`;
  });
  console.log(`budget spent by delivery — ${parts.join(' · ')}`);

  const limits = rows.map((b) => b.limit).sort((a, b) => a - b);
  const works = rows.map((b) => b.work).sort((a, b) => a - b);
  console.log(`clocks issued: ${limits[0].toFixed(0)}–${limits[limits.length - 1].toFixed(0)}s `
    + `(median ${pct(limits, 0.5).toFixed(0)}s) against estimated work `
    + `${works[0].toFixed(0)}–${works[works.length - 1].toFixed(0)}s `
    + `(median ${pct(works, 0.5).toFixed(0)}s)`);
}

console.log(`tightest deadline margin across all runs: ${worstMargin.toFixed(1)}s`);
console.log(`route failures ${routeFailures} | red-light violations ${violations}`);
console.log(`a perfect player (${REACTION}s reaction) survives a median of ${median} fares`);

// **A band, not a floor.** A difficulty system fails by being too easy exactly as readily as by
// being too hard, and only one of those used to be caught here. The lower bound is the old gate —
// a run so short the loop never got going means something is broken rather than hard. The upper
// bound is new: a perfect player is *meant* to lose eventually, so a median that climbs past it
// means the ramp has stopped biting and the score-attack has no ending.
//
// The band is quoted at this tool's default reaction. `check.mjs` runs it at 4s, where a slower
// player should be landing lower in the band than the 1.5s ceiling does.
const FLOOR = 3;
const CEILING = 20;
const inBand = median >= FLOOR && median <= CEILING;
const ok = inBand && routeFailures === 0 && violations === 0;
if (!inBand) {
  console.log(`median ${median} is outside the intended band ${FLOOR}..${CEILING} — `
    + `${median < FLOOR ? 'too hard' : 'too easy'}`);
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
