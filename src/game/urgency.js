import * as THREE from 'three';
import { PALETTE } from '../palette.js';

// How close a fare is to giving up, as a small integer.
//
// One model, three surfaces: the diamond over the waiting rider, the ring that rides with the taxi
// once they're aboard, and the countdown around each chip in the rider-finder stack. They all have
// to agree — a rider showing orange on the map and a yellow chip in the corner is two answers to
// one question — so the levels and their colours live here rather than in any of them.

/**
 * Steps on the scale, and so the top level: a fare that has just spawned is at URGENCY_SEGMENTS.
 *
 * The name is older than the model. It counted segments on the bar that used to carry urgency over
 * a waiting rider; the bar became a single diamond painted by level, and the count of steps was the
 * only part of it that mattered.
 */
export const URGENCY_SEGMENTS = 4;

/**
 * Level for a fraction of time remaining: 4 (just spawned) down to 0 (out of time).
 *
 * Even quarters. The old ring banded at 0.60 / 0.35 / 0.15, which held the top level through the
 * first 40% of the clock and then ran through the other three in a rush. A step per quarter makes
 * each one the same amount of news.
 */
export function urgencyLevel(fraction) {
  if (!(fraction > 0)) return 0;
  return Math.min(URGENCY_SEGMENTS, Math.ceil(fraction * URGENCY_SEGMENTS));
}

const COLORS = PALETTE.urgency.map((hex) => new THREE.Color(hex));

/** Colour for a level. Clamped, so a fare past its deadline stays on the bottom step. */
export const urgencyColor = (level) => COLORS[THREE.MathUtils.clamp(level, 0, URGENCY_SEGMENTS)];

/** Colour for a fraction — the form the ring and the finder chips want. */
export const urgencyColorFor = (fraction) => urgencyColor(urgencyLevel(fraction));
