// The title slide's rain on its heading: drops fall over the words and burst on them — a small
// crown where each one strikes and a few droplets thrown up and out that fall back and fade —
// while the ones that find a gap between letters carry on down to the next line, or out under the
// heading and away. The squall in the backdrop game is the weather; this is the part of it that
// lands on the type.
//
// The words are painted into the game's frame rather than shown as HTML (scenetext.js), so there is
// nothing in this page to collide with. Instead the heading is painted again, by the same code
// (`paintElement`), onto a canvas nobody sees, and read back into the top of its ink in every screen
// column: a drop falling down a column strikes there. Drawn on a canvas of its own over the slide.
import { paintElement } from './scenetext.js';

// In px, px/s and ms. Drops come at DROPS_PER_S over the heading's width (and DROP_MARGIN either
// side of it), falling at DROP_V give or take a fifth, slanted by WIND, each a streak DROP_LEN long.
// A strike throws SPRAY droplets (SPRAY_VX to either side, SPRAY_VY up, give or take half) that fall
// under GRAVITY and fade over SPRAY_MS, and opens a crown CROWN_R wide over CROWN_MS. A drop that
// misses fades out over the FALL_OUT below the heading.
const DROPS_PER_S = 55;
const DROP_MARGIN = 40;
const DROP_V = 1100;
const WIND = 90;
const DROP_LEN = 22;
const SPRAY = 7;
const SPRAY_VX = 180;
const SPRAY_VY = 360;
const GRAVITY = 1800;
const SPRAY_MS = 520;
const CROWN_R = 13;
const CROWN_MS = 240;
const FALL_OUT = 60;
// Water is a light core over a thin dark rim, so it reads on both halves of the heading: the sky,
// where the ink is dark and pale water alone vanished, and the city, where the ink turns white.
const WATER = '232, 242, 255';
const RIM = '30, 52, 84';

/** The top of `el`'s ink in every screen column across its box (Infinity where there is none). */
function inkTops(el) {
  const r = el.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(window.innerWidth);
  canvas.height = Math.ceil(r.bottom);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  paintElement(g, el);
  const x0 = Math.max(0, Math.floor(r.left - DROP_MARGIN));
  const x1 = Math.min(canvas.width, Math.ceil(r.right + DROP_MARGIN));
  const y0 = Math.max(0, Math.floor(r.top));
  const h = canvas.height - y0;
  const data = g.getImageData(x0, y0, x1 - x0, h).data;
  const tops = new Float32Array(x1 - x0).fill(Infinity);
  for (let x = 0; x < x1 - x0; x++) {
    for (let y = 0; y < h; y++) {
      if (data[(y * (x1 - x0) + x) * 4 + 3] > 127) { tops[x] = y0 + y; break; }
    }
  }
  return { x0, x1, top: r.top, bottom: r.bottom, at: (x) => tops[Math.floor(x) - x0] ?? Infinity };
}

/** Rain on `heading`, drawn over `host` (its slide). Returns `{ stop }`. */
export function rainOn(heading, host) {
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 });
  host.appendChild(canvas);
  const g = canvas.getContext('2d');
  let ink = null;
  const layout = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    ink = inkTops(heading);
  };
  layout();
  window.addEventListener('resize', layout);

  const drops = [];   // { x, y, v }
  const spray = [];   // { x, y, vx, vy, r, t0 }
  const crowns = [];  // { x, y, t0 }
  let owed = 0;
  let last = performance.now();
  let raf = 0;

  const step = (now) => {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // New drops, from just above the heading so they're falling at full speed by the time they reach it.
    owed += DROPS_PER_S * dt;
    for (; owed >= 1; owed--) {
      const v = DROP_V * (0.8 + Math.random() * 0.4);
      drops.push({ x: ink.x0 + Math.random() * (ink.x1 - ink.x0), y: ink.top - 80 - Math.random() * 120, v });
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const y = d.y + d.v * dt;
      const x = d.x + WIND * dt;
      const hit = ink.at(x);
      if (y >= hit && d.y < hit + 4) {
        // Strike: a crown on the letter and a few droplets off it.
        crowns.push({ x, y: hit, t0: now });
        for (let k = 0; k < SPRAY; k++) {
          spray.push({
            x, y: hit - 1, t0: now, r: 1.2 + Math.random() * 1.4,
            vx: (Math.random() * 2 - 1) * SPRAY_VX + WIND * 0.5,
            vy: -SPRAY_VY * (0.5 + Math.random()),
          });
        }
        drops.splice(i, 1);
        continue;
      }
      d.x = x;
      d.y = y;
      if (d.y > ink.bottom + FALL_OUT) drops.splice(i, 1);
    }
    for (let i = spray.length - 1; i >= 0; i--) {
      const s = spray[i];
      s.vy += GRAVITY * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (now - s.t0 > SPRAY_MS) spray.splice(i, 1);
    }
    for (let i = crowns.length - 1; i >= 0; i--) if (now - crowns[i].t0 > CROWN_MS) crowns.splice(i, 1);

    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.lineCap = 'round';
    // Everything twice: the rim, wider, then the water over it.
    for (const [colour, widen, strength] of [[RIM, 1.4, 0.35], [WATER, 0, 1]]) {
      for (const d of drops) {
        // Fading out once past the heading's foot, for the ones that went through.
        const fade = Math.max(0, Math.min(1, 1 - (d.y - ink.bottom) / FALL_OUT));
        const len = DROP_LEN * (d.v / DROP_V);
        g.strokeStyle = `rgba(${colour}, ${0.6 * fade * strength})`;
        g.lineWidth = 1.5 + widen;
        g.beginPath();
        g.moveTo(d.x, d.y);
        g.lineTo(d.x - (WIND / d.v) * len, d.y - len);
        g.stroke();
      }
      for (const c of crowns) {
        const k = (now - c.t0) / CROWN_MS;
        const r = CROWN_R * Math.sqrt(k);
        g.strokeStyle = `rgba(${colour}, ${0.85 * (1 - k) * strength})`;
        g.lineWidth = 1.6 + widen;
        g.beginPath();
        // A flattened ring seen from a little above, upper half only: the lower is behind the letter.
        g.ellipse(c.x, c.y, r, r * 0.35, 0, Math.PI, Math.PI * 2);
        g.stroke();
      }
      for (const sp of spray) {
        const k = (now - sp.t0) / SPRAY_MS;
        g.fillStyle = `rgba(${colour}, ${0.95 * (1 - k) * strength})`;
        g.beginPath();
        g.arc(sp.x, sp.y, sp.r + widen * 0.6, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
  raf = requestAnimationFrame(step);
  return {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', layout);
      canvas.remove();
    },
  };
}
