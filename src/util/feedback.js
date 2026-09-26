/**
 * One player-facing event, delivered on every output the device happens to have.
 *
 * **The audio event names and the haptic event names are the same eight names, fired on the same
 * eight lines**, and that is not a coincidence to be maintained by hand. Each of those moments is an
 * input the game *accepted* — a refused tap, a press it ignored and a second rider while carrying
 * all return without one — which is exactly the gate both a confirming buzz and a confirming sound
 * need. Wiring them through one call means they cannot drift apart later: a ninth event is added in
 * one place, and a call site cannot end up buzzing without sounding.
 *
 * Neither channel is guaranteed. The Taptic Engine exists only inside the native shell (there is no
 * web fallback, and util/haptics.js explains at length why not); audio exists only after a gesture
 * has unlocked a context, and only once a clip has been chosen for the event at all — which right
 * now is never, so every call is a buzz and a silence. Both no-op quietly rather than throwing,
 * because a lost confirmation is never worth an error.
 *
 * What is *not* routed through here is anything positional or continuous. A sound that belongs to a
 * place in the city needs a `screenX`, and a loop needs a handle to stop; both go to the player
 * directly. This is the confirmation path only.
 */

import { tap } from './haptics.js';
import { sound } from '../audio/cue.js';

/**
 * Fire one event on every channel.
 *
 * Throws on a name neither side knows — `tap()` validates against its own list and `sound()` against
 * the audio manifest, so a typo fails on the first of the two rather than going silently missing on
 * both. That is the entire reason both keep an explicit allow-list.
 */
export function cue(event, opts) {
  tap(event);
  sound(event, opts);
}
