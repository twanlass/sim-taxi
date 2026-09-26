/**
 * The trailer's soundtrack, synthesised — the project ships no assets, and the trailer keeps to
 * that. 120 BPM so a beat is exactly 15 frames at 30fps and every cut can land on one.
 *
 *   node tools/hype/music.mjs out.wav
 *
 * The arrangement is keyed to the edit's sections in `timeline.mjs`: a riser into the drop at
 * the title, the groove under the gameplay, a half-time lowpassed breath under the wreck, and a
 * last hit on the end card.
 */

import { writeFile } from 'node:fs/promises';
import { BPM, SECTIONS, TOTAL } from './timeline.mjs';

const SR = 44100;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const N = Math.ceil((TOTAL + 2) * SR);

const L = new Float32Array(N);
const R = new Float32Array(N);
const sendL = new Float32Array(N);   // echo send
const sendR = new Float32Array(N);
const duck = new Float32Array(N).fill(1);

let seed = 99;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2147483648) - 1;
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function add(buf, t0, samples, gain = 1) {
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < samples.length && i0 + i < N; i++) if (i0 + i >= 0) buf[i0 + i] += samples[i] * gain;
}
function addStereo(t0, samples, gain = 1, pan = 0, send = 0) {
  const gl = gain * Math.min(1, 1 - pan);
  const gr = gain * Math.min(1, 1 + pan);
  add(L, t0, samples, gl);
  add(R, t0, samples, gr);
  if (send) { add(sendL, t0, samples, gl * send); add(sendR, t0, samples, gr * send); }
}

// --- Voices -------------------------------------------------------------------------------------

function kick(len = 0.4) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 45 + 120 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 7)) + (i < 60 ? noise() * 0.3 * (1 - i / 60) : 0);
  }
  return out;
}

function snare() {
  const n = Math.round(0.25 * SR);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = noise();
    const hp = w - prev; prev = w;
    out[i] = hp * 0.7 * Math.exp(-t * 16) + Math.sin(2 * Math.PI * 185 * t) * 0.5 * Math.exp(-t * 28);
  }
  return out;
}

function hat(open = false) {
  const len = open ? 0.22 : 0.05;
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let p1 = 0; let p2 = 0;
  for (let i = 0; i < n; i++) {
    const w = noise();
    const hp = w - 2 * p1 + p2; p2 = p1; p1 = w;
    out[i] = hp * 0.25 * Math.exp(-(i / SR) * (open ? 14 : 70));
  }
  return out;
}

function clap() {
  const n = Math.round(0.3 * SR);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = noise(); const hp = w - prev; prev = w;
    const bursts = [0, 0.011, 0.022].reduce((a, o) => a + (t >= o ? Math.exp(-(t - o) * 90) : 0), 0);
    out[i] = hp * 0.5 * (bursts * 0.6 + Math.exp(-t * 12) * 0.5);
  }
  return out;
}

/** Detuned saw stack through a one-pole lowpass with its own envelope. */
function saws(notes, len, { cutoff = 2500, env = 0, attack = 0.005, release = 0.08, detune = 0.012, voices = 3, sub = 0 } = {}) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  const phases = notes.flatMap(() => Array.from({ length: voices }, (_, v) => v / voices));
  let lp = 0; let lp2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0; let k = 0;
    for (const note of notes) {
      const f0 = midi(note);
      for (let v = 0; v < voices; v++) {
        const f = f0 * (1 + detune * (v - (voices - 1) / 2));
        phases[k] = (phases[k] + f / SR) % 1;
        s += 2 * phases[k] - 1;
        k++;
      }
      if (sub) s += sub * Math.sin(2 * Math.PI * f0 / 2 * t) * voices;
    }
    s /= notes.length * voices;
    const c = Math.min(0.99, (2 * Math.PI * (cutoff + env * Math.exp(-t * 12))) / SR);
    lp += c * (s - lp);
    lp2 += c * (lp - lp2);
    const a = Math.min(1, t / attack);
    const r = Math.min(1, (len - t) / release);
    out[i] = lp2 * a * Math.max(0, r);
  }
  return out;
}

function riser(len) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let p1 = 0; let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const w = noise();
    const hp = w - p1 * (0.2 + 0.75 * u); p1 = w;
    ph += (2 * Math.PI * (200 + 1800 * u * u)) / SR;
    out[i] = (hp * 0.35 + Math.sin(ph) * 0.12) * u * u;
  }
  return out;
}

function impact(len = 3) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let ph = 0; let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (30 + 60 * Math.exp(-t * 3))) / SR;
    lp += 0.15 * (noise() - lp);
    out[i] = Math.tanh(1.5 * Math.sin(ph)) * Math.exp(-t * 1.6) * 0.9 + lp * 1.2 * Math.exp(-t * 2.5);
  }
  return out;
}

/** Record a kick for the sidechain: everything else ducks under it. */
function kickAt(t, gain = 1) {
  addStereo(t, kick(), 0.9 * gain);
  const i0 = Math.round(t * SR);
  for (let i = 0; i < 0.3 * SR && i0 + i < N; i++) {
    duck[i0 + i] = Math.min(duck[i0 + i], 1 - 0.55 * gain * Math.exp(-(i / SR) * 10));
  }
}

// --- Arrangement --------------------------------------------------------------------------------

// A minor, i–VI–III–VII: Am F C G.
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ROOTS = [33, 29, 36, 31];

const section = (name) => SECTIONS.find((s) => s.name === name);
const barsOf = (s) => Math.round((s.end - s.start) / BAR);

// Pads (with a backing layer that plays under everything except the breath and the tail).
const buffer = []; // [t, samples, gain, pan, send]
function pad(t, bars, gain = 0.28, cutoff = 900) {
  for (let b = 0; b < bars; b++) {
    const chord = CHORDS[b % 4];
    addStereo(t + b * BAR, saws(chord, BAR + 0.2, { cutoff, attack: 0.4, release: 0.4, detune: 0.018, voices: 4 }), gain, -0.3, 0.3);
    addStereo(t + b * BAR, saws(chord.map((n) => n + 12), BAR + 0.2, { cutoff, attack: 0.4, release: 0.4, detune: 0.021, voices: 3 }), gain * 0.5, 0.3, 0.3);
  }
}

function groove(t0, bars, { full = true, stabs = true, lead = false } = {}) {
  for (let b = 0; b < bars; b++) {
    const bt = t0 + b * BAR;
    const ci = b % 4;
    for (let q = 0; q < 4; q++) kickAt(bt + q * BEAT);
    addStereo(bt + BEAT, clap(), 0.55, 0.05, 0.2);
    addStereo(bt + 3 * BEAT, clap(), 0.55, 0.05, 0.2);
    if (full) addStereo(bt + BEAT, snare(), 0.35);
    if (full) addStereo(bt + 3 * BEAT, snare(), 0.35);
    for (let e = 0; e < 16; e++) {
      const open = e % 4 === 2;
      addStereo(bt + e * BEAT / 4, hat(open), open ? 0.6 : (e % 2 ? 0.3 : 0.5), 0.35);
    }
    // Rolling eighth-note bass, octave jump on the offbeat.
    for (let e = 0; e < 8; e++) {
      const note = ROOTS[ci] + (e % 2 ? 12 : 0);
      addStereo(bt + e * BEAT / 2, saws([note], BEAT / 2 - 0.02, { cutoff: 380, env: 900, voices: 2, detune: 0.006, sub: 0.8 }), 0.55);
    }
    if (stabs) {
      // Offbeat chord stabs, the riff everything hangs on.
      const pattern = [0.5, 1.5, 2.5, 2.75, 3.5];
      for (const p of pattern) {
        addStereo(bt + p * BEAT, saws(CHORDS[ci].map((n) => n + 12), 0.18, { cutoff: 1400, env: 5000, voices: 3, detune: 0.015 }), 0.33, (p * 7 % 3 - 1) * 0.4, 0.45);
      }
    }
    if (lead) {
      // A four-bar hook in the upper octave.
      const HOOK = [[76, 0, 1], [74, 1, 0.5], [72, 1.5, 0.5], [74, 2, 1], [69, 3, 1],
        [72, 0, 1], [72, 1, 0.5], [74, 1.5, 0.5], [76, 2, 1.5], [79, 3.5, 0.5]];
      const half = (b % 2) * 5;
      for (const [note, at, len] of HOOK.slice(half, half + 5)) {
        addStereo(bt + at * BEAT, saws([note], len * BEAT, { cutoff: 3000, env: 3000, voices: 3, detune: 0.01, release: 0.05 }), 0.2, 0, 0.5);
      }
    }
  }
}

for (const s of SECTIONS) {
  const bars = barsOf(s);
  switch (s.music) {
    case 'intro':
      pad(s.start, bars, 0.3, 700);
      for (let b = 1; b < bars; b++) for (let q = 0; q < 4; q++) kickAt(s.start + b * BAR + q * BEAT, b < bars - 1 ? 0.5 : 0.7);
      for (let e = 0; e < bars * 8; e++) addStereo(s.start + e * BEAT / 2, hat(), 0.4, 0.3);
      addStereo(s.end - 2 * BAR, riser(2 * BAR), 0.9, 0, 0.2);
      // A snare roll across the last bar into the drop.
      for (let k = 0; k < 16; k++) addStereo(s.end - BAR + k * BEAT / 4, snare(), 0.1 + 0.3 * (k / 16));
      break;
    case 'drop':
      addStereo(s.start, impact(), 0.9, 0, 0.3);
      groove(s.start, bars, { lead: true });
      pad(s.start, bars, 0.12, 1800);
      break;
    case 'groove':
      groove(s.start, bars, { lead: s.lead ?? false });
      pad(s.start, bars, 0.1, 1500);
      break;
    case 'lift':
      // The same groove with the hook doubled an octave up — the Loco Mode section.
      groove(s.start, bars, { lead: true });
      pad(s.start, bars, 0.14, 2600);
      addStereo(s.end - BAR, riser(BAR), 0.6);
      break;
    case 'breath':
      // Half time, lowpassed, the kick on one and three only: the wreck in slow motion.
      addStereo(s.start, impact(4), 1.0, 0, 0.4);
      pad(s.start, bars, 0.35, 450);
      for (let b = 1; b < bars; b++) { kickAt(s.start + b * BAR, 0.8); kickAt(s.start + b * BAR + 2 * BEAT, 0.6); addStereo(s.start + b * BAR + BEAT * 2, clap(), 0.3, 0, 0.6); }
      addStereo(s.end - BAR, riser(BAR), 0.8, 0, 0.2);
      for (let k = 0; k < 8; k++) addStereo(s.end - BEAT * 2 + k * BEAT / 4, snare(), 0.15 + 0.3 * (k / 8));
      break;
    case 'finale':
      addStereo(s.start, impact(), 0.8, 0, 0.3);
      groove(s.start, bars, { lead: true });
      pad(s.start, bars, 0.14, 2600);
      break;
    case 'end':
      addStereo(s.start, impact(5), 1.0, 0, 0.5);
      addStereo(s.start, saws(CHORDS[0].concat([45, 69]), 4, { cutoff: 1800, env: 4000, voices: 4, detune: 0.02, release: 3 }), 0.4, 0, 0.6);
      kickAt(s.start, 1);
      break;
    default:
  }
}

// Echo send: a dotted-eighth ping-pong, the cheapest thing that sounds like a room.
const D = Math.round(BEAT * 0.75 * SR);
for (let i = D; i < N; i++) {
  sendL[i] += sendR[i - D] * 0.42;
  sendR[i] += sendL[i - D] * 0.42;
}

// Mix: duck everything that is not the kick (approximately — the kick ducks itself a little too,
// which only rounds its tail), add the echo, soft-clip.
const pcm = Buffer.alloc(N * 4);
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = 0.9 / Math.max(1, peak * 0.7);
for (let i = 0; i < N; i++) {
  const fadeOut = Math.min(1, (N - i) / (1.5 * SR));
  const l = Math.tanh((L[i] * duck[i] + sendL[i] * 0.5) * g) * fadeOut;
  const r = Math.tanh((R[i] * duck[i] + sendR[i] * 0.5) * g) * fadeOut;
  pcm.writeInt16LE(Math.round(l * 32000), i * 4);
  pcm.writeInt16LE(Math.round(r * 32000), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);

const out = process.argv[2] ?? 'hype.wav';
await writeFile(out, Buffer.concat([header, pcm]));
console.log(`${out}: ${(N / SR).toFixed(1)}s`);
