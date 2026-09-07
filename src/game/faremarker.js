import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';
import { URGENCY_SEGMENTS, fareColor } from './urgency.js';
import {
  createDiamond, DIAMOND_HALF_H, bounceOffset, BOUNCE_HEIGHT,
  kickEnvelope, KICK_TIME, KICK_SCALE, KICK_HOP,
} from '../geometry/diamond.js';
import { createTargetRing, RING_Y } from '../geometry/targetring.js';
import { RIGHT } from './camera.js';
import { markEmissive, setEmissiveScale } from './bloom.js';
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
// **A disc under the rider's feet says it a second time, on the ground.** Same hue, same clock, the
// drop-off's own shape (geometry/targetring.js) — so a trip is marked the same way at both ends and
// there is nothing extra to learn. The crystal is at eye level, which is where the eye happens to
// be; the disc is on the road, which is where the taxi is actually being aimed, and it survives
// what the crystal does not — a rider behind a tower still has a mark on a plane the buildings
// mostly don't cover.
//
// It goes dark the moment they board. The kerb corner stops meaning anything then — the clock
// leaves with them, and a disc left glowing on an empty pavement would read as a second fare.
//
// Its own module under game/ rather than geometry/ because it owns a lifecycle — kerb, flight,
// taxi — and not just a mesh. geometry/diamond.js and geometry/targetring.js are the models it
// draws with.

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

/**
 * How high over its corner the crystal's top point reaches, at the top of its bounce.
 *
 * Exported because the crystal is *part of the marker's silhouette* without being part of the
 * marker: a tap on the diamond has always selected the fare under it, and the tap target that makes
 * that true is built in geometry/marker.js, which has no other way to know how far up this thing
 * goes. Derived rather than written down so retuning the shape or the hover moves the tap target
 * with it — the last two times either number changed, this reach changed with it.
 */
export const CRYSTAL_TOP = LIFT + DIAMOND_HALF_H + BOUNCE_HEIGHT;

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

// --- Backgrounded, while a rider is aboard ----------------------------------
//
// There is one seat. `markDirected` (game/fares.js) has always refused a kerbside fare while
// carrying one, and playtesters kept tapping them anyway — so a waiting rider's mark now steps back
// for as long as the seat is full: the crystal shrinks, and the disc under their feet darkens and
// loses its sweep (geometry/targetring.js).
//
// **Quieter, never gone, and never smaller.** A waiting fare's clock keeps draining while you
// drive, and running one out ends the run — and `budgetFor` charges every new arrival for the whole
// waiting queue ahead of it, so which rider is closest to the edge is exactly what the player should
// be reading on the way to a drop-off. The step-back says "not yet", not "not there".
//
// The crystal was shrunk to half for a first cut and it is **back at full size**: it read as a
// different, smaller kind of marker rather than as the same one turned down, and it took the hue —
// which is the clock — down with it in screen area. What goes instead is the **glow** and the
// **bounce**. Both halves of the mark are in the bloom (see markEmissive below), and the spill is
// an order of magnitude wider than the thing spilling, so it is most of what makes a marker carry
// across the city; the hop is the other half of the same claim, because a thing that moves on its
// own is a thing asking to be pressed. Between them they are the loudest pair that can come off a
// marker without touching what it *says*: same size, same hue, same place, still — no halo.
//
// **The bounce is damped, not stopped.** `bg` scales its amplitude, so a marker settles onto its
// rest height over the same 0.3s the glow fades in rather than freezing wherever in the cycle the
// pickup happened to land. `bounceOffset` is `abs(sin)` and bottoms out at exactly 0, so the height
// it settles to *is* the height it already touches once a cycle — the marker comes to rest at a
// place the eye has been watching it hit all along, which is what makes it read as stopping rather
// than as dropping.
//
// Two things deliberately keep moving. The **panic pulse** under five seconds: a rider about to
// give up is exactly as urgent whether or not the seat is full, and that is the one piece of news
// this must never suppress — it is also why the pulse rides the scale channel and the bounce rides
// position, so damping one cannot touch the other. And the **level-change kick**, for the same
// reason: a still marker that knocks once is a clock stepping down, which is news rather than an
// invitation.
const BACKGROUND_GLOW = 0;
// Seconds to cross, either way. Longer than a kick and shorter than the boarding animation, so the
// board settles into its new reading while the rider is still climbing in rather than snapping on
// the pickup frame — which already has a crystal in flight and two discs trading places. A halo
// that vanished on one frame would read as the marker being switched off rather than turned down.
const BACKGROUND_EASE = 0.3;

// --- The refused tap --------------------------------------------------------
//
// A tap on a kerbside rider while carrying used to do *nothing at all* — `main.js` returned before
// the route was planned, with no pop, no buzz and no mark on the screen, which is indistinguishable
// from tapping the sky. That is most likely what the playtest was actually showing: not players who
// could not see the rule, but players who asked the question and got no answer.
//
// So the crystal shakes. Sideways along the screen's own right (`RIGHT` in game/camera.js, which is
// the ground vector that projects horizontal under this fixed camera), damped to nothing — a head
// shake, and the one gesture on the board that is not a swell, because every swell here already
// means "yes".
//
// **Deliberately no colour.** The hue is the clock and nothing else may write it, and the highlight
// channel is the select pop's — a refusal that lit the crystal the way an accepted tap does would
// be the screen saying both things at once.
const REFUSE_TIME = 0.34;
const REFUSE_HZ = 8.5;         // ~3 shakes inside the envelope
const REFUSE_AMPLITUDE = 0.55; // world units at the first swing, ~4px at play zoom, and it is a
                               // position offset rather than a scale, so a half-size crystal shakes
                               // proportionally further rather than proportionally less

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

  // The disc under the rider's feet. Its own scene-level group rather than a child of the one
  // above: that one flies to the taxi, and this one stays on the pavement until it is switched off.
  const ring = createTargetRing(fareColor(URGENCY_SEGMENTS));
  ring.group.visible = false;
  scene.add(ring.group);

  // Both halves of the mark glow — see game/bloom.js. Marked once here rather than per fare because
  // these are **pooled**: `game/fares.js` builds MAX_FARES of them at startup and shows and hides
  // them, so the draw list is filled once and `visible` does the rest for free.
  //
  // Neither needed a material change: the crystal is a Lambert with an emissive (which is what the
  // pass reads for a lit material) and the disc is `unlitMaterial` (whose colour *is* the light).
  // What they did need is the pass re-reading them every frame — **their hue is the clock**, and a
  // copy taken at construction would bloom the wrong urgency for the whole run.
  //
  // Both are deliberately the two lowest intensities in `BLOOM_INTENSITY`. A read-out that
  // saturates toward white has stopped reporting its number, and these two report the one number
  // the player is actually racing.
  markEmissive(group, 'crystal');
  markEmissive(ring.group, 'ring');

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
  let refuseAt = null;
  let refusePending = false;
  // The step-back, and where it is heading. `bg` is eased toward `bgTarget` in `update`; `showAt`
  // snaps it, so a rider who appears while the seat is already full opens backgrounded rather than
  // shrinking in front of the player as their first act.
  let bg = 0;
  let bgTarget = 0;

  /**
   * Push the current step-back to the two things that carry it: the disc's dim, and the glow on
   * both halves of the mark.
   *
   * One function because they have to move together — a crystal with its halo gone over a disc at
   * full brightness is not a marker turned down, it is a marker with a bug. Written unconditionally
   * on every frame the marker is visible rather than only while `bg` is moving: both setters are a
   * compare-and-return on the common path, and unconditional is one less way to leave a rider the
   * player can now take sitting there with no glow on them.
   */
  function applyBackground() {
    ring.setDim(bg);
    // Both groups, and both are already marked — the crystal (with its outline hull) and the disc's
    // three layers. `setEmissiveScale` folds into the pass's intensity, so 0 leaves the draw list
    // through `material.visible` rather than drawing black. See game/bloom.js.
    const glow = THREE.MathUtils.lerp(1, BACKGROUND_GLOW, bg);
    setEmissiveScale(group, glow);
    setEmissiveScale(ring.group, glow);
  }
  // `update` is handed sim time, not a delta — every animation in this file is a function of the
  // clock, which is what keeps a frozen shot reproducible. The ease is the one thing here that is
  // *rate*-shaped rather than envelope-shaped (it can be interrupted and reversed halfway), so it
  // takes its own delta off the same clock. null until the first frame, and reset by `showAt`, so
  // a slot coming back from the pool never integrates a run's worth of elapsed time in one step.
  let lastElapsed = null;

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
    // A VIP's crystal and disc stay their fixed purple rather than cycling the ordinary green-to-red
    // scale — one colour language per marker, not two fighting for the same rider. The panic pulse
    // (a shared scale cue, not a colour) still carries urgency for it.
    if (vipMarked) return;
    const colour = fareColor(next);
    diamond.setColor(colour);
    ring.setColor(colour);
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
    // Likewise the disc on the ground, which has to agree with the crystal on every frame.
    ring: ring.group,
    /**
     * Whether the kerb disc is mid-exit — it pulls back into its own centre at the hand-off rather
     * than switching off, so `ring.visible` stays true for RING_SHRINK_TIME after `beginTransfer`.
     * Exposed for `tools/probe.mjs`, which asserts the hand-off as one disc leaving while the other
     * arrives; reading `visible` alone would call a shrinking disc "still on the kerb".
     */
    ringLeaving: () => ring.isLeaving(),
    /** Put the kerb disc straight into its arrived state — shot mode. See targetring.js. */
    settleRing: () => ring.settle(),
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

    /**
     * Step this fare's mark back behind the one in the car, or bring it forward again.
     *
     * Pushed from the fare loop every frame (game/fares.js) rather than latched at the pickup,
     * because it is a *state* — "is the seat full" — and a fare can enter it either way round: a
     * rider already on the kerb when someone else gets in, or a rider spawning while one is aboard.
     * Reconciling it per frame is also what makes it correct across a drop-off, a run ending and a
     * VIP expiring, none of which go through a common exit.
     */
    setBackgrounded(on) { bgTarget = on ? 1 : 0; },
    /** How far back this mark currently stands, 0..1 — for the headless tools. */
    getBackgrounded: () => bg,

    /**
     * The player tapped this rider while carrying someone: shake the crystal.
     *
     * The other half of the answer is on the drop-off's disc, which swells at the same moment
     * (`refuse` in game/fares.js) — this one says "not this", that one says "that". Neither is a
     * state, so both are pushed rather than reconciled: a second refused tap on the same rider has
     * to shake again or it reads as the tap having been swallowed, which is the whole complaint.
     */
    refuse() { refusePending = true; },

    /**
     * Show the marker over a rider who has just appeared, at their kerb corner.
     *
     * `backgrounded` is passed rather than left to the caller's next `setBackgrounded`, because
     * these markers are **pooled**: the slot this rider is opening on may have spent the last fare
     * stepped back behind someone in the car, and a target inherited across a spawn is the same
     * class of bug as an inherited pop or an inherited kick — both of which this function already
     * clears below. It also has to be known *now* rather than a frame later: the fare loop
     * snapshots its live list before it refills, so a marker shown here is not updated until the
     * next frame, and shot mode never gets one.
     */
    showAt(nextLevel, x, z, vip = false, backgrounded = false) {
      // Straight to the opening colour with no kick: a marker that pops the moment it appears is
      // announcing a change that hasn't happened. A VIP opens straight into its fixed purple
      // instead of the urgency scale's top level — see setUrgency.
      level = nextLevel;
      vipMarked = vip;
      const openColour = fareColor(nextLevel, vip);
      diamond.setColor(openColour);
      ring.setColor(openColour);
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
      refuseAt = null;
      refusePending = false;
      // Snapped, not eased: a rider appearing while the seat is full opens at their backgrounded
      // size. Shrinking in front of the player would announce a change that happened before they
      // arrived.
      bgTarget = backgrounded ? 1 : 0;
      bg = bgTarget;
      applyBackground();
      lastElapsed = null;
      anchor.set(x, LIFT, z);
      group.position.copy(anchor);
      // Same corner, on the pavement: the rider stands in the middle of their own disc. It grows
      // out of its own centre rather than switching on — see targetring.js.
      ring.group.position.set(x, KERB_H + RING_Y, z);
      ring.appear();
      diamond.mesh.scale.setScalar(1);
      // Damped by the step-back here too — `update` owns this channel but does not run on the frame
      // a fare spawns (the loop snapshots its live list before it refills), and shot mode ticks the
      // loop exactly once, so a rider appearing while the seat is full would render one frame, or
      // one screenshot, mid-hop.
      diamond.mesh.position.set(0, bounceOffset(phase) * (1 - bg), 0);
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
      // The kerb corner is no longer where this fare is, so the disc pulls back into its own centre
      // as the drop-off's grows out of *its* one (fares.js, beginRide). Switching one off on the
      // frame the other switched on read as two unrelated events; two discs moving in opposite
      // directions read as one clock changing hands, which is what is actually happening.
      ring.vanish();
    },

    hide() {
      group.visible = false;
      refuseAt = null;
      refusePending = false;
      lastElapsed = null;
      // Instant. `hide` is a slot being handed on or a run ending, neither of which is a gesture —
      // and an animated exit here would be driven by an `update` that is no longer being called.
      ring.hideNow();
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

      // The step-back, eased on its own delta — see `lastElapsed`. Written through to the disc
      // every frame rather than only while it is moving: `setDim` is a compare-and-return on the
      // common path, and unconditional is one less way to leave a disc dark under a rider the
      // player can now take.
      const dt = lastElapsed === null ? 0 : Math.max(0, elapsed - lastElapsed);
      lastElapsed = elapsed;
      if (bg !== bgTarget) {
        const step = dt / BACKGROUND_EASE;
        bg = bgTarget > bg ? Math.min(bgTarget, bg + step) : Math.max(bgTarget, bg - step);
      }
      applyBackground();

      // The beam circling the disc, while there is a disc to circle — it goes dark with the ring
      // itself at the hand-off (see beginTransfer), so there is nothing left to spin in the car.
      if (ring.group.visible) ring.update(elapsed);

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

      if (refusePending) {
        refuseAt = elapsed;
        refusePending = false;
      }
      let shake = 0;
      if (refuseAt !== null) {
        const since = elapsed - refuseAt;
        // On the clock like every other envelope here: a damped sine passes through zero three
        // times inside its own run, so clearing on the value would kill the shake on its first
        // crossing and leave a single flick.
        if (since >= REFUSE_TIME) refuseAt = null;
        else {
          shake = Math.sin(since * REFUSE_HZ * Math.PI * 2)
            * REFUSE_AMPLITUDE * (1 - since / REFUSE_TIME);
        }
      }

      const pulse = secondsLeft <= PULSE_BELOW_S
        ? PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(elapsed * PULSE_HZ * Math.PI * 2))
        : 0;

      // `RIGHT` is in the ground plane (y = 0), so the shake never fights the bounce for the
      // vertical channel — the crystal keeps hopping while it is being shaken.
      //
      // The bounce is damped by the step-back and the kick's hop is not: see BACKGROUND_GLOW. A
      // backgrounded marker sits still and can still knock.
      diamond.mesh.position.set(
        RIGHT.x * shake,
        bounceOffset(elapsed + phase) * (1 - bg) + kick * KICK_HOP,
        RIGHT.z * shake,
      );
      // The kick, the pulse and the pop share the scale channel and simply add: a level change
      // landing inside the last five seconds should read as a knock on top of a beating marker, not
      // replace it, and a tap on that same rider has to answer over both.
      //
      // The step-back is **not** in this sum. It used to shrink the crystal and multiply here; it
      // is a glow now, and the crystal keeps its size through the whole of a fare's life — so a
      // backgrounded rider still kicks, pulses and pops at exactly the size the eye has learned
      // those gestures at.
      diamond.mesh.scale.setScalar(1 + kick * KICK_SCALE + pulse + pop * POP_SCALE_DIAMOND);
    },
  };
}
