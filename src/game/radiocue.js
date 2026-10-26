import { createSpeech } from './speech.js';
import { storyDockFloor } from './backstory.js';

// "♪ ♫ (turns up the radio)" — the taxi's one line, the first time it rolls out of the garage after
// the backstory (Tyler, 2026-10-26). The story ends on dispatch talking over the radio; the run opens
// on the station opening out of the dash speakers into the full mix (`openDash` in game/sfx.js). This
// is the caption that ties the two together, so the player reads the change in the music as something
// the driver did.
//
// **In the story card's slot, with the "…" tag on the taxi** (Tyler, 2026-10-26). The shared speech
// card (game/speech.js) usually docks over the pedals, and on this frame the pedals are about to
// slide in under it, so it went unseen; pinned over the taxi it read as a one-off. So it docks where
// the backstory's card sat a moment ago (`storyDockFloor`), and it goes the moment the pedals come
// in (`hide` from main.js, beside `revealPedals`) so it never sits over them. It leaves first: the
// pedals and the HUD hold for RADIO_CUE_LEAD after it starts its exit (Tyler, 2026-10-26), so the
// card is sinking out as they rise in rather than the two crossing.
//
// "Turns up" rather than "starts playing": the station is already on, crushed through the dash, from
// Play and through the doorway shot (`holdReveal` waits for the first song), so the thing that
// actually happens on this frame is the volume and the width coming up.
//
// **The notes dance for as long as the card is up** (Tyler, 2026-10-26): each is its own `{…}`
// callout, so each is its own span (`parseLine` in game/speech.js) and `#radio-cue .speech-hl` in
// index.html can hop them on a loop, the second a half-beat behind the first, instead of the one
// wiggle every other callout gets.
//
// Titled "Car 9" because that is what dispatch has just been calling the taxi.
//
// Not answered — it times itself out, like dispatch's lines (game/radio.js) — because the taxi is
// the player's to drive on this frame and the tap belongs to the road. `?radiocue=classic` never
// shows it.

export const RADIO_CUE_TITLE = 'Car 9';
export const RADIO_CUE_LINE = '{♪} {♫} (turns up the radio)';

/**
 * The longest it stays up, in seconds of game time: dispatch's RADIO_LINGER and a little. The roll
 * out to the lane is usually shorter, so it is the pedals arriving that takes it down.
 */
export const RADIO_CUE_SECONDS = 3.6;

/**
 * Seconds between the card starting its exit and the pedals starting theirs, when the pedals are what
 * takes it down. The card's own exit is CLOSE_MS (200 ms) in game/speech.js, so it is gone as they
 * begin to rise.
 */
export const RADIO_CUE_LEAD = 0.2;

// Where the tag touches: just over the taxi's roof sign.
const TIP_Y = 2.2;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the card is kept inside
 * @param taxi      the taxi's sim record (`traffic.taxi`); the tag follows it
 */
export function createRadioCue({ project, viewport = null, taxi }) {
  const root = document.getElementById('radio-cue');
  const idle = { state: { open: false }, show: () => {}, hide: () => {}, update: () => {} };
  if (!root || !taxi) return idle;

  const bubble = createSpeech(root, { viewport, dockFloor: storyDockFloor });
  const state = { open: false, left: 0 };
  const at = () => project(taxi.x, TIP_Y, taxi.z);

  function hide() {
    if (!state.open) return;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    show() {
      state.open = true;
      state.left = RADIO_CUE_SECONDS;
      bubble.show(RADIO_CUE_TITLE, RADIO_CUE_LINE, at);
    },
    hide,
    /** Game time, so a pause holds it; a run that ends takes it down at once. */
    update(dt, { over = false } = {}) {
      bubble.update(dt);
      if (!state.open) return;
      if (over) { hide(); return; }
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
