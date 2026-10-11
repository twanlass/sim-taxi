import * as THREE from 'three';
import { ALARM_DEPTH, ALARM_H, ALARM_W, bankFrontage } from '../city/bank.js';
import { KERB_H } from '../city/ground.js';
import { createPerson } from '../geometry/person.js';
import { TAXI_TAILPIPE_HEIGHT, taxiDoorPoint, taxiSideToward } from '../geometry/taxi.js';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { markEmissive, setEmissiveScale } from './bloom.js';

// The bank job: `?robbery=intro`. The robbery as it shipped is a drive-past — the empty taxi goes
// by the bank, a 20px figure runs 0.9s from the steps into a moving cab, and the world stops for
// their line. Reported as hard to grok, and the reason is the trigger: the player is watching the
// taxi or the next rider, not the bank's doorstep, so the one thing that explains the event (a
// robber getting into *your* car) is over before anybody looks.
//
// So the event opens on a cut instead. The robbery's line already stops the world (game/robberline.js),
// and this stops it one beat earlier and spends the stop on the thing worth seeing:
//
//   1. The alarm boxes on the bank start flashing and the camera pulls in on the steps.
//   2. The robber bursts out of the portico with the sack shedding notes (the getaway's own cash
//      trail, game/cashtrail.js, fed from the robber instead of the tailpipe), shoves the bystander
//      who was waiting on the pavement over, and runs for the cab's open door.
//   3. They hop in, and the robber's line takes it from there exactly as before.
//
// **The world is stopped, not slowed**, and that was weighed. Slow-motion would keep the traffic
// alive, but it would also run every clock, the crystal's flight and the fare loop at a crawl
// under a figure animated at full speed, which is two time bases in one frame; the robber's line
// is a freeze, so the cut and the line read as one held beat. Everything here runs on wall time
// and the main loop draws and returns, the robber's-line branch's shape. A tap skips it.
//
// **The bystander is scenery, not a fare.** Somebody always stands outside the bank — which is
// what makes the shove land, since a victim who appears at the start of the cut reads as staged —
// but they carry no crystal and no tap target, so there is no board change and no 50/50 to learn.

/** The camera's half-height during the cut, in world units, at its tightest and loosest. */
const CUT_ZOOM_MIN = 15;
const CUT_ZOOM_MAX = 26;
/** How fast the camera settles on the cut, per second of wall time. */
const CUT_SMOOTHING = 5;
/** The alarm and the push-in get this long before the robber comes out of the door. */
const LEAD_IN = 0.45;
/** A sprint, in world units per second — a rider's boarding run is ~5. */
const RUN_SPEED = 7;
/** ...and the longest the run may take, however far the cab is: it speeds up to fit. */
const RUN_MAX = 1.6;
/** The hop in through the door. */
const HOP = 0.32;
/** A beat of the robber being in before the line opens, so the hop lands. */
const HOLD = 0.25;
/** How far either side of the contact point, in seconds, the shoving arm is out. */
const SHOVE_REACH = 0.18;
/** How far along the façade from the robber's way out the bystander stands, and in front of it. */
const BYSTANDER_ALONG = 1.7;
const BYSTANDER_OUT = -0.65;
/** The robber passes this far short of the bystander's centre: an arm's length. */
const SHOVE_GAP = 0.95;
/**
 * The fall. Knocked clean off their feet rather than tipped over: `FALL_AIR` of it is airborne,
 * `FALL_HEIGHT` up at the top of the arc and spun `FALL_SPIN` about the vertical, flailing the
 * whole way, then a bounce and a skid along the pavement. The first cut was a 0.42s topple with a
 * 0.06 bounce, which at play zoom read as somebody lying down. `FALL_SLIDE` is the whole distance,
 * flight and skid together, and `FALL_FLAT` how flat they end up.
 */
const FALL = 0.8;
const FALL_AIR = 0.6;
const FALL_HEIGHT = 1.2;
const FALL_SPIN = 1.2;
const FALL_SLIDE = 2.1;
const FALL_FLAT = Math.PI / 2 - 0.08;
/** How near the taxi's centre a landing may be: half the drawn body (2.0) and a figure's length. */
const TAXI_CLEAR = 3.4;
/** How limp they are once down: the arms and legs still stir, at a tenth of the flail. */
const LIE_LIMP = 0.9;
/** Lying there for this long once the world is back, then up, and a jog back to their spot. */
const DOWN_FOR = 4.5;
const GET_UP = 0.8;
const WALK_BACK = 1.3;
/** Where the robber stops short of the door and how far in the hop reaches — fares.js's numbers. */
const DOOR_STANDOFF = 0.7;
const DOOR_REACH = 0.5;
/** The door swinging open as they come: ~66°, eased out, over the last stretch of the run. */
const DOOR_ANGLE = 1.15;
const DOOR_OPEN_FOR = 0.35;
/** The slam once the world is back: closed, then a bounce off the frame. taxidoor.js's numbers. */
const SLAM = 0.16;
const REBOUND = 0.12;
const REBOUND_TIME = 0.12;
/** The alarm's flash: twice a level crossing's rate — this is a bell going, not a warning. */
const ALARM_PERIOD = 0.5;
/** Seconds the camera spends easing its zoom back once the line is cleared. */
const RETURN_SECONDS = 1.2;

/** Where a figure's feet go on the pavement: a rider's height, `place` in game/fares.js. */
const PAVEMENT = KERB_H + 0.12;

const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

/**
 * @param scene      the scene the bystander and the alarm boxes go into
 * @param site       the bank (`city.bank`, from `buildBank`)
 * @param cashTrail  game/cashtrail.js — the notes the sack sheds
 * @param controller the city camera (game/camera.js)
 * @param setDoor    `(side, angle)` — the taxi's rear door (`traffic.setTaxiDoor`)
 * @param play       `(name, x?, z?)` — a one-shot, placed where given
 */
export function createBankJob({ scene, site, cashTrail, controller, setDoor, play = () => {} }) {
  const f = bankFrontage(site);

  // --- The alarm light -------------------------------------------------------
  //
  // One red lamp over the doorway, the siren bar's own red. It was two amber boxes over the end
  // columns first, which read as the building's decoration rather than as the thing going off.
  const lampOn = new THREE.Color(PALETTE.lightRed);
  const lampOff = new THREE.Color(PALETTE.sirenRedOff);
  const alarm = new THREE.Mesh(
    new THREE.BoxGeometry(f.out.x ? ALARM_DEPTH : ALARM_W, ALARM_H, f.out.x ? ALARM_W : ALARM_DEPTH),
    unlitMaterial({ color: lampOff.clone() }),
  );
  alarm.position.set(f.alarm.x, f.alarm.y, f.alarm.z);
  alarm.name = 'bank-alarm';
  scene.add(alarm);
  markEmissive(alarm, 'pod');
  setEmissiveScale(alarm, 0);
  let alarmClock = 0;
  function flash(dt, on) {
    if (!on) {
      if (alarmClock === 0) return;
      alarmClock = 0;
      alarm.material.color.copy(lampOff);
      setEmissiveScale(alarm, 0);
      return;
    }
    alarmClock += dt;
    const lit = Math.floor(alarmClock / ALARM_PERIOD) % 2 === 0;
    alarm.material.color.copy(lit ? lampOn : lampOff);
    setEmissiveScale(alarm, lit ? 1 : 0);
  }

  // --- The bystander ---------------------------------------------------------
  //
  // Three groups so no Euler order has to be got right: `spot` stands on the pavement and turns to
  // face the way the fall goes, `tilt` tips about the feet in that frame, and the figure inside
  // poses as it likes.
  const home = f.at(f.gapU + BYSTANDER_ALONG, BYSTANDER_OUT, 0);
  const facing = Math.atan2(f.out.x, f.out.z);
  const spot = new THREE.Group();
  spot.position.set(home.x, PAVEMENT, home.z);
  const tilt = new THREE.Group();
  spot.add(tilt);
  const bystander = createPerson({ pickable: null });
  tilt.add(bystander.group);
  scene.add(spot);

  const by = {
    /** 'stand', 'fall' (wall time, inside the cut), 'down' or 'up' (game time). */
    phase: 'stand',
    t: 0,
    yaw: facing,
    slide: FALL_SLIDE,
    clock: 0,
  };
  function standPose(dt) {
    by.clock += dt;
    spot.rotation.y = facing;
    tilt.rotation.x = 0;
    tilt.position.set(0, 0, 0);
    bystander.idle(by.clock, 0.7);
  }
  // Still facing the street, as they were when it hit them, plus whatever the flight spun them
  // by: the fall goes the way the shove did, so they go down sideways rather than turning first.
  const turned = (spin) => facing - by.yaw + FALL_SPIN * spin;
  /** The fall, `k` 0..1 across `FALL` seconds. */
  function fallPose(k) {
    spot.rotation.y = by.yaw;
    const air = FALL_AIR / FALL;
    if (k < air) {
      // In the air: a parabola up and down, tipping over fast, everything flailing.
      const u = k / air;
      tilt.rotation.x = FALL_FLAT * (1 - (1 - u) ** 2);
      tilt.position.set(0, FALL_HEIGHT * 4 * u * (1 - u), by.slide * 0.75 * u);
      bystander.tumble(k * FALL, 0);
      bystander.group.rotation.y = turned(u);
      return;
    }
    // Down: one bounce that rocks them up off the pavement, then the skid running out.
    const w = (k - air) / (1 - air);
    const bounce = Math.sin(Math.PI * Math.min(1, w * 1.6)) * (1 - w);
    tilt.rotation.x = FALL_FLAT - 0.3 * bounce;
    tilt.position.set(0, 0.35 * bounce, by.slide * (0.75 + 0.25 * (1 - (1 - w) ** 2)));
    bystander.tumble(k * FALL, LIE_LIMP * w);
    bystander.group.rotation.y = turned(1);
  }
  /**
   * On the ground, `t` seconds in: a slow rock of the chest and the limbs stirring at a tenth of the
   * flail — dazed rather than dead, because this is a comedy about a getaway.
   */
  function liePose(t) {
    spot.rotation.y = by.yaw;
    tilt.rotation.x = FALL_FLAT + 0.035 * Math.sin(t * 1.9);
    tilt.position.set(0, 0, by.slide);
    bystander.tumble(t * 0.3, LIE_LIMP);
    // A roll of the head and shoulders now and then, as if trying to work out what hit them.
    bystander.group.rotation.y = turned(1) + 0.12 * Math.sin(t * 0.8) ** 3;
  }
  function updateBystander(dt) {
    if (by.phase === 'stand') standPose(dt);
    else if (by.phase === 'fall') {
      // Only if the world came back mid-fall, which a skip can do.
      by.t += dt;
      fallPose(Math.min(1, by.t / FALL));
      if (by.t >= FALL) { by.phase = 'down'; by.t = 0; }
    } else if (by.phase === 'down') {
      by.t += dt;
      liePose(by.t);
      if (by.t >= DOWN_FOR) { by.phase = 'up'; by.t = 0; }
    } else if (by.phase === 'up') {
      by.t += dt;
      const k = Math.min(1, by.t / GET_UP);
      // Back up the way they went down.
      tilt.rotation.x = FALL_FLAT * (1 - k) * (1 - k);
      tilt.position.set(0, 0, by.slide);
      bystander.tumble(0, LIE_LIMP * (1 - k));
      bystander.group.rotation.y = turned(1 - k);
      if (k >= 1) { by.phase = 'back'; by.t = 0; }
    } else if (by.phase === 'back') {
      // ...and a jog back to the spot they were standing on, facing it.
      by.t += dt;
      const k = Math.min(1, by.t / WALK_BACK);
      tilt.rotation.x = 0;
      const bob = bystander.run(by.t * 12);
      tilt.position.set(0, bob, by.slide * (1 - k));
      bystander.group.rotation.y = Math.PI;
      if (k >= 1) {
        by.phase = 'stand';
        bystander.rest();
      }
    }
  }

  // --- The cut ---------------------------------------------------------------
  let cut = null;
  // The door the robber left open, swung shut once the world is back: seconds into the slam, or
  // -1 while nothing is closing.
  let door = { side: 1, angle: 0, closing: -1 };
  // What the camera was doing before the cut, and how long is left of the trip back.
  let saved = null;
  let returning = 0;

  const groundY = (p) => {
    // The plinth's top, down the steps as a ramp, to the pavement. `v` is how far behind the front
    // plane this point is, which is what the steps are laid out along.
    const v = -((p.x - site.front.x) * f.out.x + (p.z - site.front.z) * f.out.z);
    const k = Math.max(0, Math.min(1, v / f.stepRun));
    return lerp(PAVEMENT, f.doorway.y, k);
  };

  /** The point `s` world units along the robber's path, written into `out`. */
  function along(s, out) {
    const { legs } = cut;
    let rest = s;
    for (const [a, b] of legs) {
      const len = dist(a, b);
      if (rest <= len || b === legs[legs.length - 1][1]) {
        const k = len > 0 ? Math.min(1, rest / len) : 1;
        out.x = lerp(a.x, b.x, k);
        out.z = lerp(a.z, b.z, k);
        out.dx = b.x - a.x;
        out.dz = b.z - a.z;
        return out;
      }
      rest -= len;
    }
    return out;
  }

  /**
   * The robber is out: plan the run from where the taxi is now (the world is about to stop, so it
   * stays there), save the framing, and start.
   */
  function begin(fare, taxi) {
    const passenger = fare.slot.passenger;
    const side = taxiSideToward(taxi, f.steps.x, f.steps.z);
    const run = taxiDoorPoint(taxi, side, DOOR_STANDOFF, { x: 0, z: 0 });
    const inside = taxiDoorPoint(taxi, side, -DOOR_REACH, { x: 0, z: 0 });
    // The shove: the robber passes the bystander at arm's length on the side they came from.
    const toBy = { x: home.x - f.steps.x, z: home.z - f.steps.z };
    const l = Math.hypot(toBy.x, toBy.z) || 1;
    const contact = { x: home.x - (toBy.x / l) * SHOVE_GAP, z: home.z - (toBy.z / l) * SHOVE_GAP };
    // Pushed away from the robber and a little out toward the road, which is where a shove off a
    // pavement sends you.
    const push = { x: toBy.x / l + f.out.x * 0.5, z: toBy.z / l + f.out.z * 0.5 };
    const legs = [
      [f.doorway, f.steps],
      [f.steps, contact],
      [contact, run],
    ];
    const length = legs.reduce((sum, [a, b]) => sum + dist(a, b), 0);
    const speed = Math.max(RUN_SPEED, length / RUN_MAX);
    cut = {
      fare,
      passenger,
      taxi,
      side,
      run,
      inside,
      legs,
      length,
      speed,
      contactAt: (dist(f.doorway, f.steps) + dist(f.steps, contact)) / speed,
      runFor: length / speed,
      t: 0,
      kicked: false,
      shoved: false,
      doorOpened: false,
      done: false,
      // A stand-in car for the cash trail: the sack is what is shedding notes, so the "tailpipe"
      // is the robber.
      sack: { x: f.doorway.x, z: f.doorway.z, yaw: 0, v: speed, crashed: false },
    };
    by.yaw = Math.atan2(push.x, push.z);
    // ...but never into the cab: the landing is pulled short of the taxi's body (half its drawn
    // length plus a body width) wherever the shove would have put them on top of it.
    const pl = Math.hypot(push.x, push.z);
    by.slide = FALL_SLIDE;
    while (by.slide > 0.4 && Math.hypot(home.x + (push.x / pl) * by.slide - taxi.x,
      home.z + (push.z / pl) * by.slide - taxi.z) < TAXI_CLEAR) by.slide -= 0.1;
    door = { side, angle: 0, closing: -1 };
    // Framed on the steps, the bystander and the cab together, tight enough that the robber is a
    // figure rather than a speck.
    const span = Math.max(dist(f.steps, run), dist(home, run));
    cut.focus = {
      x: (f.steps.x + home.x + run.x * 2) / 4,
      z: (f.steps.z + home.z + run.z * 2) / 4,
      zoom: Math.max(CUT_ZOOM_MIN, Math.min(CUT_ZOOM_MAX, 10 + span * 0.9)),
    };
    saved = { x: controller.state.target.x, z: controller.state.target.z, zoom: controller.state.zoom };
    returning = 0;
    passenger.standing.rest();
    passenger.standing.setRobber(true);
    // Hidden in the portico until the lead-in is over.
    passenger.group.visible = false;
    document.body.classList.add('bankjob');
  }

  const at = { x: 0, z: 0, dx: 0, dz: 1 };

  /** Put the robber at path distance `s` (or into the hop, once the run is done). */
  function poseRobber(time) {
    const { passenger, fare } = cut;
    const origin = passenger.group.position;
    const standing = passenger.standing;
    const base = PAVEMENT;
    if (time < 0) { passenger.group.visible = false; return; }
    passenger.group.visible = true;
    if (time < cut.runFor) {
      along(time * cut.speed, at);
      const shove = Math.max(0, 1 - Math.abs(time - cut.contactAt) / SHOVE_REACH);
      const bob = standing.run(time * 24, shove);
      standing.group.rotation.y = Math.atan2(at.dx, at.dz);
      standing.group.position.set(at.x - origin.x, groundY(at) - base + bob, at.z - origin.z);
      cut.sack.x = at.x;
      cut.sack.z = at.z;
      cut.sack.yaw = Math.atan2(-at.dz, at.dx);
      return;
    }
    const k = (time - cut.runFor) / HOP;
    standing.hopIn(k, cut.run.x - origin.x, cut.run.z - origin.z,
      cut.inside.x - origin.x, cut.inside.z - origin.z);
    if (k >= 1) passenger.group.visible = false;
    fare.boardingSide = cut.side;
  }

  /**
   * One frame of the cut, on wall time. Returns true on the frame the robber is in and the cut
   * is over — main.js opens the robber's line on it.
   */
  function update(dt, aspectRatio) {
    if (!cut || cut.done) return false;
    cut.t += dt;
    const time = cut.t - LEAD_IN;
    controller.focusOn(cut.focus.x, cut.focus.z, cut.focus.zoom, dt, aspectRatio, CUT_SMOOTHING);
    flash(dt, true);
    poseRobber(Math.min(time, cut.runFor + HOP));

    // The notes: a fistful out of the door, then a stream for as long as they are running.
    const running = time >= 0 && time < cut.runFor;
    if (running && !cut.kicked) {
      cut.kicked = true;
      cashTrail.kick(cut.sack, TAXI_TAILPIPE_HEIGHT + groundY(cut.sack));
    }
    // The trail's height is a tailpipe's over the surface below, which is what it lands the notes
    // back on — so the surface is what goes in, not the sack's height.
    cashTrail.feed(dt, running, cut.sack, TAXI_TAILPIPE_HEIGHT + groundY(cut.sack));
    cashTrail.update(dt);

    if (!cut.shoved && time >= cut.contactAt) {
      cut.shoved = true;
      by.phase = 'fall';
      by.t = 0;
      play('angry', home.x, home.z);
    }
    if (by.phase === 'fall') {
      by.t += dt;
      fallPose(Math.min(1, by.t / FALL));
      if (by.t >= FALL) {
        by.phase = 'down';
        by.t = 0;
      }
    } else if (by.phase === 'down') {
      by.t += dt;
      liePose(by.t);
    }

    // The door, flung open over the last stretch of the run.
    const open = (time - (cut.runFor - DOOR_OPEN_FOR)) / DOOR_OPEN_FOR;
    if (open > 0) {
      if (!cut.doorOpened) { cut.doorOpened = true; play('doorOpen'); }
      const u = Math.min(1, open);
      door.angle = DOOR_ANGLE * (1 - (1 - u) * (1 - u));
      setDoor(door.side, door.angle);
    }

    if (time >= cut.runFor + HOP + HOLD) finish();
    return cut.done;
  }

  /** The robber is in: hand the fare back to the fare loop and stand the cut down. */
  function finish() {
    if (!cut || cut.done) return;
    cut.done = true;
    // A skip lands everything the cut would have: the bystander on the ground, the door open.
    if (!cut.shoved) {
      cut.shoved = true;
      by.phase = 'down';
      by.t = 0;
      liePose(0);
    }
    door.angle = DOOR_ANGLE;
    setDoor(door.side, door.angle);
    cut.passenger.standing.rest();
    cut.fare.boardingSide = cut.side;
    cut.onIn?.(cut.fare, cut.inside);
    document.body.classList.remove('bankjob');
  }

  // A tap anywhere skips to the robber being in, through a full-screen catcher so it cannot also
  // route the taxi — the robber's line's own arrangement (`#robber-talk`). Space and Enter too.
  const catcher = document.getElementById('bankjob-catch');
  const skip = () => { if (cut && !cut.done) finish(); };
  catcher?.addEventListener('click', skip);
  window.addEventListener('keydown', (event) => {
    if (!cut || cut.done || event.repeat) return;
    if (event.code !== 'Space' && event.code !== 'Enter') return;
    event.preventDefault();
    skip();
  });

  return {
    /** The cut is playing: the world is stopped under it. */
    running: () => Boolean(cut && !cut.done),
    /**
     * Start the cut for this robber. `onIn(fare, point)` fires once they are in the car — whether
     * the cut ran out or was skipped — with the point they went in at.
     */
    begin(fare, taxi, onIn) {
      begin(fare, taxi);
      cut.onIn = onIn;
    },
    update,
    skip,
    /**
     * Game time, every frame the world runs: the bystander, the alarm (on for as long as a robbery
     * is), the door slam, and the camera's zoom on its way back.
     */
    tick(dt, { alarm = false, aspectRatio = 1, narrow = true } = {}) {
      updateBystander(dt);
      flash(dt, alarm);
      if (door.closing >= 0) {
        door.closing += dt;
        if (door.closing < SLAM) door.angle = DOOR_ANGLE * (1 - (door.closing / SLAM) ** 2);
        else if (door.closing < SLAM + REBOUND_TIME) {
          door.angle = REBOUND * Math.sin(Math.PI * (door.closing - SLAM) / REBOUND_TIME);
        } else { door.angle = 0; door.closing = -1; }
        setDoor(door.side, door.angle);
      }
      if (returning > 0 && saved) {
        // On a phone the follow picks the target up again by itself; on a desktop nothing follows,
        // so the framing the player had is glided back to once, here.
        if (returning === RETURN_SECONDS && !narrow) controller.glideTo(saved.x, saved.z);
        returning = Math.max(0, returning - dt);
        controller.easeZoom(saved.zoom, dt, aspectRatio, 4);
        if (returning === 0) controller.easeZoom(saved.zoom, 1e3, aspectRatio);
      }
    },
    /** The line is cleared and the getaway is on: slam the door and give the camera back. */
    release() {
      if (door.angle > 0) door.closing = 0;
      if (saved) returning = RETURN_SECONDS;
    },
    /** For the tools. */
    state: () => ({ cut: cut && { t: cut.t, done: cut.done, runFor: cut.runFor }, bystander: by.phase }),
    bystander,
    alarm,
  };
}
