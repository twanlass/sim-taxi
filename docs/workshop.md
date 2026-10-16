# The model workshop

**`/workshop/` — a workbench, not part of the game.** One vehicle or landmark on a slab of road,
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
the turntable spins the orbit.

The sun's shadow camera is pulled in to ±24 units. The scene's own covers the whole city, which is
0.12 units a texel, about thirty texels across a car. The bench is never bigger than a block.

Landmarks are built on block (2, 2) the way `createLayout` would hand them one, on a kerb-height
plinth so they stand at their city height, then recentred. The ambient fleet's vehicles are
assembled from the same geometries `createTraffic` instances (body, front wheels, cargo box), on
one material per paint, the way `wreckShell` copies a car out of the fleet.

URL: `?model=<id>&view=game&hour=<0-24>&spin=1`. The page keeps it current, so a reload or a shared
link comes back to the same bench.

## Adding a model

Add an entry to `CATALOG` in `src/workshop/catalog.js`: `id`, `label`, `kind` (the picker's group),
`source` (`src/<file>.js · <function>`, which is what the agent is told to edit), and
`build(rng)` returning `{ object, update? }`. `tools/workshop.mjs` builds every entry, so a broken
one fails `npm run check`. You can also ask for one in the chat.
