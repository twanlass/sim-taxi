// "Pull over!" — the patrol cruiser shouting at the taxi, in a speech bubble pinned over the car.
//
// The moment a patrol spots you is the moment the rules change: a cop car that was ordinary
// traffic a frame ago is now coming for you, and the only things on screen that said so were the
// bar lighting up and the strobe speeding up — both of them a handful of pixels on a car that may
// be half a block off. So the car says it, over its own roof, where the player's eye already goes
// when a siren starts. It is the police talking to *you*, which is why it is a bubble on the car
// and not dispatch's card at the top of the screen (game/radio.js) — that one is the police talking
// about you to each other, and it is still what says you got away.
//
// **A DOM bubble, not geometry.** The rider's outburst (geometry/cursebubble.js) is built in the
// world because a grawlix is marks rather than words; this has to be *read*, and there is no font
// in the scene. It follows the car by projecting a point over its roof through the live camera
// every frame, the same way the robber's line aims its pool (game/robberline.js).
//
// It asks nothing of the player — `pointer-events: none` — and leaves on its own after
// SHOUT_SECONDS of game time, so a pause holds it rather than eating it.

/** What the cop shouts. */
export const SHOUT_LINE = 'Pull over!';

/**
 * How long it stays up, in seconds of game time. Long enough to read two words at a glance while
 * the car moves under it; short enough that it has gone before the chase is about anything but
 * driving.
 */
export const SHOUT_SECONDS = 2.2;

// How far above the road the tail points, in world units: just over the cruiser's light bar (1.9
// plus the chassis lift), so the tail sits on the roof rather than on the bonnet.
const OVER_ROOF = 2.6;

// Matches the exit transition in index.html.
const CLOSE_MS = 180;

/**
 * @param project  (x, y, z) => {x, y} — world to viewport pixels
 */
export function createCopShout({ project }) {
  const root = document.getElementById('cop-shout');
  const idle = { state: { open: false }, show: () => {}, update: () => {} };
  if (!root) return idle;
  root.querySelector('.cop-shout-line').textContent = SHOUT_LINE;

  const state = { open: false, left: 0 };
  let car = null;
  let closing = null;

  function place() {
    const p = project(car.x, OVER_ROOF, car.z);
    root.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  function hide() {
    if (!state.open) return;
    state.open = false;
    root.classList.remove('is-open');
    closing = setTimeout(() => {
      root.hidden = true;
      closing = null;
      car = null;
    }, CLOSE_MS);
  }

  return {
    state,
    /** The patrol car at `cop` has just spotted the taxi. */
    show(cop) {
      if (closing) { clearTimeout(closing); closing = null; }
      car = cop;
      state.open = true;
      state.left = SHOUT_SECONDS;
      place();
      root.hidden = false;
      // One frame of the closed state first, or the transition has nothing to run from.
      void root.offsetWidth;
      root.classList.add('is-open');
    },
    /** Game time; a run that ends takes it down at once. Positioned every frame it is up. */
    update(dt, { over = false } = {}) {
      if (!car) return;
      if (over || !car.police) { hide(); return; }
      place();
      if (!state.open) return;
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
