// The warehouse shortcut's moving half (the shed is city/warehouse.js): the doors bursting open as
// the boosting taxi hits them, and rolling back down once it has gone.
//
// **Read off where the taxi is, not off the sim's lane bookkeeping.** The sim only lets the taxi
// into the street while it is boosting (`refusesLane` in sim/traffic.js), so the one question left
// here is geometric — is the car's nose at a door — and asking it in world space is what keeps the
// burst on the door the player is looking at rather than on a hold line a few units short of it.
//
// A door is either shut, bursting (up in a tenth of a second — a roller door hit at Loco speed does
// not wind, it goes), open, or rolling back down at the depot's pace. It only rolls down once the
// taxi is clear of the whole building, so a car still inside never has a curtain come down on it.

/** How close the nose has to get to a shut door's plane, in world units. */
const HIT_REACH = 2.6;
/** The taxi's half-width plus a little, for "is it in the opening" across the street. */
const IN_OPENING = 4.2;
/** Up in this long when hit. */
const BURST_TIME = 0.1;
/** Held open this long after the taxi is clear of the building, then down at this rate (per second). */
const HOLD_OPEN = 2.2;
const CLOSE_RATE = 0.45;
/** Clear of the building means this far past either door. */
const CLEAR = 6;

/**
 * @param o.site     `warehouseSite` (city/warehouse.js)
 * @param o.setDoor  `(n, open)` from `createWarehouse`
 * @param o.onSmash  `({ x, z, yaw, exit, v })` — a door just burst. `exit` is the door the taxi is
 *                   leaving by: main.js throws the bigger dust ball out of that one.
 * @param o.committed `(taxi) => boolean` — on the street or turning onto it (`onPassage` in
 *                   game/route.js). A taxi turning away at the junction comes within a door's reach
 *                   with its nose still pointed at it, and must not burst it.
 */
export function createShortcut({ site, setDoor, onSmash = () => {}, committed = () => true }) {
  const doors = site.doors.map((d) => ({ ...d, open: 0, state: 'shut', hold: 0 }));
  const { cx, wall } = site;
  let smashes = 0;

  function inside(taxi) {
    return Math.abs(taxi.x - cx) < IN_OPENING && taxi.z > wall.z0 && taxi.z < wall.z1;
  }

  function update(dt, taxi) {
    const alongX = Math.abs(taxi.x - cx) < IN_OPENING;
    // Heading along z, from the yaw: forward is (cos yaw, −sin yaw) in this project's frame.
    const fz = -Math.sin(taxi.yaw);
    const clear = taxi.z < wall.z0 - CLEAR || taxi.z > wall.z1 + CLEAR || !alongX;
    for (let n = 0; n < doors.length; n++) {
      const door = doors[n];
      if (door.state === 'shut' || door.state === 'closing') {
        // The nose at the plane, moving toward it — from outside (the way in) or inside (the way
        // out). Only the taxi ever gets here: every other car is refused the street at the line.
        const gap = door.z - taxi.z;
        const toward = Math.sign(gap) === Math.sign(fz) && Math.abs(fz) > 0.5;
        if (alongX && toward && Math.abs(gap) < HIT_REACH && !taxi.crashed && committed(taxi)) {
          door.state = 'bursting';
          smashes += 1;
          // Leaving by this door if the car is inside the shed — its heading points out through it.
          const exit = inside(taxi);
          onSmash({ x: taxi.x, z: door.z, yaw: taxi.yaw, exit, v: taxi.v, door: n });
        }
      }
      if (door.state === 'bursting') {
        door.open = Math.min(1, door.open + dt / BURST_TIME);
        if (door.open >= 1) { door.state = 'open'; door.hold = 0; }
      } else if (door.state === 'open') {
        door.hold = clear ? door.hold + dt : 0;
        if (door.hold >= HOLD_OPEN) door.state = 'closing';
      } else if (door.state === 'closing') {
        if (!clear) door.state = 'open';
        else {
          door.open = Math.max(0, door.open - dt * CLOSE_RATE);
          if (door.open <= 0) door.state = 'shut';
        }
      }
      setDoor(n, door.open);
    }
  }

  /** Both doors shut, now — a new run. */
  function reset() {
    for (let n = 0; n < doors.length; n++) {
      Object.assign(doors[n], { open: 0, state: 'shut', hold: 0 });
      setDoor(n, 0);
    }
  }

  return {
    update,
    reset,
    inside,
    state: { doors, get smashes() { return smashes; } },
  };
}
