import { createSpeech } from './speech.js';

// "Head to the shop for repairs." — the depot calling the taxi in once it is badly hurt.
//
// A repair is a tap on the depot (`sendForRepairs` in main.js), and nothing said so: the car wears
// its damage (game/taxidamage.js) but a smoking car is a warning without an instruction, and the
// garage is a building like any other until you know what it is for. So the depot says it, from
// over its own door, on the frame the car starts smoking — `SMOKE_FRACTION`, the third of the four
// damage tiers. That is the tier the car starts to look like it is in trouble; earlier and the call
// would be nagging about a swinging lamp, later (the plume at 20%) and it is one hit from too late.
//
// Pinned over the garage door, so the bubble is also the answer to "where": the depot is usually
// off frame while the taxi is out working, and the shared bubble (game/speech.js) waits at the
// screen's edge pointing at it until the player pans that way.
//
// Once per bout of damage: main.js re-arms it only when the car is back above the line, which in
// practice means a repair. Timed rather than answered, like dispatch, because the tap the player is
// about to make — on the depot, if they take the advice — belongs to the city. And it always runs
// its full time: it used to come down the moment the player tapped the depot, which made it too easy
// to lose before it had been read. Only the run ending takes it down early.

/** Who says it, and what. The Figma file's "Frame 22". */
export const DEPOT_CALL = { title: 'Taxi Depot', line: 'Head to the shop for repairs.' };

/**
 * How long it stays up, in seconds of game time — longer than dispatch's 3.2, because this one is
 * an instruction the player may want to act on, and it is usually pointing off screen.
 */
export const DEPOT_CALL_LINGER = 5;

// Where the pointer touches: a little over the top of the door opening (DOOR_H in city/garage.js),
// on the door's face, which is the part of the depot the camera is placed to see.
const OVER_DOOR = 0.8;

/**
 * @param site      the depot's geometry — `garageSite` in city/garage.js
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the bubble is kept inside
 */
export function createDepotCall({ site, project, viewport = null }) {
  const root = document.getElementById('depot-call');
  const idle = { state: { open: false }, show: () => {}, hide: () => {}, update: () => {} };
  if (!root || !site) return idle;

  const bubble = createSpeech(root, { viewport });
  const state = { open: false, left: 0 };
  const at = () => project(site.frontX, site.doorH + OVER_DOOR, site.doorZ);

  function hide() {
    if (!state.open) return;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    show() {
      state.open = true;
      state.left = DEPOT_CALL_LINGER;
      bubble.show(DEPOT_CALL.title, DEPOT_CALL.line, at);
    },
    /** Taken down early: the run is over. */
    hide,
    /** Game time, so a pause holds it. */
    update(dt) {
      bubble.update(dt);
      if (!state.open) return;
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
