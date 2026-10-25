// The game's rendering path: the renderer budget, the look decisions every material is compiled
// against, the passes, and the order a frame runs them in. One module because two pages draw with
// it — the game (main.js) and the model workshop's bench (src/workshop/viewer.js) — and the bench
// is only worth anything while a model on it looks the way it will in the city. It was a hand-kept
// copy at first, and it drifted the way copies do: the bench was still on the toon paint after the
// game had moved to real, and it drew no rim line and no AO at all, because both read a depth
// prepass the bench had never been given. Anything that changes how a frame is drawn changes here,
// and both pages get it.
//
// What stays with each caller is what is not about drawing: the game's weather, its diagnostics,
// its governor and context recovery hand themselves in to `render` as optional extras; the bench
// has none of them.

import {
  setAmbientOcclusion, setCrayon, setCartoon, setPainterly, setPaintBrushes, setJunctionPaving, setRoadStrokes,
  setClassicPaint,
  setPaintLook, setRim, rimTuning, setRimTuning, setFlip, setVehiclePaint, setCloudShadows, rimPaintOn, setRimDepth,
} from '../util/geo.js';
import {
  getAmbientOcclusion, getMsaa, getShadowMapSize, getCrayon, getCartoon, getHdr, getBloom, getRain,
  getStorm, getSquall, getPaintClassic, getPaintLook, getRimColor, getRimTune, getFlip, getVehiclePaintClassic,
} from '../util/shot.js';
import { createBrushTiles } from './brushtiles.js';
import { createAmbientOcclusion } from './ssao.js';
import { createBloom } from './bloom.js';
import { createHdr } from './hdr.js';
import { createCrayon } from './crayon.js';
import { createCartoon } from './cartoon.js';
import { createCrt } from './crt.js';
import { cullEmptyPools } from '../util/emptypools.js';
import { syncRiverWater } from '../city/riverwater.js';
import { installColorGrade } from './colorgrade.js';

/**
 * The URL's say in how the frame is drawn. The game adds what only it decides (the safe mode, the
 * pixel-ratio cap off the player's Quality setting) around these.
 */
export function renderBudget() {
  return {
    msaa: getMsaa(),
    shadowMapSize: getShadowMapSize(),
    ao: getAmbientOcclusion(),
    crayon: getCrayon(),
    cartoon: getCartoon(),
    // The two bloom routes, and they are alternatives rather than layers — see `game/hdr.js`.
    // `?hdr` wins where it can run at all; both are settled in `createRenderPath`, once it has had
    // its say.
    hdr: getHdr(),
    bloom: getBloom(),
  };
}

/**
 * Every decision `propMaterial()` bakes into the shader it builds, so all of it has to be taken
 * before a single mesh exists: none of it can move afterwards.
 */
export function decideLooks(budget) {
  // The colour grade (game/colorgrade.js) goes on the end of three's fog chunk, after the edge
  // fog's own term — which is why here, once every import has run, and not at its own import.
  installColorGrade();
  // Ambient occlusion. `?ao=off` turns it off for a like-for-like cost comparison on a device.
  setAmbientOcclusion(budget.ao);
  // Crayon Mode, the same kind of decision: see `game/crayon.js` for its three layers.
  setCrayon(budget.crayon);
  // The painterly pass (PAINT_* in util/geo.js, game/brushtiles.js) on the ground. It carries the
  // paved junction, and once carried painted strokes along the streets; those are off by default
  // since 2026-10-25 (Tyler: "toggle off the street streaks") and `?roadstrokes=classic` brings
  // them back. The shadow edge, wall fade and wall/roof/lawn strokes are still in, dialled to 0.
  // `?painterly=classic` drops the whole pass, plaza included.
  const params = new URLSearchParams(location.search);
  const painterly = params.get('painterly') !== 'classic';
  setPainterly(painterly);
  if (painterly) {
    const tiles = createBrushTiles();
    setPaintBrushes(tiles.wall, tiles.ground, tiles.road);
    setJunctionPaving(params.get('roads') !== 'classic');
    setRoadStrokes(params.get('roadstrokes') === 'classic');
  }
  setClassicPaint(getPaintClassic());
  setPaintLook(getPaintLook());
  setRim(getRimColor());
  setFlip(getFlip());
  // After the look and the rim colour, which each reset the numbers a workshop slider moved.
  for (const [key, value] of getRimTune()) if (key in rimTuning() && Number.isFinite(value)) setRimTuning(key, value);
  setVehiclePaint(!getVehiclePaintClassic());
  // Cloud shadows are compiled into every lit material, so they are decided here with the look
  // modes. See CLOUD_UNIFORMS in util/geo.js; with no weather driving them they cover nothing.
  setCloudShadows(Boolean(getRain() ?? getStorm() ?? getSquall()));
  // The other look on offer, and independent of Crayon — see `game/cartoon.js`. Its cel bands
  // compile into the same materials, so it is decided in the same breath and for the same reason.
  setCartoon(budget.cartoon);
}

/**
 * The passes. Writes the settled `hdr` and `bloom` back into `budget`, because the diagnostics
 * panel reports the budget the page actually got, and `?hdr&crayon` is a request that was refused
 * rather than one that was honoured. `onNotice` hears about a refusal.
 */
export function createRenderPath(renderer, budget, { onNotice = () => {}, still = false } = {}) {
  // The comparison route first, because whether it can run at all is what decides the other one.
  // `?hdr` takes the whole frame through a composer with tone mapping on — see game/hdr.js — and
  // declines itself outright when a look mode is on or the GPU has no renderable float target.
  const hdr = createHdr(renderer, {
    enabled: budget.hdr,
    incompatible: [budget.crayon && 'crayon', budget.cartoon && 'cartoon'].filter(Boolean),
    onNotice,
  });
  budget.hdr = hdr.state.enabled;
  // **A declined `?hdr` stands the ordinary bloom back up.** The two are alternatives, so asking
  // for the composer takes this one's place — but only if the composer is actually running, or the
  // flag would leave a page with neither and no way to tell from the picture which was missing.
  budget.bloom = budget.bloom && !budget.hdr;

  // `edges` and `depth` are why the AO pass takes three flags: the crayon line is traced out of
  // its depth buffer, the bloom rejects its lamps against it and the rim paint finds its edges in
  // it, and Android's `?safe` default would otherwise have turned the pass off on the platform
  // most likely to be asked for a drawn look.
  const ao = createAmbientOcclusion(renderer, {
    enabled: budget.ao, edges: budget.crayon || budget.cartoon, depth: budget.bloom || rimPaintOn(),
  });
  // Spill around every self-lit thing — see game/bloom.js. Not a bright-pass over the frame: an
  // explicit draw list of lamps, rendered into a small half-float target of its own, so the main
  // render keeps its MSAA and the ghost outlines keep their stencil.
  const bloom = createBloom(renderer, {
    enabled: budget.bloom, depth: ao.depth, depthSize: ao.depthSize,
  });
  const crayon = createCrayon(renderer, { enabled: budget.crayon });
  const cartoon = createCartoon({ enabled: budget.cartoon });
  // The CRT screen over the finished frame — see game/crt.js. Only the game's budget carries
  // `crt`; the workshop's bench leaves it undefined and gets the clean frame.
  const crt = createCrt(renderer, { enabled: Boolean(budget.crt), still });

  return {
    ao, bloom, crayon, cartoon, hdr, crt,

    /**
     * The page (crayon) and the bloom composite: ordinary objects in the main scene at
     * `renderOrder` 1, not post passes, with the page over the bloom. Each is null when its flag
     * is off.
     */
    addOverlays(scene) {
      if (crayon.overlay) scene.add(crayon.overlay);
      if (bloom.overlay) scene.add(bloom.overlay);
    },

    /**
     * One frame, into whatever viewport and scissor the renderer is set to. The AO prepass has to
     * run before every render, or a frozen shot renders against whatever the previous frame left
     * in the texture; the main render is untouched by it — still the default framebuffer, still
     * its own MSAA, still its own stencil buffer for the ghost outlines.
     *
     * `rain`, `rainLightsOn` and `diag` are the game's; the bench passes none of them.
     */
    render(scene, cam, { rain = null, rainLightsOn = null, diag = null } = {}) {
      // Sized here rather than in a frame loop for the same reason the AO prepass is called here:
      // shot mode and `__taxi.redraw()` both reach a render without ever reaching the loop.
      crayon.prepare();
      // `?diag` counts the whole frame's draws, every pass below included.
      diag?.frameStart();
      // Before every pass below, so an effect pool with nothing in it skips the shadow, AO and
      // main draws alike — see util/emptypools.js.
      cullEmptyPools();
      // The wet road's mirror, before anything reads it. A no-op without `?rain`.
      rainLightsOn?.();
      rain?.update(0, cam);
      rain?.renderReflection(scene, cam);
      ao.render(scene, cam);
      // The rim paint reads the depth the prepass just drew (util/geo.js, `gRimEdge`).
      setRimDepth(ao.depth(), ao.depthSize(), cam);
      // After the AO prepass, which is what fills the depth buffer the lamps are rejected against.
      bloom.render(scene, cam);
      // Here rather than in a loop for the AO prepass's reason: shot mode renders without one.
      syncRiverWater(scene.fog?.color);
      // `?hdr` takes the whole frame through a composer instead; a no-op without the flag, and it
      // returns false so the ordinary path below still runs.
      if (!hdr.render(scene, cam)) renderer.render(scene, cam);
      // Drops on the glass, over the finished frame.
      rain?.renderLens();
      // The glass, in front of the drops on it.
      crt.render();
      // After everything has drawn, so its counters and centre pixel are the frame on screen.
      diag?.update();
    },

    dispose() {
      [ao, bloom, crayon, cartoon, hdr, crt].forEach((pass) => pass.dispose());
    },
  };
}
