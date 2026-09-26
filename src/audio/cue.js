/**
 * The module-level way to play a sound, for call sites that should not have to hold a player.
 *
 * **Deliberately the same shape as `tap()` in util/haptics.js**: a bare function, a singleton behind
 * it, and a no-op everywhere it cannot work. The alternative — threading the player object from
 * `main.js` down through `pathdrag.js` and every other module that has a confirmation to fire — is
 * how a feedback call ends up omitted from a new call site because plumbing it there was a chore.
 *
 * `install()` is called once, from `main.js`, after the player is built. Before that — and in node,
 * and in shot mode, and on a page with no audio at all — `sound()` validates the event name and
 * returns false. Validating even while uninstalled is the point: `tools/audio.mjs` and the headless
 * boot both catch a typo without a browser, which is the one failure mode audio cannot show you.
 */

import { assertEvent } from './events.js';

let player = null;

/** Hand the singleton its player. Called once from `main.js`; passing `null` uninstalls it. */
export function install(next) {
  player = next;
}

/**
 * Play one event by name, or do nothing.
 *
 * Returns whether a voice actually started, which is `false` for all eight events today: no sample
 * has been chosen yet. Callers ignore it — a confirmation is fire-and-forget — but the lab reads it
 * to tell "played" apart from "no clip", and those two look identical from the outside.
 */
export function sound(event, opts) {
  assertEvent(event);
  if (!player) return false;
  return player.play(event, opts);
}

/** The installed player, or null. For the debug panel and the lab, not for the game. */
export function audioPlayer() {
  return player;
}
