# Audio

The taxi's sound: engine, Loco Mode, doors, bump, crash, jump and blinker. This is the **one part of the
game loaded from files**: the recordings are a sound designer's, and everything else, including
every mesh and the one texture, is still generated in code.

| File | Owns |
|---|---|
| `src/game/sfx.js` | The context, loading, the beds, the one-shots, mute |
| `assets/audio/mix.json` | The mix: every level, pitch, repeat gap and engine-bed number |
| `src/game/audiopanel.js` | The Audio sections of the ⚙️ panel, which edit the mix live and export it |
| `assets/audio-src/*.wav` | The designer's masters, committed, never shipped |
| `assets/audio/*.m4a` | The shipped files, one per master |
| `tools/audio.mjs` | WAV masters → AAC |
| `src/main.js` | Every call site: `sfx?.play(...)` next to the matching `haptic(...)` |

## The files

The masters are 48 kHz / 24-bit stereo WAV: **Block 1** (Nicolás J. Infantas Jamett, September
2026) is 41 files, 31.1 MB, covering 15 sounds, most of them as lettered variants. They are
**committed** under `assets/audio-src/`, so re-encoding never depends on a copy in somebody's
Downloads folder. Nothing in `src/` references them, so Vite never ships them: the bundle only
contains what a `new URL(...)` in `sfx.js` names. What ships is AAC at 128 kbps in an `.m4a`,
1,262 kB for Block 1, about 25× smaller. That format plays natively everywhere the game
runs (Safari, the iOS WKWebView, Chrome, Firefox), and `afconvert` comes with macOS, so encoding a
new delivery needs nothing installed:

```bash
node tools/audio.mjs            # reads assets/audio-src/*.wav, writes assets/audio/*.m4a
```

It re-encodes the whole set (a couple of seconds) and prints each file's size and the total, so a
delivery's size cost shows at a glance. **Re-runs are free in git**: the output is byte-for-byte
reproducible, so only a changed master shows up as a changed `.m4a`. afconvert stamps the wall
clock into the MP4 header (the `mvhd`/`tkhd`/`mdhd` times, 12 bytes), and the tool zeroes those
after each encode. It fails loudly if it can't find all three boxes, so a future afconvert that
changes the container can't quietly make the output non-reproducible again.

File names stay as the designer's (`NN_CATEGORY_descriptor_variant`, variants lettered `_A`, `_B`…
and a single file unlettered), so a re-delivery drops straight in. `FILES` in `sfx.js` is keyed by
those names, and `SOUNDS` maps what the game calls each sound to the takes it draws from. Each
`FILES` entry is a **literal** `new URL(..., import.meta.url)`.
That is what makes Vite fingerprint and emit them into `dist/assets/`. A URL built from a variable
is one Vite cannot see, so it will not ship.

Measured bitrates for the first (test) delivery: 64 kbps was 468 kB, 96 kbps 652 kB, 128 kbps 800 kB. 128 was
chosen because the saving at lower rates is small next to a smeared transient on a door or a crash.

### AAC priming and the loops

AAC pads the front of a stream with 2112 frames of encoder priming. Chrome trims them when it
decodes (measured: the idle loop decodes to exactly 4.000 s), and afconvert writes the metadata
Safari uses to do the same. A decoder that *didn't* trim would hand back a buffer 44 ms long at the
front, and looping the whole buffer would hiccup the engine every four seconds. `loopWindow`
guards against that: it compares the buffer against the master's true length (`LOOP_SECONDS`) and
sets `loopStart`/`loopEnd` around the real audio either way.

## Adding or replacing a sound

More deliveries are coming. For each one:

1. **Drop the WAVs into `assets/audio-src/`.** Keep the designer's names. A file with the same name
   as an existing one *is* a replacement, and needs no code change beyond step 2.
2. **Run `node tools/audio.mjs`.** It writes an `.m4a` beside every master into `assets/audio/`.
   Commit both the `.wav` and the `.m4a`: the master so it can be re-encoded later, and the `.m4a`
   because that is what the build uses (the build does not run the encoder, and Netlify has no
   `afconvert`).
3. **A new sound needs wiring in `src/game/sfx.js`:**
   - Add each file to `FILES`, as a **literal** `new URL('../../assets/audio/<name>.m4a', import.meta.url).href`.
     Don't build the path from a variable, or Vite won't ship the file. Then list its takes under
     the sound's name in `SOUNDS`. `npm run check` fails if a take names a file that isn't shipped,
     or a shipped `.m4a` isn't anybody's take.
   - Give the sound an entry in `assets/audio/mix.json`'s `sounds` (its level and pitch in the
     mix, one for all its takes). Block 1 arrived balanced against itself, and the designer's
     note was to start every level at 0 dB and move from there. `npm run check` fails if a sound
     has no entry.
   - For a **one-shot**, add its name to `SFX_EVENTS` and call `sfx?.play('<name>')` from the
     site in `main.js` that already knows the event happened. That is usually next to a `haptic(...)`,
     a `kickShake(...)` or a fare event. It also needs a `minGap` in mix.json (0 for no limit),
     which stops it repeating too quickly.
   - For a **loop**, add its true length to `LOOP_SECONDS` (`afinfo <file>.wav` prints it). That is
     what `loopWindow` uses to guard against AAC padding. Then steer it from `update()` off the
     taxi's state rather than starting it from an event.
   - An **alternate take** of an existing one-shot (a new `_D`) only needs its `FILES` line and a
     place in that sound's `SOUNDS` list. `play()` draws one take per trigger (`pickTake`), at
     random but never the one it played last. A bed has one file, since a loop can't change take
     mid-cycle.
4. **Check it**: `npm run check` (sfx.js is in the `BOOT` list), then `npm run dev`, tap once, and
   make sure `window.__taxi.sfx.state.loaded === window.__taxi.sfx.state.total`.
   `window.__taxi.sfx.play('<name>')` fires a one-shot on demand. Update the tables below.

Git holds each master in full on every revision, so a re-delivered WAV adds its whole size to the
repository's history, not just the difference. That is fine at 31 MB. If the masters ever grow
into the hundreds of MB, move them to Git LFS.

## What plays when

Everything is the **taxi**. Ambient traffic is silent on purpose: twenty-odd engines and blinkers
under a fixed overhead camera would be a wash, and each sound here is feedback about the one car
the player drives.

**Beds** run continuously and are steered every frame by `sfx.update()` from the taxi's state. No
event starts a bed, so no event can leave one stuck on.

| Bed | Driven by |
|---|---|
| Engine idle | Always on. Playback rate 0.9 → 1.35 from standstill to cruise, ducked to a quarter under Loco Mode, faded out when the run ends |
| Loco engine loop | Fades in 6 s into a Loco hold, over the activate's tail, and out on release. Rate rises across the overdrive band |
| Turn signal | Runs while `taxi.signalHand` is set. A new voice starts for each indicating window so it opens on a tick, just as the lamp opens lit. The master ticks every 0.9 s, which is the sim's 1.1 Hz `TURN_SIGNAL_HZ`, so the sound stays in step with the lamp |

**One-shots** fire from the site in `main.js` that already knows the thing happened. Each trigger
draws one of the sound's takes at random, never the same one twice running, so a sound heard
again doesn't repeat the recording exactly:

| Sound | Fires on |
|---|---|
| `locoLaunch` + `locoActivate` | `kickLocoMode`, the frame the pill engages. The activate (05) is 12 s long (level for about 5.5 s, then a tail) and is cut short on release; the launch (07) is the 2.25 s kick on top of it |
| `brake` | The brake pedal from cruise. Also plays at half volume when the taxi's own brake lamp comes on above 2.5 u/s (a red, a queue), so the car isn't silent when it slows by itself |
| `locoBrake` | The brake pedal above 1.1 × cruise |
| `accel` | Pulling away after at least 0.35 s stood still, but not during Loco (the launch covers that) |
| `skid` | The first frame of a boosted corner or an overtake lane swap. Once per slide, not once per rubber stamp |
| `copSkid` | The same takes, for police in a chase: a robbery cop starting to slide (`copLaysRubber` in sim/traffic.js) or the corridor cruiser in the bust chase. Faded by distance from the taxi and silent past about a screen away; its own key so it has its own level and does not spend the taxi's `skid` gap. Its `minGap` of 1s is fleet-wide and is what keeps a chase from squealing constantly: the cops carry speed into nearly every corner (162 of 175 over the probe's six getaways) |
| `doorOpen` → `doorClose` | Pickup (the close is `BOARD_SECONDS` later, once the rider is in) and the robber boarding. Drop-off (the close is 0.7 s later) |
| `takeoff` / `land` | `taxi.hopFrom` turning non-null / `traffic.onTaxiLand`, with the land scaled by the same `hit` that scales the shake |
| `bump` | A survivable hit on another car (`collisions.onBump`), scaled by closing speed: 0.3 at a nudge, full at a T-bone at the Loco top |
| `crash` | The wreck at full volume. The roadworks smash reuses it at half volume, and a crate off the flatbed at 0.3 pitched well up |

`minGap` keeps a sound from repeating too quickly: a second skid within 0.45 s is the same skid.
The per-sound levels live in `mix.json` (below). Block 1 arrives balanced against itself, so every
sound ships at 0 dB, as the designer recommended. The one exception is ours: `copSkid` sits at
−3.7 dB and pitched down a touch, because it is another car somewhere else on screen.

## Gestures, pauses and the phone

- **Nothing can play before a tap.** Every browser keeps an `AudioContext` suspended until the page
  has been touched. The context is created inside the first `pointerdown`/`touchend`/`keydown`
  (Safari only starts one from inside a gesture), and the files are decoded then. The fetches start
  at boot, so the bytes have usually arrived by the time of that first tap.
- **The world stopping stops the sound.** The pause and the robber's line both call
  `sfx.hold(true)`, which suspends the context. A door scheduled to close is on the audio clock, so
  it waits with everything else. A hidden tab suspends it too.
- **iOS**: `navigator.audioSession.type = 'playback'` (Safari 16.4+), so the game plays through
  the silent switch — it carries its own music, not just effects. It stops the player's music
  rather than mixing with it; `'ambient'` did the opposite and left a phone on silent hearing
  nothing. The shell's scheme handler
  serves `.m4a` as `audio/mp4`.
- **Mute** is the "Sound: On/Off" pill on the pause screen, the Sound switch on the title screen's
  Settings, or **M** — one flag, remembered in `localStorage`, soft-failing the way `highscores.js`
  does.
- **The player's volumes** are the two Settings sliders (game/settings.js remembers them,
  `sfx.setVolumes` applies them). SFX scales `master`, under the mix's own `master` and the mute;
  Music scales a separate bus beside it, which nothing feeds yet — the game ships no music. Both
  are squared on the way to the gain node, so the slider's middle sounds like the middle.
- **Shot mode is silent**: `sfx` is `null` there.
- **Offline**: the service worker caches the audio lazily, the same way it caches any `/assets/*`
  request. The file URLs are inside the JS bundle, not in `index.html`, so the install-time
  precache can't see them. A device that has only ever been online for one visit may therefore play
  silently offline. Nothing breaks: each missing file logs one warning and its events stay quiet.

## Tuning the mix: the Audio sections

Every number a sound designer would want to move is in **`assets/audio/mix.json`**, not in code:

| Key | What it is |
|---|---|
| `master` | The whole game's level, under the mute |
| `sounds.<name>.gain` / `.rate` | Per sound, covering all its takes: linear gain, and playback rate (pitch and tempo together). `file` is the designer's name, for reading only |
| `minGap.<name>` | Per one-shot: seconds before it may fire again. 0 is no limit |
| `engine.*` | The beds: idle and Loco pitch at each end of their speed range, how far the idle ducks under Loco, when and how fast the Loco loop comes in, pitch glide and release time constants, the self-brake level, and how long the taxi must stand before pulling away plays `accel`. Each is described at `SHIPPED_MIX` in `sfx.js` |

Open the game with **`?audio`** (or `?debug`, the same panel) and the ⚙️ panel's **Audio**,
**Engine sound**, **Sounds** and **Audio export** sections have every one of those as a live slider,
levels in dB and pitch in semitones. It used to be a separate 🔊 panel so the designer was not
scrolling past the sun; collapsed sections and the panel's search do that job now (type a sound's
name to jump to it).

- **▶** on each sound plays it once at its current level and pitch, loops included. A sound with
  variants plays a different take each press, the way the game does, and the label says which
  letter it played. **■ Stop previews** cuts them (the Loco activate is 12 s). The engine beds are
  heard by driving.
- Double-click a slider to put that one knob back. A yellow edge marks a sound that differs from
  the shipped mix.
- Edits are kept in `localStorage` (`simtaxi.audio.v2`; v1 held the test files' mix) across reloads, since a crash and Retry is
  a reload. The stash is only read by these sections, which only exist with the ⚙️ panel, so a
  half-finished mix never reaches a normal session. **Reset to shipped mix** clears it.
- **Download mix.json** saves the whole mix; **Open file…** or **Apply pasted** loads one back.
  An import replaces the mix outright, and anything unknown or out of range in it is dropped or
  clamped by `sfx.tune`.

**Shipping a mix** is dropping the downloaded file over `assets/audio/mix.json` and committing it.
`npm run check` verifies the file names every knob the code reads.

The panel only reaches what `sfx.js` owns. A few call sites in `main.js` scale a one-shot again
where they fire it: `bump` at a gain set by closing speed, the roadworks smash is `crash` at 0.5
and 1.25, a flatbed crate is `crash` at 0.3 and 1.6, and `land` scales with the impact. Those stay in code.

## Checking it

`window.__taxi.sfx.state` reports `{ ready, loaded, total, muted, held }`. `loaded` should equal
`total` (41) after the first tap. `window.__taxi.sfx.play('crash')` fires any one-shot by name, and
`tuning()`, `tune(partial)` and `reset()` reach the same mix the Audio sections edit. The
module is in check.mjs's `BOOT` list, which proves it imports cleanly in node, where it builds a
no-op.
