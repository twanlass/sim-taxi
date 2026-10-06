import { riverBanks } from '../city/grid.js';
import { REEL } from './uturnreel.js';
import { reelPlayer, createMoveClip } from './moveclip.js';

// The U-turn, acted out: a short clip for the New Move card (game/newmove.js), filmed **in the
// player's own city**. A real straight street, picked when the card opens, at the game's own 3/4
// view, with a stand-in taxi doing one loop of the move — it cruises in, floors it, taps the brake
// twice and spins round onto the far lane, then drives back the way it came. The card's pedal row
// is pressed off **this clip's clock** (`clipKeys`), so the boost key goes down on the frame the
// flame lights and each brake key on the frame the brake lamps do. That is the whole point of the
// clip (Tyler, 2026-10-04): the player sees the buttons and the car do the same thing at once.
//
// The camera, the stand-in and the still over the city are game/moveclip.js, shared with the drift's
// card (game/driftclip.js); this file is the U-turn's own part: its timeline, its reel and where in
// the city it can be filmed.
//
// **The game's own U-turn, played back.** The motion is a recording (game/uturnreel.js) of the
// shipped traffic model driving the taxi through the move with the pedals pressed on the timeline
// below — Loco Mode's launch and wheelie, the boost weave, `spinTaxi`'s slide and snap, the
// suspension — made by tools/uturnreel.mjs on the passing lab's straight road, and checked against a
// fresh take on every `npm run check` so it cannot drift from the game.

// The timeline, in seconds into the loop — what the recording pressed, and what the pedal row shows.
// Boost goes down at BOOST_ON and comes up just before the first brake tap; the two taps are 0.3s
// apart, inside bootleg.js's 350ms COMBO_GAP_MS, and the second is the spin.
export const BOOST_ON = 0.5;
export const BOOST_OFF = 1.5;
export const TAP_1 = 1.6;
export const TAP_2 = 1.9;
export const TAP_LEN = 0.13;          // how long a key reads as pressed
const KEYS_OFF = 4.2;                 // the row dims for the last beat, then the loop starts again

/** The loop, in seconds: the length of the recording. */
export const CLIP_LOOP = 4.6;

// Along the street the clip is centred on the middle of everything the car covers, so the street
// picker and the framing both work from the street's own centre.
const ALONGS = REEL.frames.map((f) => f[0]);
const ALONG_MID = (Math.min(...ALONGS) + Math.max(...ALONGS)) / 2;
const PLAYER = reelPlayer(REEL, { alongShift: ALONG_MID });

/**
 * The car at time t into the loop, interpolated off the reel: along (from the middle of the run,
 * + the way the car sets off), lateral (from the centreline, + the driver's right), y, roll, yaw
 * (from the street's heading, unwrapped), pitch, the wheel lock, the brake lamp and the flame.
 */
export const reelAt = (t) => PLAYER.at(t);

/**
 * The pedal row at time t: for each key, whether it is lit (pressed at some point this loop) and
 * whether it is down right now. Read by newmove.js every frame.
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  return {
    boost: { lit: on && t >= BOOST_ON, down: t >= BOOST_ON && t < BOOST_OFF },
    brake1: { lit: on && t >= TAP_1, down: t >= TAP_1 && t < TAP_1 + TAP_LEN },
    brake2: { lit: on && t >= TAP_2, down: t >= TAP_2 && t < TAP_2 + TAP_LEN },
  };
}


// Street choice: the run's whole extent along the street, with a car's length spare at each end,
// and how wide a corridor it needs kept clear of parked-up traffic either side of the centreline.
const RUN_FROM = Math.min(...ALONGS) - ALONG_MID - 3;
const RUN_TO = Math.max(...ALONGS) - ALONG_MID + 3;
const CLEAR_LATERAL = 5;

/** How far a lane's street runs straight on past its far end, through junctions, while it stays open. */
function straightReach(network, lane, closed) {
  let reach = 0;
  let at = lane;
  for (let k = 0; k < 4 && network.turnById; k++) {
    const turn = at.exits?.map((id) => network.turnById.get(id)).find((tr) => tr?.hand === 'straight');
    const next = turn && network.laneById.get(turn.outLane);
    if (!next || next.degenerate || next.klass !== lane.klass || closed(next.id)) break;
    reach += turn.length + next.length;
    at = next;
  }
  return reach;
}

/**
 * Pick the street to film: a straight two-way side street, off the river, with nothing in the way —
 * no car (the taxi included) stopped anywhere along the run, and as much of it as possible in view
 * past the buildings. Of the two lanes, the one that runs left to right on screen, so the move reads
 * in the order the buttons do.
 *
 * @param network   the city's road network (city/roadnet.js `cityNetwork()`)
 * @param cars      every car on the map, taxi included — anything with x and z
 * @param camRight  the city camera's screen-right vector, in world space
 * @param visible   (x, z) => boolean — is this patch of road seen past the buildings
 * @param closed    (laneId) => boolean — roadworks
 * @param run       {from, to} — the run's extent along the street from its centre; the U-turn's by
 *                  default, and the overtake's clip asks for its own (game/overtakeclip.js)
 * @param klasses   the road classes to film on: side streets, and the ring for the overtake
 * @returns {centre, forward, right, offset} or null when nothing qualifies
 */
export function pickStreet({
  network, cars, camRight, visible = () => true, closed = () => false,
  run = { from: RUN_FROM, to: RUN_TO }, klasses = ['side'],
}) {
  const banks = riverBanks();
  const { from: RUN_FROM, to: RUN_TO } = run;
  let best = null;
  for (const lane of network?.lanes ?? []) {
    if (lane.degenerate || !klasses.includes(lane.klass) || !lane.path || lane.edge.oneway) continue;
    const t0 = lane.path.tangentAt(0);
    const t1 = lane.path.tangentAt(lane.length);
    if (t0.x * t1.x + t0.z * t1.z < 0.9999) continue;          // straight only
    if (t0.x * camRight.x + t0.z * camRight.z <= 0) continue;   // left to right on screen
    const other = lane.edge.lanes.find((l) => l !== lane);
    if (!other || other.degenerate || closed(lane.id) || closed(other.id)) continue;
    // The run is three blocks long at the game's real speeds, so the street has to carry straight on
    // through the junctions either side of this block — the same kind of street, open — or the
    // stand-in drives off the end of a T-junction, into a park or off the map.
    if (straightReach(network, lane, closed) < RUN_TO - lane.length / 2
      || straightReach(network, other, closed) < -RUN_FROM - other.length / 2) continue;

    const mid = lane.path.at(lane.length / 2);
    const otherMid = other.path.at(other.length / 2);
    const centre = { x: (mid.x + otherMid.x) / 2, z: (mid.z + otherMid.z) / 2 };
    const forward = { x: t0.x, z: t0.z };
    const right = { x: -forward.z, z: forward.x };
    const offset = Math.hypot(mid.x - centre.x, mid.z - centre.z);
    const at = (along, side) => ({
      x: centre.x + forward.x * along + right.x * side,
      z: centre.z + forward.z * along + right.z * side,
    });

    // Off the river and its bridges: the deck arches, and the stand-in drives on flat ground.
    const ends = [at(RUN_FROM, 0), at(RUN_TO, 0)];
    if (banks && ends.some((p) => p.z > banks.z0 - 6 && p.z < banks.z1 + 6)) continue;
    if (banks && (ends[0].z - banks.z0) * (ends[1].z - banks.z0) < 0) continue;

    // Nothing parked in the way. A car is frozen where it stands for as long as the card is up.
    const blocked = cars.some((car) => {
      const dx = car.x - centre.x;
      const dz = car.z - centre.z;
      const along = dx * forward.x + dz * forward.z;
      const side = dx * right.x + dz * right.z;
      return along > RUN_FROM && along < RUN_TO && Math.abs(side) < CLEAR_LATERAL;
    });
    if (blocked) continue;

    let seen = 0;
    let samples = 0;
    for (let along = RUN_FROM + 3; along <= RUN_TO - 3; along += 2) {
      for (const side of [offset, -offset]) {
        const p = at(along, side);
        samples += 1;
        if (visible(p.x, p.z)) seen += 1;
      }
    }
    const score = seen / samples - Math.hypot(centre.x, centre.z) * 1e-4;   // ties go to the middle
    if (!best || score > best.score) best = { score, centre, forward, right, offset };
  }
  return best;
}

/**
 * The clip, filmed in the main scene (game/moveclip.js). Returns null when no street qualifies; the
 * card then shows without a clip.
 *
 * @param street  pickStreet's answer; the rest is createMoveClip's
 */
export function createUturnClip({ street, ...opts }) {
  return createMoveClip({ ...opts, place: street, player: PLAYER });
}
