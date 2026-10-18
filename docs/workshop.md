# The model workshop

**`/workshop/` — a workbench, not part of the game.** One vehicle or landmark on a round pad of road (three times its footprint across, fading into the sky),
under the game's own sky, sun and daylight, with a chat panel down the right (titled "Dispatch") that has Claude Code
edit the model's source while you watch.

```
npm run dev            # then open http://localhost:5173/workshop/
```

It runs under the dev server only. It is not a build input, so `npm run build` leaves it out of
`dist/` (and so out of Netlify and the iOS app) without anything having to exclude it.

| File | What it owns |
|---|---|
| `workshop/index.html` | the page: the bench's knobs, the chat panel, the layout. Every floating panel (bench, chat, pin note, any new one) takes `background: var(--panel)` (`rgb(22 30 38 / 67%)`) with a `backdrop-filter` blur and `--radius`; don't give a panel a colour of its own |
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

**Undo** sits under every reply that edited files, below the "Running tests" / docs status so it is
the last thing on the reply, with the files listed under **Changes** beside it, and puts those files back the way they were before that turn. Only the latest turn's undo is live: an older turn's snapshot predates every turn
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
claude -p --output-format stream-json --include-partial-messages
       --permission-mode acceptEdits --allowedTools <list> --append-system-prompt <bench context>
       [--resume <session>] [--model <fast model>]          (the message on stdin)
```

so it runs on the login of whoever ran `npm run dev`, in the repo, reading `CLAUDE.md` like any
session. `--resume` carries the conversation from one message to the next, and **New chat** drops
it. Set `CLAUDE_BIN` if `claude` is not on the dev server's `PATH`. The message goes in on stdin
because, passed as an argument, one that opened with a bulleted list ("- make this smaller") was
parsed as an unknown option.

**What it may do.** Headless, there is nobody to answer a permission prompt, so anything not on the
list is refused outright: edits (via `acceptEdits`), Read, Glob, Grep, `node --check`, `git diff`
and `git status`. No commits, pushes, installs or servers, and no test suite (below). The endpoint
also answers loopback only, since `vite --host` would otherwise hand a file-editing agent to the
whole Wi-Fi.

**The wait before the first tool call is mostly the CLI starting, and the log is never empty during it.**
Between Send and the first tool call or word of the reply there is real work: the undo snapshot
(three git calls), `claude -p` starting up, and the model's first token. The page cannot remove it,
so it shows it: while a run is in flight and the last message is the user's, the log ends in a
"Thinking" row (`.thinking`, a pulsing dot) that goes the moment anything streams back. On the server
`snapshot` is asynchronous and the CLI is spawned first; the message is written to its stdin only
once the snapshot resolves. `claude -p` does nothing until it has its prompt, so that keeps the agent
off the files until the tree is recorded while the startup runs alongside the git calls. (It used
to be `execFileSync` at the top of `start`, which held the dev server on all three before it
answered.)

**The checks and the docs run after the reply, not in it.** Each used to be part of the turn, and
between them they were most of the wait: `npm run check` is 45 s on a quiet machine and has taken
nine minutes on a busy one, and a docs pass is a second round of reading. Now the agent is told to
spend its turn on the edit, and once a turn that edited something finishes, the endpoint starts
both side by side (`background` in the endpoint) and the panel polls `/runs/:id/background` and
draws them under the reply: "Running tests" (with a pulsing dot in front of whatever is still
running, rather than a spinner glyph) then "✓ Tests pass", or "✗ Tests failed" with the FAIL
lines and a **Fix** button that sends them back to the agent. The docs pass is a second headless
agent on the fast model, allowed to edit `docs/` and nothing else, handed the request and the
turn's diff. What it edits joins that turn's files, so the turn's Undo takes the doc edits back
with the code (and cancels anything still running). If it did edit, the doc-link check is re-run
after both finish. A newer turn supersedes a check still running, since it would be testing a tree
the next agent is busy changing; that turn's own check covers both.

**Speed** (the picker at the far left of the composer, opposite Send) chooses the model. **Smart** is the CLI's default. **Fast** is
`WORKSHOP_FAST_MODEL` (default `sonnet`; the docs pass uses `WORKSHOP_DOCS_MODEL`, defaulting to the
same). **Auto** sends a message to the fast model when it reads as one simple change: 200
characters or fewer, no list, no pasted image (a pin's context does not count against it). The
chat does not say which model answered. A wrong guess is cheap now that every edit is
checked: **Fix** always goes to Smart.

**A reply survives the page reloading under it.** Most edits hot-swap the bench, but an edit to the
page itself (or to anything Vite cannot swap) reloads the tab, and the tab is where the reply was
being read. So the run lives on the server and buffers its events, the conversation lives in
`sessionStorage`, and a reloaded page reattaches with `?from=` and replays what it missed. Killing
the CLI when the tab dropped its stream would have let the agent's own edit kill the agent.

Each message the user sends wears an emoji reaction hanging off its bottom edge, 8px in from the right: 👀 if the
text they typed contains a `?`, 👍 otherwise. It is deterministic on purpose, not the agent's reply
(no model call), and it reads the typed text rather than the bubble, so a pin's label can't turn a
statement into a question. It is stored on the message (`reaction`, with `sentAt`), so it survives
the reload with the rest of the conversation. The badge pops in 1200ms after the send; until
then a "…" (three bouncing dots in the same pill, `.reaction.typing`) stands in for the agent
thinking, fading in just after the message lands and out as the badge takes its place. The log is
rebuilt on every streamed event, which would restart a plain CSS animation each time, so the
animation's delay is whatever is left of the 1200ms (negative once it is under way, resuming at the
right frame; the dots' single `typing-life` animation spans the whole wait the same way), and a
badge older than the delay plus the 250ms pop gets no animation at all, nor dots once the delay has passed. Its
background is a shade lighter than the panel so it stands off the black user bubble it overlaps.

The half-typed message in the composer survives the same reload: it is written to `sessionStorage`
(`workshop-chat-draft`) on every keystroke, put back on load and cleared on send. A textarea keeps
nothing across a reload on its own, and the agent's edits reload the tab mid-sentence. Text only —
pasted images are too big for `sessionStorage` and are not kept.

The composer grows with its text (`autosize` in `chat.js`) from its 64px minimum to a cap of ten rows, then
scrolls; the manual resize handle is gone. The textarea's bottom padding is the strip the buttons sit in, so
there is always a row clear under the last line. `scrollHeight` leaves the border out of a border-box, hence
the `+ 2`, and the height is collapsed to `auto` first so it can shrink after a send or a deleted paragraph.

Send (Queue, while the agent is busy) is disabled while the composer holds nothing to send: no text beyond
whitespace and no pasted image (`syncSend`, run from `autosize` and `drawAttachments`, so every path that
changes the text or the attachments passes through it).

Focus survives it too, caret and selection included, so you can keep typing while an edit lands.
`beforeunload`/`pagehide` note whether the composer has focus (`workshop-chat-focus`, the two
selection offsets) while the page still knows what is focused; load refocuses it and clears the note.

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

**The exception is an edit to shared state, which reloads the page instead.** After a palette edit
the bench drew only the sky and the grid until the tab was refreshed by hand. So an update touching
`palette.js`, `util/geo.js` or the render passes (`renderpath`, `ssao`, `bloom`, `scene`) reloads the
tab itself, carrying the camera across in `sessionStorage`. The root cause was not pinned down, so
that list is a guess at the modules whose module-level state is at risk; add to it if another edit
blanks the bench.

**A reload doesn't flash either: the last frame is held over the stage.** A reload blanks the tab
until the module has loaded and the shaders compiled. So as the page goes away (`pagehide`, or
Vite's `vite:beforeFullReload`, which is earlier and still has a drawn canvas) `stashSnapshot`
saves the bench's last frame to `sessionStorage` as a 1280px-wide JPEG, skipped while the game is
playing. An inline script in `workshop/index.html`'s `<head>` puts it back as `#stage::after` in the
very first paint, and `releaseSnapshot` fades it out two frames after the new run's own first frame.
A private window that refuses storage just flashes as before.

Two things about this are not obvious:

- **It has to be spelled `import.meta.hot.accept()`.** Vite finds self-accepting modules by
  scanning source text for that expression. The first version aliased `import.meta.hot` to a
  `const` and called `hot.accept()`, Vite never saw it, and every edit dead-ended at the viewer and
  reloaded the page.
- **The chat is a separate module that imports nothing from the game**, so it is never in the graph
  an edit invalidates. Were it inside the viewer, every edit would reset the conversation.

## The bench

**The bench draws through the game's own rendering path** (`game/renderpath.js`): the same budget
off the same URL flags, the same look decisions compiled into every material (AO, painterly, the
paint look, the rim, Crayon, Cartoon), and the same passes in the same order — the AO prepass, the
rim's depth, the bloom, then the frame. `main.js`'s `renderFrame` is that function plus the game's
weather and diagnostics, so a change to how the city draws lands on the bench with nothing to
copy. It used to be a hand-kept copy, and it drifted: it stayed on toon paint after the game moved
to real, and drew no rim and no AO at all. Every game flag (`?ao=off`, `?crayon`, `?bloom=off`)
works on the bench URL too. A model's lamps bloom at the kinds `main.js` gives them: a landmark's
come from its own `LANDMARK.glow`, which `main.js` reads as well.

**Orbit** is an orthographic camera on `OrbitControls`, like the game's: the AO and the rim read
the prepass's depth as linear world units, which only holds without a perspective divide. Its
dolly is folded from `camera.zoom` into the frustum each frame, because the AO's sample rings are
sized off `right - left` alone. It sits at the game camera's 400-unit standoff with a 1400 far plane,
not at whatever clears the model: the sky dome is a 900-unit sphere, and a tighter far plane cuts it
off and leaves the bench on black. It starts from the game camera's side of the model so the first
thing you see is the face the player sees. **Game view** is the game's own
`createCityCamera`: the fixed orthographic 3/4 view, wheel to zoom. Check anything small there,
because at play zoom a world unit is about 7.7 px. The hour slider drives `game/daylight.js`, and
the turntable spins the orbit. **Wireframe** draws the model's own materials as wires (the bench
floor stays solid), for counting triangles and finding a stray face.

**The game-zoom inset**, top right, is always on unless you minimize it with the – in its corner, which shows only while the pointer is over the window (the box takes no pointer events, so `:hover` can't see it: `viewer.js` sets `.hover` from the pointer's position; the + on the tab it leaves is always shown and brings it back): the game camera again, at
the density the game plays at (7.7 px a unit, which is `PLAY_ZOOM` in an ~800 px-tall window), so
you can tweak in close-up and see at the same time whether it reads at play size. It is a
scissored pass through the same renderer, not a second WebGL context, so it costs nothing to
hot-reload. It is rendered first and copied out into a small 2D canvas in a rounded box before the
main view paints over its corner, because a scissored rectangle cannot have rounded corners. Its camera is stretched to the whole canvas at the inset's density and scissored to
the corner, because the AO, rim depth and bloom are full-canvas textures looked up by
`gl_FragCoord`: a view squeezed into a corner viewport would read them at the wrong pixels. The screenshot sent to the agent includes it.

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
look across, and tears it down again on the way back. **`R`** reframes the model (the Reframe button's key, ignored while typing). **`.`** hides every panel and leaves just the
viewport.

## Voice

The mic, bottom-right of the composer beside Send (the Speed picker is bottom-left), dictates into the composer with the browser's own Web Speech API
(`SpeechRecognition`), so there is nothing to install and the page uploads nothing itself. Pressed,
it starts listening and the transcript streams into the box as it is recognised, appended after
whatever was already typed; the picker, Stop and Send hide and the mic turns into a stop button.
Every control in the composer (Speed picker, mic and its stop state, Stop, Send / Queue) is a fixed 28px tall, so the row never
steps as buttons swap.
Pressing it again, or sending, ends it. The button is hidden in a browser without the API
(Firefox). In Chrome the audio goes to Google's recognition service, which is the browser's choice,
and the page needs microphone permission: a refusal is reported in the chat.

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

A whole-block landmark needs no entry: export `LANDMARK = { id, label, create, glow? }` from its module
in `src/city/`, where `create(block, rng)` returns `{ group, update? }`, and the catalog finds it
(`import.meta.glob` under Vite, a directory read under the headless check). The depot, burger
joint, graveyard, car wash and gas station all arrive that way; the bank, a lot inside
`createBuildings` rather than a module of its own, is still a hand-written entry.
