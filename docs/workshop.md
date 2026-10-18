# The model workshop

**`/workshop/` — a workbench, not part of the game.** One vehicle or landmark on a round pad of road (three times its footprint across, fading into the sky),
under the game's own sky, sun and daylight, with a chat panel down the right that has Claude Code
edit the model's source while you watch.

```
npm run dev            # then open http://localhost:5173/workshop/
```

It runs under the dev server only. It is not a build input, so `npm run build` leaves it out of
`dist/` (and so out of Netlify and the iOS app) without anything having to exclude it.

| File | What it owns |
|---|---|
| `workshop/index.html` | the page: the bench's knobs, the chat panel, the layout |
| `src/workshop/catalog.js` | what can go on the bench, and which file builds each one |
| `src/workshop/viewer.js` | the bench: renderer, cameras, the hot reload |
| `src/workshop/chat.js` | the chat panel (browser side) |
| `tools/workshop-agent.mjs` | the chat's dev-server endpoint, which runs `claude -p` in the repo |
| `tools/workshop.mjs` | the headless checks, in `npm run check` |

## The loop

Pick a model, say what to change. The message goes to Claude Code with the model's name, the file
and function that build it, which view you are in, and a screenshot of exactly what is on screen
(written to `.workshop/view.png`, gitignored). Claude edits that source file; Vite sees the save and
the bench rebuilds the model in place, camera where you left it.

**There is no "roll the values back into the game" step.** Every catalog entry calls the builder
the game calls (`createTaxiMesh`, `createGarage`, `carGeometry`...), so an edit made here *is* the
game's code. Open the game in another tab and it is already there. That is also the catch: a change
to a shared builder changes everything that uses it. Doubling the taxi's roof sign also grows the
one on the depot's roof, because `roofSignGeometry` draws both. The agent usually says so.

**Undo** sits under every reply that edited files, and puts those files back the way they were
before that turn. Only the latest turn's undo is live: an older turn's snapshot predates every turn
after it, so restoring it would quietly undo those too. The snapshot is `git stash create`, which
records the whole working tree without touching it. A file the turn created is deleted, and an
untracked file that already existed is left alone because git has no copy of it. Anything you edit
by hand in the same file during a turn goes with the undo.

**Nothing is committed.** The edits sit in your working tree like any other change, for a PR in
the usual way.

## The chat: Claude Code, headless

The panel needs no API key and no server of its own. `tools/workshop-agent.mjs` is a Vite plugin
(`apply: 'serve'`) that spawns the Claude Code CLI for each message:

```
claude -p <message> --output-format stream-json --include-partial-messages
       --permission-mode acceptEdits --allowedTools <list> --append-system-prompt <bench context>
       [--resume <session>]
```

so it runs on the login of whoever ran `npm run dev`, in the repo, reading `CLAUDE.md` like any
session. `--resume` carries the conversation from one message to the next, and **New chat** drops
it. Set `CLAUDE_BIN` if `claude` is not on the dev server's `PATH`.

**What it may do.** Headless, there is nobody to answer a permission prompt, so anything not on the
list is refused outright: edits (via `acceptEdits`), Read, Glob, Grep, `npm run check`,
`node tools/*`, `git diff` and `git status`. No commits, pushes, installs or servers. The endpoint
also answers loopback only, since `vite --host` would otherwise hand a file-editing agent to the
whole Wi-Fi.

**A reply survives the page reloading under it.** Most edits hot-swap the bench, but an edit to the
page itself (or to anything Vite cannot swap) reloads the tab, and the tab is where the reply was
being read. So the run lives on the server and buffers its events, the conversation lives in
`sessionStorage`, and a reloaded page reattaches with `?from=` and replays what it missed. Killing
the CLI when the tab dropped its stream would have let the agent's own edit kill the agent.

The reload is often not the workshop's own. Vite broadcasts a full reload to **every** connected
tab, so with the game open alongside, an edit to `taxi.js` (which the bench hot-swaps fine) reloads
the workshop too, because the game's tab has no HMR boundary. The first version's stream reader
treated the stream aborting on unload as the server being unreachable, and saved that: the
reloaded page showed "Couldn't reach the agent", never reattached, and the next message got
"Still working on the last message" from the run it had dropped. So the chat ignores errors while
the page is unloading, and if it still loses a run it started, it picks that run back up (from
`/status` on load, or from the 409) rather than reporting an error.

## Editing the workshop from its own chat

The chat can change the workshop as well as the model: ask for a new control, a different layout,
a change to the chat itself. The agent is told where each piece lives (the table at the top of this
doc). What happens next depends on the file it saves:

| Edit to | What happens |
|---|---|
| `src/workshop/viewer.js`, `catalog.js` | hot-swaps, like a model edit |
| `workshop/index.html`, `src/workshop/chat.js` | the page reloads; the chat reattaches (above). For the HTML that takes the plugin's `hotUpdate`: the page's inline `<style>` is a module of its own to Vite, so without it the save hot-updates that and never reloads |
| `tools/workshop-agent.mjs`, `vite.config.js` | **the dev server restarts**; the turn keeps running and the page reconnects |

The last row is the one that needed work. `vite.config.js` imports the agent endpoint, so saving
it makes Vite restart the server and build a new plugin, while the old CLI child, in the same Node
process, carries on. The run table therefore lives on `globalThis` rather than in the plugin's
closure, so the new plugin can find the run. The chat retries a dropped stream for about 15 seconds
before calling the run lost. The agent's change to the endpoint itself applies from the next
message. A syntax error in that file takes the dev server down entirely, which the chat cannot fix
from inside. That is why the agent is told to make that edit last and `node --check` it, and why
the fix is to undo by hand with `git checkout tools/workshop-agent.mjs` and restart `npm run dev`.

## The hot reload

`viewer.js` is a self-accepting module, so an edit to *anything* in its import graph (a builder,
`palette.js`, `scene.js`) re-runs the whole bench against the new code instead of reloading the
page. `dispose` hands the camera to the next run through `import.meta.hot.data`, and the old canvas
stays up until the new one has drawn, so an edit doesn't flash.

Two things about this are not obvious:

- **It has to be spelled `import.meta.hot.accept()`.** Vite finds self-accepting modules by
  scanning source text for that expression. The first version aliased `import.meta.hot` to a
  `const` and called `hot.accept()`, Vite never saw it, and every edit dead-ended at the viewer and
  reloaded the page.
- **The chat is a separate module that imports nothing from the game**, so it is never in the graph
  an edit invalidates. Were it inside the viewer, every edit would reset the conversation.

## The bench

**Orbit** is a perspective camera on `OrbitControls`, starting from the game camera's side of the
model so the first thing you see is the face the player sees. **Game view** is the game's own
`createCityCamera`: the fixed orthographic 3/4 view, wheel to zoom. Check anything small there,
because at play zoom a world unit is about 7.7 px. The hour slider drives `game/daylight.js`, and
the turntable spins the orbit. **Wireframe** draws the model's own materials as wires (the bench
floor stays solid), for counting triangles and finding a stray face.

**The game-zoom inset**, top right, is always on unless you minimize it with the – in its corner (the + on the tab it leaves brings it back): the game camera again, at
the density the game plays at (7.7 px a unit, which is `PLAY_ZOOM` in an ~800 px-tall window), so
you can tweak in close-up and see at the same time whether it reads at play size. It is a
scissored second pass through the same renderer, not a second canvas, so it costs nothing to
hot-reload. The screenshot sent to the agent includes it.

The sun's shadow camera is pulled in to ±24 units. The scene's own covers the whole city, which is
0.12 units a texel, about thirty texels across a car. The bench is never bigger than a block.

Landmarks are built on block (2, 2) the way `createLayout` would hand them one, on a kerb-height
plinth so they stand at their city height, then recentred. The ambient fleet's vehicles are
assembled from the same geometries `createTraffic` instances (body, front wheels, cargo box), on
one material per paint, the way `wreckShell` copies a car out of the fleet.

URL: `?model=<id>&view=game&hour=<0-24>&spin=1&wire=1&inset=0&paint=<look>`. The page keeps it current, so a reload or a shared
link comes back to the same bench.

**Paint** picks one of the game's `?paint=` looks. The look is compiled into the shader, so picking
one rebuilds the model. **Play** opens the real game in a frame over the bench, carrying the paint
look across, and tears it down again on the way back. **`.`** hides every panel and leaves just the
viewport.

## Pasted images

Images pasted or dropped onto the compose box (up to six) show as thumbnails above it and go with
the next message. Each is re-encoded to PNG through a canvas, capped at 1600 px on the long side,
and the endpoint writes them to `.workshop/attachment-<n>.png` (clearing the last turn's first) and
tells the agent to read them. Queued, they wait in IndexedDB beside the screenshot.

## Pins and the queue

A click on the model (a press that doesn't travel, so the orbit keeps its drags) drops a pin and
opens a note beside it. The note goes to the chat with the spot described in the builder's own
coordinates (the hit point taken back through the model's transform, recentring and `TAXI_SCALE`
included), the facing of the surface, the palette name of its vertex colour, and a screenshot with
a ring drawn at the spot. The agent edits source, so those are the numbers it can find there.

Messages sent while a reply is still going wait in a queue under it and go one at a time as each
reply finishes; the server only ever runs one. A queued message goes with the bench as it was when
it was **queued**: its model and view ride in the queue, and its screenshot is kept in IndexedDB (a
megabyte of base64 apiece would fill `sessionStorage`), so it survives the page reloading while it
waits. The first version read all three at send time, and a note about the helicopter went out
naming the L train, with a picture of it. A sent pin stays on the bench, dimmed, until the
reply to its own message is done, or until its queued message is removed with its ×.

## Adding a model

Add an entry to `CATALOG` in `src/workshop/catalog.js`: `id`, `label`, `kind` (the picker's group),
`source` (`src/<file>.js · <function>`, which is what the agent is told to edit), and
`build(rng)` returning `{ object, update? }`. `tools/workshop.mjs` builds every entry, so a broken
one fails `npm run check`. You can also ask for one in the chat.
