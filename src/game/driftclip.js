import { riverBanks } from '../city/grid.js';
import { REEL } from './driftreel.js';
import { reelPlayer, createMoveClip, onStreet } from './moveclip.js';

// The drift, acted out: the clip on its New Move card (game/newmove.js), on a real corner of the
// player's city. The stand-in comes up the street, floors it, taps the brake just before a left turn,
// gets back on Loco Mode mid-slide and comes out of the corner on the kick's purple twin plume. The
// pedal row — Loco, brake, Loco — is pressed off this clip's clock (`clipKeys`), as the U-turn's is.
//
// The camera, the stand-in and the still over the city are game/moveclip.js, shared with the U-turn
// (game/uturnclip.js). The motion is a recording (game/driftreel.js) made by tools/driftreel.mjs on a
// grid of side streets and checked against a fresh take on every `npm run check`. It is written in
// the corner's own frame — from the junction's centre, along the approach and across it — so it can
// be laid on any corner of the city whose turn is the same shape (`pickCorner`).

// The timeline, in seconds into the loop — what the recording pressed, and what the pedal row shows.
// Loco goes down at BOOST_ON and the brake tap at TAP takes it back off, as the tap does in the
// game; the pill goes down again at KICK_ON, mid-slide, and is held out of the corner to the end
// of the loop (tools/driftreel.mjs says why).
export const BOOST_ON = 0.5;
export const TAP = 1.2;
export const TAP_LEN = 0.13;          // how long a key reads as pressed
export const KICK_ON = 1.6;
const KEYS_OFF = 2.7;                 // the row dims for the last beat, then the loop starts again

/** The loop, in seconds: the length of the recording. */
export const CLIP_LOOP = 3;

const PLAYER = reelPlayer(REEL);

/**
 * The car at time t into the loop, in the corner's frame: along the approach from the junction's
 * centre, lateral to its right, and the rest as game/moveclip.js `reelPlayer` reads them.
 */
export const reelAt = (t) => PLAYER.at(t);

/**
 * The pedal row at time t: for each key, whether it is lit (pressed at some point this loop) and
 * whether it is down right now. Read by newmove.js every frame.
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  return {
    boost: { lit: on && t >= BOOST_ON, down: t >= BOOST_ON && t < TAP },
    brake: { lit: on && t >= TAP, down: t >= TAP && t < TAP + TAP_LEN },
    kick: { lit: on && t >= KICK_ON, down: on && t >= KICK_ON },
  };
}

// How close a city corner's turn has to be to the recorded one, entry, middle and exit, to take the
// reel without the car visibly leaving the road. This is the whole test of the road's class: a side
// street and the ring are the same width and turn identically, and anywhere an arterial is either
// road the corner is a unit and a third out (its box reaches by its own width, its lanes sit wider).
const TURN_FIT = 0.05;
// How far from the car's path anything parked up has to be: the far lane of the road included, since
// a truck stood in it reads as being in the way of a car sliding past it.
const CLEAR = 5;
// The ring is the island's edge, and a corner on it puts half the clip out over the coast's fade.
const RING_COST = 0.3;
// Every this many seconds of the loop, a sample of the path for the clearance and visibility tests.
const SAMPLE_DT = 0.1;

/** Lanes that lead straight into `lane`, by id. */
function feeders(network) {
  const into = new Map();
  for (const turn of network.turns ?? []) {
    if (turn.hand !== 'straight' || !turn.legal) continue;
    into.set(turn.outLane, turn.inLane);
  }
  return into;
}

/** How far `lane`'s road runs straight on, the way `step` walks it, staying the same class and open. */
function reach(network, lane, step, closed) {
  let total = 0;
  let at = lane;
  for (let k = 0; k < 6; k++) {
    const next = step(at);
    if (!next || next.degenerate || next.klass !== lane.klass || closed(next.id)) break;
    total += next.length + 8;
    at = next;
  }
  return total;
}

/**
 * Pick the corner to film: a left turn the same shape as the recorded one (side streets or the
 * ring), with straight road enough either side of it, off the river, nothing parked on the car's
 * path and as much of it as possible in view past the buildings. Only corners whose approach and
 * exit both run left to right on screen, so the move reads in the order the buttons do — the
 * approach comes down the screen and the exit goes back up it, a V.
 *
 * @param network   the city's road network (city/roadnet.js `cityNetwork()`)
 * @param cars      every car on the map, taxi included — anything with x and z
 * @param camRight  the city camera's screen-right vector, in world space
 * @param visible   (x, z) => boolean — is this patch of road seen past the buildings
 * @param closed    (laneId) => boolean — roadworks
 * @returns {centre, forward, right} or null when nothing qualifies
 */
export function pickCorner({ network, cars, camRight, visible = () => true, closed = () => false }) {
  const banks = riverBanks();
  const into = feeders(network);
  const [ea, el, ma, ml, xa, xl] = REEL.turn;
  const alongs = REEL.frames.map((f) => f[0]);
  const laterals = REEL.frames.map((f) => f[1]);
  // How far back up the approach, and out along the exit, the reel runs.
  const needBack = -Math.min(...alongs);
  const needOut = -Math.min(...laterals);
  const path = [];
  for (let t = 0; t <= PLAYER.loop; t += SAMPLE_DT) path.push(PLAYER.at(t));
  let best = null;
  for (const lane of network?.lanes ?? []) {
    if (lane.degenerate || !lane.path || lane.edge.oneway || closed(lane.id)) continue;
    const node = network.nodeById.get(lane.to);
    const t1 = lane.path.tangentAt(lane.length);
    const forward = { x: t1.x, z: t1.z };
    const right = { x: -forward.z, z: forward.x };
    if (forward.x * camRight.x + forward.z * camRight.z <= 0) continue;
    const place = { centre: { x: node.x, z: node.z }, forward, right };
    const local = (p) => {
      const dx = p.x - node.x;
      const dz = p.z - node.z;
      return [dx * forward.x + dz * forward.z, dx * right.x + dz * right.z];
    };
    for (const id of lane.exits) {
      const turn = network.turnById.get(id);
      if (turn.hand !== REEL.hand) continue;
      const out = network.laneById.get(turn.outLane);
      if (!out || out.degenerate || out.edge.oneway || closed(out.id)) continue;
      const o = out.path.tangentAt(0);
      if (o.x * camRight.x + o.z * camRight.z <= 0) continue;
      // The same shape of corner, or the reel's car leaves the road on it.
      const fit = [[0, ea, el], [0.5, ma, ml], [1, xa, xl]].every(([u, a, l]) => {
        const [pa, pl] = local(turn.path.at(u * turn.length));
        return Math.hypot(pa - a, pl - l) < TURN_FIT;
      });
      if (!fit) continue;
      // Straight road enough before and after: the lane in plus whatever leads straight into it,
      // and the lane out plus whatever it carries straight on into.
      const back = lane.length + reach(network, lane, (l) => network.laneById.get(into.get(l.id)), closed);
      const ahead = out.length + reach(network, out, (l) => {
        const tr = l.exits?.map((e) => network.turnById.get(e)).find((x) => x?.hand === 'straight');
        return tr && network.laneById.get(tr.outLane);
      }, closed);
      if (back < needBack || ahead < needOut) continue;

      const points = path.map((p) => onStreet(place, p.along, p.lateral));
      // Off the river and its bridges: the deck arches, and the stand-in drives on flat ground.
      if (banks && points.some((p) => p.z > banks.z0 - 6 && p.z < banks.z1 + 6)) continue;
      // Nothing parked in the way. A car is frozen where it stands for as long as the card is up.
      if (cars.some((car) => points.some((p) => Math.hypot(car.x - p.x, car.z - p.z) < CLEAR))) continue;
      const seen = points.filter((p) => visible(p.x, p.z)).length / points.length;
      const ring = lane.klass === 'ring' || out.klass === 'ring' ? RING_COST : 0;
      const score = seen - ring - Math.hypot(node.x, node.z) * 1e-4;   // ties go to the middle
      if (!best || score > best.score) best = { score, ...place };
    }
  }
  return best;
}

/**
 * The clip, filmed in the main scene (game/moveclip.js). Returns null when no corner qualifies; the
 * card then shows without a clip.
 *
 * @param corner  pickCorner's answer; the rest is createMoveClip's
 */
export function createDriftClip({ corner, ...opts }) {
  return createMoveClip({ ...opts, place: corner, player: PLAYER });
}
