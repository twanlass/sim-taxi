import * as THREE from 'three';
import { makeRng } from '../util/rng.js';

/**
 * Painted brush tiles for the painterly look — drawn in code, dab by dab, onto a 256² canvas.
 *
 * Noise was tried first and read as dirt: it has no shape. A painted surface is a few hundred
 * deliberate marks with a direction, so that is what is drawn — soft elongated dabs, a few tones
 * either side of mid-grey, laid along a heading. The shader reads `r - 0.5` as a value swing.
 *
 * Every dab is also drawn at its eight wrapped neighbours, so the tile closes on itself and
 * `RepeatWrapping` puts no seam across the city. At the default 8 world units per tile that is 32px
 * a unit, so a 48–96px dab is a 1.5–3 unit stroke: about the smallest that still reads as a stroke
 * at play zoom (1 unit ≈ 7.7px) rather than as grain.
 */

const SIZE = 256;

function paintTile(seed, { count, len, wid, angle, spread, tone, hue = 0, also = null }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const rng = makeRng(seed);
  const passes = also ? 2 : 1;
  for (let i = 0; i < count * passes; i++) {
    if (i === count) ({ len, wid, angle, spread, tone } = also);
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const l = rng.range(len[0], len[1]);
    const w = rng.range(wid[0], wid[1]);
    const a = angle + rng.range(-spread, spread);
    const v = 128 + rng.range(-tone, tone);
    // A stroke's tint: positive leans warm red, negative cool blue, in the same 0..255 units as
    // the tone. Kept a fraction of the tone so it breaks the grey up without reading as colour.
    const t = rng.range(-hue, hue);
    const cr = Math.round(v + (t > 0 ? t : t * 0.5));
    const cg = Math.round(v - Math.abs(t) * 0.2);
    const cb = Math.round(v + (t < 0 ? -t : -t * 0.5));
    const rgb = `${cr},${cg},${cb}`;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        ctx.save();
        ctx.translate(x + dx * SIZE, y + dy * SIZE);
        ctx.rotate(a);
        ctx.scale(l / w, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
        g.addColorStop(0, `rgba(${rgb},0.55)`);
        g.addColorStop(0.6, `rgba(${rgb},0.4)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function paintRoad(seed) {
  // Two passes into one tile: along x, then along z, at the same count each.
  const a = { count: 110, len: [70, 130], wid: [16, 26], spread: 0.06, tone: 30, hue: 14 };
  return paintTile(seed, { ...a, angle: 0, also: { ...a, angle: Math.PI / 2 } });
}

/**
 * Walls: long, near-horizontal strokes. Ground: shorter diagonal clumps, for lawns and roofs.
 * Road: broad dry-brush strokes laid along *both* street axes (half at 0, half at 90°), because one
 * tile covers north–south and east–west roads alike and a single heading would cut across half of
 * them. Lower tone than the others — asphalt with loud strokes is the "dirty" look Tyler rejected.
 */
export function createBrushTiles() {
  return {
    wall: paintTile(9101, { count: 260, len: [48, 96], wid: [12, 20], angle: 0, spread: 0.12, tone: 40 }),
    ground: paintTile(9202, { count: 320, len: [36, 64], wid: [12, 18], angle: 0.75, spread: 0.35, tone: 36 }),
    road: paintRoad(9303),
  };
}
