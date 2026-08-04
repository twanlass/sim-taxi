# Vehicle editor

A workbench for designing the game's vehicles, served at **`/editor.html`** next to the game
(`npm run dev`, then http://localhost:5173/editor.html). Somewhere between "click through random
options" and a full modelling package: sliders for the shapes that matter, presets for the
archetypes, and a live preview under the game's own lighting.

| File | Owns |
|---|---|
| `src/geometry/carkit.js` | The parametric kit: spec → merged low-poly geometry, presets, clamping, randomizer |
| `src/editor/editor.js` | The workbench app: scene, orbit, panel, garage, JSON in/out |
| `editor.html` | Page shell and panel styling |

## The kit

`buildVehicleGeometry(spec)` turns one plain-data spec into one merged geometry, built with the
game's exact discipline — non-indexed, baked vertex colours via `bakeColor()`, one
`propMaterial()` — so a design is drop-in compatible with the meshes in `sim/traffic.js`,
`sim/police.js` and `geometry/taxi.js`.

A spec is fractions, chains and boxes:

- **body** — length / width / height / ground clearance, and a **profile**: a chain of
  `[x, y]` points (fractions of length/height) running nose-bottom, up over the roofline, to
  tail-bottom, closing flat along the ground and extruded across the width. A rectangular
  chain *is* a box; a drawn one is a wedge, a fastback, a chopped tail. Fractions so the
  length/height sliders keep composing with a drawn profile. The chain is kept x-monotonic
  (ties allowed — vertical edges), which is what makes self-intersection impossible.
- **cabin** — a glass box on the body, sized and positioned as *fractions of body length*, so
  stretching the body carries the cabin with it; it sits on the roofline beneath it, not on a
  nominal top. **rakeFront/rakeBack** shear its top face inward — a raked windscreen and rear
  screen. The shear moves every duplicate of a corner together (the `jitterVertices` welding
  rule; per-copy movement tears the surface).
- **wheels** — radius, tyre width, stance (axle inset), 2 or 3 axles (the third doubles the rear,
  truck-style)
- **cargo** — `none`, an open pickup **bed** (four walls; the body top reads as the floor), or a
  **box** (a cargo volume slightly wider than the body). Cargo colour `'body'` follows the paint.
- **extras** — the taxi's flank stripe or the police skirt wrap, a roof sign, a baked light bar
- **partColors** — per-part colour overrides keyed by manifest name, written by
  click-to-select; absent keys fall through to the role colours

Everything numeric is clamped through `LIMITS` in `normalizeSpec()`, which also fills gaps from
the default — imported or hand-edited JSON degrades to a buildable car, never NaN geometry.

**The manifest.** `buildVehicleGeometry()` records each named part's contiguous vertex range in
`geometry.userData.manifest` (`{ name, start, count }` — `mergeGeometries` preserves push
order, and consecutive same-name parts collapse, so "wheels" is one part, not four boxes).
That is what lets the editor raycast the single merged mesh and still know what was clicked:
`partAtFace(manifest, hit.faceIndex)`. `check.mjs` asserts the ranges tile every preset's
geometry exactly.

**The `sedan` preset is the game's ambient car, box for box**, and `npm run check` asserts it
stays that way (`carkit` line). That pin is the point: the kit is only a trustworthy editing
surface for the game's vehicles while its baseline *is* the game's vehicle. `police` matches
`policeGeometry()` the same way; `taxi` is the sedan plus its stripe and sign (the game applies
its 1.18 scale at the group level, not in the spec).

Orientation: **+X is the nose**, origin on the road under the car's centre — same as every
vehicle in the game.

## The workbench

The scene is `createScene()` from the game — same sun, fill and sky, with only the shadow
frustum pulled in from city-sized to bench-sized. The car sits mid-lane on a patch of the game's
own 8-unit road (centreline dashes one `LANE` away, kerbs at the edges) so scale is always in
frame.

- **Click a part to recolour it** — a press under 5px of travel is a pick (the same
  press-vs-drag slop split the game's pan makes, for the same reason). The selection pulses
  toward white by rewriting that part's slice of the colour attribute each frame, restored from
  a copy taken at build time; the chosen swatch lands in `partColors`. Esc or empty space
  deselects.
- **Silhouette mode** (✎ under the Body sliders, or `?silhouette=1`) — the camera swings to the
  side, the profile points become draggable handles on the near flank, and orbiting pauses so a
  drag means "move this point". Drags are clamped between neighbours (the chain stays
  monotonic); double-click the side to insert a point, double-click a point to delete it.
  Endpoints slide along the ground only — they close the polygon.
- **Play-zoom inset** (bottom left) — an orthographic camera down the game's `VIEW_DIR`, sized so
  one world unit covers the same pixels as at play zoom (frustum half-height 52 over the window
  height). Whether a design *reads* at seven-ish pixels per unit is the question that matters,
  and the full-size orbit view cannot answer it.
- **Stock sedan** toggle — parks the ambient car in the oncoming lane, because "is my van bigger
  than a car?" is unanswerable with nothing beside it.
- **Turntable** — on until the first drag; dragging orbits, the wheel zooms.
- **Garage** — named designs in `localStorage`, plus autosave of the working spec across reloads.
- **Copy / Import JSON** — the interchange format is the spec itself. To ship a design, paste it
  as a preset in `carkit.js` (or use it to retune the hand-built meshes it mirrors).
- **`?preset=boxtruck`** pins a preset over the autosave — a link means one specific vehicle.
- **`?shot=`** freezes the turntable, and the page sets `shotReady` — so `tools/shoot.mjs`
  screenshots it exactly like the game:
  `CHROME=… node tools/shoot.mjs --url http://localhost:4173/editor.html?preset=van --shots 0`

The build emits both pages; `vite.config.js` exists solely to list the two inputs.

`window.__editor` is the page's test hook, in the spirit of the game's `window.__taxi`: the
live spec, the current selection, and `handleScreen(i)` projecting a silhouette handle to
screen pixels — so a headless driver aims real pointer events at real positions instead of
guessing coordinates off a screenshot.
