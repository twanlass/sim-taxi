# The level editor

Phase 1: hand-authoring the map on the existing 5×5 grid. Non-rectilinear roads, rivers and
bridges are Phase 2 — the road graph itself doesn't change here. What does change is that the
layout can now come from a JSON file instead of a procedural seed, and there's a paint tool for
building one.

## Opening it

The **Edit** button in the top-right corner opens the editor from any interactive session (it
hides in `?shot=` runs — screenshots have no user). While it's open the sim pauses and the game
HUD hides; the city geometry is what you're editing around, so it stays visible.

## Tools

- **Buildings / Park / Plaza** — paint the block under the cursor. Painting a park adjacent to
  another park automatically pairs them into a district and closes the road between them, matching
  what the procedural generator does. Painting anything else over one member of a district breaks
  the pairing and reopens that road.
- **Close road** — toggle a road segment closed. Cars route around it, the router plans around it
  for free — exactly the same `setClosedSegments` path the procedural generator uses.
- **Arterial** — click a road segment to make its whole line an arterial (green wave, larger
  signal share, solid double centre line). Click again to flip the coordinated direction. Click
  once more to remove.
- **Taxi start** — pin the taxi's spawn intersection and heading. Each click rotates through the
  four cardinal directions and then clears the pin.

`Ctrl+Z` / `Cmd+Z` undoes the last edit.

## Playing your level

**▶ Play** serialises the current state to `sessionStorage` and reloads with `?level=session`.
That means the city, sim and taxi are all built by the normal boot path — there's no in-place
rebuild — which is the whole reason the round-trip route exists. Any `?seed=` / `?run=` / `?cars=`
in the URL is preserved; `?shot=` is dropped.

**Export** dumps the JSON into the text area for copying. **Import** takes JSON from the same
box. **Copy URL** builds a self-contained `?level=raw:<base64url>` link, which is how you share
without a backend — the whole level rides in the query string.

## JSON format

```json
{
  "version": 1,
  "grid": 5,
  "blocks": [
    { "bi": 2, "bj": 3, "type": "park", "districtId": 0 },
    { "bi": 3, "bj": 3, "type": "park", "districtId": 0 },
    { "bi": 0, "bj": 4, "type": "plaza" }
  ],
  "closed": ["3,3|3,4"],
  "arterials": {
    "x": [2],
    "z": [3],
    "dirX": { "2": 1 },
    "dirZ": { "3": -1 }
  },
  "taxiStart": { "i": 2, "j": 2, "d": 0 }
}
```

- `blocks` only lists non-default cells. A block that isn't in the list is a plain built block
  with no district. `type` is one of `built`, `park`, `plaza`.
- `districtId` groups exactly two adjacent park cells into a district — the pair is one merged
  green mass with the road between them closed. Lone parks omit it.
- `closed` uses `src/city/grid.js:segmentKey`, the same string the sim uses.
- `arterials.x` / `arterials.z` are line indices (`j` for X-running roads, `i` for Z-running
  roads); `dirX` / `dirZ` map the line to +1 or −1, the coordinated direction of travel.
- `taxiStart` is optional. When omitted the taxi spawns wherever the run seed puts it.

The format's version is checked at load time; a mismatch or a shape error is logged and the game
falls back to the procedural generator so a broken shareable URL never soft-locks the page.

## What it doesn't do (yet)

- **No new roads.** Streets still live on the 5×5 grid; you can only open and close the segments
  that grid already implies.
- **Larger park districts.** Districts are pairs of blocks; the routing invariants only guarantee
  connectivity under that rule.
- **Fare seeding.** The passenger spawn pool is still `runSeed`-driven — the JSON has room for a
  `fareSeeds` field, but nothing reads it. That lands with Phase 1.5 or Phase 2, whichever hits
  first.

## Files

| File | Role |
|---|---|
| `src/editor/editor.js` | Toolbar DOM, tool state, picker, import/export/play actions |
| `src/editor/overlay.js` | Invisible pick planes + visible hover, closure X, arterial arrows, taxi pin |
| `src/city/level.js` | Schema validation, serialize/deserialize, URL-safe base64 codec |
| `src/city/layout.js` | `proceduralLayout` (unchanged behaviour) and `layoutFromLevel` — both emit the same block-array shape |
| `src/util/shot.js` | `getLevel()` reads `?level=session` or `?level=raw:...` at boot |
| `src/sim/traffic.js` | Optional `taxiStart` parameter to `createTraffic` |
