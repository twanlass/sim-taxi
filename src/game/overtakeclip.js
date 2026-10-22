import { REEL as REEL_CLASSIC } from './overtakereel-classic.js';
import { REEL as REEL_TOUCH } from './overtakereel-touch.js';
import { STREETS_KEY } from '../city/grid.js';
import { reelPlayer, createMoveClip } from './moveclip.js';
import { EDGE_FOG } from './edgefog.js';
import { pickStreet } from './uturnclip.js';

// One recording per street width (`?streets=`, city/grid.js): the shape of the road it was filmed
// on is the shape of the road it has to fit. Exported for tools/check.mjs.
export const REEL = { classic: REEL_CLASSIC, touch: REEL_TOUCH }[STREETS_KEY];

// The overtake, acted out: the clip on its New Move card (game/newmove.js), on a straight street of
// the player's city. The stand-in comes up behind a slow car on Loco Mode, blips the pill off and
// straight back on, and goes round it on the wrong side of the road. The pedal row — Loco, then Loco
// again — is pressed off this clip's clock (`clipKeys`), as the U-turn's and the drift's are.
//
// Two cars this time: the reel carries the car being passed as well (`REEL.lead`), and
// game/moveclip.js draws it beside the stand-in. The motion is a recording (game/overtakereel-<width>.js)
// made by tools/overtakereel.mjs on the passing lab's straight road with the overtake combo
// (game/overtake.js) thrown on this timeline, and checked against a fresh take on every
// `npm run check`.

// The timeline, in seconds into the loop. The loop opens with Loco Mode already down and the taxi
// already at its speed, closing on the car — a pass takes ~60 units of road at the Loco top, which is
// most of a city side street's straight run, so the launch the U-turn's clip opens with would not fit
// (tools/overtakereel.mjs films it as a pre-roll and records from PRE_ROLL on). The pill comes up at
// BLIP_OFF and goes straight back down at BLIP_ON — a 150ms blip, inside OVERTAKE_BLIP_MS — and is held
// to the end of the loop, which is the pass.
//
// The blip comes late, once the taxi is on the car's bumper. It used to come at 0.6s, and since the
// dumb overtake (#581) swings out the frame the combo arms, that put the taxi in the oncoming lane
// 17 units short of the car and kept it there for 1.7s before it drew level — at the end of the loop,
// under the fade — so the card read as a taxi driving up the wrong side of an empty road (Tyler,
// 2026-10-22). Now: 1.7s closing in, out 6 units back, by and tucked in 9 ahead in the last 1.1s.
export const PRE_ROLL = 0.6;
export const BLIP_OFF = 1.55;
export const BLIP_ON = 1.7;
/** When the game counts the pass and lands its combo: the blip back on throws it (sim/traffic.js). */
export const LANDS_AT = BLIP_ON;
const KEYS_OFF = 2.5;                 // the row dims for the last beat, then the loop starts again

/** The loop, in seconds: the length of the recording. */
export const CLIP_LOOP = 2.8;

// Centred on the middle of everything both cars cover, as the U-turn's clip is — but the camera
// follows the car being passed (`track`) rather than standing still: the taxi covers ~80 units in the
// loop, and a frame that held all of it drew both cars at a third the size. Following the slow car
// keeps the two in shot and makes the move read as what it is, the taxi coming up and going round.
const ALONGS = [...REEL.frames.map((f) => f[0]), ...REEL.lead.map((f) => f[0])];
const ALONG_MID = (Math.min(...ALONGS) + Math.max(...ALONGS)) / 2;
const leadAlong = (t) => {
  const u = Math.min(REEL.lead.length - 1, Math.max(0, t / REEL.step));
  const i = Math.min(REEL.lead.length - 2, Math.floor(u));
  return REEL.lead[i][0] + (REEL.lead[i + 1][0] - REEL.lead[i][0]) * (u - i);
};
const PLAYER = reelPlayer(REEL, { alongShift: ALONG_MID, track: leadAlong });

/** The taxi at time t into the loop — see game/moveclip.js `reelPlayer`. */
export const reelAt = (t) => PLAYER.at(t);

/**
 * The pedal row at time t: for each key, whether it is lit (pressed at some point this loop) and
 * whether it is down right now. Read by newmove.js every frame.
 *
 * `pass` is the default card's one key (Tyler, 2026-10-22): the whole gesture is on one button, so
 * it is drawn as one A that goes down, comes up for the blip and goes down again, and its `rhythm`
 * is how far the playhead has filled each of the two holds under it (newmove.js `buildRhythm`). Two A
 * discs side by side (`boost`, `blip`, `?overtakekeys=classic`) read as two presses of one button,
 * and both looked pressed for most of the loop, so nothing on the card said "let go".
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  const fill = (a, b) => (on ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0);
  return {
    boost: { lit: on, down: t < BLIP_OFF },
    blip: { lit: on && t >= BLIP_ON, down: on && t >= BLIP_ON },
    pass: {
      lit: on, down: on && (t < BLIP_OFF || t >= BLIP_ON),
      rhythm: [fill(0, BLIP_OFF), fill(BLIP_ON, KEYS_OFF)],
    },
  };
}

/**
 * The street to film: the U-turn's picker, asked for this run's length — the whole of it, camera
 * track or not, because both cars still drive every unit of it.
 *
 * Side streets only while the edge fog is up (game/edgefog.js). The ring road runs along the fog's
 * inner edge, so a clip filmed there is half fog bank — and where the camera tracked out over the
 * corner, all of it: the white-out on the card Tyler reported (2026-10-22). Every shipped city has
 * a side street long enough once the traffic is cleared off it, which is the picker's own fallback
 * (main.js `filmMove`), so the cost is a clip with no other cars in it on some runs, not a card
 * without a clip. `?edgefog=classic` and the big city keep the ring road.
 */
export const OVERTAKE_KLASSES = EDGE_FOG ? ['side'] : ['side', 'ring'];
export function pickOvertakeStreet(site) {
  return pickStreet({
    ...site,
    run: { from: Math.min(...ALONGS) - ALONG_MID - 3, to: Math.max(...ALONGS) - ALONG_MID + 3 },
    klasses: OVERTAKE_KLASSES,
  });
}

/**
 * The clip, filmed in the main scene (game/moveclip.js). Returns null when no street qualifies; the
 * card then shows without a clip.
 *
 * @param street  pickOvertakeStreet's answer; the rest is createMoveClip's
 */
export function createOvertakeClip({ street, ...opts }) {
  return createMoveClip({ ...opts, place: street, player: PLAYER });
}
