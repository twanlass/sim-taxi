/**
 * Parameter sweep for the difficulty curve in `src/game/difficulty.js`.
 *
 *   node tools/difficulty-sweep.mjs [runs] [preset]
 *
 * Plays the same set of cities and situations through several tunings and reports the survival
 * distribution of each, at three reaction times. `soak.mjs` says how hard the shipped build is;
 * this says which knob to turn and how far.
 *
 * **Distributions, at more than one reaction time.** A median alone cannot tell "everybody dies at
 * 4" from "half the runs never end", and a tuning that is right for a 1.5s player can be
 * unplayable for a 4s one — the whole point of a ramp is that it stays fair to both for a while
 * and then stops. p10 is the "did anyone die during the tutorial" number and it is the one that
 * catches a curve that is cruel at the start.
 *
 * Cities are swept for the reason `docs/testing.md` gives: a change that shifts one city's signal
 * offsets reads as a difficulty change with no way to tell whether it generalises, and it usually
 * doesn't. Every variant plays the *same* cities and situations so the comparison is paired.
 *
 * Every variant is played twice: by a player who drives at cruise, and by one who holds Loco Mode
 * whenever there is fuel (`loco`). The gap between the two is the point of the pace dial — below
 * 1.0 the cruise player should be losing riders the loco player makes.
 *
 * Presets:
 *   pace      how hard you have to drive: a clock over its own trip at cruise
 *   pressure  how many riders are offered per rider one taxi can serve
 *   ramp      how many deliveries the curve takes to run its length
 *   shipped   just the current tuning
 */
import { play, pct, mean } from './autoplay.mjs';
import { setTuning, getTuning } from '../src/game/difficulty.js';

const RUNS = Number(process.argv[2] ?? 9);
const PRESET = process.argv[3] ?? 'shipped';
const FARES = 40;
const FIRST_SEED = 71624;
const CITY_SEED = 71624;
const SEED_STRIDE = 613;
const CITY_STRIDE = 7919;
const REACTION = 2;
const STYLES = [{ name: 'cruise', loco: false }, { name: 'loco', loco: true }];

const BASE = getTuning();

// Each variant is a patch over the shipped tuning, so a preset only has to name what it moves.
const PRESETS = {
  shipped: [{ label: 'shipped' }],

  pace: [
    { label: 'pace 1.5→1.0', paceEnd: 1.0 },
    { label: 'pace 1.5→0.9', paceEnd: 0.9 },
    { label: 'pace 1.5→0.85 (shipped)' },
    { label: 'pace 1.5→0.8', paceEnd: 0.8 },
  ],

  pressure: [
    { label: 'pressure 0.5→1.0', pressureEnd: 1.0 },
    { label: 'pressure 0.5→1.4 (shipped)' },
    { label: 'pressure 0.5→1.8', pressureEnd: 1.8 },
  ],

  // The opening: what decides whether a player who never touches Loco Mode survives long enough to
  // learn they should.
  opening: [
    { label: 'pace 1.3, pressure 0.7', paceStart: 1.3, pressureStart: 0.7 },
    { label: 'pace 1.5, pressure 0.7', pressureStart: 0.7 },
    { label: 'pace 1.3, pressure 0.5', paceStart: 1.3 },
    { label: 'pace 1.5, pressure 0.5 (shipped)' },
  ],

  // How fast the ramp arrives, rather than where it ends up. The old answer, under slack, was not
  // to shorten it: at 8 fares the curve landed on a player still learning the board.
  ramp: [
    { label: 'ramp 12 (shipped)' },
    { label: 'ramp 8', rampFares: 8 },
    { label: 'ramp 16', rampFares: 16 },
  ],
};

const variants = PRESETS[PRESET];
if (!variants) {
  console.log(`unknown preset "${PRESET}" — try ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

/** One variant for one style of driving, over the shared seed set. */
function evaluate(patch, loco) {
  setTuning({ ...BASE, ...patch });
  const runs = Array.from({ length: RUNS }, (_, k) => play(
    FIRST_SEED + k * SEED_STRIDE, CITY_SEED + k * CITY_STRIDE,
    { fares: FARES, reaction: REACTION, loco },
  ));

  const delivered = runs.map((r) => r.delivered).sort((a, b) => a - b);
  const rows = runs.flatMap((r) => r.budgets);
  const late = rows.filter((b) => b.index >= 8);
  const paces = rows.map((b) => b.pace).filter((p) => p !== null);
  return {
    p10: pct(delivered, 0.1),
    median: delivered[delivered.length >> 1],
    p90: pct(delivered, 0.9),
    mean: mean(delivered),
    // How much of its clock the average late fare ate. Over 100% is not possible for a delivered
    // fare — this is the margin the survivors had.
    lateSpend: late.length ? mean(late.map((b) => b.spent)) : null,
    // The pace this player actually drove at: seconds from spawn to drop-off over the estimate.
    // Read at the `loco` rows, it is the floor `paceEnd` must stay above (LOCO_PACE_SELF).
    pace: paces.length ? mean(paces) : null,
    // Seconds per delivery — what `FARE_CYCLE` in difficulty.js is measured off.
    cycle: mean(runs.filter((r) => r.delivered).map((r) => r.elapsed / r.delivered)),
    strikes: mean(runs.map((r) => r.strikes)),
    // Share of kerbside picks made with more than one rider waiting — how often the board actually
    // offered a choice.
    choice: (() => {
      const all = runs.flatMap((r) => r.choices);
      return all.length ? all.filter((n) => n > 1).length / all.length : 0;
    })(),
    // Runs that ended on a wreck rather than a clock — only the loco player can have one.
    wrecks: runs.filter((r) => r.wrecked).length,
    // How the runs that ended, ended: the third strike (on the kerb or aboard, they count alike),
    // or a wreck.
    endings: runs.reduce((acc, r) => {
      if (r.wrecked) acc.wreck += 1;
      else if (r.failReason) acc.strikes += 1;
      return acc;
    }, { wreck: 0, strikes: 0 }),
    endless: runs.filter((r) => r.delivered >= FARES).length,
    broken: runs.reduce((a, r) => a + r.routeFailures, 0),
  };
}

console.log(`preset "${PRESET}" · ${RUNS} cities · ${REACTION}s reaction`);
console.log('');
const pad = Math.max(...variants.map((v) => v.label.length));
console.log(`${'tuning'.padEnd(pad)}  style    p10  med  p90   mean  late-spend  pace  cycle  strikes  choice  wrecks  ran-out`);

for (const { label, ...patch } of variants) {
  for (const { name, loco } of STYLES) {
    const r = evaluate(patch, loco);
    console.log(`${label.padEnd(pad)}  ${name.padEnd(6)}  `
      + `${String(r.p10).padStart(3)}  ${String(r.median).padStart(3)}  ${String(r.p90).padStart(3)}  `
      + `${r.mean.toFixed(1).padStart(5)}  `
      + `${(r.lateSpend === null ? '—' : `${(100 * r.lateSpend).toFixed(0)}%`).padStart(10)}  `
      + `${(r.pace === null ? '—' : r.pace.toFixed(2)).padStart(4)}  `
      + `${r.cycle.toFixed(0).padStart(4)}s  `
      + `${r.strikes.toFixed(1).padStart(7)}  `
      + `${`${(100 * r.choice).toFixed(0)}%`.padStart(6)}  `
      + `${String(r.wrecks).padStart(6)}  `
      + `${String(r.endless).padStart(7)}`
      + `   (ended: ${r.endings.strikes} strikes, ${r.endings.wreck} wrecks)`
      + `${r.broken ? `   BROKEN ${r.broken}` : ''}`);
  }
  console.log('');
}

// Restore, so a tool that imports this one is not left holding the last variant.
setTuning(BASE);

// The shape being aimed at. Quoted here rather than in a doc because this is the file that can
// actually check it, and a target nothing measures is a wish.
console.log('target: p10 >= 3 for both styles (nobody dies during the tutorial), loco clearly');
console.log('        ahead of cruise once pace drops under 1.0, and ran-out 0 (the run still ends).');
