// Slide 4's photo going up in smoke before the snake comes on. The <img> is swapped for a WebGL
// canvas over the same box (padded, so the smoke has room to drift past the edges), and a shader
// eats the picture from left to right along a ragged noise front, as if a breeze had come in from
// the left: the front pales and goes thin, and behind it the picture's own colours lift off in long
// light streaks that blow away to the right, curl a little, wash out to white and fade. (The first
// cut had a glowing orange rim and smoke rising up, and read as the photo catching fire.) Plain
// WebGL rather than three: one quad, one texture, gone in two seconds.

// How long the whole thing takes, and how much of it the last smoke spends clearing after the
// front has crossed. The padding is the room round the photo, as a fraction of its size per side.
const WISP_MS = 2200;
const SMOKE_LIFE = 0.32;
const PAD = 0.35;

// Performance. The first cut ran at 10 fps on a 2x laptop screen: the padded canvas was 6.8M
// device pixels, and each one evaluated procedural fbm (five octaves of four sin() hashes) about 80
// times. Now the fbm is baked once into a tiling NOISE_SIZE² texture, so each is one lookup; the
// canvas renders at most MAX_PIXELS (CSS upscales it; it's smoke and it's moving); and the smoke
// gathers TAPS samples rather than 20.
const NOISE_SIZE = 256;
const NOISE_CELLS = 8; // lattice cells across the texture at the first octave
const MAX_PIXELS = 2.2e6;
const TAPS = 12;

/** Tiling value-noise fbm, five octaves, as bytes — the same function the shader used to compute. */
function bakeNoise() {
  const n = NOISE_SIZE;
  const out = new Float32Array(n * n);
  let amp = 0.5;
  for (let o = 0, cells = NOISE_CELLS; o < 5; o++, cells *= 2, amp *= 0.5) {
    const lattice = new Float32Array(cells * cells).map(() => Math.random());
    const at = (i, j) => lattice[(j % cells) * cells + (i % cells)];
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * cells;
      const j = Math.floor(fy);
      let v = fy - j;
      v = v * v * (3 - 2 * v);
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * cells;
        const i = Math.floor(fx);
        let u = fx - i;
        u = u * u * (3 - 2 * u);
        const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
        const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
        out[y * n + x] += amp * (a + (b - a) * v);
      }
    }
  }
  return Uint8Array.from(out, (f) => Math.round(f * 255));
}

const VERTEX = /* glsl */ `
  attribute vec2 corner;
  varying vec2 vUv;
  void main() { vUv = corner * 0.5 + 0.5; gl_Position = vec4(corner, 0.0, 1.0); }`;

// The front is where dissolveAt equals prog. A pixel ahead of it is still picture; one behind it has
// gone, and what shows there is smoke gathered from upwind: for each of TAPS ages, the picture point
// that would have drifted here in that long, counted only if the front passed it about that long ago.
// That keeps smoke and picture consistent without simulating anything.
const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D img;
  uniform float prog;
  uniform float pad;
  uniform float aspect;
  uniform float life;
  uniform sampler2D noiseTex;
  uniform float noiseCells;
  varying vec2 vUv;

  // Baked fbm (bakeNoise), one lattice cell per unit of p, tiling.
  float fbm(vec2 p) { return texture2D(noiseTex, p / noiseCells).r; }
  bool inside(vec2 q) { return q.x >= 0.0 && q.y >= 0.0 && q.x <= 1.0 && q.y <= 1.0; }
  // When the front reaches a point of the picture: a sweep from the left, broken up by noise so it
  // eats in ragged tongues rather than a straight wipe. Ranges over about 0 to 1.
  float dissolveAt(vec2 q) {
    return 0.62 * q.x + 0.38 * fbm(q * vec2(aspect, 1.0) * 3.5);
  }
  // Where a wisp that left a point age ago has got to: blown right, lifting only a little, faster as
  // it goes, with a curl from the noise so the streaks wander.
  vec2 drift(vec2 q, float age) {
    vec2 curl = vec2(fbm(q * 4.0 + age * 3.0) - 0.5, fbm(q * 4.0 + 17.0 - age * 3.0) - 0.5);
    return (vec2(1.0, 0.22) * age + curl * vec2(0.3, 0.5) * age) * (1.0 + 2.0 * age);
  }

  void main() {
    vec2 q = (vUv - pad) / (1.0 - 2.0 * pad);
    vec4 col = vec4(0.0);
    float n = dissolveAt(q);
    if (inside(q) && n > prog) {
      col = texture2D(img, q);
      // The front: the last sliver before it pales and thins, so the picture frays rather than burns.
      float rim = 1.0 - smoothstep(0.0, 0.06, n - prog);
      col.rgb = mix(col.rgb, vec3(1.0), rim * 0.55);
      col.a *= 1.0 - rim * 0.6;
    }
    const int TAPS = ${TAPS};
    vec4 smoke = vec4(0.0);
    for (int k = 1; k <= TAPS; k++) {
      float age = life * float(k) / float(TAPS);
      vec2 src = q - drift(q, age);
      if (!inside(src)) continue;
      float since = prog - dissolveAt(src);
      float w = 1.0 - smoothstep(0.0, life / float(TAPS) * 1.5, abs(since - age));
      if (w <= 0.0) continue;
      vec4 c = texture2D(img, src);
      // Thinner as it ages, and broken into long streaks along the wind by noise stretched across it.
      float strands = smoothstep(0.4, 0.75, fbm(src * vec2(aspect * 2.0, 16.0) + vec2(-age * 5.0, 0.0)));
      float a = w * c.a * (1.0 - age / life) * strands * 0.8;
      // The colour washes out to white as it blows away.
      vec3 tint = mix(c.rgb, vec3(1.0), 0.4 + 0.55 * age / life);
      smoke += vec4(tint * a, a);
    }
    smoke = smoke / max(1.0, smoke.a);
    // Thin out toward the canvas's own edges: smoke that drifts off the top was cut flat by them.
    vec2 e = smoothstep(0.0, 0.15, vUv) * smoothstep(0.0, 0.15, 1.0 - vUv);
    smoke *= e.x * e.y;
    // Premultiplied over: the picture where there is any, smoke over the gaps.
    gl_FragColor = vec4(col.rgb * col.a, col.a) * (1.0 - smoke.a) + smoke * 0.9;
  }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/**
 * Burn `img` away into smoke. Hides it for the duration (and leaves it hidden); resolves when the
 * last wisp has cleared. `cancel()` stops it early and resolves with false. If WebGL isn't there,
 * the photo just goes.
 */
export function wispAway(img) {
  const r = img.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
  img.style.visibility = 'hidden';
  if (!gl) return { done: Promise.resolve(true), cancel() {} };

  // The padded box, centred on the photo; the photo's own tilt and shadow carry over, so the first
  // frame is indistinguishable from the <img> it replaces. Sized off the layout box rather than the
  // bounding rect, which a tilted element grows.
  const w = img.offsetWidth * (1 + 2 * PAD);
  const h = img.offsetHeight * (1 + 2 * PAD);
  const cs = getComputedStyle(img);
  const scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (w * h)));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  Object.assign(canvas.style, {
    position: 'fixed', zIndex: 3, pointerEvents: 'none',
    left: `${r.left + r.width / 2 - w / 2}px`, top: `${r.top + r.height / 2 - h / 2}px`,
    width: `${w}px`, height: `${h}px`, rotate: cs.rotate, filter: cs.filter,
  });
  document.body.appendChild(canvas);

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, NOISE_SIZE, NOISE_SIZE, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, bakeNoise());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const at = (name) => gl.getUniformLocation(program, name);
  gl.uniform1f(at('pad'), PAD / (1 + 2 * PAD));
  gl.uniform1f(at('aspect'), img.naturalWidth / img.naturalHeight);
  gl.uniform1f(at('life'), SMOKE_LIFE);
  gl.uniform1i(at('img'), 0);
  gl.uniform1i(at('noiseTex'), 1);
  gl.uniform1f(at('noiseCells'), NOISE_CELLS);
  gl.viewport(0, 0, canvas.width, canvas.height);

  let frame = 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const end = (ok) => {
    cancelAnimationFrame(frame);
    canvas.remove();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    finish(ok);
  };
  const t0 = performance.now();
  const draw = (now) => {
    const u = Math.min(1, (now - t0) / WISP_MS);
    // From just before the picture's first point to past its last plus the smoke's whole life, eased
    // in so it catches slowly and then goes.
    const ease = u * u * (3 - 2 * u) * 0.5 + u * 0.5;
    gl.uniform1f(at('prog'), -0.02 + ease * (1.04 + SMOKE_LIFE));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (u < 1) frame = requestAnimationFrame(draw);
    else end(true);
  };
  frame = requestAnimationFrame(draw);
  return { done, cancel: () => end(false) };
}
