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
| `src/workshop/composer.js` | the composer as a component (`createComposer`): the growing text box with the Speed picker, mic, optional Stop and Send inside its bottom edge, Enter to send and dictation. Used by the chat panel and by the pin's note, so the two cannot drift; imports nothing |
| `src/workshop/emptytaxi.js` | the new-chat screen: no copy, the game's taxi side on, doing its Loco Mode weave and bob on the spot, burning the Loco plume out of its tailpipe over a disc of road that fades to nothing round it (an `alphaMap`, so the panel behind stays the page, not black) whose centre dashes stream past; a click on the taxi (raycast against the car itself) hops it on gravity, nose pitching with the climb, and it lands with the drift launch's dust burst and ring turned down, then a short squash. Clicking again in the air kicks it higher, so a fast clicker climbs; past a ceiling it stalls, tips nose-down and crashes with a bigger squash and heavier dust, and ignores clicks until it lands; drawn through the game's render path so it wears the rim line and AO |
| `src/workshop/consolelog.js` | forwards the page's console errors and warnings to the endpoint, and hands errors to `chat.js` for the auto-fix |
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

An entry may undo what the game does to a builder's result, when the game only shows it on an event: the
fire engine's `shell` is hidden until it responds to a fire, so its entry sets `shell.visible = true` or the
bench would draw an empty group. The garbage truck (hidden between collections) and the street racer
(`createRivalMesh`, exported from `game/race.js` for the purpose) are the same.

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

**Suggesting a new chat.** A chip above the composer (`#suggest`, `refreshSuggest` in `chat.js`) offers
**New chat** when the old history has become dead weight, on two local signals and no model call to judge
a topic: the bench is showing a different model from the one the chat began on (`chat.benchId`, the model
of its first message), or the chat has run `LONG_CHAT_TURNS` (14) user messages. It offers rather than
interrupts, and never while a run is going or messages are queued; × waives it (`chat.dismissed`), per
model for the first signal so a third model asks again. It polls once a second, because the bench's model
picker lives in another module that re-runs under this one and cannot be listened to.

**What it may do.** Headless, there is nobody to answer a permission prompt, so anything not on the
list is refused outright: edits (via `acceptEdits`), Read, Glob, Grep, `node --check`, `git diff`
and `git status`. No commits, pushes, installs or servers, and no test suite (below). The endpoint
also answers loopback only, since `vite --host` would otherwise hand a file-editing agent to the
whole Wi-Fi.

**The browser console reaches the agent.** The agent cannot open devtools, so an error only the browser
sees (a mount that throws, a shader that fails to link) used to arrive as a pasted screenshot.
`consolelog.js` wraps `console.error` and `console.warn` and listens for uncaught errors and unhandled
rejections, batches them (a failing frame logs hundreds a second) and posts them to `/__workshop/console`;
the endpoint (`appendConsole`) keeps the last 40 in `.workshop/console.log`, each trimmed to its first
eight lines and a repeat of the previous entry dropped, and the prompt tells the agent to Read it first
when something is missing or blank. Installing is idempotent (`window.__workshopConsoleCapture`), since an
edit to the file re-runs it. Nothing in it logs through `console`, or a failed report would report itself.

**An error right after an edit is sent back to the agent.** An error that appears within 30 s of a reply
that edited files (`chat.editedAt`) is nearly always that edit's, so `autoFix` in `chat.js` sends it as
a message on **Smart**, as Fix does, rather than waiting for someone to notice. Bounded, because an
agent fixing its own console is one bad fix from a loop: one attempt per error signature (the first line
with its numbers removed, kept in the conversation so the reload the edit causes cannot re-fire it), and
at most two in a row (`AUTOFIX_CHAIN`) until the person sends a message.

The log shows none of it: nobody needs the error text or the agent's account of the bug. The message
is flagged `auto` and renders as a quiet status line (`.msg.note`, not a bubble, in the queue too):
"Fixing a browser error…", then "Error fixed" (or "Couldn't fix the error") when the run ends. The
run's text events are dropped while `chat.runAuto` is set.

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

**Stop is a note, not an error.** The Stop handler marks the run `stopped` before it sends SIGTERM,
and the run ends with `stopped: true` if it died by signal *or* that flag is set — the CLI can catch
the SIGTERM and exit with a code and stderr of its own, so the flag, not the exit, says why it ended.
The panel draws that as a "Stopped" note rather than the red error bubble a failed run gets.

Each message the user sends wears an emoji reaction hanging off its bottom edge, 8px in from the right: 👀 if the
text they typed contains a `?`, 👍 otherwise. It is deterministic on purpose, not the agent's reply
(no model call), and it reads the typed text rather than the bubble, so a pin's label can't turn a
statement into a question. It is stored on the message (`reaction`, with `sentAt`), so it survives
the reload with the rest of the conversation. Every reacted message gets 46px of right padding
(`.msg.user:has(.reaction)`), because the pill reaches ~42px in from the edge: a short one-liner
would end under it, and so can the last line of a long message. The badge pops in 2400ms after the send (doubled from 1200 so the dots read as thinking); until
then a "…" (three bouncing dots in the same pill, `.reaction.typing`) stands in for the agent
thinking, fading in just after the message lands and out as the badge takes its place. The log is
rebuilt on every streamed event, which would restart a plain CSS animation each time, so the
animation's delay is whatever is left of the 2400ms (negative once it is under way, resuming at the
right frame; the dots' single `typing-life` animation spans the whole wait the same way), and a
badge older than the delay plus the 250ms pop gets no animation at all, nor dots once the delay has passed. Its
background is a shade lighter than the panel so it stands off the black user bubble it overlaps.

**A reply opens on dots and types itself out.** A new agent bubble (`live` in `apply`, stamped with `at`
and `shown: 0`) shows the same three bouncing dots for `DOTS_MS` (700ms), then `reveal` in `chat.js`
draws `message.text` a slice at a time from a `requestAnimationFrame` loop, so a reply reads as typed
rather than arriving in whatever chunks the stream delivers. It is only cosmetic: the whole text is on
the message the moment it arrives and `shown` is how much is drawn. The rate has a floor of ~120
characters a second and catches up on any backlog within about 500ms, so a long reply landing in one
burst is never held back longer than that. The loop is needed because the log is rebuilt on every
event; `render()` re-registers each agent bubble in `bubbles` and `kickReveal` restarts it. Messages
without `shown` (older ones, or restored after the reveal finished) draw whole, and the `▍` cursor
(`.working`) is suppressed while the dots are up.

**The log only follows a reply while the reader is at the bottom.** Because it is rebuilt on every
streamed event, emptying it shrinks it and the browser clamps `scrollTop`, which used to drag a
reader back down on every word. `render()` reads the position before the rebuild: within 48px of the
bottom, or just after sending a message, it pins to the bottom; scrolled up, it puts `scrollTop` back
where it was and leaves the reader to scroll down when they get there.

The half-typed message in the composer survives the same reload: it is written to `sessionStorage`
(`workshop-chat-draft`) on every keystroke, put back on load and cleared on send. A textarea keeps
nothing across a reload on its own, and the agent's edits reload the tab mid-sentence. Text only —
pasted images are too big for `sessionStorage` and are not kept.

The empty chat composer's placeholder rotates through example prompts (`IDEAS` in `chat.js`, one every 4s), because
the empty box is the only hint of what the chat can do and one fixed line reads as the whole range. They are
deliberately generic so they suit any model on the bench. It holds still while the box has text or focus, so the
line doesn't change under someone about to type. The pin note's composer keeps its own fixed placeholder.

The composer grows with its text (`autosize` in `composer.js`) from its 64px minimum to a cap of ten rows, then
scrolls; the manual resize handle is gone. The textarea's bottom padding is the strip the buttons sit in, so
there is always a row clear under the last line. `scrollHeight` leaves the border out of a border-box, hence
the `+ 2`, and the height is collapsed to `auto` first so it can shrink after a send or a deleted paragraph.

A composer sits `--composer-inset` (5px) in from the panel that holds it (the chat, the pin note), and its
box's corner is `--radius` less that inset, so the two curves are concentric instead of the inner one
bulging toward the outer at the corners. Change the inset and the radius follows; don't give either a literal.

Send is an up-arrow icon in every state, never a word: it is the same pill as Stop-and-send, so toggling voice
mode swaps equal-width buttons and the row does not shift. While the agent is busy it keeps the arrow and only
its accessible label reads Queue. It is disabled while the composer holds nothing to send: no text beyond
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
| `src/workshop/emptytaxi.js` | hot-swaps on its own: `chat.js` loads it with a dynamic `import()` (it must import nothing from the game, or an edit would re-run it and wipe the conversation), and it accepts itself and picks its host back up from `hot.data` |
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

**The model stays where it was set.** `load` recentres a model on the bench, and a part added to one
end moves the bounding box's centre, so recentring on every edit slid the whole model across the
viewport under a camera the edit was meant to leave alone. The offset it applied (`placement`) now
rides `import.meta.hot.data` (and `sessionStorage` across a reload) and an in-place rebuild of the
same model reuses it; picking another model recentres as before.

**Any reload keeps the framing, not just the swaps.** `stashFraming` writes the model, zoom, offset and
orbit camera to `sessionStorage` on `pagehide` and on Vite's `vite:beforeFullReload`, so a manual
refresh or an edit to the page or the chat lands on the same view (a wheel zoom not yet folded into
`orbitHalf` is folded first). Only the shared-state reload used to stash it, so every other reload
recentred the model. A `?model=` naming a different model than the stashed one discards the stash:
another subject, another framing.

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

**The reload is a navigation, so the page crossfades, and what the edit changed lights up.** A
cross-document view transition (`@view-transition` in `workshop/index.html`) runs on push, replace
and traverse but never on a reload, so `reloadSmoothly` in `viewer.js` replaces the page with a
same-URL navigation instead (a hash falls back to `reload()`, as does a navigation that has not
committed after 4s). Vite's own full reloads are taken over the same way: its `vite:beforeFullReload`
listener starts the navigation and returns a promise that never settles, which stops Vite's
`location.reload()` (an `.html` edit naming another page is left to Vite). Both module scripts are
`blocking="render"`, so the old page holds until the new one's first frame is filled in. Once fonts
are in and the fade is mostly through, `flashChanged` compares each element's rounded box and a few
computed styles against what `uiSignatures` saved before the edit (`sessionStorage`, or
`import.meta.hot.data` for a hot swap) and sweeps a `.ui-changed` overlay (glowing outline, scan
lines, a bright line down it) over the outermost changed elements, at most ten. The chat log, the
canvases and the pin are skipped, since they change constantly. It is an overlay, not a class on the
element, so it cannot fight the element's own `::before`/`::after` or transitions.

The model gets the same cue, but only when the model itself changed: every edit re-runs `viewer.js`
(a chat or composer tweak included), so `load` stamps the built model with a `fingerprint` (FNV-1a
over every mesh's vertices, transform, instance matrices and material colours), the stash carries
it across the reload, and `startScan` runs only if the model or the print differs. A stash with no
print sweeps as before. The sweep is a scan-lined plane with a bright rim, in the panels' cyan, rises through the model from its feet to
its top over 0.9s (eased out, faded over the last third). It is depth-tested, so it cuts through the
model instead of floating over it, and additive, so it never hides what it passes.

Two things about this are not obvious:

- **It has to be spelled `import.meta.hot.accept()`.** Vite finds self-accepting modules by
  scanning source text for that expression. The first version aliased `import.meta.hot` to a
  `const` and called `hot.accept()`, Vite never saw it, and every edit dead-ended at the viewer and
  reloaded the page.
- **The chat is a separate module that imports nothing from the game**, so it is never in the graph
  an edit invalidates. Were it inside the viewer, every edit would reset the conversation.

## The bench

**The bench's knobs are a column of panels, top-left: Model (the model drop-down and Paint) and Scene (everything else).** Each
is a `.panel` with a titled header (the `h1`, and the fold toggle at its far right) over a `.panel-body`; Model's body holds the
drop-down and Paint. Folding Model leaves just its title. Scene starts folded (`collapsed` in the markup) and Model starts open. The column is a flex stack, so folding one shut (the – / + button, which
shows only while the pointer is over the panel, always when folded, and always on a touch screen; the click handler in `viewer.js`
toggles `.collapsed` and reads the panel's name from `data-name`) lets the panels below slide up with no layout code. A new group of knobs is a new
`.panel` in `#bench`, not more rows in an old one.

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
thing you see is the face the player sees. There is no separate game view: the
game-zoom inset below is the game's own `createCityCamera`, and checking anything small there
is what it is for. The hour slider drives `game/daylight.js`, and
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

URL: `?model=<id>&hour=<0-24>&spin=1&wire=1&inset=0&paint=<look>&weather=<squall|night>`. The page keeps it current, so a reload or a shared
link comes back to the same bench.

**Weather** previews lamps: Day, Squall or Night. It throws the game's own switches by hand
(`setCityLights`, `setRunningLights`, and a catalog entry's optional `lamps(level)`, which the taxi uses for its
headlights and tail lights and a landmark uses for its `litWindows` panes). Squall is the shower storm's grade with
falling rain (`game/rain.js`, built the first time it is chosen) and the lights on; Night parks the day clock at 22:00
with the lights on, and Day or Squall hand the hour back. Wet and lens are left at 0: the bench ground is not the game's
patched one, so a mirror pass would only draw the model twice. `weather` is omitted from the URL while it is Day.

**Lamp toggles** (Headlights, Brake lights, Blinkers) sit under Wireframe and show only for a model whose catalog entry offers
`switches` and a `setSwitch(id, on)` (the taxi). A ticked lamp is held on whatever the Weather says, and unticked it follows the
Weather as before; ticking Blinkers lights both sides at once, the hazards, because the flash is the sim's clock and the bench
has none to step. Which are ticked survives a rebuild (`heldSwitches` in `viewer.js`), so an edit hot-reloading the model does not
turn them off. They are not in the URL.

**Paint** (in the Model panel, under the model drop-down) picks one of the game's `?paint=` looks. The look is compiled into the shader, so picking
one rebuilds the model. **Every slider's number is also a field** (`bindReadout` in `workshop/viewer.js`): click it to type an exact value (the Hour's takes `16:30` as well as `16.5`). A committed number goes through the range itself, so it clamps and snaps to the slider's own min, max and step and the slider's `input` handler stays the one place a change lands; Enter or leaving the field commits, Escape or anything that doesn't parse puts the readout back. **Rim light** (a collapsed section under Paint in the Model panel) is ten sliders on the paint's rim
(`rimTuning`/`setRimTuning` in `util/geo.js`, the same rows as the game's ⚙️ panel). They are uniforms, so they move the
paint live with no rebuild; every paint look wears the rim line except Classic, so the section is hidden there (its sliders would move nothing); each paint look sets its own rim width, so picking one re-reads the sliders, and Reset returns
them to what they read when the page loaded, before any saved values were applied. They are not in the bench's URL: a 400ms-debounced move writes them to `localStorage` (`workshop.rim`), so a reload keeps the sliders (a stale or hand-edited entry is ignored), and echoes them as a `[rim-tuning] {…}` warning, which the page forwards to `.workshop/console.log`, so the chat can read the numbers back. **Play** opens the real game in a frame over the bench, carrying the paint
look across and the sliders as `?rimtune=` (`getRimTune` in `util/shot.js`, applied in `decideLooks` after the look and rim colour, which each reset the numbers), so the game opens on what the bench shows. It also passes `?title=off&vignette=off&tutorial=off`, so Play drops straight into a run with no title menu, opening vignette or tutorial bubbles; it tears the frame down again on the way back. **`R`** reframes the model (the Reframe button's key, ignored while typing). **`.`** hides every panel and leaves just the
viewport.

## Voice

The mic, bottom-right of the composer beside Send (the Speed picker is bottom-left), dictates into the composer with the browser's own Web Speech API
(`SpeechRecognition`), so there is nothing to install and the page uploads nothing itself. Pressed,
it starts listening and the transcript streams into the box as it is recognised, appended after
whatever was already typed; the picker, Stop and Send hide and the mic turns into a stop button, with a
Stop-and-send button (an up arrow, no label) to its right that ends the dictation and sends what was heard.
The last words arrive after `stop()`, so it sends from `onend` (`sendOnEnd`) rather than on the click.
Every control in the composer (Speed picker, mic and its stop state, Stop, Send) is a fixed 28px tall, and Send is the same
arrow pill as Stop-and-send, so the row never steps as buttons swap.
While it listens, a 10-bar white waveform (60px; 14 crowded the box) takes the Speed picker's place bottom-left, so something moves
the moment you speak, before the recogniser has any words. Recognition hands over words, never audio, so
`listenLevels` (`composer.js`) opens a second microphone stream beside it and reads the loudness
through an `AnalyserNode`: one level every ~70ms (every frame was a blur) scrolls in at the right, the
peak since the last step so a short word is not lost. The bars are scaled, not eased: a transition
lagged the voice and read as sluggish. If that stream is refused the bars stay at rest and
dictation carries on.
Pressing it again, or sending, ends it. The button is hidden in a browser without the API
(Firefox). In Chrome the audio goes to Google's recognition service, which is the browser's choice,
and the page needs microphone permission: a refusal is reported in the chat.

## Pasted images

Images pasted or dropped onto the compose box (up to six) show as thumbnails inside it, above the
text, and go with the next message. The row (`#attachments`, made by `chat.js` and prepended to the composer) is
laid over the textarea's top padding, which grows by the row's measured height plus the same 12px gap a sent
bubble uses (`--attach-h`, set in `drawAttachments`), so six thumbnails wrapping to a second row push the text down
and the box's border (which brightens on focus rather than gaining an outline) wraps both. Each is re-encoded to PNG through a canvas, capped at 1600 px on the long side,
and the endpoint writes them to `.workshop/attachment-<n>.png` (clearing the last turn's first) and
tells the agent to read them. Queued, they wait in IndexedDB beside the screenshot.

The sent bubble (and its queued twin) shows the pictures as a row of thumbnails above the text with a
12px gap between (the row is prepended, and drops its margin when the bubble has no text), not a
"🖼 ×n" count. The full PNGs would not fit in the saved log (`sessionStorage`), so each is redrawn
through a canvas to a 160 px JPEG (`thumbOf`) and that is what the message keeps and a reload replays.

## Pins and the queue

A click on the model (a press that doesn't travel, so the orbit keeps its drags) drops a pin and
opens a note beside it. The note is the chat's own composer (`createComposer`), two rows tall, so a pinned message has the Speed picker and the mic too, and its Send reads Queue while the chat is on a reply. It is rebuilt with `viewer.js` on every hot reload, so the text being typed is handed across in `hot.data` (`pinText`). The note goes to the chat with the spot described in the builder's own
coordinates (the hit point taken back through the model's transform, recentring and `TAXI_SCALE`
included), the facing of the surface, the palette name of its vertex colour, and a screenshot with
a ring drawn at the spot. The agent edits source, so those are the numbers it can find there.

A part inside a merged mesh is named too. `merge` in `geometry/classics.js` flattens a model's parts
into one geometry, which used to leave a click saying only `unnamed mesh`; a builder now wraps a part
in `named(label, geometry)` and `merge` records each label's vertex range in `geometry.userData.parts`,
which `describeHit` matches against the hit triangle and appends to the part path. Only the Westfalia
labels its parts so far (`lower body`, `upper body`, `windscreen`, `pop-top`, ...); an unlabelled part
still reads `unnamed mesh`.

The description also says where to edit it, so the agent needn't grep: `- built by:` is the first
`userData.src` found on the hit geometry, then up its ancestors to the model's holder (the police
cruiser's merged mesh names the three builders that made it), and `- model source:` is the catalog
entry's `source`. A part with no `src` just omits the first line.

`src` is stamped by `srcTag(geometry, text)` in `util/geo.js`, on the shared builders so far: `carGeometry`,
`policeCabGeometry`, `truckCabGeometry`, `truckBoxGeometry`, `wheelGeometry` and `sirenPodGeometry`.
The tag survives only where the geometry is drawn as returned; `mergeGeometries` makes a new geometry
and drops it, so a builder that merges tags its own result.

**⌘-click (or Ctrl-click) the model** opens a colour swatch on the spot instead of a pin (`openSwatch`
in `viewer.js`, the `#swatch` panel in `workshop/index.html`, placed beside the hit like the pin note):
a plain "Edit" title (the palette name means nothing at a glance; Save's tooltip still carries it), a
native colour input, a hex field (capped at seven characters, so the text can't spill out of the
panel), Cancel and Save. Nearly every colour here is baked into vertices
(`bakeColor`), not set on a material, so the picker recolours, live, **every surface in the model
wearing the colour under the cursor** (`wearersOf`: matching vertex-colour ranges, instance colours or
material colours, whichever kind was hit), since that colour is one palette entry and painting only the
hit triangle would show something the palette can't express. It is only a preview: closing the panel
(Cancel, a plain click, Escape, or a hot reload, whose geometry may be shared with modules that outlive the run)
puts the old colour back. A click on the model while the colour input or hex field has focus is
the exception: it only dismisses the browser's picker popup (blurs the field) and leaves the panel and
the edit alone; the next click closes as usual. **Save** sends the chat "Change `PALETTE.<name>` to #…" with the usual hit
context and screenshot (a colour matching no palette entry says so and asks the agent to find where it
is made, and the context warns it to give the model its own entry if the palette one is shared); the
panel stays on the new colour until the edit to `palette.js` reloads the page. Hidden in Play and bare mode.

The sent bubble also carries a 240 px square thumbnail of the bench around the pin, ring at its
centre (`captureCrop` in `viewer.js`), so the note can be tied back to the spot it was about when you
scroll back through the chat. It is cut from the live canvas at its own pixel density and, like the
full screenshot, taken at send time rather than when the message reaches the front of the queue. It is
for you: the agent still gets only the 1024-wide shot. The bubble's text leads with `📍 <part>:` only
when the builder named the part; the generic labels (`unnamed mesh`, `group`, `on the bench beside
it`) are left off, since they say nothing the thumbnail doesn't (`GENERIC_LABELS` in `chat.js`).

Messages sent while a reply is still going wait in a queue under it and go one at a time as each
reply finishes; the server only ever runs one. A queued message goes with the bench as it was when
it was **queued**: its model and view ride in the queue, and its screenshot is kept in IndexedDB (a
megabyte of base64 apiece would fill `sessionStorage`), so it survives the page reloading while it
waits. The first version read all three at send time, and a note about the helicopter went out
naming the L train, with a picture of it. A sent pin stays on the bench, dimmed, until the
reply to its own message is done, or until its queued message is removed with its ×.

## Z-fighting on the bench

**Every build of the model is scanned for z-fighting** (`src/util/zfight.js`, the same scan
`tools/zfight.mjs` runs in `npm run check`), so a tie the chat's edit (or yours) introduced shows the
moment it hot-reloads, not when the background checks come back. Each tie gets a magenta pin
(`PALETTE.benchZFight`) where its biggest patch is, and a banner bottom-left lists them. The scan
looks the way the game does: down the fixed view, and at every heading for anything that drives,
so a tie on a face the player never sees is not reported. The banner is also echoed as a
`[zfight]` warning, which lands in `.workshop/console.log` for the agent; its prompt asks it to run
`node tools/zfight.mjs --model <id>` after an edit, the one check it runs itself.

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
