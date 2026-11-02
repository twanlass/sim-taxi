// The title slide's words, drawn *inside* the backdrop game so the squall's lens drops refract
// them. The drops are a pass over the game's finished frame (game/rain.js, `renderLens`), and HTML
// on top of the iframe is never in that frame — so the text is painted to a canvas at the exact
// pixels the HTML occupies and laid into the game's scene as a screen-space layer drawn last.
// Nothing in the game knows about it; it goes when the iframe does.
import * as THREE from 'three';

/** The game's scene, found by walking up from something the `__taxi` handle exposes. */
function sceneOf(taxi) {
  for (const v of Object.values(taxi)) {
    if (!v || typeof v !== 'object') continue;
    for (let o of [v, v.group, v.mesh, v.root, v.object]) {
      for (let n = 0; o?.isObject3D && n < 30; n++) {
        if (o.isScene) return o;
        o = o.parent;
      }
    }
  }
  return null;
}

/**
 * How a style's colour paints: `rgba(r, g, b, a)` split into an opaque fill and an alpha. The alpha
 * goes on `globalAlpha` rather than staying in the fill, because a colour emoji ignores the fill
 * entirely — the ✌️ stayed at full strength under an 80% ink.
 */
function inkOf(color) {
  const n = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return { fill: `rgb(${n[0]}, ${n[1]}, ${n[2]})`, alpha: n.length > 3 ? n[3] : 1 };
}

/** `text-transform` the way CSS does it: the DOM's text is what was typed, not what shows. */
function transformed(text, how) {
  if (how === 'uppercase') return text.toUpperCase();
  if (how === 'lowercase') return text.toLowerCase();
  if (how === 'capitalize') return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return text;
}

/**
 * Draw `el` onto `ctx` (set up in CSS pixels) exactly where it is on screen: a block element's lines
 * split at its <br>s, in its own font, colour, spacing and transform, or an image at its box. One
 * still loading calls `redraw` when it lands. Exported for the title's rain (splash.js), which needs
 * to know where the painted letters' ink is.
 */
export function paintElement(ctx, el, redraw = () => {}) {
  // An image (the kicker's logo) is drawn at its box; one still loading redraws when it lands.
  if (el.nodeName === 'IMG') {
    const r = el.getBoundingClientRect();
    ctx.globalAlpha = parseFloat(getComputedStyle(el).opacity);
    if (el.complete) ctx.drawImage(el, r.left, r.top, r.width, r.height);
    else el.addEventListener('load', redraw, { once: true });
    return;
  }
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const ink = inkOf(cs.color);
  ctx.fillStyle = ink.fill;
  ctx.globalAlpha = ink.alpha;
  ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.textBaseline = 'alphabetic';
  const rect = el.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight);
  // CSS centres the font's ascent+descent in each line box; the baseline follows from that.
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent;
  const lines = [];
  let cur = '';
  for (const node of el.childNodes) {
    if (node.nodeName === 'BR') { lines.push(cur); cur = ''; } else cur += node.textContent;
  }
  lines.push(cur);
  lines.forEach((line, i) => {
    const text = transformed(line.replace(/\s+/g, ' ').trim(), cs.textTransform);
    ctx.fillText(text, rect.left, rect.top + lh * i + (lh - (asc + desc)) / 2 + asc);
  });
}

/**
 * Paint `elements` (block elements whose lines are split by <br>, or images) into the game in frame `w`.
 * An element can set `--blend` to be laid over the scene instead of on top of it: `multiply`, so the
 * frame's light and shade come through the ink; `difference`, which inverts whatever is behind each
 * letter and ignores the ink's colour; or `contrast`, which reads how bright the frame is behind each
 * letter and fades the ink from its own colour over light ground to white over dark. Returns `redraw()` for a resize, or null when
 * the game's scene can't be found.
 */
export function paintIntoGame(w, elements) {
  const scene = sceneOf(w.__taxi);
  if (!scene) return null;
  const BLENDS = ['multiply', 'difference', 'contrast'];
  const blendOf = (el) => {
    const b = getComputedStyle(el).getPropertyValue('--blend').trim();
    return BLENDS.includes(b) ? b : 'normal';
  };

  // One layer per blend: a canvas, a texture, and a full-screen quad drawn last in the game's scene.
  // Two canvases each, one in each window. three checks its inputs with `instanceof`, and a typed
  // array or canvas made in this page belongs to a different realm from the game's — the first cut
  // built them here and every frame threw "Unsupported buffer data format". So the texture's canvas
  // (and the geometry's array, below) are made in the frame's window; the text is still drawn in
  // this one, where the slide's fonts are loaded, and copied across.
  function layer(blend) {
    const canvas = document.createElement('canvas');
    const gameCanvas = w.document.createElement('canvas');
    const texture = new THREE.CanvasTexture(gameCanvas);
    // Raw: the canvas already holds display colours, and the shader writes them straight out.
    texture.colorSpace = THREE.NoColorSpace;
    // Two triangles over the whole of clip space; the vertex shader ignores every camera, so the
    // layer sits on the screen whatever the game's camera does.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(
      new w.Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    // Multiply is `frame * colour`, so bare canvas has to come out white rather than clear: the
    // shader fades the ink to white by its alpha and the blend does the rest.
    // Difference can't be a blend function (it needs an abs), but exclusion can, and against white
    // ink they are the same thing: `a·(1 − frame) + frame·(1 − a)` with `a` the letter's coverage,
    // so a letter is the frame inverted and its anti-aliased edge fades back to the frame.
    const out = {
      normal: 'gl_FragColor = c;',
      contrast: 'gl_FragColor = vec4(mix(vec3(1.0), c.rgb, groundLight()), c.a);',
      multiply: 'gl_FragColor = vec4(mix(vec3(1.0), c.rgb, c.a), 1.0);',
      difference: 'gl_FragColor = vec4(vec3(c.a), 1.0);',
    }[blend];
    const factors = {
      normal: {},
      contrast: {},
      multiply: { blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor },
      difference: { blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneMinusSrcColorFactor },
    }[blend];
    // Contrast samples the frame drawn so far (copied just before this layer draws, below): its
    // brightness averaged over a disk a twentieth of the screen tall, so the ink fades across a
    // letter as the ground under it changes rather than tracing every car and tree inside it.
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, frame: { value: null }, res: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform sampler2D frame;
        uniform vec2 res;
        varying vec2 vUv;
        float lum(vec2 p) { return dot(texture2D(frame, p).rgb, vec3(0.2126, 0.7152, 0.0722)); }
        // 1 over the pale sky, 0 over the city's tarmac (about 0.9 and 0.27 in the frame's display
        // values), from thirteen taps on a golden-angle spiral. A switch rather than a fade: ink is
        // its own colour over sky and plain white over anything on the island. The first cut eased
        // across 0.4 to 0.7, and the park, the wet road and the lens rain all land inside that, so
        // the words over the city came out a mottled grey.
        float groundLight() {
          if (res.x < 2.0) return 1.0;
          vec2 uv = gl_FragCoord.xy / res;
          float r = 0.05 * res.y;
          float l = lum(uv);
          for (int i = 0; i < 12; i++) {
            float a = float(i) * 2.39996;
            l += lum(uv + vec2(cos(a), sin(a)) * r * sqrt((float(i) + 0.5) / 12.0) / res);
          }
          return smoothstep(0.66, 0.7, l / 13.0);
        }
        void main() {
          vec4 c = texture2D(map, vUv);
          if (c.a <= 0.0) discard;
          ${out}
        }`,
      transparent: true, depthTest: false, depthWrite: false,
      ...(blend === 'normal' || blend === 'contrast' ? {} : {
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, ...factors,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1e6;
    if (blend === 'contrast') {
      // The same move as the rain's lens (game/rain.js, `renderLens`): copy what the back buffer
      // holds so far. Only from the back buffer — under `?hdr` the frame is a multisampled target
      // that can't be copied from, and the ink stays its own colour.
      let frameTex = null;
      const size = new THREE.Vector2();
      mesh.onBeforeRender = (renderer) => {
        if (renderer.getRenderTarget()) return;
        renderer.getDrawingBufferSize(size);
        if (!frameTex || frameTex.image.width !== size.x || frameTex.image.height !== size.y) {
          frameTex?.dispose();
          frameTex = new THREE.FramebufferTexture(size.x, size.y);
          material.uniforms.frame.value = frameTex;
          material.uniforms.res.value.copy(size);
        }
        renderer.copyFramebufferToTexture(frameTex);
      };
    }
    scene.add(mesh);
    return { canvas, ctx: canvas.getContext('2d'), gameCanvas, gameCtx: gameCanvas.getContext('2d'), texture };
  }
  const layers = Object.fromEntries(['normal', ...BLENDS].map((b) => [b, layer(b)]));

  const paint = paintElement;

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    for (const l of Object.values(layers)) {
      if (l.canvas.width !== W || l.canvas.height !== H) {
        l.canvas.width = W; l.canvas.height = H;
        l.gameCanvas.width = W; l.gameCanvas.height = H;
        l.texture.dispose();
      }
      l.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      l.ctx.clearRect(0, 0, W, H);
    }
    for (const el of elements) paint(layers[blendOf(el)].ctx, el, redraw);
    for (const l of Object.values(layers)) {
      l.gameCtx.clearRect(0, 0, W, H);
      l.gameCtx.drawImage(l.canvas, 0, 0);
      l.texture.needsUpdate = true;
    }
  }
  redraw();
  // Follow the HTML. The visible words are this painted copy and the HTML underneath is transparent,
  // so a style edited in DevTools changed nothing on screen until the window was resized. Four times
  // a second, compare what each element would paint and redraw when anything differs. The timer is
  // the frame's own, so it stops when the backdrop is unloaded.
  const signature = () => elements.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return [r.left, r.top, r.width, r.height, cs.font, cs.color, cs.letterSpacing, cs.lineHeight,
      cs.textTransform, cs.opacity, blendOf(el), el.textContent].join('|');
  }).join('\n');
  let last = signature();
  w.setInterval(() => {
    const now = signature();
    if (now !== last) { last = now; redraw(); }
  }, 250);
  return { redraw };
}
