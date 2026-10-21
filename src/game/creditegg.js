import { PALETTE } from '../palette.js';
import { createSplashSound } from './splashsound.js';

/**
 * The pixel Claude beside its credit, and the easter egg behind it: tap him and a pixel taxi pulls
 * up, he hops in, and it Loco-boosts off the right of the screen. He pops back a moment later.
 *
 * Everything is drawn from character grids at one 2px cell, so the taxi and the mascot share a
 * pixel and read as one piece of art rather than two scales pasted together. The run is plain Web
 * Animations on DOM nodes in a layer over the title screen; nothing touches the 3D scene.
 *
 * The sound is the startup screen's (game/splashsound.js): the Loco launch and roar, at the
 * game's own mix. Its context is made inside the tap, so unlike the startup screen it is allowed
 * to run in a browser too. It follows mute and the effects slider, and `?splashsound=classic`
 * silences it with the startup screen's.
 */

const CELL = 2;

// Claude's pixel mascot: X body, E eye. Read off the sticker rather than traced, at 11 x 8.
const CLAUDE = [
  '.XXXXXXXXX.',
  '.XXXXXXXXX.',
  'XXEXXXXXEXX',
  'XXXXXXXXXXX',
  '.XXXXXXXXX.',
  '.XXXXXXXXX.',
  '.X.X...X.X.',
  '.X.X...X.X.',
];

// The taxi, facing right: S roof sign, Y body, G glass, K checker and tyres, H headlight, R tail
// light. 24 x 13, so the 11-wide mascot fits through its front window with room to spare.
const TAXI = [
  '..........SSSS..........',
  '.......YYYYYYYYYY.......',
  '......YGGGGYYGGGGGY.....',
  '.....YGGGGGYYGGGGGGY....',
  '....YYGGGGGYYGGGGGGGY...',
  'YYYYYYYYYYYYYYYYYYYYYYYY',
  'RYYYYYYYYYYYYYYYYYYYYYYH',
  'KYKYKYKYKYKYKYKYKYKYKYKY',
  'YKYKYKYKYKYKYKYKYKYKYKYK',
  'YYYYYYYYYYYYYYYYYYYYYYYY',
  '...KKKK..........KKKK...',
  '...KKKK..........KKKK...',
  '....KK............KK....',
];

// Claude at the wheel, over the front window once he has landed: the same grid as the taxi.
const RIDER = [
  '........................',
  '........................',
  '..............XXX.......',
  '.............XXXEX......',
  '.............XXXXXX.....',
];

// The Loco flame out of the back: O outer, M mid, C core, the game's own three Loco colours.
const FLAME = [
  '..OOO..',
  '.OMMMOO',
  'OMMCCCM',
  '.OMMMOO',
  '..OOO..',
];

const COLOURS = {
  X: PALETTE.claudeClay, E: PALETTE.claudeEye,
  S: PALETTE.taxiSign, Y: PALETTE.taxiBody, G: PALETTE.glass, K: PALETTE.taxiTrim,
  H: PALETTE.locoFlameCore, R: PALETTE.taxiHitFlash,
  O: PALETTE.locoFlameOuter, M: PALETTE.locoFlameMid, C: PALETTE.locoFlameCore,
};

/** A grid as an inline SVG at `CELL` px a cell, one path per colour. */
function pixelSvg(grid, className) {
  const ns = 'http://www.w3.org/2000/svg';
  const w = grid[0].length;
  const h = grid.length;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w * CELL));
  svg.setAttribute('height', String(h * CELL));
  svg.setAttribute('class', className);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const paths = {};
  grid.forEach((row, y) => [...row].forEach((c, x) => {
    if (COLOURS[c]) paths[c] = `${paths[c] ?? ''}M${x} ${y}h1v1h-1z`;
  }));
  for (const [c, d] of Object.entries(paths)) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', COLOURS[c]);
    svg.append(path);
  }
  return svg;
}

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// The run, in ms from the tap. The pull-up is quick so the tap feels answered; the boost is an
// ease-in so it reads as the car leaving rather than sliding.
const PULL_UP = 650;
const HOP = 420;
const REV = 380;
const BOOST = 520;
const AWAY = 700;

/**
 * @param {HTMLElement} root  `#title-screen`: the layer the taxi drives across. It is fixed to the
 *   viewport at the origin, so a client rect is already in its coordinates.
 * @returns {{ node: HTMLElement, cancel: () => void }}  The mark to set beside the name, and a
 *   stop for when the credits page is left mid-run.
 */
export function createClaudeMark(root) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'title-credit-claude';
  button.setAttribute('aria-label', 'Claude');
  const claude = pixelSvg(CLAUDE, 'title-credit-sprite');
  button.append(claude);

  let layer = null;
  let sound = null;
  let timers = [];

  function cancel() {
    for (const t of timers) clearTimeout(t);
    timers = [];
    layer?.remove();
    layer = null;
    sound?.close();
    sound = null;
    for (const a of claude.getAnimations()) a.cancel();
    claude.style.visibility = '';
    button.disabled = false;
  }
  const at = (ms, fn) => { timers.push(setTimeout(fn, ms)); };

  button.addEventListener('click', () => {
    if (layer || stillPlease()) return;
    button.disabled = true;
    sound = createSplashSound();

    layer = document.createElement('div');
    layer.className = 'title-egg';
    const taxi = document.createElement('div');
    taxi.className = 'title-egg-taxi';
    const flame = pixelSvg(FLAME, 'title-egg-flame');
    const rider = pixelSvg(RIDER, 'title-egg-rider');
    taxi.append(flame, pixelSvg(TAXI, 'title-egg-body'), rider);
    layer.append(taxi);
    root.append(layer);

    // Park the taxi with its front window under Claude and its tyres on his feet.
    const me = claude.getBoundingClientRect();
    const taxiW = TAXI[0].length * CELL;
    const taxiH = TAXI.length * CELL;
    const parkX = me.left + me.width / 2 - 15.5 * CELL;
    const y = me.bottom - taxiH;
    taxi.style.top = `${y}px`;
    taxi.style.left = '0px';
    const gone = root.clientWidth + 12 * CELL;

    taxi.animate([
      { transform: `translateX(${-taxiW - 8 * CELL}px)` },
      { transform: `translateX(${parkX}px)` },
    ], { duration: PULL_UP, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' });

    // The hop: up and over, shrinking into the window. Measured off his own box, so it lands where
    // the rider is drawn whatever size the credits page is set at.
    const landX = parkX + 16 * CELL - (me.left + me.width / 2);
    const landY = y + 3.5 * CELL - (me.top + me.height / 2);
    at(PULL_UP, () => {
      claude.animate([
        { transform: 'translate(0, 0) scale(1)' },
        { transform: `translate(${landX * 0.5}px, ${-10 * CELL}px) scale(0.9)`, offset: 0.45 },
        { transform: `translate(${landX}px, ${landY}px) scale(0.4)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${landX}px, ${landY}px) scale(0.4)`, opacity: 0 },
      ], { duration: HOP, easing: 'ease-in-out', fill: 'forwards' });
    });

    at(PULL_UP + HOP, () => {
      rider.style.visibility = 'visible';
      // The rev: a shudder on the spot as the flame lights.
      taxi.animate([
        { transform: `translateX(${parkX}px)` },
        { transform: `translateX(${parkX - CELL}px) translateY(${-CELL / 2}px)` },
        { transform: `translateX(${parkX + CELL / 2}px)` },
        { transform: `translateX(${parkX - CELL / 2}px) translateY(${-CELL / 2}px)` },
        { transform: `translateX(${parkX}px)` },
      ], { duration: REV, iterations: 1, fill: 'forwards' });
      flame.style.visibility = 'visible';
      sound?.play('locoLaunch');
    });

    at(PULL_UP + HOP + REV, () => {
      sound?.play('locoActivate');
      taxi.animate([
        { transform: `translateX(${parkX}px)` },
        { transform: `translateX(${gone}px)` },
      ], { duration: BOOST, easing: 'cubic-bezier(0.6, 0, 0.9, 0.6)', fill: 'forwards' });
    });

    at(PULL_UP + HOP + REV + BOOST, () => { sound?.fadeLoco(0.4); });

    // He pops back into his spot, so the credit is never left without him.
    at(PULL_UP + HOP + REV + BOOST + AWAY, () => {
      for (const a of claude.getAnimations()) a.cancel();
      claude.animate([
        { transform: 'scale(0)' },
        { transform: 'scale(1.2)', offset: 0.6 },
        { transform: 'scale(1)' },
      ], { duration: 260, easing: 'ease-out' });
      const s = sound;
      sound = null;
      setTimeout(() => s?.close(), 800);
      layer?.remove();
      layer = null;
      timers = [];
      button.disabled = false;
    });
  });

  return { node: button, cancel };
}
