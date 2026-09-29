/**
 * Encode the sound designer's WAV masters into the AAC files the game ships.
 *
 *   node tools/audio.mjs [masters-dir]      # default: assets/audio-src/
 *
 * Workflow for a new delivery is in docs/audio.md#adding-or-replacing-a-sound.
 *
 * The masters are 48 kHz / 24-bit stereo WAV — 31 MB for Block 1's forty-one files —
 * committed under `assets/audio-src/` so a re-encode never depends on someone's Downloads folder.
 * Nothing references them from `src/`, so Vite never ships them. What ships is
 * `assets/audio/<same name>.m4a`, AAC at 128 kbps: 1,262 kB for the same set, a 25x cut. On the
 * first (test) delivery 96 kbps was 650 kB against 800 and 64 kbps 470 kB, but these are short effects heard on a phone speaker *and* on
 * headphones, and the 150 kB is not worth a smeared transient on the door or the crash.
 *
 * AAC in an MP4 container rather than Opus or MP3: it is the one format every target decodes
 * natively — Safari and WKWebView (the iOS build), Chrome, Firefox — and `afconvert` ships with
 * macOS, so re-encoding a new delivery needs nothing installed. The file names are kept as the
 * designer's so a re-delivery drops straight in; `src/game/sfx.js` is what maps them to events.
 *
 * **The output is made byte-for-byte reproducible**, so re-running this over the whole set is a
 * no-op in git and only a changed master shows up as a changed `.m4a`. The AAC encode itself is
 * deterministic; what is not is the container — afconvert stamps the wall clock into the creation
 * and modification times of the `mvhd`, `tkhd` and `mdhd` boxes, 12 bytes that differed between two
 * encodes of the same WAV. `zeroTimestamps` rewrites them to 0. An mtime-based "skip what's up to
 * date" was tried first and is the wrong tool: a fresh clone hands every file an arbitrary mtime.
 *
 * AAC pads the front of the stream with 2112 frames of encoder priming. Whether a decoder trims
 * it depends on the browser, which matters only for the loops — see `loopWindow` in sfx.js.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] ?? join(root, 'assets', 'audio-src');
const out = join(root, 'assets', 'audio');
const BITRATE = 128000;

// Boxes whose payload opens version(1) flags(3) creation modification — 32-bit each in version 0,
// 64-bit in version 1 — and the containers that have to be walked to reach them.
const STAMPED = new Set(['mvhd', 'tkhd', 'mdhd']);
const CONTAINERS = new Set(['moov', 'trak', 'mdia']);

/** Zero every creation/modification time in an MP4. Returns how many boxes it rewrote. */
function zeroTimestamps(buf, start = 0, end = buf.length) {
  let n = 0;
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); header = 16; }
    else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Error(`malformed MP4 box '${type}' at ${at}`);
    const body = at + header;
    if (STAMPED.has(type)) {
      const width = buf[body] === 1 ? 8 : 4;
      buf.fill(0, body + 4, body + 4 + width * 2);
      n++;
    } else if (CONTAINERS.has(type)) {
      n += zeroTimestamps(buf, body, at + size);
    }
    at += size;
  }
  return n;
}

mkdirSync(out, { recursive: true });
const wavs = readdirSync(src).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
if (!wavs.length) {
  console.error(`no .wav files in ${src}`);
  process.exit(1);
}

let before = 0;
let after = 0;
for (const f of wavs) {
  const input = join(src, f);
  const output = join(out, `${basename(f, '.wav')}.m4a`);
  const r = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', String(BITRATE), input, output],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`afconvert failed on ${f}: ${r.stderr || r.error}`);
    process.exit(1);
  }
  const buf = readFileSync(output);
  // All three, or the file is not what this was written against and would stop being reproducible
  // without a word — fail loudly instead.
  const zeroed = zeroTimestamps(buf);
  if (zeroed !== 3) {
    console.error(`${f}: expected 3 timestamped boxes (mvhd, tkhd, mdhd), found ${zeroed}`);
    process.exit(1);
  }
  writeFileSync(output, buf);
  before += statSync(input).size;
  after += buf.length;
  console.log(`${f.padEnd(30)} -> ${(buf.length / 1024).toFixed(0).padStart(4)} kB`);
}
console.log(`${wavs.length} files: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1024).toFixed(0)} kB`);
