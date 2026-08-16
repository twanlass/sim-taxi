import { ROUTE_BLENDS } from './routeline.js';
import { HAZE_TOP, setHazeTop, hazeColor, hazeTuning } from './scene.js';
import * as difficulty from './difficulty.js';
import { SPEED, MPH_PER_UNIT, CAR_W } from '../sim/traffic.js';
import { PITCH, LANE } from '../city/grid.js';

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

  // Filled in by the haze section below. A stub rather than a direct call because that section is
  // built after this one, so naming its `const` here would be a temporal dead zone waiting for
  // whoever next reorders the panel.
  let syncHazeReadout = () => {};

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
    weaveNote.textContent = peak > WEAVE_ROOM
      ? `peak ${peak.toFixed(2)}u of ${WEAVE_ROOM.toFixed(2)}u — over the lane, expect kerbs and oncoming`
      : `peak ${peak.toFixed(2)}u of ${WEAVE_ROOM.toFixed(2)}u room · ${pct}% of the lane`;
  }
  panel.append(weaveNote);

  locoLever('Sway', 'sway', 0, 2, 0.01, (v) => `${v.toFixed(2)}u · the long wave`);
  locoLever('Sway length', 'swayWave', 3, 60, 0.5,
    (v) => `${v.toFixed(1)}u · ${(boostCruiseOf() / v).toFixed(2)} Hz at boost`);
  locoLever('Chop', 'chop', 0, 1, 0.01, (v) => `${v.toFixed(2)}u · laid over the sway`);
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
      haze: {
        top: Number(haze.value),
        skyH: hazeTuning.skyH,
        saturation: hazeTuning.saturation,
        // Derived from the three above — paste into PALETTE.fog if the parked look moved.
        color: fog ? `#${fog.color.getHexString()}` : null,
      },
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
    // The keys map onto sim/traffic.js's: kick → BOOST_KICK, speed → BOOST_SPEED,
    // accel → BOOST_ACCEL, overdriveSpeed/overdriveAccel → OVERDRIVE_*, brake → BRAKE. Read from
    // the tuning rather than the sliders, so a clamped overdrive ceiling exports as what the sim
    // is actually running.
    locoMode: loco.get(),
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
