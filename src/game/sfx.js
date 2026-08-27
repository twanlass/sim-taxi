/**
 * The game's sound, synthesised.
 *
 * **Zero external assets, the same as every mesh in this project.** There is no `.wav`, no
 * `AudioBuffer` decoded off the network and no loader — every sound here is oscillators, a noise
 * buffer generated in code, filters and envelopes. That is not asceticism for its own sake: the
 * whole bundle is ~400KB of JavaScript today, a Home Screen launch has to work with no connection
 * (see `public/sw.js`), and the iOS shell serves `dist/` off a custom scheme where a fetch for an
 * audio file is one more thing to get wrong. A dozen sample files would be larger than the game.
 *
 * **Named events, not parameters** — the same contract as `util/haptics.js`, and for the same
 * reason. A caller says `sfx.play('pickup')` and this module decides what a pickup sounds like, so
 * the bank can be retuned in one place without touching a single call site. The names are a closed
 * set (`SOUNDS`) and an unknown one throws here rather than going silently missing on a phone.
 *
 * **Nothing exists until a gesture, and nothing throws if it never can.** Browsers refuse to start
 * an `AudioContext` outside a user gesture and hand back one stuck in `'suspended'` if you try, so
 * the context is built lazily by `unlock()` — wired in `main.js` to the first pointer or key the
 * page sees. Everything else degrades to silence: no `AudioContext` constructor, a context that
 * refuses to resume, a node type the engine does not have — each of those is a game with no sound
 * rather than a game that stopped. This is the `highscores.js` rule (a dead store is an empty
 * table, never an error) applied one module over, and it matters more here: nobody has ever lost a
 * run because it was quiet.
 *
 * **Read `window` at call time, never at import.** `tools/check.mjs` boots this whole module graph
 * in node, where there is no `window` and no `AudioContext`; a module-level probe for either would
 * take the headless suite down. Same rule as `util/platform.js` and `util/haptics.js`.
 *
 * **The context factory is injectable**, which is what lets `tools/sfx.mjs` drive the entire bank
 * in node against a fake and assert the things a browser test cannot see: that every voice is
 * stopped and disconnected, that no envelope ramps exponentially to zero (a real `AudioParam`
 * throws on that, and it is the classic Web Audio footgun), that the voice cap holds, and that a
 * muted game schedules literally nothing. Same seam as `highscores.js`'s injectable store.
 *
 * **On the native side**, `AppDelegate.swift` sets `AVAudioSession` to `.ambient` so this mixes
 * with whatever the player is already listening to and obeys the ring/silent switch — a game that
 * stops somebody's podcast to play a coin sound gets muted permanently, in the OS settings, on the
 * first run. See docs/audio.md.
 */

// The siren's proximity curve is *imported* rather than restated: `game/sirenglow.js` already
// decides how close a cruiser has to be before it is worth warning about, and a second copy of
// those numbers would drift the moment either was tuned. One rule, three surfaces — the light bar,
// the wash over the frame edge, and now the wail. See `sirenLoudness` below.
import { GLOW_NEAR, GLOW_FAR, GLOW_FLOOR } from './sirenglow.js';

// --- The bank ---------------------------------------------------------------
//
// One entry per thing that happens, and the division mirrors `util/haptics.js`: sounds the player
// caused, which answer a thumb already on the glass and so are short and bright; and sounds the
// world caused, which are news and carry their weight in timbre rather than in timing.
//
// Every one of them is gated on the event having been *accepted*. A refused tap stays silent, for
// the same reason it gets no buzz — a confirming blip on a refusal says the opposite of what the
// screen is saying.

/**
 * Every name `play()` will answer to. A closed set on purpose: a `postMessage` naming an event
 * Swift does not know is dropped in silence, and so is a typo'd key in a lookup table. Throwing
 * here turns both into a caught error at the call site instead.
 */
export const SOUNDS = [
  // The player did something.
  'pick',        // a tap that re-aimed the taxi — a rider, a drop-off pin, a package pad
  'loco',        // Loco Mode engaging under a hold: the bark out of the tailpipe
  'brake',       // the brake going down hard enough to lock a wheel
  // The world did something.
  'spawn',       // a rider has appeared on the board
  'pickup',      // a rider is aboard
  'dropoff',     // a fare delivered, and paid
  'urgency',     // a fare's clock stepped down a colour — the countdown, audible
  'parcel-in',   // a package collected off its pad
  'parcel-out',  // a package delivered
  // ...and the three ways a run ends.
  'crash',       // wrecked against ambient traffic
  'bust',        // caught boosting past a cop
  'fail',        // a clock ran out
];

const SOUND_SET = new Set(SOUNDS);

/**
 * Master level. Everything below is written against a peak of 1.0 per voice and then scaled by
 * this, so retuning "how loud is the game" is one number rather than twelve.
 *
 * 0.5 rather than 1.0 because the compressor below is a safety net, not a mix stage. The loudest
 * single sound in the bank is the crash, whose three layers overlap at a combined peak of 1.55
 * before this scaling (measured in `tools/sfx.mjs`, which asserts it) — so unity would put it half
 * again over full scale and leave the limiter to fix a mix that was wrong on paper.
 *
 * Exported so that assertion can be written against the real number rather than a copy of it.
 */
export const MASTER_GAIN = 0.5;

/**
 * How many one-shot voices may be alive at once before new ones are dropped.
 *
 * A cap rather than a queue: the sounds this drops are the ones that arrived while a dozen others
 * were already playing, which is exactly the moment a thirteenth adds nothing but mud. It also
 * bounds the node count against the one failure mode a synthesised bank actually has — an event
 * that fires every frame would otherwise build oscillators forever, and a browser tab that has
 * accumulated ten thousand of them does not recover.
 *
 * 16 is well above anything the game produces on purpose (the busiest single frame in the bank is
 * a crash at 6 voices) and well below where scheduling cost shows up in a frame budget.
 */
const MAX_VOICES = 16;

/**
 * The shortest gap between two firings of the same name, in seconds.
 *
 * Only the sounds a *tap* can fire need one: a thumb can jab a marker ten times a second and the
 * game answers every one of them (the taps are all legitimate — each really does re-aim the taxi),
 * which stacks ten copies of the same 60ms blip into a rasp. Everything else is rate-limited by
 * the thing that fires it: there is one crash per run and one delivery per fare.
 *
 * Deliberately shorter than the sound it guards. It is there to stop a mechanical buzz, not to
 * refuse the player a second tap — 50ms is faster than a double-tap and slower than a frame.
 */
const REPEAT_GAP = { pick: 0.05, urgency: 0.08 };

/** Guard for `exponentialRampToValueAtTime`, which throws on a target of exactly zero. */
const SILENT = 0.0001;

/** Where the mute flag lives. Bumped if the shape ever stops being a single boolean. */
const MUTE_KEY = 'simtaxi.muted.v1';

// --- The siren's loudness ---------------------------------------------------

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * How loud the siren should be, from the cruiser's published state and its distance to the taxi.
 *
 * Pure, and exported, for the same reason `sirenWash` is: the property worth asserting is a number,
 * and a headless tool can check it against a real corridor run where a screenshot never could.
 *
 * **Gated on `state.lit` and on nothing else.** That is the rule the player already knows from the
 * light bar — lights on means a cop is here — and the wail has to be the same announcement heard
 * rather than a second opinion with its own threshold. Note what it is *not* gated on: unlike the
 * frame-edge wash, being on screen makes no difference. You can see a cruiser you are looking at;
 * you can hear one either way, and a siren that cut out the moment the car came into frame would
 * be the one moment it stopped meaning anything.
 *
 * @param state     the cruiser's published state (sim/police.js)
 * @param distance  world units from the taxi to the cruiser
 * @returns 0 when there is nothing to hear, up to 1 alongside
 */
export function sirenLoudness(state, distance) {
  if (!state || !state.lit) return 0;
  if (!(distance >= 0)) return 0;
  const near = clamp01((GLOW_FAR - distance) / (GLOW_FAR - GLOW_NEAR));
  // The same floor the wash keeps, and for the same reason: a cruiser on the far side of the city
  // is still one the player wants to know about, it just is not the thing about to happen.
  return GLOW_FLOOR + (1 - GLOW_FLOOR) * near;
}

// --- The engine -------------------------------------------------------------

/**
 * @param context   () => AudioContext — injected by `tools/sfx.mjs`. The default reads `window` at
 *                  call time and returns null anywhere there is no Web Audio at all.
 * @param store     the mute flag's home. Injected for the same reason `highscores.js` injects one.
 * @param muted     the starting state when storage has nothing to say. `true` in shot mode, where
 *                  the whole point is a frame that gets rendered and never played.
 */
export function createSfx({ context = defaultContext, store = defaultStore(), muted = null } = {}) {
  const state = {
    /** Null until `unlock()` has run inside a gesture. Everything checks it. */
    ctx: null,
    /** Set once the context has refused to start, so `unlock()` stops retrying on every tap. */
    dead: false,
    muted: readMuted(store) ?? muted ?? false,
    /** One-shot voices currently scheduled, for MAX_VOICES. */
    voices: 0,
    /** Wall of the *audio* clock, per name, for REPEAT_GAP. */
    lastAt: Object.create(null),
    /** Where the siren's wail is in its sweep, in cycles. Advanced by `update`, never by a clock
     *  of its own — a paused game holds it exactly where it was. */
    wail: 0,
  };

  let master = null;      // gain -> compressor -> destination
  let noise = null;       // one second of white noise, generated once and shared
  let roar = null;        // the Loco Mode engine bed, built on first use and then kept
  let siren = null;       // the cruiser's wail, likewise

  // --- context lifecycle ----------------------------------------------------

  /**
   * Build the audio stack, or resume one the browser suspended. Safe to call on every gesture:
   * it is a no-op once the context is running and gives up permanently once it has failed.
   *
   * Returns the context or null, so callers can be written as `const ctx = unlock(); if (!ctx)`.
   */
  function unlock() {
    if (state.dead) return null;
    if (!state.ctx) {
      try {
        state.ctx = context();
      } catch { state.ctx = null; }
      if (!state.ctx) { state.dead = true; return null; }
      try {
        buildMaster();
      } catch { state.dead = true; state.ctx = null; return null; }
    }
    // A context can be suspended long after it was created — by the autoplay policy on the first
    // gesture, by iOS taking one away for a phone call and handing it back. The resume is
    // fire-and-forget: it returns a promise that rejects on a context the browser is refusing to
    // start, and there is nothing useful to do about that but stay quiet.
    try {
      if (state.ctx.state === 'suspended') state.ctx.resume()?.catch?.(() => {});
    } catch { /* a context that will not resume is a game with no sound */ }
    return state.ctx;
  }

  function buildMaster() {
    const ctx = state.ctx;
    // A **limiter** on the bus rather than a compressor doing mix duty, and the settings say which
    // of the two this is. `MASTER_GAIN` already puts the loudest single sound in the bank — the
    // crash, three overlapping layers — at a peak of 0.78, which `tools/sfx.mjs` measures and
    // gates. So the mix is correct on paper and this exists for the case arithmetic cannot fix: a
    // delivery chime landing on the same frame as that crash, with the engine bed still up. A high
    // threshold and a steep ratio leave every ordinary sound alone and catch only the sum.
    //
    // The fast attack is the whole point of a limiter — 3ms catches the transient rather than the
    // tail of it — and the release is slow enough not to pump audibly on a bank this percussive.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -3;      // ≈0.71 linear: above every single voice, under any pile-up
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = state.muted ? 0 : MASTER_GAIN;
    master.connect(comp);
  }

  /** One second of white noise, generated once and shared by every voice that needs a hiss. */
  function noiseBuffer() {
    if (noise) return noise;
    const ctx = state.ctx;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise = buffer;
    return noise;
  }

  // --- voice construction ---------------------------------------------------

  /**
   * The envelope every voice in this bank wears: silent, a linear attack to peak, then an
   * exponential fall.
   *
   * The two ramp types are not interchangeable and the split is deliberate. A linear *attack* from
   * zero is the only one that can start at zero at all — `exponentialRampToValueAtTime` throws
   * outright on a target of zero and does nothing useful from a current value of zero. An
   * exponential *decay* is the one that sounds like something stopping: a linear fade reads as a
   * note being turned down, which is audibly wrong on a percussive bank like this one.
   *
   * `SILENT` rather than 0 as the decay target for that same throw. Asserted in `tools/sfx.mjs` —
   * it is the mistake this file is most likely to acquire in a later edit, and in a browser it
   * surfaces as one sound silently missing rather than as anything that looks like an error.
   */
  function envelope(param, t0, { peak, attack, hold = 0, dur }) {
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(peak, t0 + attack);
    if (hold > 0) param.setValueAtTime(peak, t0 + attack + hold);
    param.exponentialRampToValueAtTime(SILENT, t0 + dur);
  }

  /**
   * One oscillator with an envelope on it, optionally sweeping in pitch, optionally through a
   * filter. The whole bank is built out of this and `hiss` below.
   *
   * Every node is stopped at a known time and disconnects itself on `ended` — see `retire`. A
   * synthesised bank has no streams to leak but it has plenty of nodes, and a fifteen-minute run
   * fires a few hundred voices.
   */
  function blip(t0, {
    type = 'triangle', freq, to = null, peak = 0.5, attack = 0.005, hold = 0, dur = 0.2,
    filter = null,
  }) {
    const ctx = state.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // Exponential in pitch, not linear: pitch is perceived logarithmically, so a linear sweep from
    // 90 to 900 spends most of its time in the top octave and reads as a click with a tail.
    if (to !== null && to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);

    const gain = ctx.createGain();
    envelope(gain.gain, t0, { peak, attack, hold, dur });

    let tail = osc;
    if (filter) tail = through(osc, filter, t0, dur);
    tail.connect(gain);
    gain.connect(master);

    osc.start(t0);
    osc.stop(t0 + dur);
    retire(osc, [osc, gain, tail === osc ? null : tail]);
    return osc;
  }

  /** A burst of the shared noise buffer, filtered — every impact, screech and chuff in the bank. */
  function hiss(t0, { peak = 0.4, attack = 0.004, hold = 0, dur = 0.3, filter = null, rate = 1 }) {
    const ctx = state.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    src.playbackRate.value = rate;
    // Looped, and started at a random point in the second of noise. Two separate reasons, and the
    // first is the one that would bite: the buffer is exactly a second long, so a burst asked for a
    // longer `dur` than that would run off the end and finish in silence — a bug that shows up as
    // "the screech got quiet", not as anything that fails. The offset is the smaller point: the
    // brake is the most-repeated noise voice in the game and starting every screech on the same
    // sample gives them all an identical texture, which the ear picks up as a loop long before it
    // could name why.
    src.loop = true;
    src.loopEnd = src.buffer.duration ?? 1;

    const gain = ctx.createGain();
    envelope(gain.gain, t0, { peak, attack, hold, dur });

    let tail = src;
    if (filter) tail = through(src, filter, t0, dur);
    tail.connect(gain);
    gain.connect(master);

    src.start(t0, Math.random() * (src.loopEnd || 1));
    src.stop(t0 + dur);
    retire(src, [src, gain, tail === src ? null : tail]);
    return src;
  }

  /** A biquad between a source and the bus, with its own optional sweep. */
  function through(source, { type = 'lowpass', freq, to = null, q = 1 }, t0, dur) {
    const node = state.ctx.createBiquadFilter();
    node.type = type;
    node.Q.value = q;
    node.frequency.setValueAtTime(freq, t0);
    if (to !== null && to !== freq) node.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    source.connect(node);
    return node;
  }

  /**
   * Book one voice against the cap and hand every node back to the garbage collector when it ends.
   *
   * `onended` rather than a `setTimeout`: the audio clock and the timer queue are different clocks,
   * and a backgrounded tab throttles one of them to once a second while the other keeps perfect
   * time. Disconnecting a node a second late is harmless; disconnecting one a second *early*, which
   * is what the same drift does to a tab coming back, cuts a sound off mid-envelope.
   */
  function retire(source, nodes) {
    state.voices += 1;
    source.onended = () => {
      state.voices -= 1;
      for (const node of nodes) { try { node?.disconnect(); } catch { /* already gone */ } }
    };
  }

  // --- the sounds themselves ------------------------------------------------
  //
  // Each takes the start time and whatever it needs to know, and is otherwise free to build as many
  // voices as it likes. Frequencies are written as numbers rather than note names because several
  // of them are not notes — a screech and a fireball have a pitch, not a key.

  const BANK = {
    /**
     * A tap that landed. The shortest thing in the bank by a factor of three: it answers a thumb
     * that is still on the glass, and anything with a tail would still be sounding when the player
     * taps the next one.
     */
    pick: (t) => {
      blip(t, { type: 'triangle', freq: 1180, to: 1560, peak: 0.30, dur: 0.07 });
      blip(t, { type: 'sine', freq: 2360, peak: 0.10, dur: 0.04 });
    },

    /**
     * A rider has appeared. A soft two-note bell rather than an alert — this is information the
     * player wants and is not, by itself, urgent; the urgency has its own sound and a whole colour
     * scale below it. Long decays, low peak, and the fifth arriving late enough to read as two
     * notes rather than a chord.
     */
    spawn: (t) => {
      blip(t, { type: 'sine', freq: 784, peak: 0.24, dur: 0.42 });
      blip(t + 0.085, { type: 'sine', freq: 1175, peak: 0.20, dur: 0.50 });
      // A touch of triangle under the first partial gives the sine an edge to be heard over the
      // compressor's release; a pure sine at this level disappears behind a passing crash.
      blip(t, { type: 'triangle', freq: 392, peak: 0.09, dur: 0.30 });
    },

    /**
     * Somebody got in. A door thump and a rising interval — the thump is the physical event and the
     * rise is the promise, which is why it goes up where `dropoff` resolves.
     */
    pickup: (t) => {
      hiss(t, { peak: 0.34, dur: 0.10, filter: { type: 'lowpass', freq: 620, to: 180 } });
      blip(t + 0.02, { type: 'triangle', freq: 523, to: 784, peak: 0.28, dur: 0.16 });
    },

    /**
     * The payout — the most important sound in the game and the only one that changes with the
     * state of the run. A major arpeggio, four notes, and the whole thing transposed up a semitone
     * per fare already delivered: nothing else in the game tells the player they are having a good
     * run *while they are having it*, and a pitch climbing over fifteen minutes does it without
     * asking them to read anything.
     *
     * A semitone each and capped at an octave, which is not an arbitrary pair of numbers — a
     * perfect player survives a median of 15 fares (docs/difficulty.md), so the cap lands within a
     * couple of deliveries of the end of a good run. It climbs for as long as there is a run left
     * to climb through, and stops before the top note leaves "bright" for "shrill".
     *
     * @param streak fares delivered this run, this one included
     */
    dropoff: (t, { streak = 1 } = {}) => {
      const step = Math.min(12, Math.max(0, Math.round(streak) - 1));
      const shift = 2 ** (step / 12);
      const notes = [659.3, 830.6, 987.8, 1318.5];
      notes.forEach((note, i) => {
        blip(t + i * 0.052, {
          type: 'triangle', freq: note * shift, peak: 0.26 - i * 0.02, dur: 0.30 + i * 0.05,
        });
      });
      // The coin's own body, under the arpeggio rather than beside it.
      blip(t, { type: 'sine', freq: 329.6 * shift, peak: 0.16, dur: 0.22 });
    },

    /**
     * A fare's clock stepped down a colour. The audible half of `game/urgency.js` — the crystal
     * over the rider's head swells on the same frame, and this is that swell heard.
     *
     * **The pitch falls as the clock does**, which is the whole design: the scale runs 4 → 0 and
     * so does this, so a player who has learned it knows how much trouble a fare is in without
     * finding it on the map. The last step doubles the tick, because "one quarter left" is the one
     * that is actually about to cost a run.
     */
    urgency: (t, { level = 2 } = {}) => {
      const freq = [220, 262, 330, 415][Math.min(3, Math.max(0, level))];
      blip(t, { type: 'square', freq, peak: 0.11, dur: 0.09,
        filter: { type: 'lowpass', freq: 1800, q: 0.7 } });
      if (level <= 1) {
        blip(t + 0.13, { type: 'square', freq, peak: 0.11, dur: 0.09,
          filter: { type: 'lowpass', freq: 1800, q: 0.7 } });
      }
    },

    /** A box landing in the car: wood, not metal, and no pitch to speak of. */
    'parcel-in': (t) => {
      hiss(t, { peak: 0.30, dur: 0.08, filter: { type: 'bandpass', freq: 900, to: 380, q: 2.4 } });
      blip(t, { type: 'sine', freq: 196, to: 130, peak: 0.22, dur: 0.14 });
    },

    /**
     * A box delivered. Two clean high blips — the courier layer is cyan everywhere it appears and
     * this is the audible equivalent: brighter and thinner than a fare's payout, so the two events
     * are never mistaken for each other on a frame where both land.
     */
    'parcel-out': (t) => {
      blip(t, { type: 'triangle', freq: 1046.5, peak: 0.22, dur: 0.16 });
      blip(t + 0.09, { type: 'triangle', freq: 1568, peak: 0.20, dur: 0.26 });
    },

    /**
     * Loco Mode engaging: the bark out of the tailpipe on the frame the flames burst and the nose
     * comes up. A saw sweeping *up* through an opening filter is the whole trick — the filter
     * opening is what reads as a throttle rather than as a siren going the wrong way.
     */
    loco: (t) => {
      blip(t, {
        type: 'sawtooth', freq: 78, to: 190, peak: 0.34, attack: 0.008, dur: 0.34,
        filter: { type: 'lowpass', freq: 420, to: 2600, q: 2 },
      });
      hiss(t, { peak: 0.20, dur: 0.22, filter: { type: 'highpass', freq: 900, to: 2600 } });
    },

    /**
     * Rubber. Narrow bandpass on white noise, swept down as the car slows, and a high Q — a screech
     * is a resonance, and the same noise through a gentle filter is just wind.
     */
    brake: (t) => {
      hiss(t, {
        peak: 0.24, attack: 0.012, hold: 0.10, dur: 0.55,
        filter: { type: 'bandpass', freq: 1750, to: 820, q: 9 },
      });
      hiss(t, { peak: 0.08, dur: 0.4, filter: { type: 'highpass', freq: 2800 } });
    },

    /**
     * The wreck. Three layers, because an explosion is three things: the crack (broadband, gone in
     * 40ms), the body (noise falling through a closing filter, half a second) and the thump (a sine
     * dropping below where a phone speaker can reproduce it, which is fine — it is felt on
     * headphones and simply absent on a speaker, rather than sounding wrong on either).
     */
    crash: (t) => {
      hiss(t, { peak: 0.55, attack: 0.001, dur: 0.05, filter: { type: 'highpass', freq: 1200 } });
      hiss(t, { peak: 0.48, attack: 0.006, dur: 0.62,
        filter: { type: 'lowpass', freq: 2800, to: 220, q: 1.1 } });
      blip(t, { type: 'sine', freq: 132, to: 34, peak: 0.42, attack: 0.004, dur: 0.55 });
      // Bodywork, an instant behind the bang. Detuned by a tritone so it rings rather than chimes.
      blip(t + 0.03, { type: 'triangle', freq: 520, to: 367, peak: 0.10, dur: 0.34 });
    },

    /**
     * Busted. Deliberately *not* the crash: nothing hit the taxi, and a run that ends with a
     * fireball sound over an intact car reads as a bug. Two descending whoops — the cruiser's own
     * siren, said once, at you.
     */
    bust: (t) => {
      for (let i = 0; i < 2; i++) {
        blip(t + i * 0.20, {
          type: 'sawtooth', freq: 1180, to: 420, peak: 0.26, attack: 0.01, dur: 0.19,
          filter: { type: 'lowpass', freq: 2400, q: 1.4 },
        });
      }
      blip(t, { type: 'sine', freq: 98, peak: 0.20, dur: 0.5 });
    },

    /**
     * A clock ran out. Three notes down a minor triad, soft and slow — the only ending that is
     * nobody's fault but the player's own routing, and the only one the sound is allowed to be
     * quiet about. It plays under the camera's pull-in onto the rider walking off.
     */
    fail: (t) => {
      [523.3, 415.3, 311.1].forEach((note, i) => {
        blip(t + i * 0.15, { type: 'triangle', freq: note, peak: 0.24, dur: 0.42 });
      });
    },
  };

  // --- the two held voices --------------------------------------------------
  //
  // Everything above is fire-and-forget. These two are *held*: they exist for as long as the thing
  // they represent does, with their level ridden from the frame loop. They are built once, on first
  // need, and then kept — an oscillator is cheap to leave running at zero gain and expensive to
  // rebuild sixty times a second, and the gap while a new one spins up is audible as a click.

  /**
   * The Loco Mode engine bed. Two saws a few cents apart through a low-pass, which is the cheapest
   * thing that sounds like an engine rather than like a note: the beating between the two is most
   * of the character, and the filter riding the speed is the rest.
   *
   * Held only while Loco Mode is active, and that is a decision worth writing down. A permanent
   * engine drone under the whole run was the obvious first shape and it is wrong for this game:
   * the taxi drives itself most of the time, the sounds that matter are all short, and a bed under
   * them would be the loudest thing in a mix whose whole job is to make a chime audible. Silence is
   * the resting state; the roar is what Loco Mode *takes* you out of.
   */
  function ensureRoar() {
    if (roar) return roar;
    const ctx = state.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;
    filter.connect(gain);
    gain.connect(master);

    const oscs = [0, 7].map((detune) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 90;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      return osc;
    });
    roar = { gain, filter, oscs };
    return roar;
  }

  /**
   * The cruiser's wail. One square through a band-pass, swept by hand from `update` rather than by
   * an LFO node — the phase then lives in `state.wail`, which means a paused game holds the siren
   * exactly where it was instead of resuming a quarter of a cycle along.
   *
   * The sweep *rate* steps when the cruiser locks on, mirroring the light bar's own 6Hz → 11Hz
   * change (`SIREN_HZ` / `SIREN_HUNT_HZ` in sim/police.js) — the one cue that a corridor run has
   * become about you. It is not driven off `sirenOn()` itself, though, and that is not an oversight:
   * a tone alternating six times a second is a smoke alarm, not a siren. What the two share is the
   * *escalation*, which is the part the player is reading.
   */
  function ensureSiren() {
    if (siren) return siren;
    const ctx = state.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1100;
    filter.Q.value = 1.6;
    filter.connect(gain);
    gain.connect(master);

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 700;
    osc.connect(filter);
    osc.start();
    siren = { gain, filter, osc };
    return siren;
  }

  /** How fast the wail sweeps, in cycles per second: a corridor run, and a cruiser that has locked on. */
  const WAIL_HZ = 0.7;
  const YELP_HZ = 2.6;
  const WAIL_LOW = 620;
  const WAIL_HIGH = 1180;
  /** The siren's ceiling on the bus. Under every one-shot: it is a bed, not an event. */
  const SIREN_PEAK = 0.16;
  /** ...and the roar's. */
  const ROAR_PEAK = 0.19;

  // --- the public surface ---------------------------------------------------

  /**
   * Fire one sound. Silent — and free — everywhere it cannot work: before the first gesture, while
   * muted, past the voice cap, or inside the repeat gap.
   *
   * Wrapped whole in a `try`. Web Audio throws on a surprising number of things (a param ramped
   * from a NaN, a node type an engine has not shipped, a context closed out from under a call on
   * the frame a tab was discarded) and every one of them is a dropped sound rather than a reason to
   * take a run down.
   */
  function play(name, options) {
    if (!SOUND_SET.has(name)) throw new Error(`unknown sound: ${name}`);
    if (state.muted || state.dead || !state.ctx) return false;
    const ctx = state.ctx;
    // A context the browser suspended behind our back — a tab that lost focus, iOS taking a call —
    // would schedule every voice against a frozen clock and then play the whole pile at once on
    // resume. Dropping them is the only correct answer.
    if (ctx.state !== 'running') return false;
    if (state.voices >= MAX_VOICES) return false;

    const now = ctx.currentTime;
    const gap = REPEAT_GAP[name];
    if (gap !== undefined && now - (state.lastAt[name] ?? -Infinity) < gap) return false;
    state.lastAt[name] = now;

    try {
      // A hair in the future, not `now`. Scheduling against the current time races the audio thread,
      // which has already rendered the block that instant falls in — the attack then starts
      // mid-envelope and the sound opens with a click. 12ms is under a frame and comfortably over a
      // 128-sample quantum at any sample rate a browser offers.
      BANK[name](now + 0.012, options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The two held voices, ridden once a frame from `main.js`.
   *
   * Takes `dt` rather than reading a clock, so it advances with the game: paused, the wail holds;
   * in the crash's slow-motion, it slows with everything else. That is the same reason every
   * animation in this project is driven off the frame's own delta.
   *
   * @param dt        seconds of game time this frame
   * @param locoOn    is Loco Mode actually active (not merely pressed)
   * @param speed     the taxi's speed as a fraction of its boosting cruise, 0..1
   * @param sirenAt   `sirenLoudness()` for this frame — 0 when there is nothing to hear
   * @param hunting   has the cruiser locked on (`state.chasing || state.arrived`)
   */
  function update(dt, { locoOn = false, speed = 0, sirenAt = 0, hunting = false } = {}) {
    if (state.dead || !state.ctx || state.ctx.state !== 'running') return;
    const ctx = state.ctx;
    const now = ctx.currentTime;
    const quiet = state.muted;

    try {
      // Neither voice is *built* until the first frame it is actually wanted, so a run that never
      // boosts and never meets a cop never creates either — and a muted game never creates either
      // at all.
      if (locoOn && !quiet) {
        const voice = ensureRoar();
        // setTargetAtTime rather than a ramp: the target moves every frame, and a linear ramp
        // re-aimed sixty times a second is a staircase. The time constant is what makes the throttle
        // feel like it has mass.
        voice.gain.gain.setTargetAtTime(ROAR_PEAK, now, 0.05);
        voice.filter.frequency.setTargetAtTime(600 + 2400 * clamp01(speed), now, 0.08);
        for (const osc of voice.oscs) {
          osc.frequency.setTargetAtTime(72 + 116 * clamp01(speed), now, 0.08);
        }
      } else if (roar) {
        // Down, never off. The oscillators keep running at zero gain — see ensureRoar.
        roar.gain.gain.setTargetAtTime(0, now, 0.10);
      }

      if (sirenAt > 0 && !quiet) {
        const voice = ensureSiren();
        state.wail += dt * (hunting ? YELP_HZ : WAIL_HZ);
        // A raised cosine rather than a triangle: the turnarounds at the top and bottom of a real
        // wail are round, and a linear sweep reverses with an audible corner in it.
        const t = 0.5 - 0.5 * Math.cos(state.wail * Math.PI * 2);
        voice.osc.frequency.setTargetAtTime(WAIL_LOW + (WAIL_HIGH - WAIL_LOW) * t, now, 0.02);
        voice.filter.frequency.setTargetAtTime(900 + 900 * t, now, 0.02);
        voice.gain.gain.setTargetAtTime(SIREN_PEAK * clamp01(sirenAt), now, 0.08);
      } else if (siren) {
        siren.gain.gain.setTargetAtTime(0, now, 0.12);
      }
    } catch { /* a held voice that will not ride is a quieter game, not a broken one */ }
  }

  /** Drop both held voices at once — a run ending, a pause, a tab going away. */
  function hush() {
    if (!state.ctx) return;
    const now = state.ctx.currentTime;
    try {
      roar?.gain.gain.setTargetAtTime(0, now, 0.06);
      siren?.gain.gain.setTargetAtTime(0, now, 0.06);
    } catch { /* nothing to hush */ }
  }

  function setMuted(next) {
    state.muted = Boolean(next);
    writeMuted(store, state.muted);
    if (master && state.ctx) {
      try {
        // Ramped, not switched. A gain jumping to zero mid-voice is a click, and the mute button is
        // pressed *because* something is too loud — answering it with a pop is the one thing it
        // must not do.
        master.gain.setTargetAtTime(state.muted ? 0 : MASTER_GAIN, state.ctx.currentTime, 0.02);
      } catch { /* the ramp is a nicety; the gate in `play` is the mute */ }
    }
    if (state.muted) hush();
    return state.muted;
  }

  return {
    state,
    unlock,
    play,
    update,
    hush,
    setMuted,
    toggleMuted: () => setMuted(!state.muted),
    isMuted: () => state.muted,
  };
}

// --- storage ----------------------------------------------------------------
//
// One boolean, and every access guarded, for the reasons written out at length in `highscores.js`:
// `globalThis.localStorage` is a *getter* that throws outright when storage is blocked, Safari's
// private mode throws on the write while handing back a perfectly good object, and on a `file://`
// origin the whole thing raises `SecurityError`. Losing a mute preference is not worth an error.

function defaultStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** `null` for "nothing stored", so a caller can tell it from a stored `false`. */
function readMuted(store) {
  try {
    const raw = store?.getItem(MUTE_KEY);
    if (raw === null || raw === undefined) return null;
    return raw === '1';
  } catch { return null; }
}

function writeMuted(store, muted) {
  try { store?.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* preference not kept */ }
}

/**
 * The browser's own `AudioContext`, read at call time.
 *
 * `webkitAudioContext` is still the only constructor on older iOS versions this game is played on,
 * and it costs one `||` to keep them. `latencyHint: 'interactive'` asks the platform for the
 * smallest buffer it is willing to give: this is a game where a sound answers a thumb, and the
 * default hint targets power over latency.
 */
function defaultContext() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  return new Ctor({ latencyHint: 'interactive' });
}
