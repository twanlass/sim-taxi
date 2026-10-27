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

The game runs in a phone docked on the left of its slide, live on its main menu with the city going
about its business, beside the title. Tapping the phone (or Enter) brings it to the middle of the
window at full height, and the city carries on past its bezel to the edges of the window, dimmed; the game is then the
player's, with focus and input. Esc docks it again. The game only runs while its slide is up.

## How it reaches the game

**The game runs in a same-origin iframe.** `src/main.js` boots the game on import and
`createLayout()` installs its road network as *the* city, so the game cannot be a component of
another page. Same-origin means the talk can still reach in: `window.__taxi.presenter.hold(on)`,
the hook the game carries for the talk, freezes the world the way the pause does, with nothing
drawn over it, and the talk holds it whenever the demo's slide is not the one showing.

**The phone is always the size it is when it's played.** The iframe is the phone's screen at full
window height, portrait, so the game lays out exactly as it does on an iPhone: menu, HUD, pedals.
On the slide it is shrunk into its slot with a CSS transform (`--dock`), and going live eases the
transform away, so the canvas never resizes. A resize mid-animation would empty the drawing buffer
and re-frame the camera on every step.

The first version kept the iframe the size of the window and clipped it down to the phone, frozen,
then opened the clip out to the whole window; the game laid out for a landscape window, and the
phone disappeared on the way.

**The city round the live phone is a second copy of the game.** It loads on the same pinned `?seed=`,
fills the window under a dark wash, is held still with nothing but its canvas showing, and has its
camera set from the phone's every frame: the same position and world units per pixel, its frustum
grown out from the phone's screen to the window's edges, so the streets line up across the bezel.
Only the traffic differs, frozen out there. It loads with the slide and is blanked when the slide
goes, so it isn't drawing a window's worth of city through the rest of the talk. (A blurred copy of
the phone's own screen stretched out round it, like a video's ambient mode, came first and was
disorienting; plain grey after that read as no city at all.)

## Presenting from a pinned build

`main` deploys on every merge, so the talk at the live URL is whatever merged last. For the day
itself, build a tagged commit and serve it locally (`npm run build && npm run preview`, then
`/talk/`): nothing that merges afterwards can change it, and it does not need the venue's network.
