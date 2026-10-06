/**
 * Build a Release archive and upload it to App Store Connect, for `npm run archive:ios`.
 *
 *   node tools/ios-archive.mjs               # build, archive, verify, upload to App Store Connect
 *   node tools/ios-archive.mjs --no-upload   # stop at a signed .ipa in ios/build/export/
 *   node tools/ios-archive.mjs --dirty       # allow uncommitted changes (the upload won't match a commit)
 *
 * `push:ios` is the wrong tool for this and not by accident: it builds **Debug**, because Web
 * Inspector is the only console the game has on a phone and it is `#if DEBUG`. What goes to Apple
 * is Release, and until this script the only way to make one was Product ▸ Archive in Xcode —
 * which has no build phase running `npm run build:ios` (docs/ios.md, "First-time Xcode setup"), so
 * it archives whatever `ios/SimTaxi/web/` happens to hold. That is the stale-bundle trap with the
 * App Store on the other end of it.
 *
 * **The build number is a UTC timestamp, passed on the command line.** App Store Connect refuses an
 * upload whose `CFBundleVersion` it has seen before for that version, so it has to move every time.
 * Not the commit count: CI clones shallow (this container's is 164 commits deep), and a count that
 * depends on clone depth can go backwards. And not an edit to `project.pbxproj`, which would leave
 * the tree dirty after every upload. `20261006.1432` is a valid three-part bundle version and sorts
 * after anything an earlier run produced. If Xcode Cloud is set up later, give it the same scheme
 * (or a start number above today's timestamp), or its smaller numbers will be refused.
 *
 * **Uploading needs Xcode signed in to the Apple account** (Settings ▸ Accounts) — that is what
 * `-allowProvisioningUpdates` uses to make the distribution certificate and profile on the first
 * run. `--no-upload` stops before that, with the .ipa for Transporter.
 */

import { spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkBundleLayout } from './ios-layout.mjs';

const PROJECT = 'ios/SimTaxi.xcodeproj';
const SCHEME = 'SimTaxi';
const OUT = 'ios/build';
const ARCHIVE = path.join(OUT, `${SCHEME}.xcarchive`);
const EXPORT = path.join(OUT, 'export');
const OPTIONS = path.join(OUT, 'ExportOptions.plist');

const args = process.argv.slice(2);
const upload = !args.includes('--no-upload');
const allowDirty = args.includes('--dirty');

function run(command, argv) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: `${out}${err.message}` }));
  });
}

const die = (message, detail) => {
  console.error(`\narchive:ios  ${message}`);
  if (detail) console.error(detail.trimEnd().split('\n').slice(-25).join('\n'));
  process.exit(1);
};

const step = (n, message) => console.log(`archive:ios  ${n}/5  ${message}`);

// ----- 1. A clean tree -------------------------------------------------------------------------
// An upload is a release. One built from uncommitted changes can't be traced back to a commit when
// a review note or a crash report points at it.

step(1, 'checking the working tree');
{
  const { code, out } = await run('git', ['status', '--porcelain']);
  if (code !== 0) die('git status failed', out);
  if (out.trim() && !allowDirty) {
    die('there are uncommitted changes. Commit them, or pass --dirty to archive anyway.', out);
  }
}
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildNumber = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  + `.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
console.log(`             build ${buildNumber}`);

// ----- 2. The web bundle -----------------------------------------------------------------------
// Always rebuilt, for the reason in the header.

step(2, 'building the web bundle');
{
  const { code, out } = await run('npm', ['run', 'build:ios']);
  if (code !== 0) die('the web build failed', out);
}

// ----- 3. The archive --------------------------------------------------------------------------

step(3, 'archiving Release');
await rm(OUT, { recursive: true, force: true });
{
  const { code, out } = await run('xcrun', ['xcodebuild',
    '-project', PROJECT,
    '-scheme', SCHEME,
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-archivePath', ARCHIVE,
    '-allowProvisioningUpdates',
    `CURRENT_PROJECT_VERSION=${buildNumber}`,
    'archive',
  ]);
  if (code !== 0) die('the archive failed', out);
}

// ----- 4. The layout assertion -----------------------------------------------------------------
// The same check push:ios runs. It matters more here: this is the build players get.

step(4, 'checking the bundle layout');
{
  const layout = await checkBundleLayout(path.join(ARCHIVE, 'Products/Applications', `${SCHEME}.app`));
  if (!layout.ok) die(layout.message);
  console.log(`             ${layout.count} files under web/, none loose at the root`);
}

// ----- 5. Export, and upload -------------------------------------------------------------------
// `app-store-connect` is the Xcode 15.3+ name for the old `app-store` method. With
// `destination: upload` the export *is* the upload; with `export` it writes the .ipa to disk.

step(5, upload ? 'uploading to App Store Connect' : 'exporting the .ipa');
await writeFile(OPTIONS, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>${upload ? 'upload' : 'export'}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`);
{
  const { code, out } = await run('xcrun', ['xcodebuild', '-exportArchive',
    '-archivePath', ARCHIVE,
    '-exportPath', EXPORT,
    '-exportOptionsPlist', OPTIONS,
    '-allowProvisioningUpdates',
  ]);
  if (code !== 0) {
    const account = /No Accounts|not signed in|No signing certificate|account/i.test(out);
    die(account
      ? 'the export failed on signing. Sign in to the Apple account in Xcode ▸ Settings ▸ Accounts,\n'
        + '             and check the team is on the paid Apple Developer Program.'
      : 'the export failed', out);
  }
}

console.log(upload
  ? `\narchive:ios  done — build ${buildNumber} uploaded. It shows in App Store Connect ▸ TestFlight\n`
    + '             once Apple finishes processing it.'
  : `\narchive:ios  done — ${EXPORT}/${SCHEME}.ipa (build ${buildNumber}).`);
