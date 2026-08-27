/**
 * The sound bank, driven against a fake `AudioContext`.
 *
 * Sound is the one system in this project that cannot be checked by looking at it, and a
 * screenshot tool is no help at all. What *can* be checked is everything around the timbre — and
 * that turns out to be where the bugs are, because Web Audio fails in ways that are silent by
 * construction:
 *
 * - **`exponentialRampToValueAtTime(0, …)` throws.** Every envelope in the bank ends in a decay,
 *   and a decay written to zero takes the whole voice down — in the browser it surfaces as one
 *   sound quietly missing, with a `RangeError` swallowed by the `try` that stops a dropped sound
 *   from ending a run. Asserted on every ramp of every voice here.
 * - **A voice that is never stopped never stops.** An oscillator with no `stop()` runs until the
 *   page closes. One of those is inaudible at zero gain and a hundred of them is a stuck tone.
 * - **A node that is never disconnected is never collected.** A fifteen-minute run fires a few
 *   hundred voices; the leak check below plays the whole bank and asserts the graph empties.
 * - **Muted has to mean *nothing scheduled*,** not "scheduled at zero gain". A mute that still
 *   built every node would keep the whole cost of the audio layer on a player who turned it off.
 *
 * The fake also lets the tool assert the things a real context makes awkward: the voice cap, the
 * repeat gap on a tapped sound, a context that refuses to start, and a `localStorage` that throws.
 *
 *   node tools/sfx.mjs
 */
import { createSfx, sirenLoudness, SOUNDS, MASTER_GAIN } from '../src/game/sfx.js';
import { GLOW_FLOOR, GLOW_NEAR, GLOW_FAR } from '../src/game/sirenglow.js';

const results = [];
const failures = [];

function check(name, ok, detail = '') {
  results.push(Boolean(ok));
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// --- The fake ---------------------------------------------------------------
//
// Records rather than renders. Every node keeps its connections, its scheduled start/stop and every
// automation call made against every one of its params, so the assertions below can ask questions
// about the graph that was built rather than about a sound nobody can hear.

class FakeParam {
  constructor(owner, name, value = 0) {
    this.owner = owner;
    this.name = name;
    this.value = value;
    this.calls = [];
  }

  setValueAtTime(v, t) { this.record('setValueAtTime', v, t); return this; }

  linearRampToValueAtTime(v, t) { this.record('linearRampToValueAtTime', v, t); return this; }

  exponentialRampToValueAtTime(v, t) {
    // The real one throws here. Reproducing that is the whole point of the fake — the bank's
    // envelopes are the code most likely to acquire this mistake in a later edit.
    if (!(v > 0)) throw new RangeError('exponentialRampToValueAtTime: target must be non-zero');
    this.record('exponentialRampToValueAtTime', v, t);
    return this;
  }

  setTargetAtTime(v, t, tau) { this.record('setTargetAtTime', v, t, tau); return this; }

  cancelScheduledValues(t) { this.record('cancelScheduledValues', undefined, t); return this; }

  record(kind, v, t, tau) {
    if (v !== undefined && !Number.isFinite(v)) {
      throw new RangeError(`${this.owner.kind}.${this.name}: ${kind} value ${v}`);
    }
    if (!Number.isFinite(t)) {
      throw new RangeError(`${this.owner.kind}.${this.name}: ${kind} time ${t}`);
    }
    this.calls.push({ kind, v, t, tau });
    this.value = v ?? this.value;
  }
}

class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.outputs = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this.disconnected = false;
    this.onended = null;
    ctx.nodes.push(this);
  }

  param(name, value = 0) {
    this[name] = new FakeParam(this, name, value);
    return this[name];
  }

  connect(target) { this.outputs.push(target); return target; }

  disconnect() { this.disconnected = true; this.outputs.length = 0; }

  start(t = this.ctx.currentTime) {
    if (this.startedAt !== null) throw new Error(`${this.kind}: started twice`);
    this.startedAt = t;
  }

  stop(t = this.ctx.currentTime) {
    if (this.startedAt === null) throw new Error(`${this.kind}: stopped before start`);
    if (t < this.startedAt) throw new Error(`${this.kind}: stops before it starts`);
    this.stoppedAt = t;
    this.ctx.scheduled.push(this);
  }
}

class FakeContext {
  constructor({ state = 'running' } = {}) {
    this.state = state;
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.nodes = [];
    this.scheduled = [];
    this.destination = new FakeNode(this, 'destination');
    this.resumes = 0;
  }

  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }

  createGain() {
    const node = new FakeNode(this, 'gain');
    node.param('gain', 1);
    return node;
  }

  createOscillator() {
    const node = new FakeNode(this, 'oscillator');
    node.type = 'sine';
    node.param('frequency', 440);
    node.param('detune', 0);
    return node;
  }

  createBufferSource() {
    const node = new FakeNode(this, 'bufferSource');
    node.buffer = null;
    node.param('playbackRate', 1);
    return node;
  }

  createBiquadFilter() {
    const node = new FakeNode(this, 'biquad');
    node.type = 'lowpass';
    node.param('frequency', 350);
    node.param('Q', 1);
    node.param('gain', 0);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor');
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) node.param(name, 0);
    return node;
  }

  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      length, sampleRate: rate, numberOfChannels: channels, duration: length / rate,
      getChannelData: () => data,
    };
  }

  /** Run the clock forward and fire `onended` for everything that has finished, as the real one does. */
  advance(seconds) {
    this.currentTime += seconds;
    const done = this.scheduled.filter((n) => n.stoppedAt <= this.currentTime);
    this.scheduled = this.scheduled.filter((n) => n.stoppedAt > this.currentTime);
    for (const node of done) node.onended?.();
  }
}

/** A store that can be told to misbehave, same shape as the one in `tools/scores.mjs`. */
function fakeStore({ throwOnRead = false, throwOnWrite = false, seed = null } = {}) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    map,
    getItem(key) {
      if (throwOnRead) throw new Error('SecurityError: storage is blocked');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOnWrite) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
  };
}

/** A woken-up sfx layer on a fresh fake, which is what nearly every block below wants. */
function booted(options = {}) {
  const ctx = new FakeContext(options.context ?? {});
  const sfx = createSfx({ context: () => ctx, store: options.store ?? fakeStore() });
  sfx.unlock();
  return { ctx, sfx };
}

const live = (ctx) => ctx.nodes.filter((n) => n.kind !== 'destination' && !n.disconnected);

// --- Nothing happens before a gesture ---------------------------------------
{
  let built = 0;
  const sfx = createSfx({ context: () => { built += 1; return new FakeContext(); },
    store: fakeStore() });
  check('no AudioContext until unlock()', built === 0, `${built} built`);
  check('and playing before one is a no-op', sfx.play('pick') === false);
  check('still no context after that', built === 0, `${built} built`);

  sfx.unlock();
  check('unlock() builds exactly one', built === 1, `${built} built`);
  sfx.unlock();
  sfx.unlock();
  check('and further unlocks reuse it', built === 1, `${built} built`);
}

// --- A context that cannot be had -------------------------------------------
{
  const sfx = createSfx({ context: () => null, store: fakeStore() });
  check('no Web Audio at all is silence, not a throw', sfx.unlock() === null);
  check('and every sound still answers false', SOUNDS.every((name) => sfx.play(name) === false));
  check('the held voices ride harmlessly too', (() => {
    try { sfx.update(0.016, { locoOn: true, sirenAt: 1 }); return true; } catch { return false; }
  })());
}
{
  let built = 0;
  const sfx = createSfx({ context: () => { built += 1; throw new Error('NotAllowedError'); },
    store: fakeStore() });
  sfx.unlock();
  sfx.unlock();
  sfx.unlock();
  check('a constructor that throws is tried once and then left alone', built === 1, `${built} tries`);
}
{
  const ctx = new FakeContext({ state: 'suspended' });
  const sfx = createSfx({ context: () => ctx, store: fakeStore() });
  sfx.unlock();
  check('a suspended context is resumed', ctx.resumes === 1, `${ctx.resumes} resumes`);
}
{
  // Suspended behind our back — a tab that lost focus. Scheduling against a frozen clock would
  // stack the whole pile up and play it at once on resume.
  const { ctx, sfx } = booted();
  ctx.state = 'suspended';
  check('a suspended context schedules nothing', sfx.play('crash') === false);
}

// --- Every sound in the bank ------------------------------------------------
{
  for (const name of SOUNDS) {
    const { ctx, sfx } = booted();
    const before = ctx.nodes.length;
    let threw = null;
    try { sfx.play(name); } catch (error) { threw = error; }
    check(`${name} plays`, threw === null, threw?.message);
    const made = ctx.nodes.length - before;
    check(`${name} builds a voice`, made > 0, `${made} nodes`);

    // Every source is stopped, and every stop is after its start. An oscillator with no stop runs
    // for the life of the page.
    const sources = ctx.nodes.filter((n) => n.startedAt !== null);
    check(`${name} stops everything it starts`,
      sources.every((n) => n.stoppedAt !== null),
      `${sources.filter((n) => n.stoppedAt === null).length} left running`);
    check(`${name} schedules ahead of the clock`,
      sources.every((n) => n.startedAt >= ctx.currentTime),
      'a voice starts in the past and opens with a click');

    // Nothing in the bank may outlast a couple of seconds: these are one-shots, and a long tail
    // holds a slot against MAX_VOICES long after it stopped being audible.
    const longest = Math.max(...sources.map((n) => n.stoppedAt - n.startedAt));
    check(`${name} is a one-shot`, longest > 0 && longest < 2, `${longest.toFixed(2)}s`);

    // Every gain envelope: opens at zero, reaches a sane peak, decays to something non-zero.
    const gains = ctx.nodes.filter((n) => n.kind === 'gain' && n.gain.calls.length > 1);
    for (const g of gains) {
      const peaks = g.gain.calls.map((c) => c.v).filter((v) => v !== undefined);
      check(`${name} keeps its gain in range`,
        peaks.every((v) => v >= 0 && v <= 1), `peak ${Math.max(...peaks)}`);
    }

    // ...and every automation is in time order on its own param. Web Audio does not reorder them:
    // a ramp scheduled before the `setValueAtTime` it is supposed to start from simply does not run.
    for (const node of ctx.nodes) {
      for (const key of Object.keys(node)) {
        const param = node[key];
        if (!(param instanceof FakeParam) || param.calls.length < 2) continue;
        const ordered = param.calls.every((c, i) => i === 0 || c.t >= param.calls[i - 1].t);
        check(`${name} automates ${node.kind}.${param.name} in order`, ordered);
      }
    }
  }
  check('an unknown sound is a caught error, not silence', (() => {
    const { sfx } = booted();
    try { sfx.play('nope'); return false; } catch { return true; }
  })());
}

// --- Headroom ---------------------------------------------------------------
//
// Nothing in the bank may drive the bus past full scale on its own. The compressor is a safety net
// for a *pile-up* — a chime landing on the frame of a crash — and a single sound that needs it is a
// mix that was wrong before anything collided. This is the one property of the bank that is about
// how it sounds and can still be checked without listening to it: a voice tuned too hot reads as a
// crackle, which is indistinguishable from a broken speaker and gets reported as one.
{
  const loudest = [];
  for (const name of SOUNDS) {
    const { ctx, sfx } = booted();
    sfx.play(name);
    // Overlap-aware rather than a plain sum: `bust`'s two whoops are staggered past each other and
    // never add, while `dropoff`'s four notes ring together and do. Each envelope is treated as its
    // peak for the whole voice, which is the conservative reading — an envelope is at its peak for
    // one instant, so the real sum is lower than this and never higher.
    const voices = ctx.nodes
      .filter((n) => n.startedAt !== null)
      .map((source) => {
        const gain = source.outputs.find((o) => o.kind === 'gain')
          ?? source.outputs.flatMap((o) => o.outputs).find((o) => o.kind === 'gain');
        const peaks = (gain?.gain.calls ?? []).map((c) => c.v).filter((v) => v !== undefined);
        return { from: source.startedAt, to: source.stoppedAt, peak: peaks.length ? Math.max(...peaks) : 0 };
      });
    let peak = 0;
    for (let t = 0; t < 2; t += 0.005) {
      const at = voices.reduce((sum, v) => sum + (t >= v.from && t <= v.to ? v.peak : 0), 0);
      if (at > peak) peak = at;
    }
    loudest.push({ name, level: peak * MASTER_GAIN });
  }
  loudest.sort((a, b) => b.level - a.level);
  const over = loudest.filter((s) => s.level > 1);
  check('no single sound drives the bus past full scale', over.length === 0,
    over.map((s) => `${s.name} ${s.level.toFixed(2)}`).join(', '));
  // ...and the floor, because a voice tuned so quietly it is inaudible fails silently in the other
  // direction — nothing throws, nothing leaks, and the sound simply is not there.
  const quietest = loudest.at(-1);
  check('and none of them is inaudible', quietest.level > 0.02,
    `${quietest.name} at ${quietest.level.toFixed(3)}`);
}

// --- The graph empties ------------------------------------------------------
{
  const { ctx, sfx } = booted();
  for (const name of SOUNDS) { sfx.play(name); ctx.advance(0.2); }
  check('the bank builds a real graph', ctx.nodes.length > SOUNDS.length, `${ctx.nodes.length} nodes`);
  ctx.advance(5);
  const leaked = live(ctx).filter((n) => n.kind !== 'compressor' && n.kind !== 'gain');
  check('every one-shot disconnects when it ends', leaked.length === 0,
    leaked.map((n) => n.kind).join(','));
  check('and the voice count comes back to zero', sfx.state.voices === 0, `${sfx.state.voices}`);
}

// --- The voice cap ----------------------------------------------------------
{
  const { ctx, sfx } = booted();
  let played = 0;
  // `crash` is the widest voice in the bank, so this trips the cap in a handful of calls. The
  // repeat gap does not apply to it — only a tapped sound has one.
  for (let i = 0; i < 200; i++) if (sfx.play('crash')) played += 1;
  check('the voice cap holds', played < 200 && played > 0, `${played}/200 played`);
  check('and bounds the graph', ctx.nodes.length < 120, `${ctx.nodes.length} nodes`);
  ctx.advance(3);
  check('the cap lifts once the voices end', sfx.play('crash') === true);
}

// --- The repeat gap ---------------------------------------------------------
{
  const { ctx, sfx } = booted();
  check('the first tap plays', sfx.play('pick') === true);
  check('a tap in the same frame is dropped', sfx.play('pick') === false);
  ctx.advance(0.1);
  check('and one a tenth of a second later is not', sfx.play('pick') === true);

  // Only tapped sounds are gated. A crash and a delivery cannot arrive fast enough to need one, and
  // silently dropping either would be a lost event rather than a smoothed one.
  const fresh = booted();
  check('a delivery is never rate-limited', fresh.sfx.play('dropoff') && fresh.sfx.play('dropoff'));
}

// --- The payout climbs with the streak --------------------------------------
{
  const top = (ctx) => Math.max(...ctx.nodes.filter((n) => n.kind === 'oscillator')
    .map((n) => n.frequency.calls[0].v));
  const one = booted();
  one.sfx.play('dropoff', { streak: 1 });
  const eight = booted();
  eight.sfx.play('dropoff', { streak: 8 });
  check('a long streak pays out higher', top(eight.ctx) > top(one.ctx),
    `${top(one.ctx).toFixed(0)} → ${top(eight.ctx).toFixed(0)}`);
  const huge = booted();
  huge.sfx.play('dropoff', { streak: 40 });
  check('...but only up to an octave', top(huge.ctx) <= top(one.ctx) * 2 + 1,
    `${top(huge.ctx).toFixed(0)} against ${(top(one.ctx) * 2).toFixed(0)}`);
}

// --- The countdown falls in pitch -------------------------------------------
{
  const pitch = (level) => {
    const { ctx, sfx } = booted();
    sfx.play('urgency', { level });
    return ctx.nodes.filter((n) => n.kind === 'oscillator')[0].frequency.calls[0].v;
  };
  check('the tick drops a step as the clock does',
    pitch(3) > pitch(2) && pitch(2) > pitch(1) && pitch(1) > pitch(0),
    [3, 2, 1, 0].map(pitch).join(' → '));

  const voices = (level) => {
    const { ctx, sfx } = booted();
    sfx.play('urgency', { level });
    return ctx.nodes.filter((n) => n.kind === 'oscillator').length;
  };
  check('and doubles on the last step', voices(1) > voices(2), `${voices(2)} → ${voices(1)}`);
  check('out of range does not throw', (() => {
    const { sfx } = booted();
    try { sfx.play('urgency', { level: 99 }); sfx.play('urgency', { level: -4 }); return true; }
    catch { return false; }
  })());
}

// --- Muted means nothing is built -------------------------------------------
{
  const { ctx, sfx } = booted();
  sfx.setMuted(true);
  const before = ctx.nodes.length;
  for (const name of SOUNDS) sfx.play(name);
  sfx.update(0.016, { locoOn: true, speed: 1, sirenAt: 1 });
  check('a muted game schedules nothing at all', ctx.nodes.length === before,
    `${ctx.nodes.length - before} nodes built`);
  check('and says so', sfx.isMuted() === true);
  sfx.setMuted(false);
  check('unmuting plays again', sfx.play('pickup') === true);
  check('toggling flips it', sfx.toggleMuted() === true && sfx.toggleMuted() === false);
}

// --- The mute preference ----------------------------------------------------
{
  const store = fakeStore();
  const first = createSfx({ context: () => new FakeContext(), store });
  first.setMuted(true);
  const second = createSfx({ context: () => new FakeContext(), store });
  check('mute survives a reload', second.isMuted() === true);
  second.setMuted(false);
  const third = createSfx({ context: () => new FakeContext(), store });
  check('and so does unmuting', third.isMuted() === false);

  check('no store at all starts unmuted',
    createSfx({ context: () => new FakeContext(), store: null }).isMuted() === false);
  check('a store that throws on read starts unmuted',
    createSfx({ context: () => new FakeContext(), store: fakeStore({ throwOnRead: true }) })
      .isMuted() === false);
  const readonly = createSfx({ context: () => new FakeContext(),
    store: fakeStore({ throwOnWrite: true }) });
  check('a store that throws on write still mutes', readonly.setMuted(true) === true);

  // Shot mode: silent by default, because a screenshot is rendered and never played.
  check('the default can be overridden',
    createSfx({ context: () => new FakeContext(), store: fakeStore(), muted: true })
      .isMuted() === true);
  check('...but a stored preference still wins',
    createSfx({ context: () => new FakeContext(), store, muted: true }).isMuted() === false);
}

// --- The two held voices ----------------------------------------------------
{
  const { ctx, sfx } = booted();
  sfx.update(0.016, { locoOn: false, sirenAt: 0 });
  check('neither held voice is built until it is wanted',
    ctx.nodes.filter((n) => n.kind === 'oscillator').length === 0);

  sfx.update(0.016, { locoOn: true, speed: 0.2 });
  const oscs = ctx.nodes.filter((n) => n.kind === 'oscillator');
  check('the roar builds on the frame Loco Mode starts', oscs.length > 0, `${oscs.length}`);
  check('and it is held, not scheduled to stop',
    oscs.every((n) => n.startedAt !== null && n.stoppedAt === null));

  const built = ctx.nodes.length;
  for (let i = 0; i < 600; i++) { ctx.advance(0.016); sfx.update(0.016, { locoOn: true, speed: 1 }); }
  check('ten seconds of boost builds nothing further', ctx.nodes.length === built,
    `${ctx.nodes.length - built} extra nodes`);

  // Speed rides the filter and the pitch. Slow and fast have to differ or the bed is a drone.
  const slow = booted();
  slow.sfx.update(0.016, { locoOn: true, speed: 0 });
  const fast = booted();
  fast.sfx.update(0.016, { locoOn: true, speed: 1 });
  const roarFreq = (c) => c.nodes.filter((n) => n.kind === 'oscillator')[0].frequency.value;
  check('the roar rises with speed', roarFreq(fast.ctx) > roarFreq(slow.ctx),
    `${roarFreq(slow.ctx).toFixed(0)} → ${roarFreq(fast.ctx).toFixed(0)}`);

  // Releasing takes it down rather than off — the oscillators keep running at zero gain.
  sfx.update(0.016, { locoOn: false });
  const roarGain = ctx.nodes.filter((n) => n.kind === 'gain')
    .map((n) => n.gain.calls.at(-1)).filter(Boolean).at(-1);
  check('releasing rides the roar down', roarGain?.v === 0, JSON.stringify(roarGain));
  check('but leaves the oscillators alone',
    ctx.nodes.filter((n) => n.kind === 'oscillator').every((n) => n.stoppedAt === null));
}
{
  // The wail advances with the frame's own delta, so a paused game holds it where it was.
  const { ctx, sfx } = booted();
  sfx.update(0.016, { sirenAt: 1, hunting: false });
  const started = sfx.state.wail;
  for (let i = 0; i < 30; i++) { ctx.advance(0.016); sfx.update(0.016, { sirenAt: 1 }); }
  check('the wail sweeps', sfx.state.wail > started, `${sfx.state.wail.toFixed(3)}`);
  const held = sfx.state.wail;
  for (let i = 0; i < 30; i++) { ctx.advance(0.016); sfx.update(0, { sirenAt: 1 }); }
  check('and holds on a paused frame', sfx.state.wail === held);

  // ...and steps rate when the cruiser locks on, the way the light bar does.
  const wailed = booted();
  const yelped = booted();
  for (let i = 0; i < 60; i++) {
    wailed.sfx.update(0.016, { sirenAt: 1, hunting: false });
    yelped.sfx.update(0.016, { sirenAt: 1, hunting: true });
  }
  check('a cruiser that has locked on yelps rather than wails',
    yelped.sfx.state.wail > wailed.sfx.state.wail * 2,
    `${wailed.sfx.state.wail.toFixed(2)} vs ${yelped.sfx.state.wail.toFixed(2)}`);

  check('hush() takes both down without throwing', (() => {
    try { sfx.hush(); return true; } catch { return false; }
  })());
}

// --- The siren's loudness curve ---------------------------------------------
{
  const lit = { lit: true };
  check('an unlit cruiser is silent', sirenLoudness({ lit: false }, 10) === 0);
  check('and no cruiser at all is too', sirenLoudness(null, 10) === 0);
  check('alongside is full', Math.abs(sirenLoudness(lit, 0) - 1) < 1e-9,
    String(sirenLoudness(lit, 0)));
  check('at the near mark it is still full', Math.abs(sirenLoudness(lit, GLOW_NEAR) - 1) < 1e-9);
  check('across the city it floors rather than vanishing',
    Math.abs(sirenLoudness(lit, GLOW_FAR) - GLOW_FLOOR) < 1e-9,
    String(sirenLoudness(lit, GLOW_FAR)));
  check('and stays there beyond it',
    Math.abs(sirenLoudness(lit, GLOW_FAR * 3) - GLOW_FLOOR) < 1e-9);
  const mid = sirenLoudness(lit, (GLOW_NEAR + GLOW_FAR) / 2);
  check('with a ramp in between', mid > GLOW_FLOOR && mid < 1, String(mid));
  check('a nonsense distance is silence, not NaN', sirenLoudness(lit, NaN) === 0);

  // Loudness is a *distance* read and nothing else: unlike the frame-edge wash it must not care
  // whether the cruiser happens to be on screen, or it would cut out exactly when you can see it.
  check('the curve depends on nothing but the distance and the bar',
    sirenLoudness({ lit: true, chasing: true }, 30) === sirenLoudness({ lit: true }, 30));
}

const passed = results.filter(Boolean).length;
for (const line of failures.slice(0, 12)) console.log(`  FAIL ${line}`);
console.log(`${passed}/${results.length} checks passed`);
process.exit(failures.length ? 1 : 0);
