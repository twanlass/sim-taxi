# Audio

**Main files:** `src/game/sfx.js`, the wiring block in `src/main.js`, `tools/sfx.mjs`

Every sound in the game is synthesised at runtime — oscillators, one buffer of white noise generated
in code, filters and envelopes. There is no `.wav`, no loader and no decode step, which is the same
rule [every mesh in the project follows](README.md#conventions-worth-knowing-before-editing). The
whole audio layer is one module and it adds nothing to the bundle but its own source.

## The shape of it

`game/sfx.js` exports one factory and one pure function. Everything else about it is private.

```js
const sfx = createSfx();          // builds nothing — no AudioContext yet
sfx.unlock();                     // from a gesture: this is what creates the context
sfx.play('dropoff', { streak: 7 });
sfx.update(dt, { locoOn, speed, sirenAt, hunting });   // the two held voices, once a frame
sfx.setMuted(true);
```

**Named events, not parameters.** A caller says `sfx.play('pickup')` and the module decides what a
pickup sounds like — the same contract `util/haptics.js` has, for the same reason: the bank can be
retuned in one place without touching a call site. `SOUNDS` is a closed set and an unknown name
throws here rather than going quietly missing on somebody's phone.

**`main.js` owns the wiring and nothing else.** Which event makes which noise is one block up there,
and nearly every `sfx.play` in it sits beside a `haptic()` that was already on that line. No system
below `main.js` knows this module exists — `fares.js` reports that a clock stepped down a colour and
has no opinion about whether that makes a sound.

## The bank

| Sound | Fired by | What it is |
|---|---|---|
| `pick` | a tap that re-aimed the taxi | the shortest thing in the bank — 70ms, no tail |
| `spawn` | a rider appears on the board | a soft two-note bell |
| `pickup` | a rider is aboard | a door thump and a rising interval |
| `dropoff` | a fare delivered | a major arpeggio, **transposed up a semitone per fare landed** |
| `urgency` | a fare's clock stepped down a colour | a tick whose **pitch falls with the level** |
| `parcel-in` / `parcel-out` | the courier layer | wood going in, two clean high blips coming out |
| `loco` | Loco Mode engaging | a saw sweeping up through an opening filter |
| `brake` | the brake, hard enough to lock a wheel | narrow band-passed noise, swept down |
| `crash` | wrecked against traffic | crack, body and thump, three layers of one impact |
| `bust` | caught boosting past a cop | two descending whoops — *not* the crash |
| `fail` | a clock ran out | three notes down a minor triad |

Two of those carry the state of the run rather than just announcing an event, and they are the two
worth knowing about:

- **`dropoff` climbs.** A semitone per fare already delivered, capped at an octave. A perfect player
  survives a median of 15 fares ([difficulty.md](difficulty.md)), so the cap lands a couple of
  deliveries short of the end of a good run — it climbs for as long as there is a run left to climb
  through. Nothing else in the game tells the player they are doing well *while they are doing it*.
- **`urgency` falls.** `game/urgency.js`'s scale runs 4 → 0 and so does the pitch, so a player who
  has learned it knows how much trouble a fare is in without finding it on the map. The last step
  doubles the tick. Level 0 is deliberately silent: it only happens on the frame the clock actually
  runs out, which is the frame the run ends, and a countdown tick under the sound of the ending it
  caused says nothing.

### The two held voices

Everything above is fire-and-forget. Two voices are *held* — they exist for as long as the thing
they stand for does, with their level ridden from the frame loop by `sfx.update(dt, …)`.

**The Loco Mode roar** is two detuned saws through a low-pass, with the filter and the pitch riding
the taxi's speed as a fraction of its boosting cruise. It is up only while Loco Mode is active, and
that is a decision rather than an omission: a permanent engine drone was the obvious first shape and
it is wrong for this game. The taxi drives itself most of the time, everything that matters is
short, and a bed under it all would be the loudest thing in a mix whose whole job is to make a chime
audible. **Silence is the resting state**; the roar is what Loco Mode takes you out of.

**The cruiser's wail** is one square through a band-pass, swept by hand from `update` rather than by
an LFO node — the phase lives in `state.wail`, so a paused game holds the siren exactly where it was
instead of resuming a quarter of a cycle along. Its loudness is `sirenLoudness(police.state,
distance)`, which imports its curve straight from `game/sirenglow.js`: the light bar, the wash over
the frame edge and the wail are one rule about how close a cop has to be before it is worth
mentioning, and a second copy of those numbers would drift the moment either was tuned.

The wail is gated on `state.lit` and on nothing else — the rule the player already knows from the
bar. Note what it is *not* gated on: unlike the frame-edge wash, being on screen makes no
difference. You can see a cruiser you are looking at; you can hear one either way.

The sweep **rate** steps when the cruiser locks on, mirroring the bar's own 6Hz → 11Hz change
(`SIREN_HZ` / `SIREN_HUNT_HZ` in `sim/police.js`) — the one cue that a corridor run has become about
you. It is not driven off `sirenOn()` itself, and that is not an oversight: a tone alternating six
times a second is a smoke alarm, not a siren. What the two share is the escalation, which is the
part the player is reading.

## Nothing exists until a gesture

Browsers refuse an `AudioContext` outside a user gesture and hand back one stuck in `'suspended'` if
you try. So the context is built lazily by `unlock()`, wired in `main.js` to the first `pointerdown`,
`keydown` or `touchend` the page sees. Those listeners stay registered rather than firing once — a
context can be suspended long after it started, because iOS takes one away for a phone call and hands
it back suspended, and the next tap is the natural place to notice.

Everything else degrades to silence: no constructor, a context that refuses to resume, a node type
the engine has not shipped. That is the `highscores.js` rule (a dead store is an empty table, never
an error) one module over, and it matters more here — nobody has ever lost a run because it was
quiet.

Two more places that would otherwise leave a voice stuck:

- **A pause** returns out of `frame()` before `sfx.update` runs, so the held voices would hold
  whatever gain they last had over a frozen city, indefinitely. `createPause`'s `onChange` hushes
  them explicitly.
- **A hidden tab** stops getting frames at all, which is the same problem arriving by a different
  door. `visibilitychange` hushes them.

## The mute toggle

On the pause screen, under Resume, and `M` from a keyboard. It is not in the HUD's top row because
that row is already three things wide (cash, ⏸, streak) and a fourth would crowd the one part of the
screen that has to stay readable at a glance while driving. A player who wants the sound off wants it
off *now*, which is one tap away since ⏸ is always there; a player who does not never has to look
at it.

Muted means **nothing is scheduled**, not "scheduled at zero gain" — `play()` returns before it
builds anything and `update()` never creates either held voice. The master gain is still ramped, so
pressing it mid-voice is a fade rather than a click.

The preference lives in `localStorage` under `simtaxi.muted.v1`, behind the same guards
`highscores.js` uses: `globalThis.localStorage` is a *getter* that throws outright when storage is
blocked, Safari's private mode throws on the write while handing back a good object, and on a
`file://` origin the whole thing raises `SecurityError`. Losing a mute preference is not worth an
error.

Shot mode is silent and is given no store at all, so a capture run cannot leave the next real player
muted.

## On the phone

Two settings in the shell, and they are separate halves of one thing:

- `GameViewController` sets `allowsInlineMediaPlayback` and an empty
  `mediaTypesRequiringUserActionForPlayback`. The second is what lets a sound fire on a frame
  nobody touched the screen. It does *not* start a context — `sfx.js` still waits for a gesture,
  because the web build has to and one `dist/` ships to both.
- `AppDelegate.configureAudioSession()` sets `AVAudioSession` to **`.ambient`**, and that is a
  product decision rather than a technical one. The default for a WKWebView playing Web Audio is
  `.soloAmbient`, which *interrupts whatever the player is already listening to*. This game's
  sounds are a fare chime and a tyre screech; they are not worth somebody's podcast, and an app
  that stops it gets muted permanently, in Settings, on the first run. `.ambient` mixes, and obeys
  the ring/silent switch.

The session is deliberately **not activated** at launch. The web view activates its own the moment
the page starts a context and inherits the category set here; activating an empty one at launch
would interrupt the player's music before the game had made a single sound, which is the exact thing
`.ambient` was chosen to avoid arriving by another door.

See [ios.md](ios.md) for the rest of the shell.

## Testing

Sound is the one system a screenshot cannot review at all, and the failures that matter are silent
in a browser by construction. It is covered from both ends.

**`tools/sfx.mjs`**, in `npm run check`, drives the whole module against a **fake `AudioContext`**
that records rather than renders. That is what makes the graph assertable:

- **`exponentialRampToValueAtTime(0, …)` throws** on a real `AudioParam`, and every envelope in the
  bank ends in a decay. In the browser it surfaces as one sound quietly missing, with the
  `RangeError` swallowed by the `try` that stops a dropped sound from ending a run. The fake throws
  the same way, on every ramp of every voice.
- **A voice that is never stopped never stops**, and one that is never disconnected is never
  collected. The tool plays the whole bank, runs the clock forward and asserts the graph empties.
- **Muted has to mean nothing scheduled.** Asserted by node count, not by gain.
- Plus the voice cap, the repeat gap on tapped sounds, a context that refuses to start, a
  `localStorage` that throws, and `sirenLoudness`'s curve at both ends.

**`tools/smoke.mjs`** runs the bank once through a **real** `AudioContext` in headless Chrome
(launched with `--autoplay-policy=no-user-gesture-required --mute-audio`). A fake cannot *be* Web
Audio: a real `AudioParam` validates its arguments and a real engine has its own opinion about which
node types exist. That block also checks the graph empties for real, that the held voices ride, and
that the pause screen's toggle is a thumb-sized target whose label cannot be tapped instead of it.

Neither asserts anything about how it sounds, because neither can. For that, `window.__taxi.sfx` is
exposed on the testing hook: `window.__taxi.sfx.play('dropoff', { streak: 12 })` in a console
auditions any voice in the bank without playing the game to the event first.
