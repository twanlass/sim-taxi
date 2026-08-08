import * as THREE from 'three';
import { createTaxiMesh } from '../geometry/taxi.js';
import { VIEW_DIR } from './camera.js';

// The opening tutorial. Two beats, because there are only two things a new player cannot work out
// by looking:
//
//   1. Which of the hundred cars down there is *theirs*. The bubble is spoken by the taxi — its
//      avatar is the car itself, turning — and the camera rides over to it while the line types.
//      Showing the car saying it does the job that a sentence naming it would not.
//   2. That a rider is a thing you tap. The camera pans to the first one on the kerb and the same
//      bubble says so, pointed at a figure that is now in the middle of the frame.
//
// Everything else in the game — the drop-off dispatching itself, the timer ring, Loco Mode — either
// happens without being asked for or is a pill with a label on it. None of it is taught here.
//
// The fare clocks are held while this runs (main.js calls `fares.setPaused`), so the tutorial never
// spends the 60 seconds the player is about to need. Nothing auto-advances: both beats wait for a
// tap, because a tutorial on a timer is one the slower reader loses.

// Both lines, in the order they are spoken. Kept together so the whole script is one thing to read.
const LINES = {
  taxi: "Let's pick up some rides and earn some cash.",
  rider: 'Tap this rider to pick them up.',
};

// Typing speed. ~38 chars/sec — fast enough that a reader is never waiting on the machine, slow
// enough that the line still arrives as speech rather than as a label appearing.
const TYPE_PER_CHAR = 0.026;
// A beat on sentence punctuation, so the line has a rhythm instead of a constant clatter.
const TYPE_PAUSE = 0.14;
const PAUSE_AFTER = new Set([',', '.', '!', '?']);

// Matches the exit transition in index.html. The element is only hidden once the scale-down has
// actually played — hiding it on the same frame would cut the animation the dismissal is for.
const CLOSE_MS = 220;

// A beat between the first bubble leaving and the camera setting off for the rider, so the two
// moves read as consecutive rather than as one interrupting the other.
const HANDOFF = 0.35;

// Gentler than the boost chase (3.2) and a touch firmer than the ambient opening follow (1.5): the
// bubble is talking about this car *now*, so it wants to be centred while the line is still typing,
// without the framing whipping across the city to get there.
const COACH_FOLLOW = 2.0;

// The avatar box, in CSS pixels — matches .coach-avatar in index.html.
const AVATAR_SIZE = 54;
// One turn every 5.5s. Quick enough to read as alive in the corner of a bubble you are reading,
// slow enough that the car is legible as a car at every angle.
const AVATAR_SPIN = (Math.PI * 2) / 5.5;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The rotating taxi in the bubble's avatar. Its own tiny WebGL context, the same way each
 * rider-finder chip owns one (see game/riderfinder.js) — the mesh is the real `createTaxiMesh`, so
 * the car in the bubble is the car on the road rather than a drawing of it, and it cannot drift out
 * of step when the taxi is restyled.
 *
 * @param sun   the city's own key light, read (not re-parented — an Object3D has one parent) so the
 *              avatar is lit by the same sun as the car it is a picture of
 * @param hemi  the city's hemisphere fill, same deal
 */
function createAvatar(sun, hemi) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(AVATAR_SIZE, AVATAR_SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // The city's own lighting rig, mirrored. Two lights with the same colours, intensities and — for
  // the sun — the same world position, which is all a directional light's direction depends on:
  // both scenes aim their sun at the origin, so copying the position copies the angle exactly. The
  // car in the bubble is then lit by golden hour like everything outside it, rather than by the
  // flat front-lit rig the rider chips use (right for a figure looking at you, wrong for the same
  // vehicle the player is looking down at).
  //
  // Mirrored per frame rather than cloned once, so a day/night cycle turned on from the ⚙️ panel
  // carries into the bubble instead of leaving it stranded at whatever hour it was built.
  const avatarSun = new THREE.DirectionalLight(sun.color.getHex(), sun.intensity);
  const avatarHemi = new THREE.HemisphereLight(hemi.color.getHex(), hemi.groundColor.getHex(),
    hemi.intensity);
  scene.add(avatarSun, avatarSun.target, avatarHemi);
  const syncLights = () => {
    avatarSun.position.copy(sun.position);
    avatarSun.color.copy(sun.color);
    avatarSun.intensity = sun.intensity;
    avatarHemi.color.copy(hemi.color);
    avatarHemi.groundColor.copy(hemi.groundColor);
    avatarHemi.intensity = hemi.intensity;
  };

  const taxi = createTaxiMesh();
  // The ghost outline needs `stencil: true`, which this renderer does not ask for — without the
  // buffer the stencil test passes everywhere and the "outline" fills the whole hull in solid
  // yellow. Nothing occludes the car in a 46px disc anyway, so both passes just go.
  taxi.group.traverse((node) => {
    if (node.name === 'ghostMask' || node.name === 'ghostRim') node.visible = false;
  });
  // Sign dark — the taxi is empty at the start of a run, and the avatar is a picture of the actual
  // car, not a logo. (It was lit for a while, back when this had a flat front-lit rig and the
  // cabin and sign merged into one dark block; the city's own raking sun separates them.)
  taxi.setOccupied(false);

  // Spun about a parent rather than about the mesh itself, so the taxi keeps whatever local
  // transform createTaxiMesh gave it (the 1.18 scale, the YXZ rotation order for roll).
  const pivot = new THREE.Group();
  pivot.add(taxi.group);
  scene.add(pivot);

  // Viewed down the game's own camera direction, so the silhouette in the bubble is the silhouette
  // on the road — which is the entire point of putting the car in the bubble.
  //
  // Framed on the cylinder the car sweeps as it turns, so nothing clips at any angle of the spin
  // rather than a bumper being sliced off twice a turn. Measured off the built mesh: visible
  // extents are ±2.36 long, ±1.49 wide and 3.02 tall, so the spin radius is hypot(2.36, 1.49) =
  // 2.79. This view's elevation is atan(0.92 / √2) = 33°, which puts the screen-space half-height
  // at 3.02·cos33/2 + 2.79·sin33 = 2.79 as well — the same number, so one square FIT covers both.
  // Fitting the bounding *sphere* instead (3.17) was the first go and left the car visibly adrift
  // in the middle of a 46px disc; the extra 10% is worth having at this size.
  //
  // Centred a little under the sweep's midpoint: only the roof sign reaches the top of that range
  // and only a broadside bumper reaches the sides, so the honest visual centre sits lower than the
  // geometric one.
  const CENTRE_Y = 1.0;
  const FIT = 2.9;               // 2.79 plus 4% air
  const camera = new THREE.OrthographicCamera(-FIT, FIT, FIT, -FIT, 0.1, 60);
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(VIEW_DIR, 20);
  camera.lookAt(0, CENTRE_Y, 0);

  // A parked angle for reduced motion: three-quarters on, which is the most car-shaped view of it.
  const stillAngle = Math.PI * 0.18;

  return {
    canvas,
    render(elapsed) {
      pivot.rotation.y = prefersReducedMotion() ? stillAngle : elapsed * AVATAR_SPIN;
      syncLights();
      renderer.render(scene, camera);
    },
    /** Hand the WebGL context back once the tutorial is over — it is never shown again. */
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  };
}

/**
 * The bubble itself: show a line, type it out, take a tap.
 *
 * A tap mid-type finishes the line rather than dismissing it — the standard convention, and the one
 * that stops an eager first tap throwing away a sentence nobody has read yet.
 */
function createBubble(root, { sun, hemi }, onDismiss) {
  const button = root.querySelector('.coach-bubble');
  const ghost = root.querySelector('.coach-ghost');
  const typed = root.querySelector('.coach-typed');
  const avatarSlot = root.querySelector('.coach-avatar');

  const avatar = createAvatar(sun, hemi);
  avatarSlot.appendChild(avatar.canvas);

  let text = '';
  let shown = 0;
  let charT = 0;
  let hold = 0;
  let closing = null;

  const isTyping = () => shown < text.length;
  const finishTyping = () => {
    shown = text.length;
    typed.textContent = text;
  };

  button.addEventListener('click', () => {
    if (!root.classList.contains('is-open')) return;
    if (isTyping()) { finishTyping(); return; }
    onDismiss();
  });

  return {
    avatar,
    show(line) {
      if (closing) { clearTimeout(closing); closing = null; }
      text = line;
      shown = 0;
      charT = 0;
      hold = 0;
      ghost.textContent = line;      // reserves the finished size; see index.html
      typed.textContent = '';
      root.hidden = false;
      root.classList.remove('is-closing');
      // One frame of the closed state before the open one, or the transition has nothing to run
      // from and the bubble simply appears. Same reflow trick as the money bump in main.js.
      void root.offsetWidth;
      root.classList.add('is-open');
      if (prefersReducedMotion()) finishTyping();
    },
    hide() {
      if (root.hidden || closing) return;
      root.classList.remove('is-open');
      root.classList.add('is-closing');
      closing = setTimeout(() => {
        root.hidden = true;
        root.classList.remove('is-closing');
        closing = null;
      }, CLOSE_MS);
    },
    /** Advance the typewriter and spin the avatar. `elapsed` is tutorial time, for the spin. */
    update(dt, elapsed) {
      if (!root.hidden) avatar.render(elapsed);
      if (root.hidden || !isTyping()) return;
      if (hold > 0) { hold -= dt; return; }
      charT += dt;
      while (charT >= TYPE_PER_CHAR && isTyping()) {
        charT -= TYPE_PER_CHAR;
        shown += 1;
        if (PAUSE_AFTER.has(text[shown - 1])) { hold = TYPE_PAUSE; break; }
      }
      typed.textContent = text.slice(0, shown);
    },
  };
}

// The lit pool, in world units — sized here rather than in pixels because 1 world unit is only
// ~7.7px at play zoom, so a pool measured in pixels would be a different size on every viewport.
// The taxi is ~4 units long and a rider stands about 3 tall, so 6 units of clean centre is "the
// subject and the kerb it stands on" and no more; the fade runs out over about half a block.
// Both were half again as wide at first, which lit most of a 5x5 city and made the pool read as
// general gloom rather than as a light pointed at one thing.
const POOL_CLEAR = 6;
const POOL_EDGE = 17;

/**
 * Wire the tutorial up.
 *
 * Every dependency is a callback rather than a module import, because this thing reaches across
 * four systems that have no business knowing about each other — the camera controller, the fare
 * board, the taxi and the scene's lighting — and the wiring is main.js's job.
 *
 * @param controller    the city camera (glideTo / followXZ / updateGlide)
 * @param aspect        () => number, the live viewport aspect
 * @param isNarrow      () => boolean; on a wide viewport the whole city is framed by default, so
 *                      the tutorial puts that framing back when it is done
 * @param taxi          the live taxi car object, read for its position each frame
 * @param lights        {sun, hemi} — the city's own rig, mirrored into the avatar
 * @param project       (x, y, z) => {x, y} — world to viewport pixels, for aiming the spotlight
 * @param pixelsPerUnit () => number — the camera's current scale, for sizing it
 * @param waitingFare   () => fare | null — whoever is on the kerb to point at
 * @param fareLocation  (fare) => {x, z} — the kerb corner to centre, not the junction
 * @param isDispatched  () => boolean — has the player sent the taxi at anyone yet
 * @param isOver        () => boolean — run ended under the tutorial (a wreck, say); drop everything
 * @param onRunning     (running: boolean) => void — fires on start and on dismissal; main.js holds
 *                      the fare clocks and the HUD's entrance between the two
 */
export function createTutorial({
  controller, aspect, isNarrow, taxi, lights, project, pixelsPerUnit,
  waitingFare, fareLocation, isDispatched, isOver = () => false, onRunning = () => {},
}) {
  const root = document.getElementById('coach');
  const idle = {
    state: { step: 'done' },
    update: () => {},
    frameCamera: () => false,
    holdsCamera: () => false,
    releaseCamera: () => {},
    dismiss: () => {},
  };
  if (!root) return idle;

  // 'taxi' → 'toRider' → 'rider' → 'restore' → 'done'. `restore` only exists on a wide viewport,
  // where nothing else would ever put the default whole-city framing back.
  const state = { step: 'taxi' };
  let elapsed = 0;
  let wait = 0;
  let panned = false;
  let cameraReleased = false;
  const home = { x: controller.state.target.x, z: controller.state.target.z };

  // Where the spotlight is pointed. The taxi while the first bubble is up, then the rider from the
  // moment the camera sets off for them — so the pool is already on the rider and the pan brings
  // the player to it, rather than the light snapping on after they arrive.
  const spotlight = document.getElementById('spotlight');
  let spotAt = null;              // {x, z} in world space, or null for "aim at the taxi"

  const bubble = createBubble(root, lights, () => dismiss());

  /** Aim and size the pool for this frame. Cheap — three custom properties on one div. */
  function updateSpotlight() {
    if (!spotlight) return;
    const at = spotAt ?? { x: taxi.x, z: taxi.z };
    // 1.4 up: the middle of a car's flank and about a rider's chest, so the pool is centred on the
    // subject rather than on the patch of road it is standing on.
    const p = project(at.x, 1.4, at.z);
    const px = pixelsPerUnit();
    spotlight.style.setProperty('--sx', `${p.x.toFixed(0)}px`);
    spotlight.style.setProperty('--sy', `${p.y.toFixed(0)}px`);
    spotlight.style.setProperty('--r0', `${(POOL_CLEAR * px).toFixed(0)}px`);
    spotlight.style.setProperty('--r1', `${(POOL_EDGE * px).toFixed(0)}px`);
  }

  function end() {
    if (state.step === 'done') return;
    state.step = 'done';
    bubble.hide();
    document.body.classList.remove('coach-open', 'spotlight-on');
    onRunning(false);
    // The context is no use to anyone once the bubble is gone for good. Held until the exit
    // animation has played — the avatar is still spinning through it.
    setTimeout(() => bubble.avatar.dispose(), CLOSE_MS + 50);
  }

  /** The player is done with the current beat: advance, or wind the whole thing up. */
  function dismiss() {
    if (state.step === 'taxi') {
      bubble.hide();
      state.step = 'toRider';
      wait = HANDOFF;
      return;
    }
    if (state.step === 'rider') finish();
  }

  /** Last beat answered (or skipped). Put the framing back on a desktop, then stop. */
  function finish() {
    if (state.step === 'restore' || state.step === 'done') return;
    bubble.hide();
    // The lights come up with the bubble's dismissal, not with the end of the restore glide —
    // holding the city dark through a camera move the player did not ask for reads as the tutorial
    // still having something to say.
    document.body.classList.remove('coach-open', 'spotlight-on');
    onRunning(false);
    if (!isNarrow() && !cameraReleased) {
      state.step = 'restore';
      controller.glideTo(home.x, home.z);
      return;
    }
    end();
  }

  document.body.classList.add('coach-open');
  updateSpotlight();                      // aim it before it fades up, or it blooms from the centre
  document.body.classList.add('spotlight-on');
  onRunning(true);
  bubble.show(LINES.taxi);

  function update(dt) {
    if (state.step === 'done') return;
    if (isOver()) { end(); return; }
    elapsed += dt;
    bubble.update(dt, elapsed);
    // Tracked through the restore glide too: the pool is fading out over ~0.45s and a stale centre
    // would slide it across the city as the camera moves under it.
    updateSpotlight();

    // The player found a rider and tapped them without waiting to be told — nothing stops them, and
    // they have just done the whole of beat two unprompted. Get out of the way rather than teaching
    // it back to them. Load-bearing beyond the manners: the fare clocks are held while this is
    // running, so a bubble left up over a taxi that is already driving a fare would freeze that
    // fare's countdown for the entire delivery.
    if (state.step !== 'restore' && isDispatched()) { finish(); return; }

    if (state.step === 'toRider') {
      if (wait > 0) { wait -= dt; return; }
      if (!panned) {
        const fare = waitingFare();
        if (!fare) return;              // board momentarily empty; wait for the next spawn
        const at = fareLocation(fare);
        controller.glideTo(at.x, at.z);
        // The pool moves to the rider now, with the camera, rather than when the bubble reappears
        // — so the light is already on them and the pan carries the player to it.
        spotAt = at;
        panned = true;
        return;
      }
      // Show the line once the camera has actually arrived, so the rider it is pointing at is on
      // screen when it starts talking about them.
      if (!controller.isGliding()) {
        state.step = 'rider';
        bubble.show(LINES.rider);
      }
      return;
    }

    // (Tapping the rider is the lesson, and landing it dismisses the bubble without needing a
    // second tap on the bubble itself — that is the `isDispatched` check at the top.)
    if (state.step === 'restore' && !controller.isGliding()) end();
  }

  return {
    state,
    update,
    /**
     * Frame this step. Called from main.js's camera priority list rather than from `update`, so a
     * wreck or a Loco Mode chase outranks the tutorial's framing instead of fighting it.
     */
    frameCamera(dt) {
      if (state.step === 'taxi') {
        controller.followXZ(taxi.x, taxi.z, dt, COACH_FOLLOW, aspect());
        return true;
      }
      return controller.updateGlide(dt, aspect());
    },
    holdsCamera: () => state.step !== 'done' && !cameraReleased,
    /**
     * The player has taken the framing over — a swipe. Give up the camera but keep talking: the
     * lesson is still worth reading, it just stops dragging the map around while they read it.
     */
    releaseCamera() { cameraReleased = true; },
    dismiss,
  };
}
