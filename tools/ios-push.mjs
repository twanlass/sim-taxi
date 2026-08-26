/**
 * Build the app and push it to a paired iPhone over Wi-Fi, for `npm run push:ios`.
 *
 *   node tools/ios-push.mjs                 # build, verify, install, launch
 *   node tools/ios-push.mjs --release       # Release configuration (see the note on DEBUG below)
 *   node tools/ios-push.mjs --device tdub   # by name or UDID, when more than one is paired
 *   node tools/ios-push.mjs --no-launch     # install only
 *
 * Four commands in a row, none of them interesting on its own. What makes this worth a file is the
 * **verify** step in the middle, and the fact that two of the four fail in ways that read as
 * success.
 *
 * **Debug by default, which is the opposite of what a "push to my phone" script usually wants.**
 * `webView.isInspectable` in `GameViewController.swift` is `#if DEBUG`, and Safari Web Inspector is
 * the only console the game has on a device — it is where `?diag` prints, where the storage
 * inspector answers the `localStorage` question in docs/ios.md, and where a WebGL context loss says
 * so. A Release build installs and runs identically and tells you nothing when it doesn't.
 *
 * **The bundle layout is asserted, not assumed.** `web/` has to land in the .app as an opaque
 * folder; if it arrives flattened, `BundleSchemeHandler` hits its `fatalError` and every asset path
 * 404s — at runtime, on the phone, with a clean green build behind it. That failure has already
 * happened once here (Xcode's synchronized groups walk into subdirectories and copy flat, so the
 * project arrives in the broken state without anyone choosing it — see docs/ios.md, "The bundle
 * layout"). It costs
 * one `find` to rule out and it is checked on every push, because the thing that breaks it is a
 * project-file edit nobody remembers making.
 *
 * **A locked phone refuses the launch, and only the launch.** The install has already succeeded by
 * then, so this is a note and not a failure — exiting non-zero there would send you rebuilding
 * something that is already sitting on the home screen.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT = 'ios/SimTaxi.xcodeproj';
const SCHEME = 'SimTaxi';
const DERIVED = 'ios/DerivedData';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const configuration = flag('--release') ? 'Release' : 'Debug';
const wanted = value('--device');
const launch = !flag('--no-launch');

/** Run a command, streaming nothing, returning `{ code, out }` with stdout and stderr merged. */
function run(command, argv, { quiet = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk) => {
      out += chunk;
      if (!quiet) process.stdout.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: `${out}${err.message}` }));
  });
}

const die = (message, detail) => {
  console.error(`\npush:ios  ${message}`);
  if (detail) console.error(detail.trimEnd().split('\n').slice(-25).join('\n'));
  process.exit(1);
};

const step = (n, message) => console.log(`push:ios  ${n}/5  ${message}`);

// ----- 1. The web bundle -----------------------------------------------------------------------
// Always rebuilt. The whole point of pushing is to see a change on the phone, and the failure mode
// of skipping it — a device running the previous bundle while the diff says otherwise — is the most
// confusing one available.

step(1, `building the web bundle`);
{
  const { code, out } = await run('npm', ['run', 'build:ios']);
  if (code !== 0) die('the web build failed', out);
  const summary = out.split('\n').filter((l) => l.startsWith('ios-sync')).join('\n');
  if (summary) console.log(`          ${summary.trim()}`);
}

// ----- 2. The device ---------------------------------------------------------------------------
// `tunnelState` is deliberately not consulted. It reads `disconnected` for a perfectly reachable
// phone — the tunnel is brought up on demand by the install itself — so gating on it here would
// refuse the common case.

step(2, 'finding a paired device');
const listFile = path.join(tmpdir(), `sim-taxi-devices-${process.pid}.json`);
let device;
try {
  const { code, out } = await run('xcrun', ['devicectl', 'list', 'devices', '--json-output', listFile]);
  if (code !== 0 || !existsSync(listFile)) die('could not list devices', out);
  const parsed = JSON.parse(await readFile(listFile, 'utf8'));
  const phones = (parsed?.result?.devices ?? [])
    .filter((d) => d.hardwareProperties?.platform === 'iOS')
    .map((d) => ({ id: d.identifier, name: d.deviceProperties?.name ?? '(unnamed)' }));

  if (phones.length === 0) {
    die('no paired iOS device. Plug one in once, trust it, and enable\n'
      + '          Settings ▸ Privacy & Security ▸ Developer Mode. Xcode ▸ Devices then offers\n'
      + '          "Connect via network", which is what makes every later push wireless.');
  }
  const match = wanted
    ? phones.find((p) => p.id === wanted || p.name.toLowerCase() === wanted.toLowerCase())
    : phones[0];
  if (!match) die(`no paired device matches "${wanted}". Paired: ${phones.map((p) => p.name).join(', ')}`);
  if (!wanted && phones.length > 1) {
    console.log(`          ${phones.length} paired — using "${match.name}". Pass --device to choose.`);
  }
  device = match;
} finally {
  await rm(listFile, { force: true });
}
console.log(`          ${device.name}  ${device.id}`);

// ----- 3. The signed build ---------------------------------------------------------------------
// `-allowProvisioningUpdates` lets xcodebuild register the app and refresh the profile without
// opening Xcode. It is a no-op when the team's wildcard profile already covers the bundle id.

step(3, `building ${configuration} for the device`);
{
  const { code, out } = await run('xcrun', ['xcodebuild',
    '-project', PROJECT,
    '-scheme', SCHEME,
    '-configuration', configuration,
    '-destination', `id=${device.id}`,
    '-derivedDataPath', DERIVED,
    '-allowProvisioningUpdates',
    'build',
  ]);
  if (code !== 0) {
    const signing = /No profiles for|requires a provisioning profile|Signing for .* requires/.test(out);
    die(signing
      ? 'the build failed on code signing. Open the project in Xcode once and pick a team\n'
        + '          under Signing & Capabilities — the first registration needs a UI session.'
      : 'the device build failed', out);
  }
}

// ----- 4. The layout assertion -----------------------------------------------------------------
// See the header. A green build proves nothing about this.

step(4, 'checking the bundle layout');
const appPath = path.join(DERIVED, 'Build/Products', `${configuration}-iphoneos`, `${SCHEME}.app`);
if (!existsSync(appPath)) die(`the build reported success but produced no app at ${appPath}`);
{
  const scripts = [];
  const walk = async (dir, rel = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(dir, entry.name), at); continue; }
      if (entry.name.endsWith('.js') || entry.name === 'index.html') scripts.push(at);
    }
  };
  await walk(appPath);

  const stray = scripts.filter((f) => !f.startsWith('web/'));
  if (!scripts.includes('web/index.html')) {
    die('the app has no web/index.html — BundleSchemeHandler will fatalError on launch.\n'
      + `          Found instead: ${scripts.join(', ') || '(nothing)'}\n`
      + '          Fix: docs/ios.md — the sync group needs explicitFolders = ( web, ).');
  }
  if (stray.length) {
    die('the web bundle was flattened into the app root — every asset path will 404.\n'
      + `          Loose at the root: ${stray.join(', ')}\n`
      + '          Fix: docs/ios.md — the sync group needs explicitFolders = ( web, ).');
  }
  console.log(`          ${scripts.length} files under web/, none loose at the root`);
}

// ----- 5. Install, and launch if the phone is awake --------------------------------------------

step(5, `installing to ${device.name}`);
// Taken from what was actually installed rather than written down here, so renaming the app in the
// project doesn't leave this script launching a bundle id that no longer exists.
let bundleId;
{
  const { code, out } = await run('xcrun', ['devicectl', 'device', 'install', 'app',
    '--device', device.id, appPath]);
  if (code !== 0) {
    const unreachable = /could not be found|not connected|unreachable|timed out/i.test(out);
    die(unreachable
      ? `could not reach ${device.name}. It has to be awake and on the same Wi-Fi as this Mac.`
      : 'the install failed', out);
  }
  bundleId = out.match(/bundleID:\s*(\S+)/)?.[1];
  console.log(`          installed${bundleId ? `  ${bundleId}` : ''}`);
}

if (!launch) {
  console.log('\npush:ios  done — not launching (--no-launch).');
  process.exit(0);
}

if (!bundleId) {
  console.log('\npush:ios  done — installed. The install did not name a bundle id, so it was not launched.');
  process.exit(0);
}

{
  const { code, out } = await run('xcrun', ['devicectl', 'device', 'process', 'launch',
    '--device', device.id, bundleId]);
  if (code === 0) {
    console.log('\npush:ios  done — running on the device.');
  } else if (/Locked|could not be, unlocked/.test(out)) {
    // Not a failure. The app is installed; iOS just will not open it onto a locked screen.
    console.log(`\npush:ios  done — installed, but ${device.name} is locked, so it was not launched.`);
    console.log('          Unlock it and tap Sim Taxi.');
  } else {
    die('installed, but the launch failed', out);
  }
}
