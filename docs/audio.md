# Audio

The taxi's sound: engine, Loco Mode, doors, bump, crash, jump and blinker — and the radio. This is the **one part of the
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
| Engine idle | On from **Play** to the end of the run — silent under the title menu, as are the pull-away, takeoff and blinker (`menu` in `sfx.update`). Playback rate 0.9 → 1.35 from standstill to cruise, ducked to a quarter under Loco Mode, faded out when the run ends |
| Loco engine loop | Fades in 6 s into a Loco hold, over the activate's tail, and out on release. Rate rises across the overdrive band |
| Police siren | Always running, silent until a car on the map has `siren` set (a patrol giving chase, a robbery's cops, the arrest crew). Its level comes from the nearest one's distance to the taxi (`sirenLevel` in main.js): full inside 18 units, easing to a floor of 0.35 by 70, so a chase across the map is still heard. Faded out when the run ends |
| Turn signal | Runs while `taxi.signalHand` is set. A new voice starts for each indicating window so it opens on a tick, just as the lamp opens lit. The master ticks every 0.9 s, which is the sim's 1.1 Hz `TURN_SIGNAL_HZ`, so the sound stays in step with the lamp |

**One-shots** fire from the site in `main.js` that already knows the thing happened. Each trigger
draws one of the sound's takes at random, never the same one twice running, so a sound heard
again doesn't repeat the recording exactly:

| Sound | Fires on |
|---|---|
| `locoLaunch` + `locoActivate` | `kickLocoMode`, the frame the pill engages. The activate (05) is 12 s long (level for about 5.5 s, then a tail) and is cut short on release; the launch (07) is the 2.25 s kick on top of it |
| `brake` | The brake pedal from cruise. Nothing else: a tyre sound means rubber on the road, so the taxi slowing on its own (a red, a queue, the coast down after letting go of Loco) is silent. It used to play off the brake lamp, which lit on the post-Loco coast and screeched on every release |
| `locoBrake` | The brake pedal above 1.1 × cruise |
| `accel` | Pulling away after at least 0.35 s stood still, but not during Loco (the launch covers that) |
| `skid` | The first frame of a boosted corner or an overtake lane swap. Once per slide, not once per rubber stamp |
| `copSkid` | The same takes, for police in a chase: a robbery cop starting to slide (`copLaysRubber` in sim/traffic.js) or the corridor cruiser in the bust chase. Faded by distance from the taxi and silent past about a screen away; its own key so it has its own level and does not spend the taxi's `skid` gap. Its `minGap` of 1s is fleet-wide and is what keeps a chase from squealing constantly: the cops carry speed into nearly every corner (162 of 175 over the probe's six getaways) |
| `doorOpen` → `doorClose` | Pickup (the close is `BOARD_SECONDS` later, once the rider is in). The robber boarding opens the door and slams it when their line is dismissed: the line's freeze suspends the audio context on the frame the close would start, which cut it to a blip (`robberDoorOpen` in `src/main.js`). Drop-off (the close is 0.7 s later) |
| `takeoff` / `land` | `taxi.hopFrom` turning non-null / `traffic.onTaxiLand`, with the land scaled by the same `hit` that scales the shake |
| `bump` | A survivable hit on another car (`collisions.onBump`), scaled by closing speed: 0.3 at a nudge, full at a T-bone at the Loco top. Also the taxi knocking a spilt crate on (game/boxspill.js), at 0.18 |
| `driveThru` | The lot taking the player's taxi on a burger run (`burgerRun.holdsTaxi()` turning true), never an ambient car. The visit is timed to the clip (12.93 s, `DRIVE_THRU_SECONDS`) plus a 2 s tail (`DRIVE_THRU_TAIL`) through the taxi's two dwells in game/drivethru.js, and the probe holds the visit within half a second of that; it is faded out (`sfx.release`) on the frame the lot hands the taxi back. The radio ducks 12 dB for the length of it (`sfx.duckMusic`) |
| `crash` | The wreck at full volume. The roadworks smash reuses it at half volume, and a crate off the flatbed at 0.3 pitched well up |
| `horn` | A tap on the taxi itself, with the select-pop flash. New players coming from RTS games tap their own car first, expecting to select it; this answers the tap without inventing a selection state. Not during the opening, where that tap is the skip. The master (`18_HORN_honk`, 48 kHz / 16-bit, Tyler, October 2026) arrived at −10.5 LUFS and a +0.2 dBFS peak, 11 dB hotter than a crash, so it ships at gain 0.3 (about −21 LUFS, level with the crash). It was encoded with ffmpeg's AAC rather than afconvert, from a cloud session with no Mac; re-running `tools/audio.mjs` replaces it harmlessly |

`minGap` keeps a sound from repeating too quickly: a second skid within 0.45 s is the same skid.
The per-sound levels live in `mix.json` (below). Block 1 arrives balanced against itself, so every
sound ships at 0 dB, as the designer recommended. The exceptions are ours: `copSkid` sits at
−3.7 dB and pitched down a touch, because it is another car somewhere else on screen; and the
drive-through speaker (October 2026, not the designer's, converted from an MP3 to a 48 kHz WAV
master) arrived hotter than Block 1, so it is levelled to it. Measured as RMS off the master
(ffmpeg was not to hand; RMS reads the idle at −34.3, matching its −34 LUFS), it is −22.5 dB. The
siren was once our own stand-in too (`16_POLICE_siren_loop`, −10.1 dB, shipped at 0.18); Block 2's
`25_NPC_siren_loop` replaced it and ships at 0 dB.

## Block 2: the city

Block 2 (Nicolás, October 2026) is the city around the taxi rather than the taxi, plus the radio's
songs. The **final** delivery (*sim-taxi_block-2_final_v1*: 31 effects, 82 MB of masters, 4.6 MB
shipped; 4 songs, 51 MB, 2.9 MB) replaced a demo of the same sounds, keeping its names where a
sound stayed one file. The four `_preview` songs in it are the same mixes at −14 LUFS "for
listening only" and are not committed. His sheet numbers restart at 16, so his 17 and 18 (gate,
bridge) share numbers with our `17_BURGER_drive_through` and `18_HORN_honk`; the names differ,
which is all `FILES` reads.

What the final delivery settled, against the demo: construction, seagulls and the court are **mono
only** ("after testing in the game"); the birds are two intensities of three takes, strong for the
flock scattering and soft for it landing, where the demo's three files were a PICK; the chirp is
two short and two long takes, all four drawn at random; spawn has three takes and angry six; and
the city bed is the 21 s `19_AMB_city_loop_B_ST` alone. It came as two loops, A and B, and played
them end to end as one 42 s loop until his October 19 mix, which dropped A ("B works much better
right now"). Rain still comes both ways, to try in the mix.

- **PICK sounds** (`PICKED` in sfx.js): where he sent alternatives, the files are not random takes.
  `mix.sounds.<key>.pick` names the one that plays, and the ⚙️ panel switches it live (a bed swaps
  file the next frame). Only `rain` is one now, stereo or mono. Once a choice is made, drop the
  loser from the delivery and the key from `PICKED`.
- **PLACED sounds** (`PLACED`): heard from a point. `mix.place.<key>` is `{ near, far }` in world
  units (a block is 20): full level inside `near`, squared falloff, silent past `far`. Each is
  panned by where the point sits across the screen (`StereoPannerNode`, never wider than
  `PAN_WIDTH`). **The listener is the middle of the screen** (`controller.state.target`, `placeAt`
  in main.js), not the taxi, so panning over to the court brings it up; in play the camera follows
  the taxi, so the two barely differ. The siren and the cop squeal still measure from the taxi.
  The panel's **Full within** / **Silent past** sliders move the falloff, and while the ⚙️ panel is
  open the sound last touched in it (highlighted) draws its zones on the ground at each of its
  sources (game/soundrings.js): an orange disc where it is at full level, a blue band where it runs
  out, and a white dot and 👂 at the listener. Drag the orange or blue handle on the ring's edge
  to resize it directly. In debug mode the map drags on a desktop too, so the listener can be put
  anywhere, and each placed sound (plus the drive-through) has a 🔊 pin whose chip opens the panel
  on it. The selection, and its rings, stay put while the map is dragged around; picking another
  sound moves it, and **Esc** lets it go (that Esc does not also pause the game).
- **Stereo** is a switch on every sound: live on rain, the one delivered both ways; on and greyed
  where there is only a stereo cut, off and greyed where there is only a mono one.
- **Replace…** on any sound plays local files in its place for the session (nothing is saved).
  Several files are a variant set: a one-shot draws one per trigger, never the same twice running;
  a loop plays one, chosen from a menu.

| Sound | File(s) | Plays | Hook |
|---|---|---|---|
| `spawn` | 16 A–C | Once per entrance, the city building itself (the wave) | first frame of `cityEntry.running()` with a context and a decoded take; re-armed by a replay. **Not heard under the title screen**, which settles the entrance before anything can be tapped |
| `gate` | 17 | The depot's roller door at the start of a run | `opening.phase()` going `settle` → `door` |
| `bridge` | 18 | The whole drawbridge cycle, from the barriers starting down | `drawbridge.state.phase` → `closing`; steered for 26 s, faded out (τ 0.15 s) the frame the gates start back up (`raising`) |
| `city` | 19 B | Bed, everywhere, always | — |
| `construction` | 20 MONO | Bed at the roadworks' closed block while it stands, faded with it | `roadwork.state` |
| `birdsUp` / `birdsDown` | 21 strong A–C / soft A–C | A pigeon flock scattering / the last of it landing | `flock.state.flights` / `.landings` |
| `plane` | 22 | The light aircraft, started 1.4 s into its run to centre on the pass, steered | `flyover.state.flights` |
| `heli` | 23 | The rooftop chopper's visit, steered, faded when it is gone | `chopper.state.visits` |
| `angry` | 24 A–F | A rider storming off (the swearing bubble); the bystander the robber shoves | fare `missed` / `vip-missed` / `robber-missed`; `game/bankjob.js` |
| `siren` | 25 | The existing siren bed, now on Block 2's recording (our old stand-in, 16, is gone) | — |
| `seagulls` | 29 MONO | Bed at the nearest barge carrying gulls | `boats.boats` |
| `rain` | 30 ST / MONO | Bed, the rain at the taxi (`squall.rainNear`, or the storm's `rain`) | — |
| `court` | 31 MONO | Bed at the basketball court, where the city has one | `props.court` |
| `chirp` | 32 short A·B, long A·B | A patrol spotting the taxi and lighting up | `patrol` `onSpotted` |

### The boom box

The boom box beside the basketball court ([city.md](city.md#a-basketball-court)) bounces and puts
out notes but has **no sound yet**. It is built to take a track: `boombox.emitter` is where the
music plays from, and the comment in `ambientLevels` (main.js) shows the line that places a bed
there, beside the court's own. Add it as a bed keyed like `court` (FILES, SOUNDS, PLACED, LOOPS,
AMBIENT, LOOP_SECONDS), then set `BPM` in `game/boombox.js` to the track's tempo and pass the bed's
playback time to `boombox.update(dt, musicTime)` so the bounce lands on the track's beat rather than
the box's own clock.

The hooks follow the designer's sheet (*sim-taxi audio script, Block 2*), which names each trigger:
spawn is "buildings appear when the map is generated", the gate "opens and closes as the taxi leaves
the garage", angry is a passenger who "shouts at the taxi". Two are the nearest event the game has
rather than the one he describes: the chirp is for police who "flick the siren on for a moment",
which no cop does yet, so it plays as a patrol lights up to give chase; and the birds are written as
a flock "taking off and passing", so take-off is their main use and landing is ours.

Every Block 2 level is 0 dB: the delivery note puts the effects' peaks between −25 and −6 dBFS,
"balanced relative to each other and to Block 1". The police helicopter keeps its synthesised
rotor; 23 is the rooftop chopper.

The final delivery was encoded with ffmpeg's AAC (128 kbps, `-fflags +bitexact`) from a cloud
session with no Mac, as the horn was. Those files carry ffmpeg's 1024 frames of priming in an edit
list rather than afconvert's 2112; a decoder that honours the edit list (ffmpeg, so Chrome) hands
back the true length plus at most one frame of end padding, which `loopWindow` reads as no
priming at all and loops correctly. Re-running `tools/audio.mjs` on a Mac replaces them with
afconvert's encode.

## The radio

The music is a car radio, the station KPRS. The **title menu** has no music at all: the first tap
unlocks the effects (the menu's taps, the logo, the city's beds; nothing of the taxi's, which waits for Play too) and decodes the station in the background, but the
radio stays off until **Play**, so the music arrives as the payoff for starting a run (Tyler, October
2026). `?titlemusic=classic` brings back the menu's songs: the first tap starts one at random, more
follow back to back (no ads, no ID) for as long as the menu is up, and Play cuts it (60 ms down).
**Play** opens the station on `MUSIC_radio_intro` (6.3 s; it replaced
a 15 s one in October 2026), the announcer's "beautiful day in this concrete jungle", then a hard cut to one of four songs at random, and at the end of each a fresh pick, never the
song that just played. The songs are Nicolás's, written for the station (Block 2, October 2026):
`26_MUS_rolling` (funk), `27_MUS_upbeat` (funk with vocals), `28_MUS_hiphop` and `33_MUS_indiepop`,
40 to 50 s each with short intros and clean endings. They replaced four 30 s songs
(`MUSIC_country`, `MUSIC_jazz`, `MUSIC_rock`, `MUSIC_funk`), deleted in October 2026: their source
was never recorded, and `?songs=classic` kept them in the App Store build behind a flag the app has
no way to set. Between songs the station talks:

- **An ad break every 2 songs** (`RADIO.adEvery`): `RADIO_break_in` (the tee-up), one of three ads
  (`RADIO_ad_earls`, `RADIO_ad_le_barge`, `RADIO_ad_loco_juice`) at random and never the last one,
  then `RADIO_break_out` back into the music. A break with no ad decoded is skipped whole.
- **The station ID every 3 songs** (`RADIO.idEvery`, `RADIO_station_id`). Every sixth song both fall
  due, and the ID follows the break rather than splitting it.

So the hour runs: intro, song, song, *break*, song, *ID*, song, *break*, song, song, *break*, *ID*, …
Under `?titlemusic=classic` the menu's song is never the first song after the intro. Play again reloads past the title screen,
so that run goes straight to the intro on its first tap, as do `?title=off` and `?dev`. Before
October 2026 the station went on the air on the first tap anywhere, so the intro played under the
menu and was usually over by the time the run began; `?menumusic=classic` keeps that. Between then
and the silent menu, the menu played songs alone until Play (#519); `?titlemusic=classic` keeps that.
`__taxi.sfx.state.radio` lists the last few items scheduled.

It lives in `sfx.js` beside the effects (`RADIO`, `RADIO_FILES`, `startRadio`) but outside
`FILES`/`SOUNDS`/the mix: it plays into the **music bus**, so the Music slider and the mute steer
it and the effects slider does not. Two tracks are always scheduled on the audio clock (the one
playing and the next), so each change is sample-exact rather than waiting on `onended`, and a
pause stops it mid-song with the rest of the context. Each track is played for its master's true
length (`RADIO.seconds`), the same AAC-priming guard as `loopWindow`.

When the game-over screen appears the music bus fades to silence over 1.5 s (`fadeOutMusic`,
`MUSIC_FADE_OUT`); effects carry on. It is latched, so moving the Music slider on that screen does
not bring it back. Retry and Quit both reload the page, so the next run opens on the intro as usual.

Levels (`RADIO.gain`) bring every track to −24 LUFS at full slider. The first four were measured
off the masters with ffmpeg's `ebur128`: they arrived at −13.5 (country), −12.3 (jazz) and −10.8
(rock), and a since-replaced intro at −17.3, against −34 for the engine idle and −22 for a crash.
The October additions were levelled by **RMS** instead, ffmpeg not being to hand: the older tracks'
RMS plus their gain lands at −26.7 dB RMS on average, and each new one is brought to that. Re-measure
them with ebur128 when it is available. Nicolás's songs were measured with ebur128 at −17.8 to
−18.3 LUFS (his delivery says −18) and are brought down about 6 dB each. What the station plays is
about 3.6 MB of `.m4a`, the biggest download in the game, and decodes to roughly 85 MB of PCM, held
for the session: his songs run 40 to 50 s against the old 30, which is 25 MB more of it.

The ads and the stings arrived as MP3s and 44.1 kHz WAVs from Tyler; they were converted to 48 kHz
16-bit stereo WAV masters (afconvert) so they encode like everything else.

They are encoded by `tools/audio.mjs` like every other sound. afconvert on macOS 26.6 does not
reproduce the Block 1 files byte for byte (17 of 41 differ, mostly at the same size), so commit
only the .m4a files whose masters changed.

### Talking over the music

The station talks over the edges of the songs the way a DJ does (`RADIO_FADE` in `sfx.js`;
`?radiofade=classic` cuts hard between every track):

- **Into a song**: after the intro, the sting out of an ad break or the station ID, the next song
  starts 1 s into the voice, 6 dB down, and rises to full over the voice's last second.
- **Over a song's end**: the tee-up into an ad break and the station ID start 2 s before the song
  ends, and the song dips 6 dB under them over 0.4 s and plays its last bars out there. The songs all
  have clean endings, so the voice lands on them rather than on a cut.

The ads keep their hard edges either side, being produced pieces of their own. A track that decoded
too late to overlap simply follows.

**Each game opens on a different song.** The songs that opened the last session (the first song
after the intro, and under `?titlemusic=classic` the title menu's first song too) are remembered in `localStorage`
(`simTaxi.openingSongs`), and this session's first picks avoid them while there is another to play.

### The dash radio

From **Play** the station sounds as if it is coming from a cheap AM set in the taxi, and it **opens
out into the full mix as the car rolls out of its garage** in the
[opening vignette](gameplay.md#the-opening-vignette): the film move from music playing in the scene
to music playing over it. The menu is silent, so Play is also the moment the radio comes on, and
it comes on in the car. The in-car end is crushed hard on purpose, because the reveal is only as big as the distance
between the two ends (`DASH` in `sfx.js`):

- **Band**: high-pass at 700 Hz, an 8 dB bump at 1.4 kHz, low-pass at 2 kHz, both pass filters
  ringing a little. Narrower than a car speaker, closer to AM.
- **Mono**, so the stereo opening out is part of the reveal.
- **Crushed**: driven into a tanh clip quantised to 32 levels a side (about 6 bits), then brought
  down so a song in the car sits about 4 LU under the same song open, and the open swells as well
  as brightens.
- **Static**: six seconds of generated hiss with crackles and the odd pop, looped into the same
  speaker, about 12 dB under the music.

The announcer talks **over** the first song ([talking over the music](#talking-over-the-music)), so
the song is in the dash from a second after Play. Played one after the other, the 6.3 s intro filled
the whole in-car stretch and the crush was only ever heard on a voice. The vignette holds its shot of the car in the open
doorway (the `reveal` beat) until that song has played through the dash for 4 s (`DASH.music`,
`holdReveal` in `opening.js`, at most 8 s), so the car rolls out and the sound opens up as the
announcer signs off.
On the `roll` beat (`DASH_PHASES` in `main.js`) `openDash` runs the reveal over 3 s: the
filters sweep to transparent (exponentially on the frequencies, so the octaves open at an even pace;
open is 10 Hz, Nyquist and 0 dB), the crushed mono path crossfades into the clean stereo one, and the
static is gone in the first 1.5 s. A skip, `?vignette=off` or a city with no depot opens it
on the next frame. Only the station goes through it: the ⚙️ panel's track previews play past it.
`?radiointro=classic` keeps the station full-range from Play.

## Gestures, pauses and the phone

- **Nothing can play before a tap**, the startup screen's sting in the iOS app aside: it runs on a
  context of its own (`game/splashsound.js`, see [gameplay.md](gameplay.md#the-startup-screen)).
  Every browser keeps an `AudioContext` suspended until the page has been touched. The context is created inside the first `pointerdown`/`touchend`/`keydown`
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
  Music scales a separate bus beside it, which the radio plays into. Both
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
| `buses.master.gain` | **Master**: everything, music and effects, after the two buses below. The peak meter reads after it |
| `master` | The **SFX** bus: every effect, under the player's SFX slider and the mute. Named before there was a Master over it |
| `buses.player.gain` / `buses.world.gain` | The two buses inside SFX: **Player** (Engine & Loco, Taxi, Impacts) and **World** (City events, Ambience, People, Police) |
| `sounds.<name>.gain` / `.rate` | Per sound, covering all its takes: linear gain, and playback rate (pitch and tempo together). `file` is the designer's name, for reading only |
| `minGap.<name>` | Per one-shot: seconds before it may fire again. 0 is no limit |
| `groups.<group>.gain` | Per mix group (`GROUPS` in `sfx.js`): a gain node every sound in the group passes through on its way to its bus |
| `music.master` / `music.tracks.<track>.gain` | The radio's level as a whole, and a trim per track on top of its measured `RADIO.gain` (so 1 is the shipped -24 LUFS). The **Music** section edits them, with ▶ to preview a track and Replace… to try a local file in its place |
| `engine.*` | The beds: idle and Loco pitch at each end of their speed range, how far the idle ducks under Loco, when and how fast the Loco loop comes in, pitch glide and release time constants, and how long the taxi must stand before pulling away plays `accel`. Each is described at `SHIPPED_MIX` in `sfx.js` |

Open the game with **`?audio`** (or `?debug`, the same panel; or `?dev`, which also skips the title
and the opening straight into a run; the ⚙️ button is bottom right) and
the ⚙️ panel's **Audio** (the mixer's buses and the peak meter), **Engine sound**, **Sounds**, **Music** and
**Audio export** sections have every one of those as a live slider,
levels in dB and pitch in semitones. It used to be a separate 🔊 panel so the designer was not
scrolling past the sun; collapsed sections and the panel's search do that job now (type a sound's
name to jump to it).

- **▶** on each sound plays it once at its current level and pitch, loops included. A sound with
  variants plays a different take each press, the way the game does, and the label says which
  letter it played. A sound with a pin on the map (the court, the gate, the gulls…) plays **from
  its pin, heard from the 👂**, with the falloff and pan the game would give it, updated live as the
  rings are dragged or the 👂 pans, so a ▶ outside its rings is silent. **Shift-▶** plays the raw file. **■ Stop previews** cuts them (the Loco activate is 12 s). The engine beds are
  heard by driving.
- The mix is a tree of buses, Nicolás's layout (October 2026; `BUSES` and `GROUPS` in `sfx.js`):

  ```
  Master ─┬─ Music ── the radio's tracks
          └─ SFX ──┬─ Player ── Engine & Loco, Taxi, Impacts
                   └─ World ─── City events, Ambience, People, Police
  ```

  Every bus and group is a real gain node, and its **Level** ships in mix.json. The **Audio**
  section has the five buses, indented by depth; the groups head the **Sounds** section, each
  folding to its header (all start folded, and a search shows matches inside folded ones). Every
  fader's bottom stop is **-∞**, not a quiet level (`FLOOR` in `audiopanel.js`, -60 dB and under
  is a gain of 0).
- **M** and **S** sit on every bus, group, sound and track, for listening only: never stashed or
  exported, gone on a reload (**Clear mutes and solos** resets them). **S** is exclusive: it solos
  that one thing in place of whatever was soloed before, and shift-click adds to the solos
  instead. The rule is a DAW's
  (`monitorPass` in `sfx.js`): a mute silences that node and what runs through it; while anything
  is soloed, only what is soloed, what is under it, and the path down to it can be heard. Whatever
  is silenced is dimmed. A sound's M/S is a gain node per sound between its voices and its group;
  a track's rides its own gain (`police` also carries the synthesised rotor, as an unlisted node
  `rotor`).
- The **peak meter** on Master reads the sample peak per channel in dBFS (`meter()` in `sfx.js`:
  two analysers behind a splitter, made the first time the panel reads them, and a tap off the
  side of the chain, so nothing heard changes). The bars fall back at 24 dB/s, the white tick holds
  each channel's highest peak for 1.5 s, and the readout keeps the highest peak since the meter was
  last clicked, with **CLIP** at -0.1 dBFS and over. True peak and loudness are not measured.
- **⚡** on a rare sound makes the thing happen in the game, so it is heard placed and steered as
  in play rather than dry: `plane` sends the flyover across, `heli` brings the rooftop chopper in,
  `birdsUp`/`birdsDown` scatter the flock nearest the taxi (the landing follows), `bridge` raises
  the drawbridge, `spawn` replays the city entrance, and `angry` (the passenger walking off, files
  `24_NPC_angry_A`–`F`) stands a rider on one fixed kerb corner (the usable one nearest the middle
  of the map, `demoBail` in `game/fares.js`) who storms off with the purple curse bubble while the
  camera peeks at them, the sound played as heard from there. They are
  `soundTriggers` in main.js, the same `launch`/`visit`/`takeOff`/`request` shot mode stages with.
  A placed sound still falls off with distance, so drive near the plane path or the helipad to
  hear it (the 🔊 pins show where).
- **⏸** on `plane`, `heli` and the birds freezes that one source where it is (its own update
  skipped, so the taxi and the city carry on) with its sound **looping** and steered off it, so a
  falloff can be tuned by driving to and from something that stays put. Holding one that is not in
  the air sends it up first: the plane to the middle of its run, the chopper onto its pad, the
  nearest flock a second into its climb. Pressed again, the plane and chopper play the loop out
  and carry on. `holds` in main.js.
- Double-click a slider to put that one knob back. A yellow edge marks a sound that differs from
  the shipped mix.
- Edits are kept in `localStorage` (`simtaxi.audio.v2`; v1 held the test files' mix) across reloads, since a crash and Retry is
  a reload. The stash is only read by these sections, which only exist with the ⚙️ panel, so a
  half-finished mix never reaches a normal session. **Reset to shipped mix** clears it.
- **Download mix.json** saves the whole mix; **Open file…** or **Apply pasted** loads one back.
  An import replaces the mix outright, and anything unknown or out of range in it is dropped or
  clamped by `sfx.tune`.

- **🖥 | 📱** beside the panel's search frames the window to a phone in portrait (393 × 852,
  `game/phoneframe.js`), remembered per browser. It is a mask rather than a smaller canvas, and
  exact: the camera's zoom is a frustum half-height in world units on every device, so a phone sees
  the same height of city and less of it across, centred on the same 👂. Placed sounds are panned
  against the frame's edges instead of the window's (`panScale`), and the HUD moves inside it (the
  root's `--safe-left`/`--safe-right` become the frame's margins).
- In debug mode every placed sound on the map wears a **🔊 pin** (`game/soundpins.js`): tap one and
  the panel opens on that sound's controls, with its falloff rings on the ground. Sounds sharing a
  spot share a pin, with a chip each. Hovering a control in the panel or a pin shows its tooltip at
  once rather than after the browser's one-second wait (`game/quicktips.js`, debug only).

**Shipping a mix** is dropping the downloaded file over `assets/audio/mix.json` and committing it.
`npm run check` verifies the file names every knob the code reads.

The panel only reaches what `sfx.js` owns. A few call sites in `main.js` scale a one-shot again
where they fire it: `bump` at a gain set by closing speed, the roadworks smash is `crash` at 0.5
and 1.25, a flatbed crate is `crash` at 0.3 and 1.6, and `land` scales with the impact. Those stay in code.

## Checking it

`window.__taxi.sfx.state` reports `{ ready, loaded, total, muted, held }`. `loaded` should equal
`total` (74) after the first tap. `window.__taxi.sfx.play('crash')` fires any one-shot by name, and
`tuning()`, `tune(partial)` and `reset()` reach the same mix the Audio sections edit. The
module is in check.mjs's `BOOT` list, which proves it imports cleanly in node, where it builds a
no-op.
