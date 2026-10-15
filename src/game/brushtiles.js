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

function paintTile(seed, { count, len, wid, angle, spread, tone }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const rng = makeRng(seed);
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, SIZE);
    const y = rng.range(0, SIZE);
    const l = rng.range(len[0], len[1]);
    const w = rng.range(wid[0], wid[1]);
    const a = angle + rng.range(-spread, spread);
    const v = Math.round(128 + rng.range(-tone, tone));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        ctx.save();
        ctx.translate(x + dx * SIZE, y + dy * SIZE);
        ctx.rotate(a);
        ctx.scale(l / w, 1);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
        g.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
        g.addColorStop(0.6, `rgba(${v},${v},${v},0.4)`);
        g.addColorStop(1, `rgba(${v},${v},${v},0)`);
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

/** Walls: long, near-horizontal strokes. Ground: shorter diagonal clumps, for lawns and roofs. */
export function createBrushTiles() {
  return {
    wall: paintTile(9101, { count: 260, len: [48, 96], wid: [12, 20], angle: 0, spread: 0.12, tone: 40 }),
    ground: paintTile(9202, { count: 320, len: [36, 64], wid: [12, 18], angle: 0.75, spread: 0.35, tone: 36 }),
  };
}
