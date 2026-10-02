import * as THREE from 'three';

// Alpha-cut card atlases, drawn in code: the parks' grass (city/grass.js) and the leaf fuzz on the
// tree crowns (city/canopyfuzz.js).
//
// **The mip chain is drawn, not filtered.** A card at play zoom is a handful of pixels, so it reads
// off mips 2–3, and a box-filtered chain averages a two-texel blade over four into a value the 0.5
// alpha cut throws away — the detail is gone exactly at the zoom the game is played at. So every
// level is rasterised from the same shapes at its own resolution, with `minHalf` telling the shape
// how thin one texel is there: a blade or a leaf thins to a line as the card shrinks rather than
// averaging out of existence.

/** The camera's horizontal on screen, and the direction to it — the view never turns. */
export const VIEW_RIGHT = new THREE.Vector3(1, 0, -1).normalize();
export const TO_CAMERA = new THREE.Vector3(1, 0.92, 1).normalize();
/** Screen up in world space: `VIEW_RIGHT × VIEW_UP` points at the camera, so a quad wound
 *  (−r−u, +r−u, +r+u) faces it. */
export const VIEW_UP = new THREE.Vector3().crossVectors(TO_CAMERA, VIEW_RIGHT).normalize();

/**
 * @param variants  drawings side by side in the atlas
 * @param cellPx    each drawing's size at the top level
 * @param coverage  `(k, u, v, minHalf) → 0|1` for drawing `k` at `(u, v)` in its own cell, both
 *                  0..1 with v up; `minHalf` is half a texel at the level being drawn, in cell units
 */
export function cutoutAtlas({ variants, cellPx, coverage }) {
  const SS = 4; // supersamples per texel, per axis
  const levels = [];
  for (let w = cellPx * variants, h = cellPx; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    const data = new Uint8Array(w * h * 4);
    const minHalf = 0.5 / Math.max(w / variants, 1e-6);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const ua = ((x + (sx + 0.5) / SS) / w) * variants;
            const k = Math.min(variants - 1, Math.floor(ua));
            hit += coverage(k, ua - k, (y + (sy + 0.5) / SS) / h, minHalf);
          }
        }
        // `alphaMap` reads the green channel; filled across all four so nothing depends on which.
        const i = (y * w + x) * 4;
        data.fill(Math.round((hit / (SS * SS)) * 255), i, i + 4);
      }
    }
    levels.push({ data, width: w, height: h });
    if (w === 1 && h === 1) break;
  }

  const texture = new THREE.DataTexture(levels[0].data, levels[0].width, levels[0].height);
  texture.mipmaps = levels;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
