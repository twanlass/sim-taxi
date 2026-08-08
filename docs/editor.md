# The level editor

`editor.html`, `src/editor.js`, `src/city/level.js`.

Open `/editor.html`, draw roads, hit **▶ Play this level**.

## What you edit

Two things, and only two:

- **Where the roads are.** Drag between two neighbouring junctions to lay one; drag along an
  existing road to take it out.
- **What each block is.** Park or built, and which roads are main streets.

Everything else is *derived* on every edit — lanes, turn arcs, which junctions carry lights, what
each signal's phases are, and the shape of every block. There is nothing in the editor that places a
lane or times a light, because [the road network](roadnet.md) computes all of it from the graph. An
editor that made you author signal timing per junction would be unusable; this one only has to ask
where the roads go.

That is also why removing one road does so much: the two blocks either side **merge**, the buildings
re-lay across the new footprint, the junctions at each end drop an arm, their phase plans shrink,
and any junction left with only a straight-through loses its light entirely.

## The level format

```jsonc
{
  "version": 1,
  "nodes": [{ "id": "2,3", "x": -10, "z": 10, "gi": 2, "gj": 3 }],
  "edges": [{ "id": "2,3-3,3", "a": "2,3", "b": "3,3", "klass": "side", "wave": 0 }],
  "blocks": { "0,0|0,1|1,0|1,1": { "type": "park" } }
}
```

**Only authored data is stored.** No lane geometry, no phase tables, no block polygons — those are
re-derived by `bakeNetwork` on load, which is what stops a saved level going stale the moment the
derivation improves.

A block is named by **the sorted ring of junctions around it**, not by an index. Face indices
renumber the moment an edge is added anywhere in the city, so an index would silently repaint the
wrong block; the ring survives any edit that doesn't touch that particular face. `tools/level.mjs`
asserts exactly that.

Two things are deliberately *not* in the file:

- **Closures.** A closed road is simply an edge the level doesn't have. `cityFromLevel` derives the
  grid's closed-segment set from what's missing, which is what keeps `grid.js` answering correctly
  for a lattice-aligned level.
- **Arterials.** Read back off the edges that carry `klass: 'arterial'` rather than stored twice and
  allowed to disagree.

## Playing one

**▶ Play** saves to localStorage and opens `/?level=local&tutorial=off`. The intro is off because the
editor's loop is draw, play, tweak, play, and the opening bubbles replay on every load — somebody
testing their own city already knows which car is theirs. The seed still decides the buildings and
the trees — a level authors the *plan*, not the skyline — so the same level looks different under a
different `?seed=`.

**Export** copies the JSON to the clipboard (or downloads it, if the clipboard needs a permission the
page doesn't have). **Import** takes it back.

## Is it drivable?

The status readout is not decoration. The fare loop depends on `findRoute` never returning null, so
a level with a corner you can't reach from everywhere would hand the player a destination the taxi
cannot get to, and the fare would quietly time out.

`isNetworkConnected` asks the **road network**, not the lattice — every lane must be able to reach
every junction traffic can arrive at. `isCityConnected` in `grid.js` asks the same question of all 36
lattice positions whether or not a road reaches them, so it calls any level with a bare corner
undrivable when the roads that exist are perfectly well connected. The two agree on every generated
city, verified over 300 seeds.

A junction nothing connects to is **dropped from the city** rather than left stranded: it isn't
unreachable, it isn't there. It also stops being offered as a fare destination.

## Two entry points

`vite.config.js` names both `index.html` and `editor.html`. Supplying `rollupOptions.input` *replaces*
vite's default input rather than adding to it, so listing only the editor would build a `dist/` with
no game in it — and that failure looks like a deploy problem rather than a config one.

The editor is a separate entry rather than a mode inside `main.js` because the game's boot is a
one-shot top-level script that starts traffic, fares and police, and none of that belongs behind an
`if (editing)`.

## What it can't do yet

**Junctions are locked to the lattice.** The model handles a diagonal — `tools/level.mjs` bakes one
and asserts it splits the city into two faces with a three-arm junction — but the game around it does
not yet. `route.js` returns a list of grid *directions*, `traffic.js` stores `car.d`, and `fares.js`
spawns riders at `(i, j)` with block-distance arithmetic. Until those three speak lanes and nodes, a
junction off the lattice has no `(i, j)` for them to use.

`net.dirOfLane` and `attachGridView` in `roadnet.js` are the single place that view is derived, so
they are also the single thing to delete when it goes.

**Dragging a junction**, arcs and roundabouts all wait on the same change.
