import { BOARD_SECONDS } from './fares.js';

// The taxi's rear door swinging open for a rider and slamming behind them. Render-only flourish:
// the door is ~7px at play zoom, so it is a beat of motion on the kerb side rather than a thing to
// read. Parts and hinge live in geometry/taxi.js (`setDoor`).
//
// Timed off the boarding fare's own clock (`fare.boarding`, 0..BOARD_SECONDS) rather than off the
// `'pickup'` event, for two reasons: a robber boards without one (they spawn already riding, see
// `spawnRobber` in game/fares.js), and reading the progress keeps the door in step with the figure
// frame for frame instead of on a parallel timeline that could drift from it.
//
// The side is not decided here. game/fares.js latches it on the fare (`boardingSide`, via
// `taxiSideToward`) on the first frame of the run and aims the rider at that door, so the figure
// and the door it climbs through are answering the same question once rather than twice.
//
// person.js `board()` runs until 0.7 of the clock and hops for the rest, so the door starts opening
// as the rider closes in and is fully open by the time they leave the ground.
const OPEN_FROM = 0.4;           // fraction of BOARD_SECONDS
const OPEN_TO = 0.68;
const OPEN_ANGLE = 1.15;         // rad, ~66°
const CLOSE_TIME = 0.16;         // s, after the rider is in — quick, it's a slam
const REBOUND = 0.12;            // rad, the bounce off the frame
const REBOUND_TIME = 0.12;       // s

/**
 * `setDoor(side, angle)` is the mesh's. Call `update` every frame with whichever fare is currently
 * boarding, or null — after `fares.update`, which is what latches the fare's `boardingSide`.
 */
export function createTaxiDoor({ setDoor }) {
  let fare = null;          // the boarding fare the door is open for
  let side = 0;
  let angle = 0;
  let closing = -1;         // seconds since the rider vanished, or −1 while not closing
  let closeFrom = 0;

  function update(dt, boarding) {
    if (boarding && boarding.boarding !== undefined) {
      const p = boarding.boarding / BOARD_SECONDS;
      if (boarding !== fare) {
        if (p < OPEN_FROM) { tick(dt); return; }
        fare = boarding;
        side = boarding.boardingSide ?? 1;
        closing = -1;
      }
      const u = Math.min(1, (p - OPEN_FROM) / (OPEN_TO - OPEN_FROM));
      angle = OPEN_ANGLE * (1 - (1 - u) * (1 - u));   // ease out: flung open, settling
      setDoor(side, angle);
      return;
    }
    tick(dt);
  }

  // Shut whatever is open: ease in to the frame, a small bounce off it, then put away.
  function tick(dt) {
    if (!fare) return;
    if (closing < 0) { closing = 0; closeFrom = angle; }
    closing += dt;
    if (closing < CLOSE_TIME) {
      const u = closing / CLOSE_TIME;
      angle = closeFrom * (1 - u * u);
    } else if (closing < CLOSE_TIME + REBOUND_TIME) {
      angle = REBOUND * Math.sin(Math.PI * (closing - CLOSE_TIME) / REBOUND_TIME);
    } else {
      fare = null;
      angle = 0;
    }
    setDoor(side, angle);
  }

  return { update };
}
