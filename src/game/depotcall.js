import { createSpeech } from './speech.js';

// "Tap the garage for repairs" — the depot telling a smoking taxi where to go, in the shared speech
// card (game/speech.js), with its "…" tag on the garage door.
//
// On screen it is the **garage**, never the depot (Tyler, 2026-10-20): "depot" is the code's word.
//
// It was a bubble once before (Tyler, until 2026-10-06), then a New Move-style card with a clip of
// the visit (`REPAIR` in game/newmove.js, game/repairclip.js), which stopped the world for a lesson
// that is one sentence long. Since the speech card docked (#589) a line no longer stands on the road
// the player is steering through, so it came back as a line (Tyler, 2026-10-20). `?repairtip=classic`
// is the card.
//
// Not answered — it times itself out after DEPOT_CALL_SECONDS of game time, so a pause holds it —
// because the tap the player is about to make belongs to the road, or to the depot itself.

export const DEPOT_CALL_TITLE = 'Taxi Garage';
export const DEPOT_CALL_LINE = 'Tap the garage for repairs';

/**
 * How long it stays up, in seconds of game time: the ~0.7s it takes to type, then long enough to
 * read twice while driving. Longer than dispatch's 3.2 because this one asks for something.
 */
export const DEPOT_CALL_SECONDS = 4.5;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the card is kept inside
 * @param site      the garage's site (city/garage.js); the tag points at the top of its door
 */
export function createDepotCall({ project, viewport = null, site }) {
  const root = document.getElementById('depot-call');
  const idle = { state: { open: false }, show: () => {}, hide: () => {}, update: () => {} };
  if (!root || !site) return idle;

  const bubble = createSpeech(root, { viewport });
  const state = { open: false, left: 0 };
  // The lintel over the middle of the door: the tag sits on the building, not on the road in front.
  const at = () => project(site.curtainX, site.focus.y + site.doorH / 2, site.doorZ);

  function hide() {
    if (!state.open) return;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    show() {
      state.open = true;
      state.left = DEPOT_CALL_SECONDS;
      bubble.show(DEPOT_CALL_TITLE, DEPOT_CALL_LINE, at);
    },
    /** Taken down early — the player did what it said. */
    hide,
    /** Game time; a run that ends takes it down at once. */
    update(dt, { over = false } = {}) {
      bubble.update(dt);
      if (!state.open) return;
      if (over) { hide(); return; }
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
