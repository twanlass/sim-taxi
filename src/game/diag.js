/**
 * The on-screen renderer readout — `?diag`.
 *
 * This exists because of a class of bug that a desktop cannot see and a phone cannot report. The
 * game came up black on an Android device: no meshes, no sky, the tutorial's spotlight and the
 * HUD both perfectly alive on top of it. Everything that normally narrows that down is out of
 * reach — there is no console on the phone, and the three failures that produce exactly this
 * picture are all *silent from JavaScript's point of view*:
 *
 *   - **A lost context.** Three catches `webglcontextlost` itself, calls `preventDefault()` and
 *     sets an internal flag; every later `render()` returns immediately. It says so with
 *     `console.log`, and nothing throws.
 *   - **A shader that will not compile.** Three logs the driver's error with `console.error` and
 *     carries on. The material draws nothing; every other material still draws.
 *   - **A context that was never created.** `console.error` again, from three's
 *     `webglcontextcreationerror` handler.
 *
 * `index.html` now mirrors those console lines onto the screen, which turns all three from
 * invisible into legible. This panel answers the question that comes next: *what did the device
 * actually give us, and did anything get drawn?*
 *
 * The two lines that decide it are `calls` and `ctx`:
 *
 *   - `ctx LOST` — the GPU took the context away. Memory pressure, a driver reset, or the OS
 *     reclaiming it. `?safe` (see `util/shot.js`) is the configuration that asks for least.
 *   - `calls 0` with a live context — the scene submitted nothing. That is a camera or a culling
 *     problem, not a driver one, and it is the opposite end of the codebase.
 *   - `calls ~9` and a black screen — the pipeline ran and the pixels came out wrong. A shader,
 *     a blend state, or a driver bug, and the mirrored `THREE.WebGLProgram` error above the panel
 *     usually names it.
 *
 * Everything else in here is the device describing itself, because the answer to "why does this
 * one phone do it" is usually in the GPU string or in the gap between what the renderer *asked*
 * for and what it was *granted* — `getContextAttributes()` reports the latter, and a driver that
 * quietly declines a stencil buffer or multisampling is a documented trap in this project
 * already (see the ghost outline in `docs/rendering.md`).
 *
 * Nothing here runs unless the flag is set, and the module imports cleanly in node so
 * `npm run check` boots it with the rest.
 */

import * as THREE from 'three';

/**
 * The GPU's own name for itself.
 *
 * `WEBGL_debug_renderer_info` is the extension that gives the real string; browsers gate it
 * behind a privacy setting and some return the masked value anyway, so both are read and the
 * unmasked one is only preferred when it is actually there.
 */
function describeGpu(gl) {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    || gl.getParameter(gl.RENDERER);
  const vendor = (ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
    || gl.getParameter(gl.VENDOR);
  return { renderer: String(renderer ?? '?'), vendor: String(vendor ?? '?') };
}

/**
 * What the context was *granted*, which is not what it was asked for.
 *
 * A driver is free to hand back a context with no stencil buffer or no multisampling and say
 * nothing about it. That is not a hypothetical here: without a stencil buffer the ghost outline's
 * "not the mask" test passes everywhere and the rim fills the taxi in solid yellow, which is a
 * bug that has already been paid for once. `SAMPLES` is the count the driver actually resolved
 * to — 0 means MSAA was declined however the renderer was constructed.
 */
function describeBuffers(gl) {
  const attributes = gl.getContextAttributes() ?? {};
  return {
    antialias: Boolean(attributes.antialias),
    stencil: Boolean(attributes.stencil),
    samples: gl.getParameter(gl.SAMPLES) ?? 0,
    stencilBits: gl.getParameter(gl.STENCIL_BITS) ?? 0,
    depthBits: gl.getParameter(gl.DEPTH_BITS) ?? 0,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0,
  };
}

/**
 * The shader limits a mobile GPU is most likely to be the first to run out of.
 *
 * A desktop driver has headroom in all three and a phone's are close to the spec minimums, so a
 * program that links everywhere else can fail on one device — and this city's materials are not
 * plain: every prop material carries the AO patch's extra sampler and its uniforms on top of a
 * flat-shaded Lambert with a shadow map. When the mirrored `THREE.WebGLProgram: Shader Error`
 * says a program would not link, these are the numbers that say whether it was ever going to.
 */
function describeLimits(gl) {
  return {
    varyings: gl.getParameter(gl.MAX_VARYING_VECTORS) ?? 0,
    fragUniforms: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) ?? 0,
    textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) ?? 0,
  };
}

/**
 * Build the readout. Returns `{ update }` whether or not it is switched on, so the frame loop
 * calls it unconditionally.
 *
 * @param renderer  the main WebGLRenderer
 * @param enabled   false leaves every method a no-op and touches no DOM
 * @param flags     the renderer budget actually in effect, so the panel says which configuration
 *                  produced the picture behind it — a bisection step is worthless if you cannot
 *                  tell from the screenshot which step it was
 */
export function createDiagnostics(renderer, { enabled = false, flags = {} } = {}) {
  const element = enabled ? document.getElementById('diag') : null;
  if (!element) return { update: () => {} };

  const gl = renderer.getContext();
  const { renderer: gpu, vendor } = describeGpu(gl);
  const buffers = describeBuffers(gl);
  const limits = describeLimits(gl);
  // One pixel, read back off the default framebuffer — see `readCentrePixel`.
  const centre = new Uint8Array(4);

  // Written once. The device does not change under us, and re-reading GL parameters every frame
  // is a pipeline stall for text nobody is watching change.
  const header = [
    `${vendor}`,
    `${gpu}`,
    `webgl${renderer.capabilities.isWebGL2 ? '2' : '1'}`
      + ` · aa ${buffers.antialias ? 'yes' : 'NO'} (${buffers.samples}x)`
      + ` · stencil ${buffers.stencil ? 'yes' : 'NO'} (${buffers.stencilBits}b)`,
    `depth ${buffers.depthBits}b · maxtex ${buffers.maxTexture}`
      + ` · vary ${limits.varyings} · funif ${limits.fragUniforms}`
      + ` · tex ${limits.textureUnits}`,
    `flags msaa=${flags.msaa ? 'on' : 'off'} shadows=${flags.shadowMapSize || 'off'}`
      + ` dpr=${flags.pixelRatioCap} ao=${flags.ao ? 'on' : 'off'}`
      + `${flags.safe ? ' [safe]' : ''}`,
  ].join('\n');

  // Averaged over a second rather than reported per frame: a number that changes sixty times a
  // second is unreadable on a screen you are holding, and the question here is "is this device
  // drawing at all", not "how long was this particular frame".
  let sinceFlush = 0;
  let frames = 0;
  const drawingBuffer = new THREE.Vector2();
  // Sticky, because the events worth noting here are the ones that have already happened by the
  // time anyone reads the panel — a context loss and what was given up to survive it.
  let notice = '';

  element.hidden = false;

  /**
   * One pixel from the middle of the frame that was just drawn — and the probe that splits the
   * last two suspects apart.
   *
   * A black screen with a live context and a normal draw-call count leaves two very different
   * bugs standing, and no amount of counting draw calls tells them apart:
   *
   *   - **The GPU drew nothing useful.** A shader that links and outputs black, a blend or depth
   *     state the driver gets wrong, geometry that ends up degenerate. The pixel comes back black
   *     because the frame really is black.
   *   - **The GPU drew the city and the screen never got it.** A compositing bug: the canvas
   *     layer not being promoted, presented, or composited on that device. The pixel comes back
   *     *sky blue* while the screen stays black — which is the whole answer, and it points at a
   *     completely different half of the browser than every other line in this panel.
   *
   * Read straight after `renderer.render()` in the same task, which is when the default
   * framebuffer still holds the frame — `preserveDrawingBuffer` is off outside shot mode, and the
   * buffer is only invalidated once the frame is presented.
   *
   * It costs a pipeline stall, which is why it is behind `?diag` and runs twice a second rather
   * than sixty times. `renderer.readRenderTargetPixels` is deliberately not used: it takes a
   * render target, and the default framebuffer — the one actually on screen, with the MSAA
   * resolve this is asking about — is not one.
   */
  function readCentrePixel() {
    if (gl.isContextLost()) return null;
    try {
      gl.readPixels(
        Math.floor(drawingBuffer.x / 2), Math.floor(drawingBuffer.y / 2), 1, 1,
        gl.RGBA, gl.UNSIGNED_BYTE, centre,
      );
    } catch {
      // A driver that refuses the read is telling us something too, but not something worth
      // taking the frame loop down for.
      return null;
    }
    // Three leaves its own state bound; the read touches none of it, but the error queue is
    // shared, so a failure here would otherwise surface as a mystery further down the frame.
    if (gl.getError() !== gl.NO_ERROR) return null;
    return `${centre[0]},${centre[1]},${centre[2]}`;
  }

  function update(dt) {
    frames += 1;
    sinceFlush += dt;
    if (sinceFlush < 0.5) return;

    const fps = frames / sinceFlush;
    frames = 0;
    sinceFlush = 0;

    const info = renderer.info.render;
    // Marked stale rather than left to be misread. `render()` returns at its first line while the
    // context is down, so `renderer.info` never resets and the counters sit frozen at the last
    // frame that actually drew — which reads as "40 draw calls a frame, and still black".
    const lost = gl.isContextLost();
    renderer.getDrawingBufferSize(drawingBuffer);
    element.textContent = `${header}\n`
      // The line that decides it. `calls` is the count from the frame just drawn — three resets
      // `renderer.info` at the top of every `render()`, so this is one frame's work rather than a
      // running total.
      + `ctx ${lost ? 'LOST' : 'ok'}`
      + ` · calls ${info.calls}${lost ? ' (stale)' : ''} · tris ${info.triangles}`
      + ` · progs ${renderer.info.programs?.length ?? '?'}\n`
      + `${drawingBuffer.x}x${drawingBuffer.y} @${window.devicePixelRatio}`
      + ` · ${fps.toFixed(0)}fps`
      // Last, because it is the line you only need once the two above have failed to explain
      // anything. `mid` is the centre pixel of the frame on screen: black here and black on the
      // screen agree, and anything else means the frame was drawn and never presented.
      + ` · mid ${readCentrePixel() ?? '--'}`
      + notice;
  }

  return {
    update,
    /**
     * Record something that happened to the renderer since it was built — a context loss, a
     * budget the recovery gave up. The header is written once from the *initial* configuration,
     * so without this the panel would keep reporting a `dpr=2` that is no longer true.
     */
    note(text) { notice = `\n${text}`; },
  };
}
