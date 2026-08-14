import { ROUTE_BLENDS } from './routeline.js';
import * as difficulty from './difficulty.js';

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

const clockLabel = (hour) => {
  const h = Math.floor(hour);
  const m = String(Math.round((hour - h) * 60) % 60).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${m}`;
};

export function createDebugPanel({
  sun, hemi, sky, daylight, fares, carCount, routeLine, ao,
  // `{ load, clear }` over game/highscores.js. Defaulted so the panel still constructs in the
  // `npm run check` boot pass, which builds it against nothing.
  scores = { load: () => [], clear: () => {} },
  // The city-entrance animation's levers — `{ tuning, tune, replay }` over game/cityentry.js.
  // Defaulted for the same reason as `scores`.
  cityEntry = { tuning: () => ({ wave: 0, jitter: 0, grow: 0, overshoot: 0, dust: 0 }), tune: () => {}, replay: () => {} },
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

  const fill = slider(0, 2, 0.05, hemi.intensity);
  const fillValue = row(panel, 'Ambient fill', fill);
  fill.addEventListener('input', () => {
    takeManualControl();
    hemi.intensity = Number(fill.value);
    fillValue.textContent = hemi.intensity.toFixed(2);
  });

  /** Pull the controls back into line with the live lights. */
  function refresh() {
    const { hour } = daylight.state;
    hourInput.value = String(hour);
    hourValue.textContent = `${clockLabel(hour)} · ${daylight.elevation().toFixed(0)}° up`;
    sunColour.value = `#${sun.color.getHexString()}`;
    sunPower.value = String(sun.intensity);
    sunPowerValue.textContent = sun.intensity.toFixed(2);
    fill.value = String(hemi.intensity);
    fillValue.textContent = hemi.intensity.toFixed(2);
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
  // rider to appear is the first one on the new slack, and the density ramp only ever grows. That
  // is the same asymmetry the panel is already split by — this one sits under Game rather than
  // "Restart to apply" because most of it does take effect, just not retroactively.
  const diff = slider(0, 1, 0.05, difficulty.difficulty(0));
  const diffValue = row(panel, 'Difficulty', diff);
  const showDifficulty = (d) => {
    diffValue.textContent = `${d.toFixed(2)} · ${difficulty.shiftFor(0).name} `
      + `· ${difficulty.maxFares(0)} fares · ${difficulty.slack(0).toFixed(2)}x slack`;
  };
  diff.addEventListener('input', () => {
    const d = Number(diff.value);
    difficulty.pinDifficulty(d);
    showDifficulty(d);
  });
  showDifficulty(difficulty.difficulty(0));

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

  const actions = document.createElement('div');
  actions.className = 'dbg-actions';

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart with these';
  restart.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.set('cars', cars.value);
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

  // --- Export ---------------------------------------------------------------
  // Reads live objects rather than the slider positions, so it captures manual overrides too —
  // e.g. a sun colour picked after the time-of-day slider suggested a different one.
  heading('Export');

  const snapshot = () => ({
    light: {
      hour: Number(daylight.state.hour.toFixed(2)),
      cycling: daylight.state.cycling,
      dayLengthSeconds: daylight.state.dayLength,
      sunElevationDeg: Number(daylight.elevation().toFixed(1)),
      sunColor: `#${sun.color.getHexString()}`,
      sunIntensity: Number(sun.intensity.toFixed(2)),
      ambientIntensity: Number(hemi.intensity.toFixed(2)),
      skyTop: `#${sky.uniforms.topColor.value.getHexString()}`,
      skyBottom: `#${sky.uniforms.bottomColor.value.getHexString()}`,
    },
    game: {
      fareSeconds: fares.getSeconds(),
      cars: Number(cars.value),
      routeBlend: routeLine.blend(),
      ambientOcclusion: ao.state.enabled ? Number(ao.state.strength.toFixed(2)) : false,
    },
    // The keys map onto game/cityentry.js's constants: wave → WAVE, grow → ENTRY_DUR,
    // jitter → JITTER, overshoot → OVERSHOOT; dust is the multiplier on the burst power.
    cityEntrance: cityEntry.tuning(),
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

  return { panel, toggle, snapshot };
}
