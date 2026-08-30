import * as THREE from 'three';
import { createTaxiMesh } from '../geometry/taxi.js';
import { createPerson } from '../geometry/person.js';
import { mirrorSceneLights } from './avatarlights.js';
import { VIEW_DIR } from './camera.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// The opening tutorial. Two things a new player cannot work out by looking:
//
//   1. Which of the hundred cars down there is *theirs*. **This beat is currently switched off** —
//      see `TAXI_BEAT` below. The opening vignette answers it by showing the player's own garage
//      door open and their own car drive out of it, which is a better answer than a sentence, and
//      it gets the run to its first instruction a beat sooner.
//   2. That a rider is a thing you tap. The camera pans to the first one on the kerb and the
//      bubble says so, pointed at a figure that is now in the middle of the frame.
//
// Everything else in the game — the drop-off dispatching itself, the timer ring, Loco Mode — either
// happens without being asked for or is a pill with a label on it. None of it is taught here.
//
// It runs at the top of **every** run. Remembering it across loads was tried — a `localStorage`
// flag, on the grounds that play-again is a `location.reload()` and a lesson learned once should
// not be charged for on every retry — and taken back out: the opening is a tap long, the clocks
// are held through it, and between it and the vignette it is the whole of how a player is shown
// which car is theirs. Someone back after a week gets that for free rather than hunting for it.
//
// The fare clocks are held while this runs (main.js calls `fares.setPaused`), so the tutorial never
// spends the clock the player is about to need. That matters more than it did when every rider got
// a flat sixty seconds: a clock is budgeted from the driving its own trip costs now
// (see difficulty.md), so what a lesson would eat is margin that was calculated for driving.
// Nothing auto-advances: every gated beat waits for a tap, because a tutorial on a timer is one the
// slower reader loses.

// Whether the first beat runs at all. **Off**, and the opening vignette is why: the one thing a new
// player cannot work out by looking is which of the hundred cars down there is theirs, and a bubble
// saying so was the cheapest way to answer it — until the run started by showing the player's own
// garage door open and their own car drive out of it. That answers it better than a sentence can,
// so the bubble is now the second time they are told, and the run gets to its first instruction a
// beat sooner. See docs/gameplay.md#the-opening-vignette.
//
// A flag rather than a deletion: the beat is intact behind it (`openOnTaxi`, `LINES.taxi`, the
// 'taxi' step in both step sets), because the vignette is a prototype and this is the thing that
// has to come back if it goes.
const TAXI_BEAT = false;

// Every line, in the order it is spoken. Kept together so the whole script is one thing to read.
const LINES = {
  taxi: "Let's pick up some rides and earn some cash.",
  rider: 'Tap rider to start.',
  boost: 'Hold to floor it',
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

// A beat between the city finishing its entrance and the tutorial saying anything. This was a
// full second of static city back when a run opened on one — the beat existed to establish that
// there is a place here before the lights came down. The entrance animation now does that job
// with three-plus seconds of the city building itself (main.js holds this whole module frozen
// behind `isBlocked` until the wave lands), so all that is needed after it is a breath: long
// enough that the last building settling and the lights dimming read as two events, short enough
// that the tutorial still feels triggered by the entrance ending. The clocks are already held, so
// it costs nothing.
const OPENING_HOLD = 0.25;

// A beat between the first bubble leaving and the camera setting off for the rider, so the two
// moves read as consecutive rather than as one interrupting the other.
const HANDOFF = 0.35;

// The third beat lands a beat after the player's **first drop-off** — the moment the loop has
// closed once and they know what the job is. Told any earlier and Loco Mode is a fourth new thing
// arriving while they are still working out the first three; told here it answers a question they
// have just earned ("that took a while — can I go faster?").
//
// It was a fraction of the trip at first — half way to the pickup, measured along the road driven.
// That is a better *description* of a moment, and it was unpredictable in practice: trip lengths
// vary by a factor of five, so the hint arrived anywhere between three seconds and half a minute in.
// Then it was a fixed three seconds off the tap that sent the taxi at the first rider, which is
// predictable but lands mid-pickup, with the player watching the car and the fare's clock draining.
// Two seconds off the drop-off is both: a fixed delay, hung on the one beat in a run where nothing
// else is being asked of the player.
const BOOST_HINT_DELAY = 2;
// Unlike the first two, this beat gates nothing — the run is live and the clocks are running, so it
// cannot sit there until it is tapped. Long enough to read twice after the line lands.
const BOOST_HINT_LINGER = 6;

// Gentler than the boost chase (3.2) and a touch firmer than the ambient opening follow (1.5): the
// bubble is talking about this car *now*, so it wants to be centred while the line is still typing,
// without the framing whipping across the city to get there.
const COACH_FOLLOW = 2.0;

// The avatar box, in CSS pixels — matches .coach-avatar in index.html.
const AVATAR_SIZE = 54;
// One turn every 5.5s. Quick enough to read as alive in the corner of a bubble you are reading,
// slow enough that the car is legible as a car at every angle.
const AVATAR_SPIN = (Math.PI * 2) / 5.5;

// Where the taxi avatar is viewed from: the game camera's elevation, on the rider avatar's azimuth.
// Derived from VIEW_DIR rather than written out, so the two stay the same height above the ground
// if the city's camera is ever re-pitched — the framing below is computed from that angle. See the
// note on the camera itself for why the azimuth is the one thing that moves.
const AVATAR_VIEW = new THREE.Vector3(0, VIEW_DIR.y, Math.hypot(VIEW_DIR.x, VIEW_DIR.z)).normalize();

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The rotating taxi (and, for the second beat, the waving rider) in the bubble's avatar. Its own
 * tiny WebGL context, the same way each rider-finder chip owns one (see game/riderfinder.js) — the
 * meshes are the real `createTaxiMesh` / `createPerson`, so the figure in the bubble is the one on
 * the road rather than a drawing of it, and it cannot drift out of step when either is restyled.
 *
 * Two subjects share the one canvas — a taxi scene/camera and a rider scene/camera — and `render`
 * picks one by name each frame rather than keeping two contexts alive. Both get the game's own sun
 * and hemisphere fill, mirrored in (see `mirrorSceneLights`, shared with the rider-finder chips):
 * the bubble is a window onto this city, not a studio shot, so whichever figure is standing in it
 * should be lit by the same afternoon.
 *
 * @param sun   the city's own key light, read (not re-parented — an Object3D has one parent) so the
 *              avatar is lit by the same sun as the car it is a picture of
 * @param hemi  the city's hemisphere fill, same deal
 */
function createAvatar(sun, hemi) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;

  // A second WebGL context, and it honours the same budget flags the main renderer does — see
  // `util/shot.js`. Not for its own cost, which is a 46px disc, but because `?safe` is asking a
  // device "what will you render at all", and a context this page opened is part of the answer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(AVATAR_SIZE, AVATAR_SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();

  // The city's own lighting rig, mirrored into both scenes below (taxi and rider alike) via
  // `mirrorSceneLights` — shared with the rider-finder chips, so nothing pictured out of this city
  // is ever lit by a different afternoon than the one on screen.
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  const taxi = createTaxiMesh();
  // The ghost outline needs `stencil: true`, which this renderer does not ask for — without the
  // buffer the stencil test passes everywhere and the "outline" fills the whole hull in solid
  // yellow. Nothing occludes the car in a 46px disc anyway, so both passes just go.
  taxi.group.traverse((node) => {
    if (node.name === 'ghostMask' || node.name === 'ghostRim') node.visible = false;
  });
  // Sign lit. It was dark for a while on the grounds that the taxi is empty at the start of a run
  // and the avatar is a picture of the actual car rather than a logo — but the avatar is the only
  // place in the game where the sign is a *portrait* detail rather than a readout, nothing reads it
  // for occupancy here, and the lit off-white is the one bright mark on a roof that is otherwise a
  // dark cabin block. It is what makes the shape say "taxi" at 54px.
  taxi.setOccupied(true);

  // Spun about a parent rather than about the mesh itself, so the taxi keeps whatever local
  // transform createTaxiMesh gave it (the 1.18 scale, the YXZ rotation order for roll).
  const pivot = new THREE.Group();
  pivot.add(taxi.group);
  scene.add(pivot);

  // Viewed at the game camera's own elevation, so the silhouette in the bubble is the silhouette on
  // the road — which is the entire point of putting the car in the bubble — but turned 45° around
  // to the sunlit side.
  //
  // It looked straight down VIEW_DIR at first, azimuth and all, and the car came out half black.
  // The lights here are the city's own (mirrored above), and at the hour the game parks at the sun
  // sits at azimuth 153°, elevation 28.5° — a horizontal direction of (−0.78, +0.40) in (x, z). A
  // camera on +X +Z sees the +X faces, and those sit at n·L = −0.78: unlit at every angle of the
  // spin, so one whole flank of the car was in shadow through the entire turn while the bubble it
  // sits in is white. Turned to +Z the camera-facing flank is at +0.40 instead, and only the
  // quadrant past 27° off the axis falls into shadow — 65% of the visible sweep is lit rather than
  // 40%.
  //
  // +Z is not an arbitrary quarter turn: it is the azimuth the rider's camera below already uses
  // (and the rider-finder chips with it), so both bubbles now stand in the same afternoon at the
  // same angle to it rather than one facing the sun and one facing away.
  //
  // The azimuth is free to move because the car is *spinning*: turning the camera around the Y axis
  // only offsets the phase of the spin, so every silhouette that used to come round still does. The
  // elevation is what the framing below is derived from, and that is untouched.
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
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(AVATAR_VIEW, 20);
  camera.lookAt(0, CENTRE_Y, 0);

  // A parked angle for reduced motion: three-quarters on, which is the most car-shaped view of it —
  // and, since this one never turns away from it, the best-lit three-quarter rather than any.
  //
  // The car is built along X (CAR_LEN), so at rotation r its flank normal is (sin r, cos r) in
  // (x, z). Facing the camera on +Z wants cos r > 0; catching the sun at (−0.78, +0.40) wants
  // −0.78·sin r + 0.40·cos r > 0, i.e. r < 27°. −45° sits well inside both: the flank is at 45° to
  // the camera (a front three-quarter, nose toward the viewer) and at 0.84 of full sun.
  //
  // The old +32° was a three-quarter to the old camera and lit at −0.08 — the one pose a player who
  // asked for less motion would sit and look at, and it was the shadowed side of the car.
  const stillAngle = -Math.PI / 4;

  // The rider: same city sun/hemi as the taxi above, its own synced copy (an Object3D has one
  // parent, so the taxi's lights can't simply be re-added here) — a figure in a tutorial bubble is
  // being introduced as *part of this city*, so it should be lit by the same afternoon rather than
  // by a studio light of its own.
  const riderScene = new THREE.Scene();
  const syncRiderLights = mirrorSceneLights(riderScene, sun, hemi);
  const person = createPerson();
  riderScene.add(person.group);
  // `createPerson`'s torso is thin on Z and wide on X (shoulders either side, chest facing along
  // Z — see `board()`'s "local +Z is treated as forward"), so the camera sits on +Z to look at the
  // figure head-on. Same ortho frustum, distance and elevation as the rider-finder chip's camera
  // (game/riderfinder.js) — just turned from +X to face front.
  const riderCamera = new THREE.OrthographicCamera(-2.2, 2.2, 2.7, -1.5, 0.1, 40);
  riderCamera.position.set(0, 3.2, 4.9);
  riderCamera.lookAt(0, 1.55, 0);

  // Reduced motion freezes the wave mid-raise (t=0 in `wave`) rather than at rest — a still figure
  // with its arm down would no longer read as "hailing" at all.
  const stillWaveT = 0;

  return {
    canvas,
    /** `subject` is 'taxi' (default) or 'rider' — which scene this frame renders. */
    render(elapsed, subject) {
      if (subject === 'rider') {
        person.wave(prefersReducedMotion() ? stillWaveT : elapsed);
        syncRiderLights();
        renderer.render(riderScene, riderCamera);
        return;
      }
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
 *
 * The tap does not have to land on the bubble; see the window listener in createTutorial. Which is
 * why `tap()` is a method rather than a click handler bound in here.
 */
function createBubble(root, { sun, hemi }, onDismiss) {
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
  let subject = 'taxi';

  const isTyping = () => shown < text.length;
  const finishTyping = () => {
    shown = text.length;
    typed.textContent = text;
  };

  return {
    avatar,
    isTyping,
    /**
     * Advance. Returns false if there was nothing up to advance, so the caller can tell a tap that
     * did something from one that fell through to the game underneath.
     */
    tap() {
      if (root.hidden || !root.classList.contains('is-open')) return false;
      if (isTyping()) { finishTyping(); return true; }
      onDismiss();
      return true;
    },
    /** `who` is 'taxi' (default) or 'rider' — which avatar the bubble shows while this line is up. */
    show(line, who = 'taxi') {
      if (closing) { clearTimeout(closing); closing = null; }
      subject = who;
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
    /** Advance the typewriter and animate the avatar. `elapsed` is tutorial time, for the spin/wave. */
    update(dt, elapsed) {
      if (!root.hidden) avatar.render(elapsed, subject);
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
// The pool around the Loco Mode pill runs out to this multiple of its clear radius. Wider in
// proportion than the world one, because it sits in a screen corner: half the falloff is off the
// edge of the glass, so a ratio that looks right in the middle of the city reads as a hard-edged
// disc down there.
const BUTTON_POOL_FALLOFF = 2.8;

// The steps that own the camera, and the steps that are a bubble waiting to be answered. Everything
// after the second dismissal is neither: the run is live, the player is driving, and the third beat
// is a note in the corner rather than something standing in front of the game.
const CAMERA_STEPS = new Set(['wait', 'taxi', 'toRider', 'rider', 'restore']);
const GATED_STEPS = new Set(['wait', 'taxi', 'toRider', 'rider']);

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
 * @param boostAnchor   () => {x, y, r} | null — the Loco Mode pill's centre and radius in viewport
 *                      pixels, for the third beat's spotlight
 * @param waitingFare   () => fare | null — whoever is on the kerb to point at
 * @param fareLocation  (fare) => {x, z} — the kerb corner to centre, not the junction
 * @param isDispatched  () => boolean — has the player sent the taxi at anyone yet
 * @param hasDelivered  () => boolean — has a rider been dropped off yet; the third beat's countdown
 *                      runs off this, so the Loco Mode hint lands once the loop has closed one turn
 * @param boostUsed     () => boolean — has Loco Mode been fired at least once; if so the third beat
 *                      never appears, because it would be explaining something already discovered
 * @param isOver        () => boolean — run ended under the tutorial (a wreck, say); drop everything
 * @param isBlocked     () => boolean — something else is holding the run in front of this, so say
 *                      nothing and take no taps until it lets go
 * @param shouldIgnoreTap () => boolean — true for the click that closes out a camera drag, so a
 *                      swipe does not also dismiss the bubble it dragged past
 * @param onRunning     (running: boolean) => void — fires on start and on the *second* dismissal;
 *                      main.js holds the fare clocks and the HUD's entrance between the two. The
 *                      third beat is deliberately outside it — the run is live by then.
 */
export function createTutorial({
  controller, aspect, isNarrow, taxi, lights, project, pixelsPerUnit, boostAnchor = () => null,
  waitingFare, fareLocation, isDispatched, hasDelivered = () => false, boostUsed = () => false,
  isOver = () => false, isBlocked = () => false, shouldIgnoreTap = () => false,
  onRunning = () => {},
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

  // 'wait' → 'taxi' → 'toRider' → 'rider' → 'restore' → 'toBoost' → 'boost' → 'done'. `wait` is the
  // beat of city before the first bubble; `restore` only exists on a wide viewport, where nothing
  // else would ever put the default whole-city framing back; `toBoost` is the whole first fare —
  // pickup, drive and drop-off — with nothing on screen.
  const state = { step: 'wait' };
  // The third beat's countdown, and how long it stays once it lands.
  let boostWait = 0;
  let linger = 0;
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

  /**
   * Aim and size the pool for this frame. Cheap — four custom properties on one div.
   *
   * Two kinds of subject. The first two beats point at something in the city, so the pool is
   * anchored in world space and sized in world units. The third points at a *control*, which is a
   * fixed thing on the glass at a size that has nothing to do with the camera — so it is measured
   * off the pill's own box instead. Sizing that one in world units would grow and shrink the pool
   * around a button that never moved.
   */
  function updateSpotlight() {
    if (!spotlight) return;
    let at;
    if (state.step === 'boost') {
      const pill = boostAnchor();
      if (!pill) return;
      at = { x: pill.x, y: pill.y, r0: pill.r, r1: pill.r * BUTTON_POOL_FALLOFF };
    } else {
      const world = spotAt ?? { x: taxi.x, z: taxi.z };
      // 1.4 up: the middle of a car's flank and about a rider's chest, so the pool is centred on
      // the subject rather than on the patch of road it is standing on.
      const p = project(world.x, 1.4, world.z);
      const px = pixelsPerUnit();
      at = { x: p.x, y: p.y, r0: POOL_CLEAR * px, r1: POOL_EDGE * px };
    }
    spotlight.style.setProperty('--sx', `${at.x.toFixed(0)}px`);
    spotlight.style.setProperty('--sy', `${at.y.toFixed(0)}px`);
    spotlight.style.setProperty('--r0', `${at.r0.toFixed(0)}px`);
    spotlight.style.setProperty('--r1', `${at.r1.toFixed(0)}px`);
  }

  function end() {
    if (state.step === 'done') return;
    state.step = 'done';
    bubble.hide();
    document.body.classList.remove('coach-open', 'spotlight-on', 'coach-boost');
    root.classList.remove('at-boost');
    window.removeEventListener('click', onTap);
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
    if (state.step === 'rider') { finish(); return; }
    if (state.step === 'boost') end();
  }

  /**
   * Second beat answered (or skipped). This is where the tutorial stops standing in front of the
   * game: the clocks start, the HUD slides in, and the framing goes back where it was on a desktop.
   * What is left after it — the whole first fare, and the boost hint a beat after it is delivered —
   * happens alongside a live run rather than instead of one.
   */
  function finish() {
    if (!GATED_STEPS.has(state.step)) return;
    bubble.hide();
    // The lights come up with the bubble's dismissal, not with the end of the restore glide —
    // holding the city dark through a camera move the player did not ask for reads as the tutorial
    // still having something to say.
    document.body.classList.remove('coach-open', 'spotlight-on');
    onRunning(false);
    boostWait = BOOST_HINT_DELAY;
    if (!isNarrow() && !cameraReleased) {
      state.step = 'restore';
      controller.glideTo(home.x, home.z);
      return;
    }
    state.step = 'toBoost';
  }

  /** Third beat: the Loco Mode pill, called out while the player watches the taxi drive itself. */
  function showBoostHint() {
    state.step = 'boost';
    linger = BOOST_HINT_LINGER;
    // Pulses the pill itself, so the bubble is not the only thing saying which control it means.
    document.body.classList.add('coach-boost');
    // Sits higher than the first two beats — see #coach.at-boost. The rider chips are live now.
    root.classList.add('at-boost');
    // Same treatment the taxi and the rider got. `state.step` is already 'boost', so this picks up
    // the pill's box rather than the last world subject — aim before the fade, or it blooms from
    // wherever the previous beat left it.
    updateSpotlight();
    document.body.classList.add('spotlight-on');
    bubble.show(LINES.boost);
  }

  // One handler for the whole screen, not a click on the bubble: a tap anywhere advances. It stays
  // on `window` rather than an overlay so the tap still reaches the city underneath — on the second
  // beat the whole lesson is the tap landing on the rider, and a full-screen catcher would eat the
  // one gesture being taught. `shouldIgnoreTap` is the same guard the picker uses, so a swipe that
  // dragged the map does not also count as an answer.
  // `isBlocked` matters as much as the pan guard here: the Home Screen screen is a full-bleed
  // overlay above this one that waits to be tapped, and the tap that dismisses *it* would otherwise
  // bubble straight through and burn a beat the player never saw.
  const onTap = () => { if (!shouldIgnoreTap() && !isBlocked()) bubble.tap(); };
  window.addEventListener('click', onTap);

  /**
   * Lights down, first line up.
   *
   * **Currently switched off** — see `TAXI_BEAT` above. Kept whole rather than deleted, because
   * what turns it back on is one flag and the argument for it may well come back.
   */
  function openOnTaxi() {
    state.step = 'taxi';
    updateSpotlight();                    // aim it before it fades up, or it blooms from the centre
    document.body.classList.add('spotlight-on');
    bubble.show(LINES.taxi);
  }

  /** Straight to the second beat: no line, just the pan setting off for the rider. */
  function openOnRider() {
    state.step = 'toRider';
    wait = 0;
  }

  // The clocks are held and the chips are hidden from frame one, even though nothing is on screen
  // yet — the opening beat is part of the tutorial, and the player should not be paying for it.
  document.body.classList.add('coach-open');
  onRunning(true);
  wait = OPENING_HOLD;

  function update(dt) {
    if (state.step === 'done') return;
    if (isOver()) { end(); return; }
    // Something else is holding the run in front of this — on iOS in a tab, the "Add to Home
    // Screen" screen (game/homescreen.js), which sits above this one and parks the fare loop until
    // it is tapped. Freeze rather than run behind it: the opening hold would tick away unseen, the
    // spotlight would darken a city nobody is looking at, and the first line would type itself out
    // underneath an overlay. The clocks are already held from both sides, so nothing is lost.
    if (isBlocked()) return;
    elapsed += dt;
    bubble.update(dt, elapsed);
    // Tracked through the restore glide too: the pool is fading out over ~0.45s and a stale centre
    // would slide it across the city as the camera moves under it.
    updateSpotlight();

    // Ahead of the opening hold as well as the bubbles: a player quick enough to grab a rider
    // inside the first second should not then be shown a bubble that immediately dismisses itself.
    if (GATED_STEPS.has(state.step) && isDispatched()) { finish(); return; }

    if (state.step === 'wait') {
      wait -= dt;
      // The camera is already easing onto the taxi through this — it is the one thing that should
      // be under way before the bubble speaks, so the car is framed by the time it does.
      if (wait <= 0) (TAXI_BEAT ? openOnTaxi : openOnRider)();
      return;
    }

    // (The guard above is also what handles a player who found a rider and tapped them without
    // waiting to be told — they have just done the whole of beat two unprompted, so the tutorial
    // gets out of the way rather than teaching it back to them. Load-bearing beyond the manners:
    // the fare clocks are held through the gated beats, so a bubble left up over a taxi that is
    // already driving a fare would freeze that fare's countdown for the entire delivery.)

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
        // And this beat is what *lights* it. `spotlight-on` used to go on in `openOnTaxi` alone,
        // which stopped happening the day TAXI_BEAT was switched off: the pool was aimed at the
        // rider every frame from here, sized correctly, and left at opacity 0 for the whole
        // tutorial. The one instruction a run still gives was pointing at a figure in an undimmed
        // city. Anything that turns the light on has to aim it first (same as `showBoostHint`),
        // or the fade-up blooms from wherever the previous subject left the centre — the taxi,
        // half a city away.
        updateSpotlight();
        document.body.classList.add('spotlight-on');
        panned = true;
        return;
      }
      // Show the line once the camera has actually arrived, so the rider it is pointing at is on
      // screen when it starts talking about them.
      if (!controller.isGliding()) {
        state.step = 'rider';
        bubble.show(LINES.rider, 'rider');
      }
      return;
    }

    // (Tapping the rider is the lesson, and landing it dismisses the bubble without needing a
    // second tap on the bubble itself — that is the `isDispatched` check at the top.)
    if (state.step === 'restore' && !controller.isGliding()) state.step = 'toBoost';

    // The countdown starts at the first drop-off and nowhere earlier, so a player who never
    // completes one is never told about Loco Mode — there is no point selling a way to drive faster
    // to someone who has not yet done the driving. Ticked through `restore` as well as `toBoost`
    // because on a desktop the restore glide can still be running when the delivery lands.
    if (boostWait > 0 && hasDelivered()
      && (state.step === 'restore' || state.step === 'toBoost')) boostWait -= dt;

    if (state.step === 'toBoost') {
      if (boostWait > 0 || !hasDelivered()) return;
      // Already discovered it. Nothing to say, so the tutorial simply stops rather than explaining
      // a control the player is mid-way through using.
      if (boostUsed()) { end(); return; }
      showBoostHint();
      return;
    }

    // Nothing is waiting on this one — the run is live and the clocks are running — so it times
    // itself out rather than sitting over the road until someone taps it.
    if (state.step === 'boost' && !bubble.isTyping()) {
      linger -= dt;
      if (linger <= 0) end();
    }
  }

  return {
    state,
    update,
    /**
     * Frame this step. Called from main.js's camera priority list rather than from `update`, so a
     * wreck or a Loco Mode chase outranks the tutorial's framing instead of fighting it.
     */
    frameCamera(dt) {
      if (state.step === 'wait' || state.step === 'taxi') {
        controller.followXZ(taxi.x, taxi.z, dt, COACH_FOLLOW, aspect());
        return true;
      }
      return controller.updateGlide(dt, aspect());
    },
    holdsCamera: () => CAMERA_STEPS.has(state.step) && !cameraReleased,
    /**
     * The player has taken the framing over — a swipe. Give up the camera but keep talking: the
     * lesson is still worth reading, it just stops dragging the map around while they read it.
     */
    releaseCamera() { cameraReleased = true; },
    dismiss,
  };
}
