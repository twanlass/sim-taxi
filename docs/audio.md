# Audio

The taxi's sound: engine, Loco Mode, doors, crash, jump and blinker. This is the **one part of the
game loaded from files**: the recordings are a sound designer's, and everything else, including
every mesh and the one texture, is still generated in code.

| File | Owns |
|---|---|
| `src/game/sfx.js` | The context, loading, the beds, the one-shots, mute |
| `assets/audio-src/*.wav` | The designer's masters, committed, never shipped |
| `assets/audio/*.m4a` | The shipped files, one per master |
| `tools/audio.mjs` | WAV masters → AAC |
| `src/main.js` | Every call site: `sfx?.play(...)` next to the matching `haptic(...)` |

## The files

The masters are 48 kHz / 24-bit stereo WAV, 16.6 MB for the first delivery of seventeen. They are
**committed** under `assets/audio-src/`, so re-encoding never depends on a copy in somebody's
Downloads folder. Nothing in `src/` references them, so Vite never ships them: the bundle only
contains what a `new URL(...)` in `sfx.js` names. What ships is AAC at 128 kbps in an `.m4a`,
769 kB for the set, about 21× smaller. That format plays natively everywhere the game
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

File names stay as the designer's, so a re-delivery drops straight in. `FILES` in `sfx.js` maps
them to what the game calls them, and each entry is a **literal** `new URL(..., import.meta.url)`.
That is what makes Vite fingerprint and emit them into `dist/assets/`. A URL built from a variable
is one Vite cannot see, so it will not ship.

Measured bitrates for the set: 64 kbps is 468 kB, 96 kbps is 652 kB, 128 kbps is 800 kB. 128 was
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
   - Add it to `FILES`, as a **literal** `new URL('../../assets/audio/<name>.m4a', import.meta.url).href`.
     Don't build the path from a variable, or Vite won't ship the file.
   - Give it a `TRIM` (its volume in the mix). Measure it against the files already there rather
     than guessing: the first delivery's idles and Loco loop sit at about −25 dB RMS, and most
     one-shots peak at about −7 dB.
   - For a **one-shot**, add its name to `SFX_EVENTS` and call `sfx?.play('<name>')` from the
     site in `main.js` that already knows the event happened. That is usually next to a `haptic(...)`,
     a `kickShake(...)` or a fare event. A `MIN_GAP` entry stops it repeating too quickly.
   - For a **loop**, add its true length to `LOOP_SECONDS` (`afinfo <file>.wav` prints it). That is
     what `loopWindow` uses to guard against AAC padding. Then steer it from `update()` off the
     taxi's state rather than starting it from an event.
   - An **alternate take** of an existing sound (like the `_01/_02/_03` idles) can join the
     `rng.pick([...])` for that sound, so each run gets one.
4. **Check it**: `npm run check` (sfx.js is in the `BOOT` list), then `npm run dev`, tap once, and
   make sure `window.__taxi.sfx.state.loaded === window.__taxi.sfx.state.total`.
   `window.__taxi.sfx.play('<name>')` fires a one-shot on demand. Update the tables below.

Git holds each master in full on every revision, so a re-delivered WAV adds its whole size to the
repository's history, not just the difference. That is fine at 17 MB. If the masters ever grow
into the hundreds of MB, move them to Git LFS.

## What plays when

Everything is the **taxi**. Ambient traffic is silent on purpose: twenty-odd engines and blinkers
under a fixed overhead camera would be a wash, and each sound here is feedback about the one car
the player drives.

**Beds** run continuously and are steered every frame by `sfx.update()` from the taxi's state. No
event starts a bed, so no event can leave one stuck on.

| Bed | Driven by |
|---|---|
| Engine idle (one of three per run) | Always on. Playback rate 0.9 → 1.35 from standstill to cruise, ducked to a quarter under Loco Mode, faded out when the run ends |
| Loco engine loop (one of two per run) | Fades in 6 s into a Loco hold, over the activate's tail, and out on release. Rate rises across the overdrive band |
| Turn signal | Runs while `taxi.signalHand` is set. A new voice starts for each indicating window so it opens on a tick, just as the lamp opens lit. The master ticks every 0.9 s, which is the sim's 1.1 Hz `TURN_SIGNAL_HZ`, so the sound stays in step with the lamp |

**One-shots** fire from the site in `main.js` that already knows the thing happened:

| Sound | Fires on |
|---|---|
| `locoLaunch` + `locoActivate` | `kickLocoMode`, the frame the pill engages. The activate is 11.5 s long (a sustained 7 s, then a tail) and is cut short on release |
| `brake` | The brake pedal from cruise. Also plays at half volume when the taxi's own brake lamp comes on above 2.5 u/s (a red, a queue), so the car isn't silent when it slows by itself |
| `locoBrake` | The brake pedal above 1.1 × cruise |
| `accel` | Pulling away after at least 0.35 s stood still, but not during Loco (the launch covers that) |
| `skid` | The first frame of a boosted corner or an overtake lane swap. Once per slide, not once per rubber stamp |
| `doorOpen` → `doorClose` | Pickup (the close is `BOARD_SECONDS` later, once the rider is in) and the robber boarding. Drop-off (the close is 0.7 s later) |
| `takeoff` / `land` | `taxi.hopFrom` turning non-null / `traffic.onTaxiLand`, with the land scaled by the same `hit` that scales the shake |
| `crash` | The wreck at full volume. A bump reuses it, scaled by closing speed and pitched up a touch; the roadworks smash reuses it at half volume |

`MIN_GAP` keeps a sound from repeating too quickly: a second skid within 0.45 s is the same skid.
The per-file mix lives in `TRIM`. The masters arrive already balanced against each other, with one
exception: idle 2 is the thin, bright variant and measures 10 dB below the other two, so its trim
makes up the difference.

## Gestures, pauses and the phone

- **Nothing can play before a tap.** Every browser keeps an `AudioContext` suspended until the page
  has been touched. The context is created inside the first `pointerdown`/`touchend`/`keydown`
  (Safari only starts one from inside a gesture), and the files are decoded then. The fetches start
  at boot, so the bytes have usually arrived by the time of that first tap.
- **The world stopping stops the sound.** The pause and the robber's line both call
  `sfx.hold(true)`, which suspends the context. A door scheduled to close is on the audio clock, so
  it waits with everything else. A hidden tab suspends it too.
- **iOS**: `navigator.audioSession.type = 'ambient'` (Safari 16.4+), so the game mixes with the
  player's music instead of stopping it, and respects the silent switch. The shell's scheme handler
  serves `.m4a` as `audio/mp4`.
- **Mute** is the "Sound: On/Off" pill on the pause screen, or **M**. It is remembered in
  `localStorage`, soft-failing the way `highscores.js` does.
- **Shot mode is silent**: `sfx` is `null` there.
- **Offline**: the service worker caches the audio lazily, the same way it caches any `/assets/*`
  request. The file URLs are inside the JS bundle, not in `index.html`, so the install-time
  precache can't see them. A device that has only ever been online for one visit may therefore play
  silently offline. Nothing breaks: each missing file logs one warning and its events stay quiet.

## Checking it

`window.__taxi.sfx.state` reports `{ ready, loaded, total, muted, held }`. `loaded` should equal
`total` (17) after the first tap. `window.__taxi.sfx.play('crash')` fires any one-shot by name. The
module is in check.mjs's `BOOT` list, which proves it imports cleanly in node, where it builds a
no-op.
