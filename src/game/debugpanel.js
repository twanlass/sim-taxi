import { ROUTE_BLENDS } from './routeline.js';
import { HAZE_TOP, setHazeTop, hazeColor, hazeTuning } from './scene.js';
import * as difficulty from './difficulty.js';
import { SPEED, MPH_PER_UNIT, CAR_W } from '../sim/traffic.js';
import { PITCH, LANE } from '../city/grid.js';
import { PLAY_ZOOM } from './camera.js';
import {
  setShadowTint, shadowTint, FINISH_NAMES, glossTuning, setGlossFinish, setGlossGlobal, rimTuning, setRimTuning,
  resetGlossTuning,
} from '../util/geo.js';
import { MIN_ELEVATION } from './daylight.js';
import { BLOOM_INTENSITY, BLOOM_KINDS } from './bloom.js';
import { CRT_SLIDERS, CRT_PRESETS } from './crt.js';
import {
  PRESETS as GRADE_PRESETS, colorGrade, setGradePreset, setGradeCube, setGradeStrength, setGradeSaturation,
  resetGrade, bakedTable, toCube, gradeSnapshot, setGradeAdjust, setGradeCurve, resetGradeCurve, resetGradeAdjust,
  setGradeBypass, curveAt, lookCode, setLookCode, CURVE_CHANNELS,
} from './colorgrade.js';
import { buildAudioSections } from './audiopanel.js';
import { attachQuickTips } from './quicktips.js';

// Screen pixels to a world unit at play zoom, for the readouts that need one. Derived rather than
// written down as the 7.7 that appears as prose all over this project: the frustum is sized by
// *height*, so half a nominal 800px-tall frame spans `PLAY_ZOOM` world units, and re-tuning that
// constant moves this with it. Approximate by nature — a real device's canvas is whatever it is —
// which is why every readout using it carries a "u" as well.
const NOMINAL_FRAME_H = 800;
const PX_PER_UNIT = (NOMINAL_FRAME_H / 2) / PLAY_ZOOM;

// A small tweak panel behind a gear button.
//
// Split by cost: anything that can be applied to live objects (lighting, fare clock) updates on
// input, and anything that needs the world rebuilt (car count, a fresh run) writes a URL
// parameter and reloads. Pretending a rebuild-only value is live would just show a slider that
// silently does nothing.
//
// The panel no longer owns the sun's curve — daylight.js does, and drives it on a clock. The
// controls here are a window onto that: while the cycle runs they show where it has got to, and
// touching any of them takes manual control so the two aren't fighting over the same lights.

function row(parent, label, input) {
  const wrap = document.createElement('label');
  wrap.className = 'dbg-row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('em');
  wrap.append(name, input, value);
  parent.append(wrap);
  return value;
}

const slider = (min, max, step, value) => {
  const el = document.createElement('input');
  Object.assign(el, { type: 'range', min, max, step, value });
  return el;
};

const dropdown = (options, value) => {
  const el = document.createElement('select');
  for (const name of options) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    el.append(option);
  }
  el.value = value;
  return el;
};

// A colour well. Its `input` fires continuously while the picker is open on every browser that
// matters, so it scrubs like a slider rather than committing on close.
const swatch = (value) => {
  const el = document.createElement('input');
  Object.assign(el, { type: 'color', value });
  return el;
};

const clockLabel = (hour) => {
  const h = Math.floor(hour);
  const m = String(Math.round((hour - h) * 60) % 60).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${m}`;
};

export function createDebugPanel({
  sun, hemi, sky, daylight, fares, carCount, routeLine, ao,
  // Crayon Mode's live uniforms — `{ state, set }` over game/crayon.js. Defaulted like the rest
  // of the optional systems below so the `npm run check` boot pass can build the panel against
  // nothing; with the flag off the section says so instead of drawing dead sliders.
  crayon = { state: { enabled: false }, set: () => {} },
  // Cartoon Mode's, same shape — `{ state, set }` over game/cartoon.js.
  cartoon = { state: { enabled: false }, set: () => {} },
  // The emissive bloom's, same shape again — `{ state, set }` over game/bloom.js.
  bloom = { state: { enabled: false }, set: () => {} },
  // ...and the HDR comparison's, over game/hdr.js. Only one of the two is ever enabled.
  hdr = { state: { enabled: false }, set: () => {} },
  // The CRT screen's — `{ state, set, preset }` over game/crt.js. Off under `?crt=classic`, which
  // allocates nothing, so the section is left out rather than drawn dead.
  crt = { state: { enabled: false }, set: () => {}, preset: () => {} },
  // The scene's haze (game/scene.js). Defaulted to null for the same reason `scores` is defaulted:
  // the `npm run check` boot pass builds this panel against nothing.
  fog = null,
  // `{ load, clear }` over game/highscores.js. Defaulted so the panel still constructs in the
  // `npm run check` boot pass, which builds it against nothing.
  scores = { load: () => [], clear: () => {} },
  // The city-entrance animation's levers — `{ tuning, tune, replay }` over game/cityentry.js.
  // Defaulted for the same reason as `scores`.
  cityEntry = { tuning: () => ({ wave: 0, jitter: 0, grow: 0, overshoot: 0, dust: 0 }), tune: () => {}, replay: () => {} },
  // Loco Mode's speed ramp — `{ get, set, reset, ramp, defaults }` over sim/traffic.js, pushed in
  // by main.js. Defaulted like the two above so the `npm run check` boot pass builds the panel
  // against nothing; the section then draws a flat curve and moves a tuning nobody is reading.
  loco = {
    defaults: {
      kick: 1, speed: 1, accel: 1, overdriveSpeed: 1, overdriveAccel: 1, brake: 1,
      sway: 0.4, swayWave: 18, chop: 0.12, chopWave: 9.5, fade: 7,
    },
    get: () => ({ ...loco.defaults }), set: () => {}, reset: () => {},
    ramp: () => [{ s: 0, t: 0, v: 0 }], save: () => false,
  },
  // Whether the Loco sliders opened on a tuning restored from a previous session, rather than on
  // the shipped defaults. Only affects what the line under the Reset button says.
  locoRestored = false,
  // The weather ringing the island — `{ state, setCount, setBand, setSpeed, setOver, POOL }` over
  // game/clouds.js. Defaulted like `scores` above, so the `npm run check` boot pass builds the
  // panel against nothing.
  clouds = null,
  // Freeze-and-zoom (game/inspect.js), or null in the boot pass and in shot mode.
  inspect = null,
  // The sound effects (game/sfx.js), for the Audio sections — null in the boot pass and in shot
  // mode, which have no audio, and then the sections are left out.
  sfx = null,
  // By sound: make the rare thing that plays it happen now — the Audio sections' ⚡ buttons. See
  // `soundTriggers` in main.js.
  soundTriggers = {},
  // ...and freeze the moving ones (plane, chopper, birds) with their sound looping — the ⏸ buttons.
  // See `holds` in main.js.
  soundHolds = {},
  // Where a placed sound is heard from right now, for its ▶ — `soundPlace` in main.js.
  soundPlace = () => null,
  // The wreck fireball's cut — `{ styles, current, set }` over game/blast.js's WRECK_STYLES.
  wreck = null,
  // The 🖥 / 📱 switch beside the search (game/phoneframe.js), or null for no switch.
  phoneFrame = null,
}) {
  const toggle = document.createElement('button');
  toggle.id = 'dbg-toggle';
  toggle.type = 'button';
  toggle.textContent = '⚙️';
  toggle.title = 'Tweaks';

  const panel = document.createElement('div');
  panel.id = 'dbg-panel';
  panel.hidden = true;

  document.body.append(toggle, panel);
  attachQuickTips(panel);

  const heading = (text) => {
    const h = document.createElement('h4');
    h.textContent = text;
    panel.append(h);
  };

  // --- Lighting -------------------------------------------------------------
  heading('Light');

  const cycleBox = document.createElement('input');
  cycleBox.type = 'checkbox';
  cycleBox.checked = daylight.state.cycling;
  row(panel, 'Day cycle', cycleBox);
  cycleBox.addEventListener('change', () => daylight.setCycling(cycleBox.checked));

  /** Any manual touch stops the clock, rather than letting the next frame overwrite the change. */
  function takeManualControl() {
    if (!cycleBox.checked) return;
    cycleBox.checked = false;
    daylight.setCycling(false);
  }

  const dayLength = slider(30, 900, 10, daylight.state.dayLength);
  const dayLengthValue = row(panel, 'Day length', dayLength);
  dayLength.addEventListener('input', () => {
    daylight.setDayLength(Number(dayLength.value));
    dayLengthValue.textContent = `${dayLength.value}s`;
  });

  const hourInput = slider(0, 24, 0.05, daylight.state.hour);
  const hourValue = row(panel, 'Time of day', hourInput);
  hourInput.addEventListener('input', () => {
    takeManualControl();
    daylight.apply(Number(hourInput.value));
    refresh();
  });

  // Where the sun *is*, held apart from what hour it is — see the note on `aim` in daylight.js.
  // Deliberately outside `takeManualControl()`: pinning the direction is not a fight with the
  // clock over one value, it is taking a value the clock then has no further opinion about, so a
  // pinned sun and a running day cycle is a supported combination rather than a contradiction.
  const pinBox = document.createElement('input');
  pinBox.type = 'checkbox';
  pinBox.checked = daylight.aim.pinned;
  row(panel, 'Pin sun', pinBox);
  pinBox.addEventListener('change', () => {
    daylight.setSunPinned(pinBox.checked);
    refresh();
  });

  // 0-360 with no clamp: the arc only ever sweeps 10 to 175, and the whole point of the control is
  // reaching the three quarters of the compass a day in this city never visits.
  const bearing = slider(0, 360, 1, daylight.azimuth());
  const bearingValue = row(panel, 'Sun bearing', bearing);
  bearing.addEventListener('input', () => {
    // Moving a slider *is* the intent to pin — no ticking a box first to make the control work.
    daylight.setSunAim({ azimuth: Number(bearing.value) });
    refresh();
  });

  // Floored at MIN_ELEVATION for the same reason the arc is, and capped at true overhead. Note
  // that a low sun throws shadows longer than the shadow camera's own extent (MAX_SPAN * 1.05 in
  // scene.js), so the far end of one can be clipped down here — the arc has always had that at
  // dawn and dusk, this control just makes it reachable at any hour.
  const height = slider(MIN_ELEVATION, 90, 1, daylight.elevation());
  const heightValue = row(panel, 'Sun height', height);
  height.addEventListener('input', () => {
    daylight.setSunAim({ elevation: Number(height.value) });
    refresh();
  });

  const sunColour = document.createElement('input');
  sunColour.type = 'color';
  sunColour.value = `#${sun.color.getHexString()}`;
  row(panel, 'Sun colour', sunColour);
  sunColour.addEventListener('input', () => {
    takeManualControl();
    sun.color.set(sunColour.value);
  });

  const sunPower = slider(0, 6, 0.05, sun.intensity);
  const sunPowerValue = row(panel, 'Sun strength', sunPower);
  sunPower.addEventListener('input', () => {
    takeManualControl();
    sun.intensity = Number(sunPower.value);
    sunPowerValue.textContent = sun.intensity.toFixed(2);
  });

  // The fill is a hemisphere light, so its colour is two colours — what the sky pours down and
  // what the ground bounces back up. One well would only ever tint half the scene: set a single
  // "ambient colour" red and every upward-facing surface goes red while every underside stays the
  // colour it was, which reads as the control being broken rather than as a hemisphere.
  const fillSky = swatch(`#${hemi.color.getHexString()}`);
  row(panel, 'Fill sky', fillSky);
  fillSky.addEventListener('input', () => {
    takeManualControl();
    hemi.color.set(fillSky.value);
  });

  const fillGround = swatch(`#${hemi.groundColor.getHexString()}`);
  row(panel, 'Fill ground', fillGround);
  fillGround.addEventListener('input', () => {
    takeManualControl();
    hemi.groundColor.set(fillGround.value);
  });

  const fill = slider(0, 2, 0.05, hemi.intensity);
  const fillValue = row(panel, 'Ambient fill', fill);
  fill.addEventListener('input', () => {
    takeManualControl();
    hemi.intensity = Number(fill.value);
    fillValue.textContent = hemi.intensity.toFixed(2);
  });

  const tint = shadowTint();
  const shadowColour = swatch(tint.color);
  row(panel, 'Shadow colour', shadowColour);
  shadowColour.addEventListener('input', () => {
    setShadowTint({ color: shadowColour.value });
  });

  const shadowAmount = slider(0, 1, 0.01, tint.amount);
  const shadowAmountValue = row(panel, 'Shadow tint', shadowAmount);
  shadowAmount.addEventListener('input', () => {
    setShadowTint({ color: shadowColour.value, amount: Number(shadowAmount.value) });
    shadowAmountValue.textContent = Number(shadowAmount.value).toFixed(2);
  });
  shadowAmountValue.textContent = tint.amount.toFixed(2);

  // Filled in by the haze section below. A stub rather than a direct call because that section is
  // built after this one, so naming its `const` here would be a temporal dead zone waiting for
  // whoever next reorders the panel.
  let syncHazeReadout = () => {};

  /** Pull the controls back into line with the live lights. */
  function refresh() {
    const { hour } = daylight.state;
    hourInput.value = String(hour);
    hourValue.textContent = `${clockLabel(hour)} · ${daylight.elevation().toFixed(0)}° up`;
    pinBox.checked = daylight.aim.pinned;
    bearing.value = String(daylight.azimuth());
    bearingValue.textContent = `${daylight.azimuth().toFixed(0)}° · shade to ${((daylight.azimuth() + 180) % 360).toFixed(0)}°`;
    height.value = String(daylight.elevation());
    heightValue.textContent = `${daylight.elevation().toFixed(0)}° up`;
    sunColour.value = `#${sun.color.getHexString()}`;
    sunPower.value = String(sun.intensity);
    sunPowerValue.textContent = sun.intensity.toFixed(2);
    fillSky.value = `#${hemi.color.getHexString()}`;
    fillGround.value = `#${hemi.groundColor.getHexString()}`;
    fill.value = String(hemi.intensity);
    fillValue.textContent = hemi.intensity.toFixed(2);
    // The haze colour is a function of the sky, so it moves under the cycle without anything here
    // touching it — the readout is what needs telling.
    syncHazeReadout();
  }

  // Only runs while the panel is open — a closed panel has nothing to keep up to date.
  let polling = 0;
  function poll() {
    if (panel.hidden) { polling = 0; return; }
    if (daylight.state.cycling) refresh();
    polling = requestAnimationFrame(poll);
  }

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !polling) polling = requestAnimationFrame(poll);
  });

  // --- Game -----------------------------------------------------------------
  heading('Game');

  // Scrubs the whole ramp. Every knob in difficulty.js is a function of this one number, so the
  // late game — four riders on the board, tight clocks, heavy traffic — is reachable without
  // playing ten fares to get there, and a tweak to it can be looked at immediately.
  //
  // Only what is *derived* live actually moves: clocks are budgeted once at spawn, so the next
  // rider to appear is the first one on the new pace, and the density ramp only ever grows. That
  // is the same asymmetry the panel is already split by — this one sits under Game rather than
  // "Restart to apply" because most of it does take effect, just not retroactively.
  const diff = slider(0, 1, 0.05, difficulty.difficulty(0));
  const diffValue = row(panel, 'Difficulty', diff);
  const showDifficulty = (d) => {
    diffValue.textContent = `${d.toFixed(2)} · ${difficulty.shiftFor(0).name} `
      + `· pace ${difficulty.pace(0).toFixed(2)} · pressure ${difficulty.pressure(0).toFixed(2)}`;
  };
  diff.addEventListener('input', () => {
    const d = Number(diff.value);
    difficulty.pinDifficulty(d);
    showDifficulty(d);
  });
  showDifficulty(difficulty.difficulty(0));

  // The two dials, at both ends of the ramp (see difficulty.js). Pace is a rider's clock over their
  // own trip at cruise — under 1.0 needs Loco Mode. Pressure is riders offered per rider the taxi
  // can serve — over 1.0 means some have to be let go. Like the slider above, a new pace lands on
  // the next rider to spawn rather than on the clocks already running.
  for (const [key, label, min, max] of [
    ['paceStart', 'Pace · start', 0.6, 2],
    ['paceEnd', 'Pace · end', 0.6, 2],
    ['pressureStart', 'Pressure · start', 0.3, 2.5],
    ['pressureEnd', 'Pressure · end', 0.3, 2.5],
  ]) {
    const input = slider(min, max, 0.05, difficulty.getTuning()[key]);
    const value = row(panel, label, input);
    value.textContent = Number(input.value).toFixed(2);
    input.addEventListener('input', () => {
      difficulty.setTuning({ [key]: Number(input.value) });
      value.textContent = Number(input.value).toFixed(2);
      showDifficulty(difficulty.difficulty(0));
    });
  }

  const fareTime = slider(15, 120, 1, fares.getSeconds());
  const fareValue = row(panel, 'Fare clock', fareTime);
  fareValue.textContent = fares.isPinned() ? `${fareTime.value}s · next fare` : 'budgeted';
  fareTime.addEventListener('input', () => {
    // Touching this pins every clock flat, which takes the budget — and so the difficulty curve's
    // main lever — out of the loop. That is the point of it: it is how you hold the clock still
    // while tuning something the budget would otherwise move under you.
    fares.setSeconds(Number(fareTime.value));
    fareValue.textContent = `${fareTime.value}s · next fare · budget off`;
  });

  // Live because it is the whole point: the four modes differ by how much of the road, markings
  // and kerbs they let through, and that is only judgeable against a moving city.
  const blend = dropdown(Object.keys(ROUTE_BLENDS), routeLine.blend());
  row(panel, 'Route blend', blend);
  blend.addEventListener('change', () => routeLine.setBlend(blend.value));

  // Live, and it only reaches the *next* crash: the style is read at detonation. Mirrored into the
  // URL so a Retry that reloads keeps it, and so the choice can be pasted as a link.
  if (wreck) {
    const wreckStyle = dropdown(wreck.styles, wreck.styles.includes(wreck.current) ? wreck.current : 'flat');
    row(panel, 'Wreck fire', wreckStyle);
    wreckStyle.addEventListener('change', () => {
      wreck.set(wreckStyle.value);
      const url = new URL(window.location.href);
      url.searchParams.set('wreck', wreckStyle.value);
      window.history.replaceState(null, '', url);
    });
  }

  // Strength only. Whether the pass runs at all is `?ao=off`, and it has to be a URL flag rather
  // than a control here: the AO lookup is compiled into every prop material at build time, so
  // switching it live would mean recompiling every program in the city (see util/geo.js).
  // Live because the right amount is a judgement about the whole frame — too much and the
  // low-poly facets stop reading as facets, too little and nothing has changed.
  const occlusion = slider(0, 1, 0.05, ao.state.strength);
  occlusion.disabled = !ao.state.enabled;
  const occlusionValue = row(panel, 'Occlusion', occlusion);
  const showOcclusion = () => {
    occlusionValue.textContent = ao.state.enabled
      ? Number(occlusion.value).toFixed(2)
      : 'off · ?ao=on';
  };
  showOcclusion();
  occlusion.addEventListener('input', () => {
    ao.setStrength(Number(occlusion.value));
    showOcclusion();
  });

  // --- Crayon Mode ------------------------------------------------------------
  // `?crayon`. Whether the pass exists at all is a URL flag for the same reason `?ao` is — the
  // paper fetch is compiled into every prop material before a mesh exists — but every number in
  // it is a judgement about a whole frame, so every number in it is live. Three of them in
  // particular cannot be settled any other way: the grain, because the only question is whether
  // the city still reads at play zoom; the ink, because a car is 26px wide and a line drawn for a
  // building is a line drawn across a quarter of it; and the boil, because a rate that looks
  // hand-drawn on a still is television static in motion.
  if (crayon.state.enabled) {
    heading('Crayon');
    const crayonRow = (label, key, min, max, step, format = (v) => v.toFixed(2)) => {
      const el = slider(min, max, step, crayon.state[key]);
      const value = row(panel, label, el);
      value.textContent = format(crayon.state[key]);
      el.addEventListener('input', () => {
        const next = Number(el.value);
        crayon.set(key, next);
        value.textContent = format(next);
      });
    };
    crayonRow('Paper', 'paper', 0, 0.6, 0.01);
    crayonRow('Vignette', 'vignette', 0, 0.5, 0.01);
    crayonRow('Tooth', 'grain', 0, 0.6, 0.01);
    crayonRow('Fibre', 'blotch', 0, 0.4, 0.01);
    crayonRow('Ink', 'line', 0, 1, 0.02);
    crayonRow('Wobble', 'wobble', 0, 4, 0.1, (v) => `${v.toFixed(1)}px`);
    crayonRow('Steps', 'quantize', 0, 1, 0.05);
    crayonRow('Boil', 'boilHz', 0, 24, 1, (v) => (v > 0 ? `${v.toFixed(0)}/s` : 'held'));
  }

  // --- Cartoon Mode -----------------------------------------------------------
  // `?cartoon`, and **every number in it is live** — including the two hull rims, which used to be
  // baked into an inflated geometry and are now a uniform (see `outlineGeometry` in
  // game/cartoon.js). That was worth the change on its own: the weight of an outline is the one
  // thing here nobody can settle from a still. It is a judgement about how hard a car should shout
  // against a city, and it needs the game running and a hand on the slider.
  //
  // The two rims are separate controls rather than one, because the gap between them *is* the
  // mode: a hero reads as a hero because its ink is heavier than everything else's, and a single
  // number would collapse the only distinction being made.
  if (cartoon.state.enabled) {
    heading('Cartoon');
    const toonRow = (label, key, min, max, step, format = (v) => v.toFixed(2)) => {
      const el = slider(min, max, step, cartoon.state[key]);
      const value = row(panel, label, el);
      value.textContent = format(cartoon.state[key]);
      el.addEventListener('input', () => {
        const next = Number(el.value);
        cartoon.set(key, next);
        value.textContent = format(next);
      });
    };

    // The outline first: it is what the mode is for, and what anyone opening this panel came to
    // move. Stated in world units with the pixel count beside it, because a rim is authored in the
    // world and judged on the screen — at play zoom one unit is about 7.7px.
    const px = (v) => `${v.toFixed(2)}u · ${(v * PX_PER_UNIT).toFixed(1)}px`;
    toonRow('Taxi ink', 'taxiRim', 0, 0.6, 0.01, px);
    toonRow('Traffic ink', 'heroRim', 0, 0.6, 0.01, px);
    toonRow('Ink opacity', 'inkOpacity', 0.1, 1, 0.05);

    const inkColor = swatch(cartoon.state.inkColor);
    const inkValue = row(panel, 'Ink', inkColor);
    inkValue.textContent = cartoon.state.inkColor;
    inkColor.addEventListener('input', () => {
      cartoon.set('inkColor', inkColor.value);
      inkValue.textContent = inkColor.value;
    });

    // Then the city's own line, and the light behind it.
    toonRow('City line', 'ink', 0, 1, 0.02);
    toonRow('Line bite', 'bite', 0, 0.9, 0.02);
    toonRow('Cel', 'cel', 0, 1, 0.05);
    toonRow('Bands', 'steps', 2, 6, 1, (v) => v.toFixed(0));
  }

  // --- Bloom ------------------------------------------------------------------
  // Spill around the lamps (game/bloom.js). Split into the three numbers that shape the *whole*
  // effect and then one per kind of lamp, because those are two different jobs: the first three are
  // "what does bloom look like in this game", the rest are "how much does this particular thing
  // deserve", and mixing them into one slider is how a brake light ends up tuned against a
  // shopfront.
  //
  // The three masters are three because they answer different questions and are not
  // interchangeable. `Lamps` is how far past 1 a light is written — it sets the *shape* of the
  // falloff and whether a core whitens. `Spill` is how much of the blurred result reaches the
  // frame. `Reach` is how the blur chain's levels are weighted against each other: low is a tight
  // hot core, high is a wide soft wash, and at 1 the levels sum to a flat lift over the whole frame
  // and the glow becomes a fog (see LEVEL_WEIGHT). Turning one up and another down is a different
  // picture from leaving all three alone, and no still frame settles which.
  // --- Car finish -------------------------------------------------------------
  // The four vehicle finishes (util/geo.js, FINISH_DEFAULTS). One set of sliders retargeted by the
  // picker rather than four sets of ten, which would be most of the panel. All live: the numbers
  // are shared uniforms, so a slider reaches every car without recompiling anything.
  heading('Car finish');
  // Freeze the world and get the camera in close: a car is ~25px long at play zoom, which is no
  // size to judge a glint at. `I` toggles it from the keyboard too, `N` steps through the cars and
  // the wheel or a pinch zooms. Drag to pan.
  if (inspect) {
    const tools = document.createElement('div');
    tools.className = 'dbg-wide';
    tools.style.cssText = 'display:flex;gap:4px;';
    const tool = (label, title, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.style.flex = '1';
      b.addEventListener('click', onClick);
      tools.append(b);
      return b;
    };
    const freeze = tool('Freeze & zoom', 'Freeze the game and zoom in (I)', () => {
      inspect.toggle();
      sync();
    });
    tool('Taxi', 'Centre on the taxi', () => { if (inspect.state.on) inspect.focusTaxi(); });
    tool('Next car', 'Centre on the next car out from the taxi (N)', () => {
      if (inspect.state.on) inspect.nextCar();
    });
    tool('−', 'Zoom out (-)', () => { if (inspect.state.on) inspect.zoomOut(); });
    tool('+', 'Zoom in (+)', () => { if (inspect.state.on) inspect.zoomIn(); });
    const sync = () => { freeze.textContent = inspect.state.on ? 'Resume' : 'Freeze & zoom'; };
    // The key toggles it behind the panel's back, so the label is re-read rather than trusted.
    window.addEventListener('keydown', (event) => { if (event.code === 'KeyI') setTimeout(sync); });
    panel.append(tools);
  }
  const finishPick = dropdown(FINISH_NAMES, 'paint');
  row(panel, 'Finish', finishPick);
  const FINISH_FIELDS = [
    ['glint', 'Glint', 0, 3, 0.01],
    ['glintSharp', 'Glint sharpness', 1, 1000, 1],
    ['glintBend', 'Glint bend', 0, 2, 0.01],
    ['sheen', 'Sheen', 0, 1, 0.005],
    ['sheenSharp', 'Sheen sharpness', 1, 200, 1],
    ['flake', 'Flake', 0, 1, 0.01],
    ['reflect', 'Reflect', 0, 1, 0.005],
    ['reflectEdge', 'Reflect edge', 0, 1, 0.005],
    ['reflectBend', 'Reflect bend', 0, 2, 0.01],
    ['diffuse', 'Base colour', 0, 2, 0.01],
    ['flakeTilt', 'Flake tilt', 0, 1, 0.01],
    ['flakeSharp', 'Flake sharpness', 1, 3000, 1],
    ['coat', 'Clear coat', 0, 3, 0.01],
    ['tint', 'Metallic tint', 0, 1, 0.01],
    ['flop', 'Flop', 0, 1, 0.01],
  ];
  const finishSliders = FINISH_FIELDS.map(([key, label, min, max, step]) => {
    const input = slider(min, max, step, 0);
    const value = row(panel, label, input);
    const show = () => { value.textContent = Number(input.value).toFixed(step < 1 ? 3 : 0); };
    input.addEventListener('input', () => {
      setGlossFinish(finishPick.value, key, Number(input.value));
      show();
    });
    return { key, input, show };
  });
  const syncFinish = () => {
    const live = glossTuning().finishes[finishPick.value];
    for (const s of finishSliders) { s.input.value = String(live[s.key]); s.show(); }
  };
  finishPick.addEventListener('change', syncFinish);

  const flakeSize = slider(2, 40, 0.5, glossTuning().global.flakeSize);
  const flakeSizeValue = row(panel, 'Flake size', flakeSize);
  flakeSize.addEventListener('input', () => {
    setGlossGlobal('flakeSize', Number(flakeSize.value));
    flakeSizeValue.textContent = `${Number(flakeSize.value).toFixed(1)}/u`;
  });
  const facade = slider(0, 1, 0.01, glossTuning().global.facade);
  const facadeValue = row(panel, 'Façade dark', facade);
  facade.addEventListener('input', () => {
    setGlossGlobal('facade', Number(facade.value));
    facadeValue.textContent = Number(facade.value).toFixed(2);
  });
  const showFinishes = document.createElement('input');
  showFinishes.type = 'checkbox';
  showFinishes.checked = glossTuning().global.showFinishes;
  row(panel, 'Show finishes', showFinishes);
  showFinishes.addEventListener('change', () => setGlossGlobal('showFinishes', showFinishes.checked));

  const syncFinishGlobals = () => {
    const g = glossTuning().global;
    flakeSize.value = String(g.flakeSize);
    flakeSizeValue.textContent = `${g.flakeSize.toFixed(1)}/u`;
    facade.value = String(g.facade);
    facadeValue.textContent = g.facade.toFixed(2);
    showFinishes.checked = g.showFinishes;
  };
  syncFinish();
  syncFinishGlobals();

  // The rim line (util/geo.js, `gRimEdge`). Live on every look but classic; `?rim=off` compiles it
  // out, and then these move nothing.
  const RIM_FIELDS = [
    ['width', 'Rim width', 1, 12, 0.5, 1],
    ['strength', 'Rim strength', 0, 8, 0.05, 2],
    ['sky', 'Rim sky', 0, 2, 0.05, 2],
    ['carColour', 'Rim car colour', 0, 1, 0.05, 2],
    ['gap', 'Rim depth gap', 0.05, 2, 0.05, 2],
    // Toon and rim looks only. Higher is a smaller highlight; past 1 it is gone.
    ['glintCut', 'Toon glint cut', 0.97, 1.001, 0.001, 3],
    ['sheenCut', 'Toon sheen cut', 0.8, 1.01, 0.005, 3],
    ['flip', 'Flip colour', 0, 1, 0.05, 2],
    ['flipPower', 'Flip falloff', 0.5, 4, 0.1, 1],
    ['streaks', 'Reflection streaks', 0, 2, 0.05, 2],
  ];
  const rimStart = rimTuning();
  for (const [key, label, min, max, step, digits] of RIM_FIELDS) {
    const input = slider(min, max, step, rimStart[key]);
    const value = row(panel, label, input);
    const show = () => { value.textContent = Number(input.value).toFixed(digits); };
    input.addEventListener('input', () => { setRimTuning(key, Number(input.value)); show(); });
    show();
  }

  const resetFinish = document.createElement('button');
  resetFinish.type = 'button';
  resetFinish.className = 'dbg-wide';
  resetFinish.textContent = 'Reset car finishes';
  resetFinish.addEventListener('click', () => {
    resetGlossTuning();
    syncFinish();
    syncFinishGlobals();
  });
  panel.append(resetFinish);

  if (bloom.state.enabled) {
    heading('Bloom');
    const bloomRow = (label, key, min, max, step, format = (v) => v.toFixed(2), read = null) => {
      const initial = read ? read() : bloom.state[key];
      const el = slider(min, max, step, initial);
      const value = row(panel, label, el);
      value.textContent = format(initial);
      el.addEventListener('input', () => {
        const next = Number(el.value);
        bloom.set(key, next);
        value.textContent = format(next);
      });
    };
    bloomRow('Spill', 'strength', 0, 2, 0.05);
    // Shown as what a brake pod is actually written at, since that is the lamp anyone judging this
    // is looking at — the slider is a multiplier over every kind at once.
    bloomRow('Lamps', 'intensity', 0, 3, 0.05,
      (v) => `${v.toFixed(2)}x · pod ${(v * BLOOM_INTENSITY.pod).toFixed(1)}`);
    bloomRow('Reach', 'reach', 0, 1, 0.05,
      (v) => (v >= 0.95 ? `${v.toFixed(2)} — fog` : v.toFixed(2)));

    // Then one row per kind of lamp. Generated off `BLOOM_KINDS` rather than listed here, so
    // anything that gets marked with a new kind arrives with its own slider instead of being
    // stuck on whatever `markEmissive` was given.
    //
    // The two read-outs at the bottom of the list — a fare's crystal and its disc — are the ones
    // worth being careful with rather than the ones worth turning up: **their hue is the clock**,
    // and bloom desaturates toward white as it saturates, so past a point they stop reporting the
    // number the player is racing. They are in the list because that judgement is the player's to
    // make with the game running, not because they want to be loud.
    for (const kind of BLOOM_KINDS) {
      const label = kind.charAt(0).toUpperCase() + kind.slice(1);
      bloomRow(label, kind, 0, 8, 0.1, (v) => v.toFixed(1), () => BLOOM_INTENSITY[kind]);
    }

    // Not a knob: a device without a renderable half-float target still gets a bloom, out of an
    // RGBA8 buffer that clips every lamp at 1. Worth saying, because it is the difference between
    // a core that whitens and one that is flat, and nothing else on screen reports it.
    row(panel, 'Buffer', document.createTextNode('')).textContent = bloom.state.hdr
      ? 'RGBA16F' : 'RGBA8 — clipped';
  }

  // --- HDR ----------------------------------------------------------------------
  // `?hdr`: the whole frame through a composer with tone mapping on (game/hdr.js). A comparison
  // rather than a shipped mode, and `Exposure` is the row that makes the comparison honest — the
  // city's palette was authored with no tone curve at all, so the first thing anyone looks for is
  // where to put the exposure to get the colours back, and the answer is that you cannot.
  if (hdr.state.enabled) {
    heading('HDR');
    const hdrRow = (label, key, min, max, step, format = (v) => v.toFixed(2)) => {
      const el = slider(min, max, step, hdr.state[key]);
      const value = row(panel, label, el);
      value.textContent = format(hdr.state[key]);
      el.addEventListener('input', () => {
        const next = Number(el.value);
        hdr.set(key, next);
        value.textContent = format(next);
      });
    };
    hdrRow('Exposure', 'exposure', 0.2, 2.5, 0.05);
    hdrRow('Strength', 'strength', 0, 2, 0.05);
    hdrRow('Radius', 'radius', 0, 1, 0.05);
    hdrRow('Threshold', 'threshold', 0, 1.5, 0.05);
  }

  // --- CRT ----------------------------------------------------------------------
  // The CRT screen (game/crt.js). All live: it is a pass over the finished frame, so nothing here
  // recompiles. `Strength` is a master over the six below it; the presets are Grog's.
  if (crt.state.enabled) {
    heading('CRT');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = crt.state.enabled;
    row(panel, 'CRT screen', on);
    on.addEventListener('change', () => crt.set('enabled', on.checked));
    const syncs = [];
    for (const [key, label, min, max, digits] of CRT_SLIDERS) {
      const input = slider(min, max, 10 ** -digits, crt.state[key]);
      const value = row(panel, label, input);
      const show = () => { input.value = String(crt.state[key]); value.textContent = crt.state[key].toFixed(digits); };
      input.addEventListener('input', () => { crt.set(key, Number(input.value)); show(); });
      show();
      syncs.push(show);
    }
    const presets = document.createElement('div');
    presets.className = 'dbg-wide';
    for (const name of ['Default', ...Object.keys(CRT_PRESETS)]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', () => { crt.preset(name); syncs.forEach((s) => s()); });
      presets.append(b);
    }
    panel.append(presets);
  }

  // --- Colour grade -----------------------------------------------------------
  // A LUT, photo-editor knobs baked into it, and a saturation knob over the whole frame
  // (game/colorgrade.js). All live, and all remembered across reloads — a grade is a judgement made
  // over several sessions of play, not one look at a slider. Neutral until something here moves.
  //
  // Built to be used on a phone, where the panel covers most of the city it is grading: while a
  // finger is on one of these controls the rest of the panel goes invisible (`dbg-scrub`), so the
  // frame under it can be judged as the knob moves — the way a phone's photo editor hides its chrome
  // mid-drag. Hold to compare does the same and draws the ungraded frame.
  heading('Colour grade');
  {
    const g = colorGrade();
    const scrubStart = (holder) => {
      panel.classList.add('dbg-scrub');
      holder.classList.add('is-scrubbing');
      const end = () => {
        panel.classList.remove('dbg-scrub');
        holder.classList.remove('is-scrubbing');
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      };
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
      return end;
    };
    // A second press inside 300 ms puts the knob back at rest, so a stray drag costs nothing. Timed
    // by hand rather than on `dblclick`, which iOS does not send for a range input.
    const scrubbable = (input, zero = null) => {
      let last = 0;
      input.addEventListener('pointerdown', (event) => {
        const end = scrubStart(input.closest('.dbg-row') ?? input);
        if (zero && event.timeStamp - last < 300) {
          const up = () => { zero(); window.removeEventListener('pointerup', up, true); end(); };
          window.addEventListener('pointerup', up, true);
          last = 0;
        } else {
          last = event.timeStamp;
        }
      });
    };
    const sub = (text) => {
      const el = document.createElement('p');
      el.className = 'dbg-sub';
      el.textContent = text;
      panel.append(el);
    };

    const compare = document.createElement('button');
    compare.type = 'button';
    compare.className = 'dbg-wide dbg-hold';
    compare.dataset.search = 'compare before after grade';
    compare.innerHTML = '<span>Hold to compare</span>';
    compare.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      compare.setPointerCapture?.(event.pointerId);
      setGradeBypass(true);
      const end = scrubStart(compare);
      const release = () => {
        setGradeBypass(false);
        end();
        compare.removeEventListener('pointerup', release);
        compare.removeEventListener('pointercancel', release);
      };
      compare.addEventListener('pointerup', release);
      compare.addEventListener('pointercancel', release);
    });
    // iOS selects the label and raises the magnifier off the raw touch stream (see CLAUDE.md).
    compare.addEventListener('touchstart', (event) => { if (event.cancelable) event.preventDefault(); }, { passive: false });
    panel.append(compare);

    sub('Look');
    const fileOption = 'file';
    const look = dropdown([...Object.keys(GRADE_PRESETS), fileOption], g.preset);
    look.querySelector(`option[value="${fileOption}"]`).textContent = g.preset === fileOption ? `file: ${g.cubeName}` : 'file…';
    look.querySelector(`option[value="${fileOption}"]`).disabled = g.preset !== fileOption;
    row(panel, 'LUT', look);

    const status = document.createElement('p');
    status.className = 'dbg-note';
    status.dataset.search = 'lut cube file grade';

    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.cube';
    picker.hidden = true;
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'dbg-wide';
    load.textContent = 'Load .cube file…';
    load.addEventListener('click', () => picker.click());

    const strength = slider(0, 1, 0.01, g.strength);
    const strengthValue = row(panel, 'LUT strength', strength);
    scrubbable(strength, () => { setGradeStrength(1); show(); });
    panel.append(load, picker);

    // One row per knob in ADJUST_RANGES that is a plain slider. The hue rows show their colour in
    // the readout, because a number of degrees means nothing to look at.
    const knobs = [];
    const knob = (label, key, min, max, step, format = (v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))) => {
      const el = slider(min, max, step, g.adjust[key]);
      const value = row(panel, label, el);
      scrubbable(el, key.endsWith('Hue') ? null : () => { setGradeAdjust(key, 0); show(); });
      el.addEventListener('input', () => { setGradeAdjust(key, Number(el.value)); show(); });
      knobs.push({ el, value, key, format });
    };
    const hueFormat = (v) => `${Math.round(v)}°`;
    sub('Light');
    knob('Exposure', 'exposure', -2, 2, 0.01, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} stops`);
    knob('Contrast', 'contrast', -1, 1, 0.01);
    knob('Warmth', 'temperature', -1, 1, 0.01);
    knob('Tint', 'tint', -1, 1, 0.01);
    sub('Tone');
    knob('Shadows', 'shadows', -1, 1, 0.01);
    knob('Midtones', 'midtones', -1, 1, 0.01);
    knob('Highlights', 'highlights', -1, 1, 0.01);
    sub('Colour');
    const saturation = slider(0, 2, 0.01, g.saturation);
    const saturationValue = row(panel, 'Saturation', saturation);
    scrubbable(saturation, () => { setGradeSaturation(1); show(); });
    knob('Vibrance', 'vibrance', -1, 1, 0.01);
    knob('Shadow colour', 'shadowHue', 0, 360, 1, hueFormat);
    knob('Shadow amount', 'shadowAmount', 0, 1, 0.01, (v) => v.toFixed(2));
    knob('Highlight colour', 'highlightHue', 0, 360, 1, hueFormat);
    knob('Highlight amount', 'highlightAmount', 0, 1, 0.01, (v) => v.toFixed(2));

    // --- Curves: five knots per channel on a canvas, dragged up and down with a finger. ---
    sub('Curves');
    const curveBox = document.createElement('div');
    curveBox.className = 'dbg-curve';
    curveBox.dataset.search = 'curves rgb red green blue tone';
    const channelBar = document.createElement('div');
    channelBar.className = 'dbg-curve-tabs';
    const INK = { rgb: '#ececee', r: '#ff6b6b', g: '#5fd38a', b: '#6aa0ff' };
    let channel = 'rgb';
    const channelButtons = CURVE_CHANNELS.map((ch) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = ch.toUpperCase();
      button.style.setProperty('--ink', INK[ch]);
      button.addEventListener('click', () => { channel = ch; drawCurve(); });
      channelBar.append(button);
      return button;
    });
    const canvas = document.createElement('canvas');
    const flatten = document.createElement('button');
    flatten.type = 'button';
    flatten.textContent = 'Flatten';
    flatten.addEventListener('click', () => { resetGradeCurve(channel); show(); });
    channelBar.append(flatten);
    curveBox.append(channelBar, canvas);
    panel.append(curveBox);

    const CURVE_W = 256;
    const CURVE_H = 180;
    const PAD = 8;
    const ctx = canvas.getContext('2d');
    function drawCurve() {
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== CURVE_W * dpr) { canvas.width = CURVE_W * dpr; canvas.height = CURVE_H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CURVE_W, CURVE_H);
      const w = CURVE_W - PAD * 2;
      const h = CURVE_H - PAD * 2;
      const X = (x) => PAD + x * w;
      const Y = (y) => PAD + (1 - y) * h;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      for (let q = 0; q <= 4; q++) {
        ctx.beginPath(); ctx.moveTo(X(q / 4), Y(0)); ctx.lineTo(X(q / 4), Y(1)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(0), Y(q / 4)); ctx.lineTo(X(1), Y(q / 4)); ctx.stroke();
      }
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
      ctx.setLineDash([]);
      const order = [...CURVE_CHANNELS.filter((ch) => ch !== channel), channel];
      for (const ch of order) {
        const on = ch === channel;
        ctx.strokeStyle = INK[ch];
        ctx.globalAlpha = on ? 1 : 0.28;
        ctx.lineWidth = on ? 2 : 1;
        ctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const x = i / 64;
          const y = curveAt(ch, x);
          if (i) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const ys = colorGrade().adjust.curve[channel];
      ctx.fillStyle = INK[channel];
      for (let i = 0; i < ys.length; i++) {
        ctx.beginPath(); ctx.arc(X(i / 4), Y(ys[i]), 5, 0, Math.PI * 2); ctx.fill();
      }
      for (const b of channelButtons) b.classList.toggle('is-active', b.textContent.toLowerCase() === channel);
    }
    // A knot is picked by x alone — they sit on fixed inputs, so the nearest column is the one the
    // finger meant, and the hit target is a quarter of the canvas wide rather than a 10px dot.
    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      const rect = canvas.getBoundingClientRect();
      const toCurve = (e) => ({
        x: ((e.clientX - rect.left) / rect.width * CURVE_W - PAD) / (CURVE_W - PAD * 2),
        y: 1 - ((e.clientY - rect.top) / rect.height * CURVE_H - PAD) / (CURVE_H - PAD * 2),
      });
      const index = Math.max(0, Math.min(4, Math.round(toCurve(event).x * 4)));
      const end = scrubStart(curveBox);
      const move = (e) => { setGradeCurve(channel, index, toCurve(e).y); show(); };
      const up = () => {
        end();
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
      };
      move(event);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });
    canvas.addEventListener('touchstart', (event) => { if (event.cancelable) event.preventDefault(); }, { passive: false });

    // --- Taking a look away: the code is what to send back to be shipped as the default. ---
    sub('Share');
    const code = document.createElement('textarea');
    code.className = 'dbg-out';
    code.rows = 3;
    code.spellcheck = false;
    code.dataset.search = 'look code copy paste share grade';
    code.addEventListener('keydown', (event) => event.stopPropagation());
    code.addEventListener('keyup', (event) => event.stopPropagation());
    const actions = document.createElement('div');
    actions.className = 'dbg-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy look';
    copy.addEventListener('click', async () => {
      code.value = lookCode();
      try {
        await navigator.clipboard.writeText(code.value);
        status.textContent = 'Look copied. Paste it into the chat to make it the shipped default.';
      } catch {
        code.select();
        status.textContent = 'Could not reach the clipboard — the look is selected in the box above.';
      }
    });
    const paste = document.createElement('button');
    paste.type = 'button';
    paste.textContent = 'Apply pasted look';
    paste.addEventListener('click', () => {
      try {
        setLookCode(code.value);
        show();
        status.textContent = 'Look applied.';
      } catch (err) {
        status.textContent = `Couldn't apply it: ${err.message}`;
      }
    });
    actions.append(copy, paste);
    panel.append(code, actions);

    const show = () => {
      const now = colorGrade();
      strength.value = String(now.strength);
      strengthValue.textContent = now.strength.toFixed(2);
      saturation.value = String(now.saturation);
      saturationValue.textContent = now.saturation.toFixed(2);
      for (const k of knobs) {
        const v = now.adjust[k.key];
        k.el.value = String(v);
        k.value.textContent = k.format(v);
        k.value.style.color = k.key.endsWith('Hue') ? `hsl(${v}, 80%, 65%)` : '';
      }
      look.value = now.preset;
      const opt = look.querySelector(`option[value="${fileOption}"]`);
      opt.textContent = now.preset === fileOption ? `file: ${now.cubeName}` : 'file…';
      opt.disabled = now.preset !== fileOption;
      if (document.activeElement !== code) code.value = lookCode();
      status.textContent = now.active ? 'Grading the frame. Double-tap a slider to zero it.' : 'Neutral — no grade at all, as ?grade=classic draws it.';
      drawCurve();
    };

    look.addEventListener('change', () => { setGradePreset(look.value); show(); });
    strength.addEventListener('input', () => { setGradeStrength(Number(strength.value)); show(); });
    saturation.addEventListener('input', () => { setGradeSaturation(Number(saturation.value)); show(); });
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      try {
        const parsed = setGradeCube(await file.text(), file.name);
        show();
        status.textContent = `Loaded ${file.name} (${parsed.size}³${parsed.title ? `, "${parsed.title}"` : ''}).`;
      } catch (err) {
        status.textContent = `Couldn't use ${file.name}: ${err.message}`;
      }
    });

    // The grade with everything folded in, as one .cube — for a grading app, or for a loaded file
    // the look code cannot carry.
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'dbg-wide';
    download.textContent = 'Download baked .cube';
    download.addEventListener('click', () => {
      const blob = new Blob([toCube(bakedTable())], { type: 'text/plain' });
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob), download: 'rocket-rides-grade.cube',
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    const resetKnobs = document.createElement('button');
    resetKnobs.type = 'button';
    resetKnobs.className = 'dbg-wide';
    resetKnobs.textContent = 'Reset sliders and curves';
    resetKnobs.addEventListener('click', () => { resetGradeAdjust(); show(); });

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'dbg-wide';
    reset.textContent = 'Reset grade';
    reset.addEventListener('click', () => { resetGrade(); show(); });

    panel.append(download, resetKnobs, reset, status);
    show();
  }

  // --- Haze -------------------------------------------------------------------
  // Atmospheric perspective (game/scene.js). All three are live and none of them needs a
  // recompile — two planes and a colour on a fog object — and all three want to be live, because
  // every one of them is a judgement about a whole frame that cannot be made from the numbers. The
  // only way to know whether the back of the city has separated from the front is to watch the
  // front stay put while the back moves.
  heading('Haze');

  /**
   * Rebuild the fog colour from whatever the sky is showing *now*.
   *
   * Off the dome's live uniforms rather than through `daylight.apply()`, which would be the obvious
   * way and is wrong: apply() rewrites the sun's colour and intensity too, so tweaking the haze
   * would silently throw away a sun the player had picked by hand two rows up. This touches the one
   * thing the sliders are for.
   */
  const restyleHaze = () => {
    if (!fog) return;
    hazeColor(sky.uniforms.topColor.value, sky.uniforms.bottomColor.value, fog.color);
  };

  const haze = slider(0, 0.5, 0.01, HAZE_TOP);
  haze.disabled = !fog;
  const hazeValue = row(panel, 'Strength', haze);
  const showHaze = () => {
    hazeValue.textContent = fog ? `${Number(haze.value).toFixed(2)} at the frame's top edge` : 'no fog';
  };
  showHaze();
  haze.addEventListener('input', () => {
    if (fog) setHazeTop(fog, Number(haze.value));
    showHaze();
  });

  // How far up the dome's gradient the colour is sampled. 0 is the horizon — a near-white at most
  // hours, which is what made the far city read as grey — and 1 is the sky directly overhead, which
  // is the wrong colour at dusk. See the note on `hazeColor`.
  const hazeSky = slider(0, 1, 0.01, hazeTuning.skyH);
  hazeSky.disabled = !fog;
  const hazeSkyValue = row(panel, 'Sky sample', hazeSky);

  // Hue is never touched, so this only moves how strongly the haze states whatever colour the sky
  // is at that hour. Past ~2 the parked afternoon starts reading as coloured smoke.
  const hazeSat = slider(1, 2.5, 0.05, hazeTuning.saturation);
  hazeSat.disabled = !fog;
  const hazeSatValue = row(panel, 'Chroma', hazeSat);

  // The colour that falls out, as a hex — this is the number that goes into `PALETTE.fog` if a
  // tweak is worth keeping, and the one thing about the haze the sliders themselves can't show.
  const hazeSwatch = document.createElement('input');
  hazeSwatch.type = 'color';
  hazeSwatch.disabled = true;                 // a readout, not an input: the colour is derived
  const hazeHex = row(panel, 'Haze colour', hazeSwatch);

  const showHazeColour = () => {
    hazeSkyValue.textContent = `${Number(hazeSky.value).toFixed(2)} up the dome`;
    hazeSatValue.textContent = `${Number(hazeSat.value).toFixed(2)}x`;
    if (!fog) { hazeHex.textContent = 'no fog'; return; }
    const hex = `#${fog.color.getHexString().toUpperCase()}`;
    hazeSwatch.value = hex;
    hazeHex.textContent = hex;
  };
  showHazeColour();
  syncHazeReadout = showHazeColour;

  for (const [el, key] of [[hazeSky, 'skyH'], [hazeSat, 'saturation']]) {
    el.addEventListener('input', () => {
      hazeTuning[key] = Number(el.value);
      restyleHaze();
      showHazeColour();
    });
  }

  // --- Clouds -----------------------------------------------------------------
  // Every one of these is a judgement about a whole frame and none of them can be made from the
  // numbers, which is the same argument the haze sliders above are here for — with one extra reason
  // of its own: what the player sees of the sky depends on the *shape of their window*, and the
  // band that reads as weather on a desktop is a band a portrait phone never gets to see. So this
  // section exists to be dragged on the device in question.
  if (clouds) {
    heading('Clouds');

    const amount = slider(0, clouds.POOL, 1, clouds.state.count);
    const amountValue = row(panel, 'Amount', amount);
    const showAmount = () => { amountValue.textContent = `${clouds.state.count} in the sky`; };
    showAmount();
    amount.addEventListener('input', () => {
      clouds.setCount(Number(amount.value));
      showAmount();
    });

    // How far the band comes in over the city's edge, and how deep it is. Measured against where the
    // sky actually is: 91% of the visible sky sits within 30 units of the island's edge on a
    // portrait phone, so the two together have a budget of about 30 before the clouds are behind the
    // top of the frame rather than in it. Negative overlap holds them off the coast entirely.
    const distance = slider(-10, 30, 0.5, clouds.state.overlap);
    const distanceValue = row(panel, 'Over the coast', distance);
    const spread = slider(0, 40, 1, clouds.state.band);
    const spreadValue = row(panel, 'Band depth', spread);
    const showBand = () => {
      const overlap = Number(distance.value);
      distanceValue.textContent = overlap >= 0
        ? `${overlap.toFixed(1)} in over the edge`
        : `${(-overlap).toFixed(1)} clear of it`;
      spreadValue.textContent = `${spread.value} deep`;
    };
    showBand();
    for (const el of [distance, spread]) {
      el.addEventListener('input', () => {
        clouds.setBand(Number(distance.value), Number(spread.value));
        showBand();
      });
    }

    const drift = slider(0, 3, 0.05, clouds.state.speed);
    const driftValue = row(panel, 'Drift', drift);
    const showDrift = () => { driftValue.textContent = `${Number(drift.value).toFixed(2)}x`; };
    showDrift();
    drift.addEventListener('input', () => {
      clouds.setSpeed(Number(drift.value));
      showDrift();
    });

    // The other reading of the brief, kept as a knob rather than an argument: clouds *over* the
    // play area. It is off by default because one of them passing over the taxi takes the taxi off
    // the screen, and the taxi is what the player is steering — but that is a judgement, and this
    // is the row that lets it be made by looking rather than by arguing.
    const over = slider(0, clouds.POOL, 1, clouds.state.over);
    const overValue = row(panel, 'Over the city', over);
    const showOver = () => {
      overValue.textContent = clouds.state.over ? `${clouds.state.over} across the map` : 'none — all at the edges';
    };
    showOver();
    over.addEventListener('input', () => {
      clouds.setOver(Number(over.value));
      showOver();
    });
  }

  // --- Loco Mode --------------------------------------------------------------
  // The speed ramp, live. Every knob here is read by sim/traffic.js on the frame after it moves,
  // so the way to use this section is with the boost button held down: drag, feel, drag again.
  //
  // The curve above the sliders is drawn from `loco.ramp()` — the sim module's own integrator over
  // the same tuning the physics reads — rather than from a formula written out again here. A
  // preview with its own copy of the maths is a preview that can be wrong, and it would be wrong
  // in the direction that matters: it would go on looking right after somebody changed the sim.
  heading('Loco Mode');

  const PREVIEW_W = 230, PREVIEW_H = 76;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs) => {
    const node = document.createElementNS(svgNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const preview = svgEl('svg', {
    class: 'dbg-ramp', viewBox: `0 0 ${PREVIEW_W} ${PREVIEW_H}`, 'aria-hidden': 'true',
  });
  const cruiseLine = svgEl('line', { class: 'dbg-ramp-ref' });
  const capLine = svgEl('line', { class: 'dbg-ramp-ref' });
  const heldPath = svgEl('path', { class: 'dbg-ramp-curve' });
  const coastPath = svgEl('path', { class: 'dbg-ramp-curve coast' });
  preview.append(cruiseLine, capLine, heldPath, coastPath);
  panel.append(preview);

  const rampNote = document.createElement('p');
  rampNote.className = 'dbg-note';
  panel.append(rampNote);

  const mph = (v) => Math.round(v * MPH_PER_UNIT);
  /** A speed, in both units — the panel's whole vocabulary for "how fast is that". */
  const speedText = (v) => `${v.toFixed(2)} u/s · ${mph(v)} mph`;
  /** The speed the weave's wavelengths turn into a frequency against — itself a slider. */
  const boostCruiseOf = () => SPEED * loco.get().speed;

  /** Redraw the curve and the line under it from whatever the tuning currently is. */
  function paintRamp() {
    const tuning = loco.get();
    const samples = loco.ramp();
    const top = SPEED * tuning.overdriveSpeed;
    const cap = SPEED * tuning.speed;
    const extent = Math.max(1, samples[samples.length - 1].s);
    const ceiling = Math.max(top, SPEED) * 1.08;
    const x = (s) => (s / extent) * PREVIEW_W;
    const y = (v) => PREVIEW_H - (v / ceiling) * (PREVIEW_H - 2) - 1;

    for (const [line, v] of [[cruiseLine, SPEED], [capLine, cap]]) {
      line.setAttribute('x1', 0); line.setAttribute('x2', PREVIEW_W);
      line.setAttribute('y1', y(v)); line.setAttribute('y2', y(v));
    }

    const releaseAt = samples.findIndex((p) => p.release);
    const cut = releaseAt === -1 ? samples.length : releaseAt + 1;
    const d = (rows) => rows
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.s).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    heldPath.setAttribute('d', d(samples.slice(0, cut)));
    coastPath.setAttribute('d', releaseAt === -1 ? '' : d(samples.slice(releaseAt)));

    // What the curve costs, which is the reading the shape alone can't give: the top end is only
    // ever worth what the road it needs is worth, and the city's blocks are 20 units apart.
    const reached = samples.find((p) => p.v >= top - 1e-3);
    rampNote.textContent = reached
      ? `top ${speedText(top)} after ${reached.s.toFixed(0)}u `
        + `· ${(reached.s / PITCH).toFixed(1)} blocks of clear straight`
      : `never reaches ${speedText(top)} — band accel too low`;
  }

  /** Everything in the Loco block that has to follow a change anywhere else in it. */
  function repaintLoco() {
    paintRamp();
    showWeaveRoom();
  }

  const locoLevers = [];

  // What the tuning is doing about surviving a reload. A wreck ends the run and Retry is a page
  // reload, so without this the sliders go back to shipped at exactly the moment somebody is most
  // likely to be mid-experiment — you crank the ceiling, crash *because* you cranked it, and start
  // again. The line reports rather than promises: storage can be refused (Safari private mode
  // throws on the write while reporting a healthy object), and a panel that claims a save that
  // didn't happen is worse than one that says nothing.
  const stashNote = document.createElement('p');
  stashNote.className = 'dbg-note';

  const atDefaults = () => Object.keys(loco.defaults)
    .every((key) => loco.get()[key] === loco.defaults[key]);

  let stashSaved = true;

  function showStash(restored = false) {
    if (atDefaults()) {
      stashNote.textContent = restored ? 'restored · shipped values' : 'shipped values';
    } else if (stashSaved) {
      stashNote.textContent = restored
        ? 'restored from your last session · survives a reload'
        : 'saved · survives a reload';
    } else {
      stashNote.textContent = 'not saved — storage unavailable';
    }
  }

  const saveLoco = () => {
    stashSaved = loco.save();
    showStash();
  };

  /** One knob: applies live on input, repaints the curve, and reports what it just bought. */
  function locoLever(label, key, min, max, step, show) {
    const el = slider(min, max, step, loco.get()[key]);
    const value = row(panel, label, el);
    // Read back from the tuning rather than off the slider: `setLocoTuning` clamps the overdrive
    // ceiling up to the boost cap, so the value that landed is not always the one that was
    // dragged, and a readout showing the drag rather than the result is a lie about the sim.
    const sync = () => {
      const landed = loco.get()[key];
      el.value = String(landed);
      value.textContent = show(landed);
    };
    el.addEventListener('input', () => {
      loco.set({ [key]: Number(el.value) });
      sync();
      repaintLoco();
    });
    // Stashed on release rather than on every input. A drag fires `input` per pixel, and
    // `localStorage.setItem` is synchronous — writing the whole tuning a hundred times across one
    // slider drag is the kind of thing that makes a tuning panel feel worse the more it does.
    el.addEventListener('change', saveLoco);
    sync();
    locoLevers.push(sync);
  }

  // The ranges go far past anything shippable on purpose — the question these sliders exist to
  // answer is "how does *much* faster feel", and a slider that stops at 1.5x the shipped value
  // cannot answer it. The tops are where the game stops being a game rather than where it stops
  // being tuned: 20x cruise is 170 u/s, which crosses the whole 100-unit city in 0.6s.
  //
  // Two things genuinely break up there, and both are the game telling the truth rather than a bug
  // to fix. **Collisions start to tunnel** past ~135 u/s, where one frame at 60fps covers more
  // than the 2.31-unit collision envelope and the taxi passes through cars instead of hitting
  // them. And **`LOOKAHEAD` is 32 units**, so above about 26 u/s the taxi is already travelling
  // faster than it can see far enough ahead to brake for — which is most of what "significantly
  // faster" actually feels like from the driving seat.
  //
  // The step stays fine enough to land on the shipped value with the arrow keys, which is what
  // makes a range this wide usable at the bottom of it as well as the top.
  locoLever('Kick', 'kick', 1, 10, 0.05, (v) => `${v.toFixed(2)}x · ${speedText(SPEED * v)}`);
  locoLever('Boost top', 'speed', 1.2, 12, 0.1, (v) => speedText(SPEED * v));
  // Raised with the ceilings rather than for its own sake: a ceiling a car cannot climb to is not
  // a ceiling, and at the shipped 24 u/s² a 100 u/s boost top would take 200 units — ten blocks —
  // to reach, so uncapping the speed alone would buy a number that never appears on the road.
  locoLever('Punch', 'accel', 4, 300, 1, (v) => `${v.toFixed(0)} u/s²`);
  locoLever('Overdrive', 'overdriveSpeed', 1.2, 20, 0.1, (v) => speedText(SPEED * v));
  locoLever('Band accel', 'overdriveAccel', 0.2, 150, 0.5, (v) => `${v.toFixed(1)} u/s²`);
  // Not the taxi's alone — there is one brake in the sim and it is what every car stops on. It is
  // here because it owns the coast-down after the button is let go, which is the last phase of
  // the curve above; the readout says so rather than leaving it to be discovered. Its top went up
  // with the rest: shedding 170 u/s at the shipped 11 u/s² is fifteen seconds of coasting, which
  // is longer than the run-up that earned it.
  locoLever('Brake', 'brake', 3, 80, 0.5, (v) => `${v.toFixed(1)} u/s² · all traffic`);

  // --- Loco weave -------------------------------------------------------------
  // The wander inside the lane — the "he is driving like a maniac" tell. Two waves whose periods
  // deliberately do not divide, so the car never settles into a metronome; `sway` is the long one
  // and `chop` the short one laid over it to break the rhythm.
  //
  // These reach the police cruiser as well. It drives the taxi's Loco Mode on purpose — one
  // definition of maniac, shared out of sim/traffic.js — so the sliders move both cars, and the
  // room readout below says which car is about to run out of lane.
  heading('Loco weave');

  const weaveNote = document.createElement('p');
  weaveNote.className = 'dbg-note';

  /**
   * How far the weave may throw the car before it stops being a weave.
   *
   * Derived, not typed in: the lane centre sits `LANE` from the road centreline and the same from
   * the kerb, and half a car body is `CAR_W / 2`. What's left is the play either side. The two
   * waves can peak together, so the number to compare against is their sum — 0.52 of 1.15 shipped,
   * which is the "half the room" the tuning block in traffic.js talks about.
   */
  const WEAVE_ROOM = LANE - CAR_W / 2;

  function showWeaveRoom() {
    const { sway, chop } = loco.get();
    const peak = sway + chop;
    const pct = Math.round((peak / WEAVE_ROOM) * 100);
    if (peak === 0) {
      weaveNote.textContent = 'weave off — the taxi holds its lane centre';
      return;
    }
    weaveNote.textContent = peak > WEAVE_ROOM
      ? `peak ${peak.toFixed(2)}u of ${WEAVE_ROOM.toFixed(2)}u — over the lane, expect kerbs and oncoming`
      : `peak ${peak.toFixed(2)}u of ${WEAVE_ROOM.toFixed(2)}u room · ${pct}% of the lane`;
  }
  panel.append(weaveNote);

  // Zero is a real setting on both amplitudes — it is how you watch the mode with the wander
  // switched off — so the readout says so rather than leaving `0.00u` to be interpreted.
  locoLever('Sway', 'sway', 0, 2, 0.01,
    (v) => (v === 0 ? 'off · no long wave' : `${v.toFixed(2)}u · the long wave`));
  locoLever('Sway length', 'swayWave', 3, 60, 0.5,
    (v) => `${v.toFixed(1)}u · ${(boostCruiseOf() / v).toFixed(2)} Hz at boost`);
  locoLever('Chop', 'chop', 0, 1, 0.01,
    (v) => (v === 0 ? 'off · no short wave' : `${v.toFixed(2)}u · laid over the sway`));
  locoLever('Chop length', 'chopWave', 2, 40, 0.5,
    (v) => `${v.toFixed(1)}u · ${(boostCruiseOf() / v).toFixed(2)} Hz at boost`);
  // Distance, not time, like the weave itself — so letting go at a red doesn't drift the parked
  // car straight. Shared with the cruiser's own fade-in.
  locoLever('Fade', 'fade', 0.5, 40, 0.5, (v) => `${v.toFixed(1)}u to full · both cars`);

  const resetLoco = document.createElement('button');
  resetLoco.type = 'button';
  resetLoco.className = 'dbg-wide';
  resetLoco.textContent = 'Reset Loco Mode';
  resetLoco.addEventListener('click', () => {
    loco.reset();
    for (const sync of locoLevers) sync();
    repaintLoco();
    // Clears the stash too — `loco.save()` forgets rather than writes once the tuning is back to
    // shipped, so Reset survives a reload exactly as surely as a tweak does. A reset that came
    // back undone on the next crash would be the worst of both.
    saveLoco();
  });
  panel.append(resetLoco, stashNote);

  repaintLoco();
  showStash(locoRestored);

  // --- City entrance ----------------------------------------------------------
  // The opening rise-out-of-the-ground animation (game/cityentry.js). All five are live — the
  // shader levers are uniforms — but the animation is over by the time this panel can be opened,
  // so every slider replays the entrance on release: scrub, let go, watch. The values live in
  // the entry module and are read back here, so the Export section captures them with the rest.
  heading('City entrance');

  const entryStart = cityEntry.tuning();

  /** The overshoot's visible size: where the easeOutBack peaks, as a percentage past full. */
  const peakOf = (o) => {
    if (o <= 0) return 0;
    const b = -2 * o / (3 * (o + 1));                       // where the curve's derivative is zero
    return Math.round(((o + 1) * b ** 3 + o * b ** 2) * 100);
  };

  /** A lever: applies live on input, updates its readout, and replays the entrance on release. */
  function entryLever(label, min, max, step, key, show) {
    const el = slider(min, max, step, entryStart[key]);
    const value = row(panel, label, el);
    const paint = () => { value.textContent = show(Number(el.value)); };
    el.addEventListener('input', () => {
      cityEntry.tune({ [key]: Number(el.value) });
      paint();
    });
    el.addEventListener('change', () => cityEntry.replay());
    paint();
    return el;
  }

  entryLever('Wave speed', 0.005, 0.08, 0.005, 'wave',
    (v) => `${(v * 1000).toFixed(0)}ms/unit`);
  entryLever('Grow time', 0.2, 1.5, 0.05, 'grow', (v) => `${v.toFixed(2)}s`);
  entryLever('Jitter', 0, 1, 0.05, 'jitter', (v) => `${v.toFixed(2)}s`);
  entryLever('Overshoot', 0, 4, 0.1, 'overshoot',
    (v) => `${v.toFixed(1)} · +${peakOf(v)}%`);
  entryLever('Dust', 0, 2, 0.05, 'dust',
    (v) => (v > 0.05 ? `${v.toFixed(2)}x` : 'off'));

  const replayEntry = document.createElement('button');
  replayEntry.type = 'button';
  replayEntry.className = 'dbg-wide';
  replayEntry.textContent = 'Replay entrance';
  replayEntry.addEventListener('click', () => cityEntry.replay());
  panel.append(replayEntry);

  // --- Needs a rebuild ------------------------------------------------------
  heading('Restart to apply');

  const cars = slider(1, 60, 1, carCount);
  const carsValue = row(panel, 'Cars', cars);
  carsValue.textContent = String(carCount);
  cars.addEventListener('input', () => { carsValue.textContent = cars.value; });

  // The look, and it belongs in this section rather than among the live controls above because it
  // genuinely cannot be live: both modes are compiled into every prop material *before a mesh
  // exists* (see `setCrayon`/`setCartoon` in util/geo.js), so switching one means recompiling every
  // program in the city. What it saves is real all the same — trying the two looks against each
  // other used to mean hand-editing the address bar, which is exactly the friction that stops a
  // look from being judged properly.
  const LOOKS = ['off', 'crayon', 'cartoon', 'both'];
  const lookNow = (crayon.state.enabled && cartoon.state.enabled) ? 'both'
    : (crayon.state.enabled && 'crayon') || (cartoon.state.enabled && 'cartoon') || 'off';
  const look = dropdown(LOOKS, lookNow);
  row(panel, 'Look', look);

  const actions = document.createElement('div');
  actions.className = 'dbg-actions';

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart with these';
  restart.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.set('cars', cars.value);
    // Written as explicit `on`/`off` rather than by deleting the parameter, so a reload out of a
    // look lands back on the stock renderer instead of on whatever the URL happened to carry.
    params.set('crayon', look.value === 'crayon' || look.value === 'both' ? 'on' : 'off');
    params.set('cartoon', look.value === 'cartoon' || look.value === 'both' ? 'on' : 'off');
    params.delete('run');                     // a genuinely fresh situation
    window.location.search = params.toString();
  });

  const newRun = document.createElement('button');
  newRun.type = 'button';
  newRun.textContent = 'New run';
  newRun.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.delete('run');
    window.location.search = params.toString();
  });

  actions.append(restart, newRun);
  panel.append(actions);

  // --- Scores ---------------------------------------------------------------
  // The wipe lives here rather than on the run-end card. It is the only destructive control in the
  // game, and the one place the player is guaranteed to be looking at their scores is the screen
  // whose primary action is a big yellow "Play again" — putting "Clear" next to it is a misclick
  // that cannot be undone. Behind the ⚙️ it has to be gone looking for.
  heading('Scores');

  const wipe = document.createElement('button');
  wipe.type = 'button';
  wipe.className = 'dbg-wide';
  const showCount = () => {
    const kept = scores.load().length;
    wipe.textContent = kept ? `Clear ${kept} score${kept === 1 ? '' : 's'}` : 'No scores yet';
    wipe.disabled = kept === 0;
  };
  wipe.addEventListener('click', () => {
    scores.clear();
    showCount();
  });
  showCount();
  // Re-read on every open. The count is the only readout here that something *outside* the panel
  // can change: a run scored since the panel was built leaves the button reading "No scores yet"
  // and — worse — still `disabled`, so the wipe silently does nothing. Registered as a second
  // listener rather than folded into the toggle above, because that handler is defined before this
  // section exists. It runs after it, so `panel.hidden` is already the new state.
  toggle.addEventListener('click', () => { if (!panel.hidden) showCount(); });
  panel.append(wipe);

  // --- Audio ----------------------------------------------------------------
  // The sound designer's sections — game/audiopanel.js. Its status line polls only while the
  // panel is open, so it hears about the toggle; registered after the one above, so `panel.hidden`
  // is already the new state.
  let audio = null;
  if (sfx) {
    audio = buildAudioSections(panel, sfx, { triggers: soundTriggers, holds: soundHolds, placeOf: soundPlace });
    toggle.addEventListener('click', () => (panel.hidden ? audio.close() : audio.open()));
  }

  // --- Export ---------------------------------------------------------------
  // Reads live objects rather than the slider positions, so it captures manual overrides too —
  // e.g. a sun colour picked after the time-of-day slider suggested a different one.
  heading('Export');

  const snapshot = () => ({
    light: {
      hour: Number(daylight.state.hour.toFixed(2)),
      cycling: daylight.state.cycling,
      dayLengthSeconds: daylight.state.dayLength,
      // Where the sun is aimed. `sunElevationDeg` reports the effective angle either way, so with
      // the pin off these two are the arc's own answer for `hour` and pasting them back changes
      // nothing — which is the point: an export is a description of the frame, not of the controls.
      sunPinned: daylight.aim.pinned,
      sunBearingDeg: Number(daylight.azimuth().toFixed(1)),
      sunElevationDeg: Number(daylight.elevation().toFixed(1)),
      sunColor: `#${sun.color.getHexString()}`,
      sunIntensity: Number(sun.intensity.toFixed(2)),
      // The fill is a hemisphere light, so it takes two colours — PALETTE.hemiSky and
      // PALETTE.hemiGround, and the `sky`/`ground` fields of the keyframes in game/daylight.js.
      fillSky: `#${hemi.color.getHexString()}`,
      fillGround: `#${hemi.groundColor.getHexString()}`,
      ambientIntensity: Number(hemi.intensity.toFixed(2)),
      // Maps onto PALETTE.shadowTint and SHADOW_TINT in util/geo.js.
      shadowColor: shadowTint().color,
      shadowTint: Number(shadowTint().amount.toFixed(2)),
      skyTop: `#${sky.uniforms.topColor.value.getHexString()}`,
      skyBottom: `#${sky.uniforms.bottomColor.value.getHexString()}`,
      haze: {
        top: Number(haze.value),
        skyH: hazeTuning.skyH,
        saturation: hazeTuning.saturation,
        // Derived from the three above — paste into PALETTE.fog if the parked look moved.
        color: fog ? `#${fog.color.getHexString()}` : null,
      },
    },
    game: {
      // 'budgeted' unless the Fare clock slider has pinned every rider flat — exporting the 60s
      // fallback here read as though the shipped clock were 60s.
      fareClock: fares.isPinned() ? fares.getSeconds() : 'budgeted',
      // The keys map onto TUNING in game/difficulty.js.
      pace: [difficulty.getTuning().paceStart, difficulty.getTuning().paceEnd],
      pressure: [difficulty.getTuning().pressureStart, difficulty.getTuning().pressureEnd],
      cars: Number(cars.value),
      routeBlend: routeLine.blend(),
      ambientOcclusion: ao.state.enabled ? Number(ao.state.strength.toFixed(2)) : false,
      // The keys map onto CRAYON_DEFAULTS in game/crayon.js. `false` rather than an object with
      // the flag off, so a pasted export can't quietly promote a look nobody was looking at.
      crayon: crayon.state.enabled ? { ...crayon.state, enabled: undefined } : false,
      // The keys map onto CARTOON_DEFAULTS in game/cartoon.js. The hull rims are not in here
      // because they are not live — see the note by the section above.
      cartoon: cartoon.state.enabled ? { ...cartoon.state, enabled: undefined } : false,
      // The keys map onto GRADE_DEFAULTS in game/colorgrade.js; a loaded file is named, and its
      // table travels separately as the section's "Download baked .cube".
      colorGrade: gradeSnapshot(),
    },
    // The keys map onto game/cityentry.js's constants: wave → WAVE, grow → ENTRY_DUR,
    // jitter → JITTER, overshoot → OVERSHOOT; dust is the multiplier on the burst power.
    cityEntrance: cityEntry.tuning(),
    // The keys map onto sim/traffic.js's: kick → BOOST_KICK, speed → BOOST_SPEED,
    // accel → BOOST_ACCEL, overdriveSpeed/overdriveAccel → OVERDRIVE_*, brake → BRAKE. Read from
    // the tuning rather than the sliders, so a clamped overdrive ceiling exports as what the sim
    // is actually running.
    locoMode: loco.get(),
    // The keys map onto FINISH_DEFAULTS and GLOSS_GLOBAL_DEFAULTS in util/geo.js.
    carFinish: glossTuning(),
  });

  const output = document.createElement('textarea');
  output.className = 'dbg-out';
  output.readOnly = true;
  output.rows = 12;
  output.hidden = true;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'dbg-wide';
  copy.textContent = 'Copy settings JSON';
  copy.addEventListener('click', async () => {
    const json = JSON.stringify(snapshot(), null, 2);
    output.value = json;
    output.hidden = false;
    try {
      await navigator.clipboard.writeText(json);
      copy.textContent = 'Copied ✓';
    } catch {
      // Clipboard can be refused; the textarea below is the fallback.
      output.select();
      copy.textContent = 'Select and copy below';
    }
    setTimeout(() => { copy.textContent = 'Copy settings JSON'; }, 1800);
  });

  panel.append(copy, output);

  // Seed the readouts. The lights themselves are already set by daylight's own init.
  dayLength.dispatchEvent(new Event('input'));
  fareTime.dispatchEvent(new Event('input'));
  refresh();

  const sections = organise(panel, phoneFrame);

  /**
   * Open the panel on one sound's controls — the 🔊 pins on the map (game/soundpins.js). Opens the
   * panel if it is shut, unfolds Sounds, selects the sound (which puts its rings on the ground) and
   * scrolls it into view.
   */
  function showSound(key) {
    if (!audio) return;
    if (panel.hidden) toggle.click();
    sections.openSection('Sounds');
    audio.reveal(key);
  }

  return {
    panel, toggle, snapshot, showSound,
    audioFocus: () => audio?.focused() ?? null,
    setPlace: (key, part, value, done) => audio?.setPlace(key, part, value, done),
  };
}

// --- Sections and search -----------------------------------------------------
// The panel is built flat — a heading, then whatever follows it until the next one — and folded
// into collapsible sections afterwards, rather than threading a section container through every
// `row(panel, ...)` above. That keeps each section's code exactly as it reads, and a section added
// later gets folded for free as long as it starts with `heading()`.
//
// Everything starts collapsed: the panel grew to a dozen sections and well over a hundred controls,
// and opened flat it was a scroll hunt for the one slider anyone came for. Which sections are open
// is remembered for the browser session (sessionStorage, so a reload keeps the place but a new tab
// starts clean) — and never written while a search is forcing sections open, so clearing the
// search puts back exactly what was open before it.

const OPEN_KEY = 'dbg-open';
const TAB_KEY = 'dbg-tab';

/**
 * The tabs under the search box, and which sections each one shows — by heading. A section not
 * named here lands on Game, the catch-all, so a new heading is never lost off every tab. A search
 * looks across all three: it is how you find a control without knowing where it lives.
 */
const TABS = [
  ['Audio', ['Audio', 'Engine sound', 'Sounds', 'Music', 'Audio export']],
  ['Visuals', ['Light', 'Crayon', 'Cartoon', 'Car finish', 'Bloom', 'HDR', 'CRT', 'Colour grade', 'Haze', 'Clouds', 'City entrance']],
  ['Game', ['Game', 'Loco Mode', 'Loco weave', 'Restart to apply', 'Scores', 'Export']],
];
const tabOf = (title) => TABS.find(([, titles]) => titles.includes(title))?.[0] ?? 'Game';

function loadTab() {
  try { return sessionStorage.getItem(TAB_KEY) || TABS[0][0]; } catch { return TABS[0][0]; }
}
function saveTab(tab) {
  try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
}

function loadOpen() {
  try { return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY)) || []); } catch { return new Set(); }
}

function saveOpen(open) {
  try { sessionStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* private mode */ }
}

/** What a search matches an item on: a row's label, a button's text, or a `data-search`. */
function itemText(el) {
  if (el.dataset?.search) return el.dataset.search;
  if (el.classList.contains('dbg-row')) return el.firstElementChild?.textContent ?? '';
  if (el.matches('button')) return el.textContent;
  const buttons = el.querySelectorAll('button');
  return buttons.length ? [...buttons].map((b) => b.textContent).join(' ') : '';
}

function organise(panel, phoneFrame = null) {
  const open = loadOpen();

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'dbg-search';
  search.placeholder = 'Search';
  search.spellcheck = false;
  search.autocomplete = 'off';
  search.setAttribute('aria-label', 'Search controls');

  const header = document.createElement('div');
  header.className = 'dbg-head';
  header.append(phoneFrame ? Object.assign(document.createElement('div'), { className: 'dbg-head-row' }) : search);
  if (phoneFrame) header.firstChild.append(search, phoneFrame.buildSwitch());

  let tab = loadTab();
  const tabBar = document.createElement('div');
  tabBar.className = 'dbg-tabs';
  tabBar.setAttribute('role', 'tablist');
  const tabButtons = TABS.map(([name]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbg-tab';
    b.textContent = name;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      tab = name;
      saveTab(tab);
      // A tab is a place to look, so picking one ends a search that was looking everywhere.
      if (search.value) search.value = '';
      filter();
    });
    tabBar.append(b);
    return b;
  });
  header.append(tabBar);

  const sections = [];
  let current = null;
  for (const el of [...panel.children]) {
    if (el.tagName === 'H4') {
      const title = el.textContent;
      const section = document.createElement('section');
      section.className = 'dbg-sec';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'dbg-sec-head';
      const name = document.createElement('span');
      name.textContent = title;
      const count = document.createElement('small');
      head.append(name, count);
      const body = document.createElement('div');
      body.className = 'dbg-sec-body';
      section.append(head, body);
      el.replaceWith(section);
      const entry = { title, key: title.toLowerCase(), section, head, count, body, items: [], tab: tabOf(title) };
      head.addEventListener('click', () => {
        // During a search the open/closed look is the search's, not the user's — a click then
        // still toggles, but only this view of it.
        const on = body.hidden;
        setOpen(entry, on);
        if (!query) {
          if (on) open.add(title); else open.delete(title);
          saveOpen(open);
        }
      });
      sections.push(entry);
      setOpen(entry, open.has(title));
      current = entry;
    } else if (current) {
      current.body.append(el);
      current.items.push({ el, key: itemText(el).toLowerCase() });
    }
  }

  const empty = document.createElement('p');
  empty.className = 'dbg-empty';
  empty.textContent = 'No matches';
  empty.hidden = true;

  panel.prepend(header);
  panel.append(empty);

  // A section's badge counts its rows, or its matches while a search is narrowing it.
  const rowCount = (s) => String(s.items.filter((i) => i.el.classList.contains('dbg-row')
    || i.el.dataset?.search).length || '');
  for (const s of sections) s.count.textContent = rowCount(s);

  function setOpen(s, on) {
    s.body.hidden = !on;
    s.head.setAttribute('aria-expanded', String(on));
  }

  let query = '';
  function filter() {
    query = search.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    // While searching, every tab's sections are in play and no tab reads as the one selected.
    for (const b of tabButtons) {
      const on = !words.length && b.textContent === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    let any = false;
    for (const s of sections) {
      if (!words.length) {
        s.section.hidden = s.tab !== tab;
        for (const i of s.items) i.el.classList.remove('dbg-miss');
        setOpen(s, open.has(s.title));
        s.count.textContent = rowCount(s);
        continue;
      }
      // Every word has to land somewhere in "section title + item label", so "sun height" and
      // "loco brake" find the one control without the section having to be named exactly.
      const titleHit = words.every((w) => s.key.includes(w));
      let hits = 0;
      for (const i of s.items) {
        const hit = titleHit || (i.key && words.every((w) => s.key.includes(w) || i.key.includes(w)));
        i.el.classList.toggle('dbg-miss', !hit);
        if (hit && i.key) hits++;
      }
      const show = titleHit || hits > 0;
      s.section.hidden = !show;
      if (show) setOpen(s, true);
      s.count.textContent = titleHit ? rowCount(s) : String(hits);
      any ||= show;
    }
    empty.hidden = !words.length || any;
  }

  search.addEventListener('input', filter);
  // Lay the panel out for the remembered tab before it is first opened.
  filter();
  // Typing in the box must not drive the game: `I`, `N`, `+`, `-` and the arrow keys all have
  // window-level handlers. Same guard as the audio panel's.
  search.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && search.value) {
      search.value = '';
      filter();
    }
  });
  search.addEventListener('keyup', (event) => event.stopPropagation());

  return {
    /** Unfold a section by its heading, clearing any search that might be hiding it. */
    openSection(title) {
      const s = sections.find((x) => x.title === title);
      if (!s) return;
      tab = s.tab;
      saveTab(tab);
      search.value = '';
      filter();
      setOpen(s, true);
      open.add(title);
      saveOpen(open);
    },
  };
}
