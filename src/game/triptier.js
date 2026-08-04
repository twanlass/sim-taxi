// How long a trip is, as a small integer: short, medium, long.
//
// The meter over a waiting rider shows this as a count of lit segments rather than a block figure.
// A number was more precision than the decision needs — nobody weighs 5 blocks against 6, they
// weigh "quick and cheap" against "slow and worth it" — and three tiers is a shape the eye reads
// without stopping to parse a digit.
//
// Its own module rather than a corner of fares.js so the geometry can import it without the whole
// fare loop coming with it, which would be a cycle: fares.js builds the meter.

export const DISTANCE_TIERS = 3;

// Boundaries in blocks (Manhattan, pickup to drop-off). The grid is 5 x 5, so trips run 1 to 10
// blocks: this splits that range roughly into thirds, with the long tier deliberately the widest
// because everything past about seven blocks is the same "this will take the whole clock" story.
const MEDIUM_FROM = 4;
const LONG_FROM = 7;

/** 1 = short (1-3 blocks), 2 = medium (4-6), 3 = long (7+). */
export function distanceTier(blocks) {
  if (blocks >= LONG_FROM) return 3;
  if (blocks >= MEDIUM_FROM) return 2;
  return 1;
}
