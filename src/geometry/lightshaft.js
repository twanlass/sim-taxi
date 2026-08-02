import * as THREE from 'three';

// A shaft of light standing over a waiting rider.
//
// Named "lightshaft" rather than "beacon" on purpose: ad blockers match request URLs against
// tracking-beacon filter lists, and a file called beacon.js is blocked outright with
// ERR_BLOCKED_BY_CLIENT — which takes the whole module graph down with it.
//
// At play zoom a person is a handful of pixels among a hundred buildings; the shaft is what makes
// "someone needs picking up" readable from anywhere on the map without zooming or panning.
//
// The fade is baked into vertex colours rather than alpha: with additive blending, black *is*
// transparent, so a white-to-black gradient dissolves into the sky for free and costs no
// per-frame work. Material colour multiplies over that, which is how the whole shaft can be
// retinted to the fare's remaining time in one assignment.

const HEIGHT = 46;

export function createLightShaft() {
  const geometry = new THREE.CylinderGeometry(2.4, 1.3, HEIGHT, 14, 1, true);
  geometry.translate(0, HEIGHT / 2, 0);

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = position.getY(i) / HEIGHT;
    const falloff = (1 - t) ** 1.6;      // bright at the kerb, gone by the top
    colors[i * 3] = falloff;
    colors[i * 3 + 1] = falloff;
    colors[i * 3 + 2] = falloff;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Back faces only. Transparent objects always draw after opaque ones in three.js, so with
      // both sides on, the near wall of the cylinder paints over the rider standing inside it.
      // Rendering only the far wall leaves the figure — and the timer ring — fully readable.
      side: THREE.BackSide,
    }),
  );
  // Behind the rider and the timer ring. It is a "look here" glow, not something to read
  // through — anything it covers becomes harder to see, which is the opposite of the point.
  mesh.renderOrder = 1;
  mesh.raycast = () => {};   // never a click target; the rider underneath is

  return { mesh, setColor: (c) => mesh.material.color.copy(c) };
}
