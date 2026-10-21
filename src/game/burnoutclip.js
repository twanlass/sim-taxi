import { REEL as REEL_CLASSIC } from './burnoutreel-classic.js';
import { REEL as REEL_TOUCH } from './burnoutreel-touch.js';
import { STREETS_KEY } from '../city/grid.js';
import { reelPlayer, createMoveClip } from './moveclip.js';
import { pickStreet } from './uturnclip.js';

// One recording per street width (`?streets=`, city/grid.js), as for the other three. Exported for
// tools/check.mjs.
export const REEL = { classic: REEL_CLASSIC, touch: REEL_TOUCH }[STREETS_KEY];

// The burnout launch, acted out: the clip on its New Move card (game/newmove.js), the card a race
// win earns (game/burnout.js). The stand-in rolls up, stops on the brake, sits on it a beat, and
// leaves on Loco Mode at the launch's pull. The motion is a recording (game/burnoutreel-<width>.js)
// made by tools/burnoutreel.mjs on the passing lab's straight road and checked against a fresh take
// on every `npm run check`, like the U-turn's.

// The timeline, in seconds into the loop. The brake goes down at BRAKE_ON and is held past
// ARM_HOLD with the car stopped; the pill goes down at LOCO_ON, which is the launch, and is held to
// the end of the loop.
export const BRAKE_ON = 0.3;
export const LOCO_ON = 1.5;
/** When the game lands the combo: the pill going down off the armed brake. */
export const LANDS_AT = LOCO_ON;
const KEYS_OFF = 2.9;                 // the row dims for the last beat, then the loop starts again

/** The loop, in seconds: the length of the recording. */
export const CLIP_LOOP = 3.3;

const ALONGS = REEL.frames.map((f) => f[0]);
const ALONG_MID = (Math.min(...ALONGS) + Math.max(...ALONGS)) / 2;
const PLAYER = reelPlayer(REEL, { alongShift: ALONG_MID });

/** The taxi at time t into the loop — see game/moveclip.js `reelPlayer`. */
export const reelAt = (t) => PLAYER.at(t);

/**
 * The pedal row at time t: the brake held from BRAKE_ON until the pill takes over at LOCO_ON (last
 * pedal pressed wins), then the pill held.
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  return {
    brake: { lit: on && t >= BRAKE_ON, down: t >= BRAKE_ON && t < LOCO_ON },
    launch: { lit: on && t >= LOCO_ON, down: on && t >= LOCO_ON },
  };
}

/** The street to film: the U-turn's picker, asked for this run's length. */
export function pickBurnoutStreet(site) {
  return pickStreet({
    ...site,
    run: { from: Math.min(...ALONGS) - ALONG_MID - 3, to: Math.max(...ALONGS) - ALONG_MID + 3 },
  });
}

/** The clip, filmed in the main scene (game/moveclip.js); null when no street qualifies. */
export function createBurnoutClip({ street, ...opts }) {
  return createMoveClip({ ...opts, place: street, player: PLAYER });
}
