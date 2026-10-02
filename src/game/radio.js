import { createSpeech } from './speech.js';

// The police radio: a bubble that says the fare who just got in is not a fare.
//
// A robber boards on the ordinary urgency scale — same crystal, same ring, same band of paint (see
// docs/gameplay.md#the-robber) — so the figure coming down the bank's steps was the only thing
// saying this pickup is different, and it is a 20px figure the player was not looking at, because a
// robbery triggers on a drive-*past*. The police arriving says it too, but a beat later and off
// screen. This says it a beat after the robber's own line (game/robberline.js) is cleared —
// `RADIO_DELAY` in main.js — so the robber says who got in and this says what that means.
//
// The same bubble as everything else that talks (game/speech.js), pinned on a police car — the one
// nearest the bank when the robbery call goes out, the cruiser that lost you when the chase ends.
// The robbery's cops come in just off screen near the bank (`enterPolice` in sim/traffic.js), so
// the call usually opens waiting at the screen's edge with its pointer aimed at them, which is the
// first word the player gets about which way the police are coming from. It was pinned on the taxi
// at first, on the grounds that the robbery is the one in the back seat, and that read as the taxi
// calling the police on itself. Not answered like the tutorial's or the robber's:
//
//   - No spotlight. The run is live and the clock that matters most in the game has just started;
//     dimming the city over the getaway would spend it.
//   - Nothing to answer. It is `pointer-events: none` and times itself out, because the tap the
//     player is about to make is on the road, routing the getaway, and a bubble that ate it would
//     cost the one second this event is about.
//   - Its own element. The tutorial's third beat can still be cycling when a robbery lands, and
//     the two say different things about different things.
//
// Named `radio` rather than anything with `alert`/`banner`/`popup` in it: ad-blocker filter lists
// match those, and one hit takes the module graph down (see CLAUDE.md).

/** What the dispatcher says when the robber gets in. */
export const ROBBERY_CALL = { title: 'Police dispatch', line: '10-65 in progress!' };

/**
 * ...and what the police say when the patrol cruiser loses the taxi (game/patrol.js). The same
 * channel, because it is the same police: the bubble is how the game says "the cops are talking
 * about *you*". It is the only word the player gets that they got away — the bar going dark says it
 * too, but only to somebody looking at the car. The start of a chase needs no line of its own here:
 * the cop says it from its own roof (game/copshout.js). Ducking into the depot mid-chase
 * (`hideout` in game/patrol.js) gets the same line: from the cop's side it is the same loss.
 */
export const LOST_CALL = { title: 'Police', line: 'Lost the suspect. Resuming patrol.' };

/**
 * How long it stays up, in seconds of game time. Long enough to read the line twice at a glance,
 * short enough that it is gone before the first cop car is on screen to take over saying it. Game
 * time rather than wall time, so a pause holds it rather than eating it.
 */
export const RADIO_LINGER = 3.2;

// Where the pointer touches: just over a cop car's light bar — copshout.js's number.
const TIP_Y = 2.6;

/**
 * @param project   (x, y, z) => {x, y} — world to viewport pixels
 * @param viewport  util/viewport.js — the frame the bubble is kept inside
 */
export function createRadio({ project, viewport = null }) {
  const root = document.getElementById('radio');
  const idle = { state: { open: false }, show: () => {}, update: () => {} };
  if (!root) return idle;

  const bubble = createSpeech(root, { viewport });
  const state = { open: false, left: 0 };
  // The car the call is pinned on, and where it was last seen: a cop can be retired or recycled
  // mid-line (its `police` flag goes), and the bubble should stay where it was rather than follow
  // the car into ordinary traffic.
  let car = null;
  const last = { x: 0, z: 0 };
  const at = () => {
    if (car?.police) { last.x = car.x; last.z = car.z; }
    return project(last.x, TIP_Y, last.z);
  };

  function hide() {
    if (!state.open) return;
    state.open = false;
    bubble.hide();
  }

  return {
    state,
    /**
     * The police talk.
     *
     * @param call  ROBBERY_CALL or LOST_CALL
     * @param cop   the police car to pin it on; nothing is shown without one
     */
    show(call, cop) {
      if (!cop) return;
      car = cop;
      last.x = cop.x;
      last.z = cop.z;
      state.open = true;
      state.left = RADIO_LINGER;
      bubble.show(call.title, call.line, at);
    },
    /** Game time, so a pause holds the bubble; a run that ends takes it down at once. */
    update(dt, { over = false } = {}) {
      bubble.update(dt);
      if (!state.open) return;
      if (over) { hide(); return; }
      state.left -= dt;
      if (state.left <= 0) hide();
    },
  };
}
