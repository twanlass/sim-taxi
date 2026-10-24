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
 * Paint `elements` (block elements whose lines are split by <br>) into the game in frame `w`.
 * Returns `redraw()` for a resize, or null when the game's scene can't be found.
 */
export function paintIntoGame(w, elements) {
  const scene = sceneOf(w.__taxi);
  if (!scene) return null;

  // Two canvases, one in each window. three checks its inputs with `instanceof`, and a typed array
  // or canvas made in this page belongs to a different realm from the game's — the first cut built
  // them here and every frame threw "Unsupported buffer data format". So the texture's canvas (and
  // the geometry's array, below) are made in the frame's window; the text is still drawn in this
  // one, where the slide's fonts are loaded, and copied across.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const gameCanvas = w.document.createElement('canvas');
  const gameCtx = gameCanvas.getContext('2d');
  const texture = new THREE.CanvasTexture(gameCanvas);
  // Raw: the canvas already holds display colours, and the shader writes them straight out.
  texture.colorSpace = THREE.NoColorSpace;

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      gameCanvas.width = W; gameCanvas.height = H;
      texture.dispose();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const el of elements) {
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = cs.color;
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
        const text = line.replace(/\s+/g, ' ').trim();
        ctx.fillText(text, rect.left, rect.top + lh * i + (lh - (asc + desc)) / 2 + asc);
      });
    }
    gameCtx.clearRect(0, 0, W, H);
    gameCtx.drawImage(canvas, 0, 0);
    texture.needsUpdate = true;
  }

  // Two triangles over the whole of clip space; the vertex shader ignores every camera, so the
  // layer sits on the screen whatever the game's camera does.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(
    new w.Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(map, vUv); }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6;
  redraw();
  scene.add(mesh);
  return { redraw };
}
