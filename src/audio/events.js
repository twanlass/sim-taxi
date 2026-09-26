/**
 * Every sound the game can make, by name, and the numbers each one is played with.
 *
 * **This is `util/haptics.js`'s `EVENTS` set doing the same job for a second output device**, and it
 * is written the same way for the same reason: an explicit list, so a typo is a thrown error here
 * rather than silence on the phone. Audio is the most exposed surface in this project to that
 * failure — a feature that renders nothing is indistinguishable from one that was never wired up
 * (see the boats' wake in CLAUDE.md, absent for weeks under a comment saying it worked) — and the
 * only witness to a correct sound is an ear.
 *
 * The eight names here are deliberately the eight `haptic()` already fires, and the call sites are
 * the same lines. That is not laziness: each of those fires at the moment an input was *accepted*,
 * so a refused tap stays silent, which is exactly the gate a confirmation sound needs. Getting the
 * taxonomy for free was the whole argument for starting here — see docs/audio.md.
 *
 * **Naming an event, not a sound.** `haptics.js` posts `'loco'` and lets Swift choose the transient
 * so the choice can be made per device generation; this names the event so the *artist* can replace
 * what `'loco'` sounds like without a code change. A clip is referenced by bare basename and
 * resolved to a hashed URL by `clips.js`; nothing here knows a path or a file extension.
 *
 * **An empty `clips` array is a legal state, not a missing feature.** No sample has been chosen for
 * any of these yet, so every slot is empty and the game is exactly as silent as it was before. The
 * lab at `/audio/` lists the empty slots and lets one be dropped onto; `tools/audio.mjs` checks the
 * names line up rather than checking the array is full. Filling them is the artist's job and needs
 * no JavaScript.
 */

/** The four buses. Anything played names one, and `mix.js` sets what each is worth. */
export const BUSES = ['sfx', 'engine', 'ambience', 'music'];

/**
 * The manifest.
 *
 * - `bus`      — which of `BUSES` it sums into.
 * - `gain`     — its own level, before the bus and the master. 1 is "as delivered".
 * - `pitch`    — playback-rate jitter, ±this, as a fraction. 0 plays the sample exactly.
 * - `cooldown` — seconds before the same event may retrigger. Stops a held control machine-gunning.
 * - `voices`   — how many of *this* event may sound at once. The per-bus cap in `mix.js` is above it.
 * - `clips`    — basenames in `src/audio/clips/`. More than one is a round robin.
 *
 * The numbers are first guesses and are meant to be argued with in the lab, not here. Two of them
 * carry a reason worth keeping:
 *
 * `snap` has the shortest cooldown and the most pitch jitter because it is the one event that
 * repeats *within a single gesture* — it is a detent in a run of detents while the route band is
 * dragged, not an announcement (see the note on it in util/haptics.js) — so it has to survive being
 * heard eight times in two seconds without turning into a machine gun or a single flat tone.
 *
 * `brake` and `loco` fire against a thumb that is already pressed down and holding still. The
 * haptics file notes that a light transient is hard to feel there; the same is true of a quiet
 * sound under a held control, which is why both sit above the taps.
 */
export const EVENTS = {
  // The player did something, and the sound is the control answering the hand.
  pick: { bus: 'sfx', gain: 0.9, pitch: 0.04, cooldown: 0.05, voices: 2, clips: [] },
  grab: { bus: 'sfx', gain: 0.8, pitch: 0.03, cooldown: 0.08, voices: 1, clips: [] },
  snap: { bus: 'sfx', gain: 0.55, pitch: 0.09, cooldown: 0.03, voices: 3, clips: [] },
  brake: { bus: 'sfx', gain: 1.0, pitch: 0.02, cooldown: 0.12, voices: 1, clips: [] },
  loco: { bus: 'sfx', gain: 1.0, pitch: 0.02, cooldown: 0.2, voices: 1, clips: [] },

  // The world did something, and the sound is news.
  'parcel-in': { bus: 'sfx', gain: 0.9, pitch: 0.05, cooldown: 0.1, voices: 1, clips: [] },
  'parcel-out': { bus: 'sfx', gain: 1.0, pitch: 0.03, cooldown: 0.1, voices: 1, clips: [] },
  // The lightest thing in the group, because it reports the smallest reward in the game — a paper
  // bag, not a package. Same reasoning as its haptic.
  burger: { bus: 'sfx', gain: 0.65, pitch: 0.06, cooldown: 0.1, voices: 1, clips: [] },
};

/** The names, in manifest order. The lab's board and `tools/audio.mjs` both walk this. */
export const EVENT_NAMES = Object.keys(EVENTS);

/**
 * Throw on a name that is not in the manifest.
 *
 * Exported rather than kept private because the lab and the headless check want the same answer,
 * and because a caller that has a name from outside (a dropped file, a pasted mix) needs to be able
 * to ask without triggering playback.
 */
export function assertEvent(name) {
  if (!Object.hasOwn(EVENTS, name)) throw new Error(`unknown audio event: ${name}`);
  return EVENTS[name];
}
