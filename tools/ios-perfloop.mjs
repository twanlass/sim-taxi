/**
 * The unattended profiling loop: build, install, play the scripted session on the phone, pull the
 * capture, cool down, repeat — and report fps per scene for every variant.
 *
 *   node tools/ios-perfloop.mjs --device tdub                         # current checkout, 3 runs
 *   node tools/ios-perfloop.mjs --variants "webgl=renderer=classic,webgpu=" --runs 2
 *   node tools/ios-perfloop.mjs --no-build --runs 1 --cool 60         # what is already installed
 *   node tools/ios-perfloop.mjs --summarise perf-captures/loop/<dir>  # re-report a finished loop
 *
 * Each run relaunches the app (a DEBUG build, which is the only one that reads `--query` and saves
 * captures) with `?perf&bot` and pinned seeds, so every run plays the same session
 * (src/game/perfbot.js): fares, Loco, a drift, Big Air, the bank job, a patrol chase, a wreck. The
 * capture is saved when the bot finishes (`bot-done`); this polls the app's container for it,
 * copies it off and splits it by scene (`scenes` in tools/ios-perf.mjs).
 *
 * **Heat.** An iPhone throttles as it warms, by enough to hide the change being measured, so the
 * phone cools between runs with the app killed (`--cool`, default 180 s) and the shell writes its
 * thermal state into the capture (ios/SimTaxi/PerfBridge.swift). A run that *starts* above
 * `nominal` is kept but flagged, and left out of the medians while there is a cool one to use.
 * Needs: the phone unlocked, on power, Auto-Lock set to Never (the app keeps the screen on only while
 * it is frontmost, and it is killed to cool), and the same Wi-Fi as the Mac or a cable.
 *
 * `--variants` is `label=query,label=query`: each query is appended to the base for that variant,
 * and the runs interleave (A, B, A, B…) so heat and battery drift land on both alike.
 * `--queries-only` skips the push between variants; the build happens once at the start unless
 * `--no-build`. Results land in `perf-captures/loop/<stamp>/` (git-ignored): every capture, its
 * markdown report, `runs.jsonl`, and `summary.md`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyse, scenes } from './ios-perf.mjs';

const BUNDLE = 'com.twanlass.rocketrides';
const BOT_SECONDS = 262;   // the sum of BOT_SCENES in src/game/perfbot.js, give or take the robbery
/**
 * Pinned so every run is the same session: the city, the situation, the resolution and the cap.
 * The governor is off because a resize mid-run is itself a hitch and moves the fill cost; dpr 2 is
 * where it holds a Regular phone anyway, and never lower (Tyler, #573). 60 fps uncapped rather than
 * Regular's 30, so a change that buys headroom shows up even while the game is under 30.
 */
const BASE = 'perf&bot&seed=71624&run=7&title=off&vignette=off&governor=off&squall=off&dpr=2&fps=60';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

function run(cmd, argv, { quiet = true, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = timeout ? setTimeout(() => child.kill('SIGKILL'), timeout) : null;
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out }); });
    child.on('error', (err) => resolve({ code: 1, out: `${out}${err.message}` }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const say = (s) => console.log(`perfloop  ${new Date().toTimeString().slice(0, 8)}  ${s}`);

async function findDevice() {
  const file = path.join(tmpdir(), `sim-taxi-loop-devices-${process.pid}.json`);
  const { code, out } = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', file]);
  if (code !== 0 || !existsSync(file)) throw new Error(`could not list devices\n${out}`);
  const phones = (JSON.parse(await readFile(file, 'utf8'))?.result?.devices ?? [])
    .filter((d) => d.hardwareProperties?.platform === 'iOS' && d.hardwareProperties?.reality !== 'simulated')
    .map((d) => ({ id: d.identifier, udid: d.hardwareProperties?.udid, name: d.deviceProperties?.name ?? '' }));
  const wanted = value('--device');
  const match = wanted ? phones.find((p) => [p.id, p.udid, p.name.toLowerCase()].includes(wanted.toLowerCase())) : phones[0];
  if (!match) throw new Error(`no paired iPhone${wanted ? ` matches "${wanted}"` : ''}`);
  return match;
}

/** Launch with a query; answers the pid (for the kill that starts the cool-down), or throws. */
async function launch(device, query) {
  const file = path.join(tmpdir(), `sim-taxi-loop-launch-${process.pid}.json`);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { code, out } = await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device.id,
      '--terminate-existing', '--json-output', file, BUNDLE, '--query', query], { timeout: 60_000 });
    if (code === 0) {
      try { return JSON.parse(await readFile(file, 'utf8'))?.result?.process?.processIdentifier ?? null; } catch { return null; }
    }
    say(`launch failed (attempt ${attempt}): ${out.trim().split('\n').slice(-2).join(' ')}`);
    // Almost always a locked phone. Nothing here can unlock it; wait in case someone does.
    await wait(30_000 * attempt);
  }
  throw new Error('launch kept failing — is the phone unlocked, with Auto-Lock set to Never?');
}

async function kill(device, pid) {
  if (!pid) return;
  await run('xcrun', ['devicectl', 'device', 'process', 'terminate', '--device', device.id, '--pid', String(pid)], { timeout: 30_000 });
}

/** Every capture in the app's container, copied to `dest`. */
async function pullAll(device, dest) {
  await mkdir(dest, { recursive: true });
  const { code } = await run('xcrun', ['devicectl', 'device', 'copy', 'from', '--device', device.id,
    '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
    '--source', 'Documents/perf', '--destination', dest], { timeout: 120_000 });
  if (code !== 0) return [];
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.json')) out.push(full);
    }
  };
  await walk(dest);
  return out;
}

/**
 * Wait for this launch's capture to say the bot is done. Captures are named after the page's own
 * `timeOrigin`, so the one that belongs to this run is the newest one started after the launch.
 */
async function awaitCapture(device, launchedAt, scratch) {
  const deadline = Date.now() + (BOT_SECONDS + 150) * 1000;
  await wait((BOT_SECONDS - 20) * 1000);
  let last = null;
  while (Date.now() < deadline) {
    const files = await pullAll(device, path.join(scratch, `poll-${Date.now()}`));
    for (const f of files) {
      const data = JSON.parse(await readFile(f, 'utf8'));
      if ((data.timeOrigin ?? 0) < launchedAt - 5000) continue;
      if (!last || data.timeOrigin > last.data.timeOrigin || (data.timeOrigin === last.data.timeOrigin && data.frames.t.length > last.data.frames.t.length)) last = { file: f, data };
    }
    if (last?.data.notes.some(([, n]) => n.startsWith('bot:done'))) return last;
    await wait(20_000);
  }
  return last;   // unfinished, or null — reported as such
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '–');

/** One row per scene per variant: medians over that variant's runs, cool ones preferred. */
function summarise(runs, title) {
  const lines = [`# ${title}`, ''];
  const variants = [...new Set(runs.map((r) => r.variant))];
  const sceneNames = [...new Set(runs.flatMap((r) => r.scenes.map((s) => s.name)))];
  lines.push(`${runs.length} runs. Medians per scene; a run that started above nominal is left out while a cool one exists.`, '');
  lines.push(`| scene | ${variants.map((v) => `${v} fps | ${v} p95 ms | ${v} hitches`).join(' | ')} |`);
  lines.push(`|---|${variants.map(() => '---|---|---').join('|')}|`);
  for (const name of sceneNames) {
    const cells = variants.map((v) => {
      const all = runs.filter((r) => r.variant === v && r.ok);
      const cool = all.filter((r) => r.startThermal === 'nominal');
      const use = (cool.length ? cool : all).map((r) => r.scenes.find((s) => s.name === name)).filter(Boolean);
      return `${f1(median(use.map((s) => s.fps)))} | ${f1(median(use.map((s) => s.p95)))} | ${f1(median(use.map((s) => s.hitches)))}`;
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  lines.push('', '## Runs', '');
  for (const r of runs) {
    lines.push(`- ${r.variant} #${r.k}: ${r.ok ? 'finished' : r.error ?? 'did not finish'}, started ${r.startThermal}, hottest ${r.worstThermal}, `
      + `${f1(r.fps)} fps overall${r.stats ? `, managed ${JSON.stringify(r.stats)}` : ''} — ${r.file ?? ''}`);
  }
  return lines.join('\n');
}

async function main() {
  if (flag('--summarise')) {
    const dir = value('--summarise');
    const runs = (await readFile(path.join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const text = summarise(runs, `Perf loop — ${path.basename(dir)}`);
    await writeFile(path.join(dir, 'summary.md'), `${text}\n`);
    console.log(text);
    return;
  }
  const device = await findDevice();
  const runsPer = Number(value('--runs', 3));
  const cool = Number(value('--cool', 180));
  const variants = (value('--variants', 'build=') ?? '').split(',').filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    return { label: at < 0 ? pair : pair.slice(0, at), query: at < 0 ? '' : pair.slice(at + 1) };
  });
  const dir = path.join('perf-captures', 'loop', `${stamp()}${value('--label') ? `-${value('--label')}` : ''}`);
  await mkdir(dir, { recursive: true });
  say(`${device.name}: ${variants.map((v) => v.label).join(' / ')} × ${runsPer}, ${cool} s to cool → ${dir}`);

  if (!flag('--no-build')) {
    say('building and installing (DEBUG)…');
    const { code, out } = await run('node', ['tools/ios-push.mjs', '--device', device.name, '--no-launch'], { timeout: 15 * 60_000 });
    if (code !== 0) {
      console.error(out.trim().split('\n').slice(-25).join('\n'));
      throw new Error('push failed — see above (Game Center capability? phone locked?)');
    }
  }

  const runs = [];
  for (let k = 1; k <= runsPer; k += 1) {
    for (const v of variants) {
      const query = v.query ? `${BASE}&${v.query}` : BASE;
      say(`${v.label} #${k}: launching ?${query}`);
      const launchedAt = Date.now();
      let row = { variant: v.label, k, query, ok: false, scenes: [], startThermal: 'unknown', worstThermal: 'unknown' };
      try {
        const pid = await launch(device, query);
        const got = await awaitCapture(device, launchedAt, path.join(dir, '.pull'));
        await kill(device, pid);
        if (!got) throw new Error('no capture from this launch');
        const file = path.join(dir, `${v.label}-${k}.json`);
        await writeFile(file, JSON.stringify(got.data));
        const { rows } = analyse(got.data);
        const bot = scenes(got.data, rows);
        const heat = got.data.notes.filter(([, n]) => n.startsWith('thermal ')).map(([, n]) => n.slice(8));
        const RANK = ['nominal', 'fair', 'serious', 'critical'];
        // Overall over the scenes only: the capture keeps recording on the run-end card until it is
        // pulled, and those idle frames are not the session.
        const inScenes = bot.scenes.reduce((a, sc) => a + sc.frames, 0);
        const secs = bot.scenes.reduce((a, sc) => a + sc.secs, 0) || 1;
        row = {
          ...row, ok: bot.finished, file, scenes: bot.scenes, stats: bot.stats, fps: inScenes / secs,
          startThermal: heat[0] ?? 'unknown',
          worstThermal: heat.reduce((w, s) => (RANK.indexOf(s) > RANK.indexOf(w) ? s : w), heat[0] ?? 'unknown'),
        };
        await run('node', ['tools/ios-perf.mjs', 'report', file]);
        say(`${v.label} #${k}: ${bot.finished ? 'done' : 'UNFINISHED'}, ${f1(row.fps)} fps, thermal ${row.startThermal}→${row.worstThermal}; `
          + bot.scenes.map((s) => `${s.name} ${f1(s.fps)}`).join(' · '));
      } catch (error) {
        row.error = error.message;
        say(`${v.label} #${k}: ${error.message}`);
        if (/unlocked|Auto-Lock/.test(error.message)) { runs.push(row); break; }
      }
      runs.push(row);
      await appendFile(path.join(dir, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
      await writeFile(path.join(dir, 'summary.md'), `${summarise(runs, `Perf loop — ${path.basename(dir)}`)}\n`);
      const last = k === runsPer && v === variants[variants.length - 1];
      if (!last) {
        // A run that ended hot cools longer: serious takes minutes to come back to nominal.
        const extra = row.worstThermal === 'serious' || row.worstThermal === 'critical' ? 2 : row.worstThermal === 'fair' ? 1.5 : 1;
        say(`cooling ${Math.round(cool * extra)} s`);
        await wait(cool * extra * 1000);
      }
    }
  }
  const text = summarise(runs, `Perf loop — ${path.basename(dir)}`);
  console.log(`\n${text}`);
  say(`summary: ${path.join(dir, 'summary.md')}`);
}

main().catch((error) => { console.error(`perfloop  ${error.message}`); process.exit(1); });
