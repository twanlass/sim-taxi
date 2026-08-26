---
description: Build Sim Taxi and push it to the paired iPhone over Wi-Fi
allowed-tools: Bash(npm run push:ios), Bash(npm run push:ios -- *), Bash(npm run check), Bash(xcrun devicectl list devices*)
---

Push the current working tree to the phone.

Run `npm run push:ios`, passing through anything in `$ARGUMENTS` after `--`
(e.g. `npm run push:ios -- --device tdub --release`). It rebuilds the web bundle, builds and signs
a Debug device build, asserts the bundle layout, installs over the network and launches.

Then report, in a few lines:

- whether it landed, and on which device
- the `ios-sync` line, so the bundle size is visible
- anything the script flagged

Notes for reading the output:

- **A locked phone is not a failure.** The script says so explicitly and exits 0 — the app is
  installed and needs a tap. Don't rebuild.
- **Debug is deliberate**, not an oversight. `isInspectable` in `GameViewController.swift` is
  `#if DEBUG`, and Safari Web Inspector (Develop ▸ device ▸ Sim Taxi) is the only console the game
  has on hardware. Only use `--release` if asked.
- **The layout assertion is the one that matters.** If it fires, the fix is in
  [docs/ios.md](../../docs/ios.md) — the sync group needs `explicitFolders = ( web, )` — and
  not a rebuild. It catches a break that produces a perfectly green build and a dead app.

If the change being pushed touches anything under `src/`, run `npm run check` first and say what it
said. Don't push over a red suite without flagging it.
