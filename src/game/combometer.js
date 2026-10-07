// The combo meter (prototype, `?combo=meter` or `?combo=run`): every combo the taxi lands steps a
// multiplier up, and the next drop-off is paid at it. Replaces the Perfect Run while it is on.
//
// Tyler's idea (2026-10-07), off the combo streak in a Duolingo lesson: the number climbs as you
// chain moves, it is always on screen, and one mistake takes it away. So the meter is driven by
// what the player *does* (the four combos) and broken by the one thing they can get wrong, which is
// hitting something on Loco — any bump that costs HP (sim/collisions.js charges contact only on
// boost) drops it straight back to ×1. A reset rather than a tier down because the drop is the
// tension: a ×3 you can lose is worth driving carefully for, a ×3 that only slips to ×2 is not.
//
// Two scopes, so both can be played side by side:
//   meter — per ride. The meter is cashed at every drop-off and starts again at ×1.
//   run   — the whole run. A drop-off pays at the meter and leaves it where it is, so the only
//           thing that ever empties it is a crash. Closer to the Duolingo feel; the cap matters
//           more here, since otherwise a long clean run multiplies without limit.
//
// Steps are in halves, priced against how hard each move is to land: an overtake or a bootleg is a
// half, a drift kick a half per chain tier (DRIFT_CHAIN in sim/traffic.js, so a full chain of three
// is +3 on its own), and the bridge launch — a drift kick still being carried over an arch heading
// straight on — is the jackpot at +2. A fare is ~$11–23, so ×5 is the most one ride can be worth.
//
// Pure bookkeeping, like game/runs.js: main.js tells it what was landed and what hurt, and the fare
// loop asks it for the verdict at the drop-off through the same `judgeRun` hook.

export const COMBO_MAX = 5;

export const COMBO_STEPS = {
  overtake: { label: 'Overtake', step: 0.5 },
  uturn: { label: 'U-Turn', step: 0.5 },
  // By chain tier, 1-based.
  drift: { label: ['Drift', 'Drift ×2', 'Drift ×3'], step: [0.5, 1, 1.5] },
  launch: { label: 'Big Air', step: 2 },
};

/** What `?combo=` asked for: 'meter', 'run', or null for the Perfect Run as shipped. */
export function comboScope(params) {
  const asked = params.get('combo');
  return asked === 'meter' || asked === 'run' ? asked : null;
}

/** A combo's label and step; `tier` only matters for the drift. */
export function comboValue(key, tier = 1) {
  const def = COMBO_STEPS[key];
  if (!def) return null;
  const at = (v) => (Array.isArray(v) ? v[Math.max(0, Math.min(v.length - 1, tier - 1))] : v);
  return { label: at(def.label), step: at(def.step) };
}

/** A multiplier as the HUD writes it: 1x, 1.5x, 2x (Tyler's Figma). */
export const formatMult = (m) => `${Number.isInteger(m) ? m : m.toFixed(1)}x`;

export function createComboMeter({ scope = 'meter' } = {}) {
  const state = {
    mult: 1,
    landed: 0,      // combos behind the current multiplier, for the payout's label
    best: 1,        // the highest the meter reached this run
  };

  /** A combo landed. Returns what it added, for the word off the roof; null for an unknown key. */
  function land(key, tier = 1) {
    const v = comboValue(key, tier);
    if (!v) return null;
    const before = state.mult;
    state.mult = Math.min(COMBO_MAX, state.mult + v.step);
    state.landed += 1;
    state.best = Math.max(state.best, state.mult);
    return { ...v, mult: state.mult, added: state.mult - before };
  }

  /** A hit that cost HP. Returns whether there was anything to lose, so the caller can say so. */
  function damage() {
    const had = state.mult > 1;
    state.mult = 1;
    state.landed = 0;
    return had;
  }

  /**
   * The verdict on a drop-off, in the shape game/runs.js hands the fare loop: a list of runs for the
   * payout sequence and the product of their multipliers. Per-ride scope empties the meter here.
   */
  function judge() {
    const mult = state.mult;
    const runs = mult > 1 ? [{ key: 'combo', label: 'Combo', mult }] : [];
    if (scope === 'meter') { state.mult = 1; state.landed = 0; }
    return { runs, mult };
  }

  return { state, scope, land, damage, judge };
}
