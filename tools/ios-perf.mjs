/**
 * Profile the game on a paired iPhone — the Mac half of `?perf` (src/game/perf.js).
 *
 *   node tools/ios-perf.mjs launch [--query "perf&hitch"]   # relaunch the app with URL params
 *   node tools/ios-perf.mjs trace  [--seconds 120]          # Metal System Trace while you play
 *   node tools/ios-perf.mjs pull                            # copy the captures off, then report
 *   node tools/ios-perf.mjs report <capture.json>           # report a capture already on disk
 *
 * All take `--device <name|udid>` (default: the first paired phone). The app must be a DEBUG build
 * (`npm run push:ios`): only DEBUG reads the `--query` launch argument and registers the `perf`
 * handler that saves captures (ios/SimTaxi/PerfBridge.swift).
 *
 * **Why three halves.** `?perf` sees the JavaScript side of every frame — how long `tick` took, by
 * phase, and what else happened in it (shader links, buffer uploads, resizes). It cannot see the
 * GPU: WebKit exposes no timer queries. A hitch with a long gap and a short `cpu` is therefore
 * "not JS", and the trace is what says what it *was* — Metal System Trace shows the GPU process's
 * command buffers on the same wall clock. Captures land in `perf-captures/` (git-ignored).
 * See docs/testing.md, "Profiling on the phone".
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BUNDLE = 'com.twanlass.rocketrides';
const OUT = 'perf-captures';

const args = process.argv.slice(2);
const command = args[0];
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

function run(cmd, argv, { quiet = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: `${out}${err.message}` }));
  });
}

const die = (message, detail) => {
  console.error(`ios-perf  ${message}`);
  if (detail) console.error(detail.trimEnd().split('\n').slice(-20).join('\n'));
  process.exit(1);
};

async function findDevice() {
  const file = path.join(tmpdir(), `sim-taxi-perf-devices-${process.pid}.json`);
  const { code, out } = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', file]);
  if (code !== 0 || !existsSync(file)) die('could not list devices', out);
  const phones = (JSON.parse(await readFile(file, 'utf8'))?.result?.devices ?? [])
    .filter((d) => d.hardwareProperties?.platform === 'iOS' && d.hardwareProperties?.reality !== 'simulated')
    .map((d) => ({ id: d.identifier, udid: d.hardwareProperties?.udid, name: d.deviceProperties?.name ?? '' }));
  const wanted = value('--device');
  const match = wanted
    ? phones.find((p) => [p.id, p.udid, p.name.toLowerCase()].includes(wanted.toLowerCase()) || p.id === wanted)
    : phones[0];
  if (!match) die(`no paired iPhone${wanted ? ` matches "${wanted}"` : ''}. Paired: ${phones.map((p) => p.name).join(', ') || 'none'}.\n`
    + '          Wake the phone and keep it on the same Wi-Fi as the Mac.');
  return match;
}

async function launch() {
  const device = await findDevice();
  const query = value('--query', 'perf');
  console.log(`ios-perf  launching on ${device.name} with ?${query}`);
  const { code, out } = await run('xcrun', ['devicectl', 'device', 'process', 'launch',
    '--device', device.id, '--terminate-existing', BUNDLE, '--query', query]);
  if (code !== 0) die('launch failed (is the phone unlocked?)', out);
  console.log('ios-perf  launched');
}

async function trace() {
  const device = await findDevice();
  const seconds = Number(value('--seconds', 120));
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `trace-${stamp()}.trace`);
  console.log(`ios-perf  recording Metal System Trace on ${device.name} for ${seconds}s → ${file}`);
  // All processes, not an attach: WebGL draws in WebKit's GPU process (com.apple.WebKit.GPU), not
  // in the app, and the WebContent process that runs the JS is a third. The app alone would show a
  // shell with nothing in it.
  const udid = device.udid ?? device.id;
  const { code, out } = await run('xcrun', ['xctrace', 'record', '--template', 'Metal System Trace',
    '--device', udid, '--all-processes', '--time-limit', `${seconds}s`, '--output', file], { quiet: false });
  if (code !== 0 && !existsSync(file)) die('xctrace failed', out);
  console.log(`ios-perf  done. Open it with: open ${file}`);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

async function pull() {
  const device = await findDevice();
  const dest = path.join(OUT, `pull-${stamp()}`);
  await mkdir(dest, { recursive: true });
  const { code, out } = await run('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device.id,
    '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
    '--source', 'Documents/perf', '--destination', dest]);
  if (code !== 0) die('copy failed — has a ?perf run saved yet? (it saves every minute, on game over and when the app goes to the background)', out);
  const files = await listJson(dest);
  if (!files.length) die(`nothing pulled into ${dest}`);
  console.log(`ios-perf  pulled ${files.length} capture(s) into ${dest}`);
  // The newest capture is the run just played.
  files.sort();
  await report(files[files.length - 1]);
}

async function listJson(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJson(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '–');

/** Why a late frame was late, as far as the JS side can tell. The first cause that fits wins. */
function causeOf(f, budget) {
  if (f.save) return 'save (the capture serialising itself)';
  if (f.link) return `shader link ×${f.link}`;
  if (f.rs) return 'resize (governor step or rotation)';
  if (f.tex >= 4 || f.up >= 256) return `first-draw uploads (${f.up} KB, ${f.tex} tex)`;
  if (f.cpu > budget * 0.8) {
    // A render pass's JS is a few hundred WebGL calls; when one of those passes takes most of a
    // frame, the time went *inside* a call — WebKit blocking on its GPU process (a Metal pipeline
    // built on first draw, a sync readback) — not in three's own bookkeeping.
    const [pass, ms] = Object.entries(f.phases).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (pass && pass !== 'sim' && ms > budget * 0.5) return `GL stall in ${pass} (${ms.toFixed(0)} ms)`;
    return `JS: ${f.top}`;
  }
  return 'not JS — GPU, compositor or GC (check the trace)';
}

export function analyse(data) {
  const fr = data.frames;
  const n = fr.t.length;
  const phaseNames = Object.keys(data.phases ?? {});
  const saveBit = 1 << (data.tags.length - 1);
  const budget = 1000 / data.cap;
  const rows = [];
  // A recorded `gap` is the time from the *previous* frame's start to this one's, so it is the
  // previous frame's work (its JS, its links, its uploads, and the GPU behind it) that made it long.
  // Each row here is re-based so `gap` is the frame's own duration: next start minus its start. The
  // last frame has no successor and is dropped.
  for (let i = 0; i + 1 < n; i += 1) {
    const phases = Object.fromEntries(phaseNames.map((p) => [p, data.phases[p][i] ?? 0]));
    const top = Object.entries(phases).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
    rows.push({
      i, t: fr.t[i], gap: fr.gap[i + 1], cpu: fr.cpu[i], link: fr.link[i], up: fr.up[i], tex: fr.tex[i],
      calls: fr.calls[i], tris: fr.tris[i], rs: fr.rs[i], tags: fr.tags[i], save: Boolean(fr.tags[i] & saveBit),
      phases, top,
    });
  }
  const late = rows.filter((r) => r.gap > budget * 1.7);
  // -1 is a gap that spanned the app being backgrounded (src/game/perf.js).
  for (let k = rows.length - 1; k >= 0; k -= 1) if (rows[k].gap < 0) rows.splice(k, 1);
  for (const r of late) r.cause = causeOf(r, budget);
  return { rows, late, budget, phaseNames };
}

async function report(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  const { rows, late, budget, phaseNames } = analyse(data);
  const lines = [];
  const say = (s = '') => lines.push(s);
  const t0 = rows[0]?.t ?? 0;
  const secs = rows.length ? (rows[rows.length - 1].t - t0) / 1000 : 0;
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  const cpus = rows.map((r) => r.cpu).sort((a, b) => a - b);

  say(`# ?perf capture — ${path.basename(file)}`);
  say();
  say(`${data.nativeVersion ? `App ${data.nativeVersion.version} (${data.nativeVersion.build})` : 'Browser'} · ${data.gpu}`
    + ` · canvas ${data.canvas.w}×${data.canvas.h} @ dpr ${data.screen.dpr} · cap ${data.cap} fps`
    + ` · quality ${data.context?.quality ?? '?'} · saved on ${data.reason}`);
  say();
  say('## Startup');
  say();
  const marks = [...(data.boot.marks ?? []), ...data.notes.filter(([, n]) => !/^resize|^away/.test(n))]
    .sort((a, b) => a[0] - b[0]);
  const seen = new Set();
  let prev = 0;
  for (const [t, name] of marks) {
    if (seen.has(name)) continue;
    seen.add(name);
    say(`- ${String(t).padStart(6)} ms  ${name.padEnd(20)} +${t - prev}`);
    prev = t;
  }
  say(`- boot (capture start → first frame): ${data.boot.link} links, ${data.boot.up} KB buffers, ${data.boot.tex} texture uploads`);
  const res = data.boot.resources ?? [];
  if (res.length) {
    const slow = [...res].sort((a, b) => b[2] - a[2]).slice(0, 5);
    say(`- ${res.length} resources; slowest: ${slow.map(([n, , d]) => `${n.split('/').pop()} ${d}ms`).join(', ')}`);
  }
  say();
  say('## Frames');
  say();
  say(`${rows.length} frames over ${fmt(secs, 0)} s (${fmt(rows.length / Math.max(secs, 1), 1)} fps against a ${data.cap} cap).`);
  say(`Gap p50 ${fmt(pct(gaps, 0.5))} · p95 ${fmt(pct(gaps, 0.95))} · p99 ${fmt(pct(gaps, 0.99))} · max ${fmt(gaps[gaps.length - 1])} ms.`);
  say(`JS p50 ${fmt(pct(cpus, 0.5))} · p95 ${fmt(pct(cpus, 0.95))} · max ${fmt(cpus[cpus.length - 1])} ms.`);
  say(`Late frames (> ${fmt(budget * 1.7, 0)} ms): ${late.length} — ${fmt(late.length / Math.max(secs / 60, 1 / 60), 1)} a minute.`);
  say();
  if (phaseNames.length) {
    say('JS by phase, mean / p95 ms:');
    say();
    for (const p of phaseNames) {
      const v = rows.map((r) => r.phases[p]).sort((a, b) => a - b);
      const mean = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
      say(`- ${p.padEnd(6)} ${fmt(mean, 2)} / ${fmt(pct(v, 0.95), 2)}`);
    }
    say();
  }
  say('## Late frames by cause');
  say();
  const byCause = new Map();
  for (const r of late) {
    const key = r.cause.replace(/ \(\d+ KB.*\)$/, '').replace(/×\d+/, '').replace(/^JS: .*/, 'JS').replace(/ \(\d+ ms\)$/, '');
    const entry = byCause.get(key) ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += r.gap - budget;
    byCause.set(key, entry);
  }
  for (const [cause, { n, ms }] of [...byCause].sort((a, b) => b[1].ms - a[1].ms)) {
    say(`- **${cause}** — ${n} frames, ${fmt(ms, 0)} ms over budget in all`);
  }
  say();
  say('## Worst 25');
  say();
  say('| at (s) | gap | JS | top phases | links | KB up | tex | calls | tags | cause |');
  say('|---|---|---|---|---|---|---|---|---|---|');
  const tagNames = data.tags;
  for (const r of [...late].sort((a, b) => b.gap - a.gap).slice(0, 25)) {
    const tags = tagNames.filter((_, i) => r.tags & (1 << i)).join(' ');
    say(`| ${fmt((r.t - t0) / 1000, 1)} | ${fmt(r.gap, 0)} | ${fmt(r.cpu)} | ${r.top} | ${r.link || ''} | ${r.up || ''} | ${r.tex || ''} | ${r.calls} | ${tags} | ${r.cause} |`);
  }
  say();
  // Wall-clock times for lining the worst frames up against the Instruments trace.
  if (data.timeOrigin && late.length) {
    say('Worst five on the wall clock (to find in the trace):');
    say();
    for (const r of [...late].sort((a, b) => b.gap - a.gap).slice(0, 5)) {
      say(`- ${new Date(data.timeOrigin + r.t).toISOString().slice(11, 23)} — ${fmt(r.gap, 0)} ms`);
    }
  }
  const text = lines.join('\n');
  const out = file.replace(/\.json$/, '.md');
  await writeFile(out, `${text}\n`);
  console.log(text);
  console.log(`\nios-perf  report written to ${out}`);
}

if (command === 'launch') await launch();
else if (command === 'trace') await trace();
else if (command === 'pull') await pull();
else if (command === 'report' && args[1]) await report(args[1]);
else {
  console.log('usage: node tools/ios-perf.mjs launch|trace|pull|report <file> [--device tdub] [--query perf] [--seconds 120]');
  process.exit(command ? 1 : 0);
}
