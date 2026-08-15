import * as THREE from 'three';
import { createParcel, PARCEL_CENTRE_Y } from '../geometry/parcel.js';
import { mirrorSceneLights } from './avatarlights.js';
import { VIEW_DIR } from './camera.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';

// The courier load: the box the taxi collected, flown out of the city and parked in the corner of the
// HUD for as long as it is aboard.
//
// **This is where a collected package goes.** It used to ride on the taxi's rear deck, at about **four
// pixels** at play zoom, on the one object the player is steering rather than studying — and this chip
// was added beside it to say the same thing at a size that can be read, which left the board carrying
// two versions of one fact. The deck parcel is gone (geometry/taxi.js). The box is collected *into
// here*, which is also what lets the pickup be a single unbroken move instead of a flight into a mesh
// followed by a chip popping up somewhere else.
//
// Same rig as the rider-finder chips and the tutorial bubble — a 42px WebGL context lit by the city's
// own sun (`mirrorSceneLights`) drawing `createParcel`, the real box rather than a picture of one, so
// it cannot drift out of step when the box is restyled. That the chip draws the *same mesh* is what
// makes the flight below possible at all: the thing that lands in the corner is the thing that left
// the kerb, not a picture standing in for it.
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
// ## The box and nothing else
//
// No disc behind it and no rim around it. A rider chip needs its disc because the ring around it is
// a clock, and a clock needs a dial to be read against. A package has no clock — that is the courier
// layer's defining property, the reason it can never end a run and the reason it has no plumbob out
// on the map — so there was never anything for a ring here to say, and with the ring gone the disc
// is a plate under an object that does not need one. Bare, it reads like the rest of the HUD: the
// cash total and the ⏸ are marks on the sky too. The only thing standing between the box and a pale
// road is `#hud`'s own drop shadow, which is what holds the digits up there as well.

/** Canvas edge. A shade under the rider chip's 49px outer button. */
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
 * what makes the shadows read. In a 42px square with no ground under it, half a black box is just a
 * dark smudge. Mirroring x sends the camera to the −X +Z quadrant instead: the visible X face goes
 * to +0.78 and the Z face stays at +0.40, so both lit faces are the ones on screen. Negating a
 * component of a unit vector leaves it unit, so the elevation comes through untouched.
 */
const CHIP_VIEW = new THREE.Vector3(-VIEW_DIR.x, VIEW_DIR.y, VIEW_DIR.z);

// Framing, measured off the mesh rather than guessed. The box stands 1.16 tall (BOX_H + LID_H) and
// 1.384 across at the lid, so at 45° its half-diagonal is 0.979 and its screen half-height is
// 1.16·cos33/2 + 0.979·sin33 = 1.02 — near enough the same number as the half-width, so one square
// frustum covers both. FIT is that plus 13%, which is margin for the drop shadow and for nothing
// else: a *square* canvas has no corner for the box to foul. It was 1.42 while there was a disc
// behind it, because a box framed to a circle's inscribed square has its corners hard against the
// rim twice a turn — 25% of the frame was air paid to a plate that has since gone, and the box was
// the thing that got smaller for it.
//
// The centre is the mesh's own half-height, imported rather than the 0.58 it used to be typed as: the
// flight below lines this canvas's centre up with a point in the city, and the two ends of that line
// have to be the same point on the box.
const CENTRE_Y = PARCEL_CENTRE_Y;
const FIT = 1.15;

/**
 * Pixels this canvas gives a world unit, across the frame.
 *
 * An orthographic frustum `2·FIT` wide drawn into `SIZE` pixels — 18.3px per unit, against the game
 * camera's ~7.7 at play zoom. **The box in the corner is more than twice the size of the box on the
 * road**, which is the whole reason the chip exists, and it is also the number the flight needs: the
 * hand-off starts at `gamePxPerUnit / CHIP_PX_PER_UNIT` of full size, so the first frame in the HUD is
 * exactly as big as the last frame in the city, and the growth after it is the box coming forward to
 * be read rather than a pop.
 *
 * Measured across the frame, not up it, so it can be compared against a screen-horizontal world step
 * at the other end. Both cameras share `VIEW_DIR.y`, so a *vertical* world unit is foreshortened by
 * the same cosine in each — but only the horizontal one is foreshortened by nothing in both, which
 * makes it the one axis that needs no elevation term to compare.
 */
const CHIP_PX_PER_UNIT = SIZE / (2 * FIT);

/**
 * How long the box takes to fly from the kerb into the corner, in ms.
 *
 * Longer than the outbound world flight's 550ms (`FLIGHT_TIME` in game/parcels.js) because it is
 * covering the whole screen rather than a car's length of road, and a cross-screen move at the short
 * duration reads as a flick rather than as something being carried. Wall time rather than sim time,
 * unlike everything in parcels.js: the thing being animated is a DOM element, and it goes on animating
 * through a pause the way the rest of the HUD does.
 */
const FLY_MS = 620;

/**
 * @param sun   the city's key light, read rather than re-parented (an Object3D has one parent)
 * @param hemi  the city's hemisphere fill, same deal
 */
export function createCargoChip({ sun, hemi }) {
  const el = document.getElementById('cargo-chip');
  if (!el) return { setCarrying: () => {}, flyIn: () => {}, render: () => {} };

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  el.appendChild(canvas);

  // One more WebGL context, honouring the same budget flags the main renderer does — see
  // `util/shot.js`. Not for its own cost, which is a 42px square, but because `?safe` is asking a
  // device "what will you render at all" and every context this page opens is part of that answer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  // At rest once it has landed, and it stays there. The kerb box turns because a slow spin is the
  // universal "this is a thing to pick up" (geometry/parcel.js) — it is the box's substitute for the
  // rider's waving arm. This one has already been picked up: it is cargo, riding along, and it should
  // sit as still in the corner as it did on the deck. A spinning readout would be asking for a second
  // pickup. The one exception is the flight in, which *inherits* the spin it arrived with and eases it
  // to square — see `flyIn`.
  const parcel = createParcel({ pickable: null });
  scene.add(parcel.group);

  const camera = new THREE.OrthographicCamera(-FIT, FIT, FIT, -FIT, 0.1, 60);
  camera.position.set(0, CENTRE_Y, 0).addScaledVector(CHIP_VIEW, 20);
  camera.lookAt(0, CENTRE_Y, 0);

  let carrying = false;
  // The flight in: the yaw it started at and when, or null once the box has settled. Read by `render`,
  // which is the only thing that can turn it into a pose.
  let spin = null;
  // The DOM half of the same flight, kept so it can be cancelled. A `fill: 'both'` animation goes on
  // holding the element's transform after it ends, and a stale one still holding it is what
  // `getBoundingClientRect` would then measure the next flight's start against.
  let flight = null;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  return {
    /**
     * Show or hide the chip outright, with no flight. The *exit* path — a delivery puts it down — and
     * the way `tools/smoke.mjs` drives it, since a real courier job costs several minutes of
     * software-rendered sim to reach.
     *
     * A pickup goes through `flyIn` instead, which raises the chip itself.
     */
    setCarrying(on) {
      if (on === carrying) return;
      carrying = on;
      if (!on) {
        spin = null;
        flight?.cancel();
        flight = null;
        parcel.group.rotation.y = 0;
        el.classList.remove('is-flying');
      }
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-hidden', String(!on));
    },

    /**
     * Fly the box in from the city: it lifts off the kerb it was standing on, sweeps up into the
     * corner and settles into the chip's slot at chip size.
     *
     * `at` is where the box's own centre is on screen this frame, and `pxPerUnit` is what the game
     * camera gives a world unit *across* the frame there — both measured in main.js, which owns the
     * projection. `yaw` is the spin the kerb box had reached. Between them they are the whole of the
     * hand-off: the chip opens at that point, at that size, at that angle, on the frame the world box
     * is hidden, so nothing about the box changes across the seam except that it is now a piece of HUD.
     *
     * The three have to be *given* rather than assumed. The city's zoom moves (Loco Mode pulls the
     * camera out), so a scale baked in at 7.7px per unit is right at one zoom and wrong at every other;
     * the box bobs and spins, so the angle and even the height are only true for the frame they were
     * read on.
     *
     * ## The path, and why it goes up before it goes across
     *
     * Three keyframes. The middle one has the box 78% of the way up but only 38% of the way across, so
     * it *rises* off the pavement first and then sweeps into the corner. A straight line reads as the
     * box being dragged across the city at an angle; the lift says it left the ground, which is the
     * thing that actually happened, and it is the same shape the world flight throws its outbound box
     * on (`FLIGHT_ARC` in game/parcels.js).
     *
     * Scale leads a little — 60% of the growth is done by the midpoint — so the box has already
     * arrived at readable size while it is still travelling, rather than snapping to size at the end.
     */
    flyIn({ x, y, pxPerUnit, yaw = 0 }) {
      if (carrying) return;
      carrying = true;
      el.setAttribute('aria-hidden', 'false');
      flight?.cancel();
      flight = null;

      const home = el.getBoundingClientRect();
      // A chip with no box measures fine — it is a 42px grid cell whether or not `is-on` is set — but a
      // HUD that is `display: none` (shot mode, the run-end blackout) measures 0×0, and a flight aimed
      // from a rectangle at the origin is a box swooping in from off the top-left corner of the screen.
      // Raise it where it stands instead: there is nothing on screen for the flight to be seamless with.
      const canFly = home.width > 0 && Number.isFinite(x) && Number.isFinite(y)
        && pxPerUnit > 0 && !reducedMotion?.matches;
      el.classList.toggle('is-flying', canFly);
      el.classList.add('is-on');
      if (!canFly) return;

      const dx = x - (home.left + home.width / 2);
      const dy = y - (home.top + home.height / 2);
      const k = pxPerUnit / CHIP_PX_PER_UNIT;
      const mid = (from, to, f) => from + (to - from) * f;

      flight = el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${k})` },
        {
          transform: `translate(${dx * 0.62}px, ${dy * 0.22}px) scale(${mid(k, 1, 0.6)})`,
          offset: 0.55,
        },
        { transform: 'translate(0px, 0px) scale(1)' },
      ], { duration: FLY_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' });

      // The spin the box arrived with, eased out over the same flight — a box that snapped square on
      // the frame it changed owners would undo the seam the position and the scale just bought.
      //
      // Negated, because the chip's camera is the city's mirrored in X (see CHIP_VIEW): a mirrored view
      // of a box at yaw θ is the ordinary view of one at −θ. The mirror also flips the *image*, which
      // this cannot undo — but the box is square in plan, so what survives the flip is the silhouette
      // and what does not is which side of the tape strip the label sits on, at 42px, on an object that
      // is turning. The alternative is un-mirroring the camera and lighting the whole chip off the box's
      // dark faces, which is a real cost paid against an imperceptible one.
      //
      // Folded to the nearest quarter turn, so the box never turns more than 45° on the way in. A
      // square box a quarter turn from square is *the same picture* — the footprint is square by
      // design (geometry/parcel.js) precisely so its spin never changes its width — so "settle it
      // square" has four right answers and this takes the near one. Landing the raw angle instead
      // means up to half a turn crammed into 620ms, which is nine times the speed the box was
      // actually rotating at and reads as a flourish rather than as the same spin running down.
      const QUARTER = Math.PI / 2;
      const settled = -yaw - Math.round(-yaw / QUARTER) * QUARTER;
      spin = { from: settled, at: performance.now() };
      flight.onfinish = () => {
        el.classList.remove('is-flying');
        spin = null;
        parcel.group.rotation.y = 0;
      };
    },

    /**
     * Draw. The box is still and the frustum is fixed once it has landed, but the lights are re-synced
     * every frame regardless, because the ⚙️ panel's day/night cycle is live and a chip stranded at the
     * hour it was built would be the one object on screen lit by a different afternoon. Cheap: two
     * colour copies and a 42px draw.
     */
    render() {
      if (!carrying) return;
      if (spin) {
        // A cubic ease-out over the flight's own duration, so the turn slows to a stop as the travel
        // does rather than finishing early and leaving the box riding in dead still.
        const t = Math.min(1, (performance.now() - spin.at) / FLY_MS);
        parcel.group.rotation.y = spin.from * (1 - t) ** 3;
      }
      syncLights();
      renderer.render(scene, camera);
    },
  };
}
