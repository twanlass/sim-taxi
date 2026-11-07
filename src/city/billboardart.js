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

/**
 * `?billboardad=classic` — the first board carries the robo-taxis' MONDAY teaser again instead of
 * the vet's dog. MONDAY was the only thing on the map saying the robo-taxis were coming; Tyler
 * found it boring and asked for the vet on 2026-11-07, and the story now rides on the intro's
 * dispatch lines and on the robo-taxis themselves.
 */
export const AD_CLASSIC = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('billboardad') === 'classic';

/** The poster designs, by name, in the order the boards are placed (the first lands on every city). */
export const ADS = [AD_CLASSIC ? 'robotaxi' : 'goodboy', 'dubburger'];

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

// --- Good Boy Vet ------------------------------------------------------------------------------

/**
 * The vet clinic (city/vetclinic.js) advertising itself, the way Dub Burger does: its sign's dog
 * drawn big on the left, in the same golden fur, brown ears and cream muzzle (palette.js `dog*`),
 * on the clinic's neon blue. The clinic had no name until this poster gave it one. At play zoom:
 * "blue board, dog face, WOOF!" — the face is the part that has to survive 23 pixels, so it is
 * drawn front on (the 3D head is swung off the view axis to show a snout; flat art doesn't need
 * to) with eyes far too big and the tongue out. The collar is the sign's red rather than its blue,
 * which would vanish into the field.
 */
function drawGoodBoy(g) {
  const blue = '#2C74F0';               // `dogCollar`, a touch deeper so the cream word holds on it
  const deep = '#1A4CB4';
  const paw = '#3F84F5';
  const cream = '#FFF1D6';
  const gold = '#F2C14E';               // `dogTag`
  const ink = '#141628';
  const fur = '#E0A24E';                // `dogFur`
  const ear = '#8B4F26';                // `dogEar`
  g.fillStyle = blue;
  g.fillRect(0, 0, ART_W, ART_H);

  // Paw prints trotting across the field behind everything: texture for a player who pinches in,
  // a shade off the blue so at play zoom they are not there at all.
  g.fillStyle = paw;
  const print = (x, y, r) => {
    g.save(); g.translate(x, y); g.rotate(r);
    g.beginPath(); g.ellipse(0, 6, 15, 12, 0, 0, Math.PI * 2); g.fill();
    for (const [tx, ty] of [[-15, -10], [-5, -18], [6, -18], [16, -10]]) {
      g.beginPath(); g.ellipse(tx, ty, 5, 6.5, 0, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  };
  for (const [x, y, r] of [[430, 360, 1.3], [500, 330, 1.2], [570, 365, 1.4], [640, 335, 1.2],
    [710, 368, 1.35], [780, 338, 1.25], [850, 366, 1.3], [920, 336, 1.2], [990, 362, 1.4]]) {
    print(x, y, r);
  }

  // A darker disc behind the dog, so the ears' outline holds against the blue.
  const cx = 205;
  const cy = 190;
  g.fillStyle = deep;
  g.beginPath(); g.arc(cx, cy + 8, 178, 0, Math.PI * 2); g.fill();

  // Every part drawn twice: a hard ink drop, then the fill. The burger's trick — it is what makes
  // the shapes read as shapes at 30 pixels rather than as a blur of warm colours.
  const part = (draw, fill, drop = 6) => {
    g.fillStyle = ink;
    g.save(); g.translate(0, drop); draw(); g.fill(); g.restore();
    draw(); g.fillStyle = fill; g.fill();
  };
  const ell = (x, y, rx, ry, rot = 0) => () => {
    g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  };

  g.save();
  g.translate(cx, cy);
  g.rotate(-0.1);                       // the head cock, the same listening tilt the sign does

  // The collar first, under the chin, and its tag.
  part(() => roundRect(g, -88, 106, 176, 34, 16), '#FF3348');            // `vetNeonRed`
  part(ell(0, 158, 22, 22), gold, 4);
  g.fillStyle = '#C8932A';
  g.beginPath(); g.arc(0, 158, 9, 0, Math.PI * 2); g.fill();
  // The ears, hung off the crown behind the head and kicked out at the bottom.
  for (const s of [-1, 1]) part(ell(s * 118, 22, 50, 104, s * -0.38), ear);
  // The head, wider than tall, with a tuft on the crown.
  part(() => {
    g.beginPath();
    g.ellipse(0, -2, 128, 118, 0, 0, Math.PI * 2);
    g.moveTo(-26, -112); g.quadraticCurveTo(-8, -150, 4, -116);
    g.quadraticCurveTo(18, -146, 30, -110); g.closePath();
  }, fur);
  // A brown patch over one eye: the bit of character that makes him somebody's dog.
  g.fillStyle = ear;
  g.beginPath(); g.ellipse(52, -30, 46, 48, 0.2, 0, Math.PI * 2); g.fill();
  // The muzzle.
  g.fillStyle = cream;
  g.beginPath(); g.ellipse(0, 52, 82, 58, 0, 0, Math.PI * 2); g.fill();
  // Eyes: far too big, pupils sat in and down, so he is looking up at you.
  for (const s of [-1, 1]) {
    g.fillStyle = ink;
    g.beginPath(); g.ellipse(s * 50, -26, 30, 34, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#FFFFFF';
    g.beginPath(); g.ellipse(s * 50, -28, 25, 29, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink;
    g.beginPath(); g.ellipse(s * 47, -21, 16, 18, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#FFFFFF';
    g.beginPath(); g.arc(s * 47 + 6, -28, 6, 0, Math.PI * 2); g.fill();
  }
  // Pink cheeks.
  g.fillStyle = 'rgba(255, 111, 142, 0.45)';
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * 92, 30, 18, 11, 0, 0, Math.PI * 2); g.fill(); }
  // The open mouth and the tongue hanging out of it, a little off-centre.
  g.fillStyle = '#5A1E24';                                               // `dogMouth`
  g.beginPath();
  g.moveTo(-42, 62); g.quadraticCurveTo(0, 74, 42, 62);
  g.quadraticCurveTo(36, 106, 0, 108); g.quadraticCurveTo(-36, 106, -42, 62);
  g.fill();
  part(() => {
    g.beginPath();
    g.moveTo(-14, 80); g.lineTo(34, 80);
    g.quadraticCurveTo(40, 136, 10, 138); g.quadraticCurveTo(-20, 136, -14, 80);
  }, '#FF6F8E', 4);                                                      // `dogTongue`
  g.strokeStyle = '#D8486C';
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(10, 92); g.lineTo(11, 122); g.stroke();
  // The smile line, from the nose down and out each way.
  g.strokeStyle = ink;
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 36); g.lineTo(0, 58);
  g.moveTo(-46, 58); g.quadraticCurveTo(-22, 74, 0, 58); g.quadraticCurveTo(22, 74, 46, 58);
  g.stroke();
  // The nose, with a shine.
  g.fillStyle = ink;
  g.beginPath();
  g.moveTo(-30, 18); g.quadraticCurveTo(0, 6, 30, 18);
  g.quadraticCurveTo(26, 44, 0, 46); g.quadraticCurveTo(-26, 44, -30, 18);
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.55)';
  g.beginPath(); g.ellipse(-10, 20, 9, 5, -0.2, 0, Math.PI * 2); g.fill();
  g.restore();

  // WOOF! / GOOD BOY VET: cream and gold on a hard ink drop, as Dub Burger's are.
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
  const big = fit(g, 'WOOF!', 700, ART_W - left - 36, 220);
  word('WOOF!', big, left, 196, cream);
  const mid = fit(g, 'GOOD BOY VET', 700, ART_W - left - 36, 96);
  word('GOOD BOY VET', mid, left + 4, 290, gold);
  g.fillStyle = cream;
  fit(g, 'WALK-INS & WAG-INS WELCOME.', 600, ART_W - left - 36, 30);
  g.fillText('WALK-INS & WAG-INS WELCOME.', left + 6, 334);
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

const DRAW = { goodboy: drawGoodBoy, robotaxi: drawRobotaxi, dubburger: drawDubBurger };

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
