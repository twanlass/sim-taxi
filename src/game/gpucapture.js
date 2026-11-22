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
 * The bytes read back are the finished picture: every node material writes display values itself
 * (`installNodeGrade`, game/gpufog.js), so there is no encode to do on the copy.
 */
import * as THREE from 'three';

export function createGpuCapture(renderer, { samples = 0 } = {}) {
  if (typeof window === 'undefined' || !window.__gpuOffscreen) return null;
  const target = new THREE.RenderTarget(1, 1, { samples, depthBuffer: true, stencilBuffer: true });
  const size = new THREE.Vector2();
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
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
      const image = new ImageData(width, height);
      // WebGPU pads each row of a readback to 256 bytes, and three hands the buffer back padded,
      // all rows but the last. Reading it as tight rows shears the picture into four bands.
      const stride = Math.ceil((width * 4) / 256) * 256;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = y * stride + x * 4;
          const to = (y * width + x) * 4;
          image.data[to] = pixels[from];
          image.data[to + 1] = pixels[from + 1];
          image.data[to + 2] = pixels[from + 2];
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
