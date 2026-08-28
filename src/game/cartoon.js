import * as THREE from 'three';
import { PALETTE, color } from '../palette.js';
import { unlitMaterial, CARTOON_UNIFORMS } from '../util/geo.js';
import { ghostMaskMaterial, GHOST_REF } from '../geometry/ghostoutline.js';

/**
 * Cartoon Mode — cel-banded light, ink on every edge in the city, and a **thicker** ink around the
 * things the player has to track.
 *
 * Two mechanisms, because the two jobs are genuinely different:
 *
 *   1. **The world's ink is screen-space.** `game/ssao.js` writes a depth edge into the green
 *      channel of its half-res texture and `util/geo.js` inks it into every lit material. That
 *      catches interior creases as well as silhouettes — a building's setback, a kerb, the fold
 *      of a roof — which no hull can, and it costs one fetch on a texture the material is already
 *      sampling.
 *   2. **A hero's ink is an inverted hull.** A screen-space line can only paint on the pixels of
 *      the thing it is outlining, because that is the only place a lit material runs — so it eats
 *      *inward*. On a car 24px wide at play zoom, a line thick enough to pull it off the road eats
 *      a fifth of the car. An inflated back-face hull draws *outward*, which is what a cartoon
 *      outline actually is, and it takes its thickness per object rather than per screen.
 *
 * So the taxi, the ambient cars, the trucks and the cruiser wear hulls; the city wears the
 * screen-space line; and the difference in weight between them is the whole point — a hero reads
 * as a hero because its outline is half again everything else's.
 *
 * `?cartoon`, independent of `?crayon`. Both on at once is two inks over one frame; nothing breaks
 * and nobody should want it.
 */

// Hull thickness in world units, and the numbers are the feature.
//
// At play zoom 1 world unit is about 7.7px and the city's screen-space line is one texel of a
// half-res buffer — one CSS pixel. So `HERO_RIM` draws about 1.7px, a bit over one and a half
// times the world's line, and that ratio is what the eye reads as "this one matters". Under about
// 1.5x the two weights look like one line drawn unevenly.
//
// The ceiling is what a *car* can carry, not what looks bold in isolation. An ambient car is 1.8
// units across and about 24px at play zoom, so every 0.1 of rim spends 8% of its width: at 0.30 a
// third of the car is ink and the paint that says which car it is has gone. That is the whole
// distance between "outlined" and "blacked out", and it is only two tenths wide.
//
// The taxi gets more, and then rides the taxi group's own TAXI_SCALE of 1.18 on top, so it lands
// at 0.35 world units — about 2.7px, half again the traffic's. It is the one object on the board
// that is *the player*.
export const HERO_RIM = 0.22;
export const TAXI_RIM = 0.30;

// The most of a part's own smallest dimension an outline may ever be.
//
// A backstop rather than a working part of the look, now that `outlineRoot` picks one body per
// vehicle: a body is never small enough for this to bind, and the taxi's shell keeps the full 0.30.
// It is here because a rim stated in world units is a fraction of a body and a *multiple* of a
// small part, and the moment anything asks for an outline on something slimmer than a car it would
// double it rather than trace it — the taxi's roof sign is 0.34 units tall, and this caps it at
// 0.12. `addGhostOutline` carries a hand-tuned second rim for exactly that case; this derives it.
const MAX_RIM_FRACTION = 0.35;

/** Ink is paint, never a target: the picker has to see straight through it. */
const noRaycast = () => {};

const OUTLINE_NAME = 'toonOutline';
const MASK_NAME = 'toonOutlineMask';

// Two tiers, and they sit *below* the ghost outline's four (9990-9993) rather than among them.
//
// The stencil buffer is never cleared mid-frame, so order is the whole contract. These stamp and
// resolve first, against nothing but their own masks; the ghost tiers then stamp their own — a
// superset, since a ghost masks every part of a vehicle where this masks only its body — and
// resolve exactly as they did before this existed.
const TOON_MASK_ORDER = 9980;
const TOON_RIM_ORDER = 9981;

/**
 * The rim's material, and **the stencil test is not an optimisation — it is the whole reason this
 * works at all.**
 *
 * A hull inflated by scaling is not an offset surface, and the taxi shell is not convex. Scale the
 * whole merged body about its bounding-box centre and the *cabin* grows too, so the hull cabin's
 * rear wall ends up standing over the real boot — higher than it, therefore nearer the camera,
 * therefore passing an ordinary depth test and painting the boot black. Measured on the shipped
 * taxi: the hood and the boot both went solid, leaving yellow only in curved slivers around the
 * wheel arches, which reads as a black brick with the paint showing through the cracks.
 *
 * So the rim is masked out of the silhouette it belongs to, exactly the way
 * `geometry/ghostoutline.js` masks its own: pass 1 stamps the body's screen footprint into the
 * stencil, pass 2 draws the hull with a "not that footprint" test, and what is left is the part of
 * the hull that sticks out *past* the car. Which is what a cartoon outline is.
 *
 * Two differences from the ghost's rim, both deliberate:
 *
 *   - **An ordinary depth test.** The ghost draws only where something is in *front* of the hull,
 *     because it is a see-through-walls signal. This one is ink on a visible car and has to be
 *     hidden by the tower the car drives behind.
 *   - **Fogged, unusually for an unlit material.** `unlitMaterial()` turns the haze off because a
 *     marker's hue is its content, and a marker mixed toward the sky reports the wrong clock. An
 *     outline is the opposite kind of object — it is part of the drawing of the city, so it sits
 *     behind the same air as the car it wraps. Left unfogged, the back of the board becomes a mass
 *     of hard black over hazed pale buildings, which is the depth cue running backwards.
 */
export function toonOutlineMaterial({ rim = HERO_RIM, floorY = 0 } = {}) {
  const material = unlitMaterial({
    color: color('toonInk'),
    side: THREE.BackSide,
    fog: true,
    // Queue placement only, never blended at opacity 1: the depth buffer has to be complete and the
    // masks stamped before any of this runs, and three draws the transparent queue after every
    // opaque object regardless of renderOrder. It also means the ⚙️ panel's opacity slider works
    // without the material having to be rebuilt when it leaves 1.
    transparent: true,
    opacity: 1,
    depthWrite: false,
    stencilWrite: true,                     // enables the test; every op stays Keep
    stencilRef: GHOST_REF,
    stencilFunc: THREE.NotEqualStencilFunc,
  });

  // Per material, not shared: the taxi's rim and the traffic's are two different numbers, and the
  // floor is a property of the part being wrapped. `createCartoon` writes them by group.
  material.userData.toon = {
    uToonRim: { value: rim },
    uToonFloorY: { value: floorY },
  };

  // Mandatory, and this material is the exact case the rule exists for: it is a plain
  // `MeshBasicMaterial` in a project full of them, and three builds the program cache key from a
  // material's *parameters* before `onBeforeCompile` runs. Without a key of its own an outline hull
  // is handed whichever unpatched basic material compiled first — and then draws at rim zero,
  // invisible, with nothing logged.
  material.customProgramCacheKey = () => 'toon-outline';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.toon);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aInflate;
uniform float uToonRim;
uniform float uToonFloorY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${OUTLINE_VERTEX}`);
  };

  return material;
}

/** A rim this part can carry — see MAX_RIM_FRACTION. */
export function clampRim(geometry, rim) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  return Math.min(rim, Math.min(size.x, size.y, size.z) * MAX_RIM_FRACTION);
}

// How far the hull's underside is pulled back up after inflation, above the part's own base. The
// same 0.15 `geometry/ghostoutline.js` uses and for the same reason it records: inflating downward
// as well pushes the hull under the road, the road then counts as something in front of it, and a
// fully visible car wears a permanent smear at its bumper.
const FLOOR_MARGIN = 0.15;

/**
 * The hull's geometry — **the same shape `inflatedGeometry` bakes, but left un-inflated with the
 * offset carried in an attribute instead**, so the rim can be a uniform.
 *
 * That is the whole reason this exists rather than calling `inflatedGeometry`. A rim baked into
 * vertices is a rim you cannot scrub: moving it means rebuilding a geometry per hull, per frame,
 * while a slider is being dragged. And the thickness of an outline is the one number here nobody
 * can settle from a still — it is a judgement about how hard a car should shout against a city,
 * which needs the game running and a hand on a slider.
 *
 * The offset is exact rather than approximate. `inflatedGeometry` scales per axis about the
 * bounding-box centre, so a vertex lands at `p + (p - centre) * 2r / size` — linear in `r`. Baking
 * `2 * (p - centre) / size` per vertex therefore reproduces it exactly for *any* rim, at one
 * multiply-add in the vertex shader.
 *
 * **Not normals.** Every mesh here is non-indexed and flat-shaded, so a shared corner is several
 * vertices carrying several normals, and offsetting along them tears the hull open at every hard
 * edge. This direction is continuous across a corner because it is a function of position alone —
 * the same argument `jitterVertices` makes about keying on position rather than index.
 */
export function outlineGeometry(source) {
  // Cloned, never modified in place: for the ambient fleet this is the geometry traffic is drawing
  // from, live on an InstancedMesh, and `setAttribute` on it is the trap `game/carghosts.js` names.
  const geometry = source.clone();
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox.getCenter(new THREE.Vector3());
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const baseY = geometry.boundingBox.min.y;

  const position = geometry.attributes.position;
  const offsets = new Float32Array(position.count * 3);
  for (let v = 0; v < position.count; v += 1) {
    offsets[v * 3] = size.x > 0 ? (2 * (position.getX(v) - centre.x)) / size.x : 0;
    offsets[v * 3 + 1] = size.y > 0 ? (2 * (position.getY(v) - centre.y)) / size.y : 0;
    offsets[v * 3 + 2] = size.z > 0 ? (2 * (position.getZ(v) - centre.z)) / size.z : 0;
  }
  geometry.setAttribute('aInflate', new THREE.BufferAttribute(offsets, 3));

  // What a rim on this part may never exceed, and where its underside stops. Carried on the
  // geometry so a live rim can be clamped against the part it is actually wrapping rather than
  // against whatever the caller last asked for.
  geometry.userData.maxRim = Math.min(size.x, size.y, size.z) * MAX_RIM_FRACTION;
  geometry.userData.floorY = baseY + FLOOR_MARGIN;
  return geometry;
}

// Offset applied in the vertex shader, so `uToonRim` is a live number rather than a rebuild.
//
// The floor clamp runs *after* the offset, exactly as the baked version clamps after its scale.
const OUTLINE_VERTEX = /* glsl */ `
	transformed += aInflate * uToonRim;
	transformed.y = max(transformed.y, uToonFloorY);
`;

/**
 * Hang an outline off one mesh, as a child, so it inherits steering, bounce and roll for free —
 * the same way `addGhostOutline` does, and sharing that file's `inflatedGeometry`.
 *
 * That inflation scales about the geometry's own bounding-box centre rather than extruding along
 * normals, which matters more here than it does there: every mesh in this project is non-indexed
 * and flat-shaded, so a shared corner is several vertices with several normals, and extruding
 * along them tears the hull open at every hard edge. Scaling keeps it closed. It also clamps the
 * underside back above the part's own base, so a hull never dips through the road.
 */
export function addToonOutline(mesh, { rim = HERO_RIM } = {}) {
  // Pass 1 — the body's own screen footprint, stamped into the stencil. Shares the parent's
  // geometry rather than a copy: the mask has to match the silhouette exactly or slivers of rim
  // leak back inside it.
  const mask = new THREE.Mesh(mesh.geometry, ghostMaskMaterial());
  mask.name = MASK_NAME;
  mask.renderOrder = TOON_MASK_ORDER;
  mask.raycast = noRaycast;
  mask.castShadow = false;
  mesh.add(mask);

  // Pass 2 — the ink.
  const geometry = outlineGeometry(mesh.geometry);
  const hull = new THREE.Mesh(geometry, toonOutlineMaterial({
    rim: Math.min(rim, geometry.userData.maxRim),
    floorY: geometry.userData.floorY,
  }));
  hull.name = OUTLINE_NAME;
  hull.renderOrder = TOON_RIM_ORDER;
  hull.raycast = noRaycast;
  // No shadow. The hull is a bigger copy of a mesh that already casts one, so inheriting it would
  // fatten every shadow in the city by the outline's own width.
  hull.castShadow = false;
  hull.receiveShadow = false;
  mesh.add(hull);

  return { mask, hull };
}

/**
 * Whether a mesh could carry an outline: solid, colour-writing and **lit**.
 *
 * The same shape as `markOccluder`'s rule and for the same reason. Everything that fails it would
 * get a hull around something with no silhouette to trace — the taxi's invisible raycast box, the
 * ghost outline's own mask and rim, the unlit siren lamps on the cruiser's roof.
 */
function outlinable(object) {
  const material = object.material;
  if (!object.isMesh || !material) return false;
  if (object.name === OUTLINE_NAME) return false;
  if (material.transparent || material.visible === false || material.colorWrite === false) {
    return false;
  }
  // Lit only. A `MeshBasicMaterial` in this project is a marker, a lamp or a road decal — none of
  // them a thing in the world with a shape.
  return Boolean(material.isMeshLambertMaterial);
}

/** Bounding-box volume, the measure `outlineRoot` picks a vehicle's body by. */
function bulk(geometry) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  return size.x * size.y * size.z;
}

/**
 * Outline a vehicle: **one hull, on its body, and not one per part.**
 *
 * Outlining every part separately is the obvious thing and it is wrong, in a way that only shows
 * up on the screen. A cartoon outlines an *object*; its interior part boundaries are the thin
 * screen-space line's job. Worse, a rim stated in world units is a fraction of a body and a
 * multiple of a trim strip: the taxi carries two 3.46 x 0.54 x 0.54 bars down its flanks, and a
 * hull around each of those inflates the thin axes by two thirds and lays a black bar the whole
 * length of the car on both sides. Eight hulls on one taxi came out as a black brick with yellow
 * showing through the gaps between them.
 *
 * So: the biggest solid lit mesh under `root`, by bounding-box volume, and nothing else. On the
 * taxi that is the shell at 13.5 cubic units against 1.0 for a bar and 0.85 for a wheel — not
 * close — and on the cruiser it is the merged body. The wheels then sit *inside* the body's hull
 * on every axis but a sliver under the front valance, which `game/carghosts.js` measured at ~0.4
 * units against a rim that is itself about 2px.
 *
 * **Call this after `markOccluder`.** A hull is an opaque colour-writing mesh, so the prepass would
 * happily enrol one — and a hull in the depth prepass stamps a silhouette a rim bigger than the
 * car, which would leave the city's own screen-space line tracing the outline instead of the
 * vehicle.
 */
export function outlineRoot(root, { rim = HERO_RIM } = {}) {
  let body = null;
  root.traverse((object) => {
    if (!outlinable(object)) return;
    if (!body || bulk(object.geometry) > bulk(body.geometry)) body = object;
  });
  return body ? [addToonOutline(body, { rim })] : [];
}

/**
 * The instanced variant: a mask pool and a rim pool that **share the source's own instance
 * matrices**.
 *
 * Not copies, the same `InstancedBufferAttribute` object. Traffic writes every car's transform
 * into it once a frame and three uploads a buffer per attribute rather than per mesh — so the whole
 * fleet outlines for two extra draw calls and zero per-frame matrix work. Copying instead would
 * mean walking every car every frame to duplicate a matrix that already exists, and a copy that
 * fell a frame behind would show as ink sliding off the cars.
 *
 * The mask shares the source *geometry* as well, for the reason the per-mesh pass does: a mask that
 * is not the silhouette exactly lets rim leak back inside it.
 */
export function instancedOutline(source, { rim = HERO_RIM } = {}) {
  const capacity = source.instanceMatrix.count;

  const mask = new THREE.InstancedMesh(source.geometry, ghostMaskMaterial(), capacity);
  mask.name = `${source.name}OutlineMask`;
  mask.renderOrder = TOON_MASK_ORDER;

  const geometry = outlineGeometry(source.geometry);
  const hull = new THREE.InstancedMesh(geometry, toonOutlineMaterial({
    rim: Math.min(rim, geometry.userData.maxRim),
    floorY: geometry.userData.floorY,
  }), capacity);
  hull.name = `${source.name}Outline`;
  hull.renderOrder = TOON_RIM_ORDER;

  for (const pooled of [mask, hull]) {
    pooled.instanceMatrix = source.instanceMatrix;
    pooled.raycast = noRaycast;
    // Deliberately no shadow, unlike the traffic mesh these borrow their transforms from:
    // inheriting it would fatten every car's shadow by the outline and stamp a second one from the
    // mask.
    pooled.castShadow = false;
    // Three computes an InstancedMesh's bounding sphere once, on the first frame it culls it, from
    // the matrices as they stood then — and never again. The traffic pools this shadows all turn
    // culling off for that reason, and these two must agree with each other as well as with it: a
    // rim that survived a frame its mask was culled on is a *filled* silhouette, not an outline.
    pooled.frustumCulled = false;
    pooled.count = source.count;
  }

  return { mask, hull, source };
}

// Every method is a no-op that returns something the caller can use without a guard — except
// `fleet`, which cannot: its whole return value is a mesh for the caller to add to the scene, and
// `scene.add(null)` is a console warning on every load of a game with this mode switched off. So
// callers gate the hero block on the flag, and this throws rather than pretending.
const DISABLED = {
  state: { enabled: false },
  outline: () => [],
  fleet: () => { throw new Error('cartoon.fleet() with Cartoon Mode off — gate on the flag'); },
  update: () => {},
  set: () => {},
  dispose: () => {},
};

/** Live tuning, all of it on the ⚙️ panel. */
export const CARTOON_DEFAULTS = {
  // The two hull rims, in world units, and the only two numbers here that are not a uniform on a
  // material somewhere — they ride `uToonRim`, one value per hull group. See `outlineGeometry` for
  // why they are live at all.
  taxiRim: TAXI_RIM,
  heroRim: HERO_RIM,
  // The ink itself, shared by the hulls and the city's screen-space line so the two can never drift
  // into being two different blacks.
  ink: 0.85,
  // Read from the palette rather than repeated here: one source of truth for the colour, and the
  // panel's picker starts on whatever `palette.js` currently says the ink is.
  inkColor: PALETTE.toonInk,
  inkOpacity: 1,
  // How far the direct term is pushed onto its bands. 1 is fully cel-shaded.
  cel: 1,
  // How many bands. Three is the classic — light, mid, shadow — and it is also about where this
  // city's own lighting lands: the sun's contribution runs 0 to about 1.13 of the albedo once the
  // Lambert reciprocal-pi and the 3.55 intensity are multiplied out, so three steps put a band
  // edge right across the middle of a lit facade.
  steps: 3,
  // Where the city's edge starts taking ink. Higher is a harder, more selective line — a cartoon
  // wants fewer, more confident lines than a drawing does, so this sits well above crayon's, which
  // takes everything it can find.
  bite: 0.42,
};

/**
 * @param enabled  false leaves every method a no-op and builds nothing — no hulls, and
 *                 `util/geo.js` installs no patch, so the fetch is absent rather than multiplied
 *                 by zero.
 */
export function createCartoon({ enabled = true } = {}) {
  if (!enabled) return DISABLED;

  const state = { enabled: true, ...CARTOON_DEFAULTS };
  const fleets = [];
  const hulls = [];
  // Every rim material, split by which slider owns it. The taxi is its own group because its whole
  // job is to be heavier than the traffic it is driving through, and a single rim would collapse
  // the one distinction the mode exists to make.
  const rims = { taxi: [], hero: [] };

  CARTOON_UNIFORMS.uToonCel.value = state.cel;
  CARTOON_UNIFORMS.uToonSteps.value = state.steps;
  CARTOON_UNIFORMS.uToonInk.value = state.ink;
  CARTOON_UNIFORMS.uToonBite.value = state.bite;
  // Converted, because the ink is mixed in after three's `<colorspace_fragment>` has run — the
  // same reason the crayon's is. A `THREE.Color` from a hex string is in the linear working space
  // and the frame at that point in the shader is not; handed over unconverted the line comes out
  // far darker than the hulls drawn from the identical palette entry, which is the tell.
  CARTOON_UNIFORMS.uToonInkColor.value.copy(color('toonInk')).convertLinearToSRGB();

  /**
   * A rim, clamped against each part it is being written onto rather than once at construction.
   *
   * The clamp has to live here, not at the call site: a slider hands one number to a group whose
   * members are different sizes, and `MAX_RIM_FRACTION` is a statement about a part. Dragged past
   * what a truck's cargo box can carry, this leaves the box at its own ceiling and lets the car
   * bodies keep going.
   */
  function setRim(group, value) {
    for (const hull of rims[group]) {
      hull.material.userData.toon.uToonRim.value = Math.min(value, hull.geometry.userData.maxRim);
    }
  }

  /**
   * The ink, written to both places it is drawn — the hull materials and the screen-space line —
   * so a colour picker can never leave the city outlined in one black and the cars in another.
   *
   * The two want different colour spaces. A material's `color` is in the linear working space,
   * which is where `THREE.Color` puts a hex string; the line is mixed in *after* three's
   * `<colorspace_fragment>` has run, so its uniform has to be converted back out.
   */
  function setInk(hex) {
    const linear = new THREE.Color(hex);
    for (const hull of [...rims.taxi, ...rims.hero]) hull.material.color.copy(linear);
    CARTOON_UNIFORMS.uToonInkColor.value.copy(linear).convertLinearToSRGB();
  }

  return {
    state,

    /**
     * Outline a per-mesh object — the taxi, the cruiser. See `outlineRoot`.
     *
     * `group` is which rim slider owns the result, and it is the whole reason this takes one:
     * the taxi has to stay heavier than the traffic under every setting, so the two are scrubbed
     * apart rather than sharing one number.
     */
    outline(root, { group = 'hero', ...options } = {}) {
      const made = outlineRoot(root, { rim: state[`${group}Rim`], ...options });
      for (const pair of made) {
        hulls.push(pair.mask, pair.hull);
        rims[group].push(pair.hull);
      }
      return made;
    },

    /**
     * Outline an instanced traffic pool. Returns the pool's two meshes for the caller to add to
     * the scene, and registers them so `update` can keep their counts in step.
     */
    fleet(source, { group = 'hero', ...options } = {}) {
      const pooled = instancedOutline(source, { rim: state[`${group}Rim`], ...options });
      fleets.push(pooled);
      rims[group].push(pooled.hull);
      return [pooled.mask, pooled.hull];
    },

    /**
     * Keep every fleet hull drawing exactly as many instances as its source.
     *
     * `count` is not a property three watches, and it moves at runtime: the ⚙️ panel's car slider
     * writes it, and a truck spawning writes it mid-run. Three assignments a frame against a hull
     * that would otherwise draw the fleet's high-water mark — collapsed matrices at the world
     * origin, which is a knot of ink under the middle of the city.
     */
    update() {
      for (const { mask, hull, source } of fleets) {
        mask.count = source.count;
        hull.count = source.count;
      }
    },

    /**
     * Live tuning — the ⚙️ panel, and nothing else.
     *
     * Every key here reaches a uniform or a material property, so nothing in this section needs a
     * reload. The two rims are the ones that did until `outlineGeometry` moved the inflation into
     * the vertex shader.
     */
    set(key, value) {
      if (!(key in state)) return;
      state[key] = value;
      if (key === 'cel') CARTOON_UNIFORMS.uToonCel.value = value;
      else if (key === 'steps') CARTOON_UNIFORMS.uToonSteps.value = value;
      else if (key === 'ink') CARTOON_UNIFORMS.uToonInk.value = value;
      else if (key === 'bite') CARTOON_UNIFORMS.uToonBite.value = value;
      else if (key === 'taxiRim' || key === 'heroRim') setRim(key.replace('Rim', ''), value);
      else if (key === 'inkColor') setInk(value);
      else if (key === 'inkOpacity') {
        for (const hull of [...rims.taxi, ...rims.hero]) hull.material.opacity = value;
      }
    },

    dispose() {
      for (const piece of hulls) {
        // Same rule: a mask shares the mesh's own geometry, and only the rim owns an inflated one.
        if (piece.name === OUTLINE_NAME) piece.geometry.dispose();
        piece.material.dispose();
        piece.removeFromParent();
      }
      for (const { mask, hull } of fleets) {
        // The mask shares traffic's own geometry — disposing it would free a buffer the cars are
        // still drawing from. Only the material is this pool's to release.
        mask.material.dispose();
        mask.removeFromParent();
        hull.geometry.dispose();
        hull.material.dispose();
        hull.removeFromParent();
      }
      hulls.length = 0;
      fleets.length = 0;
    },
  };
}
