import * as THREE from 'three';
import { CAMERA_DISTANCE } from './camera.js';
import { createPrecip } from './precip.js';

/**
 * The weather, and the clock that walks it from one kind of day to another.
 *
 * It sits *on top of* the day/night cycle rather than beside it: `daylight.setLookFilter()` hands
 * this module the sampled look for the current hour on its way to the lights, and `modify()`
 * multiplies the sun down, pushes the sky toward a colour, decides how far up the city's own
 * lights have to come, and says how much fog and rain there is. One writer to the lights, one
 * place the visibility floor is enforced — see VISIBILITY_FLOOR in daylight.js, which runs *after*
 * everything here and is the reason a midnight downpour is still playable.
 *
 * Every number below is a **multiplier or a blend**, never an absolute. That is what lets the same
 * five weather types work at 3am and at noon: overcast at noon is a bright grey day, overcast at
 * midnight is a moonless one, and neither needed its own keyframe.
 */

const WHITE = new THREE.Color(0xffffff);

/**
 * `sun` / `fill` / `moon` — multipliers on the daylight curve's own intensities.
 * `sky`                   — how far the sky gradient and the hemisphere colour pull toward `tint`.
 * `fog`                   — 0 for none, 1 for as thick as it gets.
 * `wet`                   — how dark and cool the road goes.
 * `gloom`                 — a floor under `lit`: headlights and shop windows on in daylight.
 * `wind`                  — units/s of horizontal drift on the precipitation.
 *
 * Note that `fill` goes *up* in the murk, not down. Fog and snow scatter light rather than
 * removing it — an overcast afternoon is flatter than a clear one but not darker — and it is also
 * the term that keeps the city legible when the sun has been cut to a third.
 */
export const WEATHER = {
  clear: {
    label: 'Clear', sun: 1.08, fill: 1.0, moon: 1.0,
    tint: '#BBD9F2', sky: 0, fog: 0, wet: 0, gloom: 0, rain: 0, snow: 0, wind: 0,
  },
  cloudy: {
    label: 'Cloudy', sun: 0.55, fill: 1.16, moon: 0.78,
    tint: '#9BA8B6', sky: 0.45, fog: 0.16, wet: 0, gloom: 0.12, rain: 0, snow: 0, wind: 2,
  },
  fog: {
    label: 'Fog', sun: 0.44, fill: 1.32, moon: 0.88,
    tint: '#C2CBD4', sky: 0.78, fog: 1, wet: 0.28, gloom: 0.5, rain: 0, snow: 0, wind: 0.6,
  },
  rain: {
    label: 'Rain', sun: 0.34, fill: 1.12, moon: 0.72,
    tint: '#7E8A97', sky: 0.64, fog: 0.42, wet: 1, gloom: 0.58, rain: 1, snow: 0, wind: 6,
    lightning: true,
  },
  snow: {
    label: 'Snow', sun: 0.56, fill: 1.34, moon: 1.06,
    tint: '#CCD8E4', sky: 0.58, fog: 0.5, wet: 0, gloom: 0.38, rain: 0, snow: 1, wind: 2.4,
  },
};

export const WEATHER_TYPES = Object.keys(WEATHER);

/**
 * What can follow what. A chain rather than a uniform draw, because the transition is the thing
 * you actually watch: clear → snow in twelve seconds reads as a bug, clear → cloudy → snow reads
 * as a front coming in. Every type can reach every other type, just not in one step.
 */
export const WEATHER_NEXT = {
  clear: [['cloudy', 0.72], ['fog', 0.28]],
  cloudy: [['clear', 0.32], ['rain', 0.36], ['snow', 0.16], ['fog', 0.16]],
  fog: [['cloudy', 0.58], ['clear', 0.42]],
  rain: [['cloudy', 0.7], ['fog', 0.16], ['clear', 0.14]],
  snow: [['cloudy', 0.78], ['clear', 0.22]],
};

/** How long one kind of weather holds before it starts turning into the next, in real seconds.
 *  Set against DAY_SECONDS = 180: a couple of weather changes per in-game day, so the two clocks
 *  drift against each other and you get rain at dawn one lap and rain at midnight the next. */
const HOLD_MIN = 30;
const HOLD_MAX = 70;
/** How long the turn itself takes. Long enough that no single frame is where it changed. */
const TRANSITION = 12;

/** Depth range for the fog, written relative to the camera's standoff — see CAMERA_DISTANCE. */
const fogNearAt = (s) => CAMERA_DISTANCE - THREE.MathUtils.lerp(10, 45, s);
const fogFarAt = (s) => CAMERA_DISTANCE + THREE.MathUtils.lerp(320, 105, s);

// Lightning. Only in rain, and only about once every twenty seconds at full strength — this is a
// flash of fill light plus a whitened sky for a fraction of a second, so anything more frequent
// stops being an event.
const STRIKE_MIN = 8;
const STRIKE_MAX = 26;
const FLASH_DECAY = 5.5;

const lerp = THREE.MathUtils.lerp;

export function createWeather({ scene, ground, daylight, camera, rng, startType = 'clear' }) {
  const precip = createPrecip(scene, rng, () => camera.state.target);

  const state = {
    from: startType,
    to: startType,
    t: 1,                 // 0 = fully `from`, 1 = fully `to`
    hold: rng.range(HOLD_MIN, HOLD_MAX),
    cycling: true,
    flash: 0,
    nextStrike: rng.range(STRIKE_MIN, STRIKE_MAX),
    windAngle: rng.range(0, Math.PI * 2),
    /** The blended profile, rebuilt each frame. Public so the panel and the tests can read it. */
    blend: { ...WEATHER[startType] },
  };

  const tintFrom = new THREE.Color();
  const tintTo = new THREE.Color();
  const tint = new THREE.Color();
  const fogColor = new THREE.Color();
  const groundTint = new THREE.Color();

  function rebuild() {
    const a = WEATHER[state.from];
    const b = WEATHER[state.to];
    const t = THREE.MathUtils.clamp(state.t, 0, 1);
    const mix = (key) => lerp(a[key], b[key], t);

    const out = state.blend;
    for (const key of ['sun', 'fill', 'moon', 'sky', 'fog', 'wet', 'gloom', 'rain', 'snow', 'wind']) {
      out[key] = mix(key);
    }
    out.label = t < 0.5 ? a.label : b.label;
    tintFrom.set(a.tint);
    tintTo.set(b.tint);
    tint.copy(tintFrom).lerp(tintTo, t);
    out.tint = tint;
    // A strike can only be armed while there is rain on either side of the blend, so the flash
    // doesn't fire into a clear sky halfway through clearing up.
    out.lightning = Boolean(a.lightning || b.lightning) && out.rain > 0.25;
  }

  rebuild();

  /** Weighted draw from the successor table. */
  function pickNext(from) {
    const options = WEATHER_NEXT[from];
    let roll = rng.next() * options.reduce((sum, [, w]) => sum + w, 0);
    for (const [name, w] of options) {
      roll -= w;
      if (roll <= 0) return name;
    }
    return options[options.length - 1][0];
  }

  /**
   * Installed on the daylight module. Mutates the look in place on its way to the lights.
   *
   * Colours are pulled toward the weather tint rather than replaced. Replacing them would throw
   * away the hour: an overcast midnight and an overcast noon would be the same grey, and the whole
   * point of building this on top of the day cycle is that they are not.
   */
  function modify(look) {
    const w = state.blend;

    look.power *= w.sun;
    look.fill *= w.fill;
    look.moon *= w.moon;
    // The city switches its lights on because it is dark *or* because it is murky. A rainy
    // afternoon with every headlight lit is most of what sells the rain.
    look.lit = Math.max(look.lit, w.gloom);

    // The top of the sky holds its colour a little better than the horizon does, which is what
    // stops a grey day reading as a solid grey wall behind the buildings.
    look.top.lerp(w.tint, w.sky * 0.82);
    look.bottom.lerp(w.tint, w.sky);
    look.hemiSky.lerp(w.tint, w.sky * 0.6);
    // Snow bounces a lot of light back up. Warming the hemisphere's *ground* colour is the cheap
    // way to say the streets are covered without touching a single road texture.
    if (w.snow > 0.01) look.hemiGround.lerp(WHITE, w.snow * 0.45);

    if (state.flash > 0.001) {
      const f = state.flash;
      look.fill += f * 1.7;
      look.top.lerp(WHITE, f * 0.45);
      look.bottom.lerp(WHITE, f * 0.55);
    }

    look.wet = w.wet;
    if (w.fog > 0.02) {
      // Fog is the weather's tint sitting in front of the sky's own horizon colour, so the far
      // edge of the city dissolves *into* the sky rather than into a flat grey that reads as a
      // wall painted across the back of the scene.
      look.fogColor = fogColor.copy(look.bottom).lerp(w.tint, 0.55);
      look.fogNear = fogNearAt(w.fog);
      look.fogFar = fogFarAt(w.fog);
    } else {
      look.fogColor = null;
    }
    return look;
  }

  daylight.setLookFilter(modify);

  /** The type the blend is closest to — what a reader would call the weather right now. */
  const currentName = () => (state.t < 0.5 ? state.from : state.to);

  /** Jump to a named type. `instant` skips the blend — used by screenshots and the ⚙️ panel. */
  function setType(name, { instant = false } = {}) {
    if (!WEATHER[name]) return false;
    state.from = instant ? name : currentName();
    state.to = name;
    state.t = instant ? 1 : 0;
    state.hold = rng.range(HOLD_MIN, HOLD_MAX);
    rebuild();
    syncScene(daylight.apply());
    return true;
  }

  /** Everything that is not a light: fog, wet tarmac, precipitation. */
  function syncScene(look) {
    if (!look) return;
    if (look.fogColor) {
      if (!scene.fog) scene.fog = new THREE.Fog(look.fogColor.getHex(), look.fogNear, look.fogFar);
      scene.fog.color.copy(look.fogColor);
      scene.fog.near = look.fogNear;
      scene.fog.far = look.fogFar;
    } else if (scene.fog) {
      scene.fog = null;
    }

    // Wet tarmac. `material.color` multiplies the baked vertex colours, so one number darkens and
    // cools every surface the ground mesh owns — road, kerb, markings, crosswalks — in step, which
    // is what rain actually does. Not a second mesh and not a texture: there aren't any textures.
    if (ground) {
      const k = look.wet ?? 0;
      groundTint.setRGB(1 - 0.3 * k, 1 - 0.28 * k, 1 - 0.2 * k);
      ground.material.color.copy(groundTint);
    }
  }

  function update(dt) {
    const wasFlashing = state.flash > 0.001;

    if (state.cycling) {
      if (state.t < 1) {
        state.t = Math.min(1, state.t + dt / TRANSITION);
        rebuild();
      } else {
        state.hold -= dt;
        if (state.hold <= 0) {
          state.from = state.to;
          state.to = pickNext(state.from);
          state.t = 0;
          // Re-arm here, not when the blend finishes. Forgetting to left `hold` sitting at or
          // below zero for the whole of the next transition, so the moment one change landed the
          // next one started — the sky never held still, and tools/sky.mjs counted four times as
          // many changes as the hold range allows. That count is now an asserted range.
          state.hold = rng.range(HOLD_MIN, HOLD_MAX);
          state.windAngle += rng.range(-1.2, 1.2);
          rebuild();
        }
      }
    }

    // Lightning runs off the same clock whether or not the weather is cycling — a paused storm is
    // still a storm.
    if (state.blend.lightning) {
      state.nextStrike -= dt * state.blend.rain;
      if (state.nextStrike <= 0) {
        state.flash = 1;
        state.nextStrike = rng.range(STRIKE_MIN, STRIKE_MAX);
      }
    }
    if (state.flash > 0) state.flash = Math.max(0, state.flash - dt * FLASH_DECAY);

    // Re-apply the lights only when *this module* has moved. When the day cycle is running,
    // `daylight.update()` has already applied this frame with the blend below, so applying again
    // would be a second full colour sample for an identical result. When neither clock is moving,
    // the lights are already correct — and *not* rewriting them is what lets a sun colour picked
    // by hand in the ⚙️ panel survive.
    const moved = state.t < 1 || state.flash > 0.001 || wasFlashing;
    const look = moved ? daylight.apply() : daylight.look();
    syncScene(look);

    const wind = state.blend.wind;
    precip.update(
      dt,
      state.blend.rain,
      state.blend.snow,
      Math.cos(state.windAngle) * wind,
      Math.sin(state.windAngle) * wind,
    );
  }

  syncScene(daylight.apply());

  return {
    state,
    update,
    modify,
    setType,
    setCycling: (on) => { state.cycling = on; },
    /** The type the blend is closest to, e.g. `'rain'`. */
    current: currentName,
    /** Where the blend is heading, and how far along it is — for the ⚙️ panel readout. */
    describe: () => (state.t >= 1
      ? WEATHER[state.to].label
      : `${WEATHER[state.from].label} → ${WEATHER[state.to].label} ${(state.t * 100).toFixed(0)}%`),
    precip,
  };
}
