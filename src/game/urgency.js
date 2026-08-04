import * as THREE from 'three';
import { PALETTE } from '../palette.js';

// How close a fare is to giving up, as a small integer.
//
// One model, three surfaces: the urgency bar over the waiting rider, the ring that rides with the
// taxi once they're aboard, and the countdown around each chip in the rider-finder stack. They all
// have to agree — a rider showing two segments on the map and an orange chip in the corner is two
// answers to one question — so the levels and their colours live here rather than in any of them.

/** Segments on the urgency bar. The level *is* the count of lit ones. */
export const URGENCY_SEGMENTS = 4;

/**
 * Level for a fraction of time remaining: 4 (just spawned) down to 0 (out of time).
 *
 * Even quarters. The old ring banded at 0.60 / 0.35 / 0.15, which was fine for a colour but wrong
 * for a bar — it would hold four segments through the first 40% of the clock and then shed the
 * other three in a rush. A segment per quarter makes each one lost the same amount of news.
 */
export function urgencyLevel(fraction) {
  if (!(fraction > 0)) return 0;
  return Math.min(URGENCY_SEGMENTS, Math.ceil(fraction * URGENCY_SEGMENTS));
}

const COLORS = PALETTE.urgency.map((hex) => new THREE.Color(hex));

/** Colour for a level. Tied to how many segments remain, never to which segment. */
export const urgencyColor = (level) => COLORS[THREE.MathUtils.clamp(level, 0, URGENCY_SEGMENTS)];

/** Colour for a fraction — the form the ring and the finder chips want. */
export const urgencyColorFor = (fraction) => urgencyColor(urgencyLevel(fraction));
