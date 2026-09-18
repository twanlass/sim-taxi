# Audio

**Not built yet.** This is the plan, written before the first line of it exists, because the
decisions below are the kind that are expensive to reverse once a sound artist is working against
them and a hundred call sites name events.

The game is silent today. There is no `AudioContext` anywhere in `src/`.

## The doctrine, amended

This project's founding constraint is **zero external assets**, and audio breaks it. That is
settled rather than open: **the music and the effects are human-authored, delivered as files.**

The line was always about the *look* — a city that generates its own geometry from a seed, with no
loader and no model file — and it still holds there. It is restated everywhere it appears as
**zero external *visual* assets** ([README](README.md#conventions-worth-knowing-before-editing),
[CLAUDE.md](../CLAUDE.md), [rendering.md](rendering.md)). Nothing under `geometry/` or `city/` gets
to load a `.glb` on the strength of this.

The alternative was considered and rejected, and it is worth writing down why, because
[ios.md](ios.md) recommended it for a year: **synthesised Web Audio** would have held the line
exactly, and the low-poly generated aesthetic argues for it honestly. It loses on hiring. Perhaps
one audio person in fifty writes Web Audio graphs, and the ones who do are not the ones who write
the music. Paying an artist to learn an engine is paying for the wrong thing.

**But the mix is still data in this repo.** The artist owns the samples; the *numbers* — gain,
pitch jitter, cooldown, ducking, voice priority — live in `src/audio/mix.js` as JSON, tuned in the
tools below and committed like any other constant. That is what stops "make it 2dB quieter" being
a round trip through somebody's DAW, and it is the half of the collaboration that decides whether
this is pleasant or miserable.

## Shape

Four modules, and the first of them is a copy of something that already works.

| File | Owns |
|---|---|
| `src/audio/events.js` | the event allow-list and the manifest: file, bus, gain, pitch jitter, cooldown, voice budget |
| `src/audio/index.js` | the `AudioContext`, the buses, the unlock gesture, `play()` / `loop()` |
| `src/audio/mix.js` | the tunable numbers, loadable and dumpable as JSON |
| `src/game/audiostash.js` | localStorage persistence for a tuning session |

### `util/haptics.js` is the template, deliberately

The haptics bridge already solved most of this problem for a different output device, and every
rule it arrived at transfers:

- **A named-event allow-list, not a free string.** `haptics.js` keeps an explicit `EVENTS` set so a
  typo throws here rather than going silent on the phone. Audio has the identical failure — a
  `sound('picku')` plays nothing, and a feature that produces nothing is indistinguishable from one
  that was never wired up. That trap has cost this project weeks before (the boats' wake; see
  [CLAUDE.md](../CLAUDE.md)), and audio is the most exposed surface in the game to it, because the
  only witness to a correct sound is an ear.
- **Read at call time, never at import.** `tools/check.mjs` boots the whole module graph in node,
  where there is no `window` and no `AudioContext`. A module-level `new AudioContext()` takes the
  entire headless suite down. Same rule as `isNative()`.
- **Silent everywhere it cannot work, wrapped in a `try`.** Dropping a sound is never worth an
  error.
- **Name the *event*, not the sound.** `haptics.js` posts `'loco'` and lets Swift pick the
  transient, so the choice can be made per device generation. Audio wants the same seam for a
  different reason: the artist has to be able to replace what `'loco'` *is* without a code change.

**Eight call sites already exist and are already right.** Every `haptic()` call in `main.js` and
`game/pathdrag.js` fires at the moment an input was *accepted* — a refused tap stays silent —
which is exactly the gate a confirmation sound needs. Those are the free first wiring pass:
`pick`, `grab`, `snap`, `brake`, `loco`, `parcel-in`, `parcel-out`, `burger`.

### Four things haptics does not cover

**Loops with a parameter.** The engine is the sound that decides whether this game feels good, and
it is not an event — it is a continuous voice whose pitch and filter track `taxi.speed` against
`SPEED = 8.5` and the boost ceiling above it (`MPH_PER_UNIT = 67/22.95`, so cruise reads as ~25mph
and the overdrive band roughly doubles it). Same shape: the siren, the boost roar, the river, the
drawbridge motor, the city ambience. These need a `loop(event)` handle with settable params and a
fade-out, not a fire-and-forget.

**Position, under an orthographic camera that never rotates.** Skip `THREE.PositionalAudio`. A
distance model wants a perspective listener, and this eye sits 400 units from everything (see the
fog note in [CLAUDE.md](../CLAUDE.md) — the same arithmetic bites here). What the fixed 3/4 view
buys instead is that **screen position is the whole answer**: `projectToScreen`, which already
exists and which the HUD already aims with, gives an x for the pan and a distance-from-centre for
the gain. Cheaper and better suited, and it cannot disagree with what the player is looking at.

**A voice cap, decided before the first real sound lands.** A dozen ambient cars, a siren, a
drawbridge and a boosting taxi will stack into mud, and when they do everyone blames the samples.
Per-bus voice limits and an explicit stealing rule (oldest first, lowest priority first) belong in
the manifest from day one.

**Pause, and the crash's time dilation.** `frame()` in `main.js` returns before a single `update()`
while `pause.state.paused` is set — audio has to suspend on the same transition, not keep droning
over the veil. The slow-motion wreck is a live question rather than an obvious one: `dt` is scaled
so the blast, the camera and the shake decay together, and whether the audio pitches down with them
is an artistic call. Expose it as a knob rather than guessing.

## Buses

Four, so the artist has somewhere to put a decision:

- `sfx` — one-shots, the whole haptic taxonomy plus the world's own noises
- `engine` — the taxi, and only the taxi
- `ambience` — traffic, river, city, birds
- `music` — the run's bed and its stingers

Master over all four. Ducking is a bus-to-bus rule in the manifest (`music` under `sfx` on a
drop-off, say), not something scattered through call sites.

## The tools

Three, and they answer different questions. Building only one of them is the mistake to avoid.

### `/audio/` — the sound lab

**A third Vite entry, mirroring `/lab/` exactly.** The passing lab already established this
pattern down to its details and every one of them applies again: its own page under `robots:
noindex`, no manifest and no service worker, nothing in the game linking to it, its own headless
check inside `npm run check`, and an entry in `tools/ios-sync.mjs`'s `EXCLUDE` so a developer
workbench never ships inside the `.ipa`. See [lab.md](lab.md), and note the warning in
`vite.config.js`: a `manualChunks` rule that reaches into `src/` turns an import into a boot.

What it carries:

- **A trigger board.** Every event in the allow-list as a button. Hear any sound in the game
  without playing the game — which is most of the point, since half these events take a good run to
  reach and two of them require crashing.
- **Drag-and-drop hot swap.** Drop a `.wav` onto a slot and it plays that instead, off an object
  URL. This is the feature that turns a demo into a workbench: the artist iterates with no build,
  no Node, and nothing committed.
- **A mix console.** Master, per bus, and per event — gain, pitch jitter, cooldown.
- **Copy-as-JSON out, paste-JSON in.** Without this an afternoon of tuning dies in a browser tab.
  With it the artist sends a blob and it lands in `mix.js` as a diff.
- **A parameter scrubber** for the loops — engine RPM, speed, boost, siren distance, time of day —
  so a continuous voice can be auditioned without driving.
- **Round-robin proof.** If an event has three variants, show which one just fired. "It sounds
  repetitive" should be a fact, not a feeling.

### The debug panel

`game/debugpanel.js`, already behind `?debug`/`?settings`, gets an audio section.

**The lab and the panel are not redundant.** The lab is for *auditioning* — one sound, in
isolation, on demand. The panel is for *mixing against the real game*: over real traffic, at real
timing, with real overlap and real ducking. The engine loop in particular can only be tuned
honestly in the second one, because it only sounds wrong at speeds you have to earn.

### `tools/audio.mjs`, inside `npm run check`

Asserts what silence cannot tell you apart from success:

- every event in the manifest has a file that exists
- every `sound('…')` call site in `src/` names an event that is in the allow-list
- no orphan files nobody references
- the mix JSON parses and every gain is in range

Plus the audio modules go into the `BOOT` list in `tools/check.mjs`, which exists precisely because
a browser-only scope slip once shipped undetected.

### Muting the tooling

A `getMuted()` in `util/shot.js` beside the existing getters, defaulting to silent under shot mode.
`tools/shoot.mjs`, `tools/smoke.mjs` and the whole headless suite must never make a sound.

## Unlock, pause, background

- **The unlock gesture.** Web Audio starts suspended on every browser and stays that way until a
  real user gesture. The opening vignette and the Home Screen tip both hand us one; hook the resume
  to the first `pointerdown` and treat a still-suspended context as ordinary rather than as an
  error.
- **Pause.** `game/pause.js` stops the whole loop. Suspend on the same transition and resume with
  it.
- **Backgrounding** already routes through `window.__taxi.pause.setPaused(true)` from the iOS
  shell, so it comes along free — but a browser tab needs `visibilitychange` wired too.

## iOS and mobile web

**The silent switch is the trap, and it is a native change, not a web one.** A `WKWebView` obeys
the ringer switch unless the shell sets an `AVAudioSession` category. This will be reported as
"audio is broken on iPhone" by the first person who tests with their phone on silent, and nothing
in `src/` can fix it.

[ios.md](ios.md) previously recommended `.ambient`, on the reasoning that it leaves the player's
own music playing. That is half right and the wrong half: `.ambient` also stays silent with the
switch off. **`.playback` with `.mixWithOthers`** overrides the ringer switch *and* leaves their
music alone, which is what a casual game wants. One line in `ios/SimTaxi/GameViewController.swift`.

**Format: AAC in `.m4a`.** `.ogg` is not safe on older iOS, and this is an iPhone game.

**Import audio through Vite — do not put it in `public/`.** This matters more than it looks.
`public/sw.js` is cache-first on unhashed files, and its `CACHE_NAME` has to be bumped by hand
whenever one of them changes (that is why the note above `CACHE_NAME` exists at all, and why the
icons are listed in `PRECACHE_URLS`). Audio dropped in `public/` inherits that: an artist replacing
a sample would never reach an installed player, silently, forever. Vite-imported audio is
content-hashed like the rest of `assets/`, so cache-first is always correct and the problem does
not exist. `tools/ios-sync.mjs` mirrors `dist/`, so the `.ipa` picks it up with no extra work.

**A bundle budget, agreed with the artist before delivery, not after.** The offline shell precaches
everything and three.js alone is already ~516kB. Something like **2–3MB of audio total** is the
number to hand over up front; 48kHz stereo masters of forty one-shots is an order of magnitude more
than that, and it is much cheaper to say so at the start than to ask for a re-render at the end.

## The collaboration itself

Netlify builds on push to `main` (`netlify.toml`). A **deploy preview of `/audio/`** means the
artist needs no toolchain at all — they open a URL on their laptop and on their phone, drop files
onto slots, tune, and send back JSON. That is the difference between someone who can self-serve and
someone who pings you for every build, and it is worth setting up before the first sample arrives
rather than after.

## Phasing

0. **Decide** the audio session category and the format. (Doctrine: settled above.)
1. **The core**, plus exactly one placeholder sound end to end through the real pipeline — in
   `BOOT`, with `tools/audio.mjs` green.
2. **The `/audio/` lab**, with JSON export.
3. **Wire the eight existing haptic sites.** They are already at the right moments.
4. **The parametric loops** — engine first. Most artist back-and-forth by a distance; budget for it.
5. **The iOS session**, verified on a real phone with the switch both ways.

**Step 1 before step 2**, and the temptation is to do it the other way round because the lab is the
fun part. A lab built against a pipeline that does not exist yet bakes in assumptions the real
pipeline then has to honour, and unpicking that costs more than the week it saved.

## Open questions for the artist

- Does the engine pitch down in the crash's slow motion, or hold?
- One music bed with intensity layers, or discrete cues per shift?
- How many variants does a repeating one-shot need before the round robin stops being audible?
  (`pick` fires many times a minute; `parcel-out` a handful of times a run.)
- Does the siren pan by screen position or stay centred as pure tension?
