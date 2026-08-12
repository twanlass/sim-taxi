import * as THREE from 'three';
import { PALETTE } from '../palette.js';

// How close a fare is to giving up, as a small integer.
//
// One model, four surfaces: the fare's diamond, the ring on the road it is being driven at, the
// route band running between the two, and the countdown around each chip in the rider-finder stack.
// They all have to agree — a rider showing orange on the map and a yellow chip in the corner is two
// answers to one question — so the levels and their colours live here rather than in any of them.
//
// There were four while a timer ring rode with the taxi. Pulling the scale out of that ring into
// its own module is what let the ring be deleted without taking the scale with it.

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

/**
 * A VIP's fixed purple. Never drawn from the scale above — "this one is a VIP" must not be
 * confusable with how much time it has left.
 */
export const VIP_COLOR = new THREE.Color(PALETTE.vip);

/**
 * A package courier job's fixed cyan — both of its discs and the route band driving at either.
 *
 * Here rather than reached for out of `PALETTE` by each caller, for the reason this whole module
 * exists: it is the one place a job's colour is decided, so the disc on the corner, the pad across
 * town and the band between them cannot end up disagreeing. It sits beside the VIP purple because
 * it is the same kind of exception — a hue that deliberately says *what this job is* rather than
 * how long is left, which for a package is the only honest thing a colour can say: it has no clock.
 *
 * `fareColor` below is untouched. A package is not a fare and has no level to be painted from.
 */
export const PARCEL_COLOR = new THREE.Color(PALETTE.parcel);

/**
 * **The one colour a fare speaks in**, wherever it is speaking: the crystal over the rider's head,
 * the ring on the road the taxi is driving at, the band of paint between them, and the arrow that
 * stands in for the ring off-frame.
 *
 * A single seam, because the alternative is four callers each remembering the VIP exception. It was
 * three of them for a while and one of them (the drop-off) sat outside the scale entirely, which is
 * exactly the split this replaces: hue on anything belonging to a fare now means that fare's clock.
 */
export const fareColor = (level, vip = false) => (vip ? VIP_COLOR : urgencyColor(level));
