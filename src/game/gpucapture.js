/**
 * Headless stills of the WebGPU renderer, without ever presenting to the canvas.
 *
 * Headless Chromium has a working WebGPU device (SwiftShader, behind `--enable-unsafe-webgpu
 * --use-webgpu-adapter=swiftshader`) and no way to present it: the first frame drawn to the canvas
 * comes out transparent, and within half a second the device is destroyed under the page. Measured
 * on a one-cube scene, so it is the environment and not the game. A render *target* is fine: four
 * renders 700 ms apart all read back the right pixel with the device alive.
 *
 * So a tool that wants a picture sets `window.__gpuOffscreen = true` before the page loads
 * (tools/gpushot.mjs), every frame is drawn into a target instead of the canvas, and
 * `__taxi.gpuCapture()` reads it back as a PNG. A page that does not set the flag pays nothing.
 *
 * Two things the canvas does for free and a target does not: three writes a target in linear
 * colour (the sRGB encode belongs to the output pass), and WebGPU's rows run top down while WebGL's
 * run bottom up. Both are put right here, on the copy.
 */
import * as THREE from 'three';

export function createGpuCapture(renderer, { samples = 0 } = {}) {
  if (typeof window === 'undefined' || !window.__gpuOffscreen) return null;
  const target = new THREE.RenderTarget(1, 1, { samples, depthBuffer: true, stencilBuffer: true });
  const size = new THREE.Vector2();
  // Linear to sRGB, by table: 8 bits in, 8 bits out.
  const encode = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    encode[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
  }
  return {
    target,
    /** Aim the renderer at the target, sized to the canvas's own drawing buffer. */
    begin() {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      renderer.setRenderTarget(target);
    },
    end() {
      renderer.setRenderTarget(null);
    },
    /** The last frame, as a PNG data URL. */
    async capture() {
      const { width, height } = target;
      const linear = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      const image = new ImageData(width, height);
      // WebGPU pads each row of a readback to 256 bytes, and three hands the buffer back padded,
      // all rows but the last. Reading it as tight rows shears the picture into four bands.
      const stride = Math.ceil((width * 4) / 256) * 256;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = y * stride + x * 4;
          const to = (y * width + x) * 4;
          image.data[to] = encode[linear[from]];
          image.data[to + 1] = encode[linear[from + 1]];
          image.data[to + 2] = encode[linear[from + 2]];
          image.data[to + 3] = 255;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    },
  };
}
