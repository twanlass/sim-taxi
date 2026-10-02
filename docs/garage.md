# The garage

**`/garage/` — paint a vehicle in 3D, save its skin, and the game draws it.** A workbench like
[the lab](lab.md): nothing in the game links to it, and it is left out of the iOS build.

```
npm run dev            # then open http://localhost:5173/garage/
```

| File | What it owns |
|---|---|
| `garage/index.html` | the page and its panel |
| `src/garage/garage.js` | the app: the stand, both cameras, the brush, history, save |
| `src/util/paint.js` | skins: the codec, the 3D texture, the brush, `stampPaintPos`, the shader patch |
| `src/geometry/skins.js` | the shipped skins, one per vehicle type, and their live reload |
| `assets/skins/*.json` | the skins themselves — data, committed like any other asset |
| `vite.config.js` | `garageSave()`, the dev-server endpoint Save writes through |
| `tools/garage.mjs` | the headless checks, in `npm run check` |

Only the taxi so far.

## Paint in space, not on faces

There are no UVs anywhere in this project, and the garage does not add any. A skin is a small RGBA
**volume** over the vehicle's bounding box, in the vehicle's own unscaled frame — the taxi's is
64×42×36 voxels of 1/16 unit. The fragment shader reads the voxel at the fragment's position on the
car, so anything that sits in a painted voxel takes its paint.

That is chosen over a texture atlas because every mesh here is generated in code, and code changes.
An atlas keyed to a box's faces tears the moment the box is resized; a volume keyed to space does
not care. Change the taxi's proportions and the paint stays where it was put. The **bounds live in
the skin file**, not in the code, for the same reason.

Three consequences worth knowing:

- **Paint is looked up by rest position.** The doors, bonnet and boot are meshes on hinges; reading
  the volume at the live position would leave the paint standing in the air as a door swings out
  from under it. Every painted vertex carries `paintPos` — where it sits with every hinge shut,
  stamped by `stampPaintPos` at construction — and that is what the shader samples. Paint on the
  flank of a shut car is on the door when it opens. `tools/garage.mjs` checks this against the live
  transforms, because a stamping slip opens the door bare with nothing logged.
- **The sample is sunk a quarter voxel inside the surface** (`SURFACE_SINK`). The taxi's roof is at
  y = 1.5, a whole number of voxels off the skin's floor, so without it every fragment on the roof
  floored into one cell or the next on float noise and paint across it speckled.
- **A brush is a ball, not a decal.** It paints every voxel within its radius, so a big brush on the
  flank also catches the top of a tyre or the edge of the stripe beside it. Shrink the brush near a
  seam. The door's *glass* is the one place that cuts the other way: it stands 0.23 units off the
  cabin's side window, further than a brush reaches across, so paint on the window does not carry
  onto it. Paint it with the door open.

What reads paint on the taxi: the shell (body, cabin, stripe, rear wheels), both steered wheels, the
door skins, the boot lid and the bonnet. What does not: the **roof sign**, whose colour is a state
(lit means a rider aboard); the lamps; and the bumper and dark openings that only show when the car
is damaged.

### What paint does to the colour

Paint replaces the **vertex colour** and keeps the material colour — `diffuseColor = diffuse * ink`,
injected after `<color_fragment>`. So the wreck's scorch (a multiply on `material.color`) and the
highlight's emissive lift still reach a painted panel, and everything downstream — lighting, AO,
Crayon and Cartoon — sees an ordinary diffuse colour. Colours are stored as the sRGB bytes the
picker hands over and linearised in the shader.

The alpha byte is a **mode**, not an opacity: bare, *tinted* or *fixed*. Tinted multiplies by the
instance colour; fixed ignores it. For the taxi the two are the same thing and the garage only
paints fixed. They exist for the fleets: ambient cars are built white and coloured per car through
`instanceColor`, so one car skin can carry body shading that every car's own colour shows through
(tinted) alongside chrome and stripes that are the same on all of them (fixed).

## The two cameras

**Orbit** is for painting. **Game camera** is for judging: the game's own orthographic camera at
`PLAY_ZOOM`, with the zoom slider reporting how many pixels a world unit comes to on this screen.
At play zoom that is about 7.7px, the taxi is about thirty pixels long and a voxel is under one —
so detail that reads beautifully in the orbit view can be nothing at all in the game. Check there
before believing a paint job. Painting works under either camera; under the game camera a drag off
the car turns it.

The stand uses the game's sun, sky and materials — `createScene` and `createDaylight`, with the
shadow frustum pulled in to the car — and an hour slider. It does not run SSAO, bloom or the two
look modes; check those in the game.

## Saving

**Save** posts the skin to `/__garage/save/<name>`, which the dev server writes over
`assets/skins/<name>.json` (`garageSave()` in `vite.config.js`). It only overwrites skins that
already exist, and checks the body is shaped like one first. The dev server's file watcher then
hands the new skin to **every open page**: `geometry/skins.js` accepts the update and reloads the
volume in place, so a game tab open beside the garage repaints its taxi with no reload and no lost
run. The garage ignores its own save echoing back (`skin.saved`), or a stroke made in the instant
between the two would be painted over.

A built bundle has nothing to write through, so there Save downloads the file instead, to drop over
`assets/skins/` by hand. **Download** does that anywhere.

## File format

```json
{ "version": 1, "min": [-2, -0.125, -1.125], "voxel": 0.0625, "dims": [64, 42, 36], "data": "…" }
```

`data` is the volume run-length coded over whole voxels — `[count, rgba]` uint32 pairs — and
base64'd. A bare skin is one run (12 characters); a liveried car is a few kB.

## Adding a vehicle type

1. A blank skin: `blankSkin(min, max, voxel)` from `util/paint.js`, written to
   `assets/skins/<name>.json`. Size the bounds with some margin; they never need to change again.
2. Register it in `geometry/skins.js`, including the `import.meta.hot.accept` for live reload.
3. At the vehicle's construction site: `propMaterial({ paint: getSkin(name) })` on every part that
   should take paint, and `stampPaintPos(geometry, offset)` on its geometry, where `offset` is the
   part's position on the vehicle with every hinge shut. Instanced meshes need nothing more — every
   instance reads the same volume in its own frame.
4. Point the garage at it (it is hard-wired to the taxi today) and extend `tools/garage.mjs`.

Buildings are a different problem. A landmark with a fixed shape (the bank, the garage, the burger
joint) works exactly like a vehicle. Ordinary buildings come out of the generator at a different
size every seed and are merged into one mesh in world space, so there is no fixed object to paint;
those want repeating painted *tiles* applied by surface type, which is a different tool.
