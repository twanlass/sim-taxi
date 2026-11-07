import * as THREE from 'three';

// The billboards' posters, drawn as vector art on a canvas: real type in the game's own face (Space
// Grotesk 700, src/fonts.css) and flat shapes, no gloss. Tyler asked for "actual vector design"
// over the first build's pixel letters on 2026-11-04. The second ad was Loco Juice (the radio's
// energy drink) for an afternoon, then Dub Burger, the city's own drive-through (Tyler, 2026-11-05).
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
export const ADS = ['robotaxi', 'dubburger'];

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

// --- Dub Burger ---------------------------------------------------------------------------------

/**
 * The city's own drive-through (city/burgerjoint.js), advertising itself: the building's red band
 * as the field, the turning sign's burger drawn big on the left in the sign's own five slice
 * colours (palette.js), and DUB / BURGER stacked beside it. At play zoom: "red board, burger,
 * cream word" — the same three things the restaurant is. The tagline is the drive-through
 * speaker's own line ("Cash or Bitcoin?", game/ordertalk.js).
 */
function drawDubBurger(g) {
  const red = '#D2402F';                 // `burgerBand`, a touch hotter for the haze to pale
  const deep = '#8E2318';
  const cream = '#FFF1D6';
  const amber = '#FFC24A';               // `burgerNeon`
  const ink = '#2A1410';
  g.fillStyle = red;
  g.fillRect(0, 0, ART_W, ART_H);
  // A darker disc behind the burger, so its outline holds against the red.
  const cx = 200;
  const cy = 205;
  g.fillStyle = deep;
  g.beginPath(); g.arc(cx, cy, 175, 0, Math.PI * 2); g.fill();

  // The burger, bottom up, each slice outlined in ink so the stack reads as slices at 30 pixels.
  const slice = (draw, fill) => {
    g.fillStyle = ink;
    g.save(); g.translate(0, 5); draw(); g.fill(); g.restore();
    draw(); g.fillStyle = fill; g.fill();
  };
  const W = 270;
  const x0 = cx - W / 2;
  slice(() => roundRect(g, x0 + 8, cy + 62, W - 16, 52, 24), '#D2A163');              // bun base
  slice(() => roundRect(g, x0 - 4, cy + 30, W + 8, 40, 18), '#54321F');               // patty
  slice(() => {                                                                       // cheese
    g.beginPath();
    g.moveTo(x0 - 6, cy + 20); g.lineTo(x0 + W + 6, cy + 20);
    g.lineTo(x0 + W - 30, cy + 52); g.lineTo(x0 + W - 70, cy + 36);
    g.lineTo(x0 + 70, cy + 54); g.lineTo(x0 + 30, cy + 34); g.closePath();
  }, '#F7C63C');
  slice(() => {                                                                       // lettuce
    g.beginPath();
    g.moveTo(x0 - 14, cy + 14);
    for (let i = 0; i <= 10; i++) {
      const x = x0 - 14 + ((W + 28) * i) / 10;
      g.quadraticCurveTo(x - (W + 28) / 20, cy + (i % 2 ? 36 : 4), x, cy + 14);
    }
    g.lineTo(x0 + W + 14, cy); g.lineTo(x0 - 14, cy); g.closePath();
  }, '#7FB050');
  slice(() => {                                                                       // bun top
    g.beginPath();
    g.moveTo(x0, cy + 6);
    g.bezierCurveTo(x0, cy - 150, x0 + W, cy - 150, x0 + W, cy + 6);
    g.closePath();
  }, '#DFAE6C');
  g.fillStyle = '#F7EDD6';                                                            // sesame
  for (const [sx, sy, r] of [[-70, -70, 0.4], [-20, -92, -0.2], [40, -80, 0.5], [90, -52, -0.4],
    [-100, -30, 0.2], [0, -48, 0.1], [60, -30, -0.3]]) {
    g.save(); g.translate(cx + sx, cy + sy); g.rotate(r);
    g.beginPath(); g.ellipse(0, 0, 11, 6, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  // DUB / BURGER: cream on a hard ink drop, no soft shadow.
  const word = (text, size, x, y, fill) => {
    g.font = `700 ${size}px ${FONT}`;
    g.fillStyle = ink;
    g.fillText(text, x + 7, y + 7);
    g.fillStyle = fill;
    g.fillText(text, x, y);
  };
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const left = 420;
  const big = fit(g, 'DUB', 700, ART_W - left - 40, 230);
  word('DUB', big, left, 196, cream);
  const mid = fit(g, 'BURGER', 700, ART_W - left - 40, 150);
  word('BURGER', mid, left + 4, 322, amber);
  g.fillStyle = cream;
  fit(g, 'WE TAKE CASH OR BITCOIN.', 600, ART_W - left - 40, 28);
  g.fillText('WE TAKE CASH OR BITCOIN.', left + 6, 376);
}

const DRAW = { robotaxi: drawRobotaxi, dubburger: drawDubBurger };

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
