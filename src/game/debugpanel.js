import { getPhysicsMode, MODES } from '../sim/physics-mode.js';

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

const clockLabel = (hour) => {
  const h = Math.floor(hour);
  const m = String(Math.round((hour - h) * 60) % 60).padStart(2, '0');
  return `${String(h).padStart(2, '0')}:${m}`;
};

export function createDebugPanel({ sun, hemi, sky, daylight, fares, carCount }) {
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

  const fareTime = slider(15, 120, 1, fares.getSeconds());
  const fareValue = row(panel, 'Fare clock', fareTime);
  fareTime.addEventListener('input', () => {
    fares.setSeconds(Number(fareTime.value));
    fareValue.textContent = `${fareTime.value}s · next fare`;
  });

  // --- Needs a rebuild ------------------------------------------------------
  heading('Restart to apply');

  const cars = slider(1, 60, 1, carCount);
  const carsValue = row(panel, 'Cars', cars);
  carsValue.textContent = String(carCount);
  cars.addEventListener('input', () => { carsValue.textContent = cars.value; });

  // Physics is a per-session choice — it needs a fresh world (the rigid mode loads Rapier WASM
  // and builds static colliders at boot). Same shape as Cars: change here + click Restart.
  const physics = document.createElement('select');
  const PHYSICS_LABELS = { [MODES.OFF]: 'Off (rail sim)',
                           [MODES.ARCADE]: 'Arcade (tilt + bumps)',
                           [MODES.RIGID]: 'Rigid (Rapier bubble)' };
  for (const value of Object.values(MODES)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = PHYSICS_LABELS[value];
    physics.append(opt);
  }
  physics.value = getPhysicsMode();
  const physicsValue = row(panel, 'Physics', physics);
  physicsValue.textContent = physics.value === MODES.OFF ? '' : 'restart to apply';
  physics.addEventListener('input', () => {
    physicsValue.textContent = physics.value === MODES.OFF ? '' : 'restart to apply';
  });

  const actions = document.createElement('div');
  actions.className = 'dbg-actions';

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart with these';
  restart.addEventListener('click', () => {
    const params = new URLSearchParams(window.location.search);
    params.set('cars', cars.value);
    // Physics default is off; omit the param in that case to keep URLs clean.
    if (physics.value === MODES.OFF) params.delete('physics');
    else params.set('physics', physics.value);
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
      physics: physics.value,
    },
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
