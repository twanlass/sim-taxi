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
| `src/talk/talk.js` | loads the game, freezes it into the phone, runs the reveal |

## The opening slide

The game sits paused inside a phone outline on the left, with the title on the right. Tapping the
phone (or Enter, Space, →) opens it out: the outline scales up and fades, the clip around the game
opens to the whole window, the camera pulls back from a phone's close-up to the game's own framing,
and the world starts moving on the first frame of all that. The HUD fades in once the reveal lands.
Esc, or the button at the top, freezes the game where it stands and closes the phone back over it.

## How it reaches the game

**The game runs in a same-origin iframe.** `src/main.js` boots the game on import and
`createLayout()` installs its road network as *the* city, so the game cannot be a component of
another page. Same-origin means the talk can still reach straight in:

- `window.__taxi.presenter` — the only hook the game carries for the talk. `hold(on)` freezes the
  world the way the pause does, with nothing drawn over it; `settle()` finishes the city's entrance
  so the still is a whole city; `held()` reports the hold.
- `window.__taxi.camera.camera` — the talk pushes the projection in with `camera.zoom` and moves the
  taxi under the phone with `setViewOffset`, then eases both back. The game's own camera keeps
  running underneath and honours both.
- the iframe's `<body>` — the talk injects one stylesheet that hides the HUD while the game is a
  still.

**The iframe is always the size of the window.** The phone is a `clip-path` over it, so the reveal
is the clip opening rather than the canvas growing. Resizing the iframe instead would resize the
game's canvas on every step of the animation, which empties the drawing buffer and re-frames the
camera each time.

## Presenting from a pinned build

`main` deploys on every merge, so the talk at the live URL is whatever merged last. For the day
itself, build a tagged commit and serve it locally (`npm run build && npm run preview`, then
`/talk/`): nothing that merges afterwards can change it, and it does not need the venue's network.
