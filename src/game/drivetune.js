/**
 * The Drive panel: live sliders for the free-driving model and its camera (Tyler, 2026-11-25:
 * "let's blow this up and add tools so that we can tune all this stuff in real time"). A tool, not a
 * game screen — styled with the ⚙️ panel's greys, and there whenever free driving is, with no
 * `?debug` needed, since tuning the feel *is* the work on this branch.
 *
 * **Nothing here owns a number.** Each slider writes straight into an object the simulation reads
 * every frame — `freeDrive.tune` (game/freedrive.js) and `QUARTER_VIEW`'s copy (game/camera.js) — so a
 * drag is felt on the next frame with no rebuild, and the defaults stay where they are documented.
 *
 * **What you change sticks, per device.** Moved values go to localStorage on release (a drag fires
 * `input` per pixel and `setItem` is synchronous) and are put back on the next load; Reset puts the
 * shipped numbers back. Copy puts every
 * value on the clipboard as JSON, which is the thing to paste back to Claude when a feel is right.
 */
import { MPH_PER_UNIT } from '../sim/traffic.js';

const STORE_KEY = 'simTaxi.driveTune';

const deg = (r) => `${Math.round((r * 180) / Math.PI)}°`;
const mph = (v) => `${v.toFixed(1)} u/s · ${Math.round(v * MPH_PER_UNIT)} mph`;
const num = (digits, unit = '') => (v) => `${v.toFixed(digits)}${unit}`;

// [label, key, min, max, step, readout, hint]. The ranges run well past anything shippable: the
// question a tuning slider answers is "what does *much* more feel like".
// The city camera in free driving (`QUARTER_VIEW` in game/camera.js).
const QUARTER = [
  ['Zoom', 'zoom', 0.5, 3, 0.05, num(2, '×'), 'Over the game\'s play zoom — above 1 is closer'],
  ['Look ahead', 'lead', 0, 2, 0.05, num(2, '×'), 'How far the frame leads the taxi along its travel'],
];
const SPEED = [
  ['Top speed', 'loco', 2, 80, 0.1, mph, 'With the gas (Loco) held'],
  ['Gas accel', 'gasAccel', 0.5, 80, 0.5, num(1, ' u/s²'), 'Pulling away on the gas'],
  ['Coast to stop', 'roll', 0, 40, 0.5, num(1, ' u/s²'), 'Gas: neither pedal down'],
  ['Brake', 'brake', 2, 120, 1, num(0, ' u/s²'), ''],
  ['Reverse speed', 'reverseSpeed', 0, 12, 0.25, mph, 'Hold the brake when stopped to back up (0 = no reverse)'],
  ['Reverse after', 'reverseDelay', 0, 1.5, 0.05, num(2, 's'), 'How long the brake is held at a stop before it backs up'],
  ['Cruise', 'cruise', 1, 40, 0.1, mph, 'Cruise mode: hands off the pedals'],
  ['Cruise accel', 'accel', 0.5, 60, 0.5, num(1, ' u/s²'), 'Cruise mode: up to cruise and to Loco'],
  ['Loco to cruise', 'coast', 0.5, 60, 0.5, num(1, ' u/s²'), 'Cruise mode: Loco released'],
];
const STEERING = [
  ['Sensitivity', 'relSpan', 0.05, 1.6, 0.01, deg, 'Heading a full push asks for, off the nose'],
  ['Response curve', 'steerCurve', 0.3, 3, 0.05, num(2), '>1 soft centre, <1 twitchy centre'],
  ['¾ tilt correction', 'stickCorrect', 0, 1, 0.05, num(2), '¾ view: 0 = streets on the stick diagonals, 1 = push read exactly as drawn'],
  ['Stiffness', 'turnGain', 0.5, 30, 0.5, num(1), 'How hard the nose chases the stick'],
  ['Swing inertia', 'yawLag', 0.01, 0.6, 0.01, num(2, 's'), 'Lag before a turn builds and dies'],
  ['Tightest turn', 'turnTight', 0.5, 12, 0.1, num(1, 'u'), 'Turning circle (radius) when slow — smaller is sharper'],
  ['Turn at top speed', 'turnTop', 2, 60, 0.5, num(1, 'u'), 'Turning circle (radius) flat out — smaller is sharper; widens with speed² between the two'],
  ['Street magnet', 'assistDeg', 0, 45, 1, num(0, '°'), 'Hands off, settle onto a street this close'],
  ['Magnet pull', 'settle', 0, 15, 0.5, num(1, '/s'), ''],
  ['Lane assist', 'laneAssist', 0, 1, 0.05, num(2), 'How strongly it holds you in the lane, steering or hands off (0 = off)'],
  ['Lane aim ahead', 'laneLook', 0.2, 3, 0.05, num(2, 's'), 'Aims at the lane centre this far ahead — shorter is snappier, longer is gentler'],
  ['Lane assist window', 'laneWindow', 5, 45, 1, num(0, '°'), 'Works within this of a street\'s direction, fading out at the edge'],
  ['Lane assist max', 'keepMax', 0, 30, 1, num(0, '°'), 'Most it can bend the heading'],
  ['Lane assist reach', 'keepReach', 1, 12, 0.5, num(1), 'How far off a lane it still pulls'],
];
const GRIP = [
  ['Tyre grip', 'latGrip', 3, 200, 1, num(0, ' u/s²'), 'Sideways grip before it slides'],
  ['Drift grip', 'driftGrip', 1, 60, 0.5, num(1, ' u/s²'), 'Sideways grip while drifting — lower slides further'],
  ['Drift turn', 'driftTurn', 1, 3, 0.05, num(2, '×'), 'How much faster the nose swings while drifting'],
  ['Drift from', 'driftMinV', 0, 30, 0.5, num(1, ' u/s'), 'Slowest speed a brake tap starts a drift at'],
  ['Turn scrub', 'turnScrub', 0, 40, 0.5, num(1, ' u/s²'), 'Speed a hard turn costs above cruise'],
];
const WALLS = [
  ['Slide keep', 'wallKeep', 0, 1, 0.01, num(2), 'Speed kept per second sliding along a wall — 1 is ice'],
  ['Wall deflect', 'wallTurn', 0, 30, 0.5, num(1, ' rad/s'), 'How fast a glancing wall swings the nose along it'],
  ['Body radius', 'bodyR', 0.4, 2.5, 0.05, num(2), 'The car is a circle this big against walls'],
  ['Corner rounding', 'wallSmooth', 0, 6, 0.1, num(1), 'How round the seams are (bridge mouths, coast corners)'],
  ['Kerb lift', 'kerbH', 0, 1.5, 0.05, num(2), 'Ride height off the road'],
];

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function store(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

/**
 * @param car        the live free-driving numbers (`freeDrive.tune`)
 * @param carDefault their shipped values (`FREE_TUNING`)
 * @param gameLoco   () => the game's own Loco top speed, for the slider while `loco` is unset
 * @param debugViz   `{ on: () => boolean, set: (on) => void }` — the steering overlay (game/drivedebug.js)
 * @param quarter    the live ¾-view camera numbers (`QUARTER_VIEW` shape)
 * @param quarterDefault their shipped values
 */
export function createDriveTune({ car, carDefault, gameLoco, debugViz,
  quarter, quarterDefault }) {
  // Put back what was saved, over the defaults the objects arrived with.
  const saved = load();
  for (const [k, v] of Object.entries(saved.car ?? {})) if (k in carDefault && Number.isFinite(v)) car[k] = v;
  for (const [k, v] of Object.entries(saved.quarter ?? {})) {
    if (k in quarterDefault && Number.isFinite(v)) quarter[k] = v;
  }

  const toggle = document.createElement('button');
  toggle.id = 'drive-tune-toggle';
  toggle.type = 'button';
  toggle.textContent = '🎛';
  toggle.title = 'Drive tuning (T)';

  const panel = document.createElement('div');
  panel.id = 'drive-tune';
  panel.hidden = true;
  document.body.append(toggle, panel);

  const syncs = [];

  function persist() {
    const changed = (live, base) => Object.fromEntries(
      Object.keys(base).filter((k) => live[k] != null && live[k] !== base[k]).map((k) => [k, live[k]]));
    const data = load();
    data.car = changed(car, carDefault);
    delete data.cam;
    data.quarter = changed(quarter, quarterDefault);
    store(data);
  }

  /** A two-way switch on a 0/1 key: `[label, key, [offText, onText], hint]`. */
  function toggleRow(target, defaults, [label, key, [offText, onText], hint]) {
    const wrap = document.createElement('div');
    wrap.className = 'dbg-row';
    if (hint) wrap.title = hint;
    const name = document.createElement('span');
    name.textContent = label;
    const seg = document.createElement('div');
    seg.className = 'dt-seg dt-seg-row';
    const buttons = [[offText, 0], [onText, 1]].map(([text, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => { target[key] = value; sync(); persist(); });
      seg.append(b);
      return [b, value];
    });
    const value = document.createElement('em');
    wrap.append(name, seg, value);
    panel.append(wrap);
    const sync = () => {
      for (const [b, v] of buttons) b.classList.toggle('is-active', (target[key] ? 1 : 0) === v);
      value.textContent = target[key] !== defaults[key] ? '●' : '';
    };
    sync();
    syncs.push(sync);
  }

  function heading(text) {
    const h = document.createElement('h4');
    h.textContent = text;
    panel.append(h);
  }

  function section(title, target, defaults, rows, initial = (k) => target[k]) {
    if (title) heading(title);
    for (const [label, key, min, max, step, show, hint] of rows) {
      const wrap = document.createElement('label');
      wrap.className = 'dbg-row';
      if (hint) wrap.title = hint;
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min, max, step });
      const value = document.createElement('em');
      wrap.append(name, input, value);
      panel.append(wrap);
      const sync = () => {
        const v = initial(key);
        input.value = String(v);
        value.textContent = show(v) + (target[key] != null && target[key] !== defaults[key] ? ' ●' : '');
      };
      input.addEventListener('input', () => { target[key] = Number(input.value); sync(); });
      input.addEventListener('change', persist);
      // Back to the default on a double-click, one slider at a time.
      wrap.addEventListener('dblclick', () => { target[key] = defaults[key]; sync(); persist(); });
      sync();
      syncs.push(sync);
    }
  }

  // The switch and the buttons, up top.
  const bar = document.createElement('div');
  bar.className = 'dt-bar';
  // The steering overlay: magnets, lane, assist, the stick's squash (game/drivedebug.js). `V` too.
  const vizButton = document.createElement('button');
  vizButton.type = 'button';
  vizButton.textContent = 'Viz';
  vizButton.title = 'Steering debug overlay (V)';
  vizButton.addEventListener('click', () => { debugViz.set(!debugViz.on()); paintCam(); });
  const paintCam = () => {
    vizButton.classList.toggle('is-active', debugViz.on());
  };
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.title = 'Copy every value as JSON';
  copy.addEventListener('click', async () => {
    const text = JSON.stringify({ car: { ...car, loco: car.loco ?? gameLoco() }, quarter: { ...quarter } }, null, 2);
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch {
      console.log(text);
      copy.textContent = 'In console';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  });
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset';
  reset.title = 'Every slider back to the shipped value';
  reset.addEventListener('click', () => {
    Object.assign(car, carDefault);
    Object.assign(quarter, quarterDefault);
    persist();
    for (const s of syncs) s();
  });
  bar.append(vizButton, copy, reset);
  panel.append(bar);
  const note = document.createElement('p');
  note.className = 'dt-note';
  note.textContent = 'Live. ● = changed, saved on this device. Double-click a row to reset it. V shows the steering overlay.';
  panel.append(note);

  heading('¾ camera');
  toggleRow(quarter, quarterDefault, ['Follow taxi', 'follow', ['Off', 'On'],
    'Keep the ¾ camera on the taxi while you drive (a drag on the map still takes it over)']);
  section(null, quarter, quarterDefault, QUARTER);
  heading('Speed');
  toggleRow(car, carDefault, ['Pedals', 'gasPedal', ['Cruise + Loco', 'Gas + brake'],
    'Gas + brake: no cruise, Loco is the gas and hands off it rolls to a stop. Cruise + Loco: hands off holds cruise, Loco boosts']);
  section(null, car, carDefault, SPEED, (k) => (k === 'loco' ? car.loco ?? gameLoco() : car[k]));
  heading('Steering');
  toggleRow(car, carDefault, ['¾ view steer', 'turnSteer', ['Screen', 'Turn'],
    'Screen points the car where the stick points on screen; Turn steers left/right off the nose']);
  toggleRow(car, carDefault, ['Invert L/R', 'invertSteer', ['Normal', 'Inverted'],
    'Mirror the stick left to right, in either style']);
  toggleRow(car, carDefault, ['Street magnet', 'magnetOnStick', ['Ground °', 'Stick °'],
    '¾ view: measure the snap window in thumb degrees (same width for every street) or ground degrees']);
  toggleRow(car, carDefault, ['Drift', 'drift', ['Off', 'Brake tap'],
    'Steering at speed, tap the brake (or slide gas → brake → gas) to break the rear loose']);
  panel.lastElementChild.style.marginBottom = '10px';
  section(null, car, carDefault, STEERING);
  section('Grip', car, carDefault, GRIP);
  section('Walls & kerbs', car, carDefault, WALLS);

  function setOpen(open) {
    panel.hidden = !open;
    toggle.classList.toggle('is-open', open);
    if (open) { paintCam(); for (const s of syncs) s(); }
  }
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== 't' && event.key !== 'T') return;
    if (event.target instanceof HTMLElement && event.target.closest('input[type="text"], input[type="search"], textarea')) return;
    setOpen(panel.hidden);
  });
  // A slider holds keyboard focus after a drag, and the game reads keys off `window` — so arrow
  // keys and the pedals' keys would nudge the slider and drive the car at once. Hand focus back.
  panel.addEventListener('change', (event) => { if (event.target.type === 'range') event.target.blur(); });

  return {
    /** Keep the Viz button honest when `V` flips the overlay behind the panel's back. */
    refresh() { paintCam(); },
  };
}
