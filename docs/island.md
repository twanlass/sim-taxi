# The island

The city stands on an island: past the ring road a walk, a grassy verge and a coast of beaches and
cliffs, ocean out to the horizon on the west, south and east, and a forested mountain with a snowy
peak to the north. Tyler's brief, 2026-10-13, with a painted reference: "this is a island or
peninsula surrounded by ocean on 3 sides". `?island=classic` (or `ISLAND=classic` for the headless
tools) keeps the old floating slab with its faded asphalt edge.

| File | Owns |
|---|---|
| `src/city/coast.js` | The pad, the coast, the mountain and `landHeight` — one height field for everything outside the city |
| `src/city/terrain.js` | The terrain and ocean meshes, the trees and rocks, the tunnel portals |
| `src/city/railpath.js` | Where the L train runs on the island, and the cuttings it digs |
| `src/city/shore.js` | The dock sheds, the south shore row and the lighthouse |
| `src/game/peakmist.js` | The collar of cloud round the peak |
| `src/city/riverwater.js` | `patchOceanWater`, the ocean's shader |

## One height field

Everything outside the **pad** (the city out to the far side of the walk round the ring road) is
`landHeight(x, z)`, and the coast is wherever that crosses `SEA_Y` (−2, the river's own level). The
terrain mesh draws every grid cell with land above the sea in it and the ocean mesh every cell with
sea, on the same grid, so the shoreline is where two meshes meet rather than a line either draws.
An outline drawn as a polygon would need the terrain, the ocean, the beach colours and the foam
each to agree with it; a contour of one function cannot disagree with itself.

- `coastDistance` is a signed distance (positive on land): an offset of each pad edge wobbled by a
  sum of sines, smooth-minned round the corners, with the river's mouths cut through and the
  lighthouse's rock (`islet`) added. No north coast: the land runs on into the mountain.
- `beachiness` decides beach or cliff in long stretches; the drop to the waterline runs over 7
  units on a beach and 1.8 on a cliff.
- `mountainLift` is two Gaussians and ridged noise, laid down to nothing at the pad's north walk.
- The ocean carries each vertex's depth (`seaDepth`) and its shader synthesises the seabed,
  turquoise shallows and surf from that. Opaque, so no sorting.

Pure and rng-free: the island is the same shape for every city with the same roads, and nothing
about it can reshuffle another generator's stream.

**The walk's body reaches down to −3.** Wherever the coast comes in close (the river's mouths, the
harbor's corners) the land drops away from the walk's outer face, and a kerb 0.35 deep left a slot
of sky under it. Where the verge is level with the walk, the extra face is behind the ground.

## The L train on the island

Tyler picked "both into mountain" on the decision card: the line leaves each end of the arterial on
a banked bend (radius 7.5, about Chicago's own Loop corners at this scale), runs north along the
west shore and up the harbor's waterfront, and goes into the mountain through a stone portal.

- The path is in `city/railpath.js` because the ground has to know about it: the approach to each
  portal is a **cutting** (`railCut`), whose sides climb at 0.75 per unit, shallower than the
  view's 0.92 rise, or the side nearer the camera hides the portal.
- The cutting carries on `PORTAL_DEPTH` behind the portal's face. The terrain is a 2.5-unit grid,
  so a cutting that stopped at the face left its last cell rising up the face it was meant to show.
- Past each face the train and deck are discarded in their own shader (`uLPortal` in
  game/ltrain.js), so the mouth only has to read as a hole.
- Every car is its own mesh following the curve, with yaw then roll (`BODY_EULER_ORDER`).

## Performance

Measured with `tools/perf.mjs` (counts, not times): +7 draws and +67k triangles a frame in the main
pass, +33k in the shadow pass, against the slab. The ocean replaces the sky behind the city with a
shaded surface, so its real cost is fill rate on a phone: bench it there (`?bench`) before
treating that as settled.
