# The talk

**`/talk/` — a presentation about the game, built out of the game.** It is a web page made to be
screen-shared: slides in HTML and CSS that can turn into the live game and back. Nothing in the game
links to it, it has `robots: noindex`, and `tools/ios-sync.mjs` leaves it out of the iOS app.

```bash
npm run dev            # then open http://localhost:5173/talk/
```

| File | What it is |
|---|---|
| `talk/index.html` | the page: the slide's layout and the reveal's CSS |
| `src/talk/talk.js` | the deck: slides, keys, and the live-demo phone |
| `src/talk/*.js` | one module per slide that does something (the cans, the character select, the snake and its creatures, the then-and-now flattening, the title painted into the game) |

## The live demo

The game runs in a phone docked on the right of its slide, live on its main menu with the city going
about its business, beside the title. Tapping the phone (or Enter) brings it to the middle of the
window at full height, and the city carries on past its bezel to the edges of the window, dimmed; the game is then the
player's, with focus and input. Esc docks it again. The game only runs while its slide is up.

## Across the slides

**The event and the handle are on every slide.** The title paints its own pair into its game, so
the lens rain bends them. Every other slide shows `#chrome`, a fixed copy with the same rules
(`p.kicker`, `p.handle`) at the same place, hidden on the title (`body.on-title`), while the phone
is live, and on a slide marked `data-chrome="off"` (the workshop, whose panels sit up there).

**The title's words sit centred down the slide, over the city's edge**, inked by what is behind them
(`--blend: contrast` in `scenetext.js`): their own colour over the sky, and plain white over anything
on the island — a switch rather than a fade, since a fade left the words over the park and the wet
roads a mottled grey. (For a while they sat at the top in plain ink, clear of the city.)

**Slide 3** is the family in the sketchbook creatures' style, drawn with the same kit
(`src/talk/pixels.js`, shared with `escape.js`): shaded shapes on a grid, a navy outline, and eyes
that follow the cursor and blink. Each holds what they're best at (a game controller, a cupcake, a ball of
yarn, a pencil), with their age under their name. Tyler is up when the slide comes up; → brings
Heather in, → greys her and drops her out (she didn't want to make games), → brings Isla and then
Nia with START, and → moves on.

**After slide 10, → goes back to the workshop** to check in on what was set going there during the
demo, and → from there goes on to the thanks (← from the check-in goes back to slide 10). The
workshop's frame is `data-keep`, so it stays loaded once it has been up and the check-in finds the
same session.

**Slide 5** opens on "Let’s build snake?". The first click drops a clip (`talk/media/cursor-snake.mp4`)
over it, tilted, with a play button that plays it; the next fades it and lets the snake loose as the
question shrinks away. After the apples come the dragon fruit, the pineapple in the cowboy hat and
the bombs. Each arrival freezes the snake for a pop quiz while everything on the board bobs, and the
next press (or ↑/↓) lets it go. The bombs fill the whole board in a wave, all but a one-cell corridor
from the snake's head, dashed ahead of it, to a dead end; let go, it runs the corridor into a bomb,
fades out under GAME OVER, and the press after that moves on (a press mid-run waits for the bang). **Slide 7's wipe** holds on the first commit until the next click (or →),
then sweeps once today's game is drawing.

## How it reaches the game

**The game runs in a same-origin iframe.** `src/main.js` boots the game on import and
`createLayout()` installs its road network as *the* city, so the game cannot be a component of
another page. Same-origin means the talk can still reach in: `window.__taxi.presenter.hold(on)`,
the hook the game carries for the talk, freezes the world the way the pause does, with nothing
drawn over it, and the talk holds it whenever the demo's slide is not the one showing.

**The title's rain on its heading falls only while the squall is over it.** `src/talk/splash.js`
asks how wet the heading is at sixteen columns along it: each is cast down the backdrop game's
camera onto the ground and the squall asked there (`squallOver` in `talk.js`, `rainNear` with 6
units of reach). The heading hangs over open sky left of the city, so it gets wet as a front
crosses that edge of the map, and stays dry while the rain is elsewhere.

**The phone is always the size it is when it's played.** The iframe is the phone's screen at full
window height, portrait, so the game lays out exactly as it does on an iPhone: menu, HUD, pedals.
On the slide it is shrunk into its slot with a CSS transform (`--dock`), and going live eases the
transform away, so the canvas never resizes. A resize mid-animation would empty the drawing buffer
and re-frame the camera on every step.

The first version kept the iframe the size of the window and clipped it down to the phone, frozen,
then opened the clip out to the whole window; the game laid out for a landscape window, and the
phone disappeared on the way.

**The city round the live phone is a second copy of the game.** It loads on the same pinned `?seed=`,
fills the window, blurred, under a dark wash (`--surround-blur` and `--surround-dim` in
`talk/index.html`), and has its camera set from the phone's every frame: the same position and
world units per pixel, its frustum grown out from the phone's screen to the window's edges, so the
streets line up across the bezel. It is `?backdrop`, so it runs — its own traffic, its own weather —
with no sound, no input and nothing but its canvas, and the talk turns every method its camera
controller would move the camera with into a no-op, so the follow is the only thing pointing it.
Only the traffic differs from the phone's, so a car crossing the bezel is a different car on each
side; it was first held still with the presenter's hold, which read as a frozen city round a live
one. It loads with the slide and is blanked when the slide
goes, so it isn't drawing a window's worth of city through the rest of the talk. (A blurred copy of
the phone's own screen stretched out round it, like a video's ambient mode, came first and was
disorienting; plain grey after that read as no city at all.)

## Presenting from a pinned build

`main` deploys on every merge, so the talk at the live URL is whatever merged last. For the day
itself, build a tagged commit and serve it locally (`npm run build && npm run preview`, then
`/talk/`): nothing that merges afterwards can change it, and it does not need the venue's network.
