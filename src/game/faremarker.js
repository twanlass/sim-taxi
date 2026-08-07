import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';
import { URGENCY_SEGMENTS, urgencyColor } from './urgency.js';
import {
  createDiamond, DIAMOND_R, RIM_SCALE, bounceOffset, kickEnvelope, KICK_TIME, KICK_SCALE, KICK_HOP,
} from '../geometry/diamond.js';
import { createTargetRing, RING_Y } from '../geometry/targetring.js';

// The fare's clock, as a physical object: one geodesic diamond, coloured by how close this fare is
// to giving up — green, yellow, orange, red, with a disc under the rider's feet in the same colour
// for as long as they are standing on the kerb.
//
// **It belongs to the fare, not to a marker.** It waits over the rider's head on the kerb, and the
// instant they get in it flies to the taxi and rides above the roof. The clock does not restart at
// the hand-off — one deadline covers spawn all the way to drop-off — and now neither does the thing
// drawing it. The rider getting into the car and the deadline moving into the car are one gesture.
//
// It replaces two objects doing that job in relay: this diamond over the rider, and a **timer ring**
// on the road around the taxi that took over at pickup. The ring was a finer instrument — a swept
// annulus draining continuously, so it read as a real clock rather than four steps — but the two
// were the same deadline in two vocabularies, and the hand-off between them was the moment a player
// had to learn that. One object that simply travels says it without teaching anything.
//
// What that costs is precision on the riding leg: four levels where there used to be a continuous
// sweep. The panic pulse below five seconds came across with it, so the end of a clock is still an
// event and not just a shade of red.
//
// **The disc is the same colour saying it twice.** The crystal is at eye level where the eye
// happens to be; the disc is on the ground, which is where the taxi is actually being aimed, and it
// survives the crystal being lost behind a tower. It is the drop-off's own shape
// (geometry/targetring.js) in the fare's urgency colour rather than teal, so "a disc is a place the
// taxi has to reach" holds at both ends of the trip and the hue is the only difference.
//
// It goes dark the moment the rider boards. The kerb corner stops meaning anything then — the clock
// leaves with them, and a disc left glowing on an empty pavement would read as a second fare.
//
// Its own module under game/ rather than geometry/ because it owns a lifecycle — kerb, flight,
// taxi — and not just a mesh. geometry/diamond.js and geometry/targetring.js are the models it
// draws with.

// Height above the ground, on the kerb and over the taxi alike.
//
// One altitude for both, so the transfer reads as the marker sliding sideways rather than climbing
// into a different slot. Over a rider (who tops out a little over 3.3) it leaves the diamond's
// bottom vertex 1.3 units — about 10px at play zoom — of air above their head; over the taxi (which
// tops out at ~2.85 with its roof sign) it leaves ~1.85. Being a little further off the car is
// right anyway: the taxi is wide, and a marker tight to the roof reads as part of the vehicle.
const LIFT = DIAMOND_R + 4.7;

// The flight from the kerb to the taxi. Inherited from the ring this replaces, which was tuned
// against BOARD_SECONDS = 0.9 in fares.js so the clock lands on the car a beat *before* the rider
// figure finishes climbing in — the deadline arrives, then its owner does.
const TRANSFER_TIME = 0.65;
const TRANSFER_ARC = 1.6;      // world units of extra height at the midpoint of the flight

// The outline once the taxi has been sent at this rider: the same black, drawn heavier. 1.34 is
// about 5px of rim at play zoom against the ordinary 1.7px — the diamond reads as inked.
//
// Weight rather than colour. The rim was the taxi's yellow first, which is the colour that means
// "you told me to do this" everywhere else in the HUD; but this crystal spends a quarter of every
// clock *being* yellow, and a yellow rim on a yellow diamond is no rim at all. Black is the one
// value nothing on the urgency scale can collide with.
const SELECTED_RIM = 1.34;

// Panic pulse. Below PULSE_BELOW_S the diamond beats — the same object the eye is already reading
// for colour, so the two cues stack ("red AND getting bigger") rather than compete. The threshold is
// in seconds, not a fraction, so it stays "five seconds left" whether fareSeconds is the shipped 60
// or something the debug panel has tuned to 20.
//
// Carried over from the timer ring at its measured amplitude and rate: 15% is a visible twitch on a
// marker this size without turning into a lunge, and ~3.5Hz reads as urgency rather than a strobe.
// It now runs on the kerb as well as in the car, which the ring never did — a rider about to give up
// is exactly as urgent as a delivery about to fail.
const PULSE_BELOW_S = 5;
const PULSE_HZ = 3.5;
const PULSE_AMPLITUDE = 0.15;

/**
 * One fare's marker. Built once per fare slot and re-set on every spawn, the same way the rest of
 * the slot's meshes are reused.
 *
 * Scene-level rather than parented to the rider's kerb group: it has to leave that corner and fly
 * to a moving car, so it owns its own world position for its whole life.
 *
 * `phase` offsets the bounce so two fares live at once don't pulse in lockstep. It is a constant per
 * slot rather than anything random, because the bounce is driven off sim time and screenshots have
 * to be reproducible.
 */
export function createFareMarker(scene, phase = 0) {
  const diamond = createDiamond(urgencyColor(URGENCY_SEGMENTS));
  // The rider (or the taxi) under it is the click target — both carry an oversized hit box that
  // already covers this airspace, so intersecting the crystal itself would only cost work on
  // every tap.
  diamond.mesh.raycast = () => {};
  diamond.rim.raycast = () => {};

  const group = new THREE.Group();
  group.visible = false;
  group.add(diamond.mesh);
  scene.add(group);

  // The disc under the rider's feet. Its own scene-level group rather than a child of the one
  // above: that one flies to the taxi, and this one stays on the pavement until it is switched off.
  const ring = createTargetRing(urgencyColor(URGENCY_SEGMENTS));
  ring.group.visible = false;
  scene.add(ring.group);

  const anchor = new THREE.Vector3();
  const from = new THREE.Vector3();

  let selected = false;
  let level = URGENCY_SEGMENTS;
  // Sim times, or null when nothing is running. Both are stamped inside update() off the same clock
  // the bounce reads: a frozen shot has to render the same frame every time, and stamping them at
  // the call site would tie the animation to the order the calls happen in.
  let kickAt = null;
  let kickPending = false;
  let transferAt = null;
  let transferPending = false;

  /**
   * Paint the diamond in this level's colour, kicking it if the level actually moved.
   *
   * Called every frame the fare is live, so the common path is a compare and a return. The kick is
   * what makes a level change an *event*: the hue snaps between four steps and the player is usually
   * looking at the road, so without motion the change happens off the corner of the eye and the news
   * arrives late.
   */
  function setUrgency(next) {
    if (next === level) return;
    level = next;
    const colour = urgencyColor(next);
    diamond.setColor(colour);
    ring.setColor(colour);
    kickPending = true;
  }

  function setSelected(on) {
    if (on === selected) return;
    selected = on;
    diamond.setRim(on ? SELECTED_RIM : RIM_SCALE);
  }

  return {
    group,
    // The crystal itself, so a test can read colour and position back the way a player reads them
    // off the screen rather than trusting the arguments it passed in.
    mesh: diamond.mesh,
    // Likewise the disc on the ground, which has to agree with the crystal on every frame.
    ring: ring.group,
    setUrgency,
    /** Mark the rider the taxi has been sent at. Only meaningful while they are still on the kerb. */
    setSelected,
    isSelected: () => selected,
    /** Whether the level-change kick is mid-flight — for the headless tools. */
    isKicking: () => kickPending || kickAt !== null,
    /** Whether the marker is between the kerb and the taxi. */
    isTransferring: () => transferPending || transferAt !== null,

    /** Show the marker over a rider who has just appeared, at their kerb corner. */
    showAt(nextLevel, x, z) {
      // Straight to the opening colour with no kick: a marker that pops the moment it appears is
      // announcing a change that hasn't happened.
      level = nextLevel;
      diamond.setColor(urgencyColor(nextLevel));
      ring.setColor(urgencyColor(nextLevel));
      kickAt = null;
      kickPending = false;
      transferAt = null;
      transferPending = false;
      anchor.set(x, LIFT, z);
      group.position.copy(anchor);
      // Same corner, on the pavement: the rider stands in the middle of their own disc.
      ring.group.position.set(x, KERB_H + RING_Y, z);
      ring.group.visible = true;
      diamond.mesh.scale.setScalar(1);
      setSelected(false);
      group.visible = true;
    },

    /**
     * The rider is in: fly to wherever `update` is aiming from now on.
     *
     * The selection rim comes off here. It answered "which of the two waiting riders is the car
     * already going to?", and a fare in the car is not one of those any more.
     */
    beginTransfer() {
      transferPending = true;
      setSelected(false);
      // The kerb corner is no longer where this fare is.
      ring.group.visible = false;
    },

    hide() {
      group.visible = false;
      ring.group.visible = false;
      transferAt = null;
      transferPending = false;
    },

    /**
     * @param elapsed     sim time, which every animation here is a function of
     * @param target      what to hover over — omitted while the rider waits, so it stays on its
     *                    kerb corner; the taxi once they are aboard
     * @param secondsLeft on the fare's clock, for the panic pulse
     */
    update(elapsed, target = null, secondsLeft = Infinity) {
      if (!group.visible) return;

      if (target) anchor.set(target.x, LIFT, target.z);

      if (transferPending) {
        from.copy(group.position);
        transferAt = elapsed;
        transferPending = false;
      }

      if (transferAt !== null) {
        const t = Math.min(1, (elapsed - transferAt) / TRANSFER_TIME);
        const eased = 1 - (1 - t) ** 3;
        group.position.lerpVectors(from, anchor, eased);
        // Lofted over the middle of the flight, so the clock arcs across to the car instead of
        // sliding along the pavement.
        group.position.y += Math.sin(eased * Math.PI) * TRANSFER_ARC;
        if (t >= 1) transferAt = null;
      } else {
        group.position.copy(anchor);
      }

      if (kickPending) {
        kickAt = elapsed;
        kickPending = false;
      }
      let kick = 0;
      if (kickAt !== null) {
        const since = elapsed - kickAt;
        // Retired on the clock, not on the value: the envelope is 0 at both ends, so clearing when
        // it reads 0 killed every kick on its own first frame.
        if (since >= KICK_TIME) kickAt = null;
        else kick = kickEnvelope(since);
      }

      const pulse = secondsLeft <= PULSE_BELOW_S
        ? PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(elapsed * PULSE_HZ * Math.PI * 2))
        : 0;

      diamond.mesh.position.y = bounceOffset(elapsed + phase) + kick * KICK_HOP;
      // The kick and the pulse share the scale channel and simply add: a level change landing inside
      // the last five seconds should read as a knock on top of a beating marker, not replace it.
      diamond.mesh.scale.setScalar(1 + kick * KICK_SCALE + pulse);
    },
  };
}
