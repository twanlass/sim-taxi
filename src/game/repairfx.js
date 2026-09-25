import * as THREE from 'three';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { APRON_Y } from '../city/garage.js';
import { KERB_H } from '../city/ground.js';
import { markEmissive } from './bloom.js';

// The depot at work: what the player sees of a repair, through the fifth of the door that is left
// open while it happens (`REPAIR_GAP` in game/opening.js).
//
// The visit used to cut to black for this beat, which said "time passed" and nothing about what
// the time was spent on. A roller door left short of the floor with a welder going behind it says
// *repairs* on its own, and it keeps the camera on the building the player is paying to use.
//
// Three things, all of them coming out from under the curtain and none of them inside the bay —
// the camera looks down at 33°, so a gap 0.68 tall shows barely a unit of the floor behind it, and
// whatever the repair is it has to be told by what spills out:
//
//   - **The arc.** A blue-white glow in the gap and a pool of it thrown across the forecourt, strobing
//     while a weld runs and dropping to nothing between welds. Two additive quads, not a light: a
//     `PointLight` joins every lit material's program cache key (the police `shell` note in
//     CLAUDE.md), and this one would be on screen for three seconds a visit.
//   - **Sparks**, off game/sparks.js's own pool, skittering out across the forecourt from wherever
//     along the door the current weld is. Moving the weld point between welds is what stops the
//     shower reading as a fountain bolted to the doorstep.
//   - **Grit**, off game/dust.js's pool, drifting out low in the lulls.
//
// Driven by `start`/`stop` from the opening (the `workshop` it is handed) and ticked from main.js's
// frame loop like every other effect, so a paused frame simply stops advancing it.

// A weld and the pause after it, in seconds. Short enough that three seconds of repair holds three
// or four of them — one long unbroken arc reads as a light left on, not as someone working.
const ARC_MIN = 0.35;
const ARC_MAX = 0.85;
const REST_MIN = 0.2;
const REST_MAX = 0.5;
// The glow under a live arc: a floor it never drops below plus a per-frame flicker on top. Real arc
// light is a strobe, and at 60fps a random level each frame is exactly that.
const ARC_FLOOR = 0.55;
// How fast the glow dies when an arc stops, 1/s. Not instant: the eye keeps a flash for a beat,
// and a glow that snaps off reads as a dropped frame. But dark well inside the shortest pause: at
// 14 it took 0.3s to fall under 1%, the pauses were shorter than that, and the arc measured lit on
// 146 frames of 150 — a light left on, which is the one thing this is not supposed to read as.
// At 32 it is out in 0.14s.
const GLOW_DECAY = 32;

// Sparks per second while an arc runs. game/sparks.js gives each 0.36–0.63s of life, so 60 a
// second holds about 30 alive — under half its 64-slot pool, and the taxi is staged for the whole
// visit, so no landing or bump can be competing for the rest.
const SPARK_RATE = 60;
// ...thrown further and higher than a landing's, through game/sparks.js's `reach` and `lift`. At
// the landing's own throw the shower died on the doorstep: a spark that leaves at 1.2–4.2 u/s up is
// back on the floor inside a tenth of a second and loses a third of its speed at every bounce, so
// it covered about a unit of the three-unit forecourt. It has to *shoot* out of the gap to read.
const SPARK_REACH = 1.6;
const SPARK_LIFT = 1.5;
// And a pop of them on the frame each weld strikes, so an arc starting is an event and not a fade.
const STRIKE_SPARKS = 6;
// Grit puffs per second, and how big each one is on dust.js's curve. Small and slow: this is
// grinding dust drifting out of a doorway, not a barricade going over.
const DUST_RATE = 5;
const DUST_SCALE = 0.45;

// Where the weld can be along the door, as a fraction of the half-width either side of its centre.
// Kept off the jambs so the sparks never start inside the wall.
const WELD_SPREAD = 0.7;

// The two glow quads. The pool reaches most of the way across the forecourt and fans out as it goes,
// the way light out of a slot does; the gap quad stands just behind the curtain and is taller than
// the gap, because the curtain in front of it hides whatever is over the opening anyway.
const POOL_BACK = 0.8;        // how far it reaches under the door, into the bay
const POOL_OUT = 2.8;         // ...and out across the forecourt
const POOL_FAN = 0.6;         // extra width at the far end, as a fraction of the door's
const POOL_LIFT = 0.02;       // off the forecourt asphalt: two flat surfaces at one height shimmer
const GAP_BEHIND = 0.15;      // behind the curtain plane: the curtain is 0.16 thick, centred on it
const GAP_TALL = 1.2;

/**
 * @param site   the depot's geometry — `garageSite` in city/garage.js
 * @param sparks game/sparks.js's pool
 * @param dust   game/dust.js's pool
 */
export function createRepairFx({ scene, site, sparks, dust, rng }) {
  const { curtainX, doorZ, doorW } = site;
  const flash = color('weldFlash');
  const grit = color('repairDust').getHex();

  // --- The pool on the forecourt -------------------------------------------------------------
  // A plane three wound itself, laid flat and then fanned by moving vertices *within* its own
  // plane — so its normal stays +Y whatever the fan does. Brightness rides the vertex colour: this
  // is additive, so black at the far edge is "no light" and the falloff costs no texture.
  const poolGeo = new THREE.PlaneGeometry(POOL_BACK + POOL_OUT, doorW, 6, 4);
  poolGeo.rotateX(-Math.PI / 2);
  const poolPos = poolGeo.attributes.position;
  const poolCol = new Float32Array(poolPos.count * 3);
  for (let v = 0; v < poolPos.count; v++) {
    // 0 at the back edge, 1 at the far end of the forecourt.
    const u = poolPos.getX(v) / (POOL_BACK + POOL_OUT) + 0.5;
    // −1 to 1 across the door. Dark at both sides, so the pool is a spill rather than a stencil:
    // with one segment across it the fan had hard straight edges and read as a ramp painted on.
    const across = poolPos.getZ(v) / (doorW / 2);
    poolPos.setX(v, curtainX - POOL_BACK + u * (POOL_BACK + POOL_OUT));
    poolPos.setZ(v, doorZ + poolPos.getZ(v) * (1 + POOL_FAN * u));
    poolPos.setY(v, APRON_Y + POOL_LIFT);
    // Brightest right at the curtain line, where the light comes out, and gone by the far end.
    const out = Math.max(0, (u * (POOL_BACK + POOL_OUT) - POOL_BACK) / POOL_OUT);
    const k = (u * (POOL_BACK + POOL_OUT) < POOL_BACK ? 0.8 : (1 - out) ** 2) * (1 - across ** 2);
    poolCol[v * 3] = flash.r * k;
    poolCol[v * 3 + 1] = flash.g * k;
    poolCol[v * 3 + 2] = flash.b * k;
  }
  poolGeo.setAttribute('color', new THREE.BufferAttribute(poolCol, 3));

  // --- The gap itself ------------------------------------------------------------------------
  // Faces +X, out of the door towards the camera. Brighter at the floor, where the arc is.
  const gapGeo = new THREE.PlaneGeometry(doorW - 0.2, GAP_TALL, 1, 1);
  gapGeo.rotateY(Math.PI / 2);
  gapGeo.translate(curtainX - GAP_BEHIND, KERB_H + GAP_TALL / 2, doorZ);
  const gapPos = gapGeo.attributes.position;
  const gapCol = new Float32Array(gapPos.count * 3);
  for (let v = 0; v < gapPos.count; v++) {
    const k = gapPos.getY(v) < KERB_H + GAP_TALL / 2 ? 1 : 0.35;
    gapCol[v * 3] = flash.r * k;
    gapCol[v * 3 + 1] = flash.g * k;
    gapCol[v * 3 + 2] = flash.b * k;
  }
  gapGeo.setAttribute('color', new THREE.BufferAttribute(gapCol, 3));

  const glowMaterial = () => unlitMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0,
  });
  const pool = new THREE.Mesh(poolGeo, glowMaterial());
  const gap = new THREE.Mesh(gapGeo, glowMaterial());
  pool.name = 'repair-glow-pool';
  gap.name = 'repair-glow-gap';
  const glows = [pool, gap];
  for (const mesh of glows) {
    mesh.renderOrder = 6;           // with the sparks: light, drawn over what it lands on
    mesh.visible = false;
    scene.add(mesh);
  }
  // The gap blooms, on the depot strip light's own kind — it is the bay lit up. The pool does not:
  // it is light *on* the forecourt, and a blurred pool over the whole driveway is a fog.
  markEmissive(gap, 'bay');

  let working = false;
  let arc = false;
  let clock = 0;            // time left in this weld or this pause
  let weldZ = doorZ;
  let glow = 0;
  let sparkDebt = 0;
  let dustDebt = 0;

  const newWeld = () => {
    arc = true;
    clock = rng.range(ARC_MIN, ARC_MAX);
    weldZ = doorZ + rng.jitter(doorW / 2 * WELD_SPREAD);
    sparks.burst(curtainX + 0.08, APRON_Y, weldZ, Math.PI, STRIKE_SPARKS, 0,
      { reach: SPARK_REACH, lift: SPARK_LIFT });
  };

  function setGlow(level) {
    glow = level;
    for (const mesh of glows) {
      mesh.material.opacity = level;
      mesh.visible = level > 0.01;
    }
  }

  /** The repair has started: open with a weld straight away, so the first thing seen is the flash. */
  function start() {
    working = true;
    newWeld();
    // And a puff to go with it, so the door stopping short reads as the work starting.
    for (let n = 0; n < 4; n++) {
      dust.add(curtainX + 0.3, doorZ + rng.jitter(doorW * 0.35), Math.PI, DUST_SCALE * 1.4, 0.5,
        grit, APRON_Y + 0.15, 0.8);
    }
  }

  /** Stop emitting. Anything already in the air finishes its own life. */
  function stop() {
    working = false;
    arc = false;
  }

  function update(dt) {
    if (!working) {
      if (glow > 0) setGlow(glow * Math.exp(-GLOW_DECAY * dt));
      return;
    }
    clock -= dt;
    if (clock <= 0) {
      if (arc) {
        arc = false;
        clock = rng.range(REST_MIN, REST_MAX);
      } else {
        newWeld();
      }
    }

    if (arc) {
      setGlow(ARC_FLOOR + (1 - ARC_FLOOR) * rng.next());
      // `yaw` π throws sparks.js's spray "backwards" along +X: out of the door, across the
      // forecourt, towards the street.
      sparkDebt += SPARK_RATE * dt;
      const n = Math.floor(sparkDebt);
      sparkDebt -= n;
      for (let k = 0; k < n; k++) {
        sparks.burst(curtainX + 0.08, APRON_Y, weldZ + rng.jitter(0.25), Math.PI, 1, 0,
          { reach: SPARK_REACH, lift: SPARK_LIFT });
      }
    } else {
      setGlow(glow * Math.exp(-GLOW_DECAY * dt));
    }

    // Grit runs through the arcs and the pauses alike: it is the shop, not the weld.
    dustDebt += DUST_RATE * dt;
    while (dustDebt >= 1) {
      dustDebt -= 1;
      dust.add(curtainX + 0.25, doorZ + rng.jitter(doorW * 0.4), Math.PI, DUST_SCALE, 0.3, grit,
        APRON_Y + 0.12, 0.6);
    }
  }

  return {
    start,
    stop,
    update,
    /** True while the shop is working — for tools/probe.mjs. */
    working: () => working,
    /** The two glow quads — for the winding check in tools/probe.mjs. */
    pool,
    gap,
  };
}
