import { createSpeech } from './speech.js';

// "Steer with the stick" — the one line that teaches Pac-Man steering (game/steer.js), standing on
// the stick ("Swipe to turn" over the taxi under `?steer=swipe`).
//
// The taxi drives off on its own whether or not the player knows it can be steered, so the tip
// stays up until the stick has been used twice — once could be an accident, twice is the idea.
//
// It waits for the tutorial's camera beats (the pan to the first rider) rather than talking over
// them: the player cannot steer a car they are not looking at.

export const TIP_TITLE = 'Tip';
export const TIP_LINE = 'Swipe to {turn}';
// With the stick (game/joystick.js), the tip stands on it rather than over the car.
export const STICK_LINE = 'Steer with the {stick}';
// Over the taxi's roof sign, in world units, so the tail points at the car rather than into it.
const OVER_ROOF = 3.2;
const TEACH_SWIPES = 2;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js
 * @param taxi      the taxi car
 * @param steer     game/steer.js's controller
 * @param canShow   () => boolean — the run is live and nothing else is framing the camera
 * @param stickTop  () => {x, y} — the stick's top in viewport px; given, the tip points at the stick
 */
export function createSteerTip({ project, viewport = null, taxi, steer, canShow, stickTop = null }) {
  const root = document.getElementById('steer-talk');
  if (!root) return { update: () => {} };
  const bubble = createSpeech(root, { viewport });
  const at = stickTop ?? (() => project(taxi.x, OVER_ROOF, taxi.z));
  const line = stickTop ? STICK_LINE : TIP_LINE;
  let open = false;

  function update(dt) {
    bubble.update(dt);
    const want = canShow() && steer.swipes() < TEACH_SWIPES;
    if (want && !open) {
      open = true;
      // A control is not a talker, so no tag on the stick's version (as the boost hint).
      bubble.show(TIP_TITLE, line, at, null, { tag: !stickTop });
    } else if (!want && open) {
      open = false;
      bubble.hide();
    }
  }

  return { update, isOpen: () => open };
}
