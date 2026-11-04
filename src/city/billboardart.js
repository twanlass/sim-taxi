import * as THREE from 'three';

// The billboards' posters, drawn as vector art on a canvas: real type in the game's own face (Space
// Grotesk 700, src/fonts.css) and flat shapes, no gloss. Tyler asked for "actual vector design"
// over the first build's pixel letters on 2026-11-04, and for one of the two to be the Loco Juice
// ad the radio plays (RADIO_ad_loco_juice, game/sfx.js).
//
// **One word per poster has to read at play zoom**, and that sets every layout below. A world unit
// is ~7.7px there and the poster is about 7.6 × 3 units, so the canvas's 400px of height is ~23
// screen pixels: a headline has to be most of the poster's height to come out ten pixels tall.
// Everything smaller — the strap lines, the tagline — is for a player who pinches in.
//
// Browser only (it needs a canvas). `posterTexture` answers null without one, and the board falls
// back to plain paper, which is what the headless tools see.

/** The canvas, in pixels. The poster face is 2.55 : 1; this is close enough that nothing shows. */
export const ART_W = 1024;
export const ART_H = 400;

const FONT = '"Space Grotesk", system-ui, sans-serif';

/** The poster designs, by name. */
export const ADS = ['robotaxi', 'locojuice'];

/** The largest size at which `text` fits in `maxW` (and under `maxSize`). */
function fit(g, text, weight, maxW, maxSize) {
  g.font = `${weight} ${maxSize}px ${FONT}`;
  const w = g.measureText(text).width;
  const size = w > maxW ? Math.floor((maxSize * maxW) / w) : maxSize;
  g.font = `${weight} ${size}px ${FONT}`;
  return size;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// --- Robo-taxis: the rival's teaser ---------------------------------------------------------------

/**
 * A teal band over warm paper. In the band, a little robo-taxi pod and the strap line; under it the
 * one word that matters, as wide as the poster. At play zoom it reads as "teal stripe, big black
 * word": the stripe says brand, the word says when.
 */
function drawRobotaxi(g) {
  const paper = '#F4F0E6';
  const ink = '#1B2029';
  const teal = '#12A1B3';
  g.fillStyle = paper;
  g.fillRect(0, 0, ART_W, ART_H);
  const bandH = 150;
  g.fillStyle = teal;
  g.fillRect(0, 0, ART_W, bandH);

  // The pod: a rounded white body with a domed cabin, a dark window band with two LED eyes, and
  // a sensor puck on the roof. Deliberately vague about the real thing (robo-taxis arrive in the
  // game later and will have a look of their own) — this is the ad's cartoon of one.
  g.save();
  g.translate(36, 22);
  g.fillStyle = '#0B6F7C';                                   // shadow under the wheels
  g.fillRect(4, 104, 168, 8);
  g.fillStyle = '#FFFFFF';
  roundRect(g, 0, 40, 176, 62, 22);                          // body
  g.fill();
  g.beginPath();                                             // cabin dome
  g.moveTo(26, 46);
  g.quadraticCurveTo(40, 6, 92, 6);
  g.quadraticCurveTo(146, 6, 156, 46);
  g.closePath();
  g.fill();
  g.fillStyle = ink;                                         // window band
  roundRect(g, 38, 20, 104, 30, 14);
  g.fill();
  g.fillStyle = '#5EF2FF';                                   // the eyes
  g.beginPath(); g.arc(70, 35, 7, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(110, 35, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = ink;                                         // sensor puck
  roundRect(g, 78, -4, 28, 12, 5);
  g.fill();
  for (const x of [38, 140]) {                               // wheels
    g.beginPath(); g.arc(x, 102, 16, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#DDE3E8';
  for (const x of [38, 140]) { g.beginPath(); g.arc(x, 102, 6, 0, Math.PI * 2); g.fill(); }
  g.restore();

  // The strap line, in the band.
  g.fillStyle = '#FFFFFF';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  fit(g, 'ROBO-TAXIS ARRIVE', 700, 720, 64);
  g.fillText('ROBO-TAXIS ARRIVE', 258, 82);
  g.fillStyle = '#D6F6FA';
  fit(g, 'No driver. No small talk.', 500, 720, 34);
  g.fillText('No driver. No small talk.', 260, 126);

  // The headline: as big as the paper under the band allows.
  g.fillStyle = ink;
  g.textAlign = 'center';
  fit(g, 'MONDAY.', 700, ART_W - 70, 250);
  g.fillText('MONDAY.', ART_W / 2, ART_H - 40);
}

// --- Loco Juice -----------------------------------------------------------------------------------

/**
 * The energy drink. A sunburst in hot orange and magenta, a lime can tipped into the corner with a
 * lightning bolt on it, and LOCO / JUICE stacked beside it in a slanted heavy face. At play zoom:
 * "hot pink board, white word". The tagline is a joke for anyone who pinches in.
 */
function drawLocoJuice(g) {
  // Pushed hotter than they look here: the haze and the golden-hour sun both pale a poster, and
  // the first pair came out a dusty salmon at play zoom.
  const hot = '#FF1F63';
  const orange = '#FF7A00';
  const lime = '#B8F53B';
  const ink = '#24102E';
  const grad = g.createLinearGradient(0, 0, ART_W, ART_H);
  grad.addColorStop(0, orange);
  grad.addColorStop(1, hot);
  g.fillStyle = grad;
  g.fillRect(0, 0, ART_W, ART_H);

  // The burst, round the can.
  const cx = 190;
  const cy = 210;
  g.fillStyle = 'rgba(255, 230, 140, 0.22)';
  const rays = 18;
  for (let i = 0; i < rays; i++) {
    const a0 = (i / rays) * Math.PI * 2;
    const a1 = a0 + Math.PI / rays;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a0) * 1200, cy + Math.sin(a0) * 1200);
    g.lineTo(cx + Math.cos(a1) * 1200, cy + Math.sin(a1) * 1200);
    g.closePath();
    g.fill();
  }

  // The can: flat colour, a darker band at each end for the rims, no highlight.
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.22);
  const cw = 150;
  const ch = 300;
  g.fillStyle = ink;
  roundRect(g, -cw / 2 - 6, -ch / 2 - 6, cw + 12, ch + 12, 26);   // outline
  g.fill();
  g.fillStyle = lime;
  roundRect(g, -cw / 2, -ch / 2, cw, ch, 22);
  g.fill();
  g.fillStyle = '#8CC51F';
  g.fillRect(-cw / 2, -ch / 2 + 6, cw, 18);
  g.fillRect(-cw / 2, ch / 2 - 24, cw, 18);
  g.fillStyle = '#C9CED6';                                    // lid
  roundRect(g, -cw / 2 + 10, -ch / 2 - 22, cw - 20, 22, 8);
  g.fill();
  g.fillStyle = ink;                                          // the bolt
  g.beginPath();
  g.moveTo(14, -100);
  g.lineTo(-40, 14);
  g.lineTo(-4, 14);
  g.lineTo(-22, 104);
  g.lineTo(42, -16);
  g.lineTo(6, -16);
  g.closePath();
  g.fill();
  g.restore();

  // LOCO / JUICE, slanted (Space Grotesk has no italic, so the slant is a skew), white on a hard
  // ink drop rather than any soft shadow.
  const word = (text, size, y, fill) => {
    g.save();
    g.setTransform(1, 0, -0.18, 1, 0, 0);
    g.font = `700 ${size}px ${FONT}`;
    g.textAlign = 'left';
    const x = 400 + y * 0.18;
    g.fillStyle = ink;
    g.fillText(text, x + 8, y + 8);
    g.fillStyle = fill;
    g.fillText(text, x, y);
    g.restore();
  };
  g.textBaseline = 'alphabetic';
  const big = fit(g, 'LOCO', 700, 560, 210);
  word('LOCO', big, 196, '#FFFFFF');
  const mid = fit(g, 'JUICE', 700, 560, 170);
  word('JUICE', mid, 340, lime);
  g.fillStyle = '#FFF4DA';
  g.textAlign = 'left';
  fit(g, 'DRINK RESPONSIBLY. DRIVE LOCO.', 600, 520, 26);
  g.fillText('DRINK RESPONSIBLY. DRIVE LOCO.', 432, 384);
}

const DRAW = { robotaxi: drawRobotaxi, locojuice: drawLocoJuice };

/**
 * The light off the three lamps on the catwalk, painted into the poster: a warm fan up from the
 * foot under each one. Painted rather than lit because the lamps are not lights (a light in the
 * main scene re-resolves every program, CLAUDE.md), and a poster is the one surface they reach.
 */
function drawWash(g) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const u of [1 / 6, 1 / 2, 5 / 6]) {
    const x = u * ART_W;
    const grad = g.createRadialGradient(x, ART_H + 30, 10, x, ART_H + 30, 300);
    grad.addColorStop(0, 'rgba(255, 226, 160, 0.34)');
    grad.addColorStop(0.5, 'rgba(255, 220, 150, 0.12)');
    grad.addColorStop(1, 'rgba(255, 220, 150, 0)');
    g.fillStyle = grad;
    g.fillRect(x - 320, 0, 640, ART_H);
  }
  g.restore();
}

/**
 * The poster for ad `name` as a texture, or null with no canvas (the headless tools). Drawn at once
 * and again when the font has loaded — a canvas draws in whatever face is ready, and the first
 * frame of the game can arrive before Space Grotesk does.
 */
export function posterTexture(name) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = ART_W;
  canvas.height = ART_H;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const paint = () => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    DRAW[name](g);
    drawWash(g);
    texture.needsUpdate = true;
  };
  paint();
  document.fonts?.load(`700 100px ${FONT}`).then(paint, () => {});
  return texture;
}
