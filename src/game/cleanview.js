// Clean view — the city with the game taken off it, for looking at the road while painting it.
//
// The road paint's "Road only" and the inspect freeze (game/inspect.js) both turn it on, and it
// stays on while either holds it. It hides two things:
//
// - **The page.** Every overlay on `body` but the canvas, the ⚙️ panel and its toggle, and the 📱
//   frame — the HUD, the pedals, the finders, the coach, the speech. `visibility` rather than
//   `display` (index.html, `body.clean-view`), so nothing re-lays itself out and the viewport probe
//   still measures (util/viewport.js); `!important` because a few HUD parts (the boost flame's
//   frames) animate their own visibility and an animation outranks a plain declaration.
// - **The effects in the world.** Whatever was added to the scene inside `tagFx` — skid marks,
//   spray, dust, sparks, the route band, the fare markers and so on. Meshes only, never a group,
//   and never anything carrying a light: a light under a hidden subtree drops out of the light
//   count and recompiles every lit program in the city (CLAUDE.md). The cop lights are lights and
//   so stay; with the loop frozen they are not flashing anyway.
//
// Hidden meshes are put back exactly as they were. Under the freeze nothing runs to flip them back
// on in between; under Road only (not frozen) the effects are already hidden by the road paint,
// which is why `set` must run *before* the road paint hides the rest on the way in — what is
// recorded here is then not recorded there, so leaving Road only while frozen leaves them hidden.

const FX = 'cleanFx';

/** Run `make` and mark everything it adds to `scene` as an effect the clean view hides. */
export function tagFx(scene, make) {
  const before = new Set(scene.children);
  const result = make();
  for (const child of scene.children) if (!before.has(child)) child.userData[FX] = true;
  return result;
}

export function createCleanView(scene) {
  const holds = new Set();
  let hidden = null;

  function apply(on) {
    if (on === Boolean(hidden)) return;
    document.body.classList.toggle('clean-view', on);
    if (on) {
      hidden = [];
      for (const root of scene.children) {
        if (!root.userData[FX]) continue;
        root.traverse((o) => {
          if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.visible) return;
          let lit = false;
          o.traverse((c) => { if (c.isLight) lit = true; });
          if (lit) return;
          o.visible = false;
          hidden.push(o);
        });
      }
    } else {
      for (const o of hidden) o.visible = true;
      hidden = null;
    }
  }

  return {
    /** `reason` holds the clean view on (or lets go of it); on while any reason holds it. */
    set(reason, on) {
      if (on) holds.add(reason); else holds.delete(reason);
      apply(holds.size > 0);
    },
    on: () => Boolean(hidden),
  };
}
