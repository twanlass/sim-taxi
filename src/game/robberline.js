import { POOL_CLEAR, POOL_EDGE } from './tutorial.js';
import { createSpeech } from './speech.js';

// The robber's line: the beat between the robber getting in and the police turning up.
//
// A robbery used to go straight from a drive-past to four cop cars and a radio call on the same
// frame, which is the whole event arriving at once while the player was looking at something else.
// It read as traffic changing colour rather than as the game changing mode. So the event now has a
// setup, in three beats:
//
//   1. The robber is in the car. **The world stops**, the city dims around the taxi, and the robber
//      shouts at the driver from a bubble pinned on the taxi they are sitting in (game/speech.js).
//   2. The next tap anywhere clears it. The lights come up and the police come on (`raiseAlarm` in
//      game/robbery.js).
//   3. A beat later, dispatch breaks in (game/radio.js).
//
// **The world stops rather than runs on under it**, and that is the one decision in here that was
// weighed. The tutorial's gated beats let the traffic run, but they are at the top of a run with the
// clocks held and nothing chasing anyone. This one lands mid-run, with the taxi moving and a clock
// that matters about to start — a bubble that waited for a tap over a live city would either eat a
// routing tap the player meant for the road or let the getaway start behind it. Frozen, the tap has
// one meaning and nothing is lost while the line is read. main.js does the freezing, exactly as the
// pause does it: an early return from `frame()` that still draws.
//
// Its own element and its own pool rather than the tutorial's `#coach` and `#spotlight`: the
// tutorial's Loco Mode beat can be mid-showing when a robbery lands, and two owners of one element
// is a bubble that closes the other's line. `body.robber-talk` hides the coach while this is up.

/** What the robber shouts. One per robbery, drawn off the run's own seed. */
export const ROBBER_LINES = [
  'Get me outta here!!!',
  "LET'S GO! COPS ARE EVERYWHERE!",
  'Drive! DRIVE! Step on it!',
  "Don't just sit there — floor it!",
];

// Who is talking, in the bubble's title.
const TITLE = 'Bank robber';
// Where the pointer touches: just over the taxi's roof, since that is where the robber is.
const TIP_Y = 2.8;

/**
 * @param viewport      util/viewport.js — the frame the bubble is kept inside
 * @param taxi          the player's car, which the pool is centred on
 * @param project       (x, y, z) => {x, y} — world to viewport pixels
 * @param pixelsPerUnit () => number — the camera's current scale, for sizing the pool
 * @param pickLine      () => string — which line this robbery gets
 * @param onDone        () => void — the bubble has been dismissed: raise the alarm
 */
export function createRobberLine({ viewport = null, taxi, project, pixelsPerUnit, pickLine, onDone }) {
  const root = document.getElementById('robber-talk');
  const spot = document.getElementById('robber-spot');
  const idle = { isOpen: () => false, open: () => false, update: () => {}, cancel: () => {} };
  if (!root || !spot) return idle;

  let open = false;
  const bubble = createSpeech(root, { viewport, typing: true, onDismiss: () => close() });

  function aim() {
    // 1.4 up, the middle of the car's flank — the tutorial's own aim.
    const p = project(taxi.x, 1.4, taxi.z);
    const px = pixelsPerUnit();
    spot.style.setProperty('--sx', `${p.x.toFixed(0)}px`);
    spot.style.setProperty('--sy', `${p.y.toFixed(0)}px`);
    spot.style.setProperty('--r0', `${(POOL_CLEAR * px).toFixed(0)}px`);
    spot.style.setProperty('--r1', `${(POOL_EDGE * px).toFixed(0)}px`);
  }

  function close() {
    if (!open) return;
    open = false;
    bubble.hide();
    document.body.classList.remove('robber-talk');
    onDone();
  }

  // The element is a full-screen catcher while it is up (`body.robber-talk #robber-talk` in
  // index.html), so a tap anywhere lands here and not on the canvas: the route drag and the picker
  // both only take presses whose target *is* the canvas. `click` rather than `pointerdown`, so the
  // catcher is still there for the click that follows the press and nothing falls through to the
  // city on the way out.
  root.addEventListener('click', () => { if (open) bubble.tap(); });

  // Space and Enter answer it too. Space is also the Loco Mode key, whose own handler is registered
  // first and stands down while this is open (main.js), so the press that clears the bubble does
  // not also floor it.
  window.addEventListener('keydown', (event) => {
    if (!open || event.repeat || (event.code !== 'Space' && event.code !== 'Enter')) return;
    event.preventDefault();
    bubble.tap();
  });

  return {
    isOpen: () => open,
    /** The robber is in the car: stop, dim, shout. */
    open() {
      if (open) return false;
      open = true;
      // Aimed before the fade, or the pool blooms from wherever it was last left.
      aim();
      document.body.classList.add('robber-talk');
      bubble.show(TITLE, pickLine(), () => project(taxi.x, TIP_Y, taxi.z));
      return true;
    },
    /** Wall time: the world is stopped while this is up, so there is no game time to read. */
    update(dt) {
      if (!open) return;
      bubble.update(dt);
      // Re-aimed every frame for a resize or a rotation — the city does not move under it.
      aim();
    },
    /** The run ended under it. Clear without raising anything. */
    cancel() {
      if (!open) return;
      open = false;
      bubble.hide();
      document.body.classList.remove('robber-talk');
    },
  };
}
