import * as THREE from 'three';
import { ROUTE_OPACITY } from '../game/routeline.js';
import { popEnvelope, POP_TIME } from '../game/selectpop.js';
import { unlitMaterial } from '../util/geo.js';

// The disc a fare marks its ground with: a filled circle inside a solid rim, lying flat on the
// pavement corner. **Both ends of a trip wear one** — under the waiting rider, and on the corner
// they are going to once they are aboard — in that fare's urgency colour either way
// (game/urgency.js), so "a disc is a place this clock is attached to" is one rule with one shape
// behind it.
//
// The rider's has come and gone more than once: a draining countdown ring first, then nothing at
// all while the meter (and later the crystal) carried the clock overhead, then this. The argument
// against it was that a disc ought to mean "the taxi is being driven here" and a rider nobody has
// tapped is not that. The argument that won is simpler — the eye is on the road, and the colour
// belongs wherever the eye is. A rider whose crystal is behind a tower still has a mark on the
// tarmac.
//
// It never drains. Time is the colour's job; this only has to say "here".
//
// A third layer — the sweep — rides its outer edge: a bright head with a fading tail, circling at a
// fixed rate. Nothing about the fill or rim's own job changes; it is a quieter "this is a live
// target" cue layered over a mark that already reads on its own in a still frame.

export const RING_R = 3.5;
const RING_TUBE = 0.16;

// How far the disc floats above the surface it marks, so it paints over the pavement rather than
// z-fighting with it. Shared by both ends of the trip, which is part of what keeps them reading as
// one object that moved rather than two that happen to match.
export const RING_Y = 0.2;

// --- Backgrounded, while a rider is aboard ----------------------------------
//
// You cannot take a kerbside fare while carrying one (`markDirected` in game/fares.js refuses), and
// playtesters kept trying to anyway. So a waiting rider's disc steps back while the seat is full:
// same shape, same place, darker, with the sweep switched off.
//
// **Darker rather than smaller or absent**, and the choice is load-bearing. The disc is the half of
// the mark that survives this camera — a rider whose crystal is behind a tower still has colour on
// the tarmac — and the colour it is carrying is that rider's clock, which the player still has to
// read: a waiting fare running out ends the run, and `budgetFor` deliberately charges every new
// arrival for the whole waiting queue ahead of it. Hiding the disc would take the ordering puzzle
// off the road at exactly the moment the player is driving it. What can go is the *sweep* — the
// beam circling the rim is the "this is a live target" cue and nothing else, so it is the one layer
// that is saying something untrue while the seat is full.
const DIM_COLOR = 0.42;        // multiplier on the rim and fill's hue, fully backgrounded
const DIM_FILL_OPACITY = 0.5;  // ...on top of the fill's own ROUTE_OPACITY

// The drop-off's disc swells once when a tap on a kerbside rider is refused — see `pulse` below.
// Half the crystal's own select pop, because the two are wildly different sizes on screen and the
// gesture has to read as the same one: at play zoom the disc is a 27px radius, so the envelope's
// 0.944 peak here is ~+4px of radius, against the crystal's 29px going to 38px on its 0.34. Taken
// up from a first cut at 0.12 (+3px), which on something this large was a wobble rather than an
// answer — the amplitude that reads on a marker is not the one that reads on a disc.
const PULSE_SCALE = 0.16;

// One rim and one fill shape for every disc on the board — only the colour ever differs. The fill
// overlaps into the rim's tube rather than stopping at its inner edge, so no hairline of road shows
// between the two where the torus tessellates.
const RIM_GEO = new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 48).rotateX(-Math.PI / 2);
const FILL_GEO = new THREE.CircleGeometry(RING_R - RING_TUBE / 2, 48).rotateX(-Math.PI / 2);

// The beam that rides the rim: a bright head with a fading tail, circling the outer edge, so the
// disc reads as "a place" at a glance (the flat rim still does that job on its own) and the motion
// is a second, quieter cue riding on top of it.
//
// A little fatter than the rim it sits on so it reads as a highlight glinting along the edge rather
// than a second, thinner ring drawn at the same width.
const TWO_PI = Math.PI * 2;
const SWEEP_TUBE = RING_TUBE * 1.4;
const SWEEP_GEO = new THREE.TorusGeometry(RING_R, SWEEP_TUBE, 6, 64).rotateX(-Math.PI / 2);
{
  // Angle around the ring, taken from the torus's own built-in `uv.x` (three writes
  // `i / tubularSegments` there — see TorusGeometry's source) rather than re-derived with
  // `atan2(z, x)` on the rotated position. atan2 has a branch cut, and that cut lands at the
  // *opposite* side of the ring from the torus's real seam, straight through the middle of an
  // ordinary face — the vertices on either side of it still read as adjacent physical points but
  // report angles π apart, and the fragment shader interpolates that as a false second glow where
  // there is no seam at all. `uv.x` climbs 0→1 monotonically across every face with no such jump,
  // because three never emits a face that wraps its last tubular column back to its first.
  const uv = SWEEP_GEO.attributes.uv;
  const angle = new Float32Array(uv.count);
  for (let v = 0; v < uv.count; v++) angle[v] = uv.getX(v) * TWO_PI;
  SWEEP_GEO.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
}

// One revolution every 3.2s — fast enough to read as motion on a glance down at the road, slow
// enough not to compete with the panic pulse (game/faremarker.js) for the eye's attention.
const SWEEP_SPEED = TWO_PI / 3.2;
// How much of the circle the glow covers, trailing the head. A third of the ring, so most of its
// border still reads as the flat rim colour and the beam is a distinct thing riding over it rather
// than the whole rim simply looking brighter.
const SWEEP_TAIL = TWO_PI * 0.34;

/**
 * The moving highlight, over **any** band geometry carrying an `aAngle` attribute — the disc's torus
 * below, and the courier pad's rounded-square band (geometry/parcelpad.js).
 *
 * Shared rather than reimplemented per shape, because the shader *is* the effect: two copies of this
 * patch would be two beams that could drift apart in speed, tail length or falloff, and a board
 * carrying both a disc and a pad would show two subtly different kinds of "this is live". The
 * geometry is the only part that differs, so the geometry is the only part passed in.
 *
 * A `MeshBasicMaterial` patched rather than a bespoke `ShaderMaterial`: it wants everything the base
 * material already does (the same colour as the rim and fill, and three's ordinary
 * `colorspace_fragment` output), only with each fragment's alpha computed from how far it sits behind
 * a moving head angle.
 *
 * `customProgramCacheKey` is load-bearing: three keys its program cache off a patched material's
 * *parameters*, not the patch, so without it this would collide with the plain rim material the
 * instant they shared a colour and silently draw with whichever material's shader compiled first. One
 * key for every shape is correct — they compile the same source, and the geometry is what varies.
 */
export function createSweepFor(geometry, colorHex) {
  const material = unlitMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.customProgramCacheKey = () => 'ring-sweep';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHead = { value: 0 };
    shader.uniforms.uTail = { value: SWEEP_TAIL };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAngle;\nvarying float vAngle;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAngle = aAngle;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uHead;\nuniform float uTail;\nvarying float vAngle;')
      .replace('#include <dithering_fragment>',
        'float behind = mod(uHead - vAngle, 6.283185307179586);\n'
        + '\tfloat glow = pow(1.0 - smoothstep(0.0, uTail, behind), 1.6);\n'
        + '\tgl_FragColor.a *= glow;\n'
        + '\t#include <dithering_fragment>');
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 5;   // over the rim (4) and fill (3) — the beam rides on top of both
  mesh.raycast = () => {};

  return {
    mesh,
    material,
    /** Advances the beam. A no-op until the shader has actually compiled once. */
    update(elapsed) {
      const shader = material.userData.shader;
      if (shader) shader.uniforms.uHead.value = (elapsed * SWEEP_SPEED) % TWO_PI;
    },
  };
}

// --- Arriving and leaving ---------------------------------------------------
//
// A disc used to switch on and off. Both ends of a pickup did it on the same frame — the kerb disc
// went dark as the drop-off's lit — and two marks popping in opposite directions at once reads as
// two unrelated events rather than as one clock changing hands. So a disc now **grows out of its own
// centre** when it arrives and pulls back into it when it leaves.
//
// Shared with the courier pad (geometry/parcelpad.js) rather than reimplemented there: the two
// shapes differ, the gesture must not. Both are functions of sim time with the start stamped inside
// `update`, the same deferral game/faremarker.js makes, so a frozen shot renders the same frame every
// time however the calls happened to be ordered.

export const RING_GROW_TIME = 0.30;
export const RING_SHRINK_TIME = 0.20;

// Overshoot on the way in — a back-ease that crosses 1 and settles. ~1.045 at its peak, which is a
// disc that lands rather than one that eases to a halt; anything larger read as a bounce and started
// competing with the fare marker's own kick, which is the one thing on the board allowed to pop.
const GROW_BACK = 1.1;

/** Scale for a disc arriving: 0 → 1 with a small overshoot. */
export function ringGrowScale(t) {
  if (t >= 1) return 1;
  const u = t - 1;
  return 1 + (GROW_BACK + 1) * u * u * u + GROW_BACK * u * u;
}

/**
 * Scale for a disc leaving: 1 → 0, accelerating.
 *
 * Deliberately not the mirror of the growth. Arriving is news and wants the beat; leaving is a thing
 * getting out of the way, and an eased exit spends its last frames as a barely-moving object, which
 * reads as lag — the same argument the select pop's undershoot rests on.
 */
export const ringShrinkScale = (t) => (t >= 1 ? 0 : 1 - t * t);

/**
 * A target disc in one colour.
 *
 * The fill is at the route band's own opacity (see game/routeline.js), so a disc and the band
 * running into it read as one weight of paint. Depth-tested — a car crossing the junction should
 * drive *over* a disc rather than the disc painting across the car — and `depthWrite: false`, so
 * the two layers don't fight each other for the same plane.
 *
 * Being translucent puts the fill in three's transparent queue, which draws after every opaque
 * object regardless of order. That is exactly why the depth test has to stay on: under a waiting
 * rider, the far half of a flat circle projects *upward on screen* at this camera angle, and
 * without the test it would paint a band across the figure standing in it. (The old countdown ring
 * drew with the test off for legibility and needed a whole renderOrder convention to survive that.)
 */
export function createTargetRing(colorHex) {
  const group = new THREE.Group();
  const color = new THREE.Color(colorHex);

  const rim = new THREE.Mesh(
    RIM_GEO,
    unlitMaterial({ color: color.clone(), depthWrite: false }),
  );
  rim.renderOrder = 4;
  rim.raycast = () => {};
  group.add(rim);

  const fill = new THREE.Mesh(FILL_GEO, unlitMaterial({
    color: color.clone(),
    transparent: true,
    opacity: ROUTE_OPACITY,
    depthWrite: false,
  }));
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  fill.raycast = () => {};
  group.add(fill);

  const sweep = createSweepFor(SWEEP_GEO, colorHex);
  group.add(sweep.mesh);

  // How far this disc has stepped back, 0..1 — see DIM_COLOR above. Eased by the caller
  // (game/faremarker.js), which owns the clock; this only ever applies whatever it is handed.
  let dim = 0;

  /**
   * Restate the hue on all three layers at the current dim.
   *
   * One function rather than three assignments in `setColor`, because the dim and the clock write
   * the *same* channel: a level change while backgrounded would otherwise repaint the disc at full
   * brightness and undo the step-back, and it would do it four times a fare.
   *
   * The colour is scaled rather than the material faded, because two of the three layers are opaque
   * `unlitMaterial`s whose colour *is* their light — turning them transparent to dim them would move
   * them into three's transparent queue for a look change. The sweep is already additive and
   * transparent, so it fades on `opacity` and stops being drawn at all once it is out.
   */
  function paint() {
    const k = THREE.MathUtils.lerp(1, DIM_COLOR, dim);
    rim.material.color.copy(color).multiplyScalar(k);
    fill.material.color.copy(color).multiplyScalar(k);
    fill.material.opacity = ROUTE_OPACITY * THREE.MathUtils.lerp(1, DIM_FILL_OPACITY, dim);
    sweep.material.color.copy(color);
    sweep.material.opacity = 1 - dim;
    sweep.mesh.visible = dim < 1;
  }

  // Growth/exit state. `pending` is a call waiting to be stamped; the stamp happens in `update` so
  // both are functions of one frame's sim time — see the note above RING_GROW_TIME.
  let grewAt = null;
  let goneAt = null;
  let pending = null;      // 'grow' | 'shrink'
  // The refusal swell, on the same deferred stamp as everything else here — see `pulse`.
  let pulseAt = null;
  let pulsePending = false;

  return {
    group,
    /** All three layers together — they are one mark at three weights, never different colours. */
    setColor(value) {
      color.set(value);
      paint();
    },
    /**
     * Step this disc back behind the fare in the car, 0..1. See DIM_COLOR above.
     *
     * A scalar rather than a flag so the caller can ease it: the transition lands on the pickup
     * frame, which already has a crystal flying to the roof and two discs trading places, and a
     * board of markers snapping darker in the middle of that reads as a glitch.
     */
    setDim(amount) {
      const next = THREE.MathUtils.clamp(amount, 0, 1);
      if (next === dim) return;
      dim = next;
      paint();
    },
    /**
     * Swell once and settle — the "not that one, *this* one" half of a refused tap.
     *
     * Fired on the **drop-off's** disc when the player taps a kerbside rider while carrying
     * (`refuse` in game/fares.js). The refusal shakes the crystal over the rider that was tapped;
     * this answers it by pointing at the thing that has to happen first, which is the half a player
     * who has just learned there is one seat actually needs.
     *
     * Scale only, and it borrows the select pop's envelope rather than inventing a second one: an
     * acknowledgement is an acknowledgement, and the two should read as the same gesture at
     * different sizes. A no-op on a disc that is not on screen.
     */
    pulse() {
      if (!group.visible) return;
      pulsePending = true;
    },
    /**
     * Arrive: grow out of the centre. Sets the scale to nothing *now* as well as flagging the
     * animation, because there is a frame between this call and the first `update` and a disc drawn
     * full-size in it is exactly the pop this replaces.
     */
    appear() {
      pending = 'grow';
      goneAt = null;
      group.scale.setScalar(0);
      group.visible = true;
    },
    /** Leave: pull back into the centre, then hide. The group stays visible until it has. */
    vanish() {
      if (!group.visible) return;
      pending = 'shrink';
      grewAt = null;
    },
    /**
     * Jump to fully arrived, cancelling any animation.
     *
     * For **shot mode**, which ticks the fare loop exactly once and then freezes: an arrival that is
     * a function of sim time needs sim time to pass, so a disc that opens at scale 0 and is never
     * updated again is a disc that is simply not there. Every rider's kerb disc vanished from every
     * screenshot the day `appear()` landed, which is a worse failure than the pop it replaced —
     * hence a way to say "be arrived" without pretending a frame went by.
     */
    settle() {
      pending = null;
      grewAt = null;
      goneAt = null;
      group.scale.setScalar(1);
    },
    /** Off, with no animation — a run ending, or a slot being handed to the next job. */
    hideNow() {
      group.visible = false;
      group.scale.setScalar(1);
      grewAt = null;
      goneAt = null;
      pending = null;
      pulseAt = null;
      pulsePending = false;
    },
    /** Whether the exit is still playing, so a caller can hold a slot until it finishes. */
    isLeaving: () => pending === 'shrink' || goneAt !== null,
    /**
     * Advances the beam circling the rim, and whichever of the two size animations is running.
     * Cheap enough to call every frame the disc is visible.
     */
    update(elapsed) {
      // Still advanced while backgrounded, because `dim` is eased rather than switched: a beam
      // frozen mid-fade would sit as a bright arc on the rim for the length of the ease.
      if (sweep.mesh.visible) sweep.update(elapsed);

      if (pending === 'grow') { grewAt = elapsed; pending = null; }
      else if (pending === 'shrink') { goneAt = elapsed; pending = null; }
      if (pulsePending) { pulseAt = elapsed; pulsePending = false; }

      // The arrival/exit animation and the refusal swell share one channel and *multiply*: a disc
      // pulsed on the frame it is still growing in should swell out of wherever it has got to, not
      // jump to full size and back.
      let size = 1;
      if (goneAt !== null) {
        const t = (elapsed - goneAt) / RING_SHRINK_TIME;
        size = ringShrinkScale(t);
        if (t >= 1) { group.visible = false; goneAt = null; size = 1; }
      } else if (grewAt !== null) {
        const t = (elapsed - grewAt) / RING_GROW_TIME;
        size = ringGrowScale(t);
        if (t >= 1) grewAt = null;
      }
      if (pulseAt !== null) {
        const since = elapsed - pulseAt;
        // Retired on the clock, not on the value — the envelope passes through 0 on its way to the
        // undershoot, the same reason every other pop in this project is timed rather than tested.
        if (since >= POP_TIME) pulseAt = null;
        else size *= 1 + popEnvelope(since) * PULSE_SCALE;
      }
      group.scale.setScalar(size);
    },
  };
}
