/**
 * The mix: every number the artist is allowed to move, as data.
 *
 * **This file is the half of the collaboration that decides whether it is pleasant or miserable.**
 * The samples are the artist's and live in `clips/`; the levels are ours and live here, so "make it
 * 2dB quieter" is a diff in this file rather than a round trip through somebody's DAW. The lab at
 * `/audio/` scrubs these live and copies the result out as JSON to paste back in — see
 * docs/audio.md.
 *
 * Kept separate from `events.js` on purpose. That file is the *taxonomy* — the names, which bus each
 * belongs to, how many voices it may take — and changing it is a code change with call sites behind
 * it. This one is a preference, and a bad value here makes the game sound wrong rather than break.
 */

/** Master, applied after every bus. The one knob a player-facing volume control would move. */
export const MASTER = 0.8;

/**
 * Per-bus level and voice cap.
 *
 * **The caps are the load-bearing half.** A dozen ambient cars, a siren, a drawbridge and a boosting
 * taxi will stack into mud, and when they do the samples get blamed rather than the arithmetic — so
 * the ceiling is set before the first real sound lands rather than after someone complains. Oldest
 * voice on the bus loses when the cap is reached (`steal` below), which is the right rule for a
 * stream of short confirmations and the wrong one for music; `music` is capped at 1 so the question
 * never arises.
 */
export const BUSES = {
  sfx: { gain: 1.0, voices: 8 },
  engine: { gain: 0.7, voices: 2 },
  ambience: { gain: 0.5, voices: 6 },
  music: { gain: 0.6, voices: 1 },
};

/** How a bus at its cap makes room. `'oldest'` is the only rule implemented; named so it is a decision. */
export const STEAL = 'oldest';

/**
 * Ducking: while a bus on the left is sounding, the buses on the right are held down by that factor.
 *
 * One rule, and it is the one worth having on day one — an `sfx` hit ducks the music bed rather than
 * fighting it. Expressed as a table rather than scattered through call sites so the whole behaviour
 * is legible in one place, and so the lab can show it.
 */
export const DUCK = {
  sfx: { music: 0.6 },
};

/** Seconds a duck takes to come on and to let go. Asymmetric: fast in, slow out, or it pumps. */
export const DUCK_ATTACK = 0.04;
export const DUCK_RELEASE = 0.35;

/**
 * How far off centre a sound may be panned, and how much a sound at the edge of the frame is dimmed.
 *
 * **The camera never rotates and the projection is orthographic, so screen position is the whole
 * answer** — `projectToScreen` (game/camera.js) already gives an x, and the pan is that x as a
 * fraction of the half-frame. That is why this project does not use `THREE.PositionalAudio`: a
 * distance model wants a perspective listener, and this eye sits 400 units from everything, the same
 * arithmetic that makes fog here a band around the standoff rather than a distance (CLAUDE.md).
 *
 * `PAN_MAX` short of 1 on purpose: a UI confirmation pinned hard to one ear reads as a fault rather
 * than as placement, and these are mostly confirmations.
 */
export const PAN_MAX = 0.65;
export const OFFSCREEN_GAIN = 0.35;

/** The shape a stash or a pasted blob may carry. Anything else in the payload is dropped on the way in. */
export const MIX_KEYS = ['master', 'buses', 'duck', 'pan'];

/** The shipped mix as one plain object — what the lab opens on, and what "Reset" goes back to. */
export function shippedMix() {
  return {
    master: MASTER,
    // Copied rather than referenced: the lab mutates what it is handed, and a slider must not be
    // able to edit the shipped constants that "Reset" is supposed to restore.
    buses: Object.fromEntries(Object.entries(BUSES).map(([k, v]) => [k, { ...v }])),
    duck: { attack: DUCK_ATTACK, release: DUCK_RELEASE, table: structuredClone(DUCK) },
    pan: { max: PAN_MAX, offscreen: OFFSCREEN_GAIN },
  };
}
