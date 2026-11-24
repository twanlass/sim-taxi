import { createSpeech } from './speech.js';

// "Swipe to turn" — the one line that teaches Pac-Man steering (game/steer.js), pinned over the taxi.
//
// Two moments need it. The first is the start of a run: nothing on screen says the map takes a
// swipe now, and the taxi drives off on its own whether or not the player knows. So the tip stands
// over the car until the player has swiped twice — once could be an accident, twice is the idea.
// The second is the dead end: a taxi waiting at a T for a turn nobody has queued looks broken, so
// a hold that lasts HOLD_PROMPT seconds says it again, every time, until the player answers it.
//
// It waits for the tutorial's camera beats (the pan to the first rider) rather than talking over
// them: the player cannot steer a car they are not looking at.

export const TIP_TITLE = 'Tip';
export const TIP_LINE = 'Swipe to {turn}';
// How long the taxi may wait at a dead end before the tip comes back, in seconds of game time.
const HOLD_PROMPT = 0.8;
// Over the taxi's roof sign, in world units, so the tail points at the car rather than into it.
const OVER_ROOF = 3.2;
const TEACH_SWIPES = 2;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js
 * @param taxi      the taxi car
 * @param steer     game/steer.js's controller
 * @param canShow   () => boolean — the run is live and nothing else is framing the camera
 */
export function createSteerTip({ project, viewport = null, taxi, steer, canShow }) {
  const root = document.getElementById('steer-talk');
  if (!root) return { update: () => {} };
  const bubble = createSpeech(root, { viewport });
  const at = () => project(taxi.x, OVER_ROOF, taxi.z);
  let open = false;
  let held = 0;

  function update(dt) {
    bubble.update(dt);
    held = steer.holding() ? held + dt : 0;
    const want = canShow() && (steer.swipes() < TEACH_SWIPES || held >= HOLD_PROMPT);
    if (want && !open) {
      open = true;
      bubble.show(TIP_TITLE, TIP_LINE, at);
    } else if (!want && open) {
      open = false;
      bubble.hide();
    }
  }

  return { update, isOpen: () => open };
}
