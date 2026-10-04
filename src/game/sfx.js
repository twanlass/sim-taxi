/**
 * The game's sound: the taxi's engine, Loco Mode, the doors, the crash, the jump and the blinker.
 *
 * The one thing in this project loaded from files rather than generated in code. The recordings
 * are a sound designer's, encoded from WAV masters by `tools/audio.mjs` into `assets/audio/*.m4a`;
 * `new URL(..., import.meta.url)` below is what makes Vite fingerprint and ship them, and it is
 * inert in node, which is what lets `tools/check.mjs` boot this module headless.
 *
 * **Everything is the taxi.** Ambient traffic is silent on purpose: twenty-odd engines and their
 * blinkers under one fixed overhead camera would be a wash, and every sound here is feedback about
 * the one car the player is driving.
 *
 * Two kinds of sound, and the split is the design:
 *
 * - **Beds**, which run continuously and are *steered* every frame by `update()` off the taxi's
 *   state — the engine idle (pitched by speed), the Loco engine (crossfaded in while the pill is
 *   held), and the blinker (running while `taxi.signalHand` is set). A bed is never started by an
 *   event, so nothing can leave one stuck on: whatever the frame says is what plays.
 * - **One-shots**, fired by `play(name)` from the site in main.js that already knows the thing
 *   happened — the same sites `haptic()` fires from, for the same reason.
 *
 * **Nothing can play until a gesture.** Every browser holds an `AudioContext` suspended until the
 * page has been touched, so the context is created on the first press and the decode happens then.
 * The fetches start at construction, so by the first tap the bytes are usually already here.
 *
 * **Read the browser at call time, never at import** — the rule `haptics.js` states for the same
 * reason: check.mjs imports this in node, where there is no `window`.
 */
// The designer's mix — see SHIPPED_MIX below.
import MIX from '../../assets/audio/mix.json' with { type: 'json' };

// The designer's files, keyed by the designer's own names so a re-delivery drops straight in. Each
// is a literal `new URL` so Vite can see it at build time; a URL assembled from a variable is one
// Vite cannot find and will not ship.
const FILES = {
  '01_ENG_idle_loop': new URL('../../assets/audio/01_ENG_idle_loop.m4a', import.meta.url).href,
  '02_IMPACT_bump_A': new URL('../../assets/audio/02_IMPACT_bump_A.m4a', import.meta.url).href,
  '02_IMPACT_bump_B': new URL('../../assets/audio/02_IMPACT_bump_B.m4a', import.meta.url).href,
  '02_IMPACT_bump_C': new URL('../../assets/audio/02_IMPACT_bump_C.m4a', import.meta.url).href,
  '03_ENG_accel_A': new URL('../../assets/audio/03_ENG_accel_A.m4a', import.meta.url).href,
  '03_ENG_accel_B': new URL('../../assets/audio/03_ENG_accel_B.m4a', import.meta.url).href,
  '03_ENG_accel_C': new URL('../../assets/audio/03_ENG_accel_C.m4a', import.meta.url).href,
  '03_ENG_accel_D': new URL('../../assets/audio/03_ENG_accel_D.m4a', import.meta.url).href,
  '03_ENG_accel_E': new URL('../../assets/audio/03_ENG_accel_E.m4a', import.meta.url).href,
  '04_ENG_brake_A': new URL('../../assets/audio/04_ENG_brake_A.m4a', import.meta.url).href,
  '04_ENG_brake_B': new URL('../../assets/audio/04_ENG_brake_B.m4a', import.meta.url).href,
  '04_ENG_brake_C': new URL('../../assets/audio/04_ENG_brake_C.m4a', import.meta.url).href,
  '05_LOCO_activate_A': new URL('../../assets/audio/05_LOCO_activate_A.m4a', import.meta.url).href,
  '05_LOCO_activate_B': new URL('../../assets/audio/05_LOCO_activate_B.m4a', import.meta.url).href,
  '05_LOCO_activate_C': new URL('../../assets/audio/05_LOCO_activate_C.m4a', import.meta.url).href,
  '06_LOCO_engine_loop': new URL('../../assets/audio/06_LOCO_engine_loop.m4a', import.meta.url).href,
  '07_LOCO_launch_A': new URL('../../assets/audio/07_LOCO_launch_A.m4a', import.meta.url).href,
  '07_LOCO_launch_B': new URL('../../assets/audio/07_LOCO_launch_B.m4a', import.meta.url).href,
  '07_LOCO_launch_C': new URL('../../assets/audio/07_LOCO_launch_C.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_A': new URL('../../assets/audio/08_LOCO_brake_hard_A.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_B': new URL('../../assets/audio/08_LOCO_brake_hard_B.m4a', import.meta.url).href,
  '08_LOCO_brake_hard_C': new URL('../../assets/audio/08_LOCO_brake_hard_C.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_A': new URL('../../assets/audio/09_LOCO_skid_turn_A.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_B': new URL('../../assets/audio/09_LOCO_skid_turn_B.m4a', import.meta.url).href,
  '09_LOCO_skid_turn_C': new URL('../../assets/audio/09_LOCO_skid_turn_C.m4a', import.meta.url).href,
  '10_DOOR_open_A': new URL('../../assets/audio/10_DOOR_open_A.m4a', import.meta.url).href,
  '10_DOOR_open_B': new URL('../../assets/audio/10_DOOR_open_B.m4a', import.meta.url).href,
  '10_DOOR_open_C': new URL('../../assets/audio/10_DOOR_open_C.m4a', import.meta.url).href,
  '11_DOOR_close_A': new URL('../../assets/audio/11_DOOR_close_A.m4a', import.meta.url).href,
  '11_DOOR_close_B': new URL('../../assets/audio/11_DOOR_close_B.m4a', import.meta.url).href,
  '11_DOOR_close_C': new URL('../../assets/audio/11_DOOR_close_C.m4a', import.meta.url).href,
  '12_IMPACT_crash_A': new URL('../../assets/audio/12_IMPACT_crash_A.m4a', import.meta.url).href,
  '12_IMPACT_crash_B': new URL('../../assets/audio/12_IMPACT_crash_B.m4a', import.meta.url).href,
  '12_IMPACT_crash_C': new URL('../../assets/audio/12_IMPACT_crash_C.m4a', import.meta.url).href,
  '13_JUMP_takeoff_A': new URL('../../assets/audio/13_JUMP_takeoff_A.m4a', import.meta.url).href,
  '13_JUMP_takeoff_B': new URL('../../assets/audio/13_JUMP_takeoff_B.m4a', import.meta.url).href,
  '13_JUMP_takeoff_C': new URL('../../assets/audio/13_JUMP_takeoff_C.m4a', import.meta.url).href,
  '14_JUMP_land_A': new URL('../../assets/audio/14_JUMP_land_A.m4a', import.meta.url).href,
  '14_JUMP_land_B': new URL('../../assets/audio/14_JUMP_land_B.m4a', import.meta.url).href,
  '14_JUMP_land_C': new URL('../../assets/audio/14_JUMP_land_C.m4a', import.meta.url).href,
  '15_SIGNAL_turn': new URL('../../assets/audio/15_SIGNAL_turn.m4a', import.meta.url).href,
  '16_POLICE_siren_loop': new URL('../../assets/audio/16_POLICE_siren_loop.m4a', import.meta.url).href,
  '17_BURGER_drive_through': new URL('../../assets/audio/17_BURGER_drive_through.m4a', import.meta.url).href,
};

/**
 * What the game calls each sound, and the takes it draws from. The designer delivers most one-shots
 * as lettered variants (`_A`, `_B`, `_C`…) mixed level with each other and meant to be picked **one
 * per trigger**, so a door or a skid heard twice in a row is not the same recording twice — see
 * `pickTake`. A bed has one file: a loop cannot change take mid-cycle.
 */
export const SOUNDS = {
  idle: ['01_ENG_idle_loop'],
  bump: ['02_IMPACT_bump_A', '02_IMPACT_bump_B', '02_IMPACT_bump_C'],
  accel: ['03_ENG_accel_A', '03_ENG_accel_B', '03_ENG_accel_C', '03_ENG_accel_D', '03_ENG_accel_E'],
  brake: ['04_ENG_brake_A', '04_ENG_brake_B', '04_ENG_brake_C'],
  locoActivate: ['05_LOCO_activate_A', '05_LOCO_activate_B', '05_LOCO_activate_C'],
  locoLoop: ['06_LOCO_engine_loop'],
  locoLaunch: ['07_LOCO_launch_A', '07_LOCO_launch_B', '07_LOCO_launch_C'],
  locoBrake: ['08_LOCO_brake_hard_A', '08_LOCO_brake_hard_B', '08_LOCO_brake_hard_C'],
  skid: ['09_LOCO_skid_turn_A', '09_LOCO_skid_turn_B', '09_LOCO_skid_turn_C'],
  // The same takes for a chasing cop's squeal. A key of its own, not a second call to `skid`: it
  // wants its own level (it is somebody else's car, somewhere else on the screen) and its own
  // `minGap`, or four cops cornering would spend the taxi's gap and swallow its own squeal.
  copSkid: ['09_LOCO_skid_turn_A', '09_LOCO_skid_turn_B', '09_LOCO_skid_turn_C'],
  doorOpen: ['10_DOOR_open_A', '10_DOOR_open_B', '10_DOOR_open_C'],
  doorClose: ['11_DOOR_close_A', '11_DOOR_close_B', '11_DOOR_close_C'],
  crash: ['12_IMPACT_crash_A', '12_IMPACT_crash_B', '12_IMPACT_crash_C'],
  takeoff: ['13_JUMP_takeoff_A', '13_JUMP_takeoff_B', '13_JUMP_takeoff_C'],
  land: ['14_JUMP_land_A', '14_JUMP_land_B', '14_JUMP_land_C'],
  signal: ['15_SIGNAL_turn'],
  // Not the designer's: delivered separately (October 2026) and named into the same scheme so they
  // sort after Block 1. The siren is the one bed that is not the taxi — it is the cop coming after
  // it, which is feedback about the taxi all the same — and the drive-through is the speaker at the
  // burger joint's window, played once per visit.
  siren: ['16_POLICE_siren_loop'],
  driveThru: ['17_BURGER_drive_through'],
};

/** What `play()` accepts — the one-shots. A typo throws here rather than going silent. */
export const SFX_EVENTS = new Set(['bump', 'accel', 'brake', 'locoActivate', 'locoLaunch',
  'locoBrake', 'skid', 'copSkid', 'doorOpen', 'doorClose', 'crash', 'takeoff', 'land', 'driveThru']);

/** The beds: steered by `update()`, never fired. */
export const LOOPS = new Set(['idle', 'locoLoop', 'signal', 'siren']);

// The loops' true lengths, from the masters (afinfo). A decoder that does not trim AAC's 2112
// frames of encoder priming hands back a buffer that long *plus* the pad, and looping the whole
// buffer would put 44ms of silence in every cycle — a hiccup in the engine once every four
// seconds. See `loopWindow`.
const LOOP_SECONDS = { idle: 4, locoLoop: 8, signal: 4.53125, siren: 2.25 };

/**
 * The drive-through speaker's true length (afinfo on the master). The taxi's visit is timed to it —
 * see TAXI_ORDER_DWELL in game/drivethru.js, and the probe that holds the two together.
 */
export const DRIVE_THRU_SECONDS = 12.93;

/**
 * How far the radio drops while something has to be heard over it — the drive-through speaker. The
 * radio sits at -24 LUFS at full slider and the speaker at about -27 after its mix gain, so it was
 * under the music; -12 dB puts the radio at about -36, behind the speaker and still playing.
 */
const MUSIC_DUCK = 0.25;
const AAC_PRIMING = 2112 / 48000;

/**
 * The radio: an intro, then songs back to back for as long as the page is open — a fresh pick at
 * the end of each, at random but never the one that just played. Kept apart from `FILES`/`SOUNDS`
 * because it is not the taxi and not in the mix: it plays into the music bus, under the Music
 * slider rather than the effects one, and nothing steers it from the frame.
 *
 * `seconds` is each master's true length, which is what the next track is scheduled against (the
 * same AAC-priming guard `loopWindow` is for, so a decoder that leaves the pad in does not open a
 * 44ms gap at every change). `gain` levels the four against each other and sits them under the
 * taxi: measured off the masters (ffmpeg ebur128) the intro is -17.3 LUFS and the songs -13.5
 * (country), -12.3 (jazz) and -10.8 (rock), against -34 for the engine idle and -22 for a crash —
 * so each is brought to -24 LUFS at full slider, and the slider only ever turns it down.
 */
const RADIO_FILES = {
  MUSIC_radio_intro: new URL('../../assets/audio/MUSIC_radio_intro.m4a', import.meta.url).href,
  MUSIC_country: new URL('../../assets/audio/MUSIC_country.m4a', import.meta.url).href,
  MUSIC_jazz: new URL('../../assets/audio/MUSIC_jazz.m4a', import.meta.url).href,
  MUSIC_rock: new URL('../../assets/audio/MUSIC_rock.m4a', import.meta.url).href,
};
const dB = (d) => 10 ** (d / 20);
export const RADIO = {
  intro: 'MUSIC_radio_intro',
  songs: ['MUSIC_country', 'MUSIC_jazz', 'MUSIC_rock'],
  seconds: { MUSIC_radio_intro: 15, MUSIC_country: 30, MUSIC_jazz: 30, MUSIC_rock: 30 },
  gain: {
    MUSIC_radio_intro: dB(-6.7), MUSIC_country: dB(-10.5), MUSIC_jazz: dB(-11.7), MUSIC_rock: dB(-13.2),
  },
};

/**
 * The mix: every number a sound designer might want to move, kept in `assets/audio/mix.json`
 * rather than here, so the `?audio` panel (game/audiopanel.js) can export a file that drops
 * straight over it. Its four parts:
 *
 * - `master` — the whole game's level, under the mute.
 * - `sounds` — per sound (every take of it together), `gain` (linear) and `rate` (playback rate:
 *   pitch *and* tempo). The gain is how the mix is set without re-exporting masters. The Block 1
 *   delivery arrives balanced against itself — the designer's note is to start every level at
 *   0 dB and move from there, which is what the shipped file does. It sits well under the test
 *   files it replaced: the idle measures -34 dB RMS where they were -25, and the blinker -50.
 *   `copSkid` is the one level that is ours rather than the designer's (see SOUNDS). `file` is
 *   the designer's name, for reading only.
 * - `minGap` — seconds before the same one-shot may fire again: a second skid inside 0.45s is the
 *   same skid. Zero means no limit.
 * - `engine` — the beds' behaviour:
 *   - `idleRateLo`/`idleRateHi`: the idle's playback rate standing still and at cruise. A rate is
 *     pitch and tempo together, which is exactly what an engine note does as it revs.
 *   - `locoRateLo`/`locoRateHi`: the Loco loop's, across the overdrive band (cruise to Loco top).
 *   - `idleUnderLoco`: how far the idle ducks while the Loco engine is up — it is still the same
 *     car underneath, so it ducks rather than cutting out.
 *   - `locoLoopAt`/`locoLoopFade`: when the Loco loop comes in under the activate, and over how
 *     long. The Block 1 activate is 12s: level for about 5.5s (-22 dB RMS in half-second windows),
 *     then a tail that is -35 dB by 7.5s and silent by 11, so a hold that outlasts it needs
 *     something to carry on with. Faded in across the tail rather than
 *     started with the press, where the two would stack.
 *   - `pitchGlide`/`release`: time constants for `setTargetAtTime`, in seconds (~95% of the way
 *     in 3x). The glide is short enough to track a speed change and long enough that a frame's
 *     jitter in `v` is not a zipper in the pitch.
 *   - `selfBrakeGain`: the brake sound when the taxi slows *by itself* (a red, a queue), against
 *     the pedal's 1.
 *   - `pullAwayHold`: how long the taxi has to stand still before pulling away plays `accel`. The
 *     hold is what keeps a car creeping in a queue from revving on every inch.
 *
 * `tune()` cleans whatever it is handed against the shape of the shipped file, so a pasted or
 * hand-edited mix can only ever move a known number to a sane value.
 */
// The taxi pulling away from a standstill: below `STOP_V`, then over `GO_V`.
const STOP_V = 0.4;
const GO_V = 1.2;

// What each knob may hold. A gain of zero is silence and is fine; a rate of zero stops the clock.
const LIMITS = {
  master: [0, 4],
  gain: [0, 8],
  rate: [0.25, 4],
  minGap: [0, 10],
  engine: [0, 30],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `raw` cleaned onto the shape of `base` — only keys `base` has, only finite numbers, clamped.
 * With `base` null this *is* the shipped file, and every key it names is taken as the shape.
 */
function cleanMix(raw, base) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const shape = base ?? src;
  const out = {
    master: clamp(num(src.master) ?? shape.master ?? 1, LIMITS.master),
    sounds: {},
    minGap: {},
    engine: {},
  };
  for (const key of Object.keys(SOUNDS)) {
    const from = shape.sounds?.[key] ?? {};
    const given = src.sounds?.[key] ?? {};
    out.sounds[key] = {
      file: from.file ?? key,
      gain: clamp(num(given.gain) ?? from.gain ?? 1, LIMITS.gain),
      rate: clamp(num(given.rate) ?? from.rate ?? 1, LIMITS.rate),
    };
  }
  for (const key of SFX_EVENTS) {
    out.minGap[key] = clamp(num(src.minGap?.[key]) ?? shape.minGap?.[key] ?? 0, LIMITS.minGap);
  }
  for (const key of Object.keys(shape.engine ?? {})) {
    const v = num(src.engine?.[key]) ?? shape.engine[key];
    if (num(v) != null) out.engine[key] = clamp(v, LIMITS.engine);
  }
  return out;
}

/** A deep copy, since a mix is nested and `tune` writes into it. */
const copyMix = (mix) => JSON.parse(JSON.stringify(mix));

/** The mix as shipped, from mix.json. The panel's Reset returns to this. */
export const SHIPPED_MIX = cleanMix(MIX, null);

const MUTE_KEY = 'simTaxi.muted';

function readMuted() {
  try { return window.localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(on) {
  try { window.localStorage.setItem(MUTE_KEY, on ? '1' : '0'); } catch { /* soft, as ever */ }
}

/**
 * Where a loop's real audio sits inside the decoded buffer. Trimmed or not, the tail is the tail,
 * so a buffer longer than the master by roughly the priming pad has it at the front.
 */
function loopWindow(buffer, seconds) {
  const extra = buffer.duration - seconds;
  const start = extra > AAC_PRIMING * 0.5 ? Math.min(AAC_PRIMING, extra) : 0;
  return { start, end: Math.min(buffer.duration, start + seconds) };
}

/**
 * @param {object} opts
 * @param {{ next: () => number }} [opts.rng]  Draws each trigger's take (`pickTake`). Math.random without.
 */
export function createSfx({ rng } = {}) {
  const hasAudio = typeof window !== 'undefined'
    && (window.AudioContext || window.webkitAudioContext);
  const state = {
    muted: hasAudio ? readMuted() : true,
    // The player's two volume sliders on the title screen's Settings (game/settings.js owns
    // remembering them; this only applies them). 0..1 as the slider reads, squared on the way to
    // the gain node, because a linear gain spends the whole bottom half of a slider on "loud".
    effects: 1,
    music: 1,
    // The radio pulled down under the drive-through speaker — see `duckMusic`.
    ducked: false,
    ready: false,
    loaded: 0,
    total: Object.keys(FILES).length,
    held: false,
    // The radio's last few tracks as scheduled, `{ track, at }` in context seconds — for checking
    // the rotation from the console (`__taxi.sfx.state.radio`).
    radio: [],
  };
  const random = rng ? () => rng.next() : Math.random;
  // Live, and read every frame, so the panel can move any number while the car is driving.
  const mix = copyMix(SHIPPED_MIX);
  const tuning = () => copyMix(mix);
  /** Merge a partial mix in. Anything unknown or non-numeric is dropped (see `cleanMix`). */
  function tuneMix(partial) {
    const merged = copyMix(mix);
    const src = partial && typeof partial === 'object' ? partial : {};
    if ('master' in src) merged.master = src.master;
    for (const part of ['sounds', 'minGap', 'engine']) {
      for (const [key, value] of Object.entries(src[part] ?? {})) {
        if (!(key in merged[part])) continue;
        merged[part][key] = part === 'sounds' ? { ...merged[part][key], ...value } : value;
      }
    }
    Object.assign(mix, cleanMix(merged, SHIPPED_MIX));
  }
  if (!hasAudio) {
    // Headless, or a browser without Web Audio: every call is a no-op — except the mix, which is
    // plain data and is what `npm run check` exercises.
    const noop = () => {};
    return {
      state, play: noop, update: noop, hold: noop, setMuted: noop, toggleMuted: () => true,
      setVolumes: noop,
      locoOn: noop, locoOff: noop, release: noop, duckMusic: noop,
      tuning, tune: tuneMix, reset: () => tuneMix(SHIPPED_MIX),
      audition: () => null, stopAuditions: noop, files: FILES, radioFiles: RADIO_FILES,
    };
  }

  // Ask iOS for the "playback" session: plays through the ring/silent switch, the way a music app
  // does, because the game carries its own music as well as effects. The cost is that it stops
  // the player's own music rather than mixing with it; "ambient" was the other way round, and a
  // phone on silent heard nothing. Safari 16.4+; elsewhere the property does not exist.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* old */ }

  // Fetched now, decoded once there is a context to decode into.
  //
  // Each download is marked handled the moment it is made, because nothing else listens to it
  // until the first tap runs `start()` — and a download that fails before then is an *unhandled*
  // rejection in the meantime, which index.html's panel puts over the whole screen. That is a
  // launch with a bad connection: a Home Screen launch that lands on a dropped or still-attaching
  // network fails every uncached file at once, and Safari's `TypeError: Load failed` carries an
  // empty `stack`, so the panel read "Unhandled rejection:" and nothing else. A missing sound is
  // not a broken game; `start()` still awaits the original promise and logs it as one.
  const bytes = {};
  for (const [key, url] of Object.entries({ ...FILES, ...RADIO_FILES })) {
    bytes[key] = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.arrayBuffer();
    });
    bytes[key].catch(() => {});
  }

  let ctx = null;
  let master = null;
  // `resume()` and `suspend()` return promises that WebKit rejects (a context it has closed behind
  // the app's back, a resume it will not allow outside a gesture). Every call here is
  // fire-and-forget and the next gesture tries again, so a refusal is not an error worth a panel.
  // (`Promise.resolve` because the prefixed `webkitAudioContext` of an older iOS returns nothing.)
  const resumeCtx = () => { Promise.resolve(ctx.resume()).catch(() => {}); };
  const suspendCtx = () => { Promise.resolve(ctx.suspend()).catch(() => {}); };
  // The music's own level, beside `master` rather than under it, so the two sliders are
  // independent. The radio (`startRadio`) is what plays into it.
  let musicBus = null;
  /** What the master gain should read: the mix's master, under the player's slider and the mute. */
  const masterLevel = () => (state.muted ? 0 : mix.master * state.effects ** 2);
  const musicLevel = () => (state.muted ? 0 : state.music ** 2 * (state.ducked ? MUSIC_DUCK : 1));
  const buffers = {};    // by file name
  const lastAt = {};
  const lastTake = {};   // by sound name: the file it played last

  /**
   * One of `name`'s takes, at random — but never the one it played last, so a run of three bumps
   * cannot be the same recording three times, which a plain pick does one time in nine. Only takes
   * that actually decoded are drawn from, so a missing file thins the set rather than silencing it.
   */
  function pickTake(name) {
    const loaded = SOUNDS[name].filter((f) => buffers[f]);
    if (!loaded.length) return null;
    const fresh = loaded.length > 1 ? loaded.filter((f) => f !== lastTake[name]) : loaded;
    const file = fresh[Math.floor(random() * fresh.length)];
    lastTake[name] = file;
    return file;
  }

  // --- the beds, built once the buffers are in ---
  let idle = null;       // { src, gain }
  let loco = null;       // the Loco loop bed
  let signal = null;     // the blinker; recreated per indicating window so each opens on a tick
  let siren = null;      // the police siren; always running, its level steered by `update`
  let activate = null;   // the current Loco activate voice, or null
  let locoSince = -1;    // ctx time the current hold began, or -1
  let signalHand = null;
  let stoppedFor = 0;
  let wasAir = false;
  let wasBraking = false;

  function makeLoop(key, gain = 0) {
    const src = ctx.createBufferSource();
    src.buffer = buffers[SOUNDS[key][0]];
    src.loop = true;
    const w = loopWindow(src.buffer, LOOP_SECONDS[key]);
    src.loopStart = w.start;
    src.loopEnd = w.end;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start(0, w.start);
    return { src, gain: g };
  }

  function stopVoice(v, tau = mix.engine.release) {
    if (!v) return;
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, tau);
    try { v.src.stop(t + tau * 6); } catch { /* already stopped */ }
  }

  async function start() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = masterLevel();
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = musicLevel();
    musicBus.connect(ctx.destination);
    startRadio();
    await Promise.all(Object.keys(FILES).map(async (key) => {
      const p = bytes[key];
      try {
        const buf = await p;
        buffers[key] = await ctx.decodeAudioData(buf);
        state.loaded++;
      } catch (err) {
        console.warn(`sfx: ${key} did not load`, err);
      }
    }));
    if (buffers[SOUNDS.idle[0]]) idle = makeLoop('idle');
    if (buffers[SOUNDS.siren[0]]) siren = makeLoop('siren');
    if (buffers[SOUNDS.locoLoop[0]]) loco = makeLoop('locoLoop');
    state.ready = true;
    if (state.held) suspendCtx();
  }

  // --- the radio ---
  const radioBuffers = {};
  let lastSong = null;
  async function decodeRadio(key) {
    try {
      radioBuffers[key] = await ctx.decodeAudioData(await bytes[key]);
    } catch (err) {
      console.warn(`sfx: ${key} did not load`, err);
    }
  }

  /** Play `key` into the music bus from `when`, calling `onEnd` once it has finished. */
  function playTrack(key, when, onEnd) {
    const buffer = radioBuffers[key];
    const w = loopWindow(buffer, RADIO.seconds[key]);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = RADIO.gain[key];
    src.connect(g).connect(musicBus);
    src.onended = onEnd;
    src.start(when, w.start, w.end - w.start);
    return when + (w.end - w.start);
  }

  // Tracks scheduled on the audio clock and not yet ended, and when the last of them ends.
  let ahead = 0;
  let queuedEnd = 0;
  function queue(key) {
    const when = Math.max(queuedEnd, ctx.currentTime);
    ahead++;
    queuedEnd = playTrack(key, when, () => { ahead--; topUp(); });
    state.radio = [...state.radio.slice(-7), { track: key, at: when }];
  }

  /**
   * Keep **two** tracks on the clock: the one playing and the one after it. So the next song is
   * always already scheduled when the current one ends and the cut is sample-exact, where starting
   * each song from the previous one's `onended` would leave a gap of however late that event
   * lands. The clock stops with a hold, so a pause stops the radio mid-song, queue and all.
   */
  function topUp() {
    const loaded = RADIO.songs.filter((k) => radioBuffers[k]);
    while (ahead < 2 && loaded.length) {
      const fresh = loaded.length > 1 ? loaded.filter((k) => k !== lastSong) : loaded;
      lastSong = fresh[Math.floor(random() * fresh.length)];
      queue(lastSong);
    }
  }

  /**
   * The intro always, then songs for as long as the page is open. The intro is decoded first so it
   * starts as soon after the tap as it can; the songs decode while it plays. A file that failed to
   * download is a warning and a gap in the rotation, never an error — the rule for every sound here.
   */
  async function startRadio() {
    await decodeRadio(RADIO.intro);
    if (radioBuffers[RADIO.intro]) queue(RADIO.intro);
    await Promise.all(RADIO.songs.map(decodeRadio));
    topUp();
  }

  // The unlock. Created *inside* the gesture, because Safari only lets a context start running
  // from one; `resume()` again on every later gesture until it is actually running, because iOS
  // will also suspend it behind the app's back (a phone call, the app backgrounded).
  const unlock = () => {
    if (!ctx) start();
    else if (ctx.state !== 'running' && !state.held) resumeCtx();
  };
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) suspendCtx();
    else if (!state.held) resumeCtx();
  });

  /**
   * Fire a one-shot. `delay` is seconds from now on the audio clock, which stops with a hold, so a
   * door scheduled to close after the rider climbs in waits through a pause with the rest.
   */
  function play(name, { gain = 1, rate = 1, delay = 0 } = {}) {
    if (!SFX_EVENTS.has(name)) throw new Error(`unknown sound: ${name}`);
    if (!state.ready || state.muted) return null;
    const now = ctx.currentTime;
    const gap = mix.minGap[name];
    if (gap && lastAt[name] != null && now + delay - lastAt[name] < gap) return null;
    const file = pickTake(name);
    if (!file) return null;
    lastAt[name] = now + delay;
    const src = ctx.createBufferSource();
    src.buffer = buffers[file];
    src.playbackRate.value = rate * mix.sounds[name].rate;
    const g = ctx.createGain();
    g.gain.value = gain * mix.sounds[name].gain;
    src.connect(g).connect(master);
    src.start(now + delay);
    return { src, gain: g };
  }

  /** The pill went down — the frame `boost.press()` answered true. */
  function locoOn() {
    if (!state.ready) return;
    play('locoLaunch');
    stopVoice(activate);
    activate = play('locoActivate');
    locoSince = ctx.currentTime;
  }

  /** The hold ended — released, braked, run out, or the run over. Idempotent. */
  function locoOff() {
    if (!state.ready || locoSince < 0) return;
    locoSince = -1;
    stopVoice(activate, 0.15);
    activate = null;
  }

  /**
   * Steer the beds off this frame's taxi.
   *
   * @param {number} dt
   * @param {object} taxi       `traffic.taxi`
   * @param {object} opts
   * @param {number} opts.cruise  The ordinary top speed (SPEED).
   * @param {number} opts.top     The Loco top (`boostCruise()`).
   * @param {boolean} opts.holding  The pill is held (not the cooldown tail).
   * @param {boolean} opts.over   The run has ended.
   * @param {number} [opts.siren]  0..1, how loud the nearest running siren is from where the taxi
   *   is — main.js works it out from distance (see `sirenLevel` there). 0 is no siren on the map.
   */
  function update(dt, taxi, { cruise, top, holding, over, siren: sirenAt = 0 }) {
    if (!state.ready) return;
    const t = ctx.currentTime;
    const v = Math.max(0, taxi.v);
    const alive = !over && !taxi.crashed;

    if (!holding && locoSince >= 0) locoOff();

    // The engine. Pitched off speed, ducked under Loco, and gone with the run.
    const s = Math.min(1, v / cruise);
    const locoUp = alive && locoSince >= 0;
    const e = mix.engine;
    if (idle) {
      const rate = (e.idleRateLo + (e.idleRateHi - e.idleRateLo) * s) * mix.sounds.idle.rate;
      idle.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const g = !alive ? 0 : mix.sounds.idle.gain * (locoUp ? e.idleUnderLoco : 1);
      idle.gain.gain.setTargetAtTime(g, t, alive ? e.pitchGlide * 2 : 0.4);
    }
    if (loco) {
      const over01 = Math.max(0, Math.min(1, (v - cruise) / Math.max(1e-6, top - cruise)));
      const rate = (e.locoRateLo + (e.locoRateHi - e.locoRateLo) * over01)
        * mix.sounds.locoLoop.rate;
      loco.src.playbackRate.setTargetAtTime(rate, t, e.pitchGlide);
      const held = locoUp ? t - locoSince : 0;
      const k = locoUp
        ? Math.max(0, Math.min(1, (held - e.locoLoopAt) / Math.max(1e-3, e.locoLoopFade))) : 0;
      loco.gain.gain.setTargetAtTime(mix.sounds.locoLoop.gain * k, t, locoUp ? 0.3 : e.release);
    }

    // Pulling away from a stop. Not while the pill is up: the launch is that car's pull-away.
    if (v < STOP_V) stoppedFor += dt;
    else {
      if (v > GO_V && stoppedFor >= e.pullAwayHold && alive && !taxi.boost) play('accel');
      if (v > GO_V) stoppedFor = 0;
    }

    // The taxi slowing on its own — for a red, a queue, a turn. Off the brake *lamp* (eased in
    // sim/traffic.js off the car's real deceleration), on its rising edge, and softer than the
    // pedal's, which is the player's own stop and has already played at the press.
    const braking = taxi.brakeLevel > 0.6 && v > 2.5;
    if (braking && !wasBraking && alive && !taxi.braking) play('brake', { gain: e.selfBrakeGain });
    wasBraking = braking;

    // Off a ramp. The landing has its own event (`traffic.onTaxiLand`); the takeoff is only
    // visible as `hopFrom` turning non-null, so it is read off the edge here.
    const air = taxi.hopFrom != null;
    if (air && !wasAir && alive) play('takeoff');
    wasAir = air;

    // The blinker. A fresh voice per window, so it opens on its first tick exactly as the lamp
    // opens lit (the sim restarts `signalT` on every change of hand — see TURN_SIGNAL_HZ). The
    // master's ticks are 0.9s apart, which is the sim's 1.1 Hz: they stay in step with the lamp.
    const hand = alive ? taxi.signalHand : null;
    if (hand !== signalHand) {
      stopVoice(signal, 0.03);
      signal = hand && buffers[SOUNDS.signal[0]] && !state.muted ? makeLoop('signal', mix.sounds.signal.gain)
        : null;
      signalHand = hand;
    }
    if (signal) {
      signal.gain.gain.setTargetAtTime(mix.sounds.signal.gain, t, 0.02);
      signal.src.playbackRate.setTargetAtTime(mix.sounds.signal.rate, t, 0.02);
    }

    // The siren. A bed like the idle rather than a voice started per chase: it runs silent all
    // run and the frame says how loud, so a chase that ends any of the ways one can (lost, bust,
    // the depot, a wreck) can never leave it wailing. A quarter-second glide, so a cop passing
    // the falloff's edge swells in rather than switching on. Gone with the run, like the engine.
    if (siren) {
      const g = over ? 0 : mix.sounds.siren.gain * Math.max(0, Math.min(1, sirenAt));
      siren.gain.gain.setTargetAtTime(g, t, over ? 0.4 : 0.25);
      siren.src.playbackRate.setTargetAtTime(mix.sounds.siren.rate, t, 0.02);
    }
  }

  /** Stop the clock under everything — the pause and the robber's line, which stop the world. */
  function hold(on) {
    if (on === state.held) return;
    state.held = on;
    if (!ctx) return;
    if (on) suspendCtx();
    else if (!document.hidden) resumeCtx();
  }

  function setMuted(on) {
    state.muted = Boolean(on);
    writeMuted(state.muted);
    if (!ctx) return;
    master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.02);
    if (state.muted) { stopVoice(signal, 0.02); signal = null; signalHand = null; }
  }

  /** The player's sliders, 0..1 each; either may be omitted. Applied at once if the context is up. */
  function setVolumes({ effects, music } = {}) {
    const unit = (v, was) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : was);
    state.effects = unit(effects, state.effects);
    state.music = unit(music, state.music);
    if (!ctx) return;
    master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.02);
  }

  /** Pull the radio down under a voice that has to be heard (true), or let it back up (false). */
  function duckMusic(on) {
    if (Boolean(on) === state.ducked) return;
    state.ducked = Boolean(on);
    if (!ctx) return;
    // Slower back up than down: the speaker's first word should not be under the chorus, and the
    // song coming back over half a second reads as a fade rather than a switch.
    musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, on ? 0.12 : 0.5);
  }

  function tune(partial) {
    tuneMix(partial);
    if (master) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.02);
  }

  // The panel's audition voices, tracked so an 11-second activate can be stopped.
  const auditions = new Set();
  /**
   * Play a sound once at its mixed gain and rate, loops included and past `minGap` — the panel's
   * ▶. A sound with variants draws the next take the way `play` does. Returns the file it played,
   * or null when nothing could (no tap yet, the file missing, muted or held).
   */
  function audition(key) {
    if (!state.ready || state.muted || state.held || !SOUNDS[key]) return null;
    const file = pickTake(key);
    if (!file) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffers[file];
    src.playbackRate.value = mix.sounds[key].rate;
    const g = ctx.createGain();
    g.gain.value = mix.sounds[key].gain;
    src.connect(g).connect(master);
    const voice = { src, gain: g };
    auditions.add(voice);
    src.onended = () => auditions.delete(voice);
    src.start();
    return file;
  }
  function stopAuditions() {
    for (const v of auditions) stopVoice(v, 0.03);
    auditions.clear();
  }

  return {
    state,
    play,
    tuning,
    tune,
    reset: () => tune(SHIPPED_MIX),
    audition,
    stopAuditions,
    files: FILES,
    update,
    hold,
    locoOn,
    locoOff,
    /** Fade out a voice `play()` returned — the drive-through speaker as the taxi leaves the lot. */
    release: (voice, tau = 0.3) => stopVoice(voice, tau),
    duckMusic,
    setMuted,
    setVolumes,
    toggleMuted: () => { setMuted(!state.muted); return state.muted; },
  };
}
