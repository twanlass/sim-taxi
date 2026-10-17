# Gameplay

## The startup screen

`src/game/splash.js`, entered from `src/boot.js`. A cold start is black from its first frame — the
iOS launch screen, the web view and the page (`html.booting`) are all `PALETTE.splashVoid` — and
stays black while the game loads. Then a patch of asphalt fades up in the middle of the black, seen
from a low side-on camera (15° up), the taxi falls out of the sky onto it with the **Big Air landing** (the dust ring, the pale shockwave,
sparks off all four wheels, a hard shake), bounces twice, sits for a beat, lights **Loco Mode** and
leaves on its back wheels, laying rubber, off the right edge of the frame. Once it is fully gone,
flame and all (`exitTime`), the empty patch holds for a second (`HOLD`) — skid marks, dust settling
— and then fades to the title screen. About 3.8 s from the first frame of asphalt on a phone; a tap
anywhere skips to a quick fade, and a player with reduced motion gets the fade alone.

**It has sound where sound is allowed** (`game/splashsound.js`): the Big Air landing on the slam, a
bump on each bounce, and the Loco press (launch, the activate's roar, a skid for the burnout) as it
leaves, the roar fading as the car clears the frame. The game's own recordings at the shipped mix,
under the player's mute and effects slider. It has to play before anyone has tapped, which a
browser will not allow, so it makes its own context at once and stays silent unless that context
is running: in the iOS app it is (the shell lifts the gesture rule), in Safari it never is, in
Chrome only on a site the player already uses a lot. `?splashsound=classic` is the silent drop.

**It covers the load without animating during it.** `main.js` builds the city in one synchronous
task (13 s of one long task under headless SwiftShader, nothing in between), so nothing on the page
can move while it runs. `boot.js` builds the splash first — its renderer, its scene and the effect
pools it borrows from the game — then imports the game behind the black. When the game is up, the
city draws a few frames behind it (`WARM_FRAMES`) so its first-frame shader links land where they
cannot stutter anything, and then the drop plays with the city skipping its frames
(`splashCovers()`, read at the top of `frame` in main.js). The fade reveals the last of those warm
frames, still on the city's canvas, and the city picks up when the screen is gone.

**It is built before the game is imported on purpose.** `propMaterial()` bakes the AO, Crayon and
cloud-shadow switches into the shader at creation, and `main.js` throws them as it boots: a taxi made
afterwards would sample the city's SSAO buffer at whatever pixel it stood on. Built and compiled
first, it is the plain car.

**Where it plays.** Every cold start. Not wherever the title screen would not be either — shot mode,
`?dev`, `?title=off`, the reload "Play again" does — and not on **`?splash=classic`**, which is the
old load: straight into the game, though the page is still black rather than sky until the city has
drawn. The drop itself is walked in `tools/probe.mjs`: the body never dips into the road, and the
car starts above the frame and is gone, plume included, at `exitTime` at a phone, a square and a
desktop aspect, under both cameras. **`?splashcam=classic`** is the first cut's camera instead: the
game's own 33° three-quarter view, with the car leaving off the top right.

## The title screen

`src/game/titlescreen.js`, in `#title-screen`. A load opens on **Play, Settings, Credits**, left
aligned over the live city, with the camera drifting a slow ellipse across it (`panAt`: one lap
every two minutes at zoom 34, against play's 52). The menu is the only thing on screen: no HUD, no
⏸, no riders.

**It parks the run the way the Home Screen tip does.** `parked()` in `main.js` is the one gate both
answer to: the fare board is not seeded, the tutorial and the vignette are held, Space and B do
nothing, the ⏸ refuses, and the city's entrance wave is *settled* rather than played — the menu sits
over a finished city with its traffic running, which is the whole point of the backdrop. **Play**
lets go of all of it at once, so what follows is exactly the run that used to start on load: down
to the garage door, the door up, the taxi out, the tips. The drift sits at the top of the camera's
priority list while the title holds, and the vignette's approach eases from wherever it left off.

**Settings** and **Credits** dim the city behind a mask; the menu only shades the left edge its
words stand on. Settings holds four things, all remembered across visits:

| Setting | Where it lives |
|---|---|
| Sound on/off | The existing mute (`simTaxi.muted`, game/sfx.js), shared with the pause screen's Settings and **M** — stored once, not twice |
| Music volume, SFX volume | `simTaxi.settings` (game/settings.js), applied through `sfx.setVolumes`. Music is the radio ([audio.md](audio.md#the-radio)) |
| Tutorial tips | `simTaxi.settings`, on both the title and pause screens. Read on Play (`beginRun` in main.js): off drops the tutorial and lets the HUD in. Off mid-run (pause screen) does the same (`dropTutorial`); the New Move cards read it live |

**"Play again" skips it.** The retry is a reload, and a player who just pressed Play does not want
the menu again, so `onRetry` sets a one-shot `sessionStorage` flag the next boot consumes.
**`?title=off`** skips it too, the same escape hatch `?vignette=off` is; `tools/smoke.mjs` runs every
page but its own title check that way. **`?dev`** skips both, and turns on debug mode (the ⚙️
panel) with them: the one flag for playtesting. Shot mode never builds it.

## The opening vignette

`src/game/opening.js`, over the depot in [city/garage.js](city.md#the-depot-block). A run does not
start with the taxi already in traffic. The camera comes down onto a garage door, the door rolls up,
the player's car drives out of it, bumps down the kerb into the street, and the camera pulls back
out to the game.

**PROTOTYPE.** It works end to end and the numbers below are the ones it shipped with, but three
things are hard-coded that a finished version would probably decide per city — see
[the depot block](city.md#the-depot-block) for why each is the way it is: the door always faces
**+X**, the depot always takes a **whole block**, and the exit is always a **right turn** into the
near lane.

### The beats

| Phase | What happens | Length |
|---|---|---|
| `wait` | The city's own [entrance wave](rendering.md) is still running. The taxi is already in the garage by now, so the wave spreads out from the depot — the building the camera is about to go to | until the wave lands |
| `approach` | `focusOn` eases target and zoom together onto the door, from the play framing at zoom 52 down to **15** | ~1.4s, capped at 1.9 |
| `settle` | A beat on the shut door, so arriving and the door moving read as two events | 0.12s |
| `door` | The curtain winds up on an ease-*out* — a roller door leaves fast under its counterweight and creeps the last few inches | 0.95s |
| `reveal` | The car sitting in a lit doorway, the radio crushed through its speaker ([the dash radio](audio.md#the-dash-radio)). This is the shot | 0.35s, or until the first song has played 3s through the dash (up to 8s; usually ~5s) |
| `roll` | Out of the bay, across the forecourt, down the kerb, right into the lane. The zoom starts widening as the nose clears the door, so the pull-back is already under way; the **shutter starts coming back down** the moment the car reaches the kerb | ~2.7s |
| `release` | `focusOn` back to whatever framing the run would have had — the city's centre on a desktop, the taxi on a phone, where the opening follow-cam picks it up | ~1.3s, capped at 2.0 |

The door comes down over 1.4s, slower than it went up — that is what a roller door does, leaving
under its counterweight and returning under a motor, and it is scenery by then rather than the
subject. It runs on its own clock rather than the phase's, so it keeps closing through `release`
after `roll` has stopped being called, and `finish` lands it shut. **Shut is the resting state** a
run is played in: the car is out and the depot closed up behind it, which is what shot mode sets too.

Both eased legs normally retire on **arrival** rather than on their cap, and the caps sit just past
where that happens: they are a backstop against a resize or a device dropping frames, not the thing
that sets the pace. The approach runs at rate 2.4 and the `settle` beat is 0.12s because the tail of
an exponential is the part nobody is watching. History:
[the opening vignette](gameplay-history.md#the-opening-vignette).

Then the tutorial starts. The three openers **queue on one guard**: the city builds itself, the taxi
comes out of its garage, and only then does anything start talking. `isBlocked` in `main.js` chains
them, and the fare loop is held for the whole of it — see [the board waits](#the-board-waits) below.

### Where the taxi parks

Its nose sits `NOSE_BEHIND` = 0.25 units back from the shut curtain, and the number that matters is
what that is measured from: **`TAXI_TAILPIPE_BACK`, half the *drawn* car**. The taxi group wears
`TAXI_SCALE` = 1.18, so the body on screen is 4.01 units long where `CAR_LEN` says 3.4 — and parking
it by half of `CAR_LEN` put the nose a third of a unit *through* the closed door, as a yellow
rectangle stamped across the middle of the shutter. The bay is sized off the same number: 5.2 deep,
which is the car plus the recess plus somewhere for the back bumper. The probe asserts both ends.

The back half of the body is hidden behind the +Z jamb at this camera, and no width of opening
changes that — the sightline gains a unit of z for every unit of x, so it walks out of the doorway
before it clears the bay. That is the shot rather than a limitation of it: a nose in a lit doorway.

### The taxi is out of the traffic model for the whole of it

It has to be. A garage is not anywhere on the road network, and a car parked inside one cannot be
expressed as a lane coordinate. `stageCar` in `sim/traffic.js` is that split, and the split is the
interesting part: a staged car is skipped by **every simulation loop** — nothing queues behind it,
yields to it or reserves a junction against it, exactly as for a crashed one — but it is **still in
the render pass**. Only where its `x/z/yaw` come from changes.

Which means the drive-out gets the car's own suspension for free. The nose dip coming off the kerb
is not animated: it is one impulse into the pitch spring that was already there (ζ ≈ 0.4, so one
shove gives a dip, a rebound and a settle), and a second, smaller one as the rear axle follows. The
speed bob, the brake lights and the indicator all keep working the same way — the indicator through
`stageSignal`, because a staged car has no committed turn to read a hand off.

`stageCar` is mostly a list of things it *clears*. Every lane-relative offset the render pass
applies on top of a position — the weave, the overtake, the pull-over — is eased in the physics loop,
which a staged car skips, so anything left standing would be frozen into the vignette. A taxi that
spent the warm-up beside a passing siren sat in its garage permanently shoved a unit sideways until
that list existed.

### The exit is one continuous curve

Straight down the driveway, then a quarter circle onto the lane. The fillet's radius is not a choice
— it has to be tangent to the driveway at the kerb lip and tangent to the lane where it lands, which
fixes it at the gap between the kerb and the near lane's centre, `HALF_ROAD - LANE` = **2**. That
happens to be the radius every right turn in this city already uses (`turnControl` in `grid.js`), so
the manoeuvre reads as one of them.

`releaseCar` then hands the taxi back to the traffic model with its speed intact, on the lane the
arc landed on, five and a half units short of the junction. The probe asserts that the arc's
end point and the point `placeCar` puts the car at are the same to within 1e-9 — they are computed
by completely different arithmetic, and a millimetre between them is a car twitching sideways on the
handover.

**It waits for a gap.** The taxi holds at the top of the dropped kerb until the lane it is joining
is clear — a box on that lane rather than a radius around the merge point, because the opposing
lane's centre is only 4 units away and a radius wide enough to see a car coming up behind also sees
every car going the other way. It gives up waiting after 5 seconds: a run that will not start is
worse than a near miss.

### The board waits

`fares.update` is not called while the vignette runs, on the same hold the "Add to Home Screen"
screen takes. The fare board is *seeded* by that first call — `shouldRefill` fills an empty board
immediately — so leaving the loop running stood a rider and a two-metre crystal on a kerb while the
camera was down at the garage door, and on the seed this was first watched on, that kerb was the one
the door faces. The board belongs to the run, and the run starts when the taxi is on the road.

The [taxi's ghost outline](rendering.md#taxi-ghost-outline--geometryghostoutlinejs) is switched off
for the same span, and it is the sharper version of the same point: that outline exists to find the
car behind a building, and for these few seconds the car is *in* one — so it drew a yellow blob
across the door the whole vignette was building up to. Where the car is, is what the camera is for.

### Tap to skip

**A tap anywhere on the city cuts to black, lands the vignette behind it, and fades back up on the
run.** No button and no "skip" label: the opening is seven seconds at the top of a run the player
has already chosen to start, so an affordance costs more screen than the thing it escapes — and a
tap is what every other beat of the opening already answers to.

The black is the feature, not decoration. `opening.skip()` is `settle()` plus one thing settling has
no reason to do: it **snaps** the camera to `restFraming()` at play zoom, from fifteen units off a
garage door. Done in plain sight that is either a jump cut across a third of the map or a second of
easing — the wait the player just asked to be let out of. Under the black it costs one invisible
frame, which is what a cut is for. `game/wipe.js` owns the cover: 160ms out, a 90ms hold, 300ms
back. The hold is what makes it read as a cut rather than a stutter, and the fade in is slower than
the fade out because going to black answers the press while coming back *is* the game arriving.

Three things about the tap:

- **Only while the vignette owns the camera** (`holdsCamera()`), which is false during `wait` — the
  city's own entrance still building itself. Skipping a sequence that has not started reads as the
  tap having broken something.
- **Only a tap on the canvas.** The ⏸ is live through all of this (it is not part of the HUD's
  entrance), so a bare `window` listener would skip the opening *and* pause the game on one press.
- **`pointerdown`, not `click`,** because a skip has to land on the press. Nothing else is tappable
  while the vignette runs — the board is held empty, the HUD has not arrived, there is no route band
  — so there is no gesture for this one to steal.

Both holds the vignette takes — [the fare board](#the-board-waits) and the tutorial — are extended
to the wipe rather than to the vignette alone, and that is the whole reason `covering()` is public:
the sequence stops running a beat *before* the player can see anything, and a bubble that started
typing under the black would have spent half its line by the time the screen came back.

`tools/probe.mjs` asserts the half that is arithmetic — the handover lands where `settle`'s does and
the camera ends exactly on the play framing — and `tools/smoke.mjs` asserts the half that is a page:
that a `pointerdown` on the canvas puts a black div on top of everything, that the run is on the
road behind it, and that the black takes itself down again afterwards.

### Where it sits in the camera's priority list

At the **top**, above even [the closing shot](rendering.md#the-closing-shot), and on every viewport
rather than narrow ones only. It is a cut scene: nothing else can be claiming the framing three
seconds into a run, and a player swiping through one should not be able to steer it off its subject.
It hands back by letting `holdsCamera()` go false with the camera already sitting on the framing the
next claimant wants, so there is no gap for the follow-cam to snap across.

Shot mode never stages the taxi at all — the module is not constructed there — and `main.js` just
shuts the door beside `cityEntry.settle()`, which is the state a run is actually played in.

**`?vignette=off`** skips it, the same escape hatch `?tutorial=off` is: seven seconds is a long
time to sit through on every reload while iterating on something else. It is a *settle* rather than a
skip — the module is built and then landed — so the fast path goes through the same handover the
real sequence does. A skip that reached the game any other way would be a second opening to keep
working. [The player's own skip](#tap-to-skip) goes through the same `settle`, which is what that
handover being one path is for; all it adds is the camera, because it is the one skip that lands
with the shot somewhere it cannot be left.

## The opening tutorial

`src/game/tutorial.js`, in the `#coach` layer. A "TIP" [speech bubble](#speech-bubbles) pinned on
whatever it is talking about, with the line typing itself out. **Three beats, and that is all
of it** — though the first one is currently switched off:

1. ~~**"Let's pick up some rides and earn some cash."**~~ The camera follows the taxi while it types
   and a spotlight picks it out of a darkened city. **Off** — `TAXI_BEAT` in `tutorial.js`. The one
   thing a new player cannot work out by looking is which of the hundred cars down there is theirs,
   and this was the cheapest way to answer it until
   [the opening vignette](#the-opening-vignette) started the run by showing them their own garage
   door open and their own car drive out of it. That is a better answer than a sentence, and skipping
   the bubble gets the run to its first *instruction* a beat sooner. The beat is intact behind the
   flag — the line, `openOnTaxi`, and the `'taxi'` step in both step sets — because the vignette is
   a prototype and this is what has to come back if it goes.
2. **"Tap rider to start"** The lights come down and the spotlight lands on the waiting fare as the
   camera sets off for them, so the light is already on the rider and the pan carries the player to
   it; the bubble comes back once the camera has arrived. Tapping the rider answers it directly.
   With beat one switched off this is the beat that *lights* the pool (`spotlight-on`): whatever
   beat comes first has to be the one that turns the light on.
3. **"Hold to floor it"** — the gas pedal, two seconds after the first rider is *dropped off*,
   with the bubble standing on the pedal's top and its pointer on it and the pedal pulsing under it.
   **No spotlight** — dimming the city hid the taxi and the road ahead, which is the thing the
   player has to read to know whether it is safe to floor it. Skipped entirely if the player has already fired Loco
   Mode.

The city's own entrance and then the vignette come first: the whole tutorial is held frozen (via its
`isBlocked` hook — the same one the "Add to Home Screen" screen uses) while the buildings rise out of
the ground ([the entrance animation](rendering.md#the-city-entrance--gamecityentryjs)) and the taxi
comes out of its garage, then `OPENING_HOLD` — a 250ms breath — separates the camera landing
from the lights coming down. A run that opens mid-sentence gives the player nothing to attach the
sentence to, and the seconds of the city building itself do that job. The clocks are already
held through all of it, so it costs nothing. The camera is already easing onto the taxi during it —
that is the one thing that should be under way before the bubble speaks.

**A tap anywhere advances**, not just a tap on the bubble. The listener is on `window` rather than a
full-screen catcher, so the tap still reaches the city underneath — on the second beat the whole
lesson is the tap landing on the rider, and an overlay would eat the one gesture being taught. It
shares the picker's `didPan()` guard, so a swipe that dragged the map is not also an answer.

### Speech bubbles

Everything that talks on screen — these tips, [the robber](#the-bank-robbery), dispatch
and (under `?copchat=classic`) the cop's shout — is one bubble, `game/speech.js`: the Figma file's "bubble-ui" card (a caps title
saying who is talking over a bold line, and a pointer), at the HUD's ×0.652.

**Pinned to what it is about.** Each bubble is handed a target, a function returning a screen point
re-read every frame, and stands above it with its pointer on the bottom edge. The talker where there
is one (the cop's roof, the taxi the robber is in, the police car dispatch is talking from) and the thing
being pointed out where there is not (the rider's crystal, the top of the gas pedal). It slides
sideways to stay on the glass, and drops *below* a target that is up under the HUD.

**Off screen, it waits at the edge.** A target out of frame clamps the card to the nearest edge along
the line from the middle of the screen to it — the [off-screen rider arrows'](#finding-the-next-rider)
rule — with its pointer on the side facing that edge. Pan towards it and the card slides along the
edge with you until the target is in frame, then drops onto it. The pointer always sits in the
**middle** of its side and only turns, leaning towards its target but no more than 40° off square
to the card's edge, so it does not crawl along the edge as the camera pans. `placeSpeech` is the
pure half of it. History: [speech bubbles](gameplay-history.md#speech-bubbles).

### The spotlight

A single `#spotlight` div: two radial gradients centred on the subject, a warm core over a darkening
wash. Not a three.js `SpotLight` — that would mean turning down the scene's own sun and re-lighting
one patch of a city built around a single global key, which is a rendering change to carry a
two-sentence lesson. This costs one composited element.

Both radii are sized in **world units** and converted per frame, because 1 world unit is only
~7.7px at play zoom and a pool measured in pixels would be a different size on every viewport (and
wrong the moment anything moves the zoom). The clear centre is 6 units — the subject and the kerb it
stands on, no more. At half again as wide it lit most of a 5×5 city and read as general gloom rather
than as a light pointed at one thing.

The warm core matters more than it looks: the darkening alone left the subject merely *not dimmed*,
which at this contrast is not the same as lit.

Every beat that raises the pool aims it **before** adding `body.spotlight-on`, because the fade is a
0.45s opacity transition on a div whose centre is wherever the last subject left it — turn it on
first and it blooms from across the city and slides into place. `tools/smoke.mjs` asserts both halves
of this on a real page (that it is lit, and that it is lit *on the rider*): the node suite imports
`tutorial.js` but never calls it, so a pool that is aimed perfectly and never switched on is
invisible to everything else.

### The HUD arrives afterwards

The money counter and the ⏸ start off the top edge, and they slide in together the moment the last
bubble is dismissed (the [rider chips](#finding-the-next-rider) ride in with them under
`?chips=on`). A counter reading zero answers a question nobody has asked yet. `main.js` adds
`body.hud-ready`; with no tutorial to wait for (`?tutorial=off`, shot mode) they are simply there
from the first frame.

**The two pedals come in earlier**, from the bottom edge, on `body.pedals-ready`: the frame the
[opening vignette](#the-opening-vignette) hands the taxi back to the lane, with its pull-back still
running (`pedalsDue` in `main.js`). Waiting for `hud-ready` would leave several seconds of a live
taxi with nothing to press, which reads as the game not having started. A counter can wait for a
lesson; a control is the thing the lesson is standing in front of. A press on the gas pedal during
the rider beat ends that beat (`holdLocoMode` calls `tutorial.dismiss()`), as the spacebar does. Not
before the handover — a staged car burns fuel going nowhere — and not under a skip's black, the
Home Screen tip or the city's own entrance. The stylesheet treats `hud-ready` as implying
`pedals-ready`, so nothing that sets the one has to know about the other.

The offset is the standalone `translate` property, **not** a transform. Three of the HUD's pieces already
animate their own transform — the money bump, the boost meter's top-up throb, the pedals' press —
and a `body.hud-ready #boost { transform: none }` outranks a press state on specificity, which would
quietly kill the press feedback for the rest of the run.

**It leaves again for the depot.** `body.hud-away` sends every piece back off the edge it came in
from (the rider chips off the left, the nearer side for them) and fades the fare pointers, for as
long as the taxi is in the garage: the opening before the car is out of the door, and a repair
visit from the turn-in until the taxi is back on the lane. It is decided every frame (`setHudAway`
in `main.js`) off the same `release` phase the pedals wait on, so the run's first arrival and every
return from a repair land on one beat. The class sits after the ready rules in the stylesheet and
outranks them at equal specificity, so it hides a HUD that is ready without unsetting anything.

Nothing else is taught. The drop-off [dispatches itself](#the-drop-off-dispatches-itself) and the
clock is [a coloured crystal over a head](#the-fares-clock-travels) — neither needs a sentence, and
every extra beat is one more thing between the player and the game.

### The third beat is not like the other two

The first two stand in front of the game: the clocks are held, the camera is theirs, and each waits
to be answered. The third runs *alongside* a live run — the player is driving, the clocks are
counting — so it gates nothing, holds nothing, and a showing of it times itself out after
`BOOST_HINT_LINGER` rather than sitting over the road until someone taps it.

**And a tap does not answer it — a hold does.** This is the one beat whose lesson is a *gesture*
rather than a target, and the gesture it is teaching is the one the player is least likely to try:
Loco Mode is hold-to-enable, so a jab spends a slice of fuel and hands it straight back a second
later. A hint that retired on the first press therefore closed itself on the exact input it exists
to correct — the player saw the gas pedal flicker, and nothing ever told them again. What retires it now
is `boostHeld`: `main.js` latches `locoHeld` the frame the gas pedal has been down for `LOCO_HINT_HOLD`
with the boost engaged, checked every frame off `boost.heldSeconds()` rather than on the press,
because a press is not evidence of anything. `locoUsed` — the old flag, still set on the transition
into boost — now only picks *which line* a repeat says.

So the beat is not dismissible. Tapping anywhere leaves it up, and so does pressing the gas pedal (which
routes through `tutorial.dismiss()` explicitly — `holdLocoMode` calls `preventDefault`, which can
suppress the click a touch would otherwise synthesise — so that call now clears the first two beats
and deliberately does nothing to the third). Instead it comes *back*: `BOOST_HINT_SHOWS` showings,
`BOOST_HINT_REPEAT_GAP` apart, with the step falling back to `toBoost` in between so the same
countdown serves as both the first delay and every gap after it. The budget is there because this
beat is over a live run: three showings is 18 seconds of bubble across a whole run, and a player who has not taken it by the
third is not going to. A repeat says `LINES.boostAgain` — "Hold it down — don't tap" — whenever
`boostUsed` is true, since repeating the original line at someone who is jabbing the gas pedal is a
louder version of a sentence they have already read and acted on.

It is also the only one that points at a **control** rather than at the city, so it is placed
differently: `#coach.at-boost` drops it into the gutter just above the Loco Mode
gas pedal, flips the tail to the bottom, and grows the entrance upward out of it. The other two hang
centred with the tail up, because what they are talking about is up there.

**It fires on a fixed delay off the first drop-off, not on trip progress and not off the rider
tap.** Trip lengths vary by a factor of five, so anything keyed to trip progress lands anywhere
between three seconds and half a minute in; and three seconds after the rider tap the player is
watching their first pickup with a clock draining, and Loco Mode would be a fourth new thing
arriving while they are still working out the first three. Hanging `BOOST_HINT_DELAY` on the first
**delivery** — `hasDelivered()`, which `main.js` answers from `fares.state.delivered` — puts it in
the one gap in a run where nothing is being asked of the player, and it answers a question they
have just earned: that took a while, can I go faster? Two seconds, because the payout has finished
flying into the counter by then.

It follows that a player who never completes a fare is never told about Loco Mode, which is the
right way round — there is no point selling a way to drive faster to someone who has not yet done
the driving. The countdown is ticked through the `restore` glide as well as `toBoost`, since on a
desktop that glide can still be running when the delivery lands. History:
[the opening tutorial](gameplay-history.md#the-opening-tutorial).

**And it never appears if Loco Mode has already been held.** The tutorial reads `boostHeld` at the
moment the delay elapses and at the top of every frame a showing is up, so a hold taken mid-line
ends the beat there and then — explaining a control the player is mid-way through using is worse
than saying nothing, and the pool over the gas pedal is dimming a city they are now driving through at
full tilt. A player who has only ever *pressed* it gets the hint, which is the whole point of the
two flags being separate.

`LOCO_HINT_HOLD` is 0.75s — three times `LOCO_PUNCH_HOLD`, the camera push-in's threshold, because
the two ask different questions. That one is a gesture test ("tap or hold?") and 0.25 is the right
line for a frame that must not pop on a jab; this one asks whether the player has felt the boost
*keep going* because they kept pressing, and a quarter second is over before the wheelie has
finished playing. It is read against `isEngaged` rather than `isActive`, so a hold that ran the tank
dry still counts: the fuel ending is not the player letting go.

### It does not spend the player's clock

`fares.setPaused` holds every fare's countdown through the two gated beats. Only the countdown: fares
still spawn, riders still wave, diamonds still bob, and the city carries on behind the bubble. A
tutorial that taught you how to pick someone up out of the clock you need to *deliver* them would be
charging for its own lesson.

That got sharper when the clock stopped being flat. A rider's deadline is now
[budgeted from the driving their trip costs](#the-clock-is-budgeted) — it is margin sized for the
road rather than a round sixty seconds with slack to spare, so a lesson spent out of it comes
straight off the part the player needs. `state.elapsed` is deliberately *not* paused: it drives the
spawn stagger and the marker animations, neither of which is the player's to pay for.

Nothing auto-advances. Both beats wait for a tap, because a tutorial on a timer is one the slower
reader loses. A tap mid-type finishes the line instead of dismissing it, so an eager first tap
cannot throw away a sentence nobody has read.

### Where it sits in the camera's priority list

Below Loco Mode, above the [opening follow](architecture.md), and — unlike either of those — it
runs on **every** viewport, not just narrow ones. A desktop player has the whole city in frame and
still cannot tell which car is theirs, which is the entire reason the first beat exists. Because
moving the framing on a wide viewport takes away the default whole-city shot and nothing there
would ever put it back (drag-to-pan is narrow-only), the tutorial glides the camera home when it
finishes. On a phone it doesn't need to: the opening follow-cam picks the taxi back up.

A swipe hands the camera over mid-tutorial, the same as anywhere else — the bubble keeps talking,
it just stops moving the map while the player reads it.

### It runs on every new game

Not just the first. The opening is two taps long, it
[does not spend the player's clock](#it-does-not-spend-the-players-clock), and it is the only thing
in the game that frames the taxi and says which car is yours; a player back after a week gets that
for free rather than hunting the board for their car. Remembering it across loads was tried and
taken back out (see [history](gameplay-history.md#the-opening-tutorial)); the title screen's
**Tutorial tips** setting is how a player turns it off.

`?tutorial=off` skips the whole thing, and shot mode never runs it: a screenshot has nobody to
teach, and the bubble would be the loudest thing in every frame.

## New Move Unlocked: the overtake, U-turn and drift cards

**The overtake comes first** (`game/overtakeclip.js`), from the first drop-off: holding Loco Mode
behind a car rams it unless the combo is thrown (`game/overtake.js`), so it is the one move a player
is punished for not knowing. Its clip is two cars — the reel carries the car being passed too
(`REEL.lead`, drawn by `game/moveclip.js`) — and its camera **follows** that car (`track` on
`reelPlayer`) rather than standing still, because a pass takes ~80 units of road at the Loco top and
a frame that held all of it drew both cars at a third the size. That length is also why its street
picker accepts the ring road as well as side streets. The pedal row is Loco, then Loco again: the
first key goes dark at the blip and the second lights. Recorded by `tools/overtakereel.mjs`.

The bootleg (boost, then two quick brake taps — `game/bootleg.js`) is the one input nobody finds by
looking, so it gets a card (`game/newmove.js`, `#new-move` in index.html). It is the tutorial's
own speech bubble, made wider and centred over a dim with no pointer: "New Move Unlocked" in the
title slot, "U-Turn" as the line, then a clip of the move and the pedal row under it. No other words.

The clip (`game/uturnclip.js` and `game/moveclip.js`) is a scripted 4.6s loop filmed **in the player's own city**, at the
game's 3/4 view. On open, `pickStreet` chooses a straight two-way side street off the river with no
car stopped on it, mostly visible past the buildings, and runs the move left to right on screen. The
city is drawn once more into `#freeze-frame`, a 2D canvas laid over the game's, and from then on the
game's canvas renders the whole frame (`renderFrame(cam)` in main.js: shadows, AO, bloom, weather)
through a clone of the city camera slid over that street. The middle of each frame is copied into the
card. `frameRun` sizes and centres that crop by sweeping a box the size of the drawn taxi over the
whole loop, because the taxi body is much bigger than `CAR_LEN` and hand framing cut its roof off on
the spin. A stand-in taxi (the real mesh, the Loco Mode flame, the skid marks and the brake lamps) is
added to the scene while the card is up and removed on close. It cruises in, floors it, checks on the
first brake tap, spins onto the far lane on the second (0.3s later, inside the 350ms combo window)
and drives back.

The motion is **the game's own U-turn, recorded**: `tools/uturnreel.mjs` drives the shipped
traffic model, Loco Mode and bootleg on the passing lab's straight road with the pedals pressed on
the card's timeline, and writes the taxi group's transform, wheel lock, brake lamp, flame and rubber
for every frame to `game/uturnreel.js`. `npm run check` films it again and fails if the file no
longer matches (`node tools/uturnreel.mjs --write` refreshes it). It is not the sim running live
because the world is frozen under the card and a second traffic instance would write over the real
one's module-level state. At the game's real speeds the run is three blocks long, so `pickStreet`
also needs the street to carry straight on, open, through the junctions at each end. The pedal row
(the HUD's own pedal art, all three at one size with a "+" between) is pressed off the **clip's
clock**, so each key goes down on the frame the car does the thing it does: dim until pressed, lit
from then to the end of the loop. History:
[New Move cards](gameplay-history.md#new-move-unlocked-the-overtake-u-turn-and-drift-cards).

- **When:** a beat (0.9s) after the drop-off that brings a run to two fares — robbery.js's
  `MIN_DELIVERED`, the first moment a chase can happen, which is what the move is for. It waits out
  the opening tutorial's Loco Mode beat, and skips any drop-off that is not calm (a delivered robber
  hands the taxi a patrol chase, a depot visit, a wreck); the next drop-off tries again.
- **Once, ever.** Remembered under `simTaxi.seen.uturn`, unlike the opening tutorial: a card calling
  a move "new" on every retry is lying by the second one. A store that throws costs the memory, so
  it shows once per visit instead.
- **The world stops** under it, like the robber's line, and any tap or key press clears it after a
  0.3s guard (it lands mid-run, under a thumb that may be tapping the city). The key is swallowed,
  so the Space that closes it does not also boost.
- The tips setting, debug mode and `?tutorial=off` all turn it off. `__taxi.newMove.open()` shows
  it on demand; clear the key to see it again in play.

The camera, the stand-in and the still are shared with the drift's card below, in
`game/moveclip.js`; `game/uturnclip.js` keeps the U-turn's timeline, reel and street picker.

### The drift card

The drift (Loco Mode, a tap of the brake just before a turn, Loco Mode again — `driftTaxi` /
`kickDrift` in sim/traffic.js) gets the same card: "Drift" as the line, and a pedal row of Loco,
brake, Loco. Its clip (`game/driftclip.js`) is a 3s loop: the stand-in comes up the street, floors
it, taps the brake 0.2s before it starts into a left turn, gets back on the gas mid-arc, and comes
out on the kick's purple twin plume with the bark out of the pipe.

- **Recorded on a corner.** A drift needs a turn, so `tools/driftreel.mjs` films it on a grid of side
  streets with the lights taken out, not on the lab's straight, and writes `game/driftreel.js` in the
  corner's own frame (from the junction's centre, along the approach and across it). `npm run check`
  films it again, as for the U-turn (`node tools/driftreel.mjs --write` refreshes it). The gas pedal is
  held to the end of the loop: let go, the brake lamps come on as the boost eases off, and that
  would read as a brake the pedal row never pressed.
- **Played on a matching corner.** `pickCorner` lays the reel on a left turn of the player's city
  whose path matches the recorded turn's entry, middle and exit within 0.05, which admits side
  streets and the ring and rules out anything with an arterial in it (a unit and a third wider). The
  approach and the exit both run left to right on screen, so the car draws a V down and back up.
  It needs straight road enough before and after, nothing parked within 5 of the path, stays off
  the river, and prefers corners off the ring, which put half the clip over the coast's fade.
- **When:** a beat after the drop-off that brings a run to four fares, and only once the U-turn's
  card has been seen, so the two never land on one drop-off and always come in order. Remembered
  under `simTaxi.seen.drift`. `__taxi.newMove.open('drift')` shows it on demand.

## The fare loop

`src/game/fares.js`. Each fare is its own little machine — `waiting → riding → gone` — carrying its
own clock, its rider, its drop-off and the one marker that travels between them. The board holds
between one and four at once depending on how far into the run you are ([Difficulty](difficulty.md)),
and because the taxi has one seat, all but one of those are riders waiting on the kerb.

1. A passenger spawns at a random intersection (never the one the taxi is already about to reach)
   with a **clock budgeted from the driving their trip costs** — see
   [The clock is budgeted](#the-clock-is-budgeted) — and a
   [diamond](#the-fares-clock-travels) over their head, coloured by how much of that clock
   is left. The whole trip is drawn now; none of it is shown until they board — see
   [Neither how far nor where](#neither-how-far-nor-where).
2. Tap them → the taxi routes there.
3. On arrival the passenger boards (the cab's rear door swings open on the kerb side as they reach
   it and slams behind them — `game/taxidoor.js`, pure flourish), their diamond flies from the kerb to the roof of the taxi, a
   ring in that same urgency colour appears on the road where they're going, and the taxi **drives
   straight on to it** — because the instruction it used to ask for is now given for you. See
   [The drop-off dispatches itself](#the-drop-off-dispatches-itself).
4. Deliver → the fare pays out (`FARE_BASE + FARE_PER_BLOCK × blocks`, times the shift's
   multiplier, see [Economy](#economy)), and the board refills.
5. A rider's clock running out, on the kerb or **aboard**, is a [strike](difficulty.md#strikes):
   they get out and storm off, the taxi is freed, and the third strike ends the run.

## The drop-off dispatches itself

**A rider getting in is the taxi's instruction to drive them.** `dispatchToDropoff` in `main.js`
routes at the drop-off on the pickup frame; the player never taps a destination pin.

The tap it replaced confirmed a choice with exactly one option. Where the rider is going was
decided when they spawned — the price is fixed from it — and their pin is on the map the instant
they board, so the second tap added no decision, only
latency, and it spent that latency out of the *same* flat clock that still has to cover the
delivery. Meanwhile the decision the game is actually about — which of two kerbside riders to grab
while both clocks drain — is untouched.

What it costs a slow player is the whole point, and the soak measures it. Modelled as reaction time
paid on the kerbside legs only (`tools/soak.mjs`), a perfect player at **4s** reaction goes from a
median of 2 fares to **3** (mean 1.9 → 2.8, worst run 0 → 2). At 1.5s it is unchanged at 2 — the
faster the player, the less the tap was costing them, which is exactly the wrong way round for a
tap that carried no decision.

The pin stays tappable and `directed` still governs arrival, so nothing about
[arrival requires direction](#arrival-requires-direction) is skipped — the flag is now set from the
pickup instead of from a second tap.

**The taxi does not park at a pickup.** A pickup is a pause in a drive rather than a full stop and a
restart: it fires with the taxi *inside* the junction (`state === 'turn'` at every pickup across
four run seeds, still doing the full 8.5 u/s). The one `parked = true` left is the fallback for a
drop-off the router can't reach, which a shipped city never has: `main.js` rerolls any seed where
`findRoute` fails a pair. It exists so an unroutable taxi is still recoverable by hand rather than
cruising on random turns until the clock runs out.

**The route carries on through the pickup.** The pickup fires with the taxi already inside the
junction, so the exit it takes there is decided at the hold line. A route at a waiting rider
carries on along the drop-off route (`carryOn` in `game/route.js`, the onward steps tagged as
`route.onward`), so the taxi leaves the kerb the way it is about to drive anyway rather than on the
ambient dice roll (`rollExit`), and the [band](#the-route-band-wears-it-too) shows it as a dim stub
`ONWARD_LEN` (18 units) past the kerb. A stub rather than the whole leg, because the whole leg *is*
the drop-off, which stays hidden until boarding ([Neither how far nor where](#neither-how-far-nor-where)):
the stub gives away a direction, never a destination. `?route=classic` puts back the route that
stops at the kerb (#480); see [history](gameplay-history.md#the-drop-off-dispatches-itself).

Routing on the pickup frame means planning from a turn the car has already committed to —
`planOrigin` handles exactly that, and `tools/probe.mjs` asserts a fare is delivered end to end
with no drop-off ever tapped, because a route planned from the wrong origin silently drops its
first turn and the only symptom is a fare quietly timing out.

## Neither how far nor where

Both ends of a trip are **drawn** the moment a rider spawns — the price is fixed from the length, so
both have to be known — but nothing about the far end reaches the player until they're aboard. What
a rider on the kerb offers is a clock and a place to drive to.

So the payout is not legible before the choice. Fares are still priced by distance, so a long haul
still pays more — the player just finds out on delivery. "Which rider?" is a timing question, not an
economic one: on a board with two waiting riders the wrong pick loses a whole fare, and a slightly
cheaper fare delivered beats a dearer one that timed out. A colour on the rider's
[diamond](#the-fares-clock-travels) says urgency without any parse at all. History (the preview pin
and the distance bar): [Neither how far nor where](gameplay-history.md#neither-how-far-nor-where).

The pin lands exactly where it was drawn at spawn — it never moves — so nothing about the reveal is
a re-roll. `tools/probe.mjs` asserts both halves: hidden while the rider waits, and at the drawn
junction the frame it appears.

`fares.update()` returns the events that happened this frame — `{type, fare}`, with type one of
`'spawned' | 'pickup' | 'delivered' | 'failed'` — rather than firing callbacks, so the fare system
holds no reference to the taxi mesh or the HUD. `main.js` translates events into all of
that. It is a list because more than one can land together: delivering the last fare clears the
board, and the refill follows on the next frame.

### Corners the camera cannot see

A marker is staked on the **kerb corner** of its junction, and the camera looks down a fixed
diagonal — so some corners have a building standing in front of them. Reported from a phone as a
courier pad that was simply not on the map: the package was aboard, the drop-off was somewhere up
in the haze, and there was nothing on screen to drive at.

A fare survives that. Its crystal floats at 9.65 and the tallest thing that ever stands in front of
a kerb corner tops out 5.6 units above it, so a rider always has *something* above the skyline
speaking for them. A courier pad has none of that:
[`marker.js`](../src/geometry/marker.js) took the drop-off's floating head away on purpose, and what
is left is a mark on the ground.

Two families of corner, and neither is a fluke:

- **The origin junction, (0, 0), in 19 cities out of 20.** `cornerFor` flips its corner inward
  wherever there is no block on the −X−Z side, and at (0, 0) *both* axes flip — which is the one
  corner of block (0, 0) that has that block's own building between it and the camera. Every other
  edge junction flips one axis, and its sightline leaves the block within half a unit.
- **The downtown junctions**, where the block on the +X+Z side carries a tower. A sightline from a
  kerb corner reaches that block's near corner 8.5 units later and is 7.8 units up by then, so
  anything over about 8 tall there covers the mark. Only central blocks build that high.

**The board simply stops using them.** `cornerSeen` (in `game/fares.js`, beside `onParkBlock` and
for the same reason — where a pin lands is `cornerFor`'s business) is a hard filter on both boards:
a rider, a drop-off ring and either end of a courier job all have to stand somewhere the camera can
see. It costs 1.7 junctions of 36 in an average city.

The alternatives were a ghost outline on the pad, or giving the courier a floating head back. Both
add a thing to read to a board that already carries four fares and a package; the filter adds
nothing and removes the case.

**Occlusion here is a property of the city, not of the frame.** The view never rotates and the
projection is orthographic, so panning and zooming cannot change what is behind what — which is why
the question can be settled once, when the city is built, instead of per frame.
[`game/sightline.js`](../src/game/sightline.js) rasterises the towers, the trees and the depot into a
half-unit **height field** and marches the sightline through it. Real rays would be the honest way
to ask and they are what `tools/probe.mjs` checks this against, but the city is one merged mesh with
no acceleration structure: the 324 rays a corner sweep needs measured **527 ms**, against 6 ms for
the field.

The field rounds occluders *up* (each triangle stamps its peak across the cells its bounding box
covers), which makes its error one-sided — it can call a visible corner hidden, never a hidden one
visible. The probe asserts exactly that against real rays, plus the other end of it: at a 1-unit
cell the over-statement was throwing away one perfectly visible corner every six cities, which is
why the cell is half a unit.

## Extra fares and prioritisation

The taxi has **one seat**, so any extra fare beyond the one aboard is someone *waiting* — a clock
draining on the kerb while you decide who to grab. Tapping a waiting rider while already carrying
one is refused outright, rather than driving there and quietly not picking anyone up — and the
board says so on both sides of the tap, see [the board steps back](#the-board-steps-back-while-the-seat-is-full).

Two waiting riders on the board at the same time is meant to be the whole difficulty of the game:
each clock assumes it is the one you take, so late in the ramp you can't take both, and the one you
leave is a [strike](difficulty.md#strikes). How often the board actually offers that choice is
measured in [difficulty.md](difficulty.md#what-the-sweep-found), and it is not yet often. `fares.waiting()` returns the *most
urgent* waiter (lowest `timeLeft`) so the finder button and the "perfect player" in the soak both
default to serving that one first.

Rules for when the extras appear. Everything in the first group is a point on the
[difficulty curve](difficulty.md) rather than a constant:

| Rule | Early | Late | Why |
|---|---|---|---|
| `pace` | 1.5× | 0.85× | A rider's clock over their own trip at cruise. Below 1.0 needs Loco Mode. |
| `pressure` | 0.5 | 1.4 | Riders offered per rider one taxi can serve; sets the spawn gap (`FARE_CYCLE / pressure`). |
| `maxFares` | 1 fare | 4 fares | One until the tutorial fare is delivered, then the whole board. |

And the ones that are still fixed, shaping the "second fare while carrying" hand-off:

| Rule | Value | Why |
|---|---|---|
| `SECOND_FARE_DELAY` | 5s aboard | A pickup and a spawn are never the same event. |
| `SECOND_FARE_RANGE` | 45 units | When someone is aboard and closing on their drop-off, the new rider appears near it. |
| `SECOND_FARE_MIN_CLOCK` | 18s | No rider flashes into existence a few seconds before an unrelated timer ends the run. |

The bias rules shape where an extra rider lands relative to the taxi. When someone is aboard and
closing on their drop-off, the new rider appears near that drop-off — the classic "second fare
while carrying" hand-off. When nobody is aboard, the extra lands near the taxi's current
intersection instead. Either way the radius is the same, so the two paths read alike.

**`SPAWN_RADIUS` builds a box, not a true block-distance circle** — it walks `±radius` on each axis
independently, so a corner of that box can sit up to `2 × radius` blocks out on the diagonal. Fine
for an ordinary extra, where the point is "reachable", not "exactly this close". The very first
fare of the run wants a real promise, though — especially now that the taxi itself
[opens downtown](traffic.md#the-one-routing-branch) rather than at a random corner, where the box
can span the whole map even at `radius = 3`. Three constants in `fares.js` make that promise, all
of them independent of the difficulty curve, and all of them binding on the run's first fare only:

| Constant | Value | What it promises |
|---|---|---|
| `FIRST_FARE_MAX_BLOCKS` | 1 block | Manhattan distance from the taxi to the rider. |
| `FIRST_FARE_MAX_TRIP_BLOCKS` | 2 blocks | Manhattan distance from that rider to their drop-off — the one time a drop-off is drawn near its own pickup instead of unbiased. |
| `FIRST_FARE_MIN_CLOCK` | 45s | A floor under the budgeted clock, because the caps above would otherwise issue a short one. |

### The board steps back while the seat is full

Play tests kept showing the same thing: with someone aboard, players tapped a rider on the kerb
anyway. The rule had always been enforced — `markDirected` refuses and `main.js` returns before the
route is planned — but it was enforced in *silence*, and a tap that does nothing at all is
indistinguishable from a tap that missed. So the board now says the rule twice, once before the tap
and once after it.

**Before.** A waiting rider's mark steps back for as long as the seat is full: the **glow goes off
both halves of it**, the crystal's **bounce damps to a stop**, and the disc under their feet darkens
(0.42× on the rim and fill, half opacity on the fill) and drops its sweep — all of it eased over
0.3s, because a halo that vanishes on one frame reads as the marker being switched off rather than
turned down. The bounce is *damped* rather than stopped, and it settles onto a
height the eye already knows: `bounceOffset` is `abs(sin)` and touches 0 once a cycle, so the rest
position is a place the marker has been landing on all along — it reads as stopping, not dropping.

**And it reaches the frame edge.** The off-screen pointer arrows
([rendering.md](rendering.md#off-screen-fare-pointers)) go the whole way rather than dimming: with a
rider aboard there is exactly one arrow on screen and it is the drop-off's. An arrow is a *go here*
and has no vocabulary for "not yet" — it is a direction and a hue — so three of them around the frame
are three invitations to do the one thing the game refuses. The cost is that a waiting rider off the
side of the frame has no mark at all until the seat empties.

**Two things deliberately keep moving.** The panic pulse under five seconds, because a rider about
to give up is exactly as urgent whether or not the seat is full; and the level-change kick, because
a still marker that knocks once is a clock stepping down. Both ride channels the step-back doesn't
touch — the pulse and the kick's swell are on scale, the kick's hop is added after the damping —
which is what lets "you can't take this one" and "this one is in trouble" both be true at once. `setBackgrounded` on the marker is reconciled every frame
from `carrying()` rather than latched at the pickup, because the seat empties through four different
exits — a drop-off, a crash, a VIP expiring, the run ending — and only one of them is somewhere a
latch could be released. A rider who *spawns* while the seat is full opens already stepped back:
that is the fifth argument to `showAt`, passed rather than set afterwards because these markers are
pooled and the loop does not tick a fare on the frame it spawns.

**The crystal keeps its size and its hue; the glow and the bounce are what go.** Shrinking it reads
as a *different, smaller kind of marker* rather than as the same one turned down, and takes the hue
— which is the clock — down with it in screen area. The glow is the right thing to spend instead,
because the bloom's spill is an order of magnitude wider than the thing spilling
([rendering.md](rendering.md#bloom--gamebloomjs-and-the-comparison-in-gamehdrjs)), so it is most of
what makes a marker carry across the city. The hop is the other half of the same claim — a thing
that moves on its own is a thing asking to be pressed — so it damps out on the same curve. Between
them they are the loudest pair available that doesn't touch what the marker *says*.
`setEmissiveScale` is how the glow goes, rather than `unmarkEmissive`/`markEmissive` per
transition: these markers are pooled and switch several times a run, and the scalar can be eased
where a flag cannot.

**The disc darkens rather than disappearing, and that is the whole design decision.** The disc is
the half of the mark that survives this camera — a rider whose crystal is behind a tower still has
colour on the tarmac ([corners the camera cannot see](#corners-the-camera-cannot-see)) — and the
colour it is carrying is that rider's clock. A waiting fare running out is a
[strike](difficulty.md#strikes), and [the clock is budgeted](#the-clock-is-budgeted) as if each
rider were the one served next: which rider is still makeable is exactly what the player should be
reading on the way to a drop-off. Hiding the disc would take the ordering puzzle off the road at the moment
it is being driven. What *can* go is the sweep — the beam circling the rim means "this is a live
target" and nothing else, so it is the one layer that was saying something untrue.

**After.** A refused tap gets an answer: the tapped rider's crystal shakes sideways (three swings
over 0.34s, damped, along the screen's own right) and the **drop-off's disc swells** — "not this
one; that one first". Pointing at the drop-off is the half that teaches, because it names the thing
standing between the player and the rider they just asked for. Both are pushed rather than
reconciled: a second refused tap on the same rider has to shake again, or it reads as the tap having
been swallowed, which is the complaint in the first place. `fares.refuse()` owns both halves, and
the picker and the rider-finder chip both call it, so the rule never looks conditional on which
control you used.

The refusal is deliberately **silent on the hand** and **colourless on the crystal**. Every haptic
in the game reports an *accepted* input ([ios.md](ios.md), `src/util/haptics.js`) — a confirming buzz
on a refusal would say the opposite of what the screen is saying — and the crystal's hue is the
clock while its highlight channel belongs to the select pop, so a refusal that lit it up would read
as the tap having worked.

### Finding the next rider

**The rider-finder chips are off.** `game/riderfinder.js` is still in the tree and `?chips=on`
brings the row back to compare against, but nothing builds it on an ordinary run: a chip that
answered *where*, *how urgent* and *shall I take it* on a surface in thumb's reach made the optimal
play never looking at the city. See [history](gameplay-history.md#finding-the-next-rider).

What stands in for them is an [edge arrow per waiting
rider](rendering.md#off-screen-fare-pointers) — the same arrow the drop-off has always had, in that
fare's own colour. It says **which direction** and **how urgent** and deliberately stops there. How
far away the rider is, what is between you and them, and whether they are worth the drive are back
to being things you find out by looking at the map and panning to them, and dispatching still means
tapping the rider or their crystal in the world.

What that costs is real and was accepted rather than solved: an off-screen rider now takes a pan to
reach, the [rider peek](rendering.md#the-rider-peek) has no trigger left on an ordinary run, and a
crystal behind a tower has nothing else speaking for it (see [corners the camera cannot
see](#corners-the-camera-cannot-see)). The [taxi finder](rendering.md#getting-back-to-the-taxi)
stays — losing your own car is not a decision, it is a lost tool.

The pan itself is the one part of that cost that was handed back: on a phone, **tapping an arrow
rides the camera to the mark it points at** ([tapping an edge
arrow](rendering.md#tapping-an-edge-arrow)). Dragging the map in a direction an arrow was already
naming, guessing when to stop, was never a decision the board was asking about — where to go is the
decision, and it is still made by looking at the corner once you get there and tapping the rider.
The arrow still says nothing about whether to take them.

### Why the first fare is close, and why that alone made it harder

The mechanic the opening has to teach is that a **tap dispatches the taxi and the drop-off
dispatches itself**, and the only way to learn it is to watch it happen end to end. A three-block
hunt for the rider followed by an unbiased draw that could land the drop-off in the far corner
spent the whole first fare — often a minute of driving — before the loop had closed once, and the
player spent that minute reading a map rather than learning the rule. One block out and one or two
back is the same lesson in a fraction of the time. The *second* fare is already an ordinary one:
this is a first-fare exemption, not a gentler opening.

The clock floor is the part that isn't obvious, and it was measured the hard way. **A short trip
budgets a short clock, and a short clock is the tight one.** The budget is `work × pace` with a
fixed reaction allowance inside it, so a fare's absolute margin scales with its length: 1.5s of a
slow player's reaction, or one red light they didn't expect, is a few percent of a fifty-second
haul and a third of a seventeen-second hop. Shipping the two caps without the floor made the run's
*first* fare the one that ended it — over 40 soak runs at a 4s reaction, runs ending on 0
deliveries doubled from 5 to 10, which is [the one failure a score-attack cannot
have](difficulty.md#what-the-sweep-found).

45s is a shade under the median first-fare clock the old three-block draw issued (47.7s, measured
over 60 seeds), so a new player gets about the time they used to get to do a fraction of the
driving. Distance is what the caps shorten; time is not. With the floor in, run length is back at
parity — median 14 fares against the old 13 at a 1.5s reaction, 11 against 11 at 4s, over 40 runs
on each of two seed bases.

The one thing that does move is the **first fare's price**: `FARE_BASE + FARE_PER_BLOCK × blocks`
on a one-or-two-block trip pays $8–11 where the old unbiased draw paid a median of $17. It is one
fare out of a run, and pricing the tutorial hop as the tutorial hop it is beats special-casing the
economy's own formula.

**The spawn radius is a constant (`SPAWN_RADIUS`, 3 blocks)**, not a point on the ramp. Budgeted
clocks pay for the distance explicitly, so how far out a rider lands changes how long their clock
is and not how hard it is. History:
[extra fares](gameplay-history.md#extra-fares-and-prioritisation).

`spawnGap` is what turns the board into a prioritisation puzzle rather than a burst: extras land
staggered, so their kerbside clocks drain out of phase and the player has to keep picking which to
serve. `tools/probe.mjs` asserts both the peak (>= 2 waiting), the minimum spacing between spawns,
and that the board never runs ahead of the curve.

Widening the stagger, incidentally, does not make the game easier — it makes the *opening* more
fragile. See [difficulty.md](difficulty.md#what-the-sweep-found).

The rider *figure* is still white whatever else is on the board — see
[The taxi's roof sign](#the-taxis-roof-sign) — so every waiting rider reads the same way, with the
diamond over their head carrying how close each one is to giving up.

### The clock is budgeted

One deadline covers **spawn to drop-off**, and it does not reset at pickup. Collecting a rider
quickly is what buys the time to deliver them, and that is the entire tension of the game.

It is not a flat number. A rider's clock is the *estimated driving their trip costs*, plus the rider
already aboard if there is one, times the run's current [pace](difficulty.md#two-dials) — and
nobody else waiting on the kerb is in it:

```
budget = rider aboard + drive to the pickup + drive to the drop-off + reaction allowance
limit  = clamp(budget × pace(deliveries), 12s, 240s)
```

The run's **first** fare takes a floor of `FIRST_FARE_MIN_CLOCK` on top of that, because the caps
on its two legs would otherwise budget it a short clock and a short clock is the tight one — see
[why the first fare is close](#why-the-first-fare-is-close-and-why-that-alone-made-it-harder).

`estimateSeconds` in `route.js` does the conversion at 3.28 s/block and 1.30 s/turn, fitted against
581 real trips. The whole design, what it replaced and how the numbers were chosen is in
[difficulty.md](difficulty.md).

Two consequences worth knowing here:

- **Urgency is proportional, not absolute.** A green diamond no longer means "lots of seconds", it
  means "you are on schedule for this rider" — which is the decision. `fares.waiting()` ranks by
  the same fraction, so the rider's edge arrow and their own diamond never disagree about who is
  next. The panic pulse below 5s stays absolute, because "about to lose this" is true regardless of
  budget.
- **A long haul no longer punishes itself.** It gets proportionally more time. The cost of driving
  one is that *everyone else's clock keeps draining while you do* — opportunity cost against the
  queue rather than self-harm.

The "queue ahead" term has exactly one exception, and it is the whole of what makes that fare hard:
a [VIP](#vip-pickups) is budgeted to be served **next**, so its clock pays for the rider aboard and
its own trip and for nobody standing on a kerb.

`ARRIVE_RADIUS = 9` is how close the taxi's centre must get to the target **junction centre** to
count as arrived — exported from `fares.js`, and the headless tools import it rather than keeping
their own copy.

It is sized off the one place the taxi can stop and *stay* stopped short of a pin: that junction's
red light. The hold line sits `HALF_ROAD + STOP_SETBACK = 7.4` back along the lane, and the lane is
`LANE = 2` off the centreline, so a taxi waiting at the target's line is `hypot(7.4, 2) = 7.67`
from the centre — measured worst case **7.69** across 548 held-at-the-target samples in the
headless sim. At 7 it was 0.4 short — the car sat on the corner beside the pin with the drop
refusing to resolve until the light went green, which reads as the game ignoring an arrival that
plainly happened. A drive-through was never affected; only a stop was.

Not larger, either. One car back in the queue is another `MIN_GAP = 5.3`, past half the 20-unit
block pitch, and resolving there would pop the rider out mid-block with the pin still a visible
distance off.

### Arrival requires direction

A fare only resolves — pickup or drop-off — if the player actually **sent** the taxi at it.

Without this rule a taxi cruising on random turns wanders into the pin by itself: measured at
**11 of 40 seeds** completing a drop-off with no tap at all. `directed` lives on the fare, is set by
whatever routes the taxi at it, and clears whenever that fare's target changes.

On the drop-off leg [the game does the routing](#the-drop-off-dispatches-itself), so the flag is
set there rather than by a tap — but it is set by the same call that plans the route, so a
drop-off still only resolves for a taxi that was actually sent at it. Where the rule keeps its
teeth is the kerb: `beginRide` clears `directed`, and a rider is only ever collected by a taxi the
player pointed at them.

There is one taxi, so `markDirected` also clears the flag on whatever fare held it before: tapping
a second waiting rider re-routes the car and moves `directed` to that rider, rather than leaving
the abandoned one still marked. Without that, the abandoned rider stayed armed — if the new route
happened to pass within `ARRIVE_RADIUS` of its corner, it resolved a pickup too, and the taxi ended
up "carrying" two riders off a single seat.

### The taxi's roof sign

The passenger **figure** is white — deliberately colourless. Before pickup any taxi could take any
rider, so a colour on the *person* would imply a commitment that doesn't exist. The crystal over
their head and [the disc under their feet](#the-disc-says-it-again-on-the-ground) are both spoken
for by the clock, which is why the figure between them has to stay out of the way.

The **roof sign** lights up while a rider is aboard and goes dark once they're dropped off — a
plain on/off, not a colour. The drop-off carries no fare colour, so there is nothing for a coloured
sign to pair with; its one job is to say at a glance whether the taxi is free. History:
[the roof sign](gameplay-history.md#the-taxis-roof-sign).

#### The drop-off is a ring, and it wears the rider's clock

The disc on the tarmac and the off-screen pointer that stands in for it are painted from the
[urgency scale](#urgency-is-one-scale), at whatever level the rider **in the car** is standing at.
Nothing floats above it.

**It has no head.** A diamond on the board means a clock, and a ring means a place the taxi is being
driven to: a crystal over the drop-off would be a second diamond reporting nothing, and the player
would have to tell "a clock is running here" from "this is just a place" by hue on two otherwise
identical shapes — when the ring is already saying "this is just a place", at ground level, where
the driving happens.

What that costs is a rooftop silhouette: a crystal would stay visible over the skyline for a beat
after the ring itself had slipped behind a tower. The
[off-screen pointer](rendering.md#off-screen-fare-pointers) covers the far end of that — a
drop-off outside the frame — and inside the frame the route band runs all the way into the disc, so
there is a line to follow to it. A drop-off briefly hidden behind a building on a road you are
already driving down is the case that is genuinely worse, and it is worth what it buys.

**The colour is the rider's clock.** Hue on a fare marker means urgency, and the drop-off has no
clock of its own — but a colour does not have to *distinguish* to be worth reading. The ring is
where the player is looking — it is the thing being driven at, at ground level, for the whole second
leg of a trip — and the deadline they are racing is the one attached to the rider in the car. Putting
that clock on the tarmac means the answer arrives without a glance up at a 29px crystal riding a
moving roof. The disc reports nothing *of its own*; it repeats what the crystal above the taxi is
already saying, in the place the eye already is. A VIP's stays its
[fixed purple](#vip-pickups) at every level, the same exception the crystal makes.

So the marker language is: **shape says what a thing is, hue says whose clock is paying for it.** A
diamond is a clock, a ring is a destination, a band is a route — and all three of them, for one
trip, are the same colour. See [rendering.md](rendering.md#the-drop-off-ring--geometrymarkerjs).

The one decision all of this defers is still deferred: nothing on a marker says which *taxi* is
taking a trip. The day there is more than one, that stays the player's call.

#### The route band wears it too

`src/game/routeline.js`, painted per frame from `fares.colorOf()` on whichever fare the taxi has
been [sent at](#arrival-requires-direction). The band belongs to the car, but the car is not the
news: a route only exists because a fare is draining at the end of it. History:
[the route band](gameplay-history.md#the-route-band-wears-it-too).

It is the **largest thing on the screen by a wide margin**: a lane-width band running across half the
city, on a road the eye is already following because that is where the taxi is going. Urgency
carried there is urgency the player takes in while doing the thing they were doing anyway, instead of
having to look away to a small shape at the edge of vision. Both the destination and the trouble
arrive in one read.

`PALETTE.routeLine`'s yellow is still the fallback for a route with no fare behind it — the
[recovery](traffic.md) re-route, and a route poked in by hand from the debug panel. A route sent
*at* a package — the [empty-seat dispatch](#with-a-rider-aboard-a-package-is-a-detour-with-the-seat-empty-a-destination)
— wears the courier's own cyan instead: a package has no clock, so an urgency hue there would be
reporting a countdown that does not exist.

## Routing

`src/game/route.js` is Dijkstra over the road network's **lanes**, instant at this size.

A lane is a directed half of one road, so it says both which junction you are heading toward and
how you got there. It has to say both, because `legalExits` forbids U-turns: a plain junction node
would plan routes that flip direction on the spot, and the car could never execute them. Successors
are `lane.onward` — the turns the network baked at that junction. A three-way, a diagonal or a
roundabout has legal moves that direction arithmetic cannot name; a lane's exits are whatever the
geometry says they are. History: [routing](gameplay-history.md#routing).

Two details are load-bearing and easy to lose:

- **Exit order is straight, then right, then left.** Dijkstra here scans the open set and keeps
  the first minimum it finds, so successor order decides which of two *equal-cost* routes the taxi
  drives. The network fixes that order at bake (`HAND_ORDER` in `roadnet.js`) rather than leaving
  it to the order edges happened to be created in.
- **Cost is read off the lane** (`lane.klass`, `lane.withWave`), not recomputed from `(i, j, d)`.
  An editor-drawn arterial has no line index to look either up by.

`tools/roadnet.mjs` asserts the ported router returns the *same route* — not merely a route — as
the grid router did, over all 5,184 `(start, heading, target)` triples on three seeds.

`planOrigin(car)` handles the subtle case: **a car mid-turn has already committed its choice**, so
planning from its current intersection produces a route whose first step is silently skipped and
every later turn lands one intersection early. Planning starts from the intersection the taxi is
*heading toward*, plus its current heading — the first point at which it can still make a choice.
It finds that intersection by asking the network where the lane the turn is landing on ends.

**Except in the run-up.** The car commits at the hold line, but that line is `STOP_SETBACK` (3.4)
short of the junction and the stretch between them is the same straight whichever way the car goes
next. So `routeTo` also plans from `crossingOrigin(car)` — the junction being crossed — while a
straight-on crossing is still in that stretch, and if turning there saves a leg it offers the plan
on `car.lateTurn`. `retakeCrossing` in `sim/traffic.js` swaps the arc for the turn, re-asking the
left-turn yield and the full-exit-lane checks the line would have asked, or refuses and leaves the
fallback plan from the next junction. Before this, a tap in that window with the rider round the
corner came back as a lap: over 480 sampled taps landing there, 44% had a shorter route by
turning, and taking it cut the mean trip from 19.4s to 16.5s. Asserted in `tools/probe.mjs`.

The route it hands back is still a list of grid directions, because `traffic.js` still stores
`car.d` and drives `(i, j)` to `(i, j)`. That conversion (`laneDir`) is the one piece of `route.js`
that only works while the city is a grid, and it comes out when the sim drives lanes directly.

### Routing to a lane

`findRoute` answers "get me to that corner", which is the right question for a rider standing on
one and the wrong one for anything reachable from a single side. The drive-through's mouth is the
case: it opens off one kerbside lane, and three of the four ways to its junction drive past it.

`findRouteOnto(from, target, d)` is the same Dijkstra with one line changed — it stops on a
particular **lane** into the junction rather than on the junction — so the two share the search and
cannot drift apart in their weights. Two things about it are worth knowing before reaching for it:
it never returns an empty route (a car already on that lane is given the shortest way back onto it,
which is a lap of the block, because "I am on it" and "the thing I wanted on it is behind me" are
the same state from inside the router), and `findRouteVia` takes it as an option, so a route band
dragged during a burger run keeps the constraint that made the trip a drive-through visit.

The version that does *not* work is worth writing down, because it is the obvious first try:
routing `via` the junction the lane leaves. `findRouteVia` plans its second leg from the heading the
first leg arrives on, and `legalExits` forbids U-turns — so a car that reaches that junction
travelling along the same road the other way cannot take the lane, and the router quietly answers
with a three-leg lap that arrives at the right corner from the wrong side. Measured on the burger
run at about one trip in five, and invisible from outside: the taxi drives a perfectly good route,
just not to the thing that was asked for. `tools/probe.mjs` now sweeps all 144 (junction, heading)
starts and walks each route to its end.

### Road-hierarchy weights

Edges are not equal cost. The signal model was tuned around a coordinated green wave on two
arterials per axis (64% green share, offsets running with the wave direction) and an
unsignalised ring around the outside. A fewest-blocks router fights that coordination — it will
happily plan a route straight up a side street when the arterial parallel to it exists.

Current weights, per block traversed:

| Class | Weight |
|---|---|
| Ring (outermost roads) | 0.90 |
| Arterial, with the coordinated direction | 0.95 |
| Arterial, against the coordinated direction | 1.00 |
| Side street | 1.00 |

Kept close to 1.0 on purpose: the router is a **tie-breaker between paths of the same length**,
not a detour finder. Aggressive weights (ring 0.55, arterial 0.70) were tried and dropped
stopped-time further, but added enough distance to erase the gain. Measured across 240 fares vs
unit weights: trip time **−3.9%**, time-stopped-at-signals **−13.7%**, average path length
essentially unchanged. Sweep via `tools/router-sweep.mjs`.

### Dragging the route

`src/game/pathdrag.js`. **Off by default:** the band drag is only built under `?drag=on`
(`routeDragOn` in `main.js`; Tyler, 2026-10-05), and the default way to bend a route is to
[tap a street](#tap-a-street-to-send-the-route-down-it), or to
[tap a package](#two-gestures-ask-for-the-same-bend). With the flag on, **press the band and pull it
sideways.** The junction under your finger becomes a waypoint, the route is re-planned through it,
and the band redraws on the same frame — so you can take the taxi round a block that has gone solid
without giving up the fare you are driving.

Tapping a rider says **where**; this says **which way**, which is the question a player is already
asking the moment they can see a queue building on the road the band is about to take.

**A single waypoint, snapped to a junction.** Not a freehand line: there is no hand-drawn path a
city of one-way lanes could honour, and a gesture that let you draw one would have to silently
throw most of it away. What the player is naming is a corner to go via, and `findRouteVia` answers
with a real drive — right-hand lanes, no U-turns, arterials still preferred, closed streets still
avoided. A drag of half a block does nothing until it crosses into the next junction's cell and
then the whole detour appears at once, which reads as the route *committing* rather than as paint
smearing under a finger.

Four things about it are load-bearing:

- **It re-plans from where the taxi is now, every frame the finger is down.** The car does not stop
  while you drag — its clock is running — so a waypoint chosen four seconds ago has to be
  re-stitched onto a route that now starts a block further on. `planOrigin` is what makes that safe
  mid-turn, and it is the same trap [the drop-off's own dispatch](#the-drop-off-dispatches-itself)
  walks into: a route planned from the intersection a turning car has *already committed to*
  silently drops its first step, and every later turn lands one junction early. Its sibling is
  `routeConsumed`, which has to be cleared on every re-plan or the commit at the end of the current
  turn eats the first step of the new plan instead of the old one's. Both failures are a route
  desync rather than a crash — the only symptom is a fare quietly timing out — which is why the
  probe drives 180 consecutive re-plans (119 of them mid-turn on the shipped seed) and asserts the
  taxi still arrives.
- **The waypoint retires when it is reached**, not when the gesture ends. Once the taxi is heading
  at it there is nothing left to detour around, and re-planning through a junction the car has
  driven *past* answers with a lap back to it.
- **Release commits what is drawn.** No confirm step and no revert. The band has been showing the
  real route the whole way, and a gesture that undid itself on release would make every frame of
  that a lie. Undo is dragging back onto the original line, which the router answers with the
  original route — `tools/probe.mjs` asserts that exactly.
- **A silly drag is refused rather than answered.** `MAX_VIA_DETOUR = 6` legs over the direct
  route. A finger that lands behind the taxi, or slips a block wide on a two-block hop, would
  otherwise be answered with a lap of the city. Under the cap the detour is taken exactly as drawn;
  over it the band simply holds still and the drag feels like it hit a wall.

**The cap is about short trips, and the numbers say why.** On a corner-to-corner run in the shipped
city the direct route is 9 legs and the *worst* waypoint on the whole map costs 2 extra — nothing
a 5×5 grid can produce comes near the cap. Only 10 of the 36 junctions cost anything at all to go
via, and **16 of the 26 the band does not already pass through cost zero**, because a Manhattan
grid is full of equal-length alternatives the router's straight-then-right-then-left tie-break
simply didn't pick. On a two-leg trip the same cap refuses 17 of the 36.

That last figure is also a warning about how to test this: "the waypoint is not on the drawn route"
is *not* the same claim as "the waypoint costs a detour", and a cap check written against the first
one goes red for a reason nobody can act on. It is asserted against real leg counts instead.

#### Double tap the band to throw the detour away

**Two presses on the band in a third of a second re-plan it the shortest way** — no waypoint at
all, the route the taxi would have been given if nothing had ever been dragged. Same destination,
same fare, same clock, same `directed`; only the *way there* is replaced, which is the one thing
the drag ever changed.

It exists because the gesture above has a failure mode that is not a bug in it. The band lies
across the road, its grab radius is a fingertip wide (`GRAB_RADIUS = 6` units, ~46px), and
**panning the map is a drag on the same surface** — so a player reaching past the taxi to see what
is coming up lands on the band about as often as they mean to. The press is spoken for, the city
does not move, and the route quietly grows a loop. Everything behaved; the player did not ask for
any of it, and getting back meant dragging a waypoint onto a line they could no longer see the
shape of.

**It is an undo without an undo stack**, and deliberately. There is no history here: a route has
one canonical shape — whatever `findRoute` answers with from where the car is *now* — and every
detour is a departure from it, so "put it back" has one meaning however many waypoints were dragged
through on the way. A stack would have to decide what a step even is on a route re-planned every
frame of a gesture, and would restore a shortest path computed from a junction the taxi drove past
ten seconds ago.

The second press is an ordinary press on the band, and three things follow from that:

- **It opens a grab like any other**, handle and bloom and all, so a reset can run straight into a
  fresh drag without lifting. That is the recovery the pair is for: throw the accident away, then
  aim properly.
- **It answers on the press**, like the grab and the snap. Held back until the finger lifts, the
  band would sit in the wrong shape under a thumb that has already asked twice.
- **It swallows the click**, through the same `didDrag()` guard a drag uses, and it does so whether
  or not the route actually moved. The band runs *through* other markers' tap targets on its way
  into the drop-off ring, so a reset near the far end would otherwise also dispatch the taxi at
  whatever pin the second press landed on — abandoning the fare it was trying to help with. "The
  route was already the shortest way" is no comfort there, because that is exactly the case the
  player cannot see before they act.

`DOUBLE_TAP_MS` is **320** and `DOUBLE_TAP_SLOP` is **32px**. The window is short for a reason
specific to this band: unlike most double taps, the *first* tap here is a live gesture in its own
right — it takes hold — so a generous window would read a deliberate press, look, press-and-drag as
a reset. The slop is not about aim (both presses have to hit the band anyway); it is about a band
that can run the length of the screen, where two presses a hundred pixels apart are two grabs at
two different places.

**The band replays its rollout sweep**, and it has to be asked to. The sweep is keyed on
`pendingTarget`'s *identity* — which is exactly right for every re-plan the game does on its own,
since the drawbridge's replan and the drag's per-frame re-stitch both pass the same target object
precisely so the draw doesn't restart on every frame. A reset passes it too, and is the one
re-plan that wants the animation anyway: the destination is unchanged but the way there has just
been re-laid, and a band that silently snaps into a different shape under a finger reads as a
glitch rather than as an answer. Hence `routeLine.replaySweep()`, which is a statement about the
drawing and so lives in `routeline.js` rather than being faked with a fresh target object.

**One press, one buzz.** A reset that fired `grab` for the press *and* `pick` for the re-plan would
put two transients ~30ms apart, which a thumb reads as one smeared buzz rather than as two events.
So the second press fires whichever is the truer account of it: `pick` when the route actually
changed — a tap that re-aimed the taxi, which is what `pick` has always meant — and the plain
`grab` when it did not, because a double tap on a route that was already the shortest way is a
press that took hold of the band and nothing more. Same gate as `snap`: the buzz reports a route
the player actually caused, never one the router declined to change.

`tools/smoke.mjs` is the only place this can be checked, because the whole of it is event handling
and there is no DOM in the node suite. It dispatches the gesture in **one synchronous burst**,
which is what makes the assertion exact rather than tolerant: no frame runs between building the
detour and resetting it, so the taxi has not moved and the route afterwards is compared against the
direct plan character for character instead of against a leg count that shrinks on its own.

#### Tap a street to send the route down it

**The band drag is switched off unless `?drag=on`** (Tyler, 2026-10-05), to test the street tap as
the only way to bend a route. The double-tap reset goes with it.

`src/game/streettap.js`. **A tap on bare road re-plans the trip down that street** — same
destination, same fare, same clock, the drag's decision without the drag's aiming. It is the
package tap (`divertToParcel`) for plain road.

- **A street, not a junction.** `findRouteAlong` (game/route.js) tries both lanes of the tapped
  block as a `findRouteOnto` to the far end and keeps the shorter. A route through either *end* of
  the street could touch the corner and turn away without driving the road that was tapped.
- **Everything else wins.** The picker hands a tap here only when nothing pickable was under it, so
  riders, pins, packages, the depot, the burger joint and the taxi all keep their taps. A tap on a
  roof is not a tap on the street behind it: the ground point is checked with `sightlineClear`.
- **Within `STREET_SLOP` (2) of the kerb** counts as the street; the middle 8 units of an ordinary
  block answer to nothing. In a junction box the arm whose centreline is closer wins.
- **Capped at `STREET_TAP_MAX_DETOUR` (4) extra legs**, tighter than the drag's 6: a drag shows the
  detour growing before it is let go, a tap takes it in one go. Refusals are silent and the band
  not moving is the answer.
- **A tap on a street the plan already drives does nothing**, including the block the car is on.
  That is also what keeps a tap on the band (the first half of the double-tap reset) inert.
- **Spent when planned**, like the package tap: nothing remembers the street, so the next re-plan
  (a pickup, the drawbridge, an overtake detour) is free to drop it.
- **Stands down during a burger run or a repair visit**, whose destinations are lanes; their own
  `reroute` carries that and a junction-level plan would drop it.

Acknowledged with the band's rollout sweep, the drag's grommet landing on the new stretch and
letting go (`pathDrag.ping`), and a `pick` buzz — only when the route actually changed.

#### The grab flourish

A finger landing on the band has to be answered **on the band**, and answered before anything has
moved — the player is being told "this is a handle" at a moment when they have not yet pulled it.
So the whole response is a lift of what is already there rather than a new object appearing:

| | what it does | what it says |
|---|---|---|
| Whole-band lift | +0.30 on the alpha, everywhere | the thing you grabbed is the *route*, not this stretch of tarmac |
| Bloom at the finger | +0.50 more, Gaussian over ~11 units | and **here** is the point that moves |
| Thickening | +30% on the band's half-width | something has taken weight |
| The handle | a ring on the road under the finger | this is the object; it goes where you go |

It snaps on over 0.06s and settles off over 0.18s. A grab has to feel instant or it reads as lag on
the one gesture whose entire promise is that the path answers your finger; letting go is not news
in the same way.

Two numbers were measured and moved. The bloom pushed **0.45 toward white** at first and the core
went fully white over the additive blend, so the band lost its colour exactly where the player was
looking — and that colour is [the fare's clock](#the-route-band-wears-it-too), which is the one
thing on the band worth reading. Washing it out at the point of contact is the one place it must
not go. At 0.30 it is a hot version of whatever hue the band is wearing rather than a white. (The
number was measured when the band was the taxi's yellow, and survived the move to the urgency scale
because it is a lift rather than a colour of its own.)

And **the handle was additive yellow, and vanished.** It sits at the centre of the brightest thing
in the frame — the band's own bloom — and adding light to a blown highlight changes nothing. It is
[the crystal's black rim](#what-the-crystal-does) again: a marker cannot outline itself in the
colour it is standing on — and on a band that walks green to red over a run, black is the only
colour that survives all four. So the handle *subtracts* first. A darkened disc punches a hole in the
glow and the bright rim reads against that hole rather than against the road, which comes out as a
grommet in the paint — which is what the thing actually is.

#### Why the press has to be on `window`

The grab listens for `pointerdown` on **`window`, in the capture phase**, and stops propagation
when it takes hold. Not on the canvas, where everything else in this game listens.

Both this and [drag-to-pan](#picking) want the same press, and the band must win it. Registering
after `attachDragPan` does not achieve that: listener order *within one element* is registration
order whatever the capture flag says, so a capture listener on the canvas still runs second. An
ancestor's capture phase is the only ordering that holds regardless of which module happens to be
constructed first. Get it wrong and there is no error — the map slides out from under a drag that
was meant to move the route, which every headless tool here is blind to. `tools/smoke.mjs` asserts
the pair: a drag on the band re-routes and does not pan, and a drag anywhere else pans.

The click the browser synthesises after a drag is swallowed by the same `didDrag()` guard the
camera's `didPan()` uses, so a pull that happens to finish over a rider does not also dispatch the
taxi at them. A [double-tap reset](#double-tap-the-band-to-throw-the-detour-away) raises the same
flag, for the same reason one layer along: it is the other gesture this band answers by itself.

## Picking

`src/game/pick.js` raycasts against objects that opt in via `userData.pickable`, a string kind. The
ray walks up each hit's parents to find the tag, so a click on any child of the taxi group counts.

Still a plain `click` handler, even though the camera drag-pans now. The disambiguation lives in
`attachDragPan`: a press only becomes a drag once it crosses `PAN_SLOP = 8px`, and the picker
ignores the click that closes out one. So a tap is an ordinary click and only a gesture that
actually moved the map is swallowed. This is exactly why `city-lab`'s `attachCameraControls`
(which binds pointerdown to dragging unconditionally) is still unused here; it fought
tap-to-select.

**A finger is answered on `pointerup`, not on that click.** iOS withholds the click it synthesises
after a tap whenever something actionable *appears* during the tap — WebKit's hover-menu heuristic
reads it as "hovered, and a menu opened". The tap that tripped it was the rider right after an edge
arrow's pan: the arrow's pan disarms the taxi-finder chip, which fades in `SHOW_DELAY` after the
camera lands, which is when the player taps the rider the arrow found. First tap dead, second fine
(the chip is already up). Pointer events have no heuristic in front of them, so a touch press that
lifts within 8px picks on the lift, and the click that follows it (if WebKit sends one) is dropped
as its echo (`CLICK_ECHO_MS`). The press is recorded on `window` in the capture phase, because a
press on the route band is stopped there by `pathdrag.js` and a plain tap on the band still has to
reach the pin it runs through. A mouse keeps `click`, which is also what `tools/smoke.mjs` dispatches.

### The tap target

Every marker carries an oversized invisible tap target — the visible figure is a handful of pixels
at play zoom and would be miserable to hit. It is a **quad drawn flat against the screen**, on the
kerb corner, covering the marker's own silhouette: 89px wide, and tall enough to reach from the near
edge of the disc up to the top of the crystal (90px for a rider, 65px for a bare drop-off mark).
`BILLBOARD` in `game/camera.js` faces it at a camera that never rotates, so it is a constant rather
than a per-frame billboard.

A box would get this wrong twice over. What the player aims at is the figure on the kerb, which
`cornerFor` (in `game/fares.js`) pushes 4.5 units off the junction on *both* axes, so a region
centred on the junction is offset from its own marker. And the camera looks down a 33° diagonal, so
any height in a 3D target throws its top face up-screen of its base and over the marker beyond it —
and since [`pick.js`](#picking) takes the *nearest* hit, the nearer box wins. History (the box this
replaced, and how it misfired): [picking](gameplay-history.md#picking).

A quad in the screen plane has neither problem: what it covers is what you see, and offsetting it
along the camera's own up axis raises it in frame without moving it in depth, so the whole target
sits at its corner's distance. **Nothing overlaps any more.** One junction along a road is 14.1 screen
units sideways (and 7.7 down); one straight down the screen diagonal is 15.4 down and nothing
sideways. Every other pair is one of those or further, so a target under 14.1 wide and under 15.4
tall can never share a pixel with another — and a rider's is 11 × 11.1, a bare mark's 11 × 8.
Ambiguity is gone rather than resolved. `tools/probe.mjs` drives the real picker over a 3 × 3 patch on a
390 × 844 frame and asserts both halves: every aim point on a rider selects that rider, and no pixel
is contested.

**Which** pin was tapped is the instruction, not just that one was: `fares.fareFor(hit.object)`
walks up from the hit to the fare that owns it. Tapping a kerbside rider while already carrying one
is refused rather than routing a taxi that could never collect them.

**The taxi is permanently selected.** There is only ever one, so a selection step was pure
ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap on a
fare do nothing.

### The tap pops

`src/game/selectpop.js`. A tap that lands **swells and lights** the rider *and* the crystal over
their head, then settles them back, over `POP_TIME = 0.4s`:

| | rest | peak | on the way back |
|---|---|---|---|
| rider figure | ~26px | ~33px | dips to ~25px |
| crystal | ~29px | ~38px | dips to ~28px |

with a light that comes up on the same curve — the crystal's emissive from `0.35` to `1.05`, the
figure's from black to a `0.3` white lift — and fades out by 0.29s.

It exists because nothing else answers the tap *where it happened*. What the tap means — the taxi
has been sent — is said by the route band, and that starts a junction away from the finger and runs
off across the city. On the corner itself the frame after a tap that landed looked exactly like the
frame after one that missed, which on a rider a handful of pixels tall is a real question a player
was left to answer by waiting.

Four things it is careful about:

- **One envelope, shared.** The figure and the crystal have different owners (`fares.js` and
  `faremarker.js`) and different amplitudes, but they take their zero from the same frame's
  `state.elapsed` and ride the same curve, so they read as the fare reacting rather than as two
  objects that happened to be tapped at once. Phase alone is enough to break that: the first cut
  stamped the figure at the tap and the crystal on the next tick, and the two ran a frame apart.
- **The light is a lift, not a colour.** Hue on a fare marker means urgency, so a tap may not
  repaint anything — it turns up what each object is already emitting. The crystal can take a lot of
  it (its emissive *is* its own hue, so it saturates rather than washing out); the rider cannot,
  being a pale figure to start with, and at `0.45` the peak clipped them to a featureless white blob
  with the raised arm swallowed into the torso. The light also rides the fill, so an almost-spent
  crystal flashes on the liquid it has left rather than lighting up the empty glass above it.
- **Scale only, no hop.** The [level-change kick](#what-the-crystal-does) swells *and* lifts the
  crystal, and the lift is its signature. A pop that also left the ground would read as the clock
  having stepped on the frame the player tapped, which is news the marker must not invent.
- **It undershoots — but only the scale.** The envelope crosses back through rest and dips under
  before it lands. Decay alone spends its last third as a barely-moving object slowly stopping,
  which reads as lag; the dip gives the eye an ending to see. The *light* is clamped at zero over
  the same stretch, because a marker going dim reads as having been switched off rather than as
  having finished.

It fires from `markDirected`, which is where every entry point — a tap on the pin, and a tap on a
[rider-finder chip](#finding-the-next-rider) under `?chips=on` — lands once the route has actually
been planned, so a
selection that was refused never pops. Waiting fares only: the drop-off is a disc on the road with
nobody standing on it, and the taxi dispatches itself there. Re-tapping a rider the taxi is already
on its way to pops again — it acknowledges a gesture rather than reporting a state, and a second tap
that did nothing reads as a tap that was swallowed. Shot mode passes `{ pop: false }`, since a
staged dispatch is not a finger.

## The fare's clock travels

`src/game/faremarker.js`. The countdown is a **physical object that belongs to the fare** — not a
HUD number, not a property of a marker, and not something that changes hands. A **plumbob** floats
over the rider's head on the kerb — a crystal hanging point-down at the person it belongs to, the
way a plumb bob indicates a spot on the ground — painted by how much of their clock is left:
green → yellow → orange → red, [by level](#urgency-is-one-scale) — and [draining like a
glass](#the-crystal-is-a-glass-of-time) between those steps. The instant they get in it **flies to the taxi**
(`TRANSFER_TIME = 0.65s`, eased, with a small arc) and keeps draining above the roof, because from
that moment the deadline is the car's problem.

**The rider getting in and the deadline moving into the car are one gesture.** Nothing is created or
destroyed at the hand-off — the same object leaves the kerb corner it has been standing on and
crosses to the roof, which is the whole reason the flight is animated rather than a teleport. It is
also why the marker holds **one altitude** on both ends: the transfer reads as sliding sideways
rather than climbing into a different slot.

That flight is tuned against `BOARD_SECONDS = 0.9`, so the clock lands on the car a beat *before*
the rider figure finishes climbing in. The deadline arrives, then its owner does.

### The disc says it again, on the ground

A waiting rider stands in a **disc in their own urgency colour** — the same hue as the crystal over
their head, on the [drop-off's own shape](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock).
One hue said twice: at eye level, where the eye happens to be, and on the road, where the taxi is
actually being aimed. It also survives what the crystal does not — a rider behind a tower still has
a mark on a plane the buildings mostly don't cover.

It never drains. Time is the colour's job; the disc only has to say "here".

**A fare owns one disc at a time, and it moves.** The rider's goes dark the instant they board and
the drop-off's lights on the same frame — the hand-off the crystal makes in the air from the kerb to
the taxi roof, made on the ground from one end of the trip to the other. So the shape means "a place
this clock is attached to" wherever it is, and what tells the two ends apart is whether anyone is
standing in it: a disc with a figure in it is somewhere to collect, an empty one is somewhere to
deliver. A disc left glowing on an empty pavement would read as a second fare, which is exactly why
it goes out.

### The panic pulse, and what depth-testing costs

Below 5 seconds the crystal beats, a ~3.5Hz sine scaling between 1.0 and 1.15, on the kerb and in
the car alike — a rider about to give up is exactly as urgent as a delivery about to fail.
Threshold in seconds, not fraction, so "five left" stays five left whatever the clock was budgeted
at. The pulse and the red level are the same object, so the two urgency cues stack rather than
compete for the eye.

The diamond is an ordinary depth-tested object — an inverted-hull crystal cannot skip the depth test
without painting its own back faces over its front ones — so a taxi behind a building takes its
clock with it. The taxi's own [ghost outline](rendering.md#taxi-ghost-outline--geometryghostoutlinejs)
still says where the car is; the seconds are what you lose sight of. A disc still lies under a
waiting rider, but a depth-tested one, so it is occluded by the figure standing in it.

History (the timer ring this replaced): [it used to be a relay](gameplay-history.md#it-used-to-be-a-relay).

### The crystal is a glass of time

`src/geometry/diamond.js`. The diamond is a **vessel**, and the clock is the liquid in it. Below the
surface the urgency colour is opaque, saturated and self-lit — exactly what the whole crystal used
to be. Above it is emptied glass: the city visible straight through it at 0.15 alpha, darker than
the liquid and mostly drained of its hue, with a sheen on the facets turned edge-on to the camera. A
pale band rides the line between them, and that band is the part the eye actually reads.

So the two hands of the clock are on one object. The **colour** steps in quarters and kicks, which
is the alarm; the **level** moves every frame, which is where inside that quarter the fare actually
is. Green isn't one state any more — a fresh rider is a solid crystal and a rider a breath away
from yellow is a crystal two thirds full. It is the [ring's continuous
sweep](gameplay-history.md#it-used-to-be-a-relay) recovered without a second object to learn.

The level is **linear in height**, not in volume. Volume would be the physical answer and it reads
much worse: the crystal is widest a third of the way down from its top, so a volume-true drain would
spend most of the clock in a narrow band up there and then fall through the whole taper in the last
few seconds. (It was wrong on the octahedron too, which at least drained symmetrically.) The player
reads where the line *is*, so equal time has to be equal travel. Both ends overshoot the tips
slightly, which is what makes a full fare a plain solid crystal and a dead one a plain empty vessel,
with no highlight stranded on a vertex.

It is **one mesh with a per-fragment alpha**, split in the fragment shader — same silhouette, one
draw call, and the bounce, the kick and the pulse keep animating a single object. The cut is in the
geometry's **local Y**, so the liquid rides in the vessel instead of sloshing when the marker hops.

### Getting the empty half to look empty

The empty half has to read as an empty vessel, not as a dark solid.

What stood in the way of real transparency is the **black inverted hull**. It is a larger copy of the
crystal drawn back-faces-only, so its far faces cover the entire silhouette — glass over it shows a
black void rather than the city. The fix turned out to be draw order rather than a different outline:

> The crystal draws first (`renderOrder` 8) and **writes depth**, blending over the finished opaque
> scene. Then the hull draws (9) with the depth test on. Inside the silhouette its back faces are
> behind the glass and fail the test; the ring between the two silhouettes has nothing in front of
> it and passes. That ring is exactly the rim. Both are flagged `transparent` only to land in the
> same queue, which is the one place `renderOrder` decides anything — well clear of the [ghost
> outlines](rendering.md#taxi-ghost-outline--geometryghostoutlinejs) at 9990+, which already treated
> this marker as an occluder back when it was opaque.

`depthWrite` staying **on** for a transparent material is the load-bearing part, and it is the
opposite of the usual habit.

Two numbers were measured and moved (the empty glass's saturation is the next section's):

- The **sheen exponent** went from 2.5 to 5. At 2.5 it was not a highlight but a wash: very little
  of the crystal is truly head-on at this camera angle, so every visible facet picked up most of the
  lift. At 5 it stays on the two flanks either side of the front ridge.
- The **emissive** above the line, and the **alpha**, move as a pair. See below.

### Why alpha is the contrast knob, and what it cost to find out

The glass is `0.15` alpha, `s × 0.3`, `l × 0.38`. Alpha is turned first because it cannot be
swallowed by the backdrop:

> Every other knob here separates the halves by *value*, and a value gap can be swallowed whole by
> whatever the marker happens to be floating over. **Alpha cannot.** What alpha lets through is the
> city behind the crystal, which is by definition not the liquid's colour, so lowering it widens
> the gap whichever direction the backdrop happens to lie in.

The saturation cut is what makes it read at a glance. At 0.15 there is almost no ink in the empty
half to be dusty-rose *with*, so what a saturation cut buys there is not a second hue competing with
the alarm. It is a **segmentation** — the crystal splits into a saturated part and a glassy grey
part, and the eye makes a categorical judgement at a glance where it has to *measure* a value
difference. Value comparisons are precisely what kept failing at 22 pixels. History (two passes
and an overturned rule):
[why alpha is the contrast knob](gameplay-history.md#why-alpha-is-the-contrast-knob-and-what-it-cost-to-find-out).

The alarm still carries. It carries on the liquid, which is the dominant mass for three quarters of
every clock, on the [disc on the kerb](#the-disc-says-it-again-on-the-ground) under the rider, and on the route band
— all three at full hue. What it no longer has to do is carry on the part of the marker whose entire
job is to look empty.

**The emissive moves against the alpha, not with it**, and that is a correction rather than an
inconsistency. What reaches the frame is the product of the two, and the product is what has to hold
still: alpha does the separating by day, when there is a lit city behind the glass to separate
against; after dark there is no city, the black rim is invisible on a black road, and the emissive
is the only thing drawing the empty half at all. Each cut to the alpha has to be paid back, or the
night marker loses its top half entirely — a worse bug than the one being fixed. `0.6` at α 0.45,
`0.45` at α 0.28, `0.8` at α 0.15: all three land within a couple of hundredths of the same 0.12.

Two notes on the band. Its extra half-pixel was **not** free, and the price is paid at the ends of
the clock: the fill overshoots the tips by exactly one band at each end (so no highlight is ever
stranded on a vertex), which costs about 8% of the travel at each extreme rather than the old 7%.
Nobody reads a clock at "full" or "empty" — the colour says that — so it is a cheap place to spend,
but past about 0.22 the band stops reading as a surface in the crystal and starts reading as a
stripe across it. Which is why the **core** was widened instead (`0.4 → 0.65`): two thirds of the
band held flat with a third left to feather arrives as an edge with a shoulder rather than as a
gradient with a bright middle, and unlike the width it costs nothing at the ends.

**What is still unspent.** The level is [linear in height](#the-crystal-is-a-glass-of-time), and the
plumbob is widest two thirds of the way up with a long taper below — so the *area* below the line is
not proportional to the fraction, and the back half of every clock lives in the narrow part. That is
a deliberate trade (equal time has to be equal travel, and volume-true is much worse), but it is the
remaining reason a half-spent fare looks emptier than it is, and no amount of contrast addresses it.

### The far wall, and why it isn't there

Only the **near** half of the liquid's surface is drawn, and the near half of a horizontal plane
projects low — so at half full the level reads closer to a third. Drawing the far wall as well
would close the chevron into a rhombus centred on the true level, but the far wall's liquid is a
solid slab that shrinks the see-through top to a narrow wedge, and the two meniscus bands close into
a bright rectangle that reads as a label. More correct, less legible. History:
[the far wall](gameplay-history.md#the-far-wall-and-why-it-isnt-there).

What is left is a known bias: the surface reads slightly low, by a chevron about 8px deep at play
zoom. It is the same shape at every level, so it offsets the reading rather than distorting it, and
the chevron's outer corners — where it meets the silhouette — sit at the true level anyway.

> **Trap.** A patched material needs `customProgramCacheKey`. Three builds the program cache key
> from the material's parameters *before* `onBeforeCompile` runs, so a patched Lambert material
> collides with every unpatched one sharing those parameters and `acquireProgram` hands back
> whichever compiled first. This city is full of flat-shaded Lambert: the diamond drew with a
> building's program, and the fill went missing with nothing logged anywhere.

> **Trap.** Under `flatShading` three takes the normal from the screen-space derivative of the view
> position, which follows the triangle's *rendered* winding — so on back faces it points into the
> screen and the surface lights as if the sun were behind it. Three's own `FLIP_SIDED` never reaches
> this path; it only fixes the interpolated-normal one. `patchFill`'s `flipped` argument is what the
> far-wall experiment left behind, and any back-face pass on this shape will need it.

### What the crystal does

**A level change kicks it.** The crystal swells to 1.1 and hops about 4px, snapping up and easing
back over `KICK_TIME = 0.36s`. The colour snaps between four steps and is the news, but a hue change
on a 29px shape at the edge of the eye is easy to miss outright — and the ones that matter land
while the player is watching the road, not the kerb. The motion is what buys the glance; the colour
is what pays it off. It is deliberately a *beat* and not a state: over well before the next level
lands, so two fares at different levels are told apart by hue and never by whether something is
moving. A fresh rider does not kick on spawn — a marker that pops the moment it appears is
announcing a change that hasn't happened.

**Its outline is one weight, always** — `RIM_SCALE = 1.12`, about 1.7px of rim at play zoom, on the
kerb and over the taxi alike. A heavier outline is a *border* rather than a rim — heavy enough to
change the silhouette — and a marker that swaps outline weight at the hand-off reads as two markers
in relay rather than one clock travelling. The route band already answers "which rider?", along the
whole road instead of on one corner. Black is the rim's colour because this crystal spends a quarter
of every clock *being* yellow, so a yellow rim on a yellow diamond is no rim at all.

A **diamond on the board means exactly one thing: a clock is running here**, which is why the
[drop-off](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) does not wear one. History:
[what the crystal does](gameplay-history.md#what-the-crystal-does).

### Urgency is one scale

`src/game/urgency.js`. Four levels, even quarters of the clock, each with its own colour.

Four surfaces show it — the fare's diamond wherever it currently is, the
[ring on the road](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock) the taxi is being driven
at, the [route band](#the-route-band-wears-it-too) running between them, and the [edge
arrow](rendering.md#off-screen-fare-pointers) that stands in for any of them off the frame — and
they all read from here, through one `fareColor(level, vip)` that also owns the VIP exception. A
rider showing orange on the map whose arrow is yellow on the edge is two answers to one question,
and a band arriving red at an orange disc is the same mistake drawn across half the city.

The [VIP](#vip-pickups) is the exception all four make together, and it is a total one: purple at
every level, and the crystal's fill — the one surface that carried a *quantity* rather than a hue —
is held full. A VIP does not say how long you have.

Even quarters, so no level is held longer than another. `URGENCY_SEGMENTS` is how many steps the
scale has.

Per-rider patience is not in yet — every rider's clock comes from the same
[budget](#the-clock-is-budgeted). The seam is `urgencyOf(fare)` in `fares.js`: a patience mechanic
changes what goes into that function and nothing downstream of it, because every surface already
speaks in levels rather than seconds. History: [urgency](gameplay-history.md#urgency-is-one-scale).

## Economy

`$0` at top left. On delivery a green **fare price pops off the taxi itself**, rises for a beat,
then **flies to the counter** at the top-left. When it lands, the counter bumps green and its
number **rolls up** from the old total to the new one.

Two phases rather than one because the payout has to travel from *the world* to *the HUD*: a
number that jumps up without a visible link between the drop-off and the counter reads as a
side effect. `popEarning()` projects the taxi's world position to anchor phase 1, and
`counterScreenPos()` reads the counter's live viewport rect to aim phase 2 — resolved at launch,
so a mid-run resize still lands each flight where the counter actually is now. `rollMoneyTo()`
tweens the digits on rAF (not a CSS transition) so a second delivery arriving mid-roll re-aims
the same animation at the new total instead of two counters racing. Roll length scales with the
payout (~50ms per dollar, clamped) so a `$8` hop reads as a quick bump and a `$35` haul as a
longer roll.

**It runs backwards too.** The [burger](#the-burger-run) and a [repair](#repairs-at-the-depot) take
cash off the player, and they take the same two phases wearing the other sign: a red `−$10` off the
taxi, the same flight to the counter, the same roll, and a red dip on the counter instead of the
green swell (`.money-charged` against `.money-bumped`). Same direction across the screen,
deliberately — a number flying from the counter *to* the taxi would read as the player being handed
something. `rollMoneyTo()` tweens either way, and the total never goes below zero (see `charge()`
in `game/fares.js`).

### The combo meter

Every combo the taxi lands on a job steps a multiplier up, and the drop-off pays the fare at it
(`game/combometer.js`, Tyler's idea after the Duolingo combo streak). It starts each ride at ×1: an
overtake or a bootleg U-turn +0.5, a drift kick +0.5 per chain tier (so a full chain of three is
+3), **Stuntman** +1, the bridge launch +2, capped at ×5.

Stuntman is smashing through a [roadworks](traffic.md#roadworks-a-street-closed-at-both-ends)
barricade, at any speed (Tyler, 2026-10-14). It also pays a sixth of the Loco tank back on the
energy bits a drift kick uses, the same refund as the first kick of a chain (`DRIFT_CHAIN.fuel[0]`).
The refund lands whether or not there is a job in hand; the step, like every combo, only on one.
The zone comes up once a run, so this is a once-a-run move; the router already prices the closed
street cheap and aims a drop-off at it, so a player on a fare usually gets the chance.
`?stuntman=classic` makes the smash scenery again: no step, no refund. Combos only count on a job — from the tap that sends the
taxi at a rider, through the pickup, to the drop-off (`fares.job()`) — so a stunt done idling
between fares builds nothing.

It shows as `3x` centred on the cash row with the Loco tailpipe flame burning out of its left
(`updateComboTag` in main.js), only above ×1 and only while a job is in hand. There is no bar,
because the meter has no full state. The flame is Loco orange; a build that climbed the drift
chain's colours with the multiplier didn't read (Tyler). A step up rolls the count: the new number
slides up and pushes the old one out, with a bounce. Two things empty it back to ×1: **any hit that
costs HP**, and **the job walking out** — a rider whose clock runs out while they are aboard, or
while they are the one the taxi was sent to collect (`combo.walkout` in `main.js`, `walkout` in
`game/combometer.js`). The meter shakes side to side and drops out of sight. A reset rather than a
tier down, because the drop is where the tension is.

The drop-off cashes it in (`popComboPayout`): the fare's price pops mid-screen, the meter flies down
into it, the price punches and rolls up to the multiplied total, and that one number flies to the
counter. The verdict reaches the fare loop through `createFareSystem`'s `judgeRun` hook. It is read
there rather than stamped at spawn like the rest of a price, because it is about the driving, and
nothing shows a price before the drop-off for it to contradict. It multiplies everything the
drop-off pays, the robbery's clock bonus included. A [package](#the-package-courier) is never
multiplied.

`?combo=run` keeps the meter across fares instead: a drop-off pays at it and leaves it where it is,
so only a crash ends a streak.

History — the shift multiplier, the clean-driving streak, the run bonuses and the Perfect Run that
came before this: [the combo meter](gameplay-history.md#the-combo-meter).

### Priced by the trip

Each fare is priced by **trip distance**, not a flat rate: `FARE_BASE + FARE_PER_BLOCK × blocks`,
where `blocks` is the Manhattan distance between the pickup and drop-off intersections. The
price is fixed at spawn — the moment both endpoints are known — and stamped on the fare so a
long haul that runs into traffic pays the same as one that flies through green lights. Metering
during the trip would double-count the clock and reward Loco Mode for the wrong reasons.

The player does not see that distance before choosing (see
[Neither how far nor where](#neither-how-far-nor-where)), so the price is a fact about the trip
rather than a term in the decision.

What a long haul costs the player is no longer the clock it eats — the clock is
[budgeted from the trip](#the-clock-is-budgeted), so a long one gets proportionally more time. It
costs the *queue*: every other rider's clock drains while you drive it. Paying more for it is the
game being fair about that afterwards, exactly as before; only the mechanism it is fair about has
changed.

The [combo meter](#the-combo-meter) is the one thing applied later, at the drop-off; the table below
is the 1× column.

| Blocks | Price |
|---:|---:|
| 1  | $8  |
| 3  | $14 |
| 5  | $20 |
| 8  | $29 |
| 10 | $35 |

Calibration: median trip in the current city is ~5 blocks, which pays `$20` — the old flat rate —
so the soak suite's expected earnings are roughly where a flat fare put them. History:
[priced by the trip](gameplay-history.md#priced-by-the-trip).

## VIP pickups

`src/game/fares.js` and `src/game/faremarker.js`. A rare rider layered on top of the ordinary
board — their diamond opens on a fixed purple, never drawn from the urgency scale, so "this one is a
VIP" is never confused with how much time they have left, and every other surface that fare speaks
through follows it: the ring on the road at the far end of their trip, the route band driving at it,
and the off-screen arrow.

**They do not wear a crystal.** Where every other rider has a plumbob, a VIP has a chunky purple
**question mark** (`geometry/questionmark.js`) in the same slot, rocking slowly so its extrusion
shows. A plumbob that never drains is a timer-shaped thing refusing to tell the time; the question
mark says what is actually true — you do not know how long this one gives you — and says it with the
silhouette, which carries further than a hue. It copies the hidden crystal's pose every frame, so
the bounce, kick, pulse, pop and refusal shake all land on it unchanged.

**And that is the whole of what they will tell you.** A VIP's clock is not shown anywhere: the
question mark is solid purple and never drains. You know one is worth three fares and you do not
know how long you have, which is what makes taking one a gamble instead of a sum. The only thing
that ever breaks the silence is the panic pulse the marker beats under five seconds, and that is an
alarm rather than a countdown: it says *now*, not *how long*.

Everything else about a VIP is the ordinary fare loop with four numbers turned:

- **The shortest clock on the board.** Budgeted the same way as everyone else's — served next,
  from the driving the trip actually costs, plus the same reaction allowance — but at a fraction of
  the run's own pace (`VIP_PACE_FACTOR`, floored at `VIP_MIN_PACE`, about as fast as Loco Mode
  gets round the map). Letting one go is never a strike.
- **Triple pay.** A VIP pays the ordinary distance price times `VIP_PAYOUT` (3), stamped at spawn,
  and then the [combo meter](#the-combo-meter) at the drop-off like anyone. History:
  [VIP pickups](gameplay-history.md#vip-pickups).
- **A full tank on delivery**, rather than the ordinary third. `main.js` reads the boost meter's
  current fraction at the moment the delivery's energy bits land and tops up exactly what's missing,
  so a VIP always leaves Loco Mode topped off regardless of what was left in the tank going in.

What the numbers are worth, measured over 20 auto-played runs at a 1.5s reaction (the harness in
`tools/autoplay.mjs`, driven from a scratch copy that counts VIP events):

| | landed | seconds left at the drop-off |
|---|---|---|
| Queue-budgeted clock, player serves the kerb in urgency order | 55% | 13.0 |
| Queue-budgeted clock, player drops everything for the VIP | 78% | **63.9** |
| Shipped clock, player serves the kerb in urgency order | **20%** | 7.2 |
| Shipped clock, player drops everything for the VIP | 86% | 8.8 |

The middle row is what was wrong with the old one: a minute of unspent clock is not a hard fare, it
is a free one wearing a countdown. The bottom two rows are the choice — go now and you land it with
seconds to spare, leave it in the queue and you lose four out of five.

**Missing one is still not a run-ending event.** Every ordinary fare's clock hitting zero ends the
run — that is the entire tension of the fare loop. A VIP is the one exception: its clock running out
takes the fare off the board, empties the [combo meter](#the-combo-meter) if the taxi was on its way to them, and the run carries on. It stays pure upside by
construction: taking one on can only make a run better, never worse, which is what lets it stay
optional without ever being a trap even now that it is genuinely hard.

### They leave, and they let you know

What a miss *looks* like is the rider walking out. Until it did, the only evidence was a payout that
never arrived — the diamond simply stopped, exactly as a delivery does, and the cost (the fare and
the streak behind it) had to be inferred. So `beginBail` in `fares.js` hands the figure to the same
`exits` list a delivered rider uses and plays `person.bail`: out of the moving cab if they were
aboard, off the kerb if nobody ever collected them, then a fast run and a fade. The taxi is released
on the same frame — an empty seat, or a route to a corner with nobody on it.

Over their head, `geometry/cursebubble.js`: a jagged outburst bubble with `%#&@!!` in it. Every mark
is geometry — six little stroke-and-dot glyphs merged into one mesh, drawn in the screen plane by
the constant orientation the fixed camera makes possible ([rendering.md](rendering.md)) — because
there is no font in this project and a canvas-drawn label would be the one thing on the board that
is a picture of writing rather than a built object. At play zoom it is about 57px wide and each
glyph is 7px, which is a grawlix doing exactly its job: it reads as swearing and never as any
particular swear.

Where they run is the one part with a rule behind it. **Not the diagonal**: a kerb corner sits half
a unit inside its block and buildings start 0.85 in, so the obvious "away from the junction"
direction ends with the rider standing inside a shopfront, invisible for the whole animation. A
rider who gave up on the kerb walks off *along* it, on one axis, staying at their own kerb's fixed
distance from the road; one who jumped out mid-street runs at the kerb corner of the junction the
taxi is at and no further than it.

**An ordinary fare's clock running out plays the same thing**, and it is the closing shot of the run.
The endings a wreck and a bust get are events happening to the taxi; this one had nothing to look at,
so the camera used to pull in on the corner that was never reached and hold on a pin. It now pulls in
on the rider walking out on you — the same `beginBail`, from the same call site, with the run ending
around it — and the retry screen waits for the whole 2.2 seconds of it
([rendering.md](rendering.md#the-closing-shot) has the timing arithmetic, which is not trivial: the
delay is wallclock and the bail is in sim time under a slow-mo ramp). Two things differ from a missed
VIP, both of them because the run is over rather than carrying on: the drop-off ring is left standing
instead of hidden, so a trip that died within sight of its corner has both in frame; and
`fares.update` keeps ticking `updateExits` past `gameOver`, which is the only reason the animation
plays at all.

Rare on purpose — a cooldown (`VIP_COOLDOWN`) plus a per-opportunity chance (`VIP_CHANCE`), checked
only when the board is about to refill and no other VIP is already on it. Both are tuned against
the fare soak (`tools/soak.mjs`): frequent enough to be a real event, not so frequent that
forgiving misses meaningfully padded the survival curve. Never on the tutorial fare
(`VIP_MIN_DELIVERED`) — nothing on the board yet for a purple diamond to be distinguished *from*.

## Getting caught

One rule each way, the same for every cop in the game — the patrol cruiser, a getaway's fleet, a
roadblock, the arrest crew at a drop-off (`game/patrol.js`, "The capture model"; Tyler, 2026-10-14):

- **Hitting a cop is hitting a car.** HP off by closing speed, the same `bumpDamage` as anything
  else ([bumps and hit points](traffic.md#bumps-and-hit-points)), whoever did the hitting. A flat-out
  hit can still be the wreck — it just has to be the one that empties the HP. So a
  [roadblock](#they-box-you-in) is something to smash through on the pill, at a price.
- **"Busted!" is being stopped with a cop on you.** A chasing cop touching the taxi while it is doing
  under `PIN_SPEED` (3 u/s, a third of cruise) for `PIN_HOLD` (0.75s) — boxed in, rammed to a stop at
  a junction, nosed into a roadblock. The clock runs back down when the taxi gets free. A cop that
  rams a taxi still doing a speed lands a hit (HP, the bump's knock) and drops back for
  `RAM_BACKOFF` (1.5s) before it tries again. A getaway's cops arrest the same way once the alarm is
  up; the arrest crew at a drop-off never does.

The pin is not the proximity meter the patrol had before contact became the catch: that one filled
on a cop being *near* a slow taxi and read as a timer. This one needs the cop's bumper on the taxi
and the taxi stuck. There is no bar for it on screen.

It replaced three rules that each meant something different by the same blue car: a patrol touch
was "Busted!" at any speed, a boosted hit on *any* cop was the wreck whatever the HP (#466), and a
getaway's cops could not arrest at all — which made the getaway's roadblocks, the one thing it asks
you to smash, the one thing that ended a run outright. `?capture=classic` keeps them; see
[history](gameplay-history.md#getting-caught-before-the-capture-model).

## The bank robbery

`src/game/robbery.js`, `src/game/bankjob.js`, `src/city/bank.js`, `src/game/fares.js`
(`BANK_CHANCE`, `spawnRobber`), `sim/traffic.js` (`enterPolice`). One city block is a
[bank](city.md#the-bank) — a low stone building under a colonnade with a dome behind it. **Now and
then a rider spawns on its steps** (`BANK_CHANCE`: 30% of qualifying spawns from the second
delivery, 35s after the last one left the board; #499). They are an ordinary tappable fare. Tap
them and pull up, and a coin tossed when they spawned decides it — **a loaded one**: even odds on
the first bank rider of a run, then 15 points more robbery for each one who rode (50, 65, 80, 95,
capped there), back to even once a robbery happens (`BANK_ROBBER_STEP`; #522,
`?robberyodds=classic` for a fair coin every time). Heads they get in like anybody
else; tails a robber bursts out of the bank, shoves them over and takes their seat — see
[the bank job](#the-bank-job) — and the streets go blue for as long as it takes to get the robber
where they are going. `?bankfare=classic` restores the drive-past robbery, where passing the bank
with an empty cab set it off; see [history](gameplay-history.md#the-bank-robbery).

**Everything about it is the existing loop turned up.** That is a constraint rather than a
description, and it is worth listing what is *not* new, because none of it is:

- The robber is an ordinary fare that skipped the kerb. Same crystal over the roof, same ring on the
  road, same band of paint between them, same arrival test, same payout flight to the counter. Two
  things differ: the clock, and a bonus that reads it. What *looks* different is the figure — see
  [the robber](#the-robber).
- The cop cars are **ordinary cars**. They queue, indicate, stop at reds, yield and can be crashed
  into like anything else on the road — and they **come after you**, which is a route, a speed and
  an acceleration rather than an AI. See [the chase](#the-chase).
  [The patrol cruiser](traffic.md#the-patrol-cruiser) is one of these cars too, for the whole of its
  patrol, and a patrol chase is this chase with one cop in it.

  They **arrive and leave, rather than transforming**. A robbery brings four vehicles onto the map
  from off screen and stands them down again at the drop-off, driving off under their own steam —
  the ones not busy [arresting the robber or chasing you](#the-drop-off-the-arrest-and-the-tail).
  Nothing in the world changes species: no car you have been following turns into a police car, and
  no police car in your mirror stops existing (the repaint that did both is in
  [history](gameplay-history.md#the-police)). A stood-down cop keeps a dark bar on its roof,
  so it still reads as police with its lights off rather than as a blue hatchback. See
  [cop cars in ambient traffic](traffic.md#they-are-spawned-not-repainted) and
  [standing down](traffic.md#standing-down).

  The one thing they are allowed that an ordinary car is not is **a red light on a junction that is
  provably empty** — fenced on five sides, because `sim/collisions.js` only tests the taxi, so an
  unsafe crossing would be a cop driving *through* a car rather than into it. See
  [the licence](traffic.md#the-one-licence-a-red-on-a-provably-empty-junction).
- Loco Mode is untouched — the same finite tank, spent in a hold.
- The fail state is the game's own ([getting caught](#getting-caught)): a cop is a car to
  [`sim/collisions.js`](../src/sim/collisions.js), so ramming one costs hit points, and being pinned
  by one is "Busted!". The police **put themselves in your way** — see
  [they box you in](#they-box-you-in) — so a cop in the road is something to route round or wait
  out rather than drive through.

So the whole feature is a trigger, a clock, a bonus, and some paint.

### It is imposed, so it cannot cost the run

A [VIP](#vip-pickups) is *taken on*: it appears on the kerb, the player chooses to jump the queue
for it, and it can stay optional-but-hard only because missing one is never worse than never having
seen it. A robbery is only half taken on: the player chose the bank rider, but the coin that turns
the ride into a getaway is one they never see.

An imposed event that can end a run is the one thing a score-attack cannot have. So a robber whose
clock runs out does exactly what a missed VIP does: gets out mid-street, swears about it
([the outburst bubble](#they-leave-and-they-let-you-know)) and goes. The event costs the bonus and
the seat it was occupying, and nothing else. The clock running out cannot end the run.

**What it can cost is the escape afterwards, and whatever the player drives into.** Deliver the
robber and one cop comes after *you* as an ordinary [patrol chase](traffic.md#the-patrol-cruiser)
([the drop-off](#the-drop-off-the-arrest-and-the-tail)). During the getaway and after it, the
police end a run the way they do anywhere ([getting caught](#getting-caught)): pinned is "Busted!",
and a ram that empties the HP is the wreck. Nothing about the event *being imposed* can end the
run; a player who gets boxed in or drives the HP out of the taxi has done it themselves. The drop-off fills the tank to pay
for the chase, so the choice is "boost clear", not "hope".

### The robber

`geometry/person.js`. A mask right across the eyes, a cap over the hair, a dark jacket pulled over
the torso, the sleeves tinted to match, and a pale sack swinging off the left hand.

**It is the figure that has to say this is not an ordinary fare** — that and
[the radio call](#dispatch-breaks-in), and nothing else: a robber's crystal is on the ordinary urgency scale on purpose — the clock is the drama, and a fixed
hue like [a VIP's](#vip-pickups) would trade that away to say something the building and the police
cars are already saying.

It is **additive and switchable**, not a second person, and the reason is the pool. There is one
figure per fare slot, built once and handed to every fare that occupies it, so a robber cannot be a
differently-coloured `createPerson`. Nor can the base figure simply be repainted: its torso, head
and hair are merged into one mesh with the colours baked into the vertices, so tinting the jacket
tints the face with it. Five boxes that start hidden sidestep both — and the two that *are* a
repaint (the sleeves) are separate meshes in one flat colour each, where `material.color` multiplies
cleanly with nothing else on that mesh to spoil.

The jacket was added after looking at the first build. A mask and a cap on a figure still wearing
the board's pale shirt read as **a man in a hat**: at 24px the torso is the largest thing on the
figure, and it was still saying "ordinary fare" louder than the head was saying anything. The sack
is the opposite problem and the reason it is pale — against a black mask, a black cap and a black
jacket, a dark bag is invisible, and it is the one part of the kit that says *why*.

The kit is deliberately **not** cleared by `rest()`, unlike every other piece of pooled state on the
rig. `rest()` runs mid-fare — a robber is rested on the frame they appear, and again when they get
out at the far end — and a kit that came off there would take the mask off halfway through the
event. What owns it is the spawn: `spawnRobber` puts it on, and `spawnFare` takes it off, which is
the one place a slot changes hands.

### A full tank for the getaway

The frame the robber is in the car, the boost meter is poured full — the VIP's reward, paid up
front (`onBoard` in `main.js`). The event is imposed: it takes the seat whatever the meter holds,
and a getaway that opened on a dry tank was a chase the taxi could not win on speed, against cops
whose cruise ceiling sits above an unboosted taxi's. Filling it keeps the event's choice — boost
and risk the wreck, or hold off and risk the clock — a choice.

### Checkpoints on the way

`ROBBER_CHECKPOINTS` in `game/fares.js`. A getaway is not one leg: the taxi has to touch **four
checkpoints** before the drop-off, and each one pours the boost tank full again (`'checkpoint'` in
main.js, the same pour as the boarding tank) with a "Checkpoint 1/4" rising off the cab. The mark
the taxi is driving at *is* the checkpoint — a **white** ring rather than one in the clock's
colour, with a dot in the middle that grows out and fades, over and over (`setWaypoint` in
geometry/targetring.js), so a waypoint never reads as the end of the trip. (A diamond was tried
first and read as another fare crystal.) It hops on to the next corner on arrival, turning back
into the ordinary ring for the drop-off, and the route
re-dispatches itself. The clock keeps running straight through; only the drop-off pays.

The drop-off is drawn first, exactly as before (the far side of the map), and the checkpoints
between it and the bank by random darts: every leg at least 3 blocks so a checkpoint is somewhere
to drive *to*, and the whole chain at most 3 blocks per checkpoint longer than the straight
getaway, because a longer getaway is paid for out of every kerbside clock that runs while it does.
Every leg is budgeted into the robber's one clock, so the 60% over the driving still holds. A board
too full for four gets fewer.

Measured over 38 cities, with four: the driving goes from a median 41.5s to 99.7s (×2.45, worst
×3.9), and the robber's clock sits at a median 190s. (Two checkpoints measured 68.4s, ×1.74.)

**The rest of the board steps aside while it runs** (`concealed` in game/fares.js). Every rider
waiting on the kerb is hidden — figure, crystal, disc, edge arrow, finder chip, tap target — with
their clock **held**, and nobody new spawns; the courier's pads go too (`concealed` in
game/parcels.js), and driving over one does nothing. The clock is held *because* they are hidden: a
rider the player cannot see must not be able to time out and end the run. They come back exactly
as they were when the getaway ends, whichever way it ends.

**Each checkpoint calls in another cop** (`wanted` in game/robbery.js): the fleet is
`POLICE_FLEET` at the bank and one more per checkpoint touched, up to `POLICE_REINFORCEMENTS`, each
arriving behind the taxi through the ordinary top-up. Both the top-up and the recycle wait on one
gap clock, so the top-up ticks it itself and goes first; otherwise it loses every race to the
recycle and only fires while no cop is lost.

Four checkpoints were expensive for the board before the riders stepped aside: 9.9 fares · $237 at
a 1.5s reaction against 12.7 · $358 with no checkpoints, over 30 paired autoplay runs. With the
board held they **gain**: 14.2 fares · $406 at 1.5s and 15.7 · $439 at 4s — a getaway is now a
paid breather for the kerb. If that reads as too generous, the lever is to let the clocks run at a
fraction rather than hold.

### The robber's line

`game/robberline.js`. A robbery that went straight to four cop cars and the radio call on one frame
would read as traffic changing colour rather than as the game changing mode, so it has a setup, in
three beats:

1. **The robber gets in and the world stops.** Once the figure has finished running for the cab
   (`BOARD_SECONDS`), the city dims around the taxi (`#robber-spot`, the tutorial's gradient and pool
   size) and the robber shouts from a "BANK ROBBER" [bubble](#speech-bubbles) pinned on the taxi. The line is one of `ROBBER_LINES`, drawn off
   the run seed.
2. **The next tap clears it** and calls the police (`raiseAlarm` in game/robbery.js — the fare, its
   clock and the getaway route are already running; only the cop cars wait). A tap mid-type finishes
   the line first, the coach's convention. Space and Enter answer it too.
3. **`RADIO_DELAY` (1.5s of game time) later, dispatch breaks in** — below.

**The world stops rather than runs on under it.** It is the pause's own early return in `frame()`,
and for the same reason a pause is: this lands mid-run with the taxi moving, and a bubble that
waited for a tap over a live city would either eat a routing tap meant for the road or let the
getaway start behind it. Frozen, the tap has one meaning and nothing is lost while the line is read.
The element is a full-screen catcher while it is up, so the tap never reaches the canvas — the picker
and the route drag both only take presses whose target is the canvas.

Its own element and pool rather than `#coach` and `#spotlight`: the tutorial's Loco Mode beat can be
mid-showing when a robbery lands, and `body.robber-talk` hides it meanwhile. The tools construct the
robbery without `holdAlarm`, so the headless suite still sees the police on the frame it fires.

### The bank job

`game/bankjob.js` — the opening of every robbery by default (#475, the default since #478;
`?robbery=classic` drops the cut and goes straight to the robber's line). The point is that the
player *sees* the robber get in.

**It starts with the bank rider** (`BANK_CHANCE` in game/fares.js: 30% of qualifying spawns, from
the second delivery, the bank junction within the spawn box, 35s after the last one left the
board). A coin is tossed when they spawn, loaded by every bank rider who has ridden since the last
robbery: 50% robbery, then 65, 80 and 95, back to 50 after one fires (`BANK_ROBBER_STEP` in
game/fares.js; a rider who got in because the gates were shut counts as one who rode). Keep taking
the bank's fares and you are pushing your luck. Tap them and pull up: heads they get in like anybody
else; tails, and if the robbery's fairness gates are open at that moment (`swapReady` in
game/robbery.js — every [gate](#the-trigger) but the drive-past's range, with the bank rider's own
clock left out of the calm test), they leave the board without a strike and the robber takes their
seat. Nobody stands outside the bank and there is no alarm on it otherwise.

This makes the robbery **opt-in**: a player who never takes the bank rider never meets it. The rate
is unmeasured — it fires only when the bank rider is taken and the coin agrees.

The event opens on a cut, and the world stops **one beat earlier** than the line would stop it
anyway:

1. One red alarm light appears on the bank's entablature, over the doorway (`bankFrontage` in
   city/bank.js), and starts flashing, and the camera pulls in on the steps and the cab (see
   [the cut's framing](#the-cuts-framing) below).
2. The robber bursts out of the portico, shedding notes out of the sack (the getaway's own cash
   trail, fed from the robber), shoves the **bank rider** clean off their feet (airborne, spun, a
   bounce and a skid, then dazed and stirring on the ground — never landing on the cab), and
   sprints for the cab's door, which swings open as they arrive. Where the cab is round the side of
   the block, the run turns at the block's pavement corner (`aroundBlock`, #484) rather than going
   straight through the building.
3. They hop in, and [the robber's line](#the-robbers-line) takes over.

The shove plays in **slow motion**: from contact until just before the bystander comes down the
cut's clock runs at 0.3x (`IMPACT_SLOW`), easing back to 1x so the bounce and skid land at full
speed. About 4s of wall time in all, and **it cannot be skipped**: a tap landing as the cut opened
(the player still steering onto the kerb) skipped the robbery before anyone saw it. The tap is still
swallowed by a full-screen catcher, so it never reroutes the taxi. `?robberyskip=classic` puts back
the tap (or Space/Enter) skipping straight to step 3. The alarm
keeps going for as long as the robbery does and then goes; the rider gets up a few seconds into the
getaway and walks back into the bank; the door slams and the camera eases back out when the line is
cleared.

#### The cut's framing

The camera is fitted **on the screen**, not in the ground plane (`frameCut` in game/bankjob.js).
Everything the cut shows is projected onto the camera's own axes — the doorway at a figure's
height, the steps, the bystander at the top of their flight and where they come down, every corner
of the run, the cab's nose and tail, and the point over the cab the robber's bubble hangs from — and
the half-height is the smallest that holds the box at the current aspect ratio, with 1.5 units of
room, between 15 and 34. The box is centred in the strip **between the HUD rows** (the cash at the
top takes 15% of the height, the pedals at the bottom 20%), so the shove never plays under a
button. It is refitted every frame, so a rotation mid-cut reframes rather than crops.

**Loco Mode's push-in lets go for the cut.** The punch (`punchZoom` in game/camera.js) is eased by
the frame loop the cut stops, so a player still holding the pill as they pulled up — which is how
most pickups are driven — froze it at `LOCO_PUNCH` (0.76) through the cut and the line: a frame
sized to hold everything shown at 76% of its size, the bank and the cab at opposite edges of the
phone. The cut eases it back to 1 alongside its own framing.

**The L's deck thins over the cut.** The deck already dithers out over the taxi and the fare pins
(`setFadePoints` in game/ltrain.js), but the frame loop that feeds it stands still under the cut,
so the points it held were wherever the taxi and the pins were on the frame the world stopped.
During the cut it is fed the steps, the bystander and their landing, the robber where they are and
the cab instead (`fadePoints`), and those stay set for the robber's line after it. About one city
in eight puts the deck straight over the bank's steps (10 of 80 seeds measured with the deck's
sightline lift).

`?robberycam=classic` is the first framing: the steps, the bystander and the cab door averaged in
the ground plane with the door counted twice, a zoom off the world distance between them capped at
26, a held push-in left frozen, and the deck left as it was. See [history](gameplay-history.md#the-bank-job).

**Stopped, not slowed** — the world, that is; the impact slow-mo is the cut's own clock, with
everything else already frozen. Slowing the *world* would keep the traffic alive, but it runs every
clock, the crystal's flight and the fare loop at a crawl under a figure animated at full speed — two
time bases in one frame — and the line right after it is a freeze anyway. The cut and the line read
as one held beat. The robber's crystal waits for them to be in the car (`boardScripted` in
game/fares.js) rather than hanging over the steps for the whole run.

`?bankfare=classic` puts back the drive-past, with a bystander who is scenery rather than a fare
(no crystal, no tap target) standing outside the bank all run and the alarm always on the building;
see [history](gameplay-history.md#the-bank-job).

### Dispatch breaks in

`game/radio.js`. A beat after the robber's line is cleared, a [bubble](#speech-bubbles) pinned on
the robbery's cop car nearest the bank: "POLICE DISPATCH / 10-65 in progress!" The police come in
just off screen near the bank, so the call usually opens waiting at the screen's edge with its
pointer aimed at them — the first word the player gets about which way the police are coming from.
Under `?copchat=classic` (#492), a patrol cruiser that loses the taxi also says "POLICE / Lost the
suspect. Resuming patrol." from its own roof; by default the chase ends with the bar going dark.

The robber's line says *who* got in; this says what it means — the police are coming.

It is the same bubble as the tutorial's, minus everything that asks something of the player:

- **No spotlight.** The getaway's clock has just started; dimming the city over the
  getaway spends it.
- **No tap.** `pointer-events: none`, and it leaves on its own after `RADIO_LINGER` (3.2s of game
  time, so a pause holds it). The next tap is on the road, routing the getaway, and a bubble that
  caught it would cost the second this event is about.

### The clock, and the bonus that reads it

A loose clock, on purpose: the getaway is the longest drive in the game and the point of it is the
police, so the clock is there to pay the bonus rather than to threaten the trip.

**The queue behind it is empty.** Every ordinary rider's clock is budgeted over the whole chain the
taxi must clear before reaching them — the rider aboard, then everyone on the kerb in urgency order
([the clock is budgeted](#the-clock-is-budgeted)). A robber's is budgeted over its own trip and
nothing else, because a robbery cannot start with somebody in the seat. That is the same exemption a
VIP gets and for the same reason, and on its own it would buy a robber a *longer* clock than an
ordinary rider on the same trip.

**And the pace factor is turned up on top of that.** `ROBBER_PACE_FACTOR` is 1.3, floored at 1.6,
so a getaway always has at least 60% more clock than driving — measured on the probe's staged event,
118s against 60.8s of driving, where an ordinary rider on the same trip would get 91s.

**And the payout is the one price in this game not settled at spawn.** Every other fare is stamped
when its trip is decided, because a meter that ticked while driving "would punish traffic and reward
Loco Mode for the wrong reasons" ([Priced by the trip](#priced-by-the-trip)). For a getaway,
rewarding Loco Mode is exactly the ask. So a flat `ROBBER_PAYOUT` = $100 is stamped like everybody
else's price, and a bonus of up to `ROBBER_BONUS` = $50 is paid on the *fraction of clock left at the
drop-off* — read once, on the frame the arrival resolves. $150 for a clean getaway, $100 on the last
second. The event always pays, and how much is the whole of what the player is driving for.

Flat, it is a jackpot worth five or six ordinary fares, and the same number every time.

The bonus is folded into the fare's own `value` before anything reads it, so the pop that flies off
the taxi, the counter it rolls into and the run-end card's "Cash" all say the same number. A second,
smaller flight arriving from nowhere is exactly the side effect the two-phase payout exists to
prevent.

### The gate that makes it fair

A robbery takes the seat, and every rider already waiting when it starts is spending a clock that
was budgeted without it ([the clock is budgeted](#the-clock-is-budgeted)). A rider who was
comfortable can usually absorb that. A rider who was already in trouble cannot — and *their* clock
running out ends the run. So the event that is
[not allowed to end a run](#it-is-imposed-so-it-cannot-cost-the-run) was ending runs by proxy.

`CALM_LEVEL` closes it: a robbery will not start while any waiting rider has dropped below half
their clock. It is expressed as a **level** rather than a fraction so the rule is one the player can
read off the board — the urgency scale is four even quarters
([urgency is one scale](#urgency-is-one-scale)), so this is "every crystal on the kerb is still on
one of its top two steps". A number like 0.45 would measure the same thing and mean nothing on
screen.

Measured over 30 paired runs per cell, against a no-robbery baseline of a 13.9-fare mean on $339 at
a 1.5s reaction and 11.2 on $264 at 4s:

| | perfect player (1.5s) | slower player (4s) | robberies (1.5s) |
|---|---|---|---|
| no gate at all | 9.8 fares · $239 | 8.4 · $206 | 28 |
| **this gate** | **12.4 fares · $309** | **8.6 · $211** | 18 |
| tightened to the top step | 14.0 fares · $349 | 11.2 · $264 | **2** |

Two findings, and the second is why the gate is not simply turned up further. It is worth two and a
half fares to a fast player, which is most of what a cross-town getaway costs. And there is **no
usable room above it**: at the top step the event fires twice in thirty runs at 1.5s and never at
all at 4s, which is not a rarer event, it is no event.

The cooldown is not a third lever, though it looks like one. Nearly doubling it moved the count of
robberies from 33 to 34, because the cooldown is not what limits the event — what limits it is the
taxi happening to drive past the bank with an empty cab and a calm kerb, which on a five-block city
is about once a run either way. (Measured under the drive-past trigger, now `?bankfare=classic`;
under the bank rider the rate is set by `BANK_CHANCE`, its cooldown and the coin.)

### The getaway runs across town

`pickFarthest` scores every free junction by block distance from the bank and draws the drop-off
from the furthest band — the furthest, or `ROBBER_DROPOFF_SPREAD` = 1 short of it, so one city's
robberies do not all end on the same kerb. It is filtered through the same predicate as every other
drop-off, so the only thing it changes is that the distance is no longer left to chance. It is the
one event in this game whose whole point is the drive.

That distance is not free, and the mechanism is not subtle once it is named: a robbery takes the
seat for the length of its trip, and every rider standing on a kerb while it runs is spending a
clock that was budgeted without it. The longer the getaway, the more of other people's clocks it
eats — and nothing about the robber's own clock touches that, because the robber's clock is not the
one running out. 30 paired runs per cell through `tools/autoplay.mjs`:

| | perfect player (1.5s) | slower player (4s) |
|---|---|---|
| no robbery | 13.9 fares · $339 | 11.2 fares · $264 |
| **across town, with the calm gate** | **12.4 fares · $309** | **8.6 fares · $211** |
| across town, no gate at all | 9.8 fares · $239 | 8.4 fares · $206 |

Re-measured when the drop-off went to the far corner and the clock was loosened (30 paired runs,
same harness): **11.9 fares · $287** at 1.5s against 11.0 · $251 before, and **10.5 · $256** at 4s
against 11.2 · $265. The fast player comes out ahead — the loose clock means the bonus lands — and
the slower one pays about another two thirds of a fare, because a longer getaway eats more of the
kerb's clocks and nothing about the robber's own clock helps with that. Eleven robberies per
thirty runs in each cell, so read these as a direction rather than a digit.

The bottom row is what [the calm gate](#the-gate-that-makes-it-fair) is buying: without it a long
getaway is the difference between a 14-fare run and a 10-fare one. With it, a fast player pays about
a fare and a half for the event.

**The slower player pays more, and that is the honest read on this.** At a 4s reaction the cost is
2.6 fares — the p10 drops from 6 to 1, which is runs ending early rather than everyone landing a
little shorter. A player who is already behind cannot absorb a sixty-second hijack they did not ask
for, and the gate only checks the board at the moment the event *starts*.

Two levers if that is ever judged too steep, and they are the two constants in this feature that
were measured rather than chosen. `ROBBER_DROPOFF_SPREAD` is the distance — capped at four blocks
from the bank, the same sweep reads 12.6 / $314 and 11.4 / $276, which is about a fare cheaper at
either speed and a materially shorter event. And `CALM_LEVEL` is the frequency, but only in one
direction: tightened to the top step it fires **twice in thirty runs**, which is not a rarer event,
it is no event. Everything else was measured and does nothing — see the cooldown.

### What it costs, as shipped

The whole event, measured end to end through `tools/autoplay.mjs` over 30 paired runs per cell —
same cities, same situations, the robbery layer the only difference:

| | perfect player (1.5s) | slower player (4s) |
|---|---|---|
| no robbery | 13.9 fares · $339 | 11.2 fares · $264 |
| across town, no chase | 12.4 fares · $309 | 8.6 fares · $211 |
| **shipped, with the chase** | **10.9 fares · $268** | **9.6 fares · $235** |

The event costs a fast player three fares of survival and a slower one about one and a half. That is
a real price and it is a deliberate one: two rounds of "make it more dramatic" bought a cross-town
getaway and four cars hunting you, and both are paid for out of the same clock.

**One large caveat on those numbers.** `tools/autoplay.mjs`'s perfect player **never uses Loco
Mode** — it drives everywhere at cruise. So the harness measures the chase purely as extra traffic
in the way, and cannot measure the thing the chase is actually for: a player on the gas outruns
cop cars, and the decision the event poses is whether to spend the tank doing it. The real event is
a risk/reward the soak has no way to play. Treat these as the cost to somebody who ignores the
mechanic.

One thing to know when reading `npm run check`: the suite's `fares` line runs the soak over **nine**
seeds, which is a small enough sample that the first nine happen to be unlucky here — it reads a
median of 6 against 10 before. The 30-run paired numbers above are the ones to believe, and the gate
is a band (3–20) rather than the number itself, for exactly this reason.

### The trigger

**By default the trigger is the bank rider's arrival** with the coin on tails, and `swapReady` asks
the gates below at that moment (`eligible` in game/robbery.js). Under `?bankfare=classic` it is the
drive-past: `TRIGGER_RANGE`, 12 world units from the bank's door, is how close the empty taxi has to
pass — see [history](gameplay-history.md#the-trigger) for the arithmetic behind the number.

The gates, and each is there for its own reason:

- **An empty cab.** A robbery takes the seat, so there has to be one. A player mid-delivery has a
  clock running that this event would spend on somebody else's trip.
- **Nobody on the kerb is already in trouble** — every waiting rider's crystal still on one of its
  top two steps. This is [the gate that makes the event fair](#the-gate-that-makes-it-fair), and the
  only one that was measured rather than argued.
- **`MIN_DELIVERED` = 2.** `VIP_MIN_DELIVERED` is 1, on the grounds that a purple diamond needs
  something to be distinguished *from*. This is higher for a different reason: a robbery takes the
  wheel, and an event that overrides the loop is only legible to somebody who has one.
- **No VIP on the board.** The one interaction that would be unfair rather than merely busy: a VIP's
  clock is budgeted to be served *next*, so a robber taking the seat for a cross-town getaway does
  not make a VIP harder, it makes it arithmetically impossible. Nothing breaks — missing one is only
  the bonus — but it would be the game quietly cancelling a fare it had just offered.
- **A cooldown**, from the **end** of the last event rather than its start, so two can never run into
  each other however short the getaway was. Longer than `VIP_COOLDOWN` because this event cannot be
  walked past.
- **A free slot on the fare board.** The figure, the pins and the crystal come out of the same pool
  every rider uses. A full board refuses, and nothing is spent when it does — the cooldown has not
  been reset, so the next chance tries again.
- **No patrol chase already running** (`busy`), and a taxi that is neither wrecked nor staged in a
  cut scene.

### The police

`enterPolice(n, near)` in `sim/traffic.js` brings `POLICE_FLEET` (4) cop cars onto the map from off
screen, as near the bank as the camera allows, in the police two-tone (light-blue `policeBody`,
white cab) with a light bar on the roof; each checkpoint calls in one more, up to
`POLICE_REINFORCEMENTS`. They are real vehicles at the tail of the ambient pool, and they leave the
same way — see [cop cars in ambient traffic](traffic.md#cop-cars-in-ambient-traffic). History (the
repaint this replaced): [the police](gameplay-history.md#the-police).

**Four cars, flat, not on the difficulty ramp.** The event already tightens with the run — a robber's
clock is budgeted off `difficulty.pace`, so the same getaway is a harder drive on delivery forty than
on delivery three — and hanging a second knob off the same ramp would make the event's difficulty a
product of two curves neither of which could then be read on its own. Four is also what a five-block
city can show at once: a block is about a third of a phone's frame at play zoom, so four cars spread
around the taxi puts one or two in shot without the road reading as a parade.

**Every one of them flashes, and the nearest two glow.** The siren comes from three places and the
split matters, because the first two alone did not read:

- **The bar**, two instanced emissive pods on the roof off the same machinery the brake and
  turn-signal pods use (`geometry/lights.js`): red over the left lens, blue over the right,
  lighting alternately six times a second, with the dark side still showing its painted lens. A
  whole-bar strobe (both pods red, then both blue) was the earlier choice and on a phone read as
  two red lights.
- **The bloom**, which carries it at distance and took a fix. `main.js` marks every lamp the sim
  owns in one loop, and marking them all `pod` gave a cop car's bar a brake light's 3.4 against the
  cruiser's 4.2 — dimmer than the police car parked beside it, for no reason on screen. The kind
  rides on the mesh now and the loop reads it.
- **The wash on the road** (`game/coplights.js`), which is the part neither of the others can do —
  two real point lights, parked on the nearest two cop cars and re-picked every frame. See
  [cop cars' sirens](rendering.md#cop-cars-sirens--geometrylightsjs-gamecoplightsjs) for why it is
  two lights against four cars, and what `?safe` drops.

The rate is `sirenOn()`, shared with [the patrol cruiser](traffic.md#the-patrol-cruiser) and
[the off-screen wash](rendering.md#off-screen-police-warning), so a city with both in it strobes on
one clock.

### The chase

The one thing the original brief ruled out, and now the point of the event. It is **two lines of
behaviour**: `car.chase` lifts that cop's cruise ceiling and its cornering, and `car.route` is a
plain route to a junction on the taxi's own route, three to five ahead of it — after which
[the one routing branch](traffic.md#the-one-routing-branch) does the rest. A chasing cop *is* a
routed car, the same thing the player's own taxi is.

**Half cut you off, half come after you, and all of them get recycled.** A cop's mean speed over a
getaway is 9 against a boosting taxi's 27, because it is cornering and queueing where the taxi is
flat out; sent to where the taxi *is*, it is aimed at a point already a second old and loses ground
every frame. Tuning could not save it — scattering the traffic in front of it, doubling its
cornering speed and (as an experiment) turning every light in the city green for it lifted its mean
speed from 6.8 to 13.6 and moved its distance to the taxi by nothing at all.

Two answers, and the event needs both. Two of the four are sent three or five junctions down the
**route the player drew**, which is a race a slower car can actually win: it only has to beat the
taxi to one junction, and the taxi has announced which ones those are. The other two are sent
straight at the taxi, and when one of them falls out of the picture it is taken off the map and
another comes in **behind you on the straight you are already driving**. That is what a pursuit
looks like from the driver's seat, and it is the half a cut-off cannot supply — see
[the chase](traffic.md#they-are-recycled-because-a-slower-car-cannot-stay-in-the-picture). Measured
over 40 seeds, a cop is in frame for 89% of a getaway, two at a time.

A cop cruises at **20.4** against a boosting taxi's 22.1 and the traffic's 8.5. That gap is the
mode — the gas pedal outruns them in a straight line and lifting off does not — so Loco Mode becomes the
answer to the event and [the wreck](traffic.md#the-wreck) is what makes it a gamble. What Loco Mode
cannot outrun is the cop already sitting in the junction it is about to take. And they strobe at the
**hunting rate** while chasing — eleven changes a second against six: a cop cruising past on its own
business and one that has turned to come after you are otherwise the same blue car.

**Every licence they have is fenced**, which is what makes this safe rather than merely loud.
`sim/collisions.js` only ever tests the taxi, so a cop let through a light, stopped in the wrong
place or out in the wrong lane would drive *through* another car rather than into it. The red on a
provably empty junction, the roadblock and the overtake are each gated on every overlap that was
measured on the way to them, and the probe holds the whole chase to zero signal violations.

**A cop catching you is not nothing.** The robbery's own cops never arrest anybody; what they do is
get in the way — across the junction ahead, or braking in your lane having just gone round you.
Ramming one on the gas is [the wreck](traffic.md#the-wreck) outright (#466; under `?cop=classic` it
is a [bump](traffic.md#bumps-and-hit-points) that costs hit points).

**And [the patrol cruiser](traffic.md#the-patrol-cruiser) does not come after you during one** — it
drives off when a robbery starts. Its rule — boost within a block of it and it gives chase — rests
entirely on there being *one* police car on the street and it being obvious which. A robbery puts
four more on the street in the same paint under the same flashing bar, and pays a bonus on the
clock that boosting is the way to earn, so at a glance there would be no telling which of the five
blue cars is the one that minds. The honest cost is that Loco Mode has no downside but the wreck
for the length of a getaway; the chase is what pays that back, and it drives cop cars into the road
*ahead* of the taxi rather than trailing it. History: [the chase](gameplay-history.md#the-chase).

**And a boosting getaway throws cash out of the back.** `game/cashtrail.js` — banknotes fluttering out
behind the taxi, with the odd wrapped bundle among them, for as long as the gas pedal is held with a robber aboard. It is the one part of the event
that pays the player back *while* the risk is being taken: the bonus is real and the player does not
see a penny of it until the drop-off resolves, and everything in between is a tight clock and four
more cars to hit. The gate is the robbery rather than the boost, because money off the back of any
boosting taxi is a fun effect with nothing behind it — and it is one condition, so widening it is one
word. See [the cash trail](rendering.md#the-getaways-cash-trail--gamecashtrailjs).

### They box you in

Since the taxi has [hit points](traffic.md#bumps-and-hit-points), the police try to stop it rather
than only converge on it. Two moves, both ordinary traffic behaviour pointed at the taxi (mechanics
in [the box-in](traffic.md#the-box-in-roadblocks-the-overtake-and-the-brake-check)):

- **Roadblocks.** A cop crossing a junction a block or two up your route skids to a stop at 45°
  *across the middle of your road* and holds it for up to four seconds, or until you have got past it. One at a
  time, eight seconds apart. The overtake combo thrown short of one swerves round it, squeezing past by
  the kerb ([the swerve](traffic.md#swerving-round-a-car-stood-in-the-junction)), unless a second
  cop is holding the other half.
- **The overtake and the brake check.** A cop that catches you from behind goes round you in the
  oncoming lane, cuts in and slews across the road for 2.5 seconds, with the rest of the chase
  arriving behind you. A cop that is already ahead of you on your road skips the overtake and does
  the same — it does not drive on away from you. Angled across both lanes, it cannot be gone round
  on the gas.

Each poses the same three-way choice, and all three are things the game already had. **Wait** — it
costs the robber's clock, and with it the bonus. **Route round** — redraw the route and the
roadblock is let go. **Ram it** — on the gas that is the wreck (`lethalPolice`, #466; under
`?cop=classic` the cop is a bump that costs 12–60 hit points by closing speed). The fairness lives
in the choice being real: every roadblock is let go when the taxi routes round it or waits it out,
so ramming is never the only way past.

### The drop-off: the arrest and the tail

`game/arrest.js`, `robbery.js` (`stop`, `handOff`), `patrol.js` (`pursueNearest`). The getaway
ends in two scenes at once.

**The robber stays on the corner with their hands up, and the police screech up in a fan pointed at
them.** The robber climbs out the way any rider does and stops on the kerb instead of fading
(`beginExit`'s `hold` in `game/fares.js` hands back the figure; `surrender` in
`geometry/person.js` is the pose). The cops near enough — up to three, and at least two, calling in
the difference from off screen — are routed to the junction and held at its line; once the taxi is
clear they come into the box one at a time and handbrake into one of three slots round the robber,
5.5 off them and 40° apart, bonnet on the robber, bars going. After a three-second standoff the
robber walks to the nearest car and gets in the back, and the cars pull out one by one — the one
with the robber first — and are handed back to traffic, bars off, to drive away the way a
[stood-down](traffic.md#standing-down) cop does. A car nobody can see is simply
retired instead — "nobody can see" asked of the camera, not of the taxi, because a player who pans
over to watch the arrest is exactly who would otherwise see the police blink out (the first build
did that, on the frame the robber was taken in).

The fan sits in the box on the robber's side of it — a kerb corner has road on only a quarter of
the directions out from it — and fills from the slot furthest from each car first, because the cops
mostly come down the same arm and the slot nearest its mouth is parked right across it. A slot that
faces back the way a car came is reached by sliding the body round over the last stretch of the run
(`slideIn`), not by a lap of road the box does not have. Every run in and every pull-out is sampled
before it is driven — four corners on the road, the centre clear of every other car — and a car
without a clear one waits. (It used to be a ring of circling cops; see
[history](gameplay-history.md#the-drop-off-the-arrest-and-the-tail).)

The fanned cars are **driven by hand**: nothing in the traffic model parks a car across a junction
pointed at the pavement, so they are taken out of traffic the way the opening vignette takes the taxi into its garage (`stageCar`),
and put back with `releaseCar`. Everything traffic would have done for them is the module's job —
see its header and [traffic.md](traffic.md#the-arrest-a-junction-closed-to-traffic). A scene that
cannot happen (no cop gets there within 14s, nowhere to pull up) lets the robber walk off.

**The nearest cop comes after the taxi.** It is handed to the patrol (`pursueNearest`) and from then
on it *is* the patrol cruiser in a chase: strobe (and "Pull over!" under `?copchat=classic`), caught on a touch or lost two and a
half blocks out, with the patrol's catch-up. Only a cop already inside that escape range is taken —
one further out has lost the taxi by the patrol's own rule. A touch in the first 1.5s does not
count (`HANDOFF_GRACE`), because the box-in can have a cop on the taxi's bumper on the very frame
the robber gets out.

**The drop-off fills the tank**, where an ordinary delivery pours a third. The patrol's own table
(game/patrol.js) is why: a third of a tank is five seconds of boost, which loses the cop 8 times in
16; none is caught 15 in 16; a full tank gets away 14 in 16.

### The police helicopter

`game/policeheli.js`, the `police` livery in `geometry/helicopter.js`, `heliTarget` in `main.js`.
Once the taxi makes its **first checkpoint** a police helicopter flies in from the far side of the
city and holds station behind the cab and a little toward the camera, with its searchlight on it,
until the drop-off. There it moves over the robber on the corner for the standoff, follows the car
the robber is put in for a few seconds as it pulls away, and leaves the island.

It is **cinematic only**. Nothing in the robbery, the arrest or the patrol reads it, and it cannot
catch, find or block the taxi. The rooftop chopper (`game/chopper.js`) holds off starting a visit
while it is up, because both fly at `CRUISE_ALT`, the one height that clears every tower.

The light is faked rather than a `SpotLight`, which would add a light to every lit program and
shine through towers with no shadow map behind it: an additive cone from the lamp under the nose, an
additive pool where it lands, and a normally blended dark ring round the pool. The ring carries the
daytime read; an additive pool on a sunlit street is too faint to see on its own. The strengths ease
between day and night off the sun's power. The light is deliberately soft: the pool is brightest in
the middle and fades the whole way out to 1.3 of its nominal radius with no rim, and the ring starts
outside the pool's half-brightness and eases in and out, so it darkens the street round the light
rather than outlining it (`LOOKS` in `game/policeheli.js`;
[the first, harder light](gameplay-history.md#the-police-helicopters-first-searchlight)). The rotor sound is synthesised in `game/sfx.js`
(`makeRotor`) because the designer's set has no recording of one.

The machine is painted in the cruisers' own two colours turned round: `policeCab` white all over
with one broad `policeBody` stripe down the cabin, the boom and the fin cap. In place of the rooftop
chopper's single red beacon it carries a red lamp and a blue one on the stabiliser tips that
double-flash in turn (`TAIL_FLASHES`), and both are in the bloom at the cruiser bar's `siren`
intensity.

## The package courier

`src/game/parcels.js`. A brown parcel sits on a kerb corner on a cyan rounded-square pad. Drive
near it and the taxi picks it up — **while carrying a passenger, if it is carrying one** — and the
pad it is going to lights up somewhere else on the map. Drive near that and it pays out in cash.
One on the board (`MAX_PARCELS`), one aboard at a time, and nothing about it can end a run.

### With a rider aboard, a package is a detour. With the seat empty, a destination

**The rule is about the seat.** While somebody is riding, their clock is the one being spent, so
there is no way to dispatch the taxi at a package. The only way to collect or deliver one is to
make the taxi's route **pass through its junction**, on the way to wherever it was already going.
By default that is a **tap on the box**, which bends the route through it (below); a
[tap on a street](#tap-a-street-to-send-the-route-down-it) can do the same by hand, and under
`?drag=on` so can [dragging the band](#dragging-the-route). A route that already passes the pad
collects it for nothing.

A package puts something worth having on a road the route does not currently take, so *which way*
becomes worth asking with the streets clear, and the cost is paid in exactly the right currency: the
seconds the detour takes come out of the clock of whichever rider is in the back seat.

So it is the first decision on the board that spends *another job's* clock. Every other gesture in
this game answers "which rider?". This one answers "is the bonus worth the seconds?".

#### Two gestures ask for the same bend

**Tap the box** — or, under `?drag=on`, **drag the band** through the pad. With a rider aboard both
plan the identical route — origin → box → destination, `findRouteVia`. `divertToParcel` in
`main.js` is the tap's whole implementation, and the thing the detour does *not* do is route the
taxi at the package: the destination, the fare, and which clock is paying are all untouched.

The tap removes the **aiming**, not the decision. A drag asks the player to work out which junction
bends the band through a box that may be half a city from the paint, and then to hold a finger on
the route of a car that is still driving while they do it. On a phone that is a two-handed job in
service of a single yes-or-no. The tap says *include this* and lets the router find the bend. With
the drag off by default, the tap is how a package is taken.

##### The one thing the tap does not share is the cap

`TAP_MAX_DETOUR` is **uncapped**, and it is the one place the two gestures deliberately part company.

The drag's [`MAX_VIA_DETOUR`](#dragging-the-route) would refuse the same bend, and a refused tap
looks like *"tapping the box did not alter the route"*. History:
[the cap](gameplay-history.md#the-package-courier).

The two caps are not doing the same job. **The drag's cap catches a finger that slipped.** A finger
on the band is by construction near the route, so the cap almost never binds — the worst waypoint on
the whole map costs 2 extra legs on a corner-to-corner run. **A tap names one corner anywhere on the
map and is never sloppy.** Measured over 8 seeds and 649 distinct tap opportunities in real runs, the
extra legs a tapped diversion costs:

| min | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|
| 0 | 4 | **6** | 10 | 12 | 20 |

The median tap costs exactly the cap. So at 6 it refused **41% of every tap in the game**, silently,
on the gesture whose entire promise is that the route bends to include the box. And no value fixes
it: 8 refuses 26%, 10 refuses 11%, and by 16 it refuses 0.6% and exists only to surprise people.
Either it caps meaningfully or it does not exist.

What makes uncapping safe is that nothing about a tap is hidden. The band redraws through the box on
the same frame, before a wheel has turned, so the cost is visible at the moment of the decision — and
the undo is a tap on the rider, which re-plans direct. It is also the only setting consistent with
the rule below it: a diversion already may cost the rider in the back their fare, so refusing a
seven-leg one while taking a six-leg one was never protecting anybody.

`tools/probe.mjs` asserts both halves — that a tapped diversion is always routable, and that the
drag's cap would still refuse a real share of them, because the day it wouldn't is the day this
constant should be deleted rather than kept in step.

What all this trades away is worth stating plainly, because it was the original argument for the box
having no hit box at all: **the drag was the price of a package**, and skill at aiming it was part of
what a box was worth. A tap makes the collection free and leaves only the routing cost — which,
uncapped, is now the *whole* of what a box costs, paid out of the clock of whoever is in the back.
That is the trade this layer exists to offer, made explicit rather than rationed by a cap. Whether it
still plays as a temptation is the open question; the number to turn if it does not is
`PARCEL_PAY_FACTOR`, not `MAX_PARCELS`.

Two things the tap deliberately does not do:

- **It does not persist.** The waypoint is spent the moment it is planned. The next thing that
  re-plans — a pickup [dispatching itself](#the-drop-off-dispatches-itself), a tap on another rider
  — drops it, and the player taps the box again if they still want it. Re-applying it every frame
  is the one shape this must not take: `routeConsumed` is cleared on every re-plan, so a standing
  diversion means the turn the car has already committed to never retires from the route and the
  taxi sits re-deciding the same junction. Measured, in `tools/probe.mjs`: $34 earned in seven
  simulated minutes and nothing delivered.
- **It does not check the clock.** The detour is taken exactly as asked, even when it costs the
  rider in the back their fare. That is the trade this layer exists to offer, and it is the player's
  to make — the same one the drag has always let them make. With no cap either, this is the whole of
  what a box costs, which is why it has to be visible on the frame of the tap rather than felt three
  junctions later.

#### The empty-seat tap is a dispatch

With nobody in the back there is no committed clock the drive has to be a detour *from*, so the box
is allowed to be the destination: the tap routes the taxi straight at it, and the band repaints in the
courier's own cyan — [the band wears the clock it is spending](#the-route-band-wears-it-too), and a
package has none to report, so the hue says "errand" and nothing else. The dispatch replaces
whatever the taxi was driving at, including a waiting rider the player had tapped: the same
retarget rule every fare tap already follows, applied to one more kind of target, with the waiting
rider's clock draining exactly as it would have. On arrival the drive retires itself the way a
fare's legs do — route and target cleared, taxi back to cruising — and the drop-off pad that lights
up is itself tappable, so an empty-seat courier run is two taps end to end.

This is not an exception to the rule above; it is what the rule reduces to when the seat it
protects is empty. It also subsumes the old between-jobs case: with no destination at all there was
never anything to bend, and the tap has always routed at the box in that beat.

#### The corner answers, and the sign is the answer

A tap on a rider is answered by [the rider](#the-tap-pops), because what the tap *means* — the taxi
has been sent — is said by a band that starts a junction away from the finger.

A tap on a box has the opposite problem. The band's answer lands exactly where the finger is: it
bends and comes through the pad, which is the most legible confirmation in the game. What it cannot
say is **no**. A refused drag is felt through the finger — the band stops following, the gesture
hits a wall — but a refused tap looks precisely like a tap that missed a shape a few pixels across,
and the player's next move is to tap it again.

So both answers are given on the corner, on [the pop's own envelope](#the-tap-pops), and they
differ only in sign:

| | what the corner does |
|---|---|
| Taken | swells (`ACK_SWELL`, +22%) — and here is where the route bends |
| Refused | flinches inward and settles (`ACK_FLINCH`, −12%) — heard, and no |

One channel, not two. No colour: hue on this board is spoken for by the clocks, and a package has
nothing to report with it. No light either — a shape that grew *and* lit would out-shout the band
redrawing itself through the same corner on the same frame. The flinch is deliberately shallower
than the swell is tall: a refusal is the quieter event, nothing has changed and nothing is about to,
and a flinch as deep as the swell reads as a second kind of yes.

It rides the marker's `postGroup` — the kerb corner, with the pad and whatever is standing on it —
because the pad's own scale is spoken for by its arrival and exit animations and the box's by the
flight. And `main.js` calls it only once the re-plan has actually been attempted, the same
discipline `markDirected` keeps, so a refused tap can never be answered as though it had landed.

**The flinch is now nearly unreachable, and that is the point.** With
[the cap gone](#the-one-thing-the-tap-does-not-share-is-the-cap) the only refusal left is a leg the
router cannot solve, which a shipped city never has. That is the right way round: the flinch was
built to make a refusal legible and it could not carry the load it was given — a −12% squash on a
~10px box is not an answer a player reads, which is exactly why the capped version was reported as
the tap doing *nothing*. A cue this quiet is a safety net for a case that should not happen, not a
substitute for the case not happening.

### What the detour actually costs

Measured in `tools/probe.mjs`, over three cities, 420s of a perfect fare player who also couriers.
The one knob is how many extra legs of route the player will accept to reach a pad:

Re-measured at one slot (seeds 71624, 4242, 90210; the two-slot numbers this table used to carry are
in the row below it):

| Detour budget | Survived | Fares | Fare cash | Boxes offered | Delivered | Courier cash |
|---|---|---|---|---|---|---|
| **1 leg** | 420s, all three | 12–16 | $252–319 | 1–2 | 0–1 | $0–26 |
| **2 legs** | 297s, 403s, 420s | 8–12 | $135–261 | 3 | 2–3 | $40–54 |
| 3 legs | indistinguishable from 2 | | | | | |
| *(2 slots, 1 leg)* | *420s, all three* | *12–14* | *$233–296* | | *1–3* | *$14–57* |

The shape of the trade is unchanged: the two-leg detours roughly double the courier income and cost
the run in the worst city, and courier cash never comes close to replacing the fare income it burns
— $54 at the very best against $100-plus forgone. Greed is punished by arithmetic rather than by a
rule, and what is worth taking is the package that is nearly on the way already, which is exactly
the decision the layer was added to create. (Past two legs the cap stops binding at all; a 5×5 grid
is full of equal-length alternatives, the same finding [the drag's own cap](#dragging-the-route)
rests on.)

The probe therefore plays at a **one-leg** budget, not at `MAX_VIA_DETOUR`'s 6. A greedy player is
supposed to die there, and a check that asserted otherwise would be asserting the layer is free.

**What the single slot cost, and it is not nothing.** A box the player declines holds the board for
the rest of the run, so at a one-leg budget the layer now goes quiet: two of the three cities offered
exactly one box, it never came within a leg of the route, and nothing else ever appeared. Delivered
counts at that budget fell from 1–3 to 0–1. That is the honest price of "one question about one
corner" — the flip side of the box not being a supply is that a *bad* box is the only box. A player
who takes the occasional two-leg detour clears the slot and sees three, which is the behaviour the
pacing assumes. If it plays too quiet, the lever is not `MAX_PARCELS`: it is giving a long-ignored
box permission to move, which needs to happen without a countdown and without anything vanishing
from under a player already driving at it.

### Two kinds of load, and one of them has an address

A courier job is carrying a **box** or a **food order** — an oversized burger with a soda cup behind
it (`geometry/parcel.js`, `geometry/food.js`), drawn per package at even odds (`FOOD_CHANCE`).
Everything about the errand is the same either way — same pad, same cyan, same gestures, same money,
same fuel, same absence of a clock — with **one** exception, and it is the reason the second kind is
worth having at all:

**A food order is collected at the [burger joint](#the-burger-run).** Not at a corner the draw
liked: at the one place in the city that sells food. The junction is the joint's own +X+Z corner, so
the pad lands on the lot itself, by the drive-through's exit — `cornerFor` puts a kerb pin on the
−X−Z side of its junction, which makes `(bi + 1, bj + 1)` the one corner of that block whose pin
stands on the joint's slab rather than across the road from it. `main.js` derives it and injects it;
`parcels.js` holds no reference to the city layout, the same one-way arrangement `reserved` keeps in
the other direction.

The drive-through has been scenery with one secret in it for a long time. This makes it an
**address** — a building whose position the player learns because jobs come out of it — and the
delivery end is still drawn from anywhere, which is what a food delivery *is*: one origin, and the
whole map to take it to.

It costs something honest, and the trade is the same one the drive-through itself already makes. A
box is an errand between two corners the draw put near the taxi's route; a food order always starts
in the same place, so how good a job it is depends on where the taxi happens to be — and in a run
that never goes near that block, the food half of the board is not for you. That is a landmark
working, not a bug in the placement.

**A food order that cannot be collected is served as a box.** The joint's corner is unusable in three
ordinary ways — a rider is standing on it, the taxi is parked on it, or the city failed to place a
joint at all — and none of them is a reason for the board to sit empty. So `FOOD_CHANCE` is the
chance of *asking* for food, and what actually gets served is measured in `tools/probe.mjs` rather
than assumed to match it (43 of 80 on the probe's city). The one thing that would make the whole
feature vanish silently is a joint whose corner the camera cannot see — the
[sightline filter](#corners-the-camera-cannot-see) would drop it and the board would
serve boxes for the entire run, in a city that looks perfectly normal — so that is swept across
cities and asserted too.

**Everything else about the second kind is flavour, deliberately.** A second load is the obvious
place to hang a second *rule* — food that goes cold, an order worth more, one that has to be
delivered before the box the taxi is also carrying — and every one of those wants the thing this
layer does not have and [cannot grow](#a-package-has-no-clock-and-so-has-no-diamond): a clock. A
fixed origin is the one mechanic that costs the layer nothing it is built on. It takes no deadline,
it cannot fail, and it spends nothing but the map.

**Both kinds are common on purpose.** They pay the same and are collected the same way, so there is
no reason for the draw to favour either and every reason for both to be seen. A rare variant on a
board that shows one job every twenty to forty-five seconds is something a player meets twice in a
run and reads as a glitch — the courier layer is not a collection, and a load you have to be lucky to
see is one nobody learns is there.

How the two are drawn, and why the order had to be built into the box's envelope, is in
[rendering.md](rendering.md#the-food-order--geometryfoodjs).

### A package has no clock, and so has no diamond

The board's vocabulary is [shape says what a thing is, hue says whose clock is paying for
it](#the-drop-off-is-a-ring-and-it-wears-the-riders-clock). A plumbob **means** a countdown. A
package having no deadline is precisely why it must not have one — and it keeps the courier layer
from adding a second thing to read to a board that can already carry four fares. The cyan says
"courier job", full stop, which for a package is the only honest thing a colour can say.

It follows that nothing here can end a run. A parcel sits on its corner until somebody drives
through it; missing one is not a thing that can happen. It is pure upside by construction, the same
way a [VIP](#vip-pickups) is, which is what lets it stay optional without ever being a trap.

The hue is fixed and outside the [urgency scale](#urgency-is-one-scale) on exactly the argument the
VIP's purple is made on — and the *shape* is new for a reason the VIP did not need: a VIP is still a
fare, reached the way every fare is. A courier job is not, so it gets a silhouette of its own. Two
hues on one shape would ask the player to tell a package from a rider by colour at 50px; a rounded
square against a disc is read at a glance.

### The rest of it

- **One cargo slot, independent of the seat.** A second box the taxi drives past while loaded is
  left where it is — silently swapping the load would throw away a delivery already paid for in
  detour. The probe asserts the seat and the slot never touch: collecting a package does not move
  the rider's target and does not reset, pause or extend their clock.
- **Priced exactly like a rider going the same distance** — `priceFor`, stamped
  at spawn. `PARCEL_PAY_FACTOR` is the one number to turn if it plays too rich.
- **Cash and a splash of fuel.** No combo multiplier (that number means "this is what a *fare* is
  worth now") and no run-end stat row, but a delivered package does pour **a sixth of a tank** into
  Loco Mode — half what a drop-off pays (`BOOST_PARCEL_REWARD` against `BOOST_FARE_REWARD`). Both
  the payout and the fuel take the same [two-phase flight](#economy) a fare's do, because it is the
  same kind of event arriving from the same place. The half is the whole argument: an errand that
  paid nothing into the tank was the only job in the game whose reward the gas pedal ignored, and one
  that paid a fare's third would make a courier run the *cheap* way to fuel a run — six packages to
  a full tank keeps the fare the thing that fills it. With [one box on the board](#the-rest-of-it)
  that ceiling is a slow one to reach anyway: the fuel is a nudge toward a detour, never a supply.
- **One box on the board at a time** (`MAX_PARCELS`). Two pads are a *supply* — something you serve
  rather than something you notice — and two jobs' worth of cyan against a fare board that can
  already carry four discs makes the eye sort which box before it can ask whether either is worth
  the seconds. One box is one question, about one corner, which is the decision this layer exists
  to create.
- **A package is a find, not a fixture.** The gap between spawns is **drawn** per package (18–45s)
  rather than fixed, and a delivery pushes the next one further out again (`PARCEL_AFTER_DELIVERY`).
  A fixed gap makes the board a metronome — always something to detour for and nothing to notice.
  The fare board *wants* to be a steady supply, because serving it is the game; the courier board is
  the opposite. Cashing one in must not immediately produce another — that turns a find into a
  vending machine. At one slot the slot itself does most of the pacing: an uncollected box holds the
  board until somebody drives through it, and the drawn gap governs how long after a *resolution*
  the next one lands.
- **Neither board ever puts two jobs on one corner**, in either direction. The courier refuses to spawn
  on a fare's corner *and* `fares.js` refuses to spawn on a package's, through an injected `reserved`
  callback — injected rather than imported, because the fare loop has to keep working with nothing layered
  on top of it. Only the first half existed at one point, which made the rule *look* enforced while a
  package's indefinite wait guaranteed a later fare would eventually land on one. Blocks as well as
  junctions, since `cornerFor` flips its corner inward at `i === 0` and two intersections a whole block
  apart can still share a slab.
- **Never on a park.** A pad is a delivery address, and a park block has none — no door, no kerb cut,
  the box sitting among the trees — which on a [district](city.md#park-districts-close-roads) reads
  worse still,
  because a district is built *over* the road that used to reach one of its corners, so the pad stands
  beside a street the router knows is gone. Both ends are filtered, through `onParkBlock` in `fares.js`
  rather than a test written here: which block a corner pin ends up on is `cornerFor`'s −X−Z flip, and
  that flip has one owner. It is the only **hard** condition in the draw — every other one is about how
  good the errand is, and a bad draw there is a worse job; this one is not a job at all — so an unlucky
  city offers no box that frame and tries again on the next, which costs a layer with no clock nothing.
  The supply it spends is small: the leanest of 200 city seeds still leaves 24 of 36 junctions standing
  on pavement, and `tools/probe.mjs` asserts both that floor and the rule itself. The rule's check
  samples 80 fresh boards on one city rather than counting the run's own spawns — one board slot means
  a 420s run sees a handful of packages against a map that is a sixth green, so the run alone passes by
  not looking (measured: 0/2 in the run, 17/160 across the boards, with the filter deleted).
- **Packages land off the route the taxi is already driving**, at spawn. A box on a road the car was
  going to take anyway is collected for free and asks nothing. It is a spawn-time bias only — the
  next fare re-plans everything, and a package ending up on the new route is the "free money" case,
  which is fine and intended as the exception rather than the rule.
- **Never before the first delivery** (`PARCEL_MIN_DELIVERED`), for a sharper version of the reason
  a VIP waits: the second tutorial beat *is* "tap that rider", and a box on the board during it
  teaches the opposite lesson — it is the one thing on the board that tapping does nothing to.
- **`?parcels=0`** clears the board to measure the fare loop alone, the way `?cars=1` clears the
  roads. The layer is off in shot mode by default, since every framing in the sweep was composed
  before packages existed; **`?parcels=1`** forces it back on, which is the only way to point a
  camera at one (`?shot=22` and `?shot=23`).
- **The taxi does not wear its load.** A parcel on the rear deck would be
  [about four pixels](#the-load-is-carried-into-the-hud) at play zoom. The load is stated in the HUD
  instead, at a size that can be read, and the car says exactly one thing about what it is carrying —
  [the roof sign](#the-taxis-roof-sign), for a rider.

### The box visibly changes hands

Nothing about a package teleports. **The box flies**: out of the world and into the HUD on pickup, and
back out of the taxi into the pad on delivery, growing and fading in. It is the same argument [the
fare's crystal](#the-fares-clock-travels) is built on — nothing is created or destroyed at a hand-off,
which is why that flight is animated rather than a teleport — applied to the one object this layer
hands over. Details in [rendering.md](rendering.md#the-parcel--geometryparceljs).

**The pickup is two moves that cross-fade**, and the join between them is faked on purpose:

1. **In the city** (`parcels.js`, sim time): the kerb box is hidden and a flying copy takes over from
   the same spot — the same pose by *construction*, since the copy stands at the corner at
   `PARCEL_PAD_LIFT` and runs the same `idle` off the same clock. It rises, swells, slides away toward
   the corner of the screen the chip lives in, and fades out. The rise eases *out* (a thing being
   picked up); the drift eases *in*, accelerating away (a thing leaving).
2. **In the HUD** (`cargochip.js`, wall time): near the end of that — 78% along, with the world box
   down to ~a third opacity and still moving — `'loaded'` fires carrying the point the box had reached.
   The chip grows and fades in with a **short slide out of that direction**, capped at 120px, and
   inherits the spin the world copy was still turning at.

The first cut of this handed off **pixel-exact**: same point, same apparent size, same angle, on a
single frame, with the two ends of the seam verified to land on the same pixels. It was seamless and it
read as *too fast* — an exact hand-off has no moment in it where the object is visibly travelling, so
there is nothing to follow. Two shorter moves that overlap and agree only on **direction** take longer
to say the same thing and read as one journey. Which is why what leaves `parcels.js` is a point and a
direction rather than a pose, and why the chip quotes the box's position instead of tracking it.

Two more consequences worth naming:

- **The taxi's flourish fires on the pickup**, not on an arrival at the car: the whole car takes a white
  emissive lift on the [select pop](#the-tap-pops)'s own envelope, so collecting a package reads as the
  same *kind* of acknowledgement as a tap that landed.
- **`delivered` still pays out at once.** The money is earned on arrival, and making the player wait
  out an animation for it would read as lag. The chip goes down on that frame rather than when the
  outbound box lands: the flying box *is* the load leaving, and a corner still holding one while a
  package is being set down would read as the taxi carrying a second.

And the ground marks move rather than blink. A pad **grows out of its own centre** when it arrives and
pulls back into it when it leaves — as does a fare's disc, both ends. At a rider's pickup the kerb
disc now shrinks away on the same frame the drop-off's grows in, which is one clock changing ends of a
trip; two discs switching state in one frame was two events.

### The load is carried into the HUD

`src/game/cargochip.js` — the box itself at 42px under the cash total, up for exactly as
long as a package is aboard, and **flown there from the corner it was standing on**.

A deck parcel is the honest answer to "does the car have one", and at play zoom it is **about four
pixels**, on a car the player is mostly not looking at because they are reading the road ahead of it.
The cyan drop pad lighting up across town says *where*; nothing legible said *what*. This chip was
added beside the deck box to fix that, which left the board carrying two versions of one fact — so the
deck box went and the collected package comes *here* instead. That is also what lets the pickup be one
unbroken move: with nothing to arrive at on the car, the box has one destination rather than two.

- **The real mesh, not an icon.** `createParcel` in its own small WebGL context, lit by the city's own
  sun through `mirrorSceneLights` — the same rig as the [tutorial avatar](#the-opening-tutorial) and the
  [rider-finder chips](#finding-the-next-rider), so the box in the corner cannot drift out of
  step when the box on the road is restyled.
- **Three-quarter view, at the game camera's own elevation, with the azimuth mirrored** so that both
  visible faces are lit ones — see [rendering.md](rendering.md#the-parcel--geometryparceljs) for the
  angle and the framing.
- **It sits with the money, not where the rider chips were.** The bottom-left row is the reach zone and
  everything in it is a control; a chip parked at the end of it would be the one that does nothing when
  pressed. That got sharper rather than weaker once [the box on the road became
  tappable](#two-gestures-ask-for-the-same-bend): a second box on the glass that answers nothing is now
  a box the player has every reason to press.
  Up beside the cash total it is unambiguously a readout, and it inherits `#hud`'s `pointer-events: none`
  so a thumb that lands on it goes straight through to the city.
- **The box and nothing else** — no disc behind it, no rim around it. A rider chip needs its disc
  because the ring around it is a clock, and a clock needs a dial to be read against. A package has
  none, which is the whole of [why it has no diamond](#a-package-has-no-clock-and-so-has-no-diamond),
  so there was never anything for a ring here to say — and with the ring gone the disc is a plate under
  an object that does not need one. Bare, it reads like the rest of the HUD: the cash total and the ⏸
  are marks on the sky too. The only thing between the box and a pale road is `#hud`'s own drop shadow,
  which is what holds the digits up there as well.
- **It turns, slowly, the whole time it is aboard** — a 360° every 20 seconds, with a bob of 0.03
  world units (about half a pixel at 42px) on a 4.6s period. It used to land square and sit dead
  still, on the argument that the kerb box's spin *means* "this is a thing to pick up" and repeating
  it on a readout asks for a second pickup. What that actually bought was a live mesh in its own lit
  context posed to look exactly like a static icon. The distinction survives in the **rate**: the
  kerb box comes round every 11.4s and bobs 0.07, so this one is visibly the slower, calmer of the
  two — and a package cannot be selected at all, so there is no gesture for the misreading to cost.
  Under `prefers-reduced-motion` it parks square and level, checked per frame.
- **The arrival hands over to that turn.** It *inherits* the spin the world copy was still turning at
  and eases the excess away over the same 460ms — a box sitting dead square while the other one is
  visibly still moving reads as a different object — leaving it on the idle turn rather than stopping
  it. The residual is folded to the **nearest quarter turn**, which is at most 45° of travel: the
  box's footprint is square by design, so a quarter turn from square is the same picture, and landing
  the raw angle instead crams up to half a turn into the slide and reads as a flourish rather than as
  the same spin running down.
- **Raised by the hand-off, lowered by the delivery.** `flyIn` is what a `'loaded'` does to it and is
  what raises it; `setCarrying(false)` is what a `'delivered'` does. It opens small (0.45) and fully
  transparent, is opaque by 45% of the way in — so the *arrival* is the growth settling rather than a
  fade finishing — and lands with a hair of overshoot, the same punctuation the money counter's bump
  makes. Under `prefers-reduced-motion` it hands over to the plain pop.
- **Checked in `tools/smoke.mjs`, not in the node suite**: a WebGL context inside a DOM node, carried by
  a Web Animation, has no headless equivalent. Three assertions matter. The **share of the canvas actually
  drawn** — the frustum is computed from the box's own dimensions, so the failure mode is a correct
  element with the box framed off the side of it, which reads as a pass in the DOM. That it **keeps
  turning**: two draws a second apart, differenced per pixel, because a chip that draws once and never
  again is what a correct static icon looks like from the DOM and from any screenshot. That one is read
  per pixel rather than as a mean over the box — the two visible faces swing through the sun in opposite
  directions, so a mean nets most of the turn out (2 of 255 against 18) — and its floor of 8 is set above
  the **2.3** the bob alone reads, so a chip that wobbles without turning still fails it. And that the arrival
  **starts away from its slot, small and transparent, in the box's own quadrant, and ends square in the
  slot at full size**: an identity transform is a chip appearing in the corner while the box vanishes
  across town, and a sign error is one sliding in from the opposite side. The smoke run pins
  `prefers-reduced-motion: no-preference` through CDP for that check, or a headless build answering
  `reduce` would quietly be asserting the fallback.

## Crazy-taxi mode

The **Loco Mode** button is the gas pedal: the round orange button centred on the bottom edge,
100px across, with the brake to its left (see [the pedal slide](#the-pedal-slide)). Both are drawn
as an NES pad's buttons — Loco Mode is **A**, the brake **B** — black plastic surround, a dished
centre with the letter debossed in it, a hard glint (Tyler, 2026-10-15; `?pedals=classic` brings
back the round pedals with lightning and stop icons). **Hold to
enable, release to pause.** A short tap costs a short slice, a long hold flows until the tank is
empty. Full tank is 15 seconds of boost. The decision is *how long* to press as well as *when*.
The fuel level is the arc gauge round the pedal (`#boost-meter`, `game/fuelarc.js`), a 140° crown
over the top of it (~197° under `?pedals=classic`), off a `--pct`
CSS variable, dropping as you drain and climbing as a drop-off pours fuel in.

**Every drop of it is earned, except the way back out of empty.** The run opens with **a third of a tank**, each
successful drop-off pours in **another third**, a [delivered package](#the-rest-of-it) pours in **a
sixth**, and a [burger run](#the-burger-run) pours in **15%** — that is the whole list of sources,
and the first three are jobs done. The fourth is the one you buy: $10 off the counter at the window.
A top-up that lands while you're still holding the button rolls straight back into boost rather than
making you press again.

**An empty tank climbs back to a quarter, so the gas pedal is never dead for good.** Spend it all and
the gas pedal goes grey and dead (`.is-empty`, `disabled`) — and then the tank starts climbing behind it
at `BOOST_FLOOR_FRACTION / BOOST_REGEN_SECONDS`, a quarter of a tank over **five seconds**, with the
button coming alive on the frame it lands. Four things make it a recovery rather than a refill:

- **Only `'empty'` recharges.** Not a partial tank, not a tank being spent, not one frozen inside
  the `'cooldown'` momentum window. A player who let go with a sliver left keeps the sliver and gets
  no trickle; the climb answers a dead button, and running the tank out is what asks the question.
  (Spending that sliver is what runs it out, so the sliver is never a trap — just not a head start.)
- **It stops at a quarter.** 3.75 seconds of boost, half what a fare pays and a package and a half.
  Waiting is the worst rate in the game and it caps out immediately; deliveries are still the only
  way to a full tank, and a tank above zero never moves on its own.
- **The gas pedal stays dead for the whole five seconds** rather than waking on the first frame with a
  sixtieth of a second in it and going grey again under the player's thumb. A delivery outranks the
  climb: a pour lights the button on the frame it starts.
- **The climb is shown.** The gas pedal greys out, and the fuel gauge carries the climb: the arc
  fills back to a quarter in a muted gold (`#boost-meter.is-empty`), riding the pour's envelope —
  `updateBoostButton` feeds the recharge to `game/boostmeter.js` as a pour, so the climb gets that
  envelope and the spring at the end of it for free — but not its movement or its full glow
  (`#boost-meter.is-charging.is-filling`): a gauge bouncing on a pedal that refuses the press reads
  as "press me". The spring fires on the frame the button wakes.

Both ways out of a boost — letting go, and running the tank dry — pass through the one-second
`'cooldown'` momentum window first, so `'empty'` is where a drained tank lands *after* that tail
rather than the instant the fuel runs out. See
[traffic.md](traffic.md#boost-crazy-taxi-mode) for what stays armed through it.

**A tap and a hold are two different inputs, and only one of them moves the camera.** `heldSeconds()`
on the boost clock times the current press, and past `LOCO_PUNCH_HOLD` (0.25s) the frame pushes in
for as long as it lasts — see
[rendering.md](rendering.md#loco-modes-push-in). Anything else keyed on the press has the same
question to answer: taps are frequent here by design, so a jab must be allowed to spend its slice of
fuel without the view reacting to it.

Waiting buys back nothing above that bottom quarter, so the meter says how the run is going: all
but the bottom quarter of it was earned by a fare, and three deliveries is a full tank. Opening with
a third rather than empty keeps the toy in reach on the first fare — an empty start leaves the
button dead in the hand until the first drop-off lands, which is the same reason the recharge exists
at all: a run that has spent its tank and is between fares should still have one straightaway's
worth of Loco Mode within five seconds of asking. History:
[the old boost economy](gameplay-history.md#crazy-taxi-mode).

**There is no case where holding it does nothing.** [The drop-off dispatches
itself](#the-drop-off-dispatches-itself), so the taxi is never `parked` with a rider aboard and
boost applies from the pickup frame on. Every other reason the taxi slows while boosting is
traffic, and those are dealt with in [traffic.md](traffic.md#what-was-still-braking-it).

Pointer capture on `pointerdown` keeps the boost held even if the finger slides off the gas pedal;
`pointerup`, `pointercancel`, `lostpointercapture` and the window `blur` all release it, so
alt-tabbing or switching apps never leaves the boost stuck on.

That release path cuts both ways, which is why the gas pedal is `touch-action: none` rather than
`manipulation`. `manipulation` only drops double-tap zoom — pan and pinch stay live, and either
one starting on the gas lets the browser claim the touch and fire `pointercancel`, releasing a
boost the player still has their thumb on. Pointer capture then means nothing else arrives until
they lift and press again, so it reads as the gas cutting out with no way to get it back. The
case that hits it is exactly how this game is held: a thumb on the gas and a second finger
tapping a fare is a pinch gesture as far as the browser is concerned. `preventDefault` on
`pointerdown` is explicitly not a fix for that — `touch-action` is the only thing that suppresses
it, which is why the canvas has carried `none` all along.

### Spacebar

On a keyboard, **hold Space** — the same hold, for a hand that isn't dragging the mouse into the
corner. `keydown` and `keyup` on `window` route into the same `holdLocoMode()` / `boost.release()`
the gas pedal uses, so the wheelie, the flame, the launch rubber, the tutorial dismissal and the fuel
economy are all one code path with two ways in. Desktop-only by construction rather than by sniffing
for a desktop: a phone with no keyboard never fires a `keydown`, and a phone *with* one has earned
it.

Five things it has to get right:

- **`event.code`, not `event.key`.** The physical bar on any layout, and unlike a `key` of `' '` it
  doesn't need unpicking from the modifiers (Ctrl/Cmd/Alt+Space are the OS's, and are ignored).
- **Auto-repeat is dropped** (`event.repeat`). `boost.press()` would return `false` on every repeat
  anyway, so no wheelie stacks — but a held key firing 30 presses a second through the tutorial
  dismissal and the disabled check is noise the guard costs one line to remove.
- **It only claims the key when nothing focusable has it.** Space is the browser's own activation
  key: tabbing to "Play again" and pressing it has to press *that*, so `keyIsSpokenFor()` bows out
  when the target is inside an `input`, `button`, `select`, link or contenteditable. The gas pedal itself
  is the exception, and not an optional one — clicking it once moves focus onto it, and without the
  exemption the hotkey would go dead for the rest of the run: the browser synthesises a `click`,
  which nothing here listens for.
- **The Home Screen tip outranks it.** `game/homescreen.js` dismisses itself on Space and holds the
  run behind it, so the press that clears that screen must not also spend fuel on a parked taxi —
  the same `homeTip.state.holding` guard the tutorial uses. Our listener is registered first, so it
  sees `holding` still true and bows out.
- **So does [the pause](#pause).** `frame()` returns before `boost.update`, so a press behind the
  veil would sit in `'active'` burning nothing and then resume into a launch nobody asked for — the
  mirror image of the release `createPause`'s `onChange` performs on the way in. Escape, P, ⏸ and a
  tap on the veil all stay live; Space is not another way out of the pause screen.

The window `blur` release matters more here than it did for the pointer: a keyup that lands on
another window never arrives at all, so alt-tabbing mid-hold is the case where blur is the *only*
end that hold gets. It clears the `spaceHeld` latch too — that latch is what stops a stray keyup
(one whose keydown we bowed out of) from cancelling a boost the player is holding on the gas.

The gas pedal carries `aria-keyshortcuts="Space"`; there is no painted "SPACE" label on it, because the
fuel gauge sits on it and the tutorial's third beat points at it.

### The refill animation

A drop-off pays two currencies and for a while it only showed one. The flying `$20` says *money*;
nothing said *and a third of a tank*, so the meter simply grew on its own in the corner of the
screen with no visible cause. `src/game/energybits.js` is that cause: **six little yellow sparks
break off the taxi and get pulled into the fuel gauge over the gas pedal**, and the tank is topped up when the first
one lands, not on the delivery frame. A meter that starts filling a second and a half before
anything visibly reaches it reads exactly backwards.

They are **sequenced behind the payout, not fired alongside it** — the handoff is 1000ms, set from
the payout's own flight (620ms rise + 460ms fly), so the coin has landed and gone before the first
spark appears. Two swarms leaving the same car at the same time for two different corners is noise,
and the two currencies stop reading as two. The cost is that a delivery's fuel arrives ~1.6s after
the drop-off rather than immediately; that delay is the effect, and it's short enough to sit inside
the gap before the next fare is worth chasing.

Both endpoints are resolved as functions at burst time rather than baked in at call time, so a taxi
that has driven on — and a gauge a resize has moved — are still aimed at correctly. If the gauge is
hidden (shot mode, or the run-end blackout) the flight is skipped and the fuel is handed over
anyway: losing earned boost to a presentation detail would be a real bug wearing a cosmetic one.

A delivered package fires the same swarm from the same car to the same gauge, for `BOOST_PARCEL_REWARD`
instead — one effect for "you got fuel", regardless of which job paid it. It sits behind the courier
payout's flight for the same reason a fare's does.

Then the pour itself. `boost.topUp(BOOST_FARE_REWARD)` queues the fuel as *pending* and pours it in
at half a tank per second (~0.7s) so the bar visibly fills rather than snaps. A package's sixth takes
half that (~0.35s), which the probe pins as the floor: below about a quarter-second the fill stops
reading as a fill and starts reading as a jump. Since that pour is now the *only* way fuel ever
enters the meter, it carries the rest of the reward and gets three more layers, all timed by
`src/game/boostmeter.js` and shaped in `index.html`:

| Layer | What it does | Wiring |
|---|---|---|
| **Overfill** | The bar runs ~4.5% of a tank past its new mark, then rings back down onto it | `--pct` |
| **Flutter** | The fuel gauge throbs — glow and 1.2% of scale together, 4Hz — for as long as fuel is arriving | `--fill` × `--pulse` → `.is-filling` |
| **Leading edge** | A soft bright dot rides the fuel's front, fading in with the pour and out with the bounce | `--fill` → `.boost-edge` |

`boostmeter.js` is pure and DOM-free for the same reason `boost.js` is: `main.js` reads three numbers
off it and writes three CSS variables, and the probe drives it with a real pour and asserts on the
same numbers. It keys off `boost.state.pending`, so nothing has to remember to fire the animation and
a second delivery landing mid-pour just extends it.

**The overshoot is authored, not simulated.** The obvious version — draw the bar as a spring chasing
the real fuel level and let its momentum carry it past the mark — was built and measured first: 3.3%
of a tank at its best (K=160, C=4), about 4px on the gas-shaped gauge it was measured on, and a 1.4s wobble to settle. A spring
following a ramp can only overshoot by around v/ω, and a 0.5-tank/s pour against any ω fast enough
not to look sluggish leaves nothing to work with. The scripted kick starts on the frame the pour
finishes, so it still doesn't read as a jump — the bar is already travelling at the pour rate and the
kick just carries it further, 0.1s out to the peak.

**Coming back is a damped ring, not a curve.** The first version eased from the peak down onto the
mark and stopped there, which is the exact moment the eye is on it, and it read as linear — the bar
*arrived* rather than *settled*. The peak now releases into a decaying cosine (4Hz, e-folding at 8/s)
so it dips under the mark, comes back over it smaller, and converges: off a 4.5% overshoot the swings
measure **-1.7%, +0.6%, -0.2%**, then it snaps to the real level once the ring is under a fifth of a
pixel, about 0.43s in. This is the spring the scripted kick doesn't get for free. Both the overshoot
and the decay were pulled back from an original 7%/7-per-second pass that read as too bouncy.

The flutter runs at 4Hz: at 8Hz a pour that landed several energy circles at once stacked up
enough pulses to read as chaotic rather than lively, and 5Hz read as "breathing". It swells the
gauge as well as lighting it, which is what makes it visible at the edge of vision — where the gas
pedal is while the player is watching the road. `prefers-reduced-motion` drops the scale and keeps
the glow and the edge.

The glow is yellow, not the flying `$20`'s green: green reads as *money*, which is what the earnings
pop already says; yellow says *this is boost*. Driving its alpha from a variable rather than a
keyframe is also what lets it fade out cleanly however long the pour ran.

While active the taxi runs at 2.2× speed, forces its next junction green, doesn't slow for
corners, lays **skid marks** off the line and through turns, and kicks up **dust**. See
[rendering.md](rendering.md#effects) for how those two are drawn.

**And it overtakes.** A slower car in front on a straight road is no longer something to sit
behind: **blip the button (off and straight back on) while you're behind it, and the taxi pulls a
full lane into the oncoming side, goes past, and comes back** for as long as you keep holding.
Holding alone rams it (`game/overtake.js`), so it's the combo or the brake. Letting go is the abort — it tucks in behind
instead. So the button stops
being a throttle at exactly the moment it gets interesting and becomes a question: is that lane
clear enough, and is that car about to turn across you? Nothing protects you either way. Collision
detection is armed for the whole of Loco Mode, so an oncoming car is a hit that costs
[hit points](traffic.md#bumps-and-hit-points), and the last one is the wreck. It buys real speed —
time stuck behind traffic drops from 10.4% of boosting to 4.5% — and the numbers, the geometry and
the reason an earlier version of this was abandoned are all in
[traffic.md](traffic.md#overtaking).

It pulls out whenever the road allows — an oncoming lane to borrow, and straight on through the
junction ahead — and never because the sim decided it was a bad idea. A car already turning across
the lane you want, or oncoming traffic in plain sight, is yours to read: holding the button is the
decision. Gates that refused those read as the button not working and then as a rear-end; see
[traffic.md](traffic.md#when-it-is-allowed).

**And it does not stop.** Not for a full exit lane, not for a car stranded in the box, not to
yield on a left — the three ambient courtesies that could still bring it to a halt at a junction
its priority hold had already turned green. Driving into a junction with something in it is a
hit instead, because collision detection is armed for exactly as long as the mode is. That is the
bargain: the only thing between you and a wreck is what you can see coming, and the button is the
only brake. See [traffic.md](traffic.md#nothing-stops-the-taxi) for the mechanism and the numbers
— it turns out to be *faster* than letting it yield, and it barely moves the crash rate, because
the holds were rare enough to cost the mode its feel without protecting it.

**Releasing isn't an instant off.** For `BOOST_COOLDOWN` (1s) after the button comes up — or the
tank runs dry — the taxi is still exposed to everything Loco Mode was: it can still crash into
traffic, still sets a patrol cruiser after it if one is in range, still forces the next light. What it loses
immediately is the speed — the cap drops back to cruise the moment the hold ends, and ordinary
braking (the same constant every other stop uses) hauls it down from 22.1 to 8.5 in under a
second, nose dipping hard the whole way. So letting go a beat too late doesn't buy safety; it buys
a car that's still committed to whatever's in front of it while visibly losing the ability to
dodge. Re-pressing mid-cooldown cancels it and snaps straight back to full send. See
[traffic.md](traffic.md#boost-crazy-taxi-mode) for the mechanism.

The press itself also fires a **wheelie**, a tailpipe **flame burst** and a half-second launch
streak of rubber — all three gated on `boost.press()` returning true, so they fire on the
transition into Loco Mode and not on a re-press during a boost that's already running.

The **hold** has its own effect, and it is a different object: a flat stylized flame that burns out
of the tailpipe for exactly as long as the button is down (`game/locoflame.js`, and see
[rendering.md](rendering.md#the-tailpipe-plume--gamelocoflamejs)). The burst is the bark on the
press; this is what says the mode is *still on*, which nothing but the draining fuel gauge said before.

## The burger run

**Tap the burger joint.** The taxi drives itself round to the drive-through, crawls the lane, stops
at the menu board and again at the pickup window, and comes back out onto the road with **15% of a
tank** of boost — 2.25 seconds of it, the smallest top-up in the game and the only one that isn't
paid out for a job. It is the only one the player pays *for*: **$10** off the run's cash
(`BURGER_PRICE`, `game/fares.js`), taken at the window on the frame the order is handed over.

It is a secret rather than a mechanic, and everything about it is sized to keep it one. Nothing on
screen advertises it, nothing in the tutorial mentions it, and the reward is small enough that a
player who finds it has found a treat rather than a strategy. What it costs is that tenner and
**time on whatever clock is already running**: the rider in the back keeps counting down the whole
way there, through both windows and back out again. Measured tap to kerb, the trip is **12s** when
the taxi is already coming down the joint's own street, **28s** for a lap of the block, and **38s**
from the far side of the city — against 2.25s of boost. So it is a bad trade taken on purpose and a
good one when the taxi was going that way anyway, which is the whole of the decision on offer.

**Why it is not free.** It was, and free made it a strictly-better detour once found: the only price
was a clock the player was already spending, so every tap taken on a route that passed the joint was
pure profit and the decision stopped being one after the first time. Ten dollars is about half a
plain median fare and a quarter of a perfect one, which is the right way round —
the tank is worth most when the multiplier is small, and so is the money. It does **not** scale with
the multiplier: the tank it buys is a flat 2.25 seconds at every point in the run, and a price that
climbed would quietly make the same purchase worse for no reason on screen.

**The counter goes down, visibly.** The charge takes the payout's own flight in reverse sign — a red
`−$10` rises off the taxi, flies to the counter, and the total *rolls* down and bumps red when it
lands (see [Economy](#economy)). Digits dropping on their own is the exact side effect the two-phase
flight exists to prevent, and it does not become acceptable because the number is going the other
way. The boost bit flies to the gauge on the same frame, so a player who reads neither number still
sees one thing bought with another.

**An empty till is not refused; it is emptied.** A run's cash is its score — the counter prints it,
the run-end card prints it as "Cash", the score table sorts on it — and none of the three has any
idea what a negative total means, so a player who taps the joint on $4 pays $4 and still gets the
boost. Debt is not a thing this game has, and the secret is not the place to introduce it.

Nothing refuses the tap. A rider in the back does not refuse it, a full tank does not refuse it, an
empty till does not refuse it, and no clock is consulted first — the same rule
[a package detour](#what-the-detour-actually-costs) follows, for the same reason: it is the player's
call, and the band redraws through the joint on the same frame so the cost is visible before a wheel
has turned. Tapping a rider, tapping a package, or picking a rider off a finder chip all take the
wheel back, and the burger is off — silently, because the player has just said what they want
instead.

**The destination is a lane, not a junction.** The lot can only take a car off one kerbside lane —
the one running −X along the block's +Z edge — so a route planned to the junction at either end of
it arrives from whichever side is cheapest and drives straight past the thing the player asked for.
`findRouteOnto` (`game/route.js`) is a router that takes a lane instead of a corner, and it is the
whole of what makes the tap land. The obvious version — route *via* the junction the lane leaves —
looks right and fails about one trip in five, because the second leg is planned from the heading the
first one arrives on and a U-turn is not a legal exit: the router answers with a three-leg lap that
reaches the right corner from the wrong side. See
[the drive-through](traffic.md#the-players-own-visit) for what happens once the taxi is in the lot,
and `game/burgerrun.js` for the trip.

That has a tail the player can see: a lane is driven to its *end*, and the trip ends at the
driveway part-way down it. Drawn literally, the route band ran on to the junction the lane leaves —
**13.7 units past the joint**, three-quarters of a block of paint pointing down an empty road at
nothing, which reads as the tap having aimed at the wrong thing. So the target the taxi is sent at
carries an `endAt` point as well as its junction, and `routePath` (`game/routeline.js`) trims the
drawn path to it. It is on the target rather than passed in so that the band, the drag's hit test
and shot mode all get the same path without any of them knowing which kind of trip is running.

Two consequences worth knowing:

- **A taxi that has just gone past the driveway is sent round the block.** There is one way into a
  drive-through, and the pass is spent. It is the honest answer rather than a punishment — but it is
  a lap of a block, so tapping the joint as the taxi passes it is the expensive way to do this.
- **Loco Mode is dead while the taxi is in the lot.** A gas pedal leaned on at a pickup window would pour
  the tank into a car that cannot move — fifteen seconds of it if the queue in front is two cars
  deep — so the press is refused and a held one is released for as long as the visit lasts.

## Repairs at the depot

**Tap the depot with a damaged taxi** and it drives itself back to its garage, goes in, and comes
back out with its [hit points](traffic.md#bumps-and-hit-points) full and every piece of
[damage](traffic.md#bumps-and-hit-points) gone. The visit is
[the opening vignette](#the-opening-vignette) played backwards and then forwards: the camera comes
down onto the door as the taxi turns in off the lane, the door rolls up, the car drives into the bay
and the door comes down behind it — **to a fifth open**, with a welder's arc, sparks and grit
spilling out from under it while the shop works — and then the opening itself runs from `door` on,
a clean car in a lit doorway, out, down the kerb and back into traffic.
`game/depotrun.js` is the trip there; `enter()` in `game/opening.js` is everything from the lane on.

### The depot's card

Nothing would otherwise say a repair is a tap on the depot. The car wears its damage, but a smoking
car is a warning without an instruction, and the garage is a building like any other until you know
what it is for. So a beat (`SHOW_DELAY`, 0.9s) after the taxi first starts smoking —
`SMOKE_FRACTION`, 34% HP, the third of the four [damage tiers](../src/game/taxidamage.js) — the
[New Move card](#new-move-unlocked-the-overtake-u-turn-and-drift-cards) goes up with **"TAXI DEPOT / Tap for
Repairs"** (`REPAIR` in game/newmove.js). Earlier and it would be nagging about a swinging lamp; at
the 20% plume it is one hit from too late.

The card (Tyler, 2026-10-06) is **once ever** (`simTaxi.seen.repair`), stops the world like the
move cards, and answers to the same gates: the tips setting, debug mode, the opening tutorial being
done, and a calm beat (`newMoveCalm`) — a getaway, a patrol chase or a taxi already on its way in
defers it, and it is tried again every half second for as long as the car is still smoking. No
pedal row: the instruction is a tap, so the line says it, and the clip is just the visit. History:
[the depot's card](gameplay-history.md#the-depots-card).

**The clip** (`game/repairclip.js`, ~9s) is filmed on the player's own depot: a smoking stand-in
(the real damage rig, three knocks in: bonnet, boot, dragging bumper) comes up the lane and turns in, the door comes down to `REPAIR_GAP` and the shop welds, and the
door goes up on a clean car that drives back out onto the street. It is not a recording like the
move clips: the visit is a script, not physics, so `scriptVisit` runs the same script again off the
same `entryPath`/`exitPath` and the same numbers (`VISIT` in game/opening.js). Its two departures are
on purpose: the shop works `CLIP_REPAIR` (1.2s, against the game's 2.4) and the door starts down as
soon as the car is wholly behind the curtain, because a loop is watched more than once. The door and
the welding are the city's own, borrowed while the world is frozen and put back shut on close; the
player's taxi and the frozen traffic are hidden from the clip and left in the still. `__taxi.newMove.open('repair')` opens it.

| Phase | What happens | Length |
|---|---|---|
| `enter` | Off the lane round the mirrored fillet and up the kerb, the door winding up on the opening's own ease from the frame the car turns in. The camera eases onto the door at `DOOR_ZOOM` | ~2.5s |
| `shut` | The door comes down behind the car to `REPAIR_GAP` (a fifth open), its brake lamps going dark as it does | 0.72s |
| `repair` | The car is fixed and turned round under the first flash, and the shop works: arc light strobing in the gap and across the forecourt, sparks skittering out from the weld, grit drifting out low (`game/repairfx.js`) | 2.4s |
| `door` … `release` | The opening, except the door winds up from the gap rather than the floor | ~6s |

Measured end to end in `tools/probe.mjs`: **11.6s** from the turn-in to the camera handed back on a
clear road, plus up to `HOLD_MAX` (5s) when the car has to wait at the kerb for a gap.

**The repair beat is the door left open, not a fade to black.** A fade says "time passed" and
nothing about what it was spent on. A roller door stopped
short of the floor with a welder going behind it says *repairs* on its own. The gap is a fifth of
the door for a measured reason: the camera looks down at 33°, so 0.68 units of gap shows about a
unit of floor behind the curtain — enough for the light and the sparks to come out of, and not
enough to see the car turned round (the near bumper moves 0.39 units, under the arc's first
flash). The arc light is two additive quads, not a `PointLight`, for the program-cache reason in
CLAUDE.md; the sparks and the grit are the existing pools in `game/sparks.js` and `game/dust.js`.
In real time it costs about half a second more than the fade did (160 + 1000 + 300 ms of wipe and
a 0.45s beat, against 2.4s of work).

**The clocks stop for it.** Every fare on the board holds its countdown from the turn-in to the
camera being handed back — `holdFareClocks` in `main.js`, which is also where the tutorial's hold
lives, so neither can release a hold the other still wants. What a repair costs in time is the
**drive there**, on the waiting riders' clocks, which is the decision.

**It costs $25** (`REPAIR_PRICE`, `game/fares.js`), taken on the frame the car is back on the
road: a red `−$25` rises off the repaired taxi and flies to the counter, the burger's charge on a
bigger number. Before the price the only cost was the drive there, and a player on a fifth of their
HP with time in hand got a whole car back for fifteen seconds of driving. $25 is more than a median
fare early in a run and less than one by the last shift. Like the burger, an empty till pays what it
has and is never refused.

**Refused on an undamaged car.** There is nothing to fix, and a visit holds every clock on the board
— a free one is a pause button with a garage on it. Refused while anything else is driving the taxi
(the drive-through) and while the depot is busy, which covers the run's own opening.

**A rider waiting in front of it does not hide it.** A rider's tap target is an invisible quad
11 screen units across (`geometry/marker.js`), and on a corner in front of the depot it covers
half the building's front. `choosePick` in `game/pick.js` lets an invisible stand-in yield to the
first *drawn* surface along the ray when that surface is the depot (or the burger joint) and the tap
would be taken; the rider's own figure, crystal and disc are drawn, raycast and tagged as the
rider's (`stampFareMarker` in `game/fares.js`) and in front, so they still mean the rider. Every
marker's `postGroup` carries its kind so a pad or a parcel on the corner counts the same way. While
a repair would be refused — undamaged car, rider aboard — the margin stays the rider's, since the
alternative is a tap that does nothing. History:
[repairs at the depot](gameplay-history.md#repairs-at-the-depot).

**Refused with a rider aboard.** A fare doesn't ride along to the garage — and before this rule they
did, with the visit's held clocks freezing the very countdown in the back, so a damaged car could
buy ten seconds on a running fare. Drop them off first.

**It drives in nose first, not in reverse.** The literal reverse of the opening is the taxi backing
in, and backing in means stopping on the live lane past the driveway first. A staged car is invisible
to the lane bookkeeping (see the note at the top of `game/drivethru.js`), so anything behind the taxi
would drive straight through it while it stood there. Turning in off the lane clears the carriageway
in about half a second, the same trade the drive-through's entry arc makes. The car is then put on the
opening's start pose facing out, under the black and behind the shut door. The entry path is the
exit's fillet mirrored about the driveway; the probe asserts the mouth is exactly where `placeCar`
has the car on the merge lane.

**Nose-in, it parks at the back of the bay, and switches its lamps off.** The first cut parked it
on the opening's own spot, which put the tail 0.25 behind the curtain — inside the bloom's depth
bias (0.28, `DEPTH_BIAS` in `game/bloom.js`), so the brake lamps, lit at any standstill, glowed
straight through the door as it came down. It now parks 0.25 off the back wall instead (tail 0.64
behind the curtain), and `stageLampsOff` in `sim/traffic.js` takes the brake lamps down once it has
stopped — a loose rear lamp hangs on a 0.6 wire, so distance alone is not enough margin.

**The destination is a lane**, for [the burger run's reasons](#the-burger-run): the driveway opens
off the near lane of the road the door faces, running +Z, so the route is `findRouteOnto` that lane
and the band is trimmed at the mouth by `endAt`. The taxi stays in the traffic model right up to the
mouth and is caught on the frame it reaches it — a taxi that went past, boosting or weaving wide, is
sent round the block for one more go. The same identity rule as the burger holds too: anything else
the player aims the taxi at takes the wheel back — including a rider boarding en route, who is
dispatched to their drop-off and ends the trip there (the burger run hands the wheel back to the
joint; the depot doesn't, because a repair is refused with anyone aboard). A taxi already turning
into the driveway when the pickup lands finishes its visit and drives the drop-off on the way out.

**The job comes back on the way out**, on the frame the car is back in the traffic model rather
than when the camera lets go — the handover is 5.5 units short of a junction, and a car with no
route there turns at random. A rider aboard outranks whatever was remembered at the tap
(`resumeJob`, shared with the burger run). A tap on a rider *during* the visit stands: `stageCar`
never saw that route, and the lane it was planned from is the one the car is released onto.

**Loco Mode is dead for the whole visit**, and `taxi.boost` is forced off while the car is staged —
boost's one-second cooldown tail outlasts the turn-in, and `sim/collisions.js` charges hits off
that flag, so a car arriving on the gas could otherwise wreck on the kerb it was driving over. The
unarmed shove is closed on `staged` for the same reason: a cut scene owns the taxi's position.

**A tap skips it** — the opening's own cut to black (`game/wipe.js`), with the visit landed
underneath: fixed, back on the lane, the job handed back and the $25 charged, exactly as the end of
the sequence would have. With one exception, which is why it is not the opening's `window`
listener: the board is live during a visit (only its clocks are held), so a tap on a **rider, a
drop-off or a package** keeps meaning that and plans the job the car comes back out to. Anything
else — the sky, the depot, the taxi — skips. It is wired at the top of the picker in `main.js`
(`JOB_KINDS`) and on `click` rather than the opening's `pointerdown`, so a drag across the map
during a visit is not a skip either.

## The brake

The **Brake** pedal: a round red button two thirds the size of the gas (66px against 100px), to its
left on the bottom edge, the two centres on one line. Hold it and the taxi hauls itself to a stop
wherever it is; let go and it drives itself again, because driving itself is the game's resting
state and the brake never took that away — it only outranked it while held. The physics is in
[traffic.md](traffic.md#the-brake-pedal); this is what the player touches.

**It costs nothing and cannot run out.** No meter, no fuel, no cooldown, nothing to earn — which is
why it carries no gauge. A dial on it would promise a resource that isn't there.

**Red, and smaller.** The same hold-to-hold contract as the gas, the same `touch-action: none` and
art-in-a-`pointer-events: none` iOS suppression (see [above](#crazy-taxi-mode)) — so colour and size
do the work of telling the two apart at the edge of vision, where this pedal is while the player is
watching the road. Held, it lights (`.is-on`, a touch brighter) rather than dimming: it is a brake
*light*, and the taxi's own lamps are coming on out on the road at the same moment.

Both pedals are independently `position: fixed` rather than flex children of a row: the gas at
`--gas-left` (half the viewport less its radius), the brake at `--gas-left` less `--pedal-gap` and
its own width, raised to share the gas's centre line. A wrapper would put a new element between
`#boost` and the viewport, and the gas is measured (the tutorial aims its third bubble at its
`getBoundingClientRect`), animated (`translate` on the HUD entrance) and pressed through pointer
capture. History (the 60/40 pill row): [the brake](gameplay-history.md#the-brake).

**The row sits on one inset, and that inset is derived rather than typed.** The gap the player sees
at the bottom is the constant plus `env(safe-area-inset-bottom)` — 26px on a desktop and 60pt on a
notched iPhone, from one declaration. So `--ctl-inset` halves the *sum*
(`(26px + var(--safe-bottom)) / 2`), which is 13px on a desktop and 30pt on a phone. 30pt still
clears the home indicator's ~21pt of edge protection, which is why the bottom may spend part of the
safe area rather than sitting on top of all of it. The rider-finder chips, the taxi finder and the
coach bubble are all stacked on `--ctl-bottom` and `--ctl-h` rather than placed on their own, so the
whole bottom cluster moves together.

**Last pedal pressed wins.** Pressing the brake releases Loco Mode and pressing Loco Mode releases
the brake, so a two-thumbed player never ends up spending fuel against a speed target of zero — the
tank keeps whatever is left in it. The sim doesn't depend on that arbitration: hold both by any
means and the brake still wins, because it replaces the target the boost ceiling would have set.

### The bootleg: boost, then brake twice

`game/bootleg.js`, `spinTaxi` in `sim/traffic.js`, wired in `holdBrake` in main.js. In Loco Mode, tap
the brake twice within 350ms and the taxi turns 180° onto the far lane, with a screech, a jolt of
shake, a haptic buzz and four-wheel rubber. There are two cuts of it:

- **The handbrake turn** (default; `handbrakePath` in `sim/traffic.js`). Path-first: the car's centre
  drives a hairpin, a run on down the road as far as its speed carries it (0.35 units per u/s, up to
  5 units into the junction ahead), a round bulb across, and back out along the far lane. The body
  points along the path plus a slip that builds as the handbrake goes on (up to ~49°) and lets go
  by the exit, never turning back. Timed off the drift: it goes in at the speed from *before* the
  combo's first brake tap and holds it all the way round (0.5-1s), throwing tyre smoke, and lands
  on the drift's tier-1 exit kick and carry, flame bark and all, but no fuel refund. The kick is
  automatic: a version that made Loco earn it was tried and Tyler preferred it on every landing.
  No slow-mo, by Tyler's call: the move is a quick reversal, not a cinematic one.
- **Classic** (`?uturn=classic`): the first cut, an angle choreographed over 0.76s with the
  position slid underneath; see [history](gameplay-history.md#the-bootleg-boost-then-brake-twice).

It exists because a chase gave the player nothing to do but hold the gas pedal. In a getaway the cut-off
cops are in the junctions *ahead* (see [the chase](#the-chase)), and a 180 puts every one of them
behind you.

- **The combo checks Loco Mode as *engaged*, not held.** The first tap is an ordinary brake and
  releases the gas pedal (last pedal pressed wins). The gas's one-second tail (`BOOST_COOLDOWN`) is
  still engaged at the second tap, so that is what the combo reads. B pressed twice does it on a
  keyboard.
- **There is no clearance test.** The cop's U-turn (`uturnWindow`) waits for a narrow window and a
  clear road, which suits a car the collision pass does not test. The taxi *is* tested
  (`sim/collisions.js`), so whatever it spins into is a bump it pays for. Doing it in traffic has a
  cost, and that is the cost.
- **A combo that lands mid-junction or mid-overtake waits** up to 0.7s for a straight lane. At
  chase speed the taxi is crossing a junction a large share of the time, and refusing those taps was
  the commonest refusal in a bot sweep.
- **It lands short of the stop line ahead.** The landing point is clamped to stop short of the far
  lane's stop line. That line belongs to the junction behind the taxi, and landing past it would run
  the light (see CLAUDE.md).
- **The brake is ignored until it comes back up.** The second tap is usually still held when the
  spin lands, and braking then would stop the taxi broadside.
- **It is refused on arterials, on bridges and below 4 u/s.** An arterial's centreline is a planted
  median, and a bridge deck is arched. A refused combo is simply a brake. `tools/probe.mjs` spins
  the taxi on every lane: on its seed, 106 lanes spin and 26 refuse (20 median, 6 bridge).

### The drift: Loco, tap the brake, Loco again

`driftTaxi` / `kickDrift` in `sim/traffic.js`, wired in `holdBrake` and `holdLocoMode` in main.js.

**Only the combo slides.** Through a drift the nose swings ~31° past the heading on a spring
(`DRIFT_ANGLE`, render only; the front wheels countersteer) and rocks back once on the exit, and
all four wheels mark the road. A plain Loco corner keeps its lean and rear rubber, so the combo is
easy to tell from simply holding the gas. Corner speeds are the same either way — a left at the
boost cruise, a right at 0.75× — because slowing every corner to make room for a reward was a
bummer.

**The move is a combo for an exit kick.** Holding Loco into a turn, tap the brake in the last 0.6s
of approach (never under 8 units) or the first 35% of the arc, then get back on the gas before the
arc is over. The taxi comes out at 1.4× the boost cruise (`DRIFT_EXIT`, 30.9 u/s; 1.2× read as too timid), put on in one
frame and held for 0.6s, straight on through the next junction if the route goes that way (dropping
it at the junction cut every kick to ~0.4s, the time a 31 u/s car takes to cross the ~12-unit exit
lane) and ended by a real turn or the brake. The slide — screech, four-wheel rubber, swing, the
cruise held round the corner — starts on that second Loco press, not on the tap.

The kick has to read at a glance, and a buzz and a shake alone did not: the first playtest could
not tell when it had worked. It now says so with the tailpipe flame splitting into two longer
violet barrels (`locoFlameDrift*` in palette.js, so it is a different fire from the ordinary
orange one) for as long as the kick holds (`surge` in `game/locoflame.js`), a bark of fire, the Loco
whoosh, a bigger jolt, and the gauge filling. (A "DRIFT BOOST!" word off the roof was tried and
cut.)

**Kicks chain, up to three** (`DRIFT_CHAIN` in sim/traffic.js). Start the next drift within 2.5s
of the last kick running out and land it, and it comes out a tier harder: 1.4×/0.6s, 1.55×/0.75s,
1.7×/0.9s (30.9, 34.3, 37.6 u/s), the flame and the jolt 1.3× and 1.6× bigger, and the flame
cooling from violet to blue to teal (`locoFlameChain*` in palette.js). The window lapsing, a
tap with no kick after it, or any HP lost since the last kick puts the next one back at tier 1.

**A landed kick refunds a sixth of a tank** at tier 1 (`DRIFT_CHAIN.fuel`, the same as a parcel),
a ninth at tier 2 and a twelfth at tier 3 — a harder kick on the full refund is a boost that never
runs out. So a player
running low can drift their way to a drop-off. It needs *some* fuel to start — the combo is a
Loco press — and a kick costs well under a second of Loco against the 2.5s it pays, so chaining
corners is net positive. That is deliberate: it is the skill being paid.

- **The tap alone is a brake.** At 13 u/s or more (`DRIFT_MIN_V`, so only off the gas) with a
  real turn within reach it *arms* a drift (`driftTaxi`), and nothing else: the brake sound, the
  rubber and the deceleration are an ordinary press's, and held, it stops the car. A tap that
  started the slide read as the brake giving the car a shove (Tyler, 2026-10-07). Only a kicked
  drift (`driftHolds`) slides, holds its speed and is deaf to the pedal.
- **A thumb sliding back onto the gas pedal releases the brake,** which is the pedal slide doing what it
  always did, and is how the kick press takes the car back off the brake.
- **Two taps are still the bootleg, near a corner or not.** The first tap is the same in both
  moves, so only the second input decides: the gas pedal is the drift kick, a second brake tap inside
  the bootleg's 350ms window drops the drift and spins (buffered past the junction, as any combo
  landed mid-junction is). Away from a turn the bootleg is untouched.
- **No clearance test**, like the bootleg: what the swung tail hits, the collision pass charges.

A prototype: every number is a first guess. `tools/probe.mjs` drives every turn off every lane with
the combo, with the tap alone, with the gas pedal simply held and with the brake held, and checks the
kick lands, the tap alone neither slides nor gains speed, a plain Loco corner does not slide, and the swing settles
within a second.

## The pedal slide

The bottom row is two round pedals — an orange gas button 100px across, dead centre on the bottom
edge, and a red brake two thirds its size to its left, the two centres on one line so a thumb slides
straight across. (The ⏸ is up in the top-right corner, on the cash total's row.) Their depth is two
discs: a dark base, and the face drawn smaller and higher on it, so the base shows as a crescent
underneath and reads as the side. A held pedal **sinks** into its own outline: the silhouette and
the hit box stay put while the face drops 5 of the crescent's 12 units into the base, its filter
adds a dark inner shadow from the top edge, and the icon drops with it (the "The press" rules in
`index.html`). Squashing the whole pedal instead would move the cap away from the fuel gauge
hugging it. It sinks for the Space and B keys too, off `boost.state.held` and the brake's `is-on`,
not only under a finger. An empty tank greys the gas out.

**The fuel gauge is an arc over the gas pedal**, where the thumb spending it is. A
tachometer-style band (`#boost-meter` in `index.html`, shaped by `game/fuelarc.js`) runs round the
button, from just under its centre on the left, over the top, to the same height on the right. Fuel
fills from the left end, so holding the gas sweeps the front back from the right, over the crown,
and down to the left. The band is an even 16 units wide, and a thin white glint sits across the
fuel's front whenever there is any. A stroke can't taper, so the track and the fuel are filled
outlines, and `main.js` rewrites the fuel's outline whenever the level moves. The band's inner edge
holds a fixed clearance off the pedal's black outline all the way round, and the width grows
outward; the probe checks the clearance and the matching end heights. The gauge rides in with the
pedals on `pedals-ready`, not with the top HUD, and the boost sparks land on its crown. The trade: a
thumb on the pedal can cover part of the arc, and the last of the tank drains into the lower-left
end, which is the part a thumb coming in from that corner is most likely to be over. History:
[the pedal slide](gameplay-history.md#the-pedal-slide).

The row is **one control surface, not two buttons**. A thumb that goes down on Loco Mode and
slides left onto the brake hands the car over as it crosses, with no lift in between, and sliding
back hands it straight back. On a phone that is the difference between "press the gas, let go, find
the brake, press the brake" — four beats, two of them spent with the taxi doing neither — and one
continuous movement of the thumb that is already down there.

Nothing about the pedals changed to allow it. They already arbitrated (above), so a handover
mid-gesture is the same transition a two-thumbed player was already making; what was missing was a
gesture that could reach both. `holdLocoMode()` and `holdBrake()` now each report whether the pedal
actually went down, and "The pedal slide" in `main.js` is the ~60 lines that drive them off one
pointer.

**Coordinates, not event targets.** A press captures the pointer to the button it started on, so
for the rest of the gesture every move is delivered *there* whatever is under the finger — which is
what makes a hold survive a wandering thumb, and what makes hit-testing the event target useless.
The gesture hit-tests the point against two zones instead. They are measured on the press and
then left alone: both pedals change shape while held (the press), and re-measuring per move would let a pedal's own animation move the boundary under a finger that
never moved. The rectangles are grown into zones first (below).

**The zones are bigger than the buttons.** Each pedal takes a thumb `--pedal-reach` (20px) past
its drawn edge, on the first press (a `::before` on each button in `index.html`) and during the
slide (`game/pedalzones.js`, which reads the same CSS variables). On the two facing sides the reach
stops `--pedal-deadband` (8px) short of meeting in the middle of the 22px gap. Tyler, drifting
one-thumbed (2026-10-08), had the thumb slip on the way back from the brake and the car stop: with
the zones at the buttons' edges, a thumb that came back 5px short of the gas sat in the brake's slop
and the brake stayed down, which a real touch on the built page reproduces. Now it takes the gas.
20px is the most the gas can reach upward without taking taps meant for the rider chips and the
taxi finder, whose bottom edge is `--ctl-h + 20px`.

**Two different thresholds, on purpose.** Claiming a pedal means being *inside* its zone; dropping
one means being `PEDAL_SLOP` (16px) *clear* of it. Coming off the row entirely has to let go, and
equal thresholds would put a boundary under a resting thumb that a pixel of jitter could cross twice
a frame. A fresh press of Loco Mode is not a quiet event: it fires a wheelie, a flame burst, a
launch skid and a haptic tick, and brake, Loco, brake inside 350ms is a U-turn. The deadband between
the two zones is where a still finger sits, keeping whichever pedal it already had. Sliding off the
end of the row is therefore also how you let go of a pedal without lifting.

**One pointer owns the row.** A second thumb landing on the other pedal takes it over, which is the
game's own last-pedal-wins rather than a special case, and the first thumb's eventual lift then has
nothing left to release. An empty tank is the one case where the claim and the press come apart:
the gas pedal is dead under a thumb that has plainly arrived on it, so the claim moves (the brake beside
it lets go) and nothing is pressed or painted.

**The press never follows `:active`.** The browser pins `:active` to the button the pointer went
*down* on and leaves it there however far the finger travels, so a slide would sink the pedal the
thumb has left and leave the brake it is standing on looking up. An `is-held` class carries the
press on whichever pedal is actually down.

**Everything after the press listens on the window.** Capture normally redirects the rest of the
gesture to the button it started on, and a listener there would be enough — but only while the
capture holds. It never takes for a synthesised pointer, and it is dropped outright when the
capturing button leaves the screen, which is exactly what a run ending under the player's thumb
does (`body.game-over #brake`). A `pointerup` on a hidden element is not something to hang a stuck
pedal on. A pause and a `blur` drop the gesture too, for the same reason they drop the keyboard's
holds.

Four checks in `tools/smoke.mjs` drive it with real CDP touches — an untrusted `PointerEvent` has
no pointer for the browser to capture — stepping along the row rather than jumping, so the moves in
between are tested against the pedal they land on.

**On a keyboard, hold B.** One key over from the bar, through the same `holdBrake()` / `releaseBrake()`
the button uses. `keyIsSpokenFor()` — the same guard Space uses, now taking the button it should
exempt as a parameter — keeps a `b` typed into the initials field from driving the car, and the
Home Screen tip and the pause both outrank it exactly as they do the spacebar. `blur` drops the
pedal for the same reason it drops the boost: a keyup that lands on another window never arrives,
and a brake held by a window with no keyboard is a taxi stopped in the road with nothing on screen
saying why. A pause drops it too — the veil swallows the release.

**Skid marks, on all four wheels.** Every other thing that marks the road in this game comes off the
driven wheels: the launch chirp, the rubber through a boosted corner, the overtake's two lane
changes. A car standing on its brakes has locked the front pair as well, and two streaks read as a
car still under power, so the brake stamps front and rear — off the anchors the wheels are actually
built at (`TAXI_FRONT_*` / `TAXI_REAR_*` in `geometry/taxi.js`). Marks are spaced by distance
travelled like every other trail, so the streak thins as the car slows and **stops exactly where the
car stopped**, which is the whole picture the effect is drawing. One pair is stamped on the press
itself, because the 0.42-unit spacing cannot produce anything until the car has moved and the
streak would otherwise start a stamp late. Below `BRAKE_SKID_V` (2.5 u/s) nothing is laid at all —
at a walking pace it would be a stain rather than a skid. Dust comes off the tyres on the same
terms, for the same reason: traction has broken, and a locked wheel throws as much off the road as a
spinning one.

## Pause

`src/game/pause.js`, styled in `index.html` under `#pause` / `#pause-veil`. The ⏸ is a bare glyph
in the top-right corner, on the cash total's row (Tyler's HUD shuffle, 2026-10-05). It arrives with
the rest of the HUD (see [the HUD arrives afterwards](#the-hud-arrives-afterwards)) and it is gone
once the run is over, because a paused ending is not a thing.

**It stops the whole frame, not just the clocks.** `main.js` returns out of `frame()` before any
`update()` while it is set, so the traffic, the signals, the fare deadlines, the sky and the boost
tank are all where the player left them. Compare the two holds that already existed: the tutorial's
`fares.setPaused` and the Home Screen screen's `state.holding` both park the *fare loop* while the
city keeps driving, which is right for something talking over a live game. A pause that did that
would hand back a junction with a car in it that arrived while nobody was looking.

Three details in that early return are load-bearing:

- **The frame is still rendered.** `preserveDrawingBuffer` is off, so a resize or a rotation with
  the veil up repaints the canvas from an empty buffer — the city would blink out and stay out
  until the player resumed. One static render per frame is the cheap way to be right through both.
- **`clock.getDelta()` is still read**, above the return. It measures from its own last call, so
  skipping it would hand the first frame after a resume the whole length of the pause. The 0.05s
  clamp caps that — it is there to survive a stalled tab, not to license stalling on purpose.
- **A held boost is dropped** on the way in. The veil takes the pointer release the gas pedal was waiting
  for, so without it the run would resume into a boost nobody is holding.

**The screen is the title screen's menu**: "Paused" as a small header set like the title's
"‹ Back", then **Resume**, **Settings** and **Quit** as plain white words. Settings is the title
screen's own page (both build it from `game/menupage.js`, and `index.html` shares the styles under
`:is(#title-screen, #pause-veil)`) minus Tutorial tips, which are read once on Play and would change
nothing mid-run. Back or Escape returns to the pause menu; every pause opens on the menu. **Quit**
reloads without the "Play again" skip flag, so it lands on the title screen and the run is
abandoned — no score is recorded.

Only Resume resumes — a stray tap elsewhere on the veil must not drop the player back into
traffic — and it resumes on `pointerdown` rather than `click` — the release then lands on the canvas
with no `click` synthesised after it, since the two ends of the gesture are on different elements,
which is what stops the tap that resumes from also dispatching the taxi at whatever it was over.
Escape and P toggle it from a keyboard.

## The run-end screen

`src/game/runend.js`, styled in `index.html` under `#run-end`. The run ends three ways — a fare's
clock hitting zero (aboard, or the third [strike](difficulty.md#strikes) on the kerb), a collision,
a police bust — and all three land on the same screen: a title, the
reason, the run's two stats (**Cash**, then **Time**), the [high-score table](#high-scores), and **Play again**. The title is
set by the caller, so a timeout reads **Too Slow!**, a collision reads **Wrecked!**, and a police
bust reads **Busted!**.

All three also **hold the screen back for a beat** while the camera pulls into whatever ended the run
— the wreck, the cruiser, or the corner a fare's clock ran out on. See
[the closing shot](rendering.md#the-closing-shot) for the framing and the three sets of numbers; the
one thing that belongs here is that a timeout's shot is of the **drop-off the taxi never reached**,
which is the only place in the game where the answer to "what went wrong" is somewhere other than
where the taxi is standing.

It is a **full-screen blackout**, not a modal over the city: a blurred card's edges would be the
loudest thing on the screen. Blacking the whole viewport out puts the run's numbers on nothing at
all, which is what makes them the ending rather than an overlay on one.

There are two rows, **Cash** then **Time**. Each rider's clock is budgeted off the work the fare
takes ([difficulty.md](difficulty.md)), so how many fares a run carried and how far up the ramp it
got both mostly restate how long it lasted, and near-synonyms would bury Cash, the one number the
table ranks by. Cash comes first for that reason. History:
[the run-end screen](gameplay-history.md#the-run-end-screen).

The stats are **one row each, label and value side by side**, and both are set in the *same* size,
weight and colour. A small grey caption over a big yellow number made the label read as chrome and
the number as the content, when the pairing is the content; matched type makes each row one phrase
— "Cash  $412" — and the rows read as a list being counted out, which is what the stagger is
doing.

It reads as a **ledger**: label pinned to the left edge, value to the right, on a `1fr auto` grid
so the label column takes the slack and the values stay flush right however long the names get.
Both edges are then straight lines down the block, which is what lets rows of identically
styled text read as separate stats — centring each row on its own left the list ragged.
`.stat` is `display: contents` so its label and value become grid items of the row above; the
wrapper only exists for the reveal to animate a stat as a unit. Each entrance is anchored to the
edge its text is aligned to (`transform-origin: left`/`right`), so the label's oversized first
frame and the value's landing bump both grow *inward* rather than out past the container.

**The content container is capped at a phone's content width** — 358px, a 390px screen less its
16px gutters — so the desktop layout *is* the mobile layout. Pushing label and value to opposite
edges of a 1280px screen would strand each number three feet from its own name; at phone width the
gap is a gutter rather than a void. On a phone the rows run right out to the screen edges, which is
the layout the cap is borrowing. The title and reason are the one exception — see below — and are
free to run past this box on a wide enough title, still centred on the same axis.

**The title is the headline; the reason is a caption under it, not a second headline.** The title's
clamp was raised so "Wrecked!" reads as the loudest thing on the card, and the reason sits at a
noticeably smaller size beneath it. `matchReasonWidth` in `runend.js` caps the reason's width at the
title's own rendered width — measured, not assumed, since "Busted!" and "Three riders gave up on
you." are nowhere near the same length — and CSS `text-wrap: balance` picks the break point
inside that cap, so a two-line reason comes out as two even lines rather than a long first line and
a short orphan word on the second.

Type and rhythm scale with the viewport, off whichever axis is tighter: height for the list as a
whole (a landscape phone runs it past the fold) and width for the rows (`nowrap` would rather push a
long row off a 320px screen than wrap it). If it still
doesn't fit, the overlay scrolls — centred by `margin: auto` on the content rather than
`justify-content`, which clips its own overflow at the top, where the title is.

**Nothing appears at once.** The card is revealed as a sequence, because the version before this
one wrote a single line of `innerHTML` and the whole screen arrived in one frame — which reads as
the game stopping rather than as a scoreboard. The order is title → reason → each stat in turn →
the initials prompt, if the run placed → the table → **Play again**, and each stat's label **scales
down** into place as it fades up before its number rolls from zero. A number that rolls gets read; a
number that is printed gets skipped past on the way to the button. The button is last on purpose,
appearing only once the table has landed, so the player isn't invited to leave mid-tally.

**The stats, the prompt and the table are one slot taking turns**, not a list that grows. `#run-end
.run-end-body` holds whichever screen is current and cross-fades to the next. Stacking them was the
first shape and it does not fit: a title, a reason, the stat rows, a prompt and five table rows is
well past what a landscape phone shows at once, and this card's whole layout exists to keep **Play
again** above the fold. Swapping also makes each beat a screen of its own, which is the point of the
sequence — read your run, sign it, see where it placed. The slot is pinned to a `min-height` taken
from the stats' own rendered height, because a card centred by `margin: auto` re-centres on every
height change, and without the floor the title hopped up and down between beats.

**The stats are counted out one row at a time**, not staggered. A row's label arrives, its number
rolls, the number lands and pops, and only after a held beat does the next label appear. An earlier
pass overlapped the rows on a 165ms stride, and with several of them counting simultaneously the
block read as one animation with numbers moving inside it — you watched the screen rather than any
single figure. `STAT_STRIDE` is now *derived*: `ROW_MS + ROW_GAP`, where `ROW_MS` is a row's own beat
(`COUNT_LEAD + COUNT_MS + LAND_MS`). "Finished before the next one starts" is therefore a property
of the constants rather than something to keep re-checking by eye.

The whole cadence is ~3.5s and lives in the timeline constants at the top of the module rather
than in CSS keyframe delays, so it can be re-paced from one place and so the sequence works for
however many stats it is handed. Playing the rows in turn roughly doubled the wait, so **a tap
anywhere skips the beat that is running** — finishing its animations and landing its numbers — and
the retry pill is `disabled` (and so `pointer-events: none`) until then, which both keeps an
invisible button from reloading the run mid-tally and lets a tap aimed at it fall through to the
skip.

**The review waits for a tap.** Once the stats have landed, the card holds on them with a quiet,
breathing "Tap to continue" laid over the Play again pill's (still empty) slot, and only a tap moves
on to the prompt or the table, so a run summary is not something you can miss by glancing away. A
tap *during* the count still lands the numbers, but on
the review rather than past it, and the tap that leaves is only armed `HOLD_MS` after the last
number lands — the thumb still on the glass when the taxi wrecked is the likeliest tap of all, and
it should not carry through to the table. With no table to show (no scores) there is no extra
wait: the next thing is the Play again pill, which waits for a tap of its own. Under reduced motion
the screens stack, so the review is never off screen and nothing waits.

**The skip is per-beat, not a jump to the end**, and the initials prompt is why. Every other beat
but the review is on a timer; the prompt is waiting on the *player*, so nothing skips it and no timer
runs past it.
That is why the handler is a single mutable `skip` that each beat installs on its way in and the
prompt leaves null, rather than one listener that finishes every animation on the screen. The first
shape landed the whole timeline at once, which blew straight through the field and threw away the
name being typed into it.

The counters are anchored to their **first animation frame**, not to `performance.now()` at build
time. A WAAPI animation starts on the frame after `animate()`, and the game-over frame is exactly
where the page hitches — on a stalled boot the numbers ran ~500ms ahead of their own labels, which
for a list played one row at a time meant a row counting before it had appeared.

The overlay sits at **`z-index: 30`**, above the tweak toggle and the rider chips' row (20). Without
one the blackout painted *under* them and a waiting-rider chip stayed lit in the corner of the
game-over screen — and a chip still on top also swallows the tap that skips.

Under `prefers-reduced-motion` the card prints its final values with no entrance and no roll — the
sequence is the entire module, so there is nothing else to keep. **The screens stack there instead
of swapping.** The whole sequence resolves in one frame under reduced motion, so a swap replaced the
stats with the prompt before the stats had been on screen for a single frame, and a player who
opted out of animation never saw their own run summary. Reduced motion means no movement, not less
content: everything is simply present at once and the card scrolls if it has to. The prompt still
gives way to the table, since a filled-in form sitting above the table it produced is clutter rather
than content. A high score still has to be signed — the animation is what was opted out of, not the
chance to put a name on the run.

| Stat | Source | Notes |
|---|---|---|
| Cash | `fares.state.money` | |
| Time | `fares.state.elapsed` | seconds, shown as `m:ss` + trailing `s` (e.g. `1:03s`) |

## High scores

`src/game/highscores.js`, shown on [the run-end screen](#the-run-end-screen). Five runs, on this
device and nowhere else: no server, no account, no sync. `localStorage` is the whole backend, which
makes the failure modes the interesting part of the module rather than the ranking.

> **Trap.** The table is *titled* **Leaderboard** on screen, but it is **not** `leaderboard.js` and
> nothing in the DOM is called `.leaderboard` — the classes are all `.score-*`. "Leaderboard" is the
> IAB's name for a 728×90 ad unit and filter lists carry generic rules against it, the same trap
> that keeps `beacon.js` and `#banner` out of this codebase. What those rules match is URLs, ids and
> class names, not text content, so the visible word is safe and the filename is not. A blocked
> module takes the whole graph down with `ERR_BLOCKED_BY_CLIENT` and nothing in the console says why.

**One score, and for now it is the cash.** `scoreOf(entry)` in `highscores.js` is the only thing the
order is computed from — a function rather than a field read inline, because the point of naming it
is that the table ranks by a *score*. If that becomes a formula over fares, time and cash later,
that one line is what changes, and every run already stored keeps its place in the new order.
`fares` and `seconds` are still recorded on every entry for exactly that reason, even though nothing
reads them today.

**No tie-breaks.** An earlier pass broke ties on fares and then on the shorter run, and it went with
the fares column: a table that ranks by one number and then silently reorders equal numbers by a
quantity it does not show is a table the player cannot check. Two runs on $40 sit in the order they
were played — ties go to the incumbent, since the comparator returns 0 and `sort` is stable, which
is the convention every arcade table has used since arcade tables existed.

**A row is rank, name and score, and nothing else.** A fares column sat between the name and the
cash and came out with the tie-breaks: a second figure beside the score invited the player to work
out how the two combined into the order in front of them, and they don't combine. The row now shows
exactly what it is sorted by. The heading and the rank column are left-aligned, against the same
edge the list's own columns start on; centred, the heading floated free of the block it labels.

**Five rows, not ten.** The card is capped at 358px and its own layout is already fighting to keep
**Play again** above the fold on a landscape phone; ten rows loses that fight. Five is also about as
far back as anyone cares on a table only they will ever see.

### Not every run counts

A pinned difficulty, a pinned car count, a fare clock dragged around in the ⚙️ panel, or shot mode —
each of them changes what a dollar is worth, and a table with a tuning session sitting at the top of
it is worth nothing to the player who earned row two honestly. `isRankedRun()` in `main.js` reads
all four. An unranked run still gets its stats counted out; it just isn't recorded, and the screen
goes straight from the tally to **Play again** rather than showing a table this run could never have
joined.

The difficulty check is `difficulty.getPinned()` rather than `getDifficultyPin()` from `util/shot.js`.
The URL flag is only one of the two ways the curve gets pinned, and the ⚙️ slider — the one anybody
actually reaches for — calls `pinDifficulty` directly without touching the URL. Reading the live
state catches both.

### Signing a run

**Any run that makes the top five is asked for three initials**, not only a new number one. A board
where one row is named and four are `AAA` reads as broken, and a run that climbs from fifth to
second deserves a name as much as one that takes the top.

- **One `<input maxlength="3">`, not three fields.** One focus target, and backspace, arrows and the
  mobile keyboard all behave without a line of code. The arcade look comes from three spans painted
  from the value on every keystroke — letter-spacing a single field into three slots depends on the
  glyph advance of a font this game does not control (`ui-rounded` is SF Pro Rounded on iOS and
  something else everywhere it is developed; see the fit-to-width saga in `homescreen.js`), so the
  underscores drift out from under the letters on any face but the one it was eyeballed against.
- **`text-transform: uppercase` is not what makes the name uppercase.** That only changes what is
  painted; the value would still save as typed. `normaliseName` on every `input` event is — it
  uppercases, drops anything outside `A–Z0–9`, and caps at three. It runs on the way *out* of
  storage too, so a hand-edited `localStorage` can't put an eleven-character name through the row
  layout.
- **The last initials are remembered** under `simtaxi.initials` and pre-filled, so a repeat player
  confirms rather than retypes. The caret goes to the end of a pre-filled name rather than selecting
  it, so the first keystroke of someone changing their initials doesn't wipe all three.
- **The score is written before the prompt, not after it.** The player is being asked to type on a
  screen they can close at any moment, and a table that only saves once the prompt is answered loses
  the run of anyone who shuts the tab on it. Naming is an edit to a saved score, not a condition of
  saving one.
- iOS only opens the software keyboard inside a user gesture, so `focus()` is best-effort there. The
  transparent input is stretched over all three cells, which makes a tap anywhere on them a tap on
  the field — and **OK** is the way out for anyone who would rather not type at all.

**The keyboard is clamped against, not scrolled around.** iOS does not resize the *layout* viewport
when the software keyboard opens — it slides a shorter *visual* viewport up over an unchanged one —
so `#run-end`'s `position: fixed; inset: 0` still measures the whole screen and `margin: auto`
centres the card on a point behind the keys. The first fix was `scrollIntoView({ block: 'center' })`
on the cells and it could not work: the centre of that scroll container *is* the covered half, so
the field landed under the keyboard however the scroll went. `followKeyboard` in `runend.js` reads
`visualViewport` for as long as the field has focus and sets `--kb-top` / `--kb-height` on the
overlay, and `#run-end.is-keyboard` clamps `top`/`height` to them — the card then re-centres in the
band that is actually visible, with no change to how it is laid out. Measured on a fake viewport at
390×844 with a 336px keyboard: the initials sat at y 508, exactly on the keyboard's top edge, and
**OK** at 572, entirely behind it; clamped they sit at 340 and 404, with the "New high score!" line
still on screen.

- **The clamp is conditional.** Android *does* resize the layout viewport, so there the two agree
  and the clamp stays off — applying it anyway would subtract the keyboard's height twice.
  `KEYBOARD_MIN` (80px) is the gap that counts as a keyboard rather than a URL bar collapsing.
- **The scroll still runs**, as `block: 'nearest'` on the prompt rather than `center` on the cells:
  on a short viewport the card can outgrow even the visible band, and `nearest` pins the top of the
  prompt instead of pushing "New high score!" off the top of it.
- **The release is called on commit, not just on `blur`.** Removing a focused element does not
  reliably fire `blur`, and the board arriving inside a card still clamped to half the screen is a
  worse bug than the one being fixed.
- The blackout is the clamped element, so it stops painting where the clamp ends — a spread
  `box-shadow` in the same colour carries the black past it, because iOS sends the first `resize`
  while the keys are still sliding up and the strip underneath would otherwise flash the live city.

### A dead store is an empty table

`localStorage` is not a property you can rely on. Safari's private mode throws `SecurityError` on a
*write* while reporting a perfectly good object, blocked third-party storage throws on the property
access itself, and a full quota throws on `setItem`. Every call in the module is guarded and every
path degrades to "no table", because a game that dies on the game-over screen because a score could
not be saved is a far worse bug than one that quietly keeps no scores. A store that refuses the
write still gets a board for that one screen: the run happened and the rank was earned, it just
won't be there next time.

The store is **injectable**, which is what lets `tools/scores.mjs` drive the whole thing in node
against a fake — including the throwing cases and a corrupt payload, which is the half of the module
a browser on the machine this is developed on would never reach. The real `localStorage` round trip
is covered once, in `tools/smoke.mjs`, by writing a score and reloading the page.

The key is versioned (`simtaxi.scores.v1`) so a future shape change reads as "no scores yet" rather
than as a crash. **Clearing lives in the ⚙️ panel**, not on the run-end card: it is the only
destructive control in the game, and putting it next to a big yellow **Play again** is a misclick
that cannot be undone.

`shift` is stored on each entry and not shown. It is the one fact that tells two otherwise-similar
runs apart, and the row is too narrow to carry it — four columns is already what fits at the top of
the font-size clamp — so it is kept only so a future row can show it without orphaning every
existing score.
