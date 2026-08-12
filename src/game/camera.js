import * as THREE from 'three';
import { HALF_SPAN } from '../city/grid.js';

// Classic 3/4 sim camera: a fixed orthographic view looking down a diagonal. Orthographic rather
// than perspective is what makes it read as a city *sim* — parallel lines stay parallel, so
// blocks at the far edge look the same size as blocks under the cursor.

// Exported because anything that has to *face* this camera needs the same number. The view never
// rotates — only the target and the zoom move — so a billboard is a constant orientation computed
// once from this, not a per-frame lookAt.
export const VIEW_DIR = new THREE.Vector3(1, 0.92, 1).normalize();
const DISTANCE = 400;

// Screen right is world (+X, -Z) for this view direction; screen up is (-X, -Z).
const RIGHT = new THREE.Vector3(1, 0, -1).normalize();
const UP = new THREE.Vector3(-1, 0, -1).normalize();

// A one-shot pan — a tap on a rider-finder chip — as opposed to the two follow-cams, which chase a
// car. Different problem, different curve. Exponential smoothing has no ease *in*: it leaves at its
// highest speed on the very first frame, which is right when you are closing a gap that keeps
// reopening, and reads as most of a snap when you start from a dead stop.
//
// A pan's destination is usually a point that isn't moving, which is the other half of why this
// curve suits it. The one exception is a peek's ride home (see peekAt), which travels on the same
// tween but re-aims at the taxi every frame — a fixed-duration move over a target that drifts a few
// units, rather than a chase after one that never stops.
//
// Duration is driven by distance so a hop to the next block and a cross-town pan both travel at a
// legible speed, clamped at both ends: under the floor a short pan is a snap again, and over the
// ceiling the player is watching the camera travel with a fare's clock draining.
const GLIDE_SPEED = 150;        // world units per second, averaged over the move
const GLIDE_MIN_TIME = 0.32;
const GLIDE_MAX_TIME = 0.75;
// Below this the camera is already there and a tween would only add a frame of nothing.
const GLIDE_EPSILON = 0.05;

// How long a peek sits on the rider before setting off back to the taxi. Long enough to read who
// is waiting and which corner they're on — the whole reason the camera went there — and short
// enough that it never feels like the player is being *shown* something on a clock that is
// draining. Measured against the pan either side of it: at 0.32-0.75s a leg, a beat much under
// this reads as the camera arriving and immediately changing its mind.
const PEEK_HOLD = 0.9;

// Smootherstep. Zero *velocity* and zero *acceleration* at both ends, where plain smoothstep only
// zeroes velocity — with a move this short the kink at the start of a smoothstep is still visible
// as a flick, and the whole point of the pan is that the eye can ride it all the way across.
const smootherstep = (k) => k * k * k * (k * (k * 6 - 15) + 10);

// --- Leading the car -------------------------------------------------------
// A follow-cam centred on the taxi spends half the frame on road already driven. Under Loco Mode
// that is the expensive half: the mode exists to cover ground, and the player was paying for it by
// swiping ahead by hand — mid-boost, which is the one moment panning is the wrong gesture. So the
// follows aim *past* the car, and the car settles into the trailing quadrant: heading north-west it
// sits south-east of centre with the north-west of the map opened up in front of it.
//
// The offset is stated in **screen** space and converted back, which is the whole reason this isn't
// three lines. A fixed world-space lead — what the passing lab uses, where the road runs due east
// and nothing else is possible — buys wildly different amounts of visibility per heading here, for
// two compounding reasons:
//
//   - the view is a diagonal, so a world direction's screen bearing is not its map bearing, and a
//     ground step up-screen is foreshortened to VIEW_DIR.y = 0.55 of one across it;
//   - the frustum is sized by *height*, so in portrait the frame is roughly 2:1 the other way and
//     there is twice as much room to give away up-screen as sideways.
//
// Multiplied out, the same world lead is worth ~4x more of the frame going one way than the other.
// Framing on the screen fraction instead puts the car at the same place in the picture whichever
// way it is pointed, on a phone and on a desktop, and the world distance falls out of that.
const LEAD_FRACTION = 0.3;      // of the half-frame measured along the heading — see frameLead
// How fast the offset itself eases, on top of whatever rate the follow is closing at. Slower than
// either follow on purpose: the lead swings through 90° at every corner, and at the follow's own
// rate that lands as a shove sideways at the exact moment the player is reading a new street. At
// 2.4 the frame opens into the turn over about half a second, trailing the car through it.
const LEAD_RATE = 2.4;

// **And the follow's own trail is paid back.** An exponential follow *trails* whatever it is
// chasing: aiming at a point moving at v and closing
// `1 - exp(-dt * rate)` of the gap per frame settles v / rate behind it, permanently. That is 5.8
// units at the Loco Mode top on BOOST_FOLLOW_SMOOTHING, and it points backwards along exactly the
// axis this is trying to open up — before any of this the boosting taxi sat 6% of the half-frame
// *past* centre, so the follow was showing less of the road ahead than a static frame would have.
//
// The two follows also run at 1.5 and 3.2, so the same speed trailed them by different amounts and
// the framing shifted on the Loco Mode press — the one frame the player is certain to be watching.
// Cancelling the trail is what makes LEAD_FRACTION a fact about the picture rather than an opening
// bid: both follows then seat the car at the same place, and the constant means what it says.
// Steady-state, so it is only exact at a constant speed; it rides the same ease as the lead itself,
// which is what keeps a hard stop from snapping the frame back.

// A ground vector's screen offset is (v·RIGHT, (v·UP) * sin(elevation)) — RIGHT lies in the ground
// plane so it keeps its full length, UP is the ground plane's share of a tilted screen-up. And
// because VIEW_DIR is a unit vector, its y component *is* that sine: 0.5453 at the fixed 33°.
const SIN_ELEV = VIEW_DIR.y;

// --- Shake ------------------------------------------------------------------
// Two kinds of it, sharing one jitter. An **impulse** is fired once and decays — a wreck, a
// barricade, a bust; a **rumble** is a level *asked for* every frame and eased in and out, which is
// what Loco Mode holds. The bigger of the two wins rather than the two adding: a wreck landing
// mid-boost has to read as the wreck, and the rumble must not leave a floor under a kick that is
// meant to fall away to nothing.
const SHAKE_DECAY = 5;          // per second; an impulse is under a tenth of itself in half a second

// The rumble's full amplitude, in world units, at `setRumble(1)`. Deliberately about a pixel: at
// play zoom (52 — the frame is 2*52 units tall) one world unit is ~7.7px on a phone, so this is
// 1.4px of camera travel per axis, and the three axes are independent, so what lands on screen is
// typically under a pixel of picture with peaks near two.
//
// A rumble is a texture under the speed, not an event. The gentlest one-shot kick in the game is
// the roadworks landing at 0.7 (~5px), and anything near *that* held for fifteen seconds at a
// stretch is a fight with the road the player is trying to read.
const RUMBLE_AMPLITUDE = 0.18;
// How fast the level chases what the caller is asking for. Both directions, so the press fades it
// in over about a quarter of a second — under the wheelie and the flame, which are what actually
// punctuate the press — and the release takes it out over the same, roughly with the coast-down.
const RUMBLE_RATE = 8;

/**
 * Where to aim, relative to the car, to seat it `LEAD_FRACTION` of a half-frame into the quadrant
 * behind it. `(dirX, dirZ)` is the heading on the ground — any length, it is normalised here — and
 * `gain` scales the whole thing from 0 (centred) to 1.
 *
 * Derivation, because the closed form below looks like it has lost a step. With `(sx, sy)` the
 * screen offset of one world unit along the heading, the unit screen bearing is `(sx, sy) / m` and
 * the distance from centre to the frame edge along it is `m / hypot(sx/halfW, sy/halfH)` — an
 * ellipse inscribed in the frame rather than the rectangle itself, which is kink-free as the
 * heading sweeps a corner and agrees with the rectangle on both axes anyway. Wanting
 * `LEAD_FRACTION` of that, in world units, is that over `m` — and the `m` cancels.
 *
 * Exported so `tools/probe.mjs` can check the framing it produces against a real frustum rather
 * than against a number copied out of here.
 */
export function frameLead(dirX, dirZ, gain, halfW, halfH) {
  const len = Math.hypot(dirX, dirZ);
  if (len < 1e-6 || gain <= 0) return { x: 0, z: 0 };
  const ux = dirX / len;
  const uz = dirZ / len;
  const sx = ux * RIGHT.x + uz * RIGHT.z;
  const sy = (ux * UP.x + uz * UP.z) * SIN_ELEV;
  // RIGHT and UP span the ground plane and SIN_ELEV is non-zero, so sx and sy cannot both vanish.
  const dist = (LEAD_FRACTION * gain) / Math.hypot(sx / halfW, sy / halfH);
  return { x: ux * dist, z: uz * dist };
}

export function createCityCamera(aspect, { zoom = 46, target = [0, 0] } = {}) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1400);
  const state = {
    zoom,                       // half-height of the view frustum, in world units
    target: new THREE.Vector3(target[0], 0, target[1]),
    // Current shake magnitude, in world units. Non-zero means apply() jitters camera.position by
    // ±this on each axis before lookAt. Decayed each frame from main.js via updateShake().
    shake: 0,
    // The held rumble, same units, eased toward `rumbleWant` by updateShake(). Separate from
    // `shake` because it does not decay: it sits wherever the caller is holding it.
    rumble: 0,
  };

  // What the caller last asked for. Kept off `state` so there is one place a rumble is read from —
  // `state.rumble` is the level actually in the picture, and a debug readout or a check wanting to
  // know "is the camera rumbling" means that one, not the request behind it.
  let rumbleWant = 0;

  // In-flight glide, or null when idle. Held here rather than on `state` because nothing outside
  // reads it — the getters below are the whole interface.
  //
  // One field covers the plain pan *and* the multi-leg move a peek is (out, hold, back), so every
  // existing handover drops a peek exactly as it drops a pan: a drag, a boost chase and a wreck
  // focus all clear this one variable and nothing is left half-sequenced behind them.
  let glide = null;

  // The live lead offset. Eased rather than written, so the follow reads a continuous offset
  // through a corner — see LEAD_RATE. Only `followXZ` steps it, so a follow that stops leaves the
  // offset where it stood, exactly as it leaves the target: nothing here snaps back on the way out.
  const lead = { x: 0, z: 0 };

  /**
   * Ease the lead toward what `aim` asks for, or back to centred when nothing is aiming. `aim` is
   * `{ x, z, gain, speed }`: a heading on the ground, a 0-1 strength — which callers drive off
   * speed, so a taxi held at a red sits centred and one at the Loco Mode top gets the full offset —
   * and the speed itself, which pays back the follow's own trail (see above).
   */
  function stepLead(aim, dt, smoothing, aspectRatio) {
    const halfH = state.zoom;
    const want = aim
      ? frameLead(aim.x, aim.z, aim.gain ?? 1, halfH * aspectRatio, halfH)
      : { x: 0, z: 0 };
    // The trail is along the heading, like the lead, so it is added into it rather than applied
    // separately — one eased vector carries both and there is one place the framing is decided.
    const len = aim ? Math.hypot(aim.x, aim.z) : 0;
    if (len > 1e-6 && aim.speed > 0 && smoothing > 0) {
      const trail = aim.speed / smoothing;
      want.x += (aim.x / len) * trail;
      want.z += (aim.z / len) * trail;
    }
    const k = 1 - Math.exp(-dt * LEAD_RATE);
    lead.x += (want.x - lead.x) * k;
    lead.z += (want.z - lead.z) * k;
  }

  /**
   * Arm one leg. `dur` comes from the distance at this instant even when `track` will move the
   * destination later — a taxi cannot outrun the camera over three quarters of a second, so the
   * duration stays a fair read on how far there is to go.
   */
  function armGlide(toX, toZ, { track = null, hold = 0, next = null, onArrive = null } = {}) {
    const fromX = state.target.x;
    const fromZ = state.target.z;
    const clampedX = THREE.MathUtils.clamp(toX, -HALF_SPAN, HALF_SPAN);
    const clampedZ = THREE.MathUtils.clamp(toZ, -HALF_SPAN, HALF_SPAN);
    const dist = Math.hypot(clampedX - fromX, clampedZ - fromZ);
    glide = {
      fromX, fromZ, toX: clampedX, toZ: clampedZ, t: 0,
      // Zero when the camera is already standing on the destination: the travel is skipped and
      // whatever follows it — a peek's beat, its arrival callback — still happens.
      dur: dist < GLIDE_EPSILON ? 0 : THREE.MathUtils.clamp(dist / GLIDE_SPEED,
        GLIDE_MIN_TIME, GLIDE_MAX_TIME),
      track, hold, next, onArrive,
    };
    return dist;
  }

  function apply(aspectRatio) {
    const halfH = state.zoom;
    const halfW = halfH * aspectRatio;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();

    camera.position.copy(state.target).addScaledVector(VIEW_DIR, DISTANCE);
    const jitter = Math.max(state.shake, state.rumble);
    if (jitter > 0.001) {
      camera.position.x += (Math.random() * 2 - 1) * jitter;
      camera.position.y += (Math.random() * 2 - 1) * jitter;
      camera.position.z += (Math.random() * 2 - 1) * jitter;
    }
    camera.lookAt(state.target);
  }

  apply(aspect);

  return {
    camera,
    state,
    resize: (aspectRatio) => apply(aspectRatio),
    update: (aspectRatio) => apply(aspectRatio),
    /**
     * Kick a new shake, in world units of amplitude. Takes the max of the existing shake and the
     * new value so a bigger impact can override a still-decaying smaller one, but a tiny
     * secondary hit can't cancel the big one.
     */
    kickShake(amplitude) {
      state.shake = Math.max(state.shake, amplitude);
    },
    /**
     * Ask for a held rumble — `level` is 0-1 of `RUMBLE_AMPLITUDE`, the same 0-1 vocabulary the
     * follow's `aim.gain` uses, and callers drive it off speed for the same reason.
     *
     * Asked for *every frame*, not fired: this is a request, and it is the caller's own gate that
     * decides whether the rumble is up. So there is nothing to switch off on the way out — a mode
     * that ends simply stops asking, and anything that forgets to call it eases back to still
     * rather than leaving the city buzzing. Unlike `kickShake` it does not take a max, because a
     * level that could only ever go up is not a level.
     */
    setRumble(level) {
      rumbleWant = THREE.MathUtils.clamp(level, 0, 1) * RUMBLE_AMPLITUDE;
    },
    /**
     * Step both shakes and repaint the camera. Called every frame from main.js so a running shake
     * refreshes independent of any pan/follow. The impulse decays exponentially, which reads as a
     * natural fall-off rather than a hard cut; the rumble eases toward whatever `setRumble` last
     * asked for. Both snap to zero under a low threshold so an idle camera stops repainting — the
     * frame that lands on zero still repaints, which is what clears the last jittered position
     * instead of leaving it standing.
     */
    updateShake(dt, aspectRatio) {
      if (state.shake <= 0 && state.rumble <= 0 && rumbleWant <= 0) return;
      state.shake *= Math.exp(-dt * SHAKE_DECAY);
      if (state.shake < 0.01) state.shake = 0;
      state.rumble += (rumbleWant - state.rumble) * (1 - Math.exp(-dt * RUMBLE_RATE));
      if (state.rumble < 0.001) state.rumble = 0;
      apply(aspectRatio);
    },
    /**
     * Ease the camera target toward `(x, z)`. Framerate-independent: `smoothing` is a per-second
     * rate, so `1 - exp(-dt * smoothing)` is the fraction closed each frame. Higher = snappier.
     * Callers hold their own gate on when to follow (e.g. only while boost is active); this just
     * does the one step and leaves the state alone otherwise, so releasing the gate stops the
     * chase without any rubber-band back.
     *
     * Pass `aim` — `{ x, z, gain, speed }`, a ground heading, a 0-1 strength and the car's speed —
     * to frame the road ahead instead of the car itself; see LEAD_FRACTION. Omitting it doesn't
     * merely skip the offset, it eases any standing one back to zero, so a caller that wants the
     * car dead centre (the tutorial, pointing at it) gets that by saying nothing.
     */
    followXZ(x, z, dt, smoothing = 3.2, aspectRatio, aim = null) {
      glide = null;             // a chase outranks a pan; see cancelGlide
      stepLead(aim, dt, smoothing, aspectRatio);
      const t = 1 - Math.exp(-dt * smoothing);
      state.target.x += (x + lead.x - state.target.x) * t;
      state.target.z += (z + lead.z - state.target.z) * t;
      state.target.x = THREE.MathUtils.clamp(state.target.x, -HALF_SPAN, HALF_SPAN);
      state.target.z = THREE.MathUtils.clamp(state.target.z, -HALF_SPAN, HALF_SPAN);
      apply(aspectRatio);
    },
    /**
     * Ease target and zoom toward a fixed focus point — for cinematic beats like the wreck close-up
     * where both the framing *and* the zoom level need to change together. Same rate on both so a
     * caller can just keep calling it every frame and know they'll converge in step.
     */
    focusOn(x, z, targetZoom, dt, aspectRatio, smoothing = 2.4) {
      glide = null;             // as followXZ: whoever is easing the camera now owns it
      const t = 1 - Math.exp(-dt * smoothing);
      state.target.x += (x - state.target.x) * t;
      state.target.z += (z - state.target.z) * t;
      state.zoom += (targetZoom - state.zoom) * t;
      apply(aspectRatio);
    },
    /**
     * Start an eased pan to `(x, z)` — see GLIDE_SPEED above for why this is a fixed-duration
     * tween rather than the exponential ease the follows use. The start point is wherever the
     * camera is *now*, so a second call mid-flight redirects from there rather than snapping back
     * to the first call's origin — and its duration comes from that shorter remaining distance.
     */
    glideTo(x, z) {
      // Nothing after the travel, so the epsilon case is simply idle: the camera is already there
      // and a tween would only add a frame of nothing.
      if (armGlide(x, z) < GLIDE_EPSILON) glide = null;
    },
    /**
     * Look at `(x, z)` for a beat, then come back to whatever `getReturn()` is pointing at by
     * then — the rider-finder chip's whole camera move, out and home.
     *
     * The pan out exists because the rider may be off-screen entirely; the trip home exists
     * because *leaving* the camera on them costs the player the same hunt in reverse. They tapped
     * a chip, not a map: the answer they wanted was "who is waiting, and where", and once they
     * have it the framing belongs back on the car they are driving. Without this leg the player
     * pays for the convenience by dragging the map back by hand, which is slower than the pan
     * saved and lands them somewhere approximate.
     *
     * The return destination is re-read every frame rather than fixed when the leg starts: the
     * taxi has been driving the whole time, and a fixed aim would land on the patch of road it
     * left. Tracking it means the last frame sits exactly on the car *and* is already moving at
     * the car's speed, so a follow-cam picking the framing up from here has no gap to close and
     * nothing snaps.
     *
     * `onArrive` fires only if the whole sequence runs to its end. Anything that outranks a pan —
     * a finger on the map, a boost chase, a wreck — drops the peek where it stands and the
     * callback never comes, which is what keeps "the camera is back on the taxi" a fact rather
     * than an assumption.
     */
    peekAt(x, z, getReturn, onArrive) {
      armGlide(x, z, {
        hold: PEEK_HOLD,
        next: () => {
          const home = getReturn();
          armGlide(home.x, home.z, { track: getReturn, onArrive });
        },
      });
    },
    /**
     * Abandon a glide where it stands. The player grabbing the map mid-pan has to win immediately —
     * a tween still writing the target every frame would drag the city back out from under their
     * finger. Deliberately leaves the camera where it got to, like every other handover here.
     */
    cancelGlide() { glide = null; },
    isGliding: () => glide !== null,
    /**
     * The live follow lead, in world units — how far past the taxi the camera is currently aiming.
     * A copy, because it is eased in place every frame and a handed-out reference would alias it.
     */
    leadOffset: () => ({ x: lead.x, z: lead.z }),
    /**
     * Step a running glide. Returns true on every frame it moved the camera, including the frame it
     * lands on, so a caller can tell "the pan owns this frame" from "nothing to do". A no-op when
     * idle, which is what lets main.js call it unconditionally.
     */
    updateGlide(dt, aspectRatio) {
      if (!glide) return false;

      // The travel. Skipped entirely on a zero-length leg — see armGlide — which is what lets a
      // peek fired while the camera is already on the rider still hold the beat and still come
      // home.
      if (glide.t < glide.dur) {
        glide.t = Math.min(glide.t + dt, glide.dur);
        // Re-aimed before the ease is applied, not after, so the frame that lands is computed
        // against where the target is *now*. See peekAt.
        if (glide.track) {
          const to = glide.track();
          glide.toX = THREE.MathUtils.clamp(to.x, -HALF_SPAN, HALF_SPAN);
          glide.toZ = THREE.MathUtils.clamp(to.z, -HALF_SPAN, HALF_SPAN);
        }
        const e = smootherstep(glide.t / glide.dur);
        state.target.x = glide.fromX + (glide.toX - glide.fromX) * e;
        state.target.z = glide.fromZ + (glide.toZ - glide.fromZ) * e;
        apply(aspectRatio);
        // Retired on the clock, not on the distance left: smootherstep's tail is flat, so a
        // "close enough" test would cut the last few frames — the gentlest part of the whole move.
        // The landing frame falls through to the stages below, so a plain pan retires on it as it
        // always did; a peek's beat starts counting on the frame after, at its full length.
        if (glide.t < glide.dur || glide.hold > 0) return true;
      }

      // The beat. Nothing moves — the camera just sits on the rider — so this is the one stage
      // that owns the frame without repainting anything.
      if (glide.hold > 0) {
        glide.hold -= dt;
        return true;
      }

      // Whatever comes after: for a peek, the ride home. Cleared first so the leg `next` arms
      // isn't overwritten by this one retiring.
      const { next, onArrive } = glide;
      glide = null;
      if (next) next();
      else onArrive?.();
      return true;
    },
  };
}

// A press has to smear a few pixels before it counts as a drag. Below this it is still a tap, and
// the camera must not creep — on a phone every selection lands with 2-4px of finger travel, and a
// camera that answers all of it means the map slides a little every time you pick a fare.
const PAN_SLOP = 8;

// Panning stops with a corner of the city centred. Further than that and the whole map can be
// pushed off screen, which on a phone is unrecoverable without a landmark to steer back by.
const PAN_LIMIT = HALF_SPAN;

/**
 * Drag to pan, tap to pick.
 *
 * The camera was fixed on purpose — with the whole city in frame there is nothing to pan *to*, and
 * a pointerdown bound to dragging is exactly what fought tap-to-select in `city-lab`. A phone
 * breaks the premise: in portrait the frustum is sized by height, so the city runs off both sides
 * and half the fares spawn where you cannot see, let alone tap them.
 *
 * So panning is back, but gated on the slop above rather than on pointerdown, and it reports
 * whether the gesture became a drag so the picker can ignore the click that follows one. Callers
 * can pass `isEnabled` to disable panning on wide viewports where the whole city already fits —
 * kept as a live check so a resize re-enables it without a reload.
 *
 * `onPan` fires once per gesture, on the frame it crosses the slop. It is how the opening
 * follow-cam knows the player has taken the framing over — a swipe is the player saying they want
 * to look somewhere, and nothing should drag them back off it.
 */
export function attachDragPan(controller, domElement, getAspect, isEnabled = () => true,
  onPan = () => {}) {
  let drag = null;
  let panned = false;
  let clearPanned = null;

  function panBy(right, up) {
    // A finger on the map beats a pan already in flight. Cancelled here rather than from the
    // `onPan` handover callback so it holds for every caller of panBy, not just the drag that
    // happens to cross the slop.
    controller.cancelGlide();
    const target = controller.state.target;
    target.addScaledVector(RIGHT, right).addScaledVector(UP, up);
    target.x = THREE.MathUtils.clamp(target.x, -PAN_LIMIT, PAN_LIMIT);
    target.z = THREE.MathUtils.clamp(target.z, -PAN_LIMIT, PAN_LIMIT);
    controller.update(getAspect());
  }

  domElement.addEventListener('pointerdown', (event) => {
    // Single finger only. A second touch belongs to a pinch, and feeding it into the same
    // drag makes the map jump to wherever that finger landed.
    if (!event.isPrimary) return;
    if (!isEnabled()) return;
    clearTimeout(clearPanned);
    drag = { x: event.clientX, y: event.clientY, moved: 0 };
    panned = false;
    domElement.setPointerCapture(event.pointerId);
  });

  const release = () => {
    drag = null;
    // `panned` has to survive the click the browser synthesises right after this release — that's
    // the whole point, so a drag ending over a fare doesn't also route the taxi at it. But past that
    // one click it was only ever cleared by the *next* pointerdown on this element, and a tap that
    // lands somewhere else fixed on top of the canvas (the tutorial bubble, a rider-finder chip)
    // never sends this element one. That left `didPan()` reporting a swipe from minutes ago as
    // still in progress, and every later tap on those elements got silently read as the tail of a
    // drag and ignored — including the tap meant to dismiss the tutorial. Queued as a fresh task
    // rather than cleared here: pointerup -> click dispatch synchronously in the same task, so the
    // one click this is protecting still sees `panned` true; anything after that is a new tap.
    if (panned) clearPanned = setTimeout(() => { panned = false; }, 0);
  };
  domElement.addEventListener('pointerup', release);
  domElement.addEventListener('pointercancel', release);

  domElement.addEventListener('pointermove', (event) => {
    if (!drag || !event.isPrimary) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.moved += Math.hypot(dx, dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (drag.moved < PAN_SLOP) return;

    // First frame past the slop is the moment the gesture becomes a drag; `panned` is reset on
    // every pointerdown, so this is once per gesture rather than once per move event.
    if (!panned) onPan();
    panned = true;
    // World units per pixel falls straight out of the orthographic frustum: its height is
    // exactly 2 * zoom, whatever the aspect ratio. Vertical isn't drag-the-map: swipe up pans
    // the camera up (revealing what's above), swipe down pans it down — on a phone this reads
    // as "scroll to see more" rather than shoving the ground around.
    const scale = (controller.state.zoom * 2) / domElement.clientHeight;
    panBy(-dx * scale, dy * scale);
  });

  return {
    /**
     * True if the gesture that just ended was a drag. Stays true until the next pointerdown, which
     * is long enough to cover the `click` the browser synthesises after a mouse drag — a drag that
     * ends over a fare must not also route the taxi at it.
     */
    didPan: () => panned,
    panBy,
  };
}

/** Pan with WASD/arrows, zoom on the wheel. Pans along screen axes, not world axes. */
export function attachCameraControls(controller, domElement, getAspect) {
  const keys = new Set();
  const PAN_SPEED = 60;
  const MIN_ZOOM = 14;
  const MAX_ZOOM = 150;

  const onKey = (down) => (event) => {
    const code = event.code;
    if (!/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(code)) return;
    down ? keys.add(code) : keys.delete(code);
    if (code.startsWith('Arrow')) event.preventDefault();
  };

  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => keys.clear());

  domElement.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0012);
    controller.state.zoom = THREE.MathUtils.clamp(controller.state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    controller.update(getAspect());
  }, { passive: false });

  // Drag to pan, in the same screen-relative frame as the keys.
  let dragging = null;
  domElement.addEventListener('pointerdown', (event) => {
    dragging = { x: event.clientX, y: event.clientY };
    domElement.setPointerCapture(event.pointerId);
  });
  domElement.addEventListener('pointerup', () => { dragging = null; });
  domElement.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging = { x: event.clientX, y: event.clientY };

    const scale = (controller.state.zoom * 2) / domElement.clientHeight;
    panBy(-dx * scale, -dy * scale);
  });

  function panBy(right, up) {
    controller.state.target.addScaledVector(RIGHT, right);
    controller.state.target.addScaledVector(UP, up);
  }

  return function updateControls(dt) {
    let right = 0;
    let up = 0;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) up += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) up -= 1;

    if (right || up) {
      const speed = PAN_SPEED * dt * (controller.state.zoom / 46);
      panBy(right * speed, up * speed);
    }
    controller.update(getAspect());
  };
}
