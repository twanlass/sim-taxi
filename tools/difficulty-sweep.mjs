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
 * Presets:
 *   slack     the main lever — how much more than the estimated work a clock is worth
 *   ramp      how many deliveries the curve takes to run its length
 *   board     when the 2nd/3rd/4th rider are allowed onto the board
 *   gap       the stagger between spawns
 *   shipped   just the current tuning, at three reaction times
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
const REACTIONS = [1.5, 3, 4];

const BASE = getTuning();

// Each variant is a patch over the shipped tuning, so a preset only has to name what it moves.
const PRESETS = {
  shipped: [{ label: 'shipped' }],

  slack: [
    { label: 'slack 2.0→1.15', slackStart: 2.0, slackEnd: 1.15 },
    { label: 'slack 1.7→1.10', slackStart: 1.7, slackEnd: 1.10 },
    { label: 'slack 1.7→1.05 (shipped)' },
    { label: 'slack 1.6→1.05', slackStart: 1.6, slackEnd: 1.05 },
  ],

  // How fast the ramp arrives, rather than where it ends up. Swept because a player who finds the
  // shipped curve loose is asking for the hard part sooner as much as for it to be harder — but
  // the answer was no: at 8 fares both rows below drop p10 to 2 at a 4s reaction, which is the
  // ramp landing on a player still learning the board. Tighten `slack`, not `rampFares`.
  ramp: [
    { label: 'ramp 12 (shipped)' },
    { label: 'ramp 8, slack 1.8→1.05', rampFares: 8, slackStart: 1.8, slackEnd: 1.05 },
    { label: 'ramp 8, slack 1.7→1.08', rampFares: 8, slackStart: 1.7, slackEnd: 1.08 },
  ],

  board: [
    { label: 'board 1/2/10 (shipped)' },
    { label: 'board 1/4/12', boardSteps: [1, 4, 12] },
    { label: 'board 2/6/14', boardSteps: [2, 6, 14] },
    { label: 'board 2/8/18', boardSteps: [2, 8, 18] },
    { label: 'board 3/10/22', boardSteps: [3, 10, 22] },
  ],

  gap: [
    { label: 'gap 15→7 (shipped)' },
    { label: 'gap 22→10', spawnGapStart: 22, spawnGapEnd: 10 },
    { label: 'gap 30→14', spawnGapStart: 30, spawnGapEnd: 14 },
    { label: 'gap 40→18', spawnGapStart: 40, spawnGapEnd: 18 },
  ],

  // The one that matters once the queue is budgeted: a shallow board keeps clocks short and
  // readable, a deep one pushes them past three minutes and the game goes slack. Gap and slack
  // move together here because the gap sets how much work is queued and the slack sets how much
  // margin that work is given.
  shape: [
    { label: 'shipped' },
    { label: 'gap 30→14, slack 2.0→1.15', spawnGapStart: 30, spawnGapEnd: 14, slackStart: 2.0, slackEnd: 1.15 },
    { label: 'gap 30→18, slack 1.9→1.15', spawnGapStart: 30, spawnGapEnd: 18, slackStart: 1.9, slackEnd: 1.15 },
    { label: 'gap 26→16, slack 1.9→1.10', spawnGapStart: 26, spawnGapEnd: 16, slackStart: 1.9, slackEnd: 1.10 },
    { label: 'gap 26→16, slack 1.8→1.05', spawnGapStart: 26, spawnGapEnd: 16, slackStart: 1.8, slackEnd: 1.05 },
  ],
};

const variants = PRESETS[PRESET];
if (!variants) {
  console.log(`unknown preset "${PRESET}" — try ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

/** One variant at one reaction time, over the shared seed set. */
function evaluate(patch, reaction) {
  setTuning({ ...BASE, ...patch });
  const runs = Array.from({ length: RUNS }, (_, k) => play(
    FIRST_SEED + k * SEED_STRIDE, CITY_SEED + k * CITY_STRIDE,
    { fares: FARES, reaction },
  ));

  const delivered = runs.map((r) => r.delivered).sort((a, b) => a - b);
  const rows = runs.flatMap((r) => r.budgets);
  const late = rows.filter((b) => b.index >= 8);
  return {
    p10: pct(delivered, 0.1),
    median: delivered[delivered.length >> 1],
    p90: pct(delivered, 0.9),
    mean: mean(delivered),
    // How much of its clock the average late fare ate. If this stays low while runs get longer,
    // the ramp is not the thing ending them — the board is.
    lateSpend: late.length ? mean(late.map((b) => b.spent)) : null,
    endless: runs.filter((r) => r.delivered >= FARES).length,
    broken: runs.reduce((a, r) => a + r.routeFailures + r.violations, 0),
  };
}

console.log(`preset "${PRESET}" · ${RUNS} cities × ${REACTIONS.length} reaction times`);
console.log('');
const pad = Math.max(...variants.map((v) => v.label.length));
console.log(`${'tuning'.padEnd(pad)}  react  p10  med  p90   mean  late-spend  ran-out`);

const results = [];
for (const { label, ...patch } of variants) {
  for (const reaction of REACTIONS) {
    const r = evaluate(patch, reaction);
    results.push({ label, reaction, ...r });
    console.log(`${label.padEnd(pad)}  ${reaction.toFixed(1)}s  `
      + `${String(r.p10).padStart(3)}  ${String(r.median).padStart(3)}  ${String(r.p90).padStart(3)}  `
      + `${r.mean.toFixed(1).padStart(5)}  `
      + `${(r.lateSpend === null ? '—' : `${(100 * r.lateSpend).toFixed(0)}%`).padStart(10)}  `
      + `${String(r.endless).padStart(7)}`
      + `${r.broken ? `   BROKEN ${r.broken}` : ''}`);
  }
  console.log('');
}

// Restore, so a tool that imports this one is not left holding the last variant.
setTuning(BASE);

// The shape being aimed at. Quoted here rather than in a doc because this is the file that can
// actually check it, and a target nothing measures is a wish.
console.log('target: p10 >= 3 at every reaction (nobody dies during the tutorial),');
console.log('        median ~12-15 at 1.5s and ~6-8 at 4s, and ran-out 0 (the run still ends).');
