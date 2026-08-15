import * as THREE from 'three';
import { createTaxiMesh } from '../geometry/taxi.js';
import { mirrorSceneLights } from './avatarlights.js';
import { VIEW_DIR } from './camera.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// "Where did my car go?" — the button that answers it.
//
// The camera is the player's the moment they swipe (see `attachDragPan`), and it stays theirs: the
// opening follow-cam does not slide back onto the taxi, because a camera that fights a deliberate
// pan is worse than one that is occasionally pointed at nothing. The cost of that is real, though,
// and it is paid at exactly the wrong moment. On a phone the city is bigger than the frame, so a
// look across town — or a peek at a rider that the player then swiped away from — can leave the
// taxi entirely off-screen, and the only way back was to drag the map until the yellow car turned
// up. That is a hunt across near-identical blocks, on a clock that is draining, to find the one
// thing the player never stopped needing to see.
//
// So: while the taxi is **completely** off-frame, a chip of it fades in at the opposite end of the
// bottom row from the rider chips, and a tap rides the camera back to it. It is the same shape of
// affordance aimed the other way — the rider chips answer "who is waiting", this one answers "where
// am I".
//
// ## Only when the car is genuinely gone
//
// Not "mostly off", not "near the edge": the test is the whole silhouette outside the frame, the
// car's on-screen radius included, because a chip offering to find something the player can still
// see is a chip they learn to ignore. Two things keep it from flickering on that boundary — a few
// pixels of hysteresis, so a car tracking the frame edge doesn't toggle it, and a short dwell
// before it arrives, so a car that clips a corner for half a second never raises it at all.
//
// ## No ring, and nothing but the car
//
// A rider chip's ring is a clock, and this has no clock to show: the taxi is not going anywhere and
// nothing about it expires. What is left is the same dark disc with the real `createTaxiMesh` on
// it, lit by the city's own sun through `mirrorSceneLights` — the same rig the tutorial's avatar
// and the rider chips use, so the car in the corner is lit by the same afternoon as the one it is
// pointing at.
//
// It does **not** turn to the taxi's heading. Tempting, and wrong twice over: at 44px a yaw is
// noise rather than information, and three quarters of the compass puts the car's lit flank away
// from this camera (see the sun arithmetic on the parked angle below), so a heading-true chip would
// spend most of a run as a dark smudge. Which way to look is what the camera move itself answers.

/** Canvas edge, in CSS pixels. Inside the 49px disc — see `#taxi-finder` in index.html. */
const SIZE = 44;

// The car's on-screen radius, in world units: measured off the built mesh, whose visible extents
// are ±2.36 long and ±1.49 wide, so hypot(2.36, 1.49) = 2.79 covers it at every heading. Converted
// to pixels per frame, since the zoom can move under it (a wreck pulls the camera in).
const CAR_RADIUS = 2.79;
// Where on the car the off-screen test is taken: the middle of its flank rather than the road
// under it, so the radius above is measured about the centre of the shape it is standing in for.
const CAR_CENTRE_Y = 1.0;

// Hysteresis on the edge test, in pixels. Without it a taxi driving along the frame edge — which is
// exactly what a player who panned one block too far is looking at — sits on the boundary and
// blinks the chip on and off. The car has to clear the frame by this much to raise it; a single
// pixel of car back inside takes it down again.
const EDGE_SLACK = 14;

// How long the car has to stay gone before the chip appears. A frame or two off-screen is a car
// crossing a corner of the view, not a car that is lost, and the answer to that one arrives on its
// own. Long enough to swallow those; short enough that a player who has genuinely lost the taxi
// isn't waiting on the HUD to agree with them.
const SHOW_DELAY = 0.4;

/**
 * The city's view direction with its azimuth squared up — the game camera's own 33° elevation,
 * looking down +Z. The same construction as the tutorial's avatar (game/tutorial.js), and for the
 * same reason: at the hour the game parks at the sun sits at azimuth 153°, so a camera left on the
 * city's own +X +Z diagonal sees only faces at n·L = −0.78 and the car comes out half black.
 */
const CHIP_VIEW = new THREE.Vector3(0, VIEW_DIR.y, Math.hypot(VIEW_DIR.x, VIEW_DIR.z)).normalize();

// The parked pose: a front three-quarter, nose toward the viewer, which is both the most car-shaped
// view of it and the best-lit one. The car is built along X, so at rotation r its flank normal is
// (sin r, cos r): facing this camera wants cos r > 0, and catching the sun at (−0.78, +0.40) wants
// −0.78·sin r + 0.40·cos r > 0, i.e. r < 27°. −45° sits well inside both, at 0.84 of full sun. The
// tutorial's still avatar is parked at the same angle off the same arithmetic.
const CHIP_YAW = -Math.PI / 4;

// Framing, measured off the mesh rather than guessed. At this yaw the car's extreme corner is
// 2.36·cos45 + 1.49·sin45 = 2.72 units from centre, and its screen half-height is
// 3.02·cos33/2 + 2.72·sin33 = 2.75 — near enough the same number, so one square frustum covers
// both. Centred a little under the geometric middle: only the roof sign reaches the top of that
// range, so the honest visual centre sits lower.
const CENTRE_Y = 1.0;
const FIT = 2.85;

/**
 * Is the car's whole silhouette outside the frame?
 *
 * `x`/`y` are its centre in viewport pixels, `radius` its on-screen radius and `w`/`h` the frame the
 * renderer actually draws. `wasOff` is the last answer, which is what makes this hysteretic: a car
 * has to clear the edge by `EDGE_SLACK` to *become* hidden, and only has to put a pixel back inside
 * the frame to stop being hidden. Deliberately not the safe-area insets — the canvas draws under
 * the status bar and the home indicator, so a car up there is on screen even if the hardware is
 * sitting on top of it, and the arrow in `dropoffindicator.js` reads those because it is placing a
 * thing on the HUD rather than asking whether the player can see one.
 *
 * Exported so `tools/probe.mjs` can walk the boundary without a browser.
 */
export function isCarOffScreen(x, y, radius, w, h, wasOff) {
  const pad = wasOff ? radius : radius + EDGE_SLACK;
  return x < -pad || x > w + pad || y < -pad || y > h + pad;
}

/**
 * @param project       (x, y, z) => {x, y} in viewport pixels — main.js's `projectToScreen`
 * @param frame         the viewport the renderer draws to (`util/viewport.js`), not `window.inner*`
 * @param pixelsPerUnit () => px per world unit, so the car's radius survives a zoom change
 * @param sun / hemi    the city's own lights, read rather than re-parented (an Object3D has one
 *                      parent) so the car in the chip is lit by the afternoon it is a picture of
 * @param onTap         what a press does — main.js rides the camera back to the taxi
 */
export function createTaxiFinder({ project, frame, pixelsPerUnit, sun, hemi, onTap }) {
  const button = document.getElementById('taxi-finder');
  if (!button) return { update: () => {}, render: () => {}, isUp: () => false };

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  button.appendChild(canvas);

  // One more WebGL context, honouring the same budget flags the main renderer does — see
  // `util/shot.js`. Not for its own cost, which is a 44px disc, but because `?safe` is asking a
  // device "what will you render at all" and every context this page opens is part of that answer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  const taxi = createTaxiMesh();
  // The ghost outline needs `stencil: true`, which this renderer does not ask for — without the
  // buffer the stencil test passes everywhere and the "outline" fills the whole hull in solid
  // yellow. Nothing occludes the car in a 44px disc anyway, so both passes just go.
  taxi.group.traverse((node) => {
    if (node.name === 'ghostMask' || node.name === 'ghostRim') node.visible = false;
  });
  // Sign lit, the same as the tutorial's avatar: nothing here reads it for occupancy, and the
  // off-white is the one bright mark on a roof that is otherwise a dark cabin block — it is what
  // makes the shape say "taxi" at this size.
  taxi.setOccupied(true);

  // Turned about a parent rather than about the mesh itself, so the taxi keeps whatever local
  // transform `createTaxiMesh` gave it (the 1.18 scale, the YXZ rotation order for roll).
  const pivot = new THREE.Group();
  pivot.rotation.y = CHIP_YAW;
  pivot.add(taxi.group);
  scene.add(pivot);

  const camera = new THREE.OrthographicCamera(-FIT, FIT, FIT, -FIT, 0.1, 60);
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(CHIP_VIEW, 20);
  camera.lookAt(0, CENTRE_Y, 0);

  let off = false;          // the edge test's own state, which it needs for its hysteresis
  let dwell = 0;            // how long the car has been gone, against SHOW_DELAY
  let up = false;           // is the chip on screen

  button.addEventListener('click', () => { if (up && onTap) onTap(); });

  function setUp(next) {
    if (up === next) return;
    up = next;
    button.classList.toggle('is-on', next);
    button.setAttribute('aria-hidden', String(!next));
    // `disabled` as well as the CSS `pointer-events: none`, because the two cover different
    // pointers: the style stops a thumb landing on an invisible button, and this keeps a chip that
    // is not offering itself out of the tab order — a focusable control inside `aria-hidden` is a
    // control a keyboard can reach and a screen reader cannot describe.
    button.disabled = !next;
  }
  // No initial `setUp(false)`: the markup ships down — `aria-hidden` and `disabled` are on the
  // element in index.html — so the chip is already in this state before the module reaches it, and
  // a call here would be a no-op against `up`'s own starting value anyway.

  /**
   * @param taxiCar the player's car
   * @param armed   false whenever something else already has the framing in hand — the run is over,
   *                the tutorial is pointing at the city, or a pan is in flight (including this
   *                chip's own, which is what takes it down on the tap). The chip drops immediately
   *                rather than fading behind them, and the dwell resets, so it has to earn its way
   *                back afterwards.
   */
  function update(dt, taxiCar, armed = true) {
    if (!armed || !taxiCar) {
      off = false;
      dwell = 0;
      setUp(false);
      return;
    }

    const p = project(taxiCar.x, CAR_CENTRE_Y, taxiCar.z);
    off = isCarOffScreen(p.x, p.y, CAR_RADIUS * pixelsPerUnit(), frame.width(), frame.height(), off);
    dwell = off ? dwell + dt : 0;
    setUp(dwell >= SHOW_DELAY);

    // A chip on its way *out* is not redrawn — the canvas keeps its last composited frame through
    // the CSS fade, the same way the cargo chip's does.
    if (up) render();
  }

  /**
   * Draw. Nothing in this scene moves, but the lights are re-synced every time: the ⚙️ panel's
   * day/night cycle is live, and a chip stranded at the hour it was built would be the one car on
   * screen lit by a different afternoon. Cheap — two colour copies and a 44px draw.
   *
   * Exposed as well as called from `update` so `tools/smoke.mjs` can draw and read the canvas back
   * inside one task: the renderer does not preserve its drawing buffer, so a readback split across
   * two CDP round-trips reads an empty one.
   */
  function render() {
    syncLights();
    renderer.render(scene, camera);
  }

  return {
    update,
    render,
    /** Whether the chip is currently offering itself — for `tools/smoke.mjs`. */
    isUp: () => up,
  };
}
