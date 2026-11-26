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
  setAmbientOcclusion, setPainterly, setPaintBrushes, setJunctionPaving, setRoadStrokes, setRoadTexture, setRoadPixels, ROAD_TEXEL,
  setClassicPaint,
  setPaintLook, setRim, rimTuning, setRimTuning, setFlip, setVehiclePaint, setCloudShadows, rimPaintOn, setRimDepth, updateCloudMap,
} from '../util/geo.js';
import {
  getAmbientOcclusion, getMsaa, getShadowMapSize, getBloom, getRain,
  getStorm, getSquall, getPaintClassic, getPaintLook, getRimColor, getRimTune, getFlip, getVehiclePaintClassic,
} from '../util/shot.js';
import { createBrushTiles } from './brushtiles.js';
import { createAmbientOcclusion } from './ssao.js';
import { createBloom } from './bloom.js';
import { createCrt } from './crt.js';
import { cullEmptyPools } from '../util/emptypools.js';
import { syncRiverWater } from '../city/riverwater.js';
import { installColorGrade } from './colorgrade.js';
import { setWallGrain, WALL_TEXEL } from '../city/wallgrain.js';
import { perfPhase } from './perf.js';

/**
 * The URL's say in how the frame is drawn. The game adds what only it decides (the safe mode, the
 * pixel-ratio cap off the player's Quality setting) around these.
 */
export function renderBudget() {
  return {
    msaa: getMsaa(),
    shadowMapSize: getShadowMapSize(),
    ao: getAmbientOcclusion(),
    bloom: getBloom(),
  };
}

/**
 * Every decision `propMaterial()` bakes into the shader it builds, so all of it has to be taken
 * before a single mesh exists: none of it can move afterwards.
 */
export function decideLooks(budget, seed = 0) {
  // The colour grade (game/colorgrade.js) goes on the end of three's fog chunk, after the edge
  // fog's own term — which is why here, once every import has run, and not at its own import.
  installColorGrade();
  // Ambient occlusion. `?ao=off` turns it off for a like-for-like cost comparison on a device.
  setAmbientOcclusion(budget.ao);
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
    // The asphalt's colour variation (`setRoadTexture`): resurfaced runs, wear and mottle, worked
    // out in the same pass. `?roadtex=classic` is the one flat grey; `?roadtexamt=` scales it.
    // It is drawn as a pixel-art street, through a grid of world texels (`setRoadPixels`);
    // `?roadtex=smooth` is the same road without the grid, and `?roadpx=` the texel's size.
    const texAmt = Number(params.get('roadtexamt') ?? 1);
    setRoadTexture(params.get('roadtex') === 'classic' ? 0 : Number.isFinite(texAmt) ? texAmt : 1, seed);
    const texel = Number(params.get('roadpx') ?? ROAD_TEXEL);
    setRoadPixels(params.get('roadtex') === 'smooth' ? 0 : Number.isFinite(texel) ? texel : ROAD_TEXEL);
  }
  // The buildings' pixel grain (city/wallgrain.js): the street's texel grid on every wall and roof.
  // Not part of the painterly pass, so it stands outside it. `?bldgtex=classic` compiles none of it,
  // `?bldgtexamt=` scales it and `?bldgpx=` is its texel.
  const grainAmt = Number(params.get('bldgtexamt') ?? 1);
  const grainTexel = Number(params.get('bldgpx') ?? WALL_TEXEL);
  setWallGrain(params.get('bldgtex') === 'classic' ? 0 : Number.isFinite(grainAmt) ? grainAmt : 1,
    Number.isFinite(grainTexel) ? grainTexel : WALL_TEXEL);
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
}

/**
 * The passes.
 */
export function createRenderPath(renderer, budget, { still = false } = {}) {
  // `depth` is why the AO pass takes two flags: the bloom rejects its lamps against its depth
  // buffer and the rim paint finds its edges in it, and Android's `?safe` default would otherwise
  // have turned the pass off.
  const ao = createAmbientOcclusion(renderer, {
    enabled: budget.ao,
    // WebGPU: the depth prepass is a WebGL pass until it is ported (game/gpucompat.js).
    depth: !budget.gpu && (budget.bloom || rimPaintOn()),
  });
  // Spill around every self-lit thing — see game/bloom.js. Not a bright-pass over the frame: an
  // explicit draw list of lamps, rendered into a small half-float target of its own, so the main
  // render keeps its MSAA and the ghost outlines keep their stencil.
  const bloom = createBloom(renderer, {
    enabled: budget.bloom, depth: ao.depth, depthSize: ao.depthSize,
  });
  // The CRT screen over the finished frame — see game/crt.js. Only the game's budget carries
  // `crt`; the workshop's bench leaves it undefined and gets the clean frame.
  const crt = createCrt(renderer, { enabled: Boolean(budget.crt), still });

  return {
    ao, bloom, crt,

    /**
     * The bloom composite: an ordinary object in the main scene at `renderOrder` 1, not a post
     * pass. Null when its flag is off.
     */
    addOverlays(scene) {
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
      // `?diag` counts the whole frame's draws, every pass below included.
      diag?.frameStart();
      // Before every pass below, so an effect pool with nothing in it skips the shadow, AO and
      // main draws alike — see util/emptypools.js.
      cullEmptyPools();
      // The cloud shade every lit material reads (util/gpuclouds.js), before the mirror reads it too.
      updateCloudMap(renderer);
      // The wet road's mirror, before anything reads it. A no-op without `?rain`.
      rainLightsOn?.();
      rain?.update(0, cam);
      rain?.renderReflection(scene, cam);
      perfPhase('ao');
      ao.render(scene, cam);
      // The rim paint reads the depth the prepass just drew (util/geo.js, `gRimEdge`).
      setRimDepth(ao.depth(), ao.depthSize(), cam);
      // After the AO prepass, which is what fills the depth buffer the lamps are rejected against.
      perfPhase('bloom');
      bloom.render(scene, cam);
      // Here rather than in a loop for the AO prepass's reason: shot mode renders without one.
      syncRiverWater(scene.fog?.color);
      perfPhase('main');
      renderer.render(scene, cam);
      perfPhase('post');
      // Drops on the glass, over the finished frame.
      rain?.renderLens();
      // The glass, in front of the drops on it.
      crt.render();
      // After everything has drawn, so its counters and centre pixel are the frame on screen.
      diag?.update();
      perfPhase('after');
    },

    dispose() {
      [ao, bloom, crt].forEach((pass) => pass.dispose());
    },
  };
}
