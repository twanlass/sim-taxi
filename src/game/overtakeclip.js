import { REEL } from './overtakereel.js';
import { reelPlayer, createMoveClip } from './moveclip.js';
import { pickStreet } from './uturnclip.js';

// The overtake, acted out: the clip on its New Move card (game/newmove.js), on a straight street of
// the player's city. The stand-in comes up behind a slow car on Loco Mode, blips the pill off and
// straight back on, and goes round it on the wrong side of the road. The pedal row — Loco, then Loco
// again — is pressed off this clip's clock (`clipKeys`), as the U-turn's and the drift's are.
//
// Two cars this time: the reel carries the car being passed as well (`REEL.lead`), and
// game/moveclip.js draws it beside the stand-in. The motion is a recording (game/overtakereel.js)
// made by tools/overtakereel.mjs on the passing lab's straight road with the overtake combo
// (game/overtake.js) thrown on this timeline, and checked against a fresh take on every
// `npm run check`.

// The timeline, in seconds into the loop. The loop opens with Loco Mode already down and the taxi
// already at its speed, closing on the car — a pass takes ~60 units of road at the Loco top, which is
// most of a city side street's straight run, so the launch the U-turn's clip opens with would not fit
// (tools/overtakereel.mjs films it as a pre-roll and records from PRE_ROLL on). The pill comes up at
// BLIP_OFF and goes straight back down at BLIP_ON — a 150ms blip, inside OVERTAKE_BLIP_MS — and is held
// to the end of the loop, which is the pass.
export const PRE_ROLL = 0.6;
export const BLIP_OFF = 0.45;
export const BLIP_ON = 0.6;
const KEYS_OFF = 2.6;                 // the row dims for the last beat, then the loop starts again

/** The loop, in seconds: the length of the recording. */
export const CLIP_LOOP = 3.0;

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
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  return {
    boost: { lit: on, down: t < BLIP_OFF },
    blip: { lit: on && t >= BLIP_ON, down: on && t >= BLIP_ON },
  };
}

/**
 * The street to film: the U-turn's picker, asked for this run's length — the whole of it, camera
 * track or not, because both cars still drive every unit of it — and allowed the ring road, whose
 * straight sides are the only roads in the city long enough for a pass on a side street's terms.
 */
export function pickOvertakeStreet(site) {
  return pickStreet({
    ...site,
    run: { from: Math.min(...ALONGS) - ALONG_MID - 3, to: Math.max(...ALONGS) - ALONG_MID + 3 },
    klasses: ['side', 'ring'],
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
