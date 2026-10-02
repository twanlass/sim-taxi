import { createSpeech } from './speech.js';

// "Pull over now" — the patrol cruiser shouting at the taxi, in a speech bubble pinned over the car.
//
// The moment a patrol spots you is the moment the rules change: a cop car that was ordinary
// traffic a frame ago is now coming for you, and the only things on screen that said so were the
// bar lighting up and the strobe speeding up — both of them a handful of pixels on a car that may
// be half a block off. So the car says it, over its own roof, where the player's eye already goes
// when a siren starts. It is the police talking to *you*, which is why it is pinned on the cop and
// dispatch's bubble (game/radio.js) is pinned on the taxi — that one is the police talking about you
// to each other, and it is still what says you got away.
//
// **A DOM bubble, not geometry.** The rider's outburst (geometry/cursebubble.js) is built in the
// world because a grawlix is marks rather than words; this has to be *read*, and there is no font
// in the scene. It is the shared bubble (game/speech.js), following the car by projecting a point
// over its roof through the live camera every frame — and waiting at the screen's edge, pointing,
// while the car is out of frame.
//
// It asks nothing of the player — `pointer-events: none` — and leaves on its own after
// SHOUT_SECONDS of game time, so a pause holds it rather than eating it.

/** What the cop shouts. */
export const SHOUT_TITLE = 'Police';
export const SHOUT_LINE = 'Taxi: pull over now';

/**
 * How long it stays up, in seconds of game time. Long enough to read two words at a glance while
 * the car moves under it; short enough that it has gone before the chase is about anything but
 * driving.
 */
export const SHOUT_SECONDS = 2.2;

// How far above the road the tail points, in world units: just over the cruiser's light bar (1.9
// plus the chassis lift), so the tail sits on the roof rather than on the bonnet.
const OVER_ROOF = 2.6;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the bubble is kept inside
 */
export function createCopShout({ project, viewport = null }) {
  const root = document.getElementById('cop-shout');
  const idle = { state: { open: false }, show: () => {}, update: () => {} };
  if (!root) return idle;

  const bubble = createSpeech(root, { viewport });
  const state = { open: false, left: 0 };
  let car = null;
  // Where the car was last seen, so a cruiser that leaves the map mid-line (and is recycled into
  // someone else) doesn't drag the bubble after it.
  const last = { x: 0, z: 0 };
  const at = () => {
    if (car?.police) { last.x = car.x; last.z = car.z; }
    return project(last.x, OVER_ROOF, last.z);
  };

  function hide() {
    if (!state.open) return;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    /** The patrol car at `cop` has just spotted the taxi. */
    show(cop) {
      car = cop;
      state.open = true;
      state.left = SHOUT_SECONDS;
      bubble.show(SHOUT_TITLE, SHOUT_LINE, at);
    },
    /** Game time; a run that ends takes it down at once. Positioned every frame it is up. */
    update(dt, { over = false } = {}) {
      bubble.update(dt);
      if (!state.open) return;
      if (over || !car.police) { hide(); return; }
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
