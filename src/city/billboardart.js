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

/**
 * `?dogad=` — which of the vet's posters the first board carries. Tyler asked for three directions
 * after the first (`cartoon`) read as clip art, 2026-11-07: `peek`, `print` and `shapes`, all
 * without the ink outline and the hard drop that made the cartoon cheesy. He liked the dachshund
 * and asked for it in a hot dog bun, which is `bun`, the default.
 */
const DOG_ADS = { bun: 'dogbun', peek: 'dogpeek', print: 'dogprint', shapes: 'dogshapes', cartoon: 'goodboy' };
const DOG_AD = (typeof location !== 'undefined'
  && DOG_ADS[new URLSearchParams(location.search).get('dogad')]) || DOG_ADS.bun;

/** The poster designs, by name, in the order the boards are placed (the first lands on every city). */
export const ADS = [AD_CLASSIC ? 'robotaxi' : DOG_AD, 'dubburger'];

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

// --- Good Boy Vet, three directions ------------------------------------------------------------

const circle = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
const oval = (g, x, y, rx, ry, rot = 0) => {
  g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill();
};

/**
 * `peek`: a modern campaign crop. A white dog with black ears comes up from the bottom edge so only
 * the top of its head shows — the eyes and the top of the nose — on a hard yellow, with "Good boy?"
 * set big in black beside it. At play zoom: "yellow board, a face looking up at you, a black word".
 * The cut-off is the joke and it is what makes it read as an ad rather than an illustration.
 */
function drawDogPeek(g) {
  const yellow = '#FFD23F';
  const ink = '#141414';
  const white = '#FBF7EE';
  g.fillStyle = yellow;
  g.fillRect(0, 0, ART_W, ART_H);
  const cx = 740;
  const cy = 520;
  // Ears behind the head, hanging off the crown.
  g.fillStyle = ink;
  oval(g, cx - 238, cy - 120, 72, 165, 0.32);
  oval(g, cx + 238, cy - 120, 72, 165, -0.32);
  // The head, mostly off the bottom of the board.
  g.fillStyle = white;
  oval(g, cx, cy, 250, 330);
  // A black patch over one eye.
  g.fillStyle = ink;
  oval(g, cx + 88, cy - 228, 70, 62, 0.3);
  // Eyes, looking up at you.
  for (const s of [-1, 1]) {
    g.fillStyle = s > 0 ? white : ink;
    if (s > 0) circle(g, cx + 88, cy - 228, 38);
    g.fillStyle = ink;
    circle(g, cx + s * 88, cy - 236, s > 0 ? 26 : 30);
    g.fillStyle = '#FFFFFF';
    circle(g, cx + s * 88 + 9, cy - 246, 9);
  }
  // Eyebrows, worried up in the middle.
  g.strokeStyle = ink;
  g.lineWidth = 12;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - 128, cy - 300); g.quadraticCurveTo(cx - 90, cy - 316, cx - 52, cy - 296);
  g.moveTo(cx + 52, cy - 296); g.quadraticCurveTo(cx + 90, cy - 316, cx + 128, cy - 300);
  g.stroke();
  // The top of the nose, cut off by the bottom edge.
  g.fillStyle = ink;
  g.beginPath();
  g.moveTo(cx - 62, cy - 146); g.quadraticCurveTo(cx, cy - 168, cx + 62, cy - 146);
  g.quadraticCurveTo(cx + 56, cy - 90, cx, cy - 84); g.quadraticCurveTo(cx - 56, cy - 90, cx - 62, cy - 146);
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.5)';
  oval(g, cx - 20, cy - 142, 16, 8, -0.2);

  g.fillStyle = ink;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  fit(g, 'Good', 700, 400, 170);
  g.fillText('Good', 40, 168);
  fit(g, 'boy?', 700, 400, 170);
  g.fillText('boy?', 40, 312);
  fit(g, 'GOOD BOY VET  ·  WALK-INS WELCOME', 700, 380, 26);
  g.fillText('GOOD BOY VET  ·  WALK-INS WELCOME', 44, 362);
}

/**
 * `print`: a two-ink mid-century screen print. A long red dachshund stands right across the board,
 * the one dog shaped like a billboard, under a mustard sun, with the clinic's name in navy and a
 * line about the long haul. Flat colour, no outlines, slight registration offset on the sun.
 */
function drawDogPrint(g) {
  const paper = '#F1E6CF';
  const navy = '#1F2A44';
  const red = '#E0503A';
  const mustard = '#E8B04A';
  g.fillStyle = paper;
  g.fillRect(0, 0, ART_W, ART_H);
  // The sun behind the head, and the ground line.
  g.fillStyle = mustard;
  circle(g, 840, 170, 120);
  g.fillStyle = navy;
  g.fillRect(0, 352, ART_W, 6);

  // The dachshund, facing right: tail, legs, body, chest, head, snout, ear.
  g.fillStyle = red;
  g.beginPath();                                                       // tail
  g.moveTo(172, 236); g.quadraticCurveTo(118, 228, 96, 192);
  g.quadraticCurveTo(130, 212, 180, 210); g.closePath(); g.fill();
  for (const x of [210, 268, 650, 712]) {                              // legs
    roundRect(g, x, 260, 42, 92, 18); g.fill();
  }
  roundRect(g, 160, 196, 640, 112, 56); g.fill();                      // body
  oval(g, 760, 252, 74, 70);                                           // chest
  circle(g, 842, 184, 70);                                             // head
  g.beginPath();                                                       // snout
  g.moveTo(860, 150); g.quadraticCurveTo(960, 168, 984, 214);
  g.quadraticCurveTo(964, 244, 868, 236); g.closePath(); g.fill();
  g.fillStyle = navy;
  g.beginPath();                                                       // ear
  g.moveTo(812, 140); g.quadraticCurveTo(760, 170, 778, 270);
  g.quadraticCurveTo(820, 268, 840, 156); g.closePath(); g.fill();
  circle(g, 870, 172, 9);                                              // eye
  oval(g, 984, 210, 13, 11);                                           // nose

  // The name, top left, and the line under it.
  g.fillStyle = navy;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  fit(g, 'GOOD BOY VET', 700, 580, 96);
  g.fillText('GOOD BOY VET', 44, 112);
  g.fillStyle = red;
  fit(g, 'Here for the long haul.', 500, 520, 36);
  g.fillText('Here for the long haul.', 48, 160);
  g.fillStyle = navy;
  fit(g, 'OPEN LATE  ·  WALK-INS', 700, 300, 22);
  g.fillText('OPEN LATE  ·  WALK-INS', 48, 388);
}

/**
 * `bun`: the print's dachshund lying in a hot dog bun, Tyler's riff on the wiener (2026-11-07).
 * The print's flat screen-print look, on deep blue rather than its cream paper: cream lost the bun
 * at play zoom, where the lamp wash and the tan crust came out the same colour. A mustard sun behind the head, a squiggle of mustard
 * down his back, his head and front paws over the end of the bun and his tail out of the other.
 * The joke is the hot dog order: "With everything." — and for a vet, everything is checkups, shots
 * and belly rubs. At play zoom: "blue board, a long red dog in a bun".
 */
function drawDogBun(g) {
  const field = '#203E66';               // a deep blue, so a tan bun and a red dog pop under the lamps
  const cream = '#F6EBD2';
  const navy = '#1F2A44';
  const red = '#E0503A';
  const sun = '#E8B04A';
  const mustard = '#F7CB2D';
  const bun = '#D9A15A';
  const bunBack = '#BF8340';
  const bunLight = '#EBBE7C';
  g.fillStyle = field;
  g.fillRect(0, 0, ART_W, ART_H);
  g.fillStyle = sun;
  circle(g, 892, 196, 116);

  // The back half of the bun, behind him.
  g.fillStyle = bunBack;
  roundRect(g, 150, 200, 720, 96, 48); g.fill();
  // The tail, out of the left end.
  g.fillStyle = red;
  g.beginPath();
  g.moveTo(190, 236); g.quadraticCurveTo(130, 226, 104, 184);
  g.quadraticCurveTo(140, 206, 196, 214); g.closePath(); g.fill();
  // The dog: body, chest, head, snout, ear.
  roundRect(g, 172, 212, 690, 84, 42); g.fill();
  oval(g, 846, 246, 54, 48);
  circle(g, 896, 196, 62);
  g.beginPath();
  g.moveTo(910, 164); g.quadraticCurveTo(1000, 180, 1012, 222);
  g.quadraticCurveTo(992, 250, 912, 246); g.closePath(); g.fill();
  g.fillStyle = navy;
  g.beginPath();
  g.moveTo(870, 154); g.quadraticCurveTo(822, 184, 838, 272);
  g.quadraticCurveTo(878, 268, 896, 168); g.closePath(); g.fill();
  circle(g, 924, 184, 9);
  oval(g, 1010, 218, 12, 10);
  // The mustard, squiggled down his back.
  g.strokeStyle = mustard;
  g.lineWidth = 15;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  for (let x = 220; x <= 790; x += 6) {
    const y = 228 + Math.sin((x - 220) / 26) * 9;
    if (x === 220) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  // The front half of the bun, with a lighter crust along its lip.
  g.fillStyle = bun;
  roundRect(g, 136, 262, 752, 98, 49); g.fill();
  g.fillStyle = bunLight;
  roundRect(g, 176, 270, 672, 16, 8); g.fill();
  // Front paws over the lip.
  g.fillStyle = red;
  oval(g, 812, 276, 24, 16);
  oval(g, 858, 280, 24, 16);

  g.fillStyle = cream;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  fit(g, 'WITH EVERYTHING.', 700, 640, 84);
  g.fillText('WITH EVERYTHING.', 40, 98);
  g.fillStyle = sun;
  fit(g, 'Checkups, shots & belly rubs.', 500, 600, 36);
  g.fillText('Checkups, shots & belly rubs.', 44, 146);
  g.fillStyle = cream;
  fit(g, 'GOOD BOY VET  ·  OPEN LATE', 700, 380, 24);
  g.fillText('GOOD BOY VET  ·  OPEN LATE', 44, 388);
}

/**
 * `shapes`: Bauhaus. A coral block on the left with a dog built only from primitives — a navy
 * circle for the head, two mustard half-discs for the ears, cream circles for eyes, a coral
 * triangle for the nose — and GOOD / BOY stacked heavy in navy on cream beside it.
 */
function drawDogShapes(g) {
  const cream = '#F5EEDF';
  const coral = '#FF6B57';
  const navy = '#1C2B4A';
  const mustard = '#F2B33D';
  g.fillStyle = cream;
  g.fillRect(0, 0, ART_W, ART_H);
  g.fillStyle = coral;
  g.fillRect(0, 0, 420, ART_H);

  const cx = 210;
  const cy = 214;
  // The head.
  g.fillStyle = navy;
  circle(g, cx, cy, 130);
  // Ears: long capsules hung off the crown and down past the cheeks, over the head's edge.
  g.fillStyle = mustard;
  for (const s of [-1, 1]) {
    roundRect(g, cx + s * 112 - 40, cy - 120, 80, 200, 40); g.fill();
  }
  // A cream muzzle disc, low.
  g.fillStyle = cream;
  circle(g, cx, cy + 58, 64);
  // Eyes: cream circles with navy pupils, set high.
  for (const s of [-1, 1]) {
    g.fillStyle = cream;
    circle(g, cx + s * 52, cy - 34, 28);
    g.fillStyle = navy;
    circle(g, cx + s * 48, cy - 28, 14);
  }
  // The nose: a navy half-disc, flat side up, and a coral tongue under the muzzle.
  g.fillStyle = navy;
  g.beginPath(); g.arc(cx, cy + 28, 26, 0, Math.PI); g.closePath(); g.fill();
  g.fillStyle = coral;
  g.beginPath(); g.arc(cx, cy + 100, 26, 0, Math.PI); g.closePath(); g.fill();
  // A mustard tag at the chin.
  g.fillStyle = mustard;
  circle(g, cx, cy + 156, 22);

  g.fillStyle = navy;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const left = 470;
  fit(g, 'GOOD', 700, ART_W - left - 40, 170);
  g.fillText('GOOD', left, 168);
  fit(g, 'BOY', 700, ART_W - left - 40, 170);
  g.fillText('BOY', left, 318);
  g.fillStyle = coral;
  fit(g, 'VETERINARY  ·  SIT. STAY. HEAL.', 700, ART_W - left - 40, 26);
  g.fillText('VETERINARY  ·  SIT. STAY. HEAL.', left + 4, 366);
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

const DRAW = {
  dogbun: drawDogBun, dogpeek: drawDogPeek, dogprint: drawDogPrint, dogshapes: drawDogShapes, goodboy: drawGoodBoy, robotaxi: drawRobotaxi, dubburger: drawDubBurger };

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
