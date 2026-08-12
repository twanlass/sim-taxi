import * as THREE from 'three';
import { URGENCY_SEGMENTS, fareColor } from './urgency.js';
import {
  createDiamond, DIAMOND_HALF_H, bounceOffset, kickEnvelope, KICK_TIME, KICK_SCALE, KICK_HOP,
} from '../geometry/diamond.js';
import { popEnvelope, popHighlight, POP_TIME, POP_SCALE_DIAMOND } from './selectpop.js';

// The fare's clock, as a physical object: one plumbob crystal hanging point-down over whoever it
// belongs to, coloured by how close this fare is to giving up — green, yellow, orange, red.
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
// That cost precision for a while: four levels where the ring had a continuous sweep. It is back —
// the crystal is a glass vessel and the colour is the liquid in it, draining every frame (see
// geometry/diamond.js). The four steps are still the alarm, and they still kick; the level is the
// fine hand between them. The panic pulse below five seconds came across from the ring too, so the
// end of a clock is an event and not just a shade of red.
//
// **A VIP's crystal opts out of all of it.** Fixed purple, always full — see setUrgency and
// setFill. The fixed hue is already the one thing it needs to say ("this is a VIP"), and a second
// colour language draining underneath would read as the marker disagreeing with itself.
//
// **A waiting rider has no disc under their feet.** They wore one for a spell — the crystal's
// colour said again on the ground, where the driving is aimed — and it went when a ring on the road
// became the thing the taxi is being *sent at*. A rider is not that: they are a place the taxi may
// be sent, and the tap that sends it lands on them either way. So a ring on the tarmac now means
// exactly one thing, the same way a diamond means exactly one thing, and the kerb before a pickup
// carries the figure and the clock over their head and nothing else. It also gives the board back
// a lot of paint: three waiting riders were three discs and three crystals, on a city whose blocks
// are only ~92px across.
//
// Its own module under game/ rather than geometry/ because it owns a lifecycle — kerb, flight,
// taxi — and not just a mesh. geometry/diamond.js is the model it draws with.

// Height above the ground, on the kerb and over the taxi alike.
//
// One altitude for both, so the transfer reads as the marker sliding sideways rather than climbing
// into a different slot. Measured from the crystal's bottom point rather than from its middle,
// which is what keeps the headroom fixed while the shape is retuned: over a rider (who tops out a
// little over 3.3) it leaves that point 1.3 units — about 10px at play zoom — of air above their
// head, and over the taxi (which tops out at ~2.85 with its roof sign) ~1.85. Being a little
// further off the car is right anyway: the taxi is wide, and a marker tight to the roof reads as
// part of the vehicle.
//
// The plumbob's point hangs lower under its own origin than the octahedron's did, so this number
// grew with the shape and the air above a rider's head did not move.
const LIFT = DIAMOND_HALF_H + 4.7;

// The flight from the kerb to the taxi. Inherited from the ring this replaces, which was tuned
// against BOARD_SECONDS = 0.9 in fares.js so the clock lands on the car a beat *before* the rider
// figure finishes climbing in — the deadline arrives, then its owner does.
const TRANSFER_TIME = 0.65;
const TRANSFER_ARC = 1.6;      // world units of extra height at the midpoint of the flight

// **The outline is one weight for the marker's whole life** — see RIM_OFFSET in geometry/diamond.js.
// It used to ink over at ≈5px against the ordinary 1.7px while the taxi was on its way to
// this rider and drop back at pickup, so a fare wore a thick black border on the kerb and a hairline
// one over the car. Two weights on one silhouette read as the marker changing shape at the hand-off
// rather than as a state, and the heavy one was a border rather than a rim. Which rider the car is
// going to is the route band's job, and it says it along the whole road instead of on one corner.

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
  const diamond = createDiamond(fareColor(URGENCY_SEGMENTS));
  // The rider (or the taxi) under it is the click target — both carry an oversized hit box that
  // already covers this airspace, so intersecting the crystal itself would only cost work on
  // every tap.
  diamond.mesh.raycast = () => {};
  diamond.rim.raycast = () => {};

  const group = new THREE.Group();
  group.visible = false;
  group.add(diamond.mesh);

  scene.add(group);

  const anchor = new THREE.Vector3();
  const from = new THREE.Vector3();

  let level = URGENCY_SEGMENTS;
  // A VIP marker never speaks the urgency scale — see setUrgency and showAt below.
  let vipMarked = false;
  // Sim times, or null when nothing is running. Both are stamped inside update() off the same clock
  // the bounce reads: a frozen shot has to render the same frame every time, and stamping them at
  // the call site would tie the animation to the order the calls happen in.
  let kickAt = null;
  let kickPending = false;
  let popAt = null;
  let popPending = false;
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
    // A VIP's diamond stays its fixed purple rather than cycling the ordinary green-to-red scale —
    // one colour language per marker, not two fighting for the same rider. The panic pulse (a
    // shared scale cue, not a colour) still carries urgency for it.
    if (vipMarked) return;
    diamond.setColor(fareColor(next));
    kickPending = true;
  }

  /**
   * How much of the clock is left, 0..1 — the level the liquid in the crystal stands at.
   *
   * Every frame, and continuous, where `setUrgency` is four steps. Straight through to the model
   * with no easing: this *is* the clock, and a lag between the seconds and the level is the one
   * thing a countdown may not have.
   */
  function setFill(fraction) {
    // A VIP's crystal doesn't drain either — see setUrgency. It stays the solid, full purple gem
    // it opened as for its whole life on the board; the panic pulse carries urgency for it instead.
    if (vipMarked) return;
    diamond.setFill(fraction);
  }

  return {
    group,
    // The crystal itself, so a test can read colour and position back the way a player reads them
    // off the screen rather than trusting the arguments it passed in.
    mesh: diamond.mesh,
    // The outline hull, at one fixed weight wherever the marker is (see the header). Named rather
    // than reached for by child index — the crystal grew a second wall underneath it and a test
    // walking `mesh.children[0]` silently started reading the far wall instead.
    rim: diamond.rim,
    isVip: () => vipMarked,
    setUrgency,
    setFill,
    /** What the crystal is showing, for tools with no GL context to read it back from. */
    getFill: () => diamond.getFill(),
    /** Whether the level-change kick is mid-flight — for the headless tools. */
    isKicking: () => kickPending || kickAt !== null,
    /** Likewise the select pop. */
    isPopping: () => popPending || popAt !== null,
    /**
     * The player has just picked this fare: swell and settle back.
     *
     * Pushed from `markDirected` (game/fares.js) rather than reconciled per frame, because it is an
     * acknowledgement of a gesture and not a state — there is nothing to reconcile against, and a
     * second tap on a rider the taxi is already on its way to has to pop again or it reads as the
     * tap having been swallowed.
     *
     * Stamped on the sim clock inside `update` like the kick, so a frozen shot renders the same
     * frame every time whatever order the calls happened in.
     *
     * Scale only, deliberately: the level-change kick hops as well as swells, and that lift is its
     * signature. A pop that also left the ground would read as the clock having stepped on the
     * frame the player tapped, which is the one piece of news the marker must not invent.
     */
    pop() { popPending = true; },
    /** Whether the marker is between the kerb and the taxi. */
    isTransferring: () => transferPending || transferAt !== null,

    /** Show the marker over a rider who has just appeared, at their kerb corner. */
    showAt(nextLevel, x, z, vip = false) {
      // Straight to the opening colour with no kick: a marker that pops the moment it appears is
      // announcing a change that hasn't happened. A VIP opens straight into its fixed purple
      // instead of the urgency scale's top level — see setUrgency.
      level = nextLevel;
      vipMarked = vip;
      diamond.setColor(fareColor(nextLevel, vip));
      // Full, whatever the level says. A rider appears with their whole clock, and the first tick
      // is a frame away — a crystal that drew empty for that frame would flash the wrong news. A
      // VIP's crystal stays at this fill forever — see setFill — so this is also where it settles.
      diamond.setFill(1);
      kickAt = null;
      kickPending = false;
      // Slot reuse: the previous fare on this slot may have been tapped in the last half second of
      // its life, and a fresh rider opening mid-swell would announce a tap that never happened.
      popAt = null;
      popPending = false;
      // `update` only puts the light back on a frame it runs, and a marker hidden mid-flash never
      // gets one.
      diamond.setHighlight(0);
      transferAt = null;
      transferPending = false;
      anchor.set(x, LIFT, z);
      group.position.copy(anchor);
      diamond.mesh.scale.setScalar(1);
      group.visible = true;
    },

    /**
     * The rider is in: fly to wherever `update` is aiming from now on.
     *
     * Nothing about the crystal changes at the hand-off but where it is — same colour, same fill,
     * same outline. The heavy selection rim used to come off here, and its going was the one thing
     * that made the transfer read as two markers rather than one travelling.
     */
    beginTransfer() {
      transferPending = true;
    },

    hide() {
      group.visible = false;
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

      if (popPending) {
        popAt = elapsed;
        popPending = false;
      }
      let pop = 0;
      let glow = 0;
      if (popAt !== null) {
        const since = elapsed - popAt;
        // Retired on the clock rather than on the value, same as the kick above — the envelope
        // passes through 0 on its way to the undershoot, and clearing there would cut the settle off.
        if (since >= POP_TIME) popAt = null;
        else {
          pop = popEnvelope(since);
          glow = popHighlight(since);
        }
      }
      // Written every frame rather than only while a pop is live: the frame the pop retires is the
      // one that has to put the light back, and unconditional is one less way to leave a crystal
      // burning.
      diamond.setHighlight(glow);

      const pulse = secondsLeft <= PULSE_BELOW_S
        ? PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(elapsed * PULSE_HZ * Math.PI * 2))
        : 0;

      diamond.mesh.position.y = bounceOffset(elapsed + phase) + kick * KICK_HOP;
      // The kick, the pulse and the pop share the scale channel and simply add: a level change
      // landing inside the last five seconds should read as a knock on top of a beating marker, not
      // replace it, and a tap on that same rider has to answer over both.
      diamond.mesh.scale.setScalar(1 + kick * KICK_SCALE + pulse + pop * POP_SCALE_DIAMOND);
    },
  };
}
