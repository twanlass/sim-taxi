import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { sirenOn } from '../geometry/lights.js';
import { CHASSIS_LIFT } from '../geometry/wheels.js';

// The red and blue wash a cop car throws across the tarmac and the fronts of the buildings it
// passes, during a [bank robbery](../../docs/gameplay.md#the-police).
//
// **The bar on the roof is not the glow.** A cop car's bar is an instanced emissive pod pair
// (geometry/lights.js) and the bloom spreads a halo round it, but both of those are *the lamp
// looking bright*; neither puts any colour on the road. The cruiser has had a real `PointLight` per
// colour since it existed, and the note there says why in one line: "the bar alone is a couple of
// pixels; what sells a siren is the colour washing across the tarmac and the fronts of nearby
// buildings as it goes past." A cop car with no light was the same car with the argument removed.
//
// It lives here rather than in `sim/traffic.js` for the reason the cruiser's rubber and dust do:
// scene lighting is the game layer's, and `sim/` may not reach into it. traffic.js publishes
// `policeCars`; this parks lights on them.

/**
 * How many cars get a light, out of however many are in livery.
 *
 * **Two, against four cars wearing bars**, and the asymmetry is the whole design of this module. A
 * `PointLight` is not free — it is a uniform slot and a per-fragment term on every lit material in
 * the scene, paid on every frame whether or not a robbery is running — so the count is fixed at
 * construction and small. Two is what the cruiser already costs the scene, so a city with a
 * robbery in it lights the same as a city with a corridor run in it.
 *
 * Which two is re-picked every frame: the nearest to the taxi. That is cheap (a distance sort over
 * at most a dozen cars) and it means the wash is always on the cop cars the player can actually
 * see, while the two further away still flash their bars. The alternative — a light each — spends
 * four uniform slots to light two cars that are usually off frame.
 */
const LIGHTS = 2;

/**
 * Reach and falloff, straight off the cruiser's own lamps (`lightBar` in sim/police.js), so two
 * kinds of police car on the same street throw the same colour the same distance. 34 units is a bit
 * over a block and a half.
 */
const RANGE = 34;
const DECAY = 1.7;

/**
 * Peak intensity, and the floor the *other* colour holds while it is off.
 *
 * Under the cruiser's 90, and deliberately: there can be two of these at once and the cruiser is
 * one car. At 90 apiece a pair of cop cars a block apart washed the road between them into a flat
 * purple, which reads as a lighting bug rather than as two sirens. The off-colour floor is the
 * cruiser's own ratio (14/90) for the reason stated there — a hard on/off strobe reads as flicker
 * rather than as a siren.
 */
const PEAK = 62;
const DIM = PEAK * (14 / 90);

/** Where the lamp sits above the car's origin — level with the bar it is standing in for. */
const LAMP_Y = 2.1 + CHASSIS_LIFT;

/**
 * @param scene    the scene the lights are added to
 * @param enabled  false builds nothing and leaves every method a no-op — `?safe` turns this off,
 *                 since two extra point lights is exactly the kind of per-fragment cost a budget
 *                 mode exists to drop. The bars keep flashing either way.
 */
export function createCopLights(scene, { enabled = true } = {}) {
  if (!enabled) {
    return { update: () => {}, lights: [], state: { lit: 0, hunting: false } };
  }

  const state = { lit: 0, hunting: false };
  const lamps = [];
  for (let k = 0; k < LIGHTS; k++) {
    // A pair per car, the same split the bar itself uses: one lamp per colour, alternating, rather
    // than one lamp whose colour is tweened. A tween walks through purple on every change.
    const red = new THREE.PointLight(new THREE.Color(PALETTE.lightRed), 0, RANGE, DECAY);
    const blue = new THREE.PointLight(new THREE.Color(PALETTE.sirenBlue), 0, RANGE, DECAY);
    // No shadows. These are cheap fill standing in for a lamp that is a few pixels across, and a
    // shadow-casting point light is six more render passes for something nothing is lit by.
    scene.add(red);
    scene.add(blue);
    lamps.push({ red, blue });
  }

  const dark = () => {
    for (const lamp of lamps) {
      lamp.red.intensity = 0;
      lamp.blue.intensity = 0;
    }
    state.lit = 0;
  };

  /**
   * Park the lamps on the nearest cop cars and strobe them.
   *
   * `flash` is the sim clock the bars are driven off (`traffic.stats.time`), so the wash and the
   * bar under it are the same siren rather than two clocks that drift apart — the same rule
   * game/sirenglow.js keeps against the cruiser's bar.
   */
  function update(cars, taxi, flash) {
    if (!cars.length) { dark(); return; }


    // Nearest first, of the cars whose **bar is actually running**. `siren` rather than the fact of
    // being in `policeCars`, because the two come apart for the length of the stand-down: a cop
    // released from a finished robbery keeps its paint and loses its lights, and a wash still
    // playing on the tarmac under a dark bar is the one place this would show as a disagreement
    // between the two. Same reason the bar itself is written off `siren` in sim/traffic.js.
    const near = [...cars]
      .filter((car) => !car.crashed && car.siren)
      .sort((a, b) => Math.hypot(a.x - taxi.x, a.z - taxi.z) - Math.hypot(b.x - taxi.x, b.z - taxi.z))
      .slice(0, LIGHTS);

    // Per car rather than once for the pass: a cop that is chasing strobes at the hunting rate and
    // one that is not strobes at the cruising rate, and the wash has to be the same siren as the
    // bar over it or the two visibly disagree on the same vehicle.
    const anyChasing = near.some((car) => car.chase > 0);
    for (let k = 0; k < lamps.length; k++) {
      const car = near[k];
      const lamp = lamps[k];
      if (!car) {
        lamp.red.intensity = 0;
        lamp.blue.intensity = 0;
        continue;
      }
      lamp.red.position.set(car.x, LAMP_Y, car.z);
      lamp.blue.position.copy(lamp.red.position);
      const on = sirenOn(flash, car.chase > 0);
      lamp.red.intensity = on ? PEAK : DIM;
      lamp.blue.intensity = on ? DIM : PEAK;
    }
    state.lit = near.length;
    state.hunting = anyChasing;
    // A fleet that is entirely stood down leaves `near` empty, and the loop above has already
    // zeroed every lamp — `state.lit` going to 0 is what the probe reads as "no robbery, no wash".
    if (!near.length) state.hunting = false;
  }

  return {
    state,
    update,
    /** The lamps, for the tools. */
    lights: lamps,
  };
}
