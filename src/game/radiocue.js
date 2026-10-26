import { createSpeech } from './speech.js';

// "♪ ♫ (turns up the radio)" — the taxi's one line, the first time it rolls out of the garage after
// the backstory (Tyler, 2026-10-26). The story ends on dispatch talking over the radio; the run opens
// on the station opening out of the dash speakers into the full mix (`openDash` in game/sfx.js). This
// is the caption that ties the two together, in the shared speech card (game/speech.js) with its tag
// on the taxi's roof, so the player reads the change in the music as something the driver did.
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

/** Seconds of game time it stays up: dispatch's RADIO_LINGER and a little, as it types in. */
export const RADIO_CUE_SECONDS = 3.6;

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

  const bubble = createSpeech(root, { viewport });
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
