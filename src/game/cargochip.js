import * as THREE from 'three';
import { createParcel } from '../geometry/parcel.js';
import { mirrorSceneLights } from './avatarlights.js';
import { VIEW_DIR } from './camera.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// The courier load, pictured in the HUD while a package is aboard.
//
// The taxi already says it carries one — `PARCEL_DECK_SCALE` puts a box on the rear deck (see
// geometry/taxi.js) — and at play zoom that box is about **four pixels**, on a car the player is
// mostly not looking at because they are reading the road ahead of it. The cyan drop pad lights up
// across town at the same moment, which says *where*, and nothing on screen says *what*. A player
// who missed the pickup flight is left inferring the load from a pad they never asked for.
//
// So: the same mesh, big enough to read, parked in the corner of the HUD. Same rig as the
// rider-finder chips and the tutorial bubble — a 42px WebGL context lit by the city's own sun
// (`mirrorSceneLights`) drawing `createParcel`, the real box rather than a picture of one, so it
// cannot drift out of step when the box is restyled.
//
// ## Why it sits with the money and not with the rider chips
//
// The bottom-left row is the reach zone: everything in it — the Loco Mode pill, every rider chip —
// is a control, and a chip parked at the end of that row would be the one that does nothing when
// pressed. **A package cannot be selected**; that is the whole of game/parcels.js. Up beside the
// cash total it is unambiguously a readout, in the corner the run's other state already lives in,
// and it inherits `#hud`'s `pointer-events: none` so a thumb that lands on it goes through to the
// city underneath.
//
// ## No ring around it
//
// A rider chip's ring is a clock. A package has no clock — that is the courier layer's defining
// property, the reason it can never end a run and the reason it has no plumbob out on the map — so
// a ring here would be the one shape on screen that lies about it. What the chip carries instead is
// a thin *solid* cyan rim: the pad colour, unbroken, saying "courier job" and nothing about time.

/** Canvas edge, and the disc it fills. A shade under the rider chip's 49px outer button. */
const SIZE = 42;

/**
 * The city's own view direction, mirrored in X.
 *
 * The chip is a portrait of a thing in this city, so it keeps the game camera's 33° elevation and
 * its 45° azimuth to a box's faces — the silhouette in the HUD is the silhouette on the deck, two
 * faces at three-quarters, which is the pair 📦 shows (the tape strip and a label both live on the
 * Z faces; see geometry/parcel.js).
 *
 * The azimuth is *turned*, though, for the reason tutorial.js turns its own: at the hour the game
 * parks at the sun sits at azimuth 153°, a horizontal direction of (−0.78, +0.40) in (x, z), so the
 * +X faces the city camera looks at are at n·L = −0.78 — unlit. In the world that is fine, it is
 * what makes the shadows read. In a 42px disc with no ground under it, half a black box is just a
 * dark smudge. Mirroring x sends the camera to the −X +Z quadrant instead: the visible X face goes
 * to +0.78 and the Z face stays at +0.40, so both lit faces are the ones on screen. Negating a
 * component of a unit vector leaves it unit, so the elevation comes through untouched.
 */
const CHIP_VIEW = new THREE.Vector3(-VIEW_DIR.x, VIEW_DIR.y, VIEW_DIR.z);

// Framing, measured off the mesh rather than guessed. The box stands 1.16 tall (BOX_H + LID_H) and
// 1.384 across at the lid, so at 45° its half-diagonal is 0.979 and its screen half-height is
// 1.16·cos33/2 + 0.979·sin33 = 1.02 — near enough the same number as the half-width, so one square
// frustum covers both. FIT is that plus a wide margin: the disc is a *circle*, and a box framed to
// its inscribed square has its corners hard against the rim twice as often as a figure does.
const CENTRE_Y = 0.58;
const FIT = 1.42;

/**
 * @param sun   the city's key light, read rather than re-parented (an Object3D has one parent)
 * @param hemi  the city's hemisphere fill, same deal
 */
export function createCargoChip({ sun, hemi }) {
  const el = document.getElementById('cargo-chip');
  if (!el) return { setCarrying: () => {}, render: () => {} };

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  el.appendChild(canvas);

  // One more WebGL context, honouring the same budget flags the main renderer does — see
  // `util/shot.js`. Not for its own cost, which is a 42px disc, but because `?safe` is asking a
  // device "what will you render at all" and every context this page opens is part of that answer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  // Left at rest, and it stays there. The kerb box turns because a slow spin is the universal "this
  // is a thing to pick up" (geometry/parcel.js) — it is the box's substitute for the rider's waving
  // arm. This one has already been picked up: it is cargo, riding along, and it should sit as still
  // in the corner as it does on the deck. A spinning readout would be asking for a second pickup.
  const parcel = createParcel({ pickable: null });
  scene.add(parcel.group);

  const camera = new THREE.OrthographicCamera(-FIT, FIT, FIT, -FIT, 0.1, 60);
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(CHIP_VIEW, 20);
  camera.lookAt(0, CENTRE_Y, 0);

  let carrying = false;

  return {
    /**
     * Show or hide the chip. Called from the same two places `traffic.setTaxiCargo` is, so the
     * corner and the rear deck can never disagree about whether there is a box in the car — the
     * chip appears on `'loaded'`, when the flying box actually reaches the taxi, and goes on
     * `'delivered'`, when the outbound box is the load leaving.
     */
    setCarrying(on) {
      if (on === carrying) return;
      carrying = on;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-hidden', String(!on));
    },
    /**
     * Draw. Nothing moves in here — the box is still and the frustum is fixed — but the lights are
     * re-synced every frame regardless, because the ⚙️ panel's day/night cycle is live and a chip
     * stranded at the hour it was built would be the one object on screen lit by a different
     * afternoon. Cheap: two colour copies and a 42px draw.
     */
    render() {
      if (!carrying) return;
      syncLights();
      renderer.render(scene, camera);
    },
  };
}
